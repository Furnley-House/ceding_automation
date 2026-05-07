import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserCheck, Loader2, ExternalLink, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { casesApi } from "@/lib/api";
import { useRole } from "@/hooks/useRole";
import { PARAPLANNERS, type Paraplanner } from "@/lib/paraplanners";
import type { CaseRow } from "@/lib/caseHelpers";

interface Props {
  caseItem: CaseRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAssigned?: () => void;
}

function defaultDueDate() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d.toISOString().slice(0, 10);
}

export function AssignParaplannerDialog({ caseItem, open, onOpenChange, onAssigned }: Props) {
  const qc = useQueryClient();
  const { role, userName } = useRole();
  const [selectedId, setSelectedId] = useState<string>(PARAPLANNERS[0].user_id);
  const [note, setNote] = useState("");
  const [dueDate, setDueDate] = useState(defaultDueDate());

  const sortedParaplanners = useMemo(
    () => [...PARAPLANNERS].sort((a, b) => a.workload - b.workload),
    [],
  );

  const assignMutation = useMutation({
    mutationFn: async () => {
      const pp = PARAPLANNERS.find((p) => p.user_id === selectedId)!;
      const noteWithDue = [note.trim(), `Due: ${dueDate}`].filter(Boolean).join("\n\n");
      await casesApi.assignParaplanner(caseItem.id, pp.user_id, noteWithDue || undefined);
      return { paraplanner: pp };
    },
    onSuccess: ({ paraplanner }) => {
      toast.success(`Assigned to ${paraplanner.full_name}`, {
        description: "Case updated · paraplanner notified.",
      });
      qc.invalidateQueries({ queryKey: ["case", caseItem.id] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      onOpenChange(false);
      onAssigned?.();
    },
    onError: (e: Error) => toast.error("Assign failed", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5 text-teal" />
            Assign to paraplanner
          </DialogTitle>
          <DialogDescription>
            Hand off <strong className="text-foreground">{caseItem.client_name}</strong> for review. The paraplanner will be notified in-app and a CRM task is created.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2 block">
              Paraplanner · sorted by workload
            </Label>
            <div className="space-y-1.5">
              {sortedParaplanners.map((pp) => (
                <ParaplannerCard
                  key={pp.user_id}
                  pp={pp}
                  selected={selectedId === pp.user_id}
                  onSelect={() => setSelectedId(pp.user_id)}
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="due" className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                Due date
              </Label>
              <Input
                id="due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="h-9 mt-1"
              />
            </div>
            <div className="flex items-end">
              <p className="text-[10px] text-muted-foreground italic">
                Default = 3 working days. Adjust if urgent.
              </p>
            </div>
          </div>

          <div>
            <Label htmlFor="note" className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">
              Note for paraplanner (optional)
            </Label>
            <Textarea
              id="note"
              rows={3}
              placeholder="Anything they should know? e.g. safeguarded benefits flagged, AMC needs verification…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1"
            />
          </div>

          <div className="rounded-md border border-info/30 bg-info/5 p-3 text-[11px] text-foreground">
            <p className="font-semibold mb-1 flex items-center gap-1.5">
              <ExternalLink className="h-3 w-3 text-info" /> What happens on assign
            </p>
            <ul className="space-y-0.5 text-muted-foreground ml-4 list-disc">
              <li>Case status → <span className="font-mono text-foreground">ready_for_review</span></li>
              <li>CRM task created and ID stored on the case</li>
              <li>In-app notification sent to the paraplanner</li>
              <li>Immutable entry written to the audit trail</li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={assignMutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => assignMutation.mutate()} disabled={assignMutation.isPending} className="gap-2">
            {assignMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Assigning…
              </>
            ) : (
              <>
                Confirm assign <ChevronRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ParaplannerCard({
  pp,
  selected,
  onSelect,
}: {
  pp: Paraplanner;
  selected: boolean;
  onSelect: () => void;
}) {
  const loadColour =
    pp.workload <= 3
      ? "bg-success/15 text-success border-success/30"
      : pp.workload <= 6
      ? "bg-warning/15 text-warning border-warning/30"
      : "bg-overdue/15 text-overdue border-overdue/30";
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-center gap-3 rounded-md border p-3 text-left transition-colors ${
        selected ? "border-teal bg-teal/5 ring-1 ring-teal/40" : "border-border hover:border-teal/40 hover:bg-muted/40"
      }`}
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold shrink-0">
        {pp.initials}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground">{pp.full_name}</p>
        <p className="text-[11px] text-muted-foreground truncate">{pp.specialism}</p>
      </div>
      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${loadColour}`}>
        {pp.workload} open
      </span>
    </button>
  );
}
