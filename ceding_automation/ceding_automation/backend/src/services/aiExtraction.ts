// backend/src/services/aiExtraction.ts
// Connects to Azure OpenAI to extract checklist fields from uploaded documents.
// In production: Azure OpenAI GPT-4o with document base64 input.
// The AI layer (Fireflies, NLP pipeline) is managed separately on Azure.

import { AzureOpenAI } from "openai";
import { downloadBlobAsBuffer } from "./storage";
import { parseJsonCompletionOrFallback } from "../utils/openaiJsonSafe";

const client = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
  apiKey: process.env.AZURE_OPENAI_API_KEY!,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o",
});

interface ExtractionInput {
  storagePath: string;
  planType: string;
  checklistFields: Array<{
    id: string;
    key: string;
    label: string;
    type: string;
  }>;
}

interface ExtractedField {
  fieldKey: string;
  value: string;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
  pageNumber?: number;
  section?: string;
  quote?: string;
}

interface ExtractionResult {
  fields: ExtractedField[];
  pageCount: number;
  model: string;
}

export async function extractDocumentWithAI(input: ExtractionInput): Promise<ExtractionResult> {
  const buffer = await downloadBlobAsBuffer(input.storagePath);
  const base64 = buffer.toString("base64");
  const isPdf = input.storagePath.endsWith(".pdf");

  const fieldList = input.checklistFields
    .map((f) => `- ${f.key} (${f.label}, type: ${f.type})`)
    .join("\n");

  const systemPrompt = `You are a financial document extraction AI for Furnley House, a UK financial planning firm.
Your task is to extract specific checklist fields from provider documents for pension ceding / transfer cases.
Return ONLY valid JSON with no preamble. Be precise and cite page numbers.

Confidence levels:
- HIGH: Value clearly stated, no ambiguity
- MEDIUM: Value inferred but reasonable
- LOW: Uncertain, multiple possible interpretations
- MISSING: Field not found in document

Always extract monetary values as numbers with currency symbol (e.g. "£125,432.50").
Always extract percentages with % symbol (e.g. "0.75%").
Always extract dates in DD/MM/YYYY format.`;

  const userPrompt = `Extract the following fields from this ${input.planType} plan document:

${fieldList}

Return JSON in this exact format:
{
  "fields": [
    {
      "fieldKey": "field_key_here",
      "value": "extracted value or null",
      "confidence": "HIGH|MEDIUM|LOW|MISSING",
      "pageNumber": 1,
      "section": "section heading if applicable",
      "quote": "exact text snippet from document"
    }
  ],
  "pageCount": <number of pages>
}`;

  const messages: Array<{ role: "user" | "system"; content: unknown }> = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: isPdf
        ? [
            {
              type: "image_url",
              image_url: {
                url: `data:application/pdf;base64,${base64}`,
                detail: "high",
              },
            },
            { type: "text", text: userPrompt },
          ]
        : [{ type: "text", text: `Document content (base64): ${base64}\n\n${userPrompt}` }],
    },
  ];

  const response = await client.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o",
    messages: messages as Parameters<typeof client.chat.completions.create>[0]["messages"],
    max_tokens: 8000,
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const parsed = parseJsonCompletionOrFallback<{
    fields?: ExtractedField[];
    pageCount?: number;
  }>(
    response,
    { fields: [], pageCount: 0 },
    "pdf-extract-legacy",
  );

  return {
    fields: parsed.fields || [],
    pageCount: parsed.pageCount || 0,
    model: response.model,
  };
}
