import { History } from "lucide-react";
import { AuditTimeline } from "@/components/case/AuditTimeline";

const AuditTrail = () => {
  return (
    <div className="animate-slide-in space-y-6">
      <div className="flex items-start gap-3 pb-5 border-b border-border">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-teal/15 text-teal shrink-0">
          <History className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold theme-heading text-foreground">Audit Trail</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Immutable log of every field change across all cases — extractions, edits, approvals, calls.
          </p>
        </div>
      </div>

      <AuditTimeline showCase />
    </div>
  );
};

export default AuditTrail;
