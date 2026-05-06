import { useEffect, useState, useCallback } from "react";
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
  provider_name?: string | null;
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

export function useDocuments(caseId: string | undefined) {
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

  useEffect(() => { refresh(); }, [refresh]);

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

export async function getSignedUrl(
  caseId: string,
  docId: string
): Promise<string | null> {
  try {
    const res = await api.get(`/cases/${caseId}/documents/${docId}/url`);
    return (res.data as { url?: string })?.url ?? null;
  } catch {
    return null;
  }
}
