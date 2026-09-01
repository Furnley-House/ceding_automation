// backend/src/services/palindromeTranscript.ts
// Read Palindrome's output document out of WorkDrive and turn it into the
// plain transcript text the checklist extractor consumes.
//
// ── What Palindrome writes ────────────────────────────────────────────────
// The artefact depends on Meeting_Type on the Creator row:
//
//   Meeting_Type = "ceding"          → transcript_<ts>.docx
//                                      VERBATIM, speaker-labelled dialogue
//   Meeting_Type = "Client - Other"  → superbia_summary_ai-generated_<ts>.docx
//                                      narrated third-person summary
//
// Ceding needs the verbatim one: analyseTranscript() cites an evidence_quote
// per extracted field, and that quote is shown to the adviser as the source
// of the value. A summary makes that quote a paraphrase, which is worse than
// useless — it looks like a citation but isn't one. Keep PALINDROME_MEETING_TYPE
// set to "ceding".
//
// Verbatim files look like:
//
//   Meeting Source:
//   None
//   Meeting Participants:
//   Financial Advisor: someone@furnleyhouse.co.uk
//   Provider helpline representative: Oscar
//   Transcript:
//   Oscar : Provider helpline representative : Good morning...
//   someone@furnleyhouse.co.uk : Financial Advisor : Hello...
//
// We keep the dialogue and drop the preamble — the header carries no field
// data and its "Meeting Source: None" lines only confuse the extractor.

import mammoth from 'mammoth';
import { listWorkDriveFiles, downloadWorkDriveFile, WorkDriveFile } from './workdrive';

// Palindrome names verbatim output transcript_*, summaries superbia_summary_*.
// We accept both so a case whose Meeting_Type was wrong still ingests
// something, but the caller is told which it got.
const VERBATIM_PREFIX = 'transcript_';
const SUMMARY_PREFIX = 'superbia_summary';

export type TranscriptKind = 'verbatim' | 'summary' | 'unknown';

export interface PalindromeArtefact {
  file: WorkDriveFile;
  kind: TranscriptKind;
}

export function classifyArtefact(name: string): TranscriptKind {
  const n = name.toLowerCase();
  if (n.startsWith(VERBATIM_PREFIX)) return 'verbatim';
  if (n.startsWith(SUMMARY_PREFIX)) return 'summary';
  return 'unknown';
}

/**
 * Find the newest Palindrome output in a folder.
 *
 * `since` filters to files created after the job was submitted, which matters
 * because the client record folder accumulates output from every call on that
 * client — without it we would keep re-ingesting the first transcript ever
 * written there.
 */
export async function findLatestArtefact(
  transcriptsFolderId: string,
  since?: Date,
  excludeFileIds: string[] = [],
): Promise<PalindromeArtefact | null> {
  const files = await listWorkDriveFiles(transcriptsFolderId, { extensions: ['docx'] });
  const excluded = new Set(excludeFileIds);

  const candidates = files
    .map((f) => ({ file: f, kind: classifyArtefact(f.name) }))
    .filter((c) => c.kind !== 'unknown')
    // Never hand the same document to two transcript rows. Several calls for
    // one client share a folder, so without this a second job could claim the
    // first job's output.
    .filter((c) => !excluded.has(c.file.id))
    .filter((c) => {
      if (!since) return true;
      // Must use the millisecond field. WorkDrive's created_time is the
      // display string "Aug 17, 11:09 AM", which new Date() reads as the
      // YEAR 2001 — every file then looks ancient and gets dropped.
      const ms = c.file.createdTimeMs;
      // Keep files with no usable timestamp rather than silently losing a
      // real transcript.
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return true;
      // 60s of slack: WorkDrive's clock and ours are not the same clock.
      return ms >= since.getTime() - 60_000;
    });

  if (candidates.length === 0) return null;

  // Prefer verbatim when both kinds landed for the same job.
  const verbatim = candidates.filter((c) => c.kind === 'verbatim');
  const pool = verbatim.length > 0 ? verbatim : candidates;

  pool.sort((a, b) => {
    const ta = a.file.createdTimeMs ?? 0;
    const tb = b.file.createdTimeMs ?? 0;
    if (tb !== ta) return tb - ta;
    // Filenames embed a sortable timestamp, so they break ties correctly.
    return b.file.name.localeCompare(a.file.name);
  });

  return pool[0];
}

/** Convert a .docx buffer to plain text, preserving paragraph breaks. */
export async function docxToText(buffer: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer });
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

export interface ParsedTranscript {
  /** Dialogue only — the header stripped off. */
  text: string;
  /** Everything, in case the header is ever needed for triage. */
  fullText: string;
  participants: string[];
  kind: TranscriptKind;
  turnCount: number;
}

/**
 * Split Palindrome's document into participants + dialogue.
 *
 * Everything before the "Transcript:" marker is preamble. If the marker is
 * absent (a summary, or a format change) we keep the whole document — better
 * to hand the extractor too much than to silently return nothing.
 */
export function parseTranscriptDocument(raw: string, kind: TranscriptKind): ParsedTranscript {
  const lines = raw.split('\n');

  const markerIdx = lines.findIndex((l) => /^transcript\s*:?\s*$/i.test(l.trim()));

  const participants: string[] = [];
  const partIdx = lines.findIndex((l) => /^meeting participants\s*:?\s*$/i.test(l.trim()));
  if (partIdx !== -1) {
    const end = markerIdx !== -1 ? markerIdx : lines.length;
    for (let i = partIdx + 1; i < end; i++) {
      const l = lines[i].trim();
      if (!l || /^(meeting|transcript)\b/i.test(l)) continue;
      participants.push(l);
    }
  }

  const body = markerIdx !== -1 ? lines.slice(markerIdx + 1) : lines;
  const text = body.join('\n').trim();

  // A dialogue turn looks like "Speaker : Role : words". Counting them is a
  // cheap sanity signal that we got dialogue rather than prose.
  const turnCount = body.filter((l) => /^[^:]{1,80}:[^:]{1,80}:/.test(l.trim())).length;

  return { text, fullText: raw, participants, kind, turnCount };
}

/** Download + parse one artefact in a single call. */
export async function fetchAndParseArtefact(
  artefact: PalindromeArtefact,
): Promise<ParsedTranscript> {
  const { buffer } = await downloadWorkDriveFile(artefact.file.id);
  const raw = await docxToText(buffer);
  return parseTranscriptDocument(raw, artefact.kind);
}
