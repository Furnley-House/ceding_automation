import { SectionHeader, ConfidenceBadge } from "@/components/shared/StatusComponents";
import { useState, useRef, useCallback, useEffect } from "react";
import { Upload, FileText, CheckCircle, Cpu, AlertCircle, Eye } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import type { Tables } from "@/integrations/supabase/types";

type DocRow = Tables<"documents">;

const DocumentInbox = () => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [extracting, setExtracting] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [previewDoc, setPreviewDoc] = useState<DocRow | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch documents on mount
  const fetchDocs = useCallback(async () => {
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .order("created_at", { ascending: false });
    if (!error && data) setDocs(data);
  }, []);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  // ── Upload handler ──
  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];

    if (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) {
      toast.error("Only PDF files are supported at this time.");
      return;
    }

    setUploading(true);
    try {
      const filePath = `inbox/${Date.now()}_${file.name}`;
      const { error: storageErr } = await supabase.storage
        .from("policy-documents")
        .upload(filePath, file);
      if (storageErr) throw storageErr;

      const user = (await supabase.auth.getUser()).data.user;

      const { error: dbErr } = await supabase.from("documents").insert({
        file_name: file.name,
        file_path: filePath,
        status: "pending",
        uploaded_by: user?.id ?? null,
      });
      if (dbErr) throw dbErr;

      toast.success(`"${file.name}" uploaded successfully`);
      await fetchDocs();
    } catch (err: any) {
      console.error("Upload error:", err);
      toast.error(err.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // ── AI extraction handler ──
  const handleRunExtraction = async (docId: string) => {
    setExtracting(docId);
    try {
      const { data, error } = await supabase.functions.invoke("extract-policy", {
        body: { documentId: docId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast.success(`Extraction complete — ${data.fieldsExtracted ?? 0} fields extracted`);
      await fetchDocs();
    } catch (err: any) {
      console.error("Extraction error:", err);
      toast.error(err.message || "AI extraction failed");
    } finally {
      setExtracting(null);
    }
  };

  // ── Drag events ──
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true); };
  const onDragLeave = () => setIsDragOver(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  return (
    <div className="animate-slide-in">
      <SectionHeader title="Document Inbox" subtitle="Upload and process policy documents" />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={e => handleFiles(e.target.files)}
      />

      {/* Drop zone */}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        disabled={uploading}
        className={`mb-8 flex w-full cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition-colors ${
          isDragOver ? "border-primary bg-primary/5" : "border-border bg-card"
        } ${uploading ? "opacity-60 pointer-events-none" : "hover:border-primary/50"}`}
      >
        {uploading ? (
          <>
            <Cpu className="mb-3 h-10 w-10 text-primary animate-spin" />
            <p className="text-sm font-medium text-foreground">Uploading…</p>
          </>
        ) : (
          <>
            <Upload className="mb-3 h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Drag & drop policy PDFs here</p>
            <p className="mt-1 text-xs text-muted-foreground">or click to browse · PDF supported</p>
          </>
        )}
      </button>

      {/* Empty state */}
      {docs.length === 0 && !uploading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No documents yet. Upload a PDF to get started.</p>
        </div>
      )}

      {/* Documents list */}
      <div className="space-y-4">
        {docs.map(doc => {
          const isExtracting = extracting === doc.id;
          const isExtracted = doc.status === "extracted";
          const extractedData = doc.extracted_data as any[] | null;

          return (
            <div key={doc.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <FileText className="mt-1 h-8 w-8 text-primary shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">{doc.file_name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {doc.provider_name && `${doc.provider_name} · `}
                      {doc.document_type ?? "Policy Document"} · Uploaded{" "}
                      {new Date(doc.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  {isExtracted ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-600">
                      <CheckCircle className="h-3.5 w-3.5" /> {doc.fields_extracted ?? 0} fields extracted
                    </span>
                  ) : isExtracting ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary animate-pulse">
                      <Cpu className="h-3.5 w-3.5 animate-spin" /> AI extracting…
                    </span>
                  ) : (
                    <button
                      onClick={() => handleRunExtraction(doc.id)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                      <Cpu className="h-3.5 w-3.5" /> Run AI Extraction
                    </button>
                  )}
                </div>
              </div>

              {/* Extraction progress */}
              {isExtracting && (
                <div className="mt-4">
                  <Progress value={undefined} className="h-1.5" />
                  <p className="mt-2 text-xs text-muted-foreground">
                    Analysing document with AI… this may take 30–60 seconds.
                  </p>
                </div>
              )}

              {/* Extracted summary */}
              {isExtracted && (
                <div className="mt-4 space-y-3">
                  <div className="grid grid-cols-3 gap-4 rounded-lg bg-muted/30 p-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Fields Extracted</p>
                      <p className="text-lg font-bold text-foreground">{doc.fields_extracted ?? 0}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Avg Confidence</p>
                      <ConfidenceBadge
                        level={
                          (doc.avg_confidence ?? 0) >= 80
                            ? "high"
                            : (doc.avg_confidence ?? 0) >= 50
                            ? "medium"
                            : "low"
                        }
                      />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Provider Detected</p>
                      <p className="text-sm font-semibold text-foreground">
                        {doc.provider_name ?? "—"}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={() => setPreviewDoc(doc)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                  >
                    <Eye className="h-3.5 w-3.5" /> View extracted fields
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Extracted fields dialog */}
      <Dialog open={!!previewDoc} onOpenChange={() => setPreviewDoc(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Extracted Fields — {previewDoc?.file_name}</DialogTitle>
            <DialogDescription>
              AI-extracted data from the policy document. Review and verify before use.
            </DialogDescription>
          </DialogHeader>

          {previewDoc?.extracted_data && Array.isArray(previewDoc.extracted_data) ? (
            <div className="space-y-4 mt-2">
              {Object.entries(
                (previewDoc.extracted_data as any[]).reduce((acc: Record<string, any[]>, f: any) => {
                  const section = f.section || "Other";
                  if (!acc[section]) acc[section] = [];
                  acc[section].push(f);
                  return acc;
                }, {})
              ).map(([section, fields]) => (
                <div key={section}>
                  <h4 className="text-sm font-semibold text-foreground mb-2">{section}</h4>
                  <div className="rounded-lg border border-border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-muted/50">
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Field</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Value</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Confidence</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(fields as any[]).map((f: any, idx: number) => (
                          <tr key={idx} className="border-t border-border">
                            <td className="px-3 py-2 text-foreground">{f.label}</td>
                            <td className="px-3 py-2 text-foreground font-medium">{f.value ?? "—"}</td>
                            <td className="px-3 py-2">
                              <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                                f.confidence === "high"
                                  ? "bg-green-100 text-green-700"
                                  : f.confidence === "medium"
                                  ? "bg-yellow-100 text-yellow-700"
                                  : "bg-red-100 text-red-700"
                              }`}>
                                {f.confidence ?? "—"}
                              </span>
                            </td>
                            <td className="px-3 py-2">
                              {f.status === "complete" ? (
                                <CheckCircle className="h-3.5 w-3.5 text-green-600" />
                              ) : f.status === "needs_review" ? (
                                <AlertCircle className="h-3.5 w-3.5 text-yellow-600" />
                              ) : (
                                <span className="text-muted-foreground">missing</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-4">No extracted data available.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DocumentInbox;
