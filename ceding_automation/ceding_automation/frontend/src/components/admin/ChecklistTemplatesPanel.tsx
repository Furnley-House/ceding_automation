import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ListChecks,
  Loader2,
  Plus,
  Pencil,
  Power,
  PowerOff,
  ArrowUp,
  ArrowDown,
  X,
  GripVertical,
} from "lucide-react";
import { checklistTemplatesApi } from "@/lib/api";
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

const PLAN_TYPES = [
  "PENSION",
  "ISA",
  "GIA",
  "BOND",
  "FINAL_SALARY",
  "PROTECTION",
] as const;
type PlanType = (typeof PLAN_TYPES)[number];

const PLAN_LABELS: Record<PlanType, string> = {
  PENSION: "Pension",
  ISA: "ISA",
  GIA: "GIA",
  BOND: "Bond",
  FINAL_SALARY: "Final Salary",
  PROTECTION: "Protection",
};

const FIELD_TYPES = [
  "text",
  "number",
  "currency",
  "date",
  "dropdown",
  "yes_no",
  "percentage",
  "url",
  "free_text",
] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  currency: "Currency",
  date: "Date",
  dropdown: "Dropdown",
  yes_no: "Yes / No",
  percentage: "Percentage",
  url: "URL",
  free_text: "Free text",
};

