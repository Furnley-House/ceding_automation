// One-shot: replace Emma Clarke (dummy paraplanner) with Megan Doherty
// (real paraplanner) across existing case data, then deactivate Emma so
// the auto-assign helper picks Megan going forward.
//
// Lookups by EMAIL so the script is portable across local / staging / prod
// (DB cuids differ per env). If Megan doesn't exist in the target DB yet,
// the seed will create her — run `npx prisma db seed` first.
//
// Run with: npx tsx src/scripts/replaceEmmaWithMegan.ts
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const EMMA_EMAIL = "paraplanner@furnleyhouse.co.uk";
const MEGAN_EMAIL = "megan.doherty@furnleyhouse.co.uk";

async function main() {
  const emma = await prisma.user.findUnique({ where: { email: EMMA_EMAIL } });
  const megan = await prisma.user.findUnique({ where: { email: MEGAN_EMAIL } });
  if (!megan) {
    throw new Error(
      `Megan Doherty (${MEGAN_EMAIL}) not found. Run \`npx prisma db seed\` first to create her.`,
    );
  }
  if (!emma) {
    console.log(`Emma (${EMMA_EMAIL}) not found in this DB — nothing to migrate.`);
    return;
  }
  const EMMA_ID = emma.id;
  const MEGAN_ID = megan.id;
  console.log(`Emma:  ${emma.name} <${emma.email}> status=${emma.status}`);
  console.log(`Megan: ${megan.name} <${megan.email}> status=${megan.status}`);
  console.log("");

  // 1. Repoint cases assigned to Emma as paraplanner → Megan
  const casesUpdated = await prisma.case.updateMany({
    where: { paralPlannerId: EMMA_ID },
    data: { paralPlannerId: MEGAN_ID },
  });
  console.log(`Cases.paralPlannerId Emma → Megan: ${casesUpdated.count}`);

  // 2. Repoint cases where Emma was assignedTo (CA) — unlikely but safe
  const assignedUpdated = await prisma.case.updateMany({
    where: { assignedToId: EMMA_ID },
    data: { assignedToId: MEGAN_ID },
  });
  console.log(`Cases.assignedToId Emma → Megan:    ${assignedUpdated.count}`);

  // 3. Repoint notifications addressed to Emma
  const notifsUpdated = await prisma.notification.updateMany({
    where: { userId: EMMA_ID },
    data: { userId: MEGAN_ID },
  });
  console.log(`Notifications Emma → Megan:         ${notifsUpdated.count}`);

  // 4. Deactivate Emma (keep the row so historical audit / created-by refs
  //    don't break, but she stops appearing in active-paraplanner lookups)
  await prisma.user.update({
    where: { id: EMMA_ID },
    data: { status: "INACTIVE" },
  });
  console.log(`Emma marked INACTIVE`);

  console.log("\n── After ──");
  const stillActive = await prisma.user.findMany({
    where: { role: "PARAPLANNER", status: "ACTIVE" },
    select: { name: true, email: true },
    orderBy: { createdAt: "asc" },
  });
  console.table(stillActive);
}

main().then(() => prisma.$disconnect()).catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
