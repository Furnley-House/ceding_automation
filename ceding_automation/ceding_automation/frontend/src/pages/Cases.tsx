import { useState, useMemo, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Plus,
  Filter,
  Sparkles,
  Briefcase,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { getCases, createCase, importCrmTaskAsCase } from "@/services/api";
import {
  CASE_STATUSES,
  PLAN_TYPES,
  RAG_STYLES,
  STATUS_LABELS,
  STATUS_STYLES,
  calculateRag,
  generateCaseRef,
} from "@/lib/caseHelpers";
import { useRole } from "@/hooks/useRole";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// (Demo seed data was removed — Import CRM task now hits the real Zoho API via the backend.)

const Cases = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const { userName, role } = useRole();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get("status") ?? "all");
  const [planFilter, setPlanFilter] = useState<string>("all");
  const [ragFilter, setRagFilter] = useState<string>("all");
  const [dialogOpen, setDialogOpen] = useState(false);

  // Sync filter state from URL (so dashboard KPI clicks land here pre-filtered)
  useEffect(() => {
    const s = searchParams.get("status");
    if (s && s !== statusFilter) setStatusFilter(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── Auto-import a CRM task when arriving from a Zoho deep link ──
  // Accepts both param names so either Zoho button format works:
  //   /cases?zohoTaskId=<id>   (canonical)
  //   /cases?taskid=<id>       (Zoho button default)
  const [importingTaskId, setImportingTaskId] = useState<string | null>(null);
  useEffect(() => {
    const taskId =
      searchParams.get("zohoTaskId") ??
      searchParams.get("taskId") ??
      searchParams.get("taskid");
    if (!taskId || importingTaskId === taskId) return;
    setImportingTaskId(taskId);

    (async () => {
      const t = toast.loading(`Looking up CRM task…`);
      try {
        const result = await importCrmTaskAsCase(taskId);
        const importedCase = result.case as {
          id?: string;
          case_ref?: string;
          caseRef?: string;
          client_name?: string;
          clientName?: string;
        } | undefined;

        const caseId = importedCase?.id;
        const ref = importedCase?.case_ref ?? importedCase?.caseRef ?? taskId;
        const client = importedCase?.client_name ?? importedCase?.clientName ?? "Unknown";

        toast.success(
          result.alreadyExisted ? `Existing case — ${client}` : `Case created — ${client}`,
          { id: t, description: ref },
        );

        // Clean all task-id params from the URL before navigating so a back/refresh
        // doesn't trigger another import attempt.
        const next = new URLSearchParams(searchParams);
        next.delete("zohoTaskId");
        next.delete("taskId");
        next.delete("taskid");
        setSearchParams(next, { replace: true });

        if (caseId) {
          qc.invalidateQueries({ queryKey: ["case", caseId] });
          navigate(`/cases/${caseId}`, { replace: true });
        } else {
          qc.invalidateQueries({ queryKey: ["cases"] });
        }
      } catch (e) {
        toast.error("Import failed", {
          id: t,
          description: e instanceof Error ? e.message : "Unknown error",
        });
        setImportingTaskId(null); // allow retry on next visit
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [form, setForm] = useState({
    client_name: "",
    Provider_group: "",
    plan_type: "Personal Pension",
    plan_number: "",
    zoho_task_id: "",
    case_notes: "",
  });

  const { data: cases = [], isLoading } = useQuery({ queryKey: ["cases"], queryFn: getCases });

  const createMutation = useMutation({
    mutationFn: createCase,
    onSuccess: (newCase) => {
      qc.invalidateQueries({ queryKey: ["cases"] });
      setDialogOpen(false);
      setForm({ client_name: "", Provider_group: "", plan_type: "Personal Pension", plan_number: "", zoho_task_id: "", case_notes: "" });
      toast.success("Case created", { description: `${newCase.case_ref} — ${newCase.client_name}` });
      navigate(`/cases/${newCase.id}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.client_name || !form.Provider_group || !form.plan_number) {
      toast.error("Client, provider, and policy reference are required.");
      return;
    }
    createMutation.mutate({
      case_ref: generateCaseRef(form.plan_type),
      client_name: form.client_name,
      Provider_group: form.Provider_group,
      plan_number: form.plan_number,
      plan_type: form.plan_type,
      status: "pending_loa",
      owner_name: userName ?? null,
      zoho_task_id: form.zoho_task_id || null,
      case_notes: form.case_notes || null,
      current_stage: 1,
    } as any);
  };

  // Prompt for a Zoho task ID, then call the backend import endpoint.
  // For end-to-end testing: enter the Zoho task record ID (the long numeric string
  // shown in the URL when viewing a task in Zoho CRM, e.g. 4716998000001234567).
  const importFromCrm = async () => {
    const taskId = window.prompt("Enter the Zoho CRM task ID to import:");
    if (!taskId?.trim()) return;
    const id = taskId.trim();
    const t = toast.loading(`Looking up CRM task…`);
    try {
      const result = await importCrmTaskAsCase(id);
      const importedCase = result.case as {
        id?: string;
        case_ref?: string;
        caseRef?: string;
        client_name?: string;
        clientName?: string;
      } | undefined;
      const ref = importedCase?.case_ref ?? importedCase?.caseRef ?? id;
      const client = importedCase?.client_name ?? importedCase?.clientName ?? "Unknown";
      toast.success(
        result.alreadyExisted ? `Existing case — ${client}` : `Case created — ${client}`,
        { id: t, description: ref },
      );
      qc.invalidateQueries({ queryKey: ["cases"] });
      if (importedCase?.id) {
        qc.invalidateQueries({ queryKey: ["case", importedCase.id] });
        navigate(`/cases/${importedCase.id}`, { replace: false });
      }
    } catch (e) {
      toast.error("Import failed", {
        id: t,
        description: e instanceof Error ? e.message : "Unknown error",
      });
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cases.filter((c) => {
      // CA team only sees tasks assigned to them in CRM.
      if (role === "ca_team" && (c.owner_name ?? "").trim() !== (userName ?? "").trim())
        return false;
      if (statusFilter === "active") {
        if (["complete", "approved"].includes(c.status)) return false;
      } else if (statusFilter !== "all" && c.status !== statusFilter) {
        return false;
      }
      if (planFilter !== "all" && c.plan_type !== planFilter) return false;
      if (ragFilter !== "all" && calculateRag(c) !== ragFilter) return false;
      if (q && !`${c.client_name} ${c.Provider_group} ${c.plan_number} ${c.case_ref}`.toLowerCase().includes(q))
        return false;
      return true;
    });
  }, [cases, search, statusFilter, planFilter, ragFilter, role, userName]);

  return (
    <div className="animate-slide-in">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold theme-heading text-foreground flex items-center gap-2">
            <Briefcase className="h-6 w-6 text-teal" /> Cases
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            All ceding cases assigned to you. {filtered.length} of {cases.length} shown.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={importFromCrm} disabled={createMutation.isPending} className="gap-2">
            <Sparkles className="h-4 w-4 text-teal" /> Import CRM task
          </Button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="h-4 w-4" /> New Case
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Create new ceding case</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4 pt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="client_name">Client Name *</Label>
                    <Input id="client_name" value={form.client_name} onChange={(e) => setForm((f) => ({ ...f, client_name: e.target.value }))} placeholder="e.g. James Richardson" required />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="Provider_group">Provider *</Label>
                    <Input id="Provider_group" value={form.Provider_group} onChange={(e) => setForm((f) => ({ ...f, Provider_group: e.target.value }))} placeholder="e.g. Aviva" required />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="plan_type">Plan Type *</Label>
                    <Select value={form.plan_type} onValueChange={(v) => setForm((f) => ({ ...f, plan_type: v }))}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLAN_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="plan_number">Policy Reference *</Label>
                    <Input id="plan_number" value={form.plan_number} onChange={(e) => setForm((f) => ({ ...f, plan_number: e.target.value }))} placeholder="e.g. AV-SIPP-2847" required />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="zoho_task_id">CRM Task ID (optional)</Label>
                  <Input id="zoho_task_id" value={form.zoho_task_id} onChange={(e) => setForm((f) => ({ ...f, zoho_task_id: e.target.value }))} placeholder="e.g. ZT-12345" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="case_notes">Case notes (optional)</Label>
                  <Textarea id="case_notes" value={form.case_notes} onChange={(e) => setForm((f) => ({ ...f, case_notes: e.target.value }))} rows={3} placeholder="Any context for the CA team…" />
                </div>
                <Button type="submit" disabled={createMutation.isPending} className="w-full">
                  {createMutation.isPending ? "Creating…" : "Create case"}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="mb-4 grid gap-3 md:grid-cols-[1fr,auto,auto,auto]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by client, provider, policy ref…" className="pl-9" />
        </div>
        <FilterSelect
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            const next = new URLSearchParams(searchParams);
            if (v === "all") next.delete("status");
            else next.set("status", v);
            setSearchParams(next, { replace: true });
          }}
          placeholder="Status"
        >
          <SelectItem value="all">All statuses</SelectItem>
          <SelectItem value="active">Active (in progress)</SelectItem>
          {CASE_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect value={planFilter} onChange={setPlanFilter} placeholder="Plan type">
          <SelectItem value="all">All plan types</SelectItem>
          {PLAN_TYPES.map((p) => (
            <SelectItem key={p} value={p}>
              {p}
            </SelectItem>
          ))}
        </FilterSelect>
        <FilterSelect value={ragFilter} onChange={setRagFilter} placeholder="RAG">
          <SelectItem value="all">All RAG</SelectItem>
          <SelectItem value="green">🟢 Green</SelectItem>
          <SelectItem value="amber">🟡 Amber</SelectItem>
          <SelectItem value="red">🔴 Red</SelectItem>
        </FilterSelect>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-3 text-left font-semibold w-8" />
              <th className="px-4 py-3 text-left font-semibold">Client</th>
              <th className="px-4 py-3 text-left font-semibold">Provider</th>
              <th className="px-4 py-3 text-left font-semibold">Plan Type</th>
              <th className="px-4 py-3 text-left font-semibold">Policy Ref</th>
              <th className="px-4 py-3 text-left font-semibold">Status</th>
              <th className="px-4 py-3 text-left font-semibold">Stage</th>
              <th className="px-4 py-3 text-left font-semibold">Last updated</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-muted-foreground">
                  {cases.length === 0 ? (
                    <>
                      No ceding cases yet. Click <strong>+ New Case</strong> to get started.
                    </>
                  ) : (
                    <>No cases match your filters.</>
                  )}
                </td>
              </tr>
            ) : (
              filtered.map((c) => {
                const rag = calculateRag(c);
                const ragStyle = RAG_STYLES[rag];
                const statusStyle = STATUS_STYLES[c.status] ?? "bg-muted text-muted-foreground";
                const lastUpdated = new Date(c.updated_at);
                return (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/cases/${c.id}`)}
                    className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <span className={`inline-block h-2.5 w-2.5 rounded-full ${ragStyle.dot}`} title={`RAG: ${ragStyle.label}`} />
                    </td>
                    <td className="px-4 py-3 font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        {c.is_overdue && <AlertTriangle className="h-3.5 w-3.5 text-overdue" />}
                        {c.client_name}
                      </div>
                      <p className="text-[11px] text-muted-foreground font-normal mt-0.5">{c.case_ref}</p>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.Provider_group}</td>
                    <td className="px-4 py-3 text-muted-foreground">{c.plan_type}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{c.plan_number}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold ${statusStyle}`}>
                        {STATUS_LABELS[c.status] ?? c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      Step {(c as any).current_stage ?? 1} / 10
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {lastUpdated.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

function FilterSelect({
  value,
  onChange,
  placeholder,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  children: React.ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[170px]">
        <Filter className="h-3.5 w-3.5 text-muted-foreground mr-1" />
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

export default Cases;