interface Template {
  id: string;
  planType: PlanType;
  sectionName: string;
  fieldName: string;
  fieldKey: string;
  fieldType: FieldType;
  dropdownOptions: string[];
  isRequired: boolean;
  displayOrder: number;
  isActive: boolean;
  conditionalNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export function ChecklistTemplatesPanel() {
  const qc = useQueryClient();
  const [planType, setPlanType] = useState<PlanType>("PENSION");
  const [showInactive, setShowInactive] = useState(true);
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["checklist-templates", planType, "all"],
    queryFn: async () => {
      const res = await checklistTemplatesApi.list({
        planType,
        includeInactive: true,
      });
      return (res.data as Template[]) ?? [];
    },
  });

  const filtered = useMemo(
    () =>
      templates
        .filter((t) => showInactive || t.isActive)
        .sort((a, b) => a.displayOrder - b.displayOrder),
    [templates, showInactive],
  );

  const grouped = useMemo(() => {
    const m = new Map<string, Template[]>();
    filtered.forEach((t) => {
      if (!m.has(t.sectionName)) m.set(t.sectionName, []);
      m.get(t.sectionName)!.push(t);
    });
    return Array.from(m.entries());
  }, [filtered]);

  const reorder = useMutation({
    mutationFn: async (items: { id: string; displayOrder: number }[]) =>
      checklistTemplatesApi.reorder(items),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["checklist-templates"] }),
    onError: (e: Error) =>
      toast.error("Reorder failed", { description: e.message }),
  });

  const toggleActive = useMutation({
    mutationFn: async (t: Template) => {
      if (t.isActive) return checklistTemplatesApi.delete(t.id);
      return checklistTemplatesApi.update(t.id, { isActive: true });
    },
    onSuccess: (_, t) => {
      qc.invalidateQueries({ queryKey: ["checklist-templates"] });
      toast.success(t.isActive ? "Field deactivated" : "Field reactivated");
    },
    onError: (e: Error) =>
      toast.error("Update failed", { description: e.message }),
  });

  // Move a template up/down within the active list. We rebuild displayOrder
  // for ALL siblings so gaps don't accumulate over time.
  const moveTemplate = (template: Template, direction: -1 | 1) => {
    const ordered = [...filtered];
    const idx = ordered.findIndex((t) => t.id === template.id);
    if (idx < 0) return;
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= ordered.length) return;

    [ordered[idx], ordered[swapIdx]] = [ordered[swapIdx], ordered[idx]];
    const items = ordered.map((t, i) => ({ id: t.id, displayOrder: i + 1 }));
    reorder.mutate(items);
  };

  const stats = useMemo(() => {
    const active = templates.filter((t) => t.isActive).length;
    const sections = new Set(templates.filter((t) => t.isActive).map((t) => t.sectionName));
    return {
      total: templates.length,
      active,
      inactive: templates.length - active,
      sections: sections.size,
    };
  }, [templates]);

  return (
    <div className="theme-card theme-card-accent border border-border bg-card">
      <div className="flex items-start justify-between gap-4 mb-4 pb-4 border-b border-border flex-wrap">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-teal/15 text-teal shrink-0">
            <ListChecks className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold theme-heading text-foreground">
              Checklist Templates
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-md">
              Define the fields each plan type's checklist will collect. Edits
              here affect <strong>future cases</strong> only — existing cases
              keep their snapshot.
            </p>
          </div>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-2 shrink-0">
          <Plus className="h-4 w-4" /> Add field
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <Stat label="Plan type" value={PLAN_LABELS[planType]} tone="info" />
        <Stat label="Active fields" value={stats.active} tone="success" />
        <Stat label="Sections" value={stats.sections} tone="muted" />
        <Stat label="Inactive" value={stats.inactive} tone="muted" />
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Label className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">
            Plan type
          </Label>
          <Select value={planType} onValueChange={(v) => setPlanType(v as PlanType)}>
            <SelectTrigger className="h-9 w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_TYPES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PLAN_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground rounded-md border border-border px-3 h-9 bg-card ml-auto">
          <Switch checked={showInactive} onCheckedChange={setShowInactive} />
          <span>Show inactive</span>
        </label>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : grouped.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-muted/20 p-8 text-center">
          <ListChecks className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-semibold text-foreground">
            No fields for {PLAN_LABELS[planType]} yet
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Click <strong>Add field</strong> to start defining the checklist for
            this plan type.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {grouped.map(([section, fields]) => (
            <div
              key={section}
              className="rounded-md border border-border bg-card overflow-hidden"
            >
              <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between">
                <h4 className="text-[11px] uppercase tracking-widest font-bold text-muted-foreground">
                  {section}
                </h4>
                <span className="text-[10px] text-muted-foreground">
                  {fields.length} field{fields.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="divide-y divide-border">
                {fields.map((t) => {
                  const globalIdx = filtered.findIndex((f) => f.id === t.id);
                  const canMoveUp = globalIdx > 0;
                  const canMoveDown = globalIdx < filtered.length - 1;
                  return (
                    <li
                      key={t.id}
                      className={`flex items-center gap-3 px-3 py-2 hover:bg-muted/20 transition-colors ${
                        !t.isActive ? "opacity-60" : ""
                      }`}
                    >
                      <GripVertical className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-foreground">
                            {t.fieldName}
                          </span>
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {t.fieldKey}
                          </span>
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-muted text-foreground border border-border">
                            {FIELD_TYPE_LABELS[t.fieldType]}
                          </span>
                          {t.isRequired && (
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-overdue/15 text-overdue border border-overdue/30">
                              Required
                            </span>
                          )}
                          {!t.isActive && (
                            <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                              Inactive
                            </span>
                          )}
                        </div>
                        {t.conditionalNote && (
                          <p className="text-[11px] text-muted-foreground italic mt-0.5">
                            {t.conditionalNote}
                          </p>
                        )}
                        {t.fieldType === "dropdown" && t.dropdownOptions.length > 0 && (
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            <span className="font-semibold">Options:</span>{" "}
                            {t.dropdownOptions.join(", ")}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => moveTemplate(t, -1)}
                          disabled={!canMoveUp || reorder.isPending || !t.isActive}
                          title="Move up"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => moveTemplate(t, 1)}
                          disabled={!canMoveDown || reorder.isPending || !t.isActive}
                          title="Move down"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 gap-1 text-xs"
                          onClick={() => setEditing(t)}
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </Button>
                        {t.isActive ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 gap-1 text-xs text-overdue hover:text-overdue"
                            onClick={() => {
                              if (confirm(`Deactivate field "${t.fieldName}"?`)) {
                                toggleActive.mutate(t);
                              }
                            }}
                            disabled={toggleActive.isPending}
                          >
                            <PowerOff className="h-3 w-3" />
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 gap-1 text-xs text-success hover:text-success"
                            onClick={() => toggleActive.mutate(t)}
                            disabled={toggleActive.isPending}
                          >
                            <Power className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <TemplateEditorDialog
          open={creating}
          onOpenChange={setCreating}
          mode="create"
          defaultPlanType={planType}
        />
      )}
      {editing && (
        <TemplateEditorDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          mode="edit"
          template={editing}
        />
      )}
    </div>
  );
}

interface TemplateFormState {
  planType: PlanType;
  sectionName: string;
  fieldName: string;
  fieldKey: string;
  fieldType: FieldType;
  isRequired: boolean;
  conditionalNote: string;
  dropdownOptions: string[];
}

function TemplateEditorDialog({
  open,
  onOpenChange,
  mode,
  template,
  defaultPlanType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  template?: Template;
  defaultPlanType?: PlanType;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<TemplateFormState>(() => {
    if (template) {
      return {
        planType: template.planType,
        sectionName: template.sectionName,
        fieldName: template.fieldName,
        fieldKey: template.fieldKey,
        fieldType: template.fieldType,
        isRequired: template.isRequired,
        conditionalNote: template.conditionalNote ?? "",
        dropdownOptions: template.dropdownOptions ?? [],
      };
    }
    return {
      planType: defaultPlanType ?? "PENSION",
      sectionName: "",
      fieldName: "",
      fieldKey: "",
      fieldType: "text",
      isRequired: true,
      conditionalNote: "",
      dropdownOptions: [],
    };
  });
  const [optionDraft, setOptionDraft] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        sectionName: form.sectionName.trim(),
        fieldName: form.fieldName.trim(),
        fieldKey: form.fieldKey.trim(),
        fieldType: form.fieldType,
        isRequired: form.isRequired,
        conditionalNote: form.conditionalNote.trim() || null,
        dropdownOptions:
          form.fieldType === "dropdown" ? form.dropdownOptions : [],
      };
      if (mode === "create") {
        payload.planType = form.planType;
        const res = await checklistTemplatesApi.create(payload);
        return res.data as Template;
      }
      const res = await checklistTemplatesApi.update(template!.id, payload);
      return res.data as Template;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["checklist-templates"] });
      toast.success(mode === "create" ? "Field added" : "Field updated");
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

  const addOption = () => {
    const v = optionDraft.trim();
    if (!v) return;
    if (form.dropdownOptions.includes(v)) {
      setOptionDraft("");
      return;
    }
    setForm((f) => ({ ...f, dropdownOptions: [...f.dropdownOptions, v] }));
    setOptionDraft("");
  };

  const removeOption = (opt: string) => {
    setForm((f) => ({
      ...f,
      dropdownOptions: f.dropdownOptions.filter((o) => o !== opt),
    }));
  };

  const valid =
    form.sectionName.trim().length > 0 &&
    form.fieldName.trim().length > 0 &&
    /^[a-z][a-z0-9_]*$/.test(form.fieldKey.trim()) &&
    (form.fieldType !== "dropdown" || form.dropdownOptions.length > 0);

  // Auto-derive snake_case key from label when creating
  const onFieldNameChange = (v: string) => {
    setForm((f) => {
      if (mode === "create" && (f.fieldKey === "" || f.fieldKey === toSnake(f.fieldName))) {
        return { ...f, fieldName: v, fieldKey: toSnake(v) };
      }
      return { ...f, fieldName: v };
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "create"
              ? "Add checklist field"
              : `Edit ${template?.fieldName ?? "field"}`}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Defines a new field for the selected plan type's checklist. Future cases will include this field."
              : "Existing per-case rows keep their stored values. Renaming or changing type is mostly cosmetic at the API layer."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
          {mode === "create" && (
            <div>
              <Label className="text-xs uppercase tracking-wider font-semibold">
                Plan type *
              </Label>
              <Select
                value={form.planType}
                onValueChange={(v) =>
                  setForm({ ...form, planType: v as PlanType })
                }
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_TYPES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PLAN_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className={mode === "create" ? "" : "sm:col-span-2"}>
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Section *
            </Label>
            <Input
              value={form.sectionName}
              onChange={(e) =>
                setForm({ ...form, sectionName: e.target.value })
              }
              placeholder="e.g. Plan Details"
              className="mt-1"
              autoFocus
            />
          </div>

          <div className="sm:col-span-2">
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Field name *
            </Label>
            <Input
              value={form.fieldName}
              onChange={(e) => onFieldNameChange(e.target.value)}
              placeholder="e.g. Annual Management Charge"
              className="mt-1"
            />
          </div>

          <div className="sm:col-span-2">
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Field key *
            </Label>
            <Input
              value={form.fieldKey}
              onChange={(e) =>
                setForm({ ...form, fieldKey: e.target.value.toLowerCase() })
              }
              placeholder="e.g. annual_management_charge"
              className="mt-1 font-mono text-sm"
              disabled={mode === "edit"}
            />
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {mode === "edit"
                ? "Field key is locked after creation to keep per-case rows in sync."
                : "snake_case · lowercase letters, digits, underscores · must be unique per plan type."}
            </p>
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Field type *
            </Label>
            <Select
              value={form.fieldType}
              onValueChange={(v) =>
                setForm({ ...form, fieldType: v as FieldType })
              }
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {FIELD_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Required
            </Label>
            <div className="mt-2 flex items-center gap-2">
              <Switch
                checked={form.isRequired}
                onCheckedChange={(v) => setForm({ ...form, isRequired: v })}
              />
              <span className="text-sm text-foreground">
                {form.isRequired ? "Required field" : "Optional"}
              </span>
            </div>
          </div>

          {form.fieldType === "dropdown" && (
            <div className="sm:col-span-2">
              <Label className="text-xs uppercase tracking-wider font-semibold">
                Dropdown options *
              </Label>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                CA team will pick exactly one of these.
              </p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {form.dropdownOptions.map((opt) => (
                  <span
                    key={opt}
                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-muted text-foreground border border-border"
                  >
                    {opt}
                    <button
                      type="button"
                      onClick={() => removeOption(opt)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2 mt-2">
                <Input
                  value={optionDraft}
                  onChange={(e) => setOptionDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addOption();
                    }
                  }}
                  placeholder="Add option…"
                  className="h-8 text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addOption}
                  disabled={!optionDraft.trim()}
                >
                  Add
                </Button>
              </div>
            </div>
          )}

          <div className="sm:col-span-2">
            <Label className="text-xs uppercase tracking-wider font-semibold">
              Help text (tooltip)
            </Label>
            <Textarea
              value={form.conditionalNote}
              onChange={(e) =>
                setForm({ ...form, conditionalNote: e.target.value })
              }
              rows={2}
              placeholder="Guidance shown to the CA team when filling this field."
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
            {mode === "create" ? "Create field" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toSnake(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
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
