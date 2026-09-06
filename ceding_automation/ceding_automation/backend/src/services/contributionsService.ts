// backend/src/services/contributionsService.ts
//
// Service functions for the contribution_transactions child table
// (H33-followup PR2). Extracted from routes/contributions.ts so the
// atomic supersede-and-create logic can be unit-tested in isolation
// without spinning up an Express app or a real database.
//
// The parent's employerAiTotal / personalAiTotal columns are
// deliberately PRESERVED across CA overrides — see the schema.prisma
// comment on those fields for the FH-2026-000188 forensics rationale.
// The conflict marker is a client-side derivation (PR3); this service
// does not write a conflict flag anywhere.

import { PrismaClient, Prisma } from "@prisma/client";

// The Prisma-like slice we depend on — narrowed so the route handler
// (real PrismaClient) and the tests (plain object with vi.fn mocks)
// both type-check without leaking Prisma's whole surface into either.
export type ContributionsPrismaLike = Pick<
  PrismaClient,
  "$transaction" | "checklistContribution" | "contributionTransaction" | "auditLog"
>;

export interface ManualEntryResult {
  transaction: {
    id: string;
    contributionId: string;
    type: "EMPLOYER" | "PERSONAL";
    amount: string;
    description: string;
    source: "MANUAL";
    createdAt: Date;
  };
  supersededCount: number;
}

export class ContributionNotFoundError extends Error {
  constructor() {
    super("Contribution row not found for this case");
    this.name = "ContributionNotFoundError";
  }
}

/**
 * Create a MANUAL contribution transaction in a (contributionId, type)
 * cell, atomically superseding any non-superseded prior rows in that
 * same cell.
 *
 * Supersede-ALL policy: once a CA types a number, that number IS the
 * cell's value. Retyping supersedes the previous MANUAL row too — so
 * the sum of non-superseded children equals the latest CA input rather
 * than accumulating across retypes. Full history is preserved via
 * supersededAt (drill-down in PR3 will surface the replaced rows with
 * "replaced <date>" tags).
 *
 * If you meant a strict-AI-only supersede (literal reading of the PR2
 * spec — "if AI children exist, supersede them"), narrow the WHERE
 * clause below by adding `source: 'AI'` to the updateMany / findMany
 * pair. That would let a repeated manual entry stack instead of
 * replace, which is worse UX but closer to the spec's literal words.
 *
 * The parent's *AiTotal is NOT touched. See the schema comment.
 */
export async function createManualContributionTransaction(
  db: ContributionsPrismaLike,
  args: {
    caseId: string;
    contributionId: string;
    type: "EMPLOYER" | "PERSONAL";
    amount: Prisma.Decimal;
    userId: string;
  },
): Promise<ManualEntryResult> {
  return db.$transaction(async (tx) => {
    // Cross-case protection: the parent row must belong to this case.
    // A leaked contribution id from another case must not permit a
    // write here. Same pattern as the existing PATCH handler.
    const contribution = await tx.checklistContribution.findFirst({
      where: { id: args.contributionId, caseId: args.caseId },
      select: { id: true, position: true, taxYearLabel: true },
    });
    if (!contribution) {
      throw new ContributionNotFoundError();
    }

    // Capture what will be superseded — needed for the audit metadata
    // so the trail is self-contained without joining to superseded
    // rows later.
    const willBeSuperseded = await tx.contributionTransaction.findMany({
      where: {
        contributionId: args.contributionId,
        type: args.type,
        supersededAt: null,
      },
      select: {
        id: true,
        source: true,
        amount: true,
        description: true,
        date: true,
      },
    });

    const now = new Date();

    await tx.contributionTransaction.updateMany({
      where: {
        contributionId: args.contributionId,
        type: args.type,
        supersededAt: null,
      },
      data: { supersededAt: now },
    });

    const created = await tx.contributionTransaction.create({
      data: {
        contributionId: args.contributionId,
        type: args.type,
        amount: args.amount,
        description: "Manual entry",
        source: "MANUAL",
        // date, documentId, sourcePage, sourceRef left NULL — a manual
        // entry has no source date and no source document, and any
        // manufactured default would misrepresent the row as observed
        // evidence in the drill-down.
      },
    });

    await tx.auditLog.create({
      data: {
        caseId: args.caseId,
        userId: args.userId,
        action: "CONTRIBUTION_TRANSACTION_ADDED",
        source: "MANUAL",
        newValue: created.amount.toString(),
        metadata: {
          contributionId: args.contributionId,
          transactionId: created.id,
          type: args.type,
          position: contribution.position,
          taxYearLabel: contribution.taxYearLabel,
          amount: created.amount.toString(),
          supersededCount: willBeSuperseded.length,
          supersededDetails: willBeSuperseded.map((s) => ({
            id: s.id,
            source: s.source,
            amount: s.amount.toString(),
            description: s.description,
            date: s.date ? s.date.toISOString().slice(0, 10) : null,
          })),
        } as Prisma.InputJsonValue,
      },
    });

    return {
      transaction: {
        id: created.id,
        contributionId: created.contributionId,
        type: created.type as "EMPLOYER" | "PERSONAL",
        amount: created.amount.toString(),
        description: created.description,
        source: "MANUAL",
        createdAt: created.createdAt,
      },
      supersededCount: willBeSuperseded.length,
    };
  });
}
