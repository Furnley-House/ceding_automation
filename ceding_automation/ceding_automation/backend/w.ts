import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { resolveCaseFolderId } from './src/services/workdrive';
const p = new PrismaClient();
async function main() {
  const cases = await p.case.findMany({
    select: { caseRef: true, clientName: true, clientZohoId: true },
    orderBy: { createdAt: 'desc' }, take: 10,
  });
  console.log('CASE            CLIENT              RESOLVED FOLDER                        SOURCE');
  for (const c of cases) {
    try {
      const r = await resolveCaseFolderId(c.clientZohoId);
      console.log(
        `${(c.caseRef ?? '').padEnd(15)} ${String(c.clientName).slice(0,18).padEnd(19)} ${r.folderId.padEnd(38)} ${r.source}`,
      );
    } catch (e) {
      console.log(`${(c.caseRef ?? '').padEnd(15)} ${String(c.clientName).slice(0,18).padEnd(19)} ERROR: ${(e as Error).message.slice(0,50)}`);
    }
  }
}
main().catch(console.error).finally(() => p.$disconnect());
