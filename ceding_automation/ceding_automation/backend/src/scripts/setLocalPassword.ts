// backend/src/scripts/setLocalPassword.ts
// Give a local user a password so you can sign in without SSO.
//
//   npx tsx src/scripts/setLocalPassword.ts <email> [password]
//
// Password login (2026-09-17) is set up by an admin in User Management, and
// the seed creates no passwords — so on a fresh local database nobody can
// sign in to become that admin. This closes that loop. It is the same
// hashPassword the app uses, so the row it writes is indistinguishable from
// one the admin UI would have produced.
//
// Refuses to run against anything but localhost: the whole point is that it
// sets a password nobody had to be told, which is fine on a laptop and not
// fine anywhere else.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword, isPasswordAcceptable } from '../utils/password';

const prisma = new PrismaClient();

const DEFAULT_PASSWORD = 'local-dev-password';

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  const host = url.match(/@([^:/?]+)/)?.[1] ?? '';
  if (!['localhost', '127.0.0.1', '::1', 'db', 'postgres'].includes(host)) {
    console.error(
      `Refusing to run: DATABASE_URL points at "${host}", not a local database.\n` +
        `Passwords on shared environments are set by an admin in User Management.`,
    );
    process.exit(1);
  }
}

async function main() {
  assertLocalDatabase();

  const email = process.argv[2]?.trim().toLowerCase();
  const password = process.argv[3] ?? DEFAULT_PASSWORD;

  if (!email) {
    const users = await prisma.user.findMany({
      select: { email: true, role: true, passwordHash: true },
      orderBy: { email: 'asc' },
    });
    console.log('Usage: npx tsx src/scripts/setLocalPassword.ts <email> [password]\n');
    console.log('Users in this database:');
    for (const u of users) {
      console.log(`  ${u.passwordHash ? '[has password]' : '[no password]'} ${u.role.padEnd(12)} ${u.email}`);
    }
    return;
  }

  const acceptable = isPasswordAcceptable(password);
  if (!acceptable.ok) {
    console.error(`Password rejected: ${acceptable.reason}`);
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, role: true, status: true },
  });
  if (!user) {
    console.error(`No user with email ${email}. Run without arguments to list them.`);
    process.exit(1);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      // Not a temp password handed over by an admin, so there is nothing to
      // force a rotation of — going straight to the app is the point.
      mustChangePassword: false,
      passwordUpdatedAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  console.log(`Password set for ${user.name} <${email}> (${user.role}, ${user.status})`);
  console.log(`  password: ${password}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
