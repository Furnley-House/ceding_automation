// backend/src/routes/publicRecordings.ts
// The ONLY unauthenticated route in this API.
//
// ── Why it exists ─────────────────────────────────────────────────────────
// Palindrome fetches a call recording by GETting the URL we put in the
// Creator row's Meeting_Download_URL2 field. It does not read the WorkDrive
// folder it has been granted access to — proven when a submission failed with
// "Failed to download file after 3 attempts: Redirect response '302'" after
// following a WorkDrive permalink to a login page.
//
// The obvious answer, a WorkDrive external download link, is closed to us
// twice over:
//   * the API user (itsupport@superbiagroup.co.uk) is Editor, not Organizer,
//     on the team folder — POST /links and PATCH /links both answer R008,
//     under every payload/endpoint/header variant;
//   * external download links are disabled org-wide, and should stay that way.
//
// So the backend serves the audio itself. This needs no WorkDrive role beyond
// the download the token already performs, and is tighter than a public link:
// signed, short-lived, single-file, revocable, audited.
//
// See services/recordingLinks.ts for the token format.

import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { verifyRecordingToken, recordingLinkConfigError } from '../services/recordingLinks';
import { downloadWorkDriveFile } from '../services/workdrive';

const router = Router();
const prisma = new PrismaClient();

// Attribution for the audit row. Seeded by prisma/seed.ts, same id the BFF
// write-back path uses — the fetch is machine-initiated, not a human action.
const SYSTEM_USER_ID = 'system-ai-bff';

router.get('/recordings/:token', async (req: Request, res: Response) => {
  // Never let a proxy or CDN cache audio behind a short-lived token.
  res.set('Cache-Control', 'no-store, private');

  const configError = recordingLinkConfigError();
  if (configError) {
    // Log the real cause; tell an unauthenticated caller nothing useful.
    console.error('[public-recordings] not configured:', configError);
    return res.status(503).json({ error: 'Recording links are not configured' });
  }

  const result = verifyRecordingToken(req.params.token);
  if (!result.ok) {
    // Uniform 404 for every failure mode. Distinguishing "bad signature" from
    // "expired" would tell someone probing which half of the token to keep
    // working on.
    console.warn(`[public-recordings] rejected token (${result.reason}) from ${req.ip}`);
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const { buffer, contentType } = await downloadWorkDriveFile(result.fileId);

    // Audit the fetch — this is how you see when Palindrome pulled a client
    // recording. Best-effort: a failed audit write must not fail the
    // download, or Palindrome retries and the pipeline half-breaks.
    if (result.caseId) {
      prisma.auditLog
        .create({
          data: {
            caseId: result.caseId,
            userId: SYSTEM_USER_ID,
            action: 'TRANSCRIPT_UPLOADED',
            source: 'SYSTEM',
            newValue: `Recording fetched via signed link: ${result.filename}`,
            metadata: {
              workdriveFileId: result.fileId,
              filename: result.filename,
              requesterIp: req.ip,
              userAgent: req.headers['user-agent'] ?? null,
              tokenExpiresAt: result.expiresAt.toISOString(),
              bytes: buffer.length,
            } as Prisma.InputJsonValue,
          },
        })
        .catch((err) => console.error('[public-recordings] audit write failed:', err));
    }

    console.log(
      `[public-recordings] served ${result.filename} (${buffer.length} bytes) to ${req.ip}`,
    );

    res.set('Content-Type', contentType || 'audio/mpeg');
    res.set('Content-Length', String(buffer.length));
    // `attachment` so any client following the URL downloads rather than
    // trying to render it. Quotes stripped from the filename so a crafted
    // name can't break out of the header value.
    res.set(
      'Content-Disposition',
      `attachment; filename="${result.filename.replace(/["\r\n]/g, '')}"`,
    );
    res.send(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'download failed';
    console.error(`[public-recordings] WorkDrive fetch failed for ${result.fileId}:`, msg);
    res.status(502).json({ error: 'Upstream fetch failed' });
  }
});

export { router as publicRecordingRoutes };
