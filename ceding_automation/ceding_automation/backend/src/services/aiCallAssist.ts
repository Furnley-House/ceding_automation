// backend/src/services/aiCallAssist.ts
// Azure OpenAI helpers for Call Assist: script generation + transcript analysis.
// Provides static fallbacks when Azure OpenAI is not configured.
import { AzureOpenAI } from "openai";

function isAIConfigured(): boolean {
  const key = process.env.AZURE_OPENAI_API_KEY ?? "";
  return (
    !!process.env.AZURE_OPENAI_ENDPOINT &&
    key.length > 0 &&
    !key.startsWith("your-")
  );
}

function makeClient() {
  return new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
    apiKey: process.env.AZURE_OPENAI_API_KEY!,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o",
  });
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface ScriptQuestion {
  field_key: string;
  question: string;
  purpose: "obtain" | "verify";
}

export interface CallScript {
  opener: string;
  sections: Array<{ title: string; questions: ScriptQuestion[] }>;
  objection_handlers: Array<{ objection: string; response: string }>;
  closing: string;
}

export interface ScriptInput {
  missingFields: Array<{ key: string; label: string; section: string; hint?: string | null }>;
  reviewFields: Array<{ key: string; label: string; value: string; confidence: string }>;
  clientName: string;
  providerName: string;
  planNumber: string;
  planType: string;
}

export interface AnalysedField {
  key: string;
  value: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "MISSING";
  evidence_quote: string;
  reasoning?: string;
}

export interface AnalysisResult {
  extracted: AnalysedField[];
  summary: string;
}

export interface AnalysisInput {
  transcript: string;
  targets: Array<{ key: string; label: string; type?: string; hint?: string }>;
  clientName: string;
  providerName: string;
  planNumber: string;
}

// ── Script generation ─────────────────────────────────────────────────────

export async function generateCallScript(input: ScriptInput): Promise<CallScript> {
  if (!isAIConfigured()) return buildStaticScript(input);

  const client = makeClient();

  const fieldLines = [
    ...input.missingFields.map(
      (f) =>
        `MISSING: ${f.label} [${f.key}] — ${f.section}${f.hint ? ` (hint: ${f.hint})` : ""}`
    ),
    ...input.reviewFields.map(
      (f) =>
        `VERIFY: ${f.label} [${f.key}] — currently recorded as "${f.value}" (${f.confidence} confidence)`
    ),
  ].join("\n");

  const prompt = `You are a UK financial services call script generator for Furnley House Financial Planning Partners.
Create a professional, concise phone script for their ceding administration team to call ${input.providerName} regarding client ${input.clientName}, policy ${input.planNumber} (${input.planType} plan).

Fields to obtain or verify:
${fieldLines}

Requirements:
- Compliant with FCA communication standards
- Mention the LOA/Authority to Act that should already be on file
- Group related questions into logical sections
- Include 2–3 common objection handlers relevant to pension ceding calls
- Keep the opener under 60 words

Return ONLY valid JSON (no preamble) matching this exact schema:
{
  "opener": "string",
  "sections": [
    {
      "title": "string",
      "questions": [
        { "field_key": "string", "question": "string", "purpose": "obtain" | "verify" }
      ]
    }
  ],
  "objection_handlers": [
    { "objection": "string", "response": "string" }
  ],
  "closing": "string"
}`;

  const response = await client.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2000,
    temperature: 0.3,
    response_format: { type: "json_object" },
  });

  return JSON.parse(response.choices[0].message.content || "{}") as CallScript;
}

function buildStaticScript(input: ScriptInput): CallScript {
  return {
    opener: `Good morning/afternoon, my name is [Your Name] from Furnley House Financial Planning Partners, calling on behalf of our client ${input.clientName}. We have an Authority to Act / LOA on file. I'm calling regarding plan ${input.planNumber || "(plan number)"}. Could I please speak with someone in your ceding or transfers department?`,
    sections: [
      {
        title: "Outstanding Information",
        questions: [
          ...input.missingFields.map((f) => ({
            field_key: f.key,
            question: `Could you please confirm the ${f.label} for this plan?`,
            purpose: "obtain" as const,
          })),
          ...input.reviewFields.map((f) => ({
            field_key: f.key,
            question: `We have the ${f.label} recorded as "${f.value}" — could you confirm that's correct?`,
            purpose: "verify" as const,
          })),
        ],
      },
    ],
    objection_handlers: [
      {
        objection: "We cannot discuss this without written authorisation",
        response:
          "We have a signed Letter of Authority on file dated [date] — I can quote the reference. Shall I email a copy across?",
      },
      {
        objection: "You need to submit that in writing",
        response:
          "Understood. Could you confirm the correct email address for your ceding team so we can follow up in writing today?",
      },
      {
        objection: "The system is down / call back later",
        response:
          "Of course. Could I take your name and direct dial so we can call back at a convenient time?",
      },
    ],
    closing:
      "Thank you so much for your help. Could I take your name and a direct line or email for our records? We'll send written confirmation of today's call. Have a great day.",
  };
}

// ── Transcript analysis ───────────────────────────────────────────────────

export async function analyseTranscript(input: AnalysisInput): Promise<AnalysisResult> {
  if (!isAIConfigured()) {
    return {
      extracted: [],
      summary:
        "Azure OpenAI is not configured — transcript saved but not analysed automatically. " +
        "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .env to enable AI analysis.",
    };
  }

  const client = makeClient();

  const targetLines = input.targets
    .map(
      (t) =>
        `- ${t.key}: ${t.label}${t.type ? ` (${t.type})` : ""}${t.hint ? ` — ${t.hint}` : ""}`
    )
    .join("\n");

  const prompt = `You are a UK financial services transcript analysis AI for Furnley House Financial Planning Partners.
Analyse the following call transcript to extract field values for client ${input.clientName}, policy ${input.planNumber} at ${input.providerName}.

TARGET FIELDS TO EXTRACT:
${targetLines}

TRANSCRIPT:
${input.transcript}

Rules:
- Only extract fields explicitly discussed in the transcript
- MISSING = topic was not addressed at all (omit these from extracted array)
- HIGH = value clearly and unambiguously stated
- MEDIUM = clearly implied
- LOW = uncertain interpretation
- Monetary values: include £ symbol (e.g. "£127,450.32")
- Percentages: include % (e.g. "0.45%")
- Dates: DD/MM/YYYY

Return ONLY valid JSON:
{
  "extracted": [
    {
      "key": "field_key",
      "value": "extracted value",
      "confidence": "HIGH|MEDIUM|LOW",
      "evidence_quote": "verbatim quote from transcript",
      "reasoning": "brief reasoning"
    }
  ],
  "summary": "2-3 sentence summary of what was confirmed in this call"
}`;

  const response = await client.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2500,
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(response.choices[0].message.content || "{}");

  return {
    extracted: ((parsed.extracted as AnalysedField[]) ?? []).filter(
      (f) => f.confidence !== "MISSING" && f.value
    ),
    summary: parsed.summary ?? "",
  };
}
