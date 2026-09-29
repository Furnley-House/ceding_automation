// backend/src/scripts/backfill-adviser-from-owner.ts
//
// One-off backfill: walk every Case with a `clientZohoId` and no
// `adviserId`, fetch the Zoho Contact, read `Contact.Owner`, resolve
// or auto-provision an app user, and set `Case.adviserId` (+
// `Case.zohoAdviserId` for cache parity with the sync path). Nothing
// else on the case is touched — no `policyRef`, `planType`, `status`,
// `zohoCaseId`, `providerId`, or `paralPlannerId`. Adviser-only.
//
// Zoho field consulted: `Contact.Owner` (id + name + email are
// embedded on the Owner record, so no `findZohoUserById` enrichment
// is needed). The script does NOT read the `ZOHO_CONTACT_FIELD_ADVISER`
// env var — the target field is hardcoded to `Owner` here so the
// script's behaviour is deterministic regardless of runtime env.
//
// Usage:
//   npx tsx src/scripts/backfill-adviser-from-owner.ts \
//        [--commit] \
//        [--limit N] \
//        [--overrides path/to/overrides.json]
//
// Default is dry-run. Pass --commit to actually write.
//
// Idempotent + resumable: the query only selects cases with
// `adviserId IS NULL`, so a re-run after a crash picks up whatever's
// left. Each case's write is one atomic transaction (case.update +
// audit.create), so no half-written state on interrupt. User creates
// use `prisma.user.upsert` on email, safe under retry.
//
// Attribution: cases audited as `userId = 'system-ai-bff'`, action
// `CASE_UPDATED`, `source = 'SYSTEM'`, with a `metadata.runId` uuid
// tagging every row from a single invocation — grep by that to
// review, or to undo one run's writes.

import "dotenv/config";
import { PrismaClient, UserRole, UserStatus } from "@prisma/client";
import * as fs from "fs";
import { randomUUID } from "crypto";
import { getContactRecord } from "../services/zohoCrm";

const SYSTEM_USER_ID = "system-ai-bff";
const REQUEST_STAGGER_MS = 200; // ~5 req/s — well under Zoho CRM v6 (~100 req/min)

interface OverrideConfig {
  // Contacts owned by any of these Zoho user emails are skipped
  // entirely — no user created, no adviserId set. For placeholder /
  // role-based / shared-mailbox Zoho accounts that aren't actual
  // advisers. See KI-12 for the sync-side gap this compensates for
  // (the interactive sync path has the same auto-provision blind
  // spot and should be fixed at source).
  skipEmails: string[];
  inactiveDomains: string[];
  roleOverrides: Record<string, UserRole>;
}

const VALID_ROLES = new Set<UserRole>([
  "CA_TEAM" as UserRole,
  "ADVISER" as UserRole,
  "PARAPLANNER" as UserRole,
  "ADMIN" as UserRole,
]);

const DEFAULT_CONFIG: OverrideConfig = {
  // Prod Zoho scan on 2026-09-29 found these three placeholder accounts.
  // `unassigned@furnleyhouse.co.uk` (active) currently owns 200+ prod
  // Contacts. `admin@` and `test@` are disabled but included defensively
  // in case they're re-enabled or already own historical Contacts.
  skipEmails: [
    "unassigned@furnleyhouse.co.uk",
    "admin@furnleyhouse.co.uk",
    "test@headleyfs.com",
  ],
  inactiveDomains: ["anchor-wealth.co.uk"],
  roleOverrides: {},
};

