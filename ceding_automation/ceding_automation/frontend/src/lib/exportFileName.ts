// Stage 9 export file name, in the format the team used before the app:
//   "Ceding Checklist – Nest Pensions – Amanda Pankhurst – 12345678.xlsx"
// Used for both the local download and the WorkDrive upload.
//
// Each part is cleaned of characters Windows / WorkDrive reject
// (\ / : * ? " < > |) — policy refs like "8714659 / 714126" contain a
// slash. Missing parts are left out rather than printed as blanks.

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]+/g;

function clean(part: string | null | undefined): string {
  return (part ?? "").replace(ILLEGAL, " ").replace(/\s+/g, " ").trim();
}

export function buildExportFileName(opts: {
  providerName?: string | null;
  clientName?: string | null;
  policyNumber?: string | null;
  /** Fallback identifier when provider, client and policy are all blank. */
  caseRef?: string | null;
}): string {
  const parts = [opts.providerName, opts.clientName, opts.policyNumber].map(clean).filter(Boolean);
  if (parts.length === 0 && clean(opts.caseRef)) parts.push(clean(opts.caseRef));
  return `${["Ceding Checklist", ...parts].join(" – ")}.xlsx`;
}
