// On/off switch shown in the header of an optional checklist section
// (With-Profit Funds, Guarantees, Protected Tax-Free Cash (Pre-A-Day)).
// Switching OFF when the section already holds real answers asks first,
// because those answers are replaced with "N/A".
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { OptionalSectionState } from "@/lib/api";

interface Props {
  state: OptionalSectionState;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}

export function OptionalSectionSwitch({ state, disabled, onChange }: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const request = (next: boolean) => {
    if (!next && state.realValueCount > 0) setConfirmOpen(true);
    else onChange(next);
  };
  const id = `opt-sec-${state.section.replace(/\W+/g, "-")}`;
  return (
    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <label htmlFor={id} className="text-[11px] font-semibold text-muted-foreground normal-case tracking-normal">
        {state.enabled ? "Applicable" : "Not applicable"}
      </label>
      <Switch
        id={id}
        checked={state.enabled}
        disabled={disabled}
        onCheckedChange={request}
        aria-label={`${state.section} applicable`}
      />
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark “{state.section}” as not applicable?</AlertDialogTitle>
            <AlertDialogDescription>
              {state.realValueCount} field{state.realValueCount === 1 ? "" : "s"} in this section already
              {state.realValueCount === 1 ? " has" : " have"} an answer. Switching the section off replaces
              every field with “N/A” (and clears any approvals on them).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep answers</AlertDialogCancel>
            <AlertDialogAction onClick={() => onChange(false)}>Set to N/A</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Height-animated wrapper so a section opens/closes like an accordion. */
export function SectionCollapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
      <div className="overflow-hidden" aria-hidden={!open}>{children}</div>
    </div>
  );
}