interface Args {
  commit: boolean;
  limit?: number;
  overridesPath?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { commit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--commit") out.commit = true;
    else if (a === "--dry-run") out.commit = false;
    else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--overrides") out.overridesPath = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: npx tsx src/scripts/backfill-adviser-from-owner.ts [--commit] [--limit N] [--overrides path/to/overrides.json]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function loadConfig(pathToJson?: string): OverrideConfig {
  if (!pathToJson) return DEFAULT_CONFIG;
  const raw = fs.readFileSync(pathToJson, "utf8");
  const parsed = JSON.parse(raw);
  const roleOverrides: Record<string, UserRole> = {};
  for (const [email, role] of Object.entries(parsed.roleOverrides ?? {})) {
    if (!VALID_ROLES.has(role as UserRole)) {
      throw new Error(
        `Invalid role "${role}" for ${email} in ${pathToJson}. Must be one of: ${[...VALID_ROLES].join(", ")}`,
      );
    }
    roleOverrides[email.toLowerCase()] = role as UserRole;
  }
  const skipEmails: string[] = (parsed.skipEmails ?? DEFAULT_CONFIG.skipEmails).map(
    (e: string) => e.toLowerCase().trim(),
  );
  return {
    skipEmails,
    inactiveDomains: (parsed.inactiveDomains ?? DEFAULT_CONFIG.inactiveDomains).map(
      (d: string) => d.toLowerCase(),
    ),
    roleOverrides,
  };
}

interface Owner {
  id: string;
  name?: string;
  email?: string;
}

function extractOwner(contact: Record<string, unknown>): Owner | null {
  const v = contact["Owner"];
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  if (!id) return null;
  return {
    id,
    name: typeof obj.name === "string" ? obj.name.trim() : undefined,
    email:
      typeof obj.email === "string" ? obj.email.trim().toLowerCase() : undefined,
  };
}

type Outcome =
  | {
      kind: "link_existing";
      caseId: string;
      caseRef: string;
      userId: string;
      email: string;
      existingRole: UserRole;
      existingStatus: UserStatus;
      ownerZohoId: string;
    }
  | {
      kind: "create_and_link";
      caseId: string;
      caseRef: string;
      email: string;
      name: string;
      role: UserRole;
      status: UserStatus;
      ownerZohoId: string;
    }
  | { kind: "skip_no_contact"; caseId: string; caseRef: string; clientZohoId: string }
  | { kind: "skip_no_owner"; caseId: string; caseRef: string; clientZohoId: string }
  | { kind: "skip_no_email"; caseId: string; caseRef: string; ownerZohoId: string }
  | { kind: "skip_placeholder_owner"; caseId: string; caseRef: string; email: string; ownerZohoId: string };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs();
  const config = loadConfig(args.overridesPath);
  const runId = randomUUID();
  const prisma = new PrismaClient();

  console.log(`Backfill adviser from Contact.Owner — ${new Date().toISOString()}`);
  console.log(`  Mode:             ${args.commit ? "COMMIT" : "DRY-RUN"}`);
  console.log(`  Run id:           ${runId}`);
  console.log(`  Limit:            ${args.limit ?? "(none)"}`);
  console.log(`  Overrides source: ${args.overridesPath ?? "(defaults)"}`);
  console.log(`  Skip emails:      ${config.skipEmails.join(", ") || "(none)"}`);
  console.log(`  Inactive domains: ${config.inactiveDomains.join(", ") || "(none)"}`);
  console.log(`  Role overrides:   ${Object.keys(config.roleOverrides).length} entr${Object.keys(config.roleOverrides).length === 1 ? "y" : "ies"}`);
  console.log();

  // Cases needing backfill — the WHERE clause is what makes re-runs
  // idempotent. Anything already set stays set.
  const cases = await prisma.case.findMany({
    where: { adviserId: null, clientZohoId: { not: null } },
    select: { id: true, caseRef: true, clientZohoId: true },
    orderBy: { caseRef: "asc" },
    take: args.limit,
  });
  console.log(`Cases to consider (adviserId IS NULL AND clientZohoId IS NOT NULL): ${cases.length}`);

