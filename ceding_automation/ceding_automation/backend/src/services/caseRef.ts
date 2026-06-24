// backend/src/services/caseRef.ts
// Shared caseRef generator. Single source of truth for the FH-YYYY-NNNNNN
// numbering so that every code path that creates a case (manual form +
// CRM import + any future creator) computes the next ref the same way.
//
// Algorithm — lifted verbatim from the d877bb4 fix in routes/cases.ts:
//   Use MAX(existing suffix) + 1 so deletions don't cause collisions.
//   Sorting by caseRef desc works because the FH-YYYY-NNNNNN format is
//   lexicographically ordered.
import { PrismaClient } from "@prisma/client";

export async function generateNextCaseRef(prisma: PrismaClient): Promise<string> {
  const latest = await prisma.case.findFirst({
    orderBy: { caseRef: "desc" },
    select: { caseRef: true },
  });
  const lastSeq = latest ? parseInt(latest.caseRef.split("-").pop() ?? "0", 10) : 0;
  const nextSeq = Number.isFinite(lastSeq) ? lastSeq + 1 : 1;
  return `FH-${new Date().getFullYear()}-${String(nextSeq).padStart(6, "0")}`;
}
