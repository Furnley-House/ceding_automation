import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Loader2,
  Search,
  Plus,
  Pencil,
  Power,
  PowerOff,
  CheckCircle2,
  XCircle,
  X,
  Mail,
  Phone,
} from "lucide-react";
import { providersApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

type LOAFormat = "ELECTRONIC" | "WET_SIGNATURE" | "EITHER";

interface Provider {
  id: string;
  name: string;
  phoneMain: string | null;
  phoneCedingDept: string | null;
  emailMain: string | null;
  emailCedingDept: string | null;
  postalAddress: string | null;
  loaFormat: LOAFormat;
  isOnOrigo: boolean;
  acceptedSigType: string | null;
  planTypePrefixes: string[];
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const LOA_LABELS: Record<LOAFormat, string> = {
  ELECTRONIC: "Electronic only",
  WET_SIGNATURE: "Wet signature required",
  EITHER: "Either (wet or electronic)",
};

const EMPTY_FORM: ProviderFormState = {
  name: "",
  phoneMain: "",
  phoneCedingDept: "",
  emailMain: "",
  emailCedingDept: "",
  postalAddress: "",
  loaFormat: "EITHER",
  isOnOrigo: false,
  acceptedSigType: "",
  planTypePrefixes: [],
  notes: "",
};

interface ProviderFormState {
  name: string;
  phoneMain: string;
  phoneCedingDept: string;
  emailMain: string;
  emailCedingDept: string;
  postalAddress: string;
  loaFormat: LOAFormat;
  isOnOrigo: boolean;
  acceptedSigType: string;
  planTypePrefixes: string[];
  notes: string;
}

export function ProviderManagementPanel() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: providers = [], isLoading } = useQuery({
    queryKey: ["providers", "admin", "all"],
    queryFn: async () => {
      const res = await providersApi.list(true);
      return (res.data as Provider[]) ?? [];
    },
  });

  const deactivate = useMutation({
    mutationFn: async (id: string) => providersApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers"] });
      toast.success("Provider deactivated");
    },
    onError: (e: Error) =>
      toast.error("Deactivate failed", { description: e.message }),
  });

  const reactivate = useMutation({
    mutationFn: async (provider: Provider) =>
      providersApi.update(provider.id, { isActive: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers"] });
      toast.success("Provider reactivated");
    },
    onError: (e: Error) =>
      toast.error("Reactivate failed", { description: e.message }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providers
      .filter((p) => {
        if (!showInactive && !p.isActive) return false;
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q) ||
          (p.emailMain ?? "").toLowerCase().includes(q) ||
          (p.phoneMain ?? "").toLowerCase().includes(q) ||
          p.planTypePrefixes.some((x) => x.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [providers, search, showInactive]);

  const stats = useMemo(() => {
    const active = providers.filter((p) => p.isActive).length;
    const origo = providers.filter((p) => p.isActive && p.isOnOrigo).length;
    return {
      total: providers.length,
      active,
      inactive: providers.length - active,
      origo,
    };
  }, [providers]);

  return (
    <div className="theme-card theme-card-accent border border-border bg-card">
      <div className="flex items-start justify-between gap-4 mb-4 pb-4 border-b border-border flex-wrap">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-teal/15 text-teal shrink-0">
            <Building2 className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold theme-heading text-foreground">
              Provider Directory
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-md">
              Add ceding providers, set their LOA format, Origo support, and
              policy-prefix routing rules. Cases match providers by name on
              import.
            </p>
          </div>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-2 shrink-0">
          <Plus className="h-4 w-4" /> Add provider
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <Stat label="Total" value={stats.total} tone="muted" />
        <Stat label="Active" value={stats.active} tone="success" />
        <Stat label="On Origo" value={stats.origo} tone="info" />
        <Stat label="Inactive" value={stats.inactive} tone="muted" />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, phone, prefix…"
            className="h-9 pl-8"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground rounded-md border border-border px-3 h-9 bg-card">
          <Switch checked={showInactive} onCheckedChange={setShowInactive} />
          <span>Show inactive</span>
        </label>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 p-8 text-center">
          <Building2 className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-semibold text-foreground">No providers</p>
          <p className="text-xs text-muted-foreground mt-1">
            Click <strong>Add provider</strong> to create one.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-bold">Provider</th>
                <th className="text-left px-3 py-2 font-bold">Contact</th>
                <th className="text-left px-3 py-2 font-bold">LOA</th>
                <th className="text-left px-3 py-2 font-bold">Origo</th>
                <th className="text-left px-3 py-2 font-bold">Prefixes</th>
                <th className="text-right px-3 py-2 font-bold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((p) => (
                <tr
                  key={p.id}
                  className={`hover:bg-muted/20 transition-colors ${
                    !p.isActive ? "opacity-60" : ""
                  }`}
                >
                  <td className="px-3 py-2.5 align-top">
                    <div className="font-semibold text-foreground flex items-center gap-2 flex-wrap">
                      {p.name}
                      {!p.isActive && (
                        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                          Inactive
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-top text-xs">
                    {p.emailMain && (
                      <div className="text-foreground flex items-center gap-1">
                        <Mail className="h-3 w-3 text-muted-foreground" />
                        {p.emailMain}
                      </div>
                    )}
                    {p.phoneMain && (
                      <div className="text-muted-foreground flex items-center gap-1">
                        <Phone className="h-3 w-3" />
                        {p.phoneMain}
                      </div>
                    )}
                    {!p.emailMain && !p.phoneMain && (
                      <span className="italic text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 align-top text-xs text-foreground">
                    {LOA_LABELS[p.loaFormat]}
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    {p.isOnOrigo ? (
                      <span className="inline-flex items-center gap-1 text-xs text-success font-semibold">
                        <CheckCircle2 className="h-3 w-3" /> Yes
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <XCircle className="h-3 w-3" /> No
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    <div className="flex flex-wrap gap-1 max-w-[180px]">
                      {p.planTypePrefixes.length === 0 ? (
                        <span className="text-xs italic text-muted-foreground">—</span>
                      ) : (
                        p.planTypePrefixes.map((prefix) => (
                          <span
                            key={prefix}
                            className="inline-flex items-center text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-foreground"
                          >
                            {prefix}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 align-top text-right">
                    <div className="inline-flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 gap-1 text-xs"
                        onClick={() => setEditing(p)}
                      >
                        <Pencil className="h-3 w-3" /> Edit
                      </Button>
                      {p.isActive ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 gap-1 text-xs text-overdue hover:text-overdue"
                          onClick={() => {
                            if (
                              confirm(
                                `Deactivate "${p.name}"? Existing cases keep this link, but the provider is hidden from new selections.`,
                              )
                            ) {
                              deactivate.mutate(p.id);
                            }
                          }}
                          disabled={deactivate.isPending}
                        >
                          <PowerOff className="h-3 w-3" /> Deactivate
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 gap-1 text-xs text-success hover:text-success"
                          onClick={() => reactivate.mutate(p)}
                          disabled={reactivate.isPending}
                        >
                          <Power className="h-3 w-3" /> Reactivate
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <ProviderEditorDialog
          open={creating}
          onOpenChange={setCreating}
          mode="create"
        />
      )}
      {editing && (
        <ProviderEditorDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          mode="edit"
          provider={editing}
        />
      )}
    </div>
  );
}

function ProviderEditorDialog({
  open,
  onOpenChange,
  mode,
  provider,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  provider?: Provider;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ProviderFormState>(() =>
    provider ? toFormState(provider) : EMPTY_FORM,
  );
  const [prefixDraft, setPrefixDraft] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        phoneMain: form.phoneMain.trim() || null,
        phoneCedingDept: form.phoneCedingDept.trim() || null,
        emailMain: form.emailMain.trim() || null,
        emailCedingDept: form.emailCedingDept.trim() || null,
        postalAddress: form.postalAddress.trim() || null,
        loaFormat: form.loaFormat,
        isOnOrigo: form.isOnOrigo,
        acceptedSigType: form.acceptedSigType.trim() || null,
        planTypePrefixes: form.planTypePrefixes,
        notes: form.notes.trim() || null,
      };
      if (mode === "create") {
        const res = await providersApi.create(payload);
        return res.data as Provider;
      }
      const res = await providersApi.update(provider!.id, payload);
      return res.data as Provider;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["providers"] });
      toast.success(mode === "create" ? "Provider created" : "Provider updated");
      onOpenChange(false);
    },
    onError: (e: unknown) => {
      const err = e as { response?: { data?: { error?: unknown } }; message?: string };
      const errorVal = err?.response?.data?.error;
      const description =
        typeof errorVal === "string"
          ? errorVal
          : (err?.message ?? "Unknown error");
      toast.error(mode === "create" ? "Create failed" : "Update failed", {
        description,
      });
    },
  });

  const addPrefix = () => {
    const v = prefixDraft.trim().toUpperCase();
    if (!v) return;
    if (form.planTypePrefixes.includes(v)) {
      setPrefixDraft("");
      return;
    }
    setForm((f) => ({ ...f, planTypePrefixes: [...f.planTypePrefixes, v] }));
    setPrefixDraft("");
  };

  const removePrefix = (prefix: string) => {
    setForm((f) => ({
      ...f,
      planTypePrefixes: f.planTypePrefixes.filter((p) => p !== prefix),
    }));
  };

  const valid = form.name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Add provider" : `Edit ${provider?.name ?? "provider"}`}
          </DialogTitle>
          <DialogDescription>
            All fields except <strong>Name</strong> are optional. The directory
            page surfaces email/phone to the CA team during LOA prep.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          <div className="sm:col-span-2">
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Provider name *
            </Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Aviva"
              className="mt-1"
              autoFocus
            />
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Main email
            </Label>
            <Input
              type="email"
              value={form.emailMain}
              onChange={(e) => setForm({ ...form, emailMain: e.target.value })}
              placeholder="ceding@aviva.co.uk"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Ceding-dept email
            </Label>
            <Input
              type="email"
              value={form.emailCedingDept}
              onChange={(e) => setForm({ ...form, emailCedingDept: e.target.value })}
              placeholder="(optional)"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Main phone
            </Label>
            <Input
              value={form.phoneMain}
              onChange={(e) => setForm({ ...form, phoneMain: e.target.value })}
              placeholder="+44 1603 622200"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Ceding-dept phone
            </Label>
            <Input
              value={form.phoneCedingDept}
              onChange={(e) => setForm({ ...form, phoneCedingDept: e.target.value })}
              placeholder="(optional)"
              className="mt-1"
            />
          </div>

          <div className="sm:col-span-2">
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Postal address
            </Label>
            <Textarea
              value={form.postalAddress}
              onChange={(e) => setForm({ ...form, postalAddress: e.target.value })}
              rows={2}
              placeholder="(optional)"
              className="mt-1"
            />
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wider font-semibold">
              LOA format
            </Label>
            <Select
              value={form.loaFormat}
              onValueChange={(v) => setForm({ ...form, loaFormat: v as LOAFormat })}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="EITHER">Either (wet or electronic)</SelectItem>
                <SelectItem value="ELECTRONIC">Electronic only</SelectItem>
                <SelectItem value="WET_SIGNATURE">Wet signature required</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Accepted signature type
            </Label>
            <Input
              value={form.acceptedSigType}
              onChange={(e) => setForm({ ...form, acceptedSigType: e.target.value })}
              placeholder="e.g. Electronic / Wet / Either"
              className="mt-1"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="inline-flex items-center gap-2">
              <Switch
                checked={form.isOnOrigo}
                onCheckedChange={(v) => setForm({ ...form, isOnOrigo: v })}
              />
              <span className="text-sm text-foreground font-medium">
                On Origo (electronic LOA available)
              </span>
            </label>
          </div>

          <div className="sm:col-span-2">
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Policy-number prefixes
            </Label>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Used to auto-route policies to the right provider on import.
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {form.planTypePrefixes.map((prefix) => (
                <span
                  key={prefix}
                  className="inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded-md bg-muted text-foreground border border-border"
                >
                  {prefix}
                  <button
                    type="button"
                    onClick={() => removePrefix(prefix)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2 mt-2">
              <Input
                value={prefixDraft}
                onChange={(e) => setPrefixDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPrefix();
                  }
                }}
                placeholder="e.g. PP, ISA, DC"
                className="h-8 text-sm font-mono uppercase"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addPrefix}
                disabled={!prefixDraft.trim()}
              >
                Add
              </Button>
            </div>
          </div>

          <div className="sm:col-span-2">
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Notes
            </Label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={3}
              placeholder="Any internal notes about this provider — call hours, jargon mappings, known quirks…"
              className="mt-1"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!valid || save.isPending}
            className="gap-2"
          >
            {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === "create" ? "Create" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toFormState(p: Provider): ProviderFormState {
  return {
    name: p.name,
    phoneMain: p.phoneMain ?? "",
    phoneCedingDept: p.phoneCedingDept ?? "",
    emailMain: p.emailMain ?? "",
    emailCedingDept: p.emailCedingDept ?? "",
    postalAddress: p.postalAddress ?? "",
    loaFormat: p.loaFormat,
    isOnOrigo: p.isOnOrigo,
    acceptedSigType: p.acceptedSigType ?? "",
    planTypePrefixes: p.planTypePrefixes,
    notes: p.notes ?? "",
  };
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "muted" | "success" | "info" | "overdue";
}) {
  const cls = {
    muted: "bg-muted/40 border-border text-muted-foreground",
    success: "bg-success/10 border-success/30 text-success",
    info: "bg-info/10 border-info/30 text-info",
    overdue: "bg-overdue/10 border-overdue/30 text-overdue",
  }[tone];
  return (
    <div className={`rounded-md border p-2.5 ${cls}`}>
      <span className="text-[10px] uppercase tracking-wider font-bold opacity-80">
        {label}
      </span>
      <p className="text-xl font-bold text-foreground mt-0.5">{value}</p>
    </div>
  );
}
