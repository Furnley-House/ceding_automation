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

interface CaseRow {
  id: string;
  case_ref: string;
  client_name: string;
  provider_name: string;
}

interface Props {
  /** Scope to a single case. Omit for global view. */
  caseId?: string;
  /** Show case ref column (global view). */
  showCase?: boolean;
}

const ACTION_META: Record<
  string,
  { label: string; icon: React.ElementType; cls: string }
> = {
  ai_extract: {
    label: "AI extract",
    icon: Sparkles,
    cls: "bg-teal/15 text-teal border-teal/30",
  },
  call_extract: {
    label: "Call extract",
    icon: Phone,
    cls: "bg-info/15 text-info border-info/30",
  },
  manual_edit: {
    label: "Manual edit",
    icon: Pencil,
    cls: "bg-warning/15 text-warning border-warning/30",
  },
  approve: {
    label: "Approved",
    icon: ThumbsUp,
    cls: "bg-success/15 text-success border-success/30",
  },
  request_review: {
    label: "Review requested",
    icon: RotateCcw,
    cls: "bg-overdue/15 text-overdue border-overdue/30",
  },
  comment: {
    label: "Comment",
    icon: MessageSquare,
    cls: "bg-muted text-muted-foreground border-border",
  },
};

const SOURCE_META: Record<string, string> = {
  ai: "AI",
  manual: "Manual",
  call: "Call",
};

function actionMeta(action: string) {
  return (
    ACTION_META[action] ?? {
      label: action,
      icon: History,
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

export function AuditTimeline({ caseId, showCase = false }: Props) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cases, setCases] = useState<Record<string, CaseRow>>({});
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      if (!caseId) {
        // Global audit view has no backend endpoint — show empty state
        if (!cancelled) { setRows([]); setLoading(false); }
        return;
      }
      try {
        const res = await auditApi.getForCase(caseId);
        if (!cancelled) setRows((res.data as AuditRow[]) ?? []);
      } catch (err) {
        console.error("audit load", err);
        if (!cancelled) setRows([]);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [caseId, showCase]);

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
          showCase ? cases[r.case_id]?.case_ref : "",
          showCase ? cases[r.case_id]?.client_name : "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [rows, actionFilter, sourceFilter, search, showCase, cases]);

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
      const c = cases[r.case_id];
      lines.push(
        [
          new Date(r.created_at).toISOString(),
          c?.case_ref ?? "",
          c?.client_name ?? "",
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
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-trail-${caseId ?? "global"}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 p-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search field, value, actor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-8"
          />
        </div>
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {Object.entries(ACTION_META).map(([k, v]) => (
              <SelectItem key={k} value={k}>
                {v.label}
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
            <SelectItem value="ai">AI</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="call">Call</SelectItem>
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
          : `${filtered.length} of ${rows.length} entries${caseId ? "" : " across all cases"}`}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="rounded-md border border-dashed border-border bg-muted/30 p-8 text-center">
          <History className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-semibold text-foreground">No audit entries match</p>
          <p className="text-xs text-muted-foreground mt-1">
            Adjust the filters or search above.
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
                const c = showCase ? cases[r.case_id] : undefined;
                return (
                  <li key={r.id} className="relative">
                    <span
                      className={`absolute -left-[22px] top-2 flex h-4 w-4 items-center justify-center rounded-full border-2 border-background ${meta.cls.split(" ").find((x) => x.startsWith("bg-")) ?? "bg-muted"}`}
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
                          <span className="text-xs font-semibold text-foreground truncate">
                            {r.field_label ?? r.field_key ?? "—"}
                          </span>
                          {r.confidence && (
                            <span className="text-[10px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
                              {r.confidence}
                            </span>
                          )}
                          {showCase && c && (
                            <Link
                              to={`/cases/${c.id}`}
                              className="text-[10px] text-info hover:underline font-mono"
                            >
                              {c.case_ref} · {c.client_name}
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
                            {r.old_value || <em className="not-italic">empty</em>}
                          </span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-foreground font-medium truncate max-w-[280px]">
                            {r.new_value || <em className="not-italic text-muted-foreground">empty</em>}
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
