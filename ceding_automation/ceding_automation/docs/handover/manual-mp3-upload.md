# Manual MP3 upload button — feature-request handover

**For:** whoever picks it up (was Srinath's original branch)
**From:** 2026-10-01 triage session (Nishant + Claude)
**Backend:** complete, unreachable since `d81a9e8` (2026-09-01)
**Scope:** frontend-only, ~90 loc in `CallWorkspace.tsx`

## Context

Surfaced in Revathy's 2026-09-30 E2E as "MP3 upload unreachable from the UI — backend route exists at calls.ts:836, no frontend caller" and initially categorised as a high-severity defect. On triage 2026-10-01: it's not a defect. Srinath added a complete backend endpoint on 2026-09-01 in `d81a9e8` (a Palindrome-adjacent feature commit) but no frontend caller was ever written. Nothing regressed; a feature landed half-done.

Reframed as feature-request, not filed in `KNOWN_ISSUES.md`. Open workflow question below determines whether it ships at all.

## Open question — must be answered before this ships

**Does RingCentral cover every call a CA needs transcribed?** If yes, the endpoint stays as dead code (harmless, gated by CA_TEAM/ADMIN + `requireCaseAccess`) or gets removed in a cleanup PR. If no — the plausible gaps are (1) provider calling back on a CA's mobile because they missed the RC line, (2) adviser/paraplanner joining a chase call from a personal line out of hours, (3) a recording exists in a legacy format from a pre-RC Furnley setup — then this feature ships.

Nishant to ask Aruna / a CA: "in the last month, have you had a call for a case that you couldn't get RC to transcribe?" Answer decides.

## Backend — already done

`POST /api/cases/:caseId/calls/upload-recording` at `backend/src/routes/calls.ts:836`:

- Auth: `requireAuth`, `requireRole(["CA_TEAM", "ADMIN"])`, `requireCaseAccess`.
- Multer memory storage, 250 MB limit, `.single("file")` — accepts multipart form with field name `file`.
- Content-Type inferred from the file; rejected with 415 if not audio (`.mp3`, `.wav`, `.m4a`, `.mp4`).
- Resolves the client's WorkDrive folder via `ensureCaseCallFolders(clientZohoId, caseRef)`; hard-fails 422 with `WorkDriveFolderResolutionError` shape if the Contact has no `Client_Record_Folder_ID`.
- Prefixes the filename with the case ref so a shared client folder stays readable.
- Uploads the buffer to WorkDrive via `uploadToWorkDrive` (already wrapped in `withZohoAuth` — KI-13 handled).
- Submits to Palindrome via `submitAndTrack` — same tracker the RC path uses, so the returned `transcriptId` plugs straight into the frontend's existing polling.
- Returns 202 with `{ transcriptId, creatorRecordId, status, recordingFileId, recordingFileName, recordingPermalink, folders }`.

Palindrome-not-configured → 503; folder unresolvable → 422; unknown → 500. All paths already handled server-side.

## Frontend — what's needed

Add to `frontend/src/components/case/CallWorkspace.tsx`:

1. **A handler** `uploadRecordingFile(file: File)` — placed after the existing `submitToPalindrome`. Same `palPhase` state machine (`"idle" | "uploading" | "waiting" | "done" | "failed"`), same polling via `watchPalindromeTranscript(transcriptId)`, same toast shapes. Client-side pre-check: reject files > 250 MB before uploading (matches the backend multer limit at `calls.ts:62`). Distinguish 415 / 422 / 500 in the error toast.

2. **A file-input affordance** — placed inside the RC Recordings panel body, just above the commented-out "manual session ID fallback" (around `CallWorkspace.tsx:2131`). Small dashed-border label with a hidden `<input type="file" accept="audio/*,.mp3,.wav,.m4a,.mp4" />` inside. Disabled + spinner during `palPhase === "uploading"`. Reset `e.target.value = ""` on change so a CA can re-pick the same file after an error.

3. **No new endpoint, no new dependencies, no backend work.** `CloudUpload` and `Loader2` icons are already imported.

Copy suggestion: "Or upload an audio file (RC didn't record, different phone, etc.)".

## Draft was written and reverted

A working diff was drafted on 2026-10-01 (roughly the shape above, 90 lines), typechecked cleanly, and was ready to commit. Reverted before commit because it's a feature and shouldn't ship in the bug-fix batch. If the workflow question above answers "yes, there are RC gaps," the code shape is well-understood; whoever picks it up can re-derive in an hour.

## Not blocking anything today

The backend endpoint sitting unreachable is not costing anything — no security surface (role + case-access gated), no orphaned data, no maintenance overhead. Cleanup path if this is dropped for good: delete `router.post("/:caseId/calls/upload-recording", ...)` in `calls.ts`, drop the associated `recordingUpload` multer config if it isn't used elsewhere. Separate PR.

## Cross-refs

- `KI-13` — WorkDrive auth wrapper. Already applied to `uploadToWorkDrive`, so this feature inherits the fix without extra work.
- `KI-15` — auth-route rate limiter deferred. Unrelated but part of the same batch of triage findings.
- Original E2E report: Revathy 2026-09-30, item 5 of 7.
