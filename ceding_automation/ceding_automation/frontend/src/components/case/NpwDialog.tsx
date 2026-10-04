import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { markCaseNpw } from "@/services/api";
import { NPW_REASONS, type NpwReasonCode } from "@/lib/npw";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Stage 3 "Mark NPW" — Not Proceeding With. Cancels the case with a reason.
 * The case drops out of active counts and lists but stays viewable, and the
 * audit trail keeps the reason.
 */
export function NpwDialog({
  caseId,
  caseRef,
  open,
  onOpenChange,
}: {
  caseId: string;
  caseRef: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<NpwReasonCode | "">("");
  const [note, setNote] = useState("");
  const noteRequired = reason === "OTHER";
  const canSubmit = reason !== "" && (!noteRequired || note.trim().length > 0);

  const mutation = useMutation({
    mutationFn: () => markCaseNpw(caseId, reason as NpwReasonCode, note.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["case", caseId] });
      qc.invalidateQueries({ queryKey: ["cases"] });
      toast.success(`${caseRef} marked NPW`, { description: "Case cancelled and removed from active work." });
      onOpenChange(false);
    },
    onError: (e) => {
      const msg = axios.isAxiosError(e)
        ? (typeof e.response?.data?.error === "string" ? e.response.data.error : e.message)
        : e instanceof Error
          ? e.message
          : "Unknown error";
      toast.error("Couldn't mark NPW", { description: msg });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark as NPW (Not Proceeding With)</DialogTitle>
          <DialogDescription>
            This cancels {caseRef}. It leaves the active counts and lists, but you can still open it and
            its audit trail.
          </DialogDescription>
        </DialogHeader>

        <RadioGroup value={reason} onValueChange={(v) => setReason(v as NpwReasonCode)} className="gap-2">
          {NPW_REASONS.map((r) => (
            <div key={r.code} className="flex items-center gap-2">
              <RadioGroupItem id={`npw-${r.code}`} value={r.code} />
              <Label htmlFor={`npw-${r.code}`} className="font-normal cursor-pointer">
                {r.label}
              </Label>
            </div>
          ))}
        </RadioGroup>

        <div className="space-y-1.5">
          <Label htmlFor="npw-note">Note {noteRequired ? "(required)" : "(optional)"}</Label>
          <Textarea
            id="npw-note"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Provider pack shows this is an investment bond"
            rows={3}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Keep case
          </Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={!canSubmit || mutation.isPending}
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Mark NPW
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