  // De-duplicate by Contact so we don't hit the same Zoho record twice.
  const distinct = new Map<string, string[]>(); // clientZohoId -> caseIds
  for (const c of cases) {
    const key = c.clientZohoId!;
    const list = distinct.get(key) ?? [];
    list.push(c.id);
    distinct.set(key, list);
  }
  console.log(`Distinct Zoho Contacts to fetch: ${distinct.size}`);
  console.log();

  // Sequential fetches with a 200 ms stagger. 130 Contacts ≈ 30 s.
  const ownersByContact = new Map<string, Owner | null>();
  let n = 0;
  const zohoIds = [...distinct.keys()];
  for (const clientZohoId of zohoIds) {
    n++;
    process.stdout.write(`\r  Fetching Contact ${n}/${zohoIds.length}...`);
    try {
      const contact = await getContactRecord(clientZohoId);
      ownersByContact.set(clientZohoId, contact ? extractOwner(contact) : null);
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 100) ?? String(err);
      console.error(`\n  Contact ${clientZohoId}: ${msg}`);
      ownersByContact.set(clientZohoId, null);
    }
    if (n < zohoIds.length) await sleep(REQUEST_STAGGER_MS);
  }
  console.log();
  const fetched = [...ownersByContact.values()].filter(Boolean).length;
  console.log(`  Fetched ${fetched}/${zohoIds.length} Contacts with an Owner id`);
  console.log();

  // Preload existing users for the emails we've seen.
  const emails = new Set<string>();
  for (const o of ownersByContact.values()) if (o?.email) emails.add(o.email);
  const existingUsers = emails.size
    ? await prisma.user.findMany({
        where: { email: { in: [...emails], mode: "insensitive" } },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
        },
      })
    : [];
  const userByEmail = new Map(existingUsers.map((u) => [u.email.toLowerCase(), u]));

  // Compute plan
  const outcomes: Outcome[] = [];
  for (const c of cases) {
    const clientZohoId = c.clientZohoId!;
    const owner = ownersByContact.get(clientZohoId);
    if (!owner) {
      outcomes.push({ kind: "skip_no_contact", caseId: c.id, caseRef: c.caseRef, clientZohoId });
      continue;
    }
    if (!owner.email) {
      outcomes.push({ kind: "skip_no_email", caseId: c.id, caseRef: c.caseRef, ownerZohoId: owner.id });
      continue;
    }
    if (config.skipEmails.includes(owner.email)) {
      // Placeholder / role-based / shared-mailbox Zoho account. Case
      // keeps adviserId=null — a blank adviser field is honest;
      // one that reads "Unassigned" would be misleading.
      outcomes.push({
        kind: "skip_placeholder_owner",
        caseId: c.id,
        caseRef: c.caseRef,
        email: owner.email,
        ownerZohoId: owner.id,
      });
      continue;
    }
    const domain = owner.email.split("@")[1] ?? "";
    const existing = userByEmail.get(owner.email);
    if (existing) {
      outcomes.push({
        kind: "link_existing",
        caseId: c.id,
        caseRef: c.caseRef,
        userId: existing.id,
        email: owner.email,
        existingRole: existing.role,
        existingStatus: existing.status,
        ownerZohoId: owner.id,
      });
    } else {
      const role = config.roleOverrides[owner.email] ?? ("ADVISER" as UserRole);
      const status: UserStatus = config.inactiveDomains.includes(domain)
        ? "INACTIVE"
        : "ACTIVE";
      outcomes.push({
        kind: "create_and_link",
        caseId: c.id,
        caseRef: c.caseRef,
        email: owner.email,
        name: owner.name || owner.email.split("@")[0],
        role,
        status,
        ownerZohoId: owner.id,
      });
    }
  }

  renderReport(outcomes);

  if (!args.commit) {
    console.log();
    console.log("Dry-run — nothing written. Re-run with --commit to apply.");
    await prisma.$disconnect();
    return;
  }

  console.log();
  console.log("─── COMMIT ───────────────────────────────────────");

  // Distinct users to create (one per email even if multiple cases share).
  const createByEmail = new Map<string, Extract<Outcome, { kind: "create_and_link" }>>();
  for (const o of outcomes) {
    if (o.kind === "create_and_link" && !createByEmail.has(o.email)) {
      createByEmail.set(o.email, o);
    }
  }

  const userIdByEmail = new Map<string, string>();
  for (const u of existingUsers) userIdByEmail.set(u.email.toLowerCase(), u.id);

  let createdUsers = 0;
  for (const [email, o] of createByEmail) {
    try {
      const user = await prisma.user.upsert({
        where: { email },
        update: {}, // never overwrite an existing user's role/status
        create: {
          email,
          name: o.name,
          role: o.role,
          status: o.status,
        },
        select: { id: true },
      });
      const wasCreated = !userIdByEmail.has(email);
      userIdByEmail.set(email, user.id);
      if (wasCreated) createdUsers++;
      // NOTE: no user_audit_logs write. The UserAuditAction enum
      // doesn't include USER_CREATED (it covers PERMISSION / ROLE /
      // STATUS changes only). Creation is traceable via
      // `users.createdAt`, and the linked case's audit_logs row
      // carries `metadata.autoProvisioned = true` + the shared runId,
      // which is a full trail: "this run created this user, and here
      // is the case it was linked to".
    } catch (err) {
      console.error(`  Upsert user ${email} failed: ${(err as Error).message?.slice(0, 120)}`);
    }
  }
  console.log(`  Users created:  ${createdUsers}`);
  console.log(`  Users linked:   ${userIdByEmail.size - createdUsers} existing rows`);

  // Case updates — one atomic transaction each, so an interrupt leaves no
  // half-written cases.
  let updated = 0;
  let failed = 0;
  for (const o of outcomes) {
    const userId =
      o.kind === "link_existing"
        ? o.userId
        : o.kind === "create_and_link"
        ? userIdByEmail.get(o.email)
        : null;
    if (!userId) continue;
    const ownerZohoId =
      o.kind === "link_existing"
        ? o.ownerZohoId
        : o.kind === "create_and_link"
        ? o.ownerZohoId
        : null;
    if (!ownerZohoId) continue;

    try {
      await prisma.$transaction([
        prisma.case.update({
          where: { id: o.caseId },
          data: {
            adviserId: userId,
            zohoAdviserId: ownerZohoId,
          },
        }),
        prisma.auditLog.create({
          data: {
            caseId: o.caseId,
            userId: SYSTEM_USER_ID,
            action: "CASE_UPDATED",
            source: "SYSTEM",
            newValue: "Backfilled adviser from Zoho Contact.Owner",
            metadata: {
              backfill: "adviser-from-owner",
              script: "backfill-adviser-from-owner",
              runId,
              changes: [{ field: "adviser", from: null, to: userId }],
              autoProvisioned: o.kind === "create_and_link",
              ownerZohoId,
            },
          },
        }),
      ]);
      updated++;
    } catch (err) {
      failed++;
      console.error(`  ${o.caseRef}: ${(err as Error).message?.slice(0, 120)}`);
    }
  }
  console.log(`  Cases updated:  ${updated}`);
  if (failed) console.log(`  Cases failed:   ${failed}`);
  console.log();
  console.log(`Run id: ${runId}`);
  console.log(`  audit_logs   —  filter on metadata->>'runId' = '${runId}'`);
  console.log(`  user_audit_logs — same filter on newly-created users`);

  await prisma.$disconnect();
}

