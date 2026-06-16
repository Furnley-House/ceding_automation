import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";

export interface DocumentRow {
  id: string;
  case_id?: string | null;
  file_name?: string | null;
  file_path?: string | null;
  filename?: string | null;
  original_name?: string | null;
  status?: string | null;
  uploaded_by?: string | null;
  document_type?: string | null;
  Provider_group?: string | null;
  fields_extracted?: number | null;
  avg_confidence?: number | null;
  extracted_data?: unknown | null;
  created_at?: string;
  [key: string]: unknown;
}

function toSnake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase();
}
function snakeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snakeKeys);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [toSnake(k), snakeKeys(val)])
    );
  return v;
}

export function useDocuments(
  caseId: string | undefined,
  options?: { refreshInterval?: number },
) {
  const refreshInterval = options?.refreshInterval ?? 0;
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!caseId) return;
    setLoading(true);
    try {
      const res = await api.get(`/cases/${caseId}/documents`);
      setDocuments((snakeKeys(res.data) as DocumentRow[]) ?? []);
    } catch (err) {
      console.error("useDocuments error", err);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  // S2 (Stage 3/4 redesign, Decision 5): opt-in live polling. When the caller
  // sets a refreshInterval, the doc list refreshes on that cadence — but
  // self-throttles to a no-op once every doc reaches a terminal status
  // (EXTRACTED / ERROR per the Prisma DocumentStatus enum). UPLOADED and
  // PROCESSING are treated as in-flight: keep polling. A `documentsRef`
  // lets the interval read the latest documents without re-creating the
  // timer on every render. The GET /api/cases/:id/documents route is
  // exempted from the rate limiter (backend/src/index.ts skip predicate)
  // so multi-user shared-NAT polling won't 429.
  const documentsRef = useRef(documents);
  useEffect(() => {
    documentsRef.current = documents;
  });

  useEffect(() => {
    refresh();
    if (refreshInterval <= 0) return;

    const id = setInterval(() => {
      const anyInFlight = documentsRef.current.some((d) => {
        const s = d.status;
        return s !== "EXTRACTED" && s !== "ERROR";
      });
      if (anyInFlight) refresh();
    }, refreshInterval);
    return () => clearInterval(id);
  }, [caseId, refresh, refreshInterval]);

  const removeDocument = async (doc: DocumentRow) => {
    try {
      await api.delete(`/cases/${caseId}/documents/${doc.id}`);
    } catch (err) {
      console.error("removeDocument error", err);
    }
    await refresh();
  };

  return { documents, loading, refresh, removeDocument };
}

export async function uploadDocumentFile({
  caseId,
  file,
}: {
  caseId: string;
  file: File;
}): Promise<DocumentRow | null> {
  const form = new FormData();
  form.append("file", file);
  const res = await api.post(`/cases/${caseId}/documents`, form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return snakeKeys(res.data) as DocumentRow;
}

// Fetch the PDF bytes through our own API and turn them into a same-origin
// object URL that react-pdf can load. We deliberately do NOT use the Azure
// SAS URL directly: in dev the storage account has no CORS rule for
// http://localhost:5173 and the browser would block the fetch even though
// the blob is reachable. Proxying through the backend keeps everything
// same-origin and reuses the existing auth interceptor.
//
// Callers must revoke the returned URL with URL.revokeObjectURL() when they
// no longer need it — otherwise the blob is kept alive for the page lifetime.
export async function getSignedUrl(
  caseId: string,
  docId: string
): Promise<string | null> {
  try {
    const res = await api.get(
      `/cases/${caseId}/documents/${docId}/raw`,
      { responseType: "blob" }
    );
    return URL.createObjectURL(res.data as Blob);
  } catch {
    return null;
  }
}
