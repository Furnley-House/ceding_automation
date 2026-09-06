// backend/src/routes/documents.ts returns each Document with its
// `aiExtractionNotes` JSONB column intact; useDocuments.ts runs the
// response through snakeKeys so the frontend reads
// `document.ai_extraction_notes`. The stored shape is the
// DetectionOutcome contract from ceding-ai-pipeline
// (models/extraction_response.py) — populated by aiBffApply from the
// pipeline's write-back when Stage 1 (provider) or Stage 2 (plan type)
// fell back to case-supplied values. Rendered above the ChecklistPanel
// in ExtractionWorkspace so a CA reviewing the extracted fields sees
// WHY the values may need extra scrutiny, tied to the document
// currently shown in the PDF viewer.

import { AlertTriangle } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

// ── COPY (pending sign-off) — swap here without touching logic ───────────
export const EXTRACTION_NOTES_COPY = {
  provider: {
    knownFallback: (name: string) =>
      `This document didn't clearly identify a provider. Extraction ran using "${name}" from the case.`,
    unknownFallback:
      "This document didn't identify a provider, and the case doesn't have a confirmed one either. Extraction ran with limited context — please double-check the values.",
  },
  planType: {
    knownFallback: (planType: string) =>
      `This document didn't clearly identify a plan type. Extraction ran using "${planType}" from the case.`,
    unknownFallback:
      "This document didn't identify a plan type, and the case doesn't have a confirmed one either. Extraction ran with limited context — please double-check the values.",
  },
  titleBoth: "Extraction ran with limited context",
  titleOne: "One detection fell back to the case",
} as const;
// ─────────────────────────────────────────────────────────────────────────

// Shape stored on documents.ai_extraction_notes JSONB — mirrors the wire
// contract in ceding-ai-pipeline models/extraction_response.py. Kept
// permissive (all fields optional) because the column is nullable and
// pre-piece-1b documents have null; post-piece-1b documents from a
// happy-path extraction have provider.failed = plan_type.failed = false.
interface ProviderEffective {
  name?: string | null;
  canonical?: string | null;
  is_known_provider?: boolean;
}
interface ProviderBlock {
  failed?: boolean;
  failure_reason?: string | null;
  effective?: ProviderEffective;
}
interface PlanTypeBlock {
  failed?: boolean;
  failure_reason?: string | null;
  effective?: string | null;
}
interface DetectionNotes {
  provider?: ProviderBlock;
  plan_type?: PlanTypeBlock;
}

function isDetectionNotes(v: unknown): v is DetectionNotes {
  return typeof v === "object" && v !== null;
}

export interface BannerContent {
  show: boolean;
  title: string;
  lines: string[];
}

/**
 * Pure logic — deciding what (if anything) the banner should say.
 * Extracted so the branching is unit-testable without rendering React.
 *
 * Returns `show: false` when the notes are null / not the expected shape /
 * both detection stages succeeded.
 *
 * Edge-case discipline: when the pipeline's `effective` name is
 * "Unknown Provider" (or is_known_provider === false) OR the plan_type
 * `effective` is "UNKNOWN"/null, we render the "limited context" copy
 * INSTEAD of naming the unknown value back at the CA — "we've used
 * 'Unknown Provider' from the case" would be misleading and unhelpful.
 */
export function computeBanner(notes: unknown): BannerContent {
  if (!isDetectionNotes(notes)) {
    return { show: false, title: "", lines: [] };
  }
  const providerFailed = notes.provider?.failed === true;
  const planTypeFailed = notes.plan_type?.failed === true;
  if (!providerFailed && !planTypeFailed) {
    return { show: false, title: "", lines: [] };
  }

  const providerName = notes.provider?.effective?.name ?? null;
  const providerIsKnown =
    notes.provider?.effective?.is_known_provider === true;
  const planTypeName = notes.plan_type?.effective ?? null;
  const planTypeIsUnknown = !planTypeName || planTypeName === "UNKNOWN";

  const lines: string[] = [];

  if (providerFailed) {
    if (
      providerIsKnown &&
      providerName &&
      providerName !== "Unknown Provider"
    ) {
      lines.push(EXTRACTION_NOTES_COPY.provider.knownFallback(providerName));
    } else {
      lines.push(EXTRACTION_NOTES_COPY.provider.unknownFallback);
    }
  }
  if (planTypeFailed) {
    if (!planTypeIsUnknown) {
      lines.push(
        EXTRACTION_NOTES_COPY.planType.knownFallback(planTypeName!),
      );
    } else {
      lines.push(EXTRACTION_NOTES_COPY.planType.unknownFallback);
    }
  }

  const title =
    providerFailed && planTypeFailed
      ? EXTRACTION_NOTES_COPY.titleBoth
      : EXTRACTION_NOTES_COPY.titleOne;

  return { show: true, title, lines };
}

interface Props {
  /** JSONB blob from the current document's ai_extraction_notes column.
   *  Null / undefined when the document was extracted cleanly, or when
   *  it predates piece 1b and was never re-extracted. Typed as unknown
   *  because the column is JSONB and DocumentRow doesn't (and shouldn't)
   *  strong-type the whole blob shape at hook level. */
  notes: unknown;
}

/**
 * Warning-tone advisory. Reuses the shadcn Alert primitive
 * (frontend/src/components/ui/alert.tsx) — the same shell every other
 * advisory in the app uses. Alert ships `default` and `destructive`
 * variants only; there is no `warning` variant, so we apply amber
 * Tailwind classes at the call site rather than mutating the primitive.
 * Icon is `AlertTriangle` from lucide-react (already a dependency,
 * used by accordion / breadcrumb / etc.).
 */
export function ExtractionNotesBanner({ notes }: Props) {
  const content = computeBanner(notes);
  if (!content.show) return null;

  return (
    <Alert className="mb-3 border-amber-500/50 bg-amber-50 text-amber-950 dark:border-amber-500/60 dark:bg-amber-900/20 dark:text-amber-100 [&>svg]:text-amber-600">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{content.title}</AlertTitle>
      <AlertDescription>
        {content.lines.length === 1 ? (
          <p>{content.lines[0]}</p>
        ) : (
          <ul className="list-disc pl-5 space-y-1">
            {content.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}
