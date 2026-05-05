import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, FileText, Loader2 } from "lucide-react";
import { uploadDocumentFile } from "@/hooks/useDocuments";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface Props {
  caseId: string;
  onUploaded?: () => void;
}

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

export function DocumentUploader({ caseId, onUploaded }: Props) {
  const [busy, setBusy] = useState(false);
  const [uploadingNames, setUploadingNames] = useState<string[]>([]);

  const onDrop = useCallback(
    async (files: File[]) => {
      if (busy) return;
      const valid = files.filter((f) => {
        if (f.size > MAX_BYTES) {
          toast.error(`${f.name} is over 20 MB`);
          return false;
        }
        if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") {
          toast.error(`${f.name} is not a PDF`);
          return false;
        }
        return true;
      });
      if (valid.length === 0) return;

      setBusy(true);
      setUploadingNames(valid.map((v) => v.name));
      try {
        for (const f of valid) {
          await uploadDocumentFile({ caseId, file: f });
        }
        toast.success(`Uploaded ${valid.length} document${valid.length === 1 ? "" : "s"}`);
        onUploaded?.();
      } catch (e: any) {
        console.error(e);
        toast.error("Upload failed", { description: e?.message ?? "Please retry" });
      } finally {
        setBusy(false);
        setUploadingNames([]);
      }
    },
    [busy, caseId, onUploaded],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: true,
    noClick: true,
  });

  return (
    <div
      {...getRootProps()}
      className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
        isDragActive ? "border-teal bg-teal/5" : "border-border bg-muted/20 hover:bg-muted/30"
      }`}
    >
      <input {...getInputProps()} />
      <Upload className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
      <p className="text-sm font-semibold text-foreground mb-1">
        {isDragActive ? "Drop the PDFs here…" : "Drop policy pack PDFs here"}
      </p>
      <p className="text-xs text-muted-foreground mb-4">
        Multiple files supported · 20 MB max each · provider packs, illustrations, terms
      </p>
      <Button type="button" onClick={open} disabled={busy} variant="outline" size="sm">
        {busy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Uploading…
          </>
        ) : (
          <>
            <FileText className="h-3.5 w-3.5 mr-1.5" /> Browse files
          </>
        )}
      </Button>
      {uploadingNames.length > 0 && (
        <div className="mt-3 text-xs text-muted-foreground space-y-0.5">
          {uploadingNames.map((n) => (
            <div key={n}>↑ {n}</div>
          ))}
        </div>
      )}
    </div>
  );
}
