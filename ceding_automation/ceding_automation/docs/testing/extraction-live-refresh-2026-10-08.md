# Extraction live-refresh — 2026-10-08

For Revathy. One item, not a full round. On staging now.

Reported from prod by Kishore: at Stage 4, the checklist and the fund /
contributions grids stayed empty after a document finished extracting. The
counts above them read `0 of N`. Only a page refresh brought the data in.
The data was never lost — the screen just was not updating.

Fixed on commit `c4283d1`.

## What it is

When a document extraction completes, the Stage 4 counts and the checklist,
fund-details, and contributions tables now refresh on their own. Before,
they only refreshed when the page was reloaded.

## How to test it

1. Open any PENSION case at Stage 4. Fresh case is easiest — fewer existing
   fields to track.
2. Upload one or two provider documents.
3. Click **Extract** on each document (or **Extract all pending**).
4. **Stay on the page.** Don't navigate, don't refresh.
5. Watch the counts at the top of the Stage 4 panel while extraction runs
   (`Extracting…` → `Extracted · 0:nn` on each doc card). The three count
   tiles (Filled / Needs review / Missing) and the checklist rows should
   fill in on their own as each document finishes. Fund Details and
   Contributions grids should also populate without a refresh.

## What a regression looks like

Document cards flip to **Extracted** but the checklist still reads `0 of N`
and the fund / contributions grids stay empty. A manual page refresh
populates them.

If you hit that, grab the case ID (`FH-2026-xxxxxx`), roughly how many
documents, and whether any of the three (checklist / funds / contributions)
updated and only some lagged — that split would tell us which of the three
notification wires failed.
