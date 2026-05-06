import { SectionHeader } from "@/components/shared/StatusComponents";
import { Phone, ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

/**
 * The standalone Call Assist page has been replaced by the per-case Call Workspace
 * (Stage 5 inside each case). Navigate to a case and open Stage 5 to access the
 * AI call script, RingCentral dialler, and transcript upload.
 */
const CallAssist = () => {
  const navigate = useNavigate();
  return (
    <div className="animate-slide-in">
      <SectionHeader
        title="Call Assist"
        subtitle="AI call scripts and transcript analysis"
      />
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Phone className="h-12 w-12 text-muted-foreground/40 mb-4" />
        <p className="text-sm font-semibold text-foreground mb-1">Call Assist is now per-case</p>
        <p className="text-xs text-muted-foreground max-w-sm mb-6">
          Open a case and navigate to <strong>Stage 5 — Call Assist</strong> to generate an AI script for missing fields, launch the RingCentral dialler, and analyse call transcripts.
        </p>
        <Button onClick={() => navigate("/cases")} className="gap-2">
          Go to Cases <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};

export default CallAssist;
