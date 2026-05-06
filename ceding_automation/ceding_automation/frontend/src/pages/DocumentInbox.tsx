import { SectionHeader } from "@/components/shared/StatusComponents";
import { FolderOpen, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

/**
 * Document upload is now handled per-case in the Case workspace (Stage 3 — Document Upload).
 * This standalone inbox page is no longer active.
 */
const DocumentInbox = () => {
  const navigate = useNavigate();
  return (
    <div className="animate-slide-in">
      <SectionHeader title="Document Inbox" subtitle="Upload and process policy documents" />
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <FolderOpen className="h-12 w-12 text-muted-foreground/40 mb-4" />
        <p className="text-sm font-semibold text-foreground mb-1">Documents are now managed per case</p>
        <p className="text-xs text-muted-foreground max-w-sm mb-6">
          Open a case and navigate to <strong>Stage 3 — Document Upload</strong> to attach policy PDFs and run AI extraction.
        </p>
        <Button onClick={() => navigate("/cases")} className="gap-2">
          Go to Cases <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};

export default DocumentInbox;
