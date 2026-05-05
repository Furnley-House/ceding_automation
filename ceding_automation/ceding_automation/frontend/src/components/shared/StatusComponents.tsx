import type { Confidence, EvidenceSource, CaseStatus } from "@/data/seedData";

export function ConfidenceBadge({ level }: { level: Confidence }) {
  const styles: Record<Confidence, string> = {
    high: "bg-success/15 text-success",
    medium: "bg-warning/15 text-warning",
    low: "bg-overdue/15 text-overdue",
  };
  const tooltips: Record<Confidence, string> = {
    high: "AI is highly confident in this extracted value",
    medium: "AI has moderate confidence — may need review",
    low: "AI has low confidence — likely needs manual verification",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${styles[level]}`}
      title={tooltips[level]}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${level === 'high' ? 'bg-success' : level === 'medium' ? 'bg-warning' : 'bg-overdue'}`} />
      {level.charAt(0).toUpperCase() + level.slice(1)} confidence
    </span>
  );
}

export function EvidenceBadge({ source }: { source: EvidenceSource }) {
  const styles: Record<EvidenceSource, string> = {
    pdf: "bg-info/15 text-info",
    call: "bg-primary/15 text-primary",
    email: "bg-accent text-accent-foreground",
    manual: "bg-muted text-muted-foreground",
  };
  const labels: Record<EvidenceSource, string> = { pdf: 'PDF', call: 'Call', email: 'Email', manual: 'Manual' };
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${styles[source]}`}>
      {labels[source]}
    </span>
  );
}

export function StatusChip({ status }: { status: CaseStatus }) {
  const styles: Record<CaseStatus, string> = {
    loa_sent: "bg-info/15 text-info",
    loa_processed: "bg-info/15 text-info",
    waiting_pdf: "bg-warning/15 text-warning",
    pdf_received: "bg-primary/15 text-primary",
    ceding_in_progress: "bg-primary/15 text-primary",
    complete: "bg-success/15 text-success",
  };
  const labels: Record<CaseStatus, string> = {
    loa_sent: 'LOA Sent',
    loa_processed: 'LOA Processed',
    waiting_pdf: 'Waiting PDF',
    pdf_received: 'PDF Received',
    ceding_in_progress: 'Ceding In Progress',
    complete: 'Complete',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

export function FieldStatusIcon({ status }: { status: 'complete' | 'missing' | 'needs_review' }) {
  if (status === 'complete') return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-success/15 text-success text-xs">✓</span>;
  if (status === 'missing') return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-overdue/15 text-overdue text-xs">✕</span>;
  return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-warning/15 text-warning text-xs">!</span>;
}

export function KPICard({ title, value, subtitle, accent }: { title: string; value: string | number; subtitle?: string; accent?: 'default' | 'warning' | 'success' | 'overdue' }) {
  const border = accent === 'warning' ? 'border-l-warning' : accent === 'success' ? 'border-l-success' : accent === 'overdue' ? 'border-l-overdue' : 'border-l-primary';
  return (
    <div className={`rounded-xl border border-border bg-card p-5 border-l-4 ${border}`}>
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      <p className="mt-1 text-3xl font-bold text-foreground">{value}</p>
      {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

export function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
