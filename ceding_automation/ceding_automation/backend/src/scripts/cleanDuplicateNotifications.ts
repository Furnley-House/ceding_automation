// One-off cleanup: collapse duplicate (user, case, title) notifications
// to the most recent one. Run with: npx tsx src/scripts/cleanDuplicateNotifications.ts
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // Pull all notifications, group in JS — small table, easier than raw SQL.
  const all = await prisma.notification.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, userId: true, caseId: true, title: true, createdAt: true },
  });
  const seen = new Set<string>();
  const toDelete: string[] = [];
  for (const n of all) {
    const key = `${n.userId}::${n.caseId ?? ""}::${n.title}`;
    if (seen.has(key)) toDelete.push(n.id);
    else seen.add(key);
  }
  if (toDelete.length === 0) {
    console.log("No duplicate notifications found.");
    return;
  }
  console.log(`Deleting ${toDelete.length} duplicate notifications…`);
  const result = await prisma.notification.deleteMany({
    where: { id: { in: toDelete } },
  });
  console.log(`Deleted ${result.count} rows.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
