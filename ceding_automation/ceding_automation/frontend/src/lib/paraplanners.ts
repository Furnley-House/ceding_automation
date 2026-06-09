// Display/decorative metadata for paraplanners. Real per-case paraplanner
// link is resolved backend-side via Case.paralPlannerId; this list is just
// for chips, initials, and workload colour-coding on the dashboard.
//
// `email` is the cross-environment-stable key.
// `user_id` is a placeholder retained only for AssignParaplannerDialog
// (currently dead code — never imported). Don't depend on it matching a
// real DB row; staging / prod have different cuids per env.
export interface Paraplanner {
  email: string;
  user_id: string; // placeholder for legacy dialog only — do not query against DB
  full_name: string;
  initials: string;
  workload: number;
  specialism: string;
}

export const PARAPLANNERS: Paraplanner[] = [
  {
    // Real Furnley House paraplanner — primary reviewer for ceding cases.
    email: "megan.doherty@furnleyhouse.co.uk",
    user_id: "megan-placeholder",
    full_name: "Megan Doherty",
    initials: "MD",
    workload: 4,
    specialism: "Pension · ISA · GIA ceding cases",
  },
  {
    email: "daniel.okonkwo@furnleyhouse.co.uk",
    user_id: "daniel-placeholder",
    full_name: "Daniel Okonkwo",
    initials: "DO",
    workload: 7,
    specialism: "SIPP & personal pensions",
  },
  {
    email: "sophie.bennett@furnleyhouse.co.uk",
    user_id: "sophie-placeholder",
    full_name: "Sophie Bennett",
    initials: "SB",
    workload: 2,
    specialism: "ISA · GIA · workplace pensions",
  },
];

export function getParaplannerByName(fullName: string | null | undefined): Paraplanner | undefined {
  if (!fullName) return undefined;
  const lower = fullName.trim().toLowerCase();
  return PARAPLANNERS.find((p) => p.full_name.toLowerCase() === lower);
}
