// backend/src/scripts/testPalindromeIngest.ts
// Manual check of the Palindrome ingestion path against a real WorkDrive
// folder — finds the newest transcript, downloads it, parses it, and prints
// what the checklist extractor would receive.
//
//   npx tsx src/scripts/testPalindromeIngest.ts <transcriptsFolderId>
//
// Read-only. Writes nothing to WorkDrive, Creator or the database.
import 'dotenv/config';
import {
  findLatestArtefact,
  fetchAndParseArtefact,
} from '../services/palindromeTranscript';

async function main() {
  const folderId = process.argv[2] ?? process.env.ZOHO_WORKDRIVE_FOLDER_ID;
  if (!folderId) {
    console.error('Usage: npx tsx src/scripts/testPalindromeIngest.ts <transcriptsFolderId>');
    process.exit(1);
  }

  console.log(`[ingest-test] folder: ${folderId}\n`);

  const artefact = await findLatestArtefact(folderId);
  if (!artefact) {
    console.log('No Palindrome artefact (transcript_* / superbia_summary_*) in that folder.');
    return;
  }

  console.log(`file       : ${artefact.file.name}`);
  console.log(`kind       : ${artefact.kind}`);
  console.log(`created    : ${artefact.file.createdTime ?? '(unknown)'}`);
  console.log(`size       : ${artefact.file.sizeBytes ?? '?'} bytes\n`);

  const parsed = await fetchAndParseArtefact(artefact);

  console.log(`participants (${parsed.participants.length}):`);
  for (const p of parsed.participants) console.log(`  - ${p}`);

  console.log(`\ndialogue turns : ${parsed.turnCount}`);
  console.log(`chars (body)   : ${parsed.text.length}`);
  console.log(`chars (full)   : ${parsed.fullText.length}`);
  console.log(`words (body)   : ${parsed.text.split(/\s+/).filter(Boolean).length}`);

  if (parsed.kind === 'verbatim' && parsed.turnCount === 0) {
    console.log(
      '\n⚠️  Named transcript_* but no dialogue turns parsed — the document ' +
        'format may have changed. Check the preview below.',
    );
  }

  console.log('\n── first 12 lines of what analyseTranscript() would receive ──');
  for (const l of parsed.text.split('\n').slice(0, 12)) {
    console.log('  ' + (l.length > 150 ? l.slice(0, 150) + '…' : l));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
