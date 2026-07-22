// backend/src/utils/openaiJsonSafe.ts
// Safe-parse helper for Azure OpenAI JSON-mode responses.
//
// Handles the two failure modes that used to bubble up as HTTP 500s from
// the Call Assist and PDF extraction paths:
//   1. finish_reason === "length" — model hit max_tokens mid-JSON, content
//      is truncated and unparseable (e.g. "Unterminated string in JSON at
//      position ~8000" from a 2000-token cap on gpt-4o).
//   2. JSON.parse throws — model returned malformed JSON for any other reason.
//
// In both cases we log one diagnostic line (finish_reason, usage,
// content.length, and — for parse errors — the SyntaxError message) and
// return the caller's fallback value. The happy path stays silent.
//
// Structural (duck-typed) input so this file has no dependency on the
// OpenAI SDK types.

type ChatCompletionShape = {
  choices: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null } | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
};

export function parseJsonCompletionOrFallback<T>(
  response: ChatCompletionShape,
  fallback: T,
  label: string,
): T {
  const choice = response.choices[0];
  const finishReason = choice?.finish_reason ?? "unknown";
  const content = choice?.message?.content ?? "";
  const usage = response.usage ?? null;

  if (finishReason === "length") {
    console.error(
      `[${label}] response TRUNCATED (finish_reason=length): content=${content.length} chars, usage=${JSON.stringify(usage)} — returning fallback`,
    );
    return fallback;
  }

  try {
    return JSON.parse(content) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[${label}] JSON parse failed (finish_reason=${finishReason}): ${msg}; content=${content.length} chars, usage=${JSON.stringify(usage)} — returning fallback`,
    );
    return fallback;
  }
}
