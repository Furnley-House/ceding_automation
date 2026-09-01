// backend/src/scripts/testPalindromePoller.ts
// True end-to-end check of the Palindrome transcription path:
//
//   submit  →  Creator row  →  trigger  →  poller  →  .docx  →  Transcript.rawText
//
//   npx tsx src/scripts/testPalindromePoller.ts [--cleanup]
//
// Picks the newest audio file out of the case's WorkDrive folder, submits it,
// then runs the poller until the transcript lands in the database.
//
// Requires:
//   * PUBLIC_BASE_URL reachable from the internet (staging, or a tunnel) —
//     Palindrome fetches the audio over HTTP;
//   * RECORDING_LINK_SECRET set;
//   * a case in the DB (falls back to creating one).
//
// --cleanup removes stranded test transcript rows and exits.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { ensureCaseCallFolders, submitCallForTranscription } from '../services/palindrome';
import { listWorkDriveFiles } from '../services/workdrive';
import { startPalindromePoller, stopPalindromePoller } from '../services/palindromePoller';
import { recordingLinkConfigError } from '../services/recordingLinks';

const prisma = new PrismaClient();
const AUDIO_EXT = ['mp3', 'mp4', 'wav', 'm4a'];

async function cleanup() {
  const stranded = await prisma.transcript.findMany({
    where: { source: 'PALINDROME', rawText: '' },
    select: { id: true, palindromeStatus: true, palindromeRecordId: true },
  });
  console.log(`Deleting ${stranded.length} transcript row(s) with empty rawText:`);
  for (const s of stranded) {
    console.log(`  ${s.id}  status=${s.palindromeStatus ?? '-'}  creator=${s.palindromeRecordId ?? '-'}`);
  }
  if (stranded.length) {
    await prisma.transcript.deleteMany({ where: { id: { in: stranded.map((s) => s.id) } } });
  }
  console.log('done');
}

async function main() {
  const dbHost = process.env.DATABASE_URL?.match(/@([^:/]+)/)?.[1] ?? 'unknown';
  if (dbHost.includes('prod')) {
    throw new Error(`Refusing to run against a prod-looking DB host: ${dbHost}`);
  }

  if (process.argv.includes('--cleanup')) {
    await cleanup();
    return;
  }

  const configError = recordingLinkConfigError();
  if (configError) throw new Error(configError);
  console.log(`[test] PUBLIC_BASE_URL = ${process.env.PUBLIC_BASE_URL}`);

  // ── the case ───────────────────────────────────────────────────────────
  let caseRow = await prisma.case.findFirst({
    select: { id: true, caseRef: true, clientZohoId: true },
  });
  if (!caseRow) {
    const creator = await prisma.user.findFirst({ where: { role: 'CA_TEAM' }, select: { id: true } });
    if (!creator) throw new Error('No CA_TEAM user — run `npm run db:seed` first.');
    caseRow = await prisma.case.create({
      data: {
        caseRef: `FH-TEST-${Date.now().toString().slice(-6)}`,
        clientName: 'Palindrome Poller Test',
        planType: 'PENSION',
        createdById: creator.id,
      },
      select: { id: true, caseRef: true, clientZohoId: true },
    });
  }
  console.log(`[test] case ${caseRow.caseRef} (clientZohoId=${caseRow.clientZohoId ?? 'none → env folder'})`);

  // ── folders + the recording to submit ──────────────────────────────────
  const folders = await ensureCaseCallFolders(caseRow.clientZohoId, caseRow.caseRef);
  console.log(`[test] recordings folder  ${folders.recordingsFolderId}`);
  console.log(`[test] transcripts folder ${folders.transcriptsFolderId}`);

  const audio = await listWorkDriveFiles(folders.recordingsFolderId, { extensions: AUDIO_EXT });
  if (audio.length === 0) {
    throw new Error(
      `No audio file in folder ${folders.recordingsFolderId}. Upload a recording there first.`,
    );
  }
  audio.sort((a, b) => (b.createdTimeMs ?? 0) - (a.createdTimeMs ?? 0));
  const recording = audio[0];
  console.log(`[test] recording: ${recording.name} (${recording.id})\n`);

  // ── submit ─────────────────────────────────────────────────────────────
  const submitted = await submitCallForTranscription({
    caseId: caseRow.id,
    recordingFileId: recording.id,
    recordingFileName: recording.name,
    recordingsFolderId: folders.recordingsFolderId,
    transcriptsFolderId: folders.transcriptsFolderId,
  });
  console.log(`[test] Creator record ${submitted.creatorRecordId}`);

  const transcript = await prisma.transcript.create({
    data: {
      caseId: caseRow.id,
      source: 'PALINDROME',
      rawText: '',
      palindromeRecordId: submitted.creatorRecordId,
      palindromeStatus: 'Ready For Processing',
      requestedAt: new Date(),
      workdriveRecordingFileId: recording.id,
      workdriveTranscriptsFolder: folders.transcriptsFolderId,
    },
  });
  console.log(`[test] transcript row ${transcript.id}\n`);

  // ── let the poller finish it ────────────────────────────────────────────
  process.env.TRANSCRIPT_VIA_PALINDROME = 'true';
  startPalindromePoller();

  console.log('[test] polling for up to 8 minutes…\n');
  const deadline = Date.now() + 8 * 60_000;
  let done = false;

  while (Date.now() < deadline && !done) {
    await new Promise((r) => setTimeout(r, 10_000));
    const row = await prisma.transcript.findUnique({ where: { id: transcript.id } });
    if (!row) break;
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(
      `  [${stamp}] status=${row.palindromeStatus ?? '-'} chars=${row.rawText.length} completed=${row.completedAt ? 'yes' : 'no'}`,
    );
    if (row.completedAt) done = true;
  }

  stopPalindromePoller();

  const final = await prisma.transcript.findUnique({ where: { id: transcript.id } });
  console.log('\n── FINAL ──');
  console.log('status      :', final?.palindromeStatus);
  console.log('completedAt :', final?.completedAt);
  console.log('wd file id  :', final?.workdriveTranscriptFileId ?? '(none)');
  console.log('error       :', final?.palindromeError ?? '(none)');
  console.log('rawText     :', final?.rawText.length, 'chars');
  if (final?.rawText) {
    console.log('\nfirst 3 lines stored on Transcript.rawText:');
    for (const l of final.rawText.split('\n').slice(0, 3)) {
      console.log('  ' + (l.length > 140 ? l.slice(0, 140) + '…' : l));
    }
  }

  const audits = await prisma.auditLog.findMany({
    where: { caseId: caseRow.id, action: 'TRANSCRIPT_UPLOADED' },
    orderBy: { createdAt: 'desc' },
    take: 4,
  });
  console.log(`\nrecent audit rows (${audits.length}):`);
  for (const a of audits) console.log('  -', a.newValue);

  console.log(
    final?.rawText && final.rawText.length > 100
      ? '\n✅ END TO END WORKS — transcript is in the database'
      : '\n❌ transcript did not land',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
