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

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB (backend allows up to 50 MB; UI is intentionally stricter)

// Per FR-06: accept PDF, Word (.doc/.docx), Excel (.xls/.xlsx) and plain text.
// Some browsers / OSes report `application/octet-stream` for legacy Office
// files instead of the real MIME type, so we accept the file when EITHER the
// extension OR the MIME is recognised.
const ALLOWED_EXTENSIONS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt"] as const;
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
];
const EXTENSION_RE = new RegExp(`(${ALLOWED_EXTENSIONS.join("|").replace(/\./g, "\\.")})$`, "i");

function isAcceptedFile(f: File): boolean {
  return EXTENSION_RE.test(f.name) || ALLOWED_MIME_TYPES.includes(f.type);
}

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
        if (!isAcceptedFile(f)) {
          toast.error(`${f.name} is not a supported format`, {
            description: "Allowed: PDF, Word (.doc/.docx), Excel (.xls/.xlsx), plain text (.txt)",
          });
          return false;
        }
        return true;
      });
      if (valid.length === 0) return;

      setBusy(true);
      setUploadingNames(valid.map((v) => v.name));
      // Sequential one-at-a-time uploads, but each failure is contained to
      // its own file — a 400 on file 2 must not abort files 3..N. The old
      // `for/await` loop threw on the first failure and silently dropped
      // the rest, which read to testers as "multi-file sometimes doesn't
      // work" with no clue which file was the problem.
      const failures: { name: string; message: string }[] = [];
      let successes = 0;
      for (const f of valid) {
        try {
          await uploadDocumentFile({ caseId, file: f });
          successes++;
        } catch (e) {
          const message =
            (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
            (e instanceof Error ? e.message : "Upload failed");
          failures.push({ name: f.name, message });
        }
      }
      if (successes > 0) {
        toast.success(`Uploaded ${successes} document${successes === 1 ? "" : "s"}`);
        onUploaded?.();
      }
      for (const f of failures) {
        toast.error(`${f.name} failed`, { description: f.message });
      }
      setBusy(false);
      setUploadingNames([]);
    },
    [busy, caseId, onUploaded],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "application/msword": [".doc"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "application/vnd.ms-excel": [".xls"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "text/plain": [".txt"],
    },
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
        {isDragActive ? "Drop the documents here…" : "Drop policy documents here"}
      </p>
      <p className="text-xs text-muted-foreground mb-4">
        PDF · Word (.doc/.docx) · Excel (.xls/.xlsx) · Plain text (.txt) · 20 MB max each
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
