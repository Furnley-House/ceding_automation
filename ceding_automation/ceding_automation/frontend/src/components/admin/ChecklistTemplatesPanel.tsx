import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ListChecks,
  Loader2,
  ArrowUp,
  ArrowDown,
  GripVertical,
  Lock,
} from "lucide-react";
import { checklistTemplatesApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

// Editing the canonical checklist is deliberately locked here. The AI
// extraction layer is trained against the canonical JSON in lockstep —
// adding / renaming / removing fields without re-training the extractor
// causes silent quality regressions (the AI starts dropping fields it
// no longer recognises, or filling stale keys). The Add / Edit / Delete
// buttons stay disabled until an AI-retraining workflow exists; admins
// can still re-order the list, which is purely cosmetic and safe.
export function ChecklistTemplatesPanel() {
  const qc = useQueryClient();
  const [planType, setPlanType] = useState<PlanType>("PENSION");
  const [showInactive, setShowInactive] = useState(true);

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
              View the field definitions each plan type's checklist will
              collect, and reorder them. Adding, editing, or deactivating
              fields is locked here.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1 text-[11px] font-semibold text-warning shrink-0">
          <Lock className="h-3.5 w-3.5" /> Read-only
        </span>
      </div>

      {/* Why-locked banner — explains why Add / Edit / Deactivate are missing
          so a future admin doesn't think they're staring at a broken UI. */}
      <div className="rounded-md border border-warning/30 bg-warning/5 p-3 mb-4 flex items-start gap-2.5">
        <Lock className="h-4 w-4 text-warning shrink-0 mt-0.5" />
        <div className="text-xs text-foreground">
          <p className="font-semibold">Checklist editing is locked</p>
          <p className="text-muted-foreground mt-0.5">
            The AI extraction layer is trained against this exact field set.
            Adding, renaming or removing a field without retraining the
            extractor causes silent quality regressions. Reordering is safe
            and remains available. To change the field set, coordinate with
            the AI team on a paired schema + training update.
          </p>
        </div>
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
                      {/* Only reorder controls remain — Edit / Deactivate /
                          Activate are intentionally absent, see lock banner. */}
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
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* TemplateEditorDialog (create + edit) and the deactivate / reactivate
          mutations were removed when this panel went read-only. Restore from
          git history (look for ChecklistTemplatesPanel.tsx before 16-Jun) once
          the AI extraction layer supports a paired field-set + retraining
          workflow — the backend endpoints (POST / PATCH / DELETE on
          /checklist-templates) still exist and just need their UI re-wired. */}
    </div>
  );
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
