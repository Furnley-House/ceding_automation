// One-shot: find Megan Doherty's user record (id + email + role).
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: "Megan", mode: "insensitive" } },
        { name: { contains: "Doherty", mode: "insensitive" } },
      ],
    },
    select: { id: true, email: true, name: true, role: true, status: true, ssoId: true },
  });
  console.log(JSON.stringify(users, null, 2));

  console.log("\n── All active paraplanners ──");
  const paraplanners = await prisma.user.findMany({
    where: { role: "PARAPLANNER" },
    select: { id: true, email: true, name: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(JSON.stringify(paraplanners, null, 2));
}
main().then(() => prisma.$disconnect()).catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
