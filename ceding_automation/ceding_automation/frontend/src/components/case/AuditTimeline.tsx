import { useEffect, useMemo, useState } from "react";
import { auditApi } from "@/lib/api";
import {
  Sparkles,
  Pencil,
  Phone,
  ThumbsUp,
  RotateCcw,
  MessageSquare,
  Download,
  Search,
  History,
  Loader2,
  ArrowRight,
  User,
  FilePlus,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Bell,
  ClipboardCheck,
  Shuffle,
  Mail,
  Cloud,
  ListChecks,
  PhoneCall,
  Layers,
  Send,
  CircleDot,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

interface AuditRow {
  id: string;
  created_at: string;
  case_id: string;
  case_ref?: string | null;
  client_name?: string | null;
  user_id?: string | null;
  field_id?: string | null;
  field_key?: string | null;
  field_label?: string | null;
  action: string;
  source: string;
  old_value?: string | null;
  new_value?: string | null;
  confidence?: string | null;
  actor_name?: string | null;
  actor_role?: string | null;
  notes?: string | null;
}

interface Props {
  /** Scope to a single case. Omit for global view. */
  caseId?: string;
  /** Show case ref + client name on each row (defaults to true when caseId is omitted). */
  showCase?: boolean;
  /** Default page size when querying the global endpoint. */
  pageSize?: number;
}

// Full mapping of every AuditAction enum value (backend schema) to a UI label
// + icon + Tailwind colour classes. Keys MUST match the backend Prisma enum
// exactly. Anything not listed falls through to a neutral default.
const ACTION_META: Record<
  string,
  { label: string; icon: React.ElementType; cls: string }
> = {
  // Case lifecycle
  CASE_CREATED: {
    label: "Case created",
    icon: FilePlus,
    cls: "bg-teal/15 text-teal border-teal/30",
  },
  CASE_UPDATED: {
    label: "Case updated",
    icon: Pencil,
    cls: "bg-info/15 text-info border-info/30",
  },
  CASE_STATUS_CHANGED: {
    label: "Status changed",
    icon: Shuffle,
    cls: "bg-info/15 text-info border-info/30",
  },
  CASE_ASSIGNED: {
    label: "Assigned",
    icon: User,
    cls: "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30",
  },
  CASE_MARKED_READY: {
    label: "Ready for review",
    icon: ClipboardCheck,
    cls: "bg-info/15 text-info border-info/30",
  },
  CASE_APPROVED: {
    label: "Case approved",
    icon: CheckCircle2,
    cls: "bg-success/15 text-success border-success/30",
  },
  // Document + extraction
  DOCUMENT_UPLOADED: {
    label: "Document uploaded",
    icon: FileText,
    cls: "bg-teal/15 text-teal border-teal/30",
  },
  DOCUMENT_DELETED: {
    label: "Document deleted",
    icon: FileText,
    cls: "bg-overdue/15 text-overdue border-overdue/30",
  },
  AI_EXTRACTION_RUN: {
    label: "AI extraction",
    icon: Sparkles,
    cls: "bg-teal/15 text-teal border-teal/30",
  },
  FIELD_EXTRACTED: {
    label: "Field extracted",
    icon: Sparkles,
    cls: "bg-teal/10 text-teal border-teal/20",
  },
  FIELD_EDITED: {
    label: "Manual edit",
    icon: Pencil,
    cls: "bg-warning/15 text-warning border-warning/30",
  },
  FIELD_APPROVED: {
    label: "Field approved",
    icon: ThumbsUp,
    cls: "bg-success/15 text-success border-success/30",
  },
  FIELD_REVIEW_REQUESTED: {
    label: "Review requested",
    icon: RotateCcw,
    cls: "bg-overdue/15 text-overdue border-overdue/30",
  },
  CONFLICT_RESOLVED: {
    label: "Conflict resolved",
    icon: AlertTriangle,
    cls: "bg-warning/15 text-warning border-warning/30",
  },
  // Calls
  CALL_SCRIPT_GENERATED: {
    label: "Call script",
    icon: PhoneCall,
    cls: "bg-info/15 text-info border-info/30",
  },
  TRANSCRIPT_UPLOADED: {
    label: "Transcript uploaded",
    icon: Phone,
    cls: "bg-info/15 text-info border-info/30",
  },
  TRANSCRIPT_ANALYSED: {
    label: "Transcript analysed",
    icon: Phone,
    cls: "bg-info/15 text-info border-info/30",
  },
  // Export / WorkDrive
  CHECKLIST_EXPORTED: {
    label: "Checklist exported",
    icon: Download,
    cls: "bg-teal/15 text-teal border-teal/30",
  },
  WORKDRIVE_EXPORTED: {
    label: "WorkDrive upload",
    icon: Cloud,
    cls: "bg-teal/15 text-teal border-teal/30",
  },
  // Comms
  COMMENT_ADDED: {
    label: "Comment",
    icon: MessageSquare,
    cls: "bg-muted text-muted-foreground border-border",
  },
  CHASE_LOGGED: {
    label: "Chase logged",
    icon: Mail,
    cls: "bg-warning/15 text-warning border-warning/30",
  },
  LOA_STATUS_UPDATED: {
    label: "LOA status",
    icon: Send,
    cls: "bg-info/15 text-info border-info/30",
  },
  ZOHO_TASK_CREATED: {
    label: "Zoho task",
    icon: ListChecks,
    cls: "bg-info/15 text-info border-info/30",
  },
  NOTIFICATION_SENT: {
    label: "Notification",
    icon: Bell,
    cls: "bg-muted text-muted-foreground border-border",
  },
  // Fund lines
  FUND_LINE_ADDED: {
    label: "Fund line added",
    icon: Layers,
    cls: "bg-teal/15 text-teal border-teal/30",
  },
  FUND_LINE_UPDATED: {
    label: "Fund line edited",
    icon: Layers,
    cls: "bg-warning/15 text-warning border-warning/30",
  },
  FUND_LINE_REMOVED: {
    label: "Fund line removed",
    icon: Layers,
    cls: "bg-overdue/15 text-overdue border-overdue/30",
  },
};

const SOURCE_META: Record<string, string> = {
  AI: "AI",
  MANUAL: "Manual",
  TRANSCRIPT: "Call",
  SYSTEM: "System",
  // legacy / case-insensitive fallbacks
  ai: "AI",
  manual: "Manual",
  call: "Call",
  system: "System",
};

function actionMeta(action: string) {
  return (
    ACTION_META[action] ?? {
      label: action.replace(/_/g, " ").toLowerCase(),
      icon: CircleDot,
      cls: "bg-muted text-muted-foreground border-border",
    }
  );
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function AuditTimeline({ caseId, showCase, pageSize = 200 }: Props) {
  // Default `showCase` to true when there's no caseId (global view) and false
  // otherwise (per-case view doesn't need to repeat the case ref on every row).
  const showCaseLabel = showCase ?? !caseId;

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (caseId) {
          const res = await auditApi.getForCase(caseId);
          if (!cancelled) {
            const list = (res.data as AuditRow[]) ?? [];
            setRows(list);
            setTotal(list.length);
          }
        } else {
          // Global view — admin / paraplanner / adviser only (backend gates).
          const res = await auditApi.list({ limit: pageSize });
          const data = res.data as
            | { logs: AuditRow[]; total: number }
            | AuditRow[];
          const list = Array.isArray(data) ? data : data.logs;
          const t = Array.isArray(data) ? list.length : data.total;
          if (!cancelled) {
            setRows(list ?? []);
            setTotal(t ?? 0);
          }
        }
      } catch (err) {
        const e = err as {
          response?: { status?: number; data?: { error?: string } };
          message?: string;
        };
        const status = e?.response?.status;
        if (!cancelled) {
          setRows([]);
          setError(
            status === 403
              ? "You don't have access to the global audit trail."
              : (e?.response?.data?.error ??
                  e?.message ??
                  "Failed to load audit log"),
          );
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId, pageSize]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (actionFilter !== "all" && r.action !== actionFilter) return false;
      if (sourceFilter !== "all" && r.source !== sourceFilter) return false;
      if (search.trim()) {
        const s = search.toLowerCase();
        const hay = [
          r.field_label,
          r.field_key,
          r.old_value,
          r.new_value,
          r.actor_name,
          r.notes,
          r.case_ref,
          r.client_name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [rows, actionFilter, sourceFilter, search]);

  const grouped = useMemo(() => {
    const groups: Record<string, AuditRow[]> = {};
    filtered.forEach((r) => {
      const day = new Date(r.created_at).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      (groups[day] ??= []).push(r);
    });
    return Object.entries(groups);
  }, [filtered]);

  const exportCsv = () => {
    const headers = [
      "timestamp",
      "case_ref",
      "client",
      "action",
      "source",
      "field_label",
      "field_key",
      "old_value",
      "new_value",
      "confidence",
      "actor_name",
      "actor_role",
      "notes",
    ];
    const lines = [headers.join(",")];
    filtered.forEach((r) => {
      lines.push(
        [
          new Date(r.created_at).toISOString(),
          r.case_ref ?? "",
          r.client_name ?? "",
          r.action,
          r.source,
          r.field_label ?? "",
          r.field_key ?? "",
          r.old_value ?? "",
          r.new_value ?? "",
          r.confidence ?? "",
          r.actor_name ?? "",
          r.actor_role ?? "",
          r.notes ?? "",
        ]
          .map(csvEscape)
          .join(","),
      );
    });
    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-trail-${caseId ?? "global"}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Build the Action filter list from the actions actually present in the
  // data, ordered by frequency. Keeps the dropdown short on per-case views.
  const actionFilterOptions = useMemo(() => {
    const counts = new Map<string, number>();
    rows.forEach((r) => counts.set(r.action, (counts.get(r.action) ?? 0) + 1));
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
  }, [rows]);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search field, value, actor, case…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-8"
          />
        </div>
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {actionFilterOptions.map((k) => (
              <SelectItem key={k} value={k}>
                {actionMeta(k).label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="h-9 w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="AI">AI</SelectItem>
            <SelectItem value="MANUAL">Manual</SelectItem>
            <SelectItem value="TRANSCRIPT">Call transcript</SelectItem>
            <SelectItem value="SYSTEM">System</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="gap-1.5 h-9"
        >
          <Download className="h-3.5 w-3.5" /> Export CSV
        </Button>
      </div>

      <div className="text-[11px] text-muted-foreground">
        {loading
          ? "Loading…"
          : error
            ? error
            : `${filtered.length} of ${total} entries${
                caseId ? "" : " across all cases"
              }`}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="rounded-md border border-dashed border-border bg-muted/30 p-8 text-center">
          <History className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-semibold text-foreground">
            No audit entries
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {rows.length === 0
              ? "Nothing has been logged yet."
              : "No rows match your filters — adjust above."}
          </p>
        </div>
      )}

      {/* Timeline grouped by day */}
      <div className="space-y-6">
        {grouped.map(([day, items]) => (
          <div key={day}>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">
                {day}
              </h3>
              <div className="flex-1 h-px bg-border" />
              <span className="text-[10px] text-muted-foreground">
                {items.length} entr{items.length === 1 ? "y" : "ies"}
              </span>
            </div>
            <ol className="relative space-y-2 border-l-2 border-border ml-2 pl-4">
              {items.map((r) => {
                const meta = actionMeta(r.action);
                const Icon = meta.icon;
                const time = new Date(r.created_at).toLocaleTimeString("en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                });
                return (
                  <li key={r.id} className="relative">
                    <span
                      className={`absolute -left-[22px] top-2 flex h-4 w-4 items-center justify-center rounded-full border-2 border-background ${
                        meta.cls
                          .split(" ")
                          .find((x) => x.startsWith("bg-")) ?? "bg-muted"
                      }`}
                    >
                      <Icon className="h-2.5 w-2.5" />
                    </span>
                    <div className="rounded-md border border-border bg-card p-3 hover:border-teal/40 transition-colors">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap min-w-0">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${meta.cls}`}
                          >
                            <Icon className="h-2.5 w-2.5" />
                            {meta.label}
                          </span>
                          {(r.field_label || r.field_key) && (
                            <span className="text-xs font-semibold text-foreground truncate">
                              {r.field_label ?? r.field_key}
                            </span>
                          )}
                          {r.confidence && (
                            <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
                              {r.confidence}
                            </span>
                          )}
                          {showCaseLabel && r.case_ref && (
                            <Link
                              to={`/cases/${r.case_id}`}
                              className="text-[10px] text-info hover:underline font-mono"
                            >
                              {r.case_ref}
                              {r.client_name ? ` · ${r.client_name}` : ""}
                            </Link>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {time}
                        </span>
                      </div>

                      {(r.old_value || r.new_value) && (
                        <div className="mt-2 flex items-center gap-2 text-xs flex-wrap">
                          <span className="text-muted-foreground line-through truncate max-w-[280px]">
                            {r.old_value || (
                              <em className="not-italic">empty</em>
                            )}
                          </span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-foreground font-medium truncate max-w-[280px]">
                            {r.new_value || (
                              <em className="not-italic text-muted-foreground">
                                empty
                              </em>
                            )}
                          </span>
                        </div>
                      )}

                      {r.notes && (
                        <p className="mt-2 text-[11px] text-foreground bg-muted/50 px-2 py-1 rounded">
                          <MessageSquare className="inline h-2.5 w-2.5 mr-1 text-muted-foreground" />
                          {r.notes}
                        </p>
                      )}

                      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <User className="h-2.5 w-2.5" />
                        <span>
                          {r.actor_name ?? "System"}
                          {r.actor_role && (
                            <span className="ml-1 text-muted-foreground/70">
                              · {r.actor_role.replace("_", " ")}
                            </span>
                          )}
                        </span>
                        <span className="ml-auto text-muted-foreground/70">
                          via {SOURCE_META[r.source] ?? r.source}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}