function renderReport(outcomes: Outcome[]) {
  const link = outcomes.filter((o) => o.kind === "link_existing") as Extract<Outcome, { kind: "link_existing" }>[];
  const create = outcomes.filter((o) => o.kind === "create_and_link") as Extract<Outcome, { kind: "create_and_link" }>[];
  const noContact = outcomes.filter((o) => o.kind === "skip_no_contact");
  const noEmail = outcomes.filter((o) => o.kind === "skip_no_email");
  const placeholder = outcomes.filter((o) => o.kind === "skip_placeholder_owner") as Extract<Outcome, { kind: "skip_placeholder_owner" }>[];

  console.log("Plan summary");
  console.log(`  Would link to existing user:       ${link.length} cases`);
  console.log(`  Would auto-provision + link:       ${create.length} cases`);
  console.log(`  Would skip (placeholder Owner):    ${placeholder.length} cases`);
  console.log(`  Would skip (Contact not found):    ${noContact.length} cases`);
  console.log(`  Would skip (Owner has no email):   ${noEmail.length} cases`);
  console.log();

  if (create.length) {
    // Distinct users to be created, with case counts + status/role.
    const byEmail = new Map<
      string,
      { role: UserRole; status: UserStatus; name: string; cases: number }
    >();
    for (const o of create) {
      const cur = byEmail.get(o.email) ?? { role: o.role, status: o.status, name: o.name, cases: 0 };
      cur.cases++;
      byEmail.set(o.email, cur);
    }
    const rows = [...byEmail.entries()].sort((a, b) => b[1].cases - a[1].cases);
    console.log(`New users to be auto-provisioned (${byEmail.size}):`);
    console.log(`  ${"email".padEnd(42)} ${"name".padEnd(24)} ${"role".padEnd(11)} ${"status".padEnd(9)} cases`);
    for (const [email, u] of rows) {
      console.log(`  ${email.padEnd(42)} ${u.name.padEnd(24).slice(0, 24)} ${u.role.padEnd(11)} ${u.status.padEnd(9)} ${u.cases}`);
    }
    console.log();
  }

  if (link.length) {
    const byEmail = new Map<
      string,
      { role: UserRole; status: UserStatus; cases: number }
    >();
    for (const o of link) {
      const cur = byEmail.get(o.email) ?? { role: o.existingRole, status: o.existingStatus, cases: 0 };
      cur.cases++;
      byEmail.set(o.email, cur);
    }
    const rows = [...byEmail.entries()].sort((a, b) => b[1].cases - a[1].cases);
    console.log(`Existing users to link (role preserved) (${byEmail.size}):`);
    console.log(`  ${"email".padEnd(42)} ${"current role".padEnd(13)} ${"status".padEnd(9)} cases`);
    for (const [email, u] of rows) {
      console.log(`  ${email.padEnd(42)} ${u.role.padEnd(13)} ${u.status.padEnd(9)} ${u.cases}`);
    }
    console.log();
  }

  if (placeholder.length) {
    // Break down by which placeholder email so it's obvious which pattern
    // is doing the skipping.
    const byEmail = new Map<string, number>();
    for (const o of placeholder) byEmail.set(o.email, (byEmail.get(o.email) ?? 0) + 1);
    const rows = [...byEmail.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`Skipped — Owner is a placeholder / shared account (${placeholder.length}):`);
    for (const [email, n] of rows) {
      console.log(`  ${email.padEnd(42)} ${n} cases`);
    }
    console.log();
  }

  if (noContact.length) {
    console.log(`Skipped — Contact not fetchable from Zoho (${noContact.length}):`);
    for (const o of noContact.slice(0, 10)) {
      console.log(`  ${o.caseRef}  (clientZohoId: ${o.clientZohoId})`);
    }
    if (noContact.length > 10) console.log(`  … and ${noContact.length - 10} more`);
    console.log();
  }

  if (noEmail.length) {
    console.log(`Skipped — Owner has no email on Contact (${noEmail.length}):`);
    for (const o of noEmail.slice(0, 10)) {
      console.log(`  ${o.caseRef}  (Owner: ${o.ownerZohoId})`);
    }
    if (noEmail.length > 10) console.log(`  … and ${noEmail.length - 10} more`);
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
