// backend/src/services/planResolution.ts
//
// Find the Zoho Plans record for a case when the stored id is missing or
// no longer resolves. Shared by Refresh-from-Zoho (routes/cases.ts) and the
// Stage 9 export (routes/export.ts) so both heal the same way.
//
// Why more than one Policy_Ref search: the Zoho Task's Plan_reference is
// free text and CAs sometimes type two references into it
// ("8714659 / 714126"). The case's own policyRef is locked after
// extraction and holds the clean value, but the sync used to search Plans
// with the Task's raw combined string — which matches nothing. We now try
// the case's value, then each individual part of the Task's value, then
// the plan Name the case cached when it was last linked.

import { findPlanRecordByName, findPlanRecordByPolicyRef } from "./zohoCrm";

export type PlanHit = { id: string; record: Record<string, unknown> };
export type PlanResolution = PlanHit & { via: "policy_ref" | "plan_name"; matchedOn: string };

/** Split "8714659 / 714126" style references into ["8714659", "714126"].
 *  Each full input value comes first (an exact Policy_Ref may genuinely
 *  contain a "/"), then its parts. Order-preserving, de-duplicated. */
export function policyRefCandidates(...refs: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  for (const r of refs) if (r) add(r);
  for (const r of refs) {
    if (!r) continue;
    for (const part of r.split(/\s*(?:\/|,|;|&|\||\band\b)\s*/i)) add(part);
  }
  return out;
}

/** Try each Policy_Ref candidate, then the cached plan Name. Returns the
 *  first unique match, or null. Search errors propagate to the caller. */
export async function resolvePlanRecord(opts: {
  policyRefs: Array<string | null | undefined>;
  planName?: string | null;
}): Promise<PlanResolution | null> {
  for (const ref of policyRefCandidates(...opts.policyRefs)) {
    const hit = await findPlanRecordByPolicyRef(ref);
    if (hit) return { ...hit, via: "policy_ref", matchedOn: ref };
  }
  if (opts.planName && opts.planName.trim()) {
    const hit = await findPlanRecordByName(opts.planName);
    if (hit) return { ...hit, via: "plan_name", matchedOn: opts.planName.trim() };
  }
  return null;
}
