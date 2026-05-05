// Stable paraplanner records used for assignment and in-app notifications.
export interface Paraplanner {
  user_id: string;
  full_name: string;
  initials: string;
  workload: number;
  specialism: string;
}

export const PARAPLANNERS: Paraplanner[] = [
  {
    user_id: "11111111-1111-1111-1111-111111111111",
    full_name: "Emma Clarke",
    initials: "EC",
    workload: 4,
    specialism: "DB transfers · safeguarded benefits",
  },
  {
    user_id: "22222222-2222-2222-2222-222222222222",
    full_name: "Daniel Okonkwo",
    initials: "DO",
    workload: 7,
    specialism: "SIPP & personal pensions",
  },
  {
    user_id: "33333333-3333-3333-3333-333333333333",
    full_name: "Sophie Bennett",
    initials: "SB",
    workload: 2,
    specialism: "ISA · GIA · workplace pensions",
  },
];

export function getParaplanner(userId: string | null | undefined): Paraplanner | undefined {
  if (!userId) return undefined;
  return PARAPLANNERS.find((p) => p.user_id === userId);
}
