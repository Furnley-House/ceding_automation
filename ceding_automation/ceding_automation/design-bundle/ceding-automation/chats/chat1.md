# Provider Hub AI

_Started 2026-05-07 13:55 UTC_

---

## User

GitHub connected

## Assistant

Hi! GitHub is connected — feel free to paste a github.com repository URL and I can explore the structure or import specific files to use as reference for design mockups.

What are you working on for the Ceding Automation project? If you have a repo to pull from, drop the link; otherwise let me know what you'd like to design and I'll ask a few questions to get going.

## User

https://github.com/Furnley-House/providerhub-ai

## Assistant

I'll start by exploring the attached folder, the design system, and the GitHub repo in parallel to understand what we're working with.

_[tool: local_ls]_

_[tool: list_files]_

_[tool: github_get_tree]_

The design system folder appears empty — let me check it more carefully, and explore both codebases in parallel.

_[tool: list_files]_

_[tool: local_ls]_

_[tool: local_read]_

_[tool: github_read_file]_

_[tool: github_get_tree]_

I have rich context now. The local folder and the GitHub repo appear to be the same codebase. The design system project is empty — so the brand reference will be the README's specified palette (Navy `#0D1B2A` | Teal `#00C2CB` | Inter) plus what's in the actual codebase.

Let me look at the existing screenshots, key pages, and styling so I understand the current product before asking questions.

_[tool: view_image]_

_[tool: view_image]_

_[tool: view_image]_

_[tool: view_image]_

Local images aren't accessible directly — let me copy a few key files in to understand the visual language.

_[tool: local_copy_to_project]_

_[tool: view_image]_

_[tool: view_image]_

_[tool: view_image]_

_[tool: view_image]_

_[tool: view_image]_

_[tool: read_file]_

_[tool: read_file]_

I now have a clear picture of the existing ProviderHub product:

**Brand & visual language**
- **Furnley House**: Navy `#0D1B2A` primary, Teal `#00C2CB` accent, Inter font
- Dark navy sidebar, light content area, white cards with subtle shadows
- Confidence states: green (high) / amber (medium) / red (low/missing)
- 4 themes available (furnley default, ocean, forest, royal)
- Lion icon + ProviderHub wordmark logos

**Product surface**
- Dashboard, Cases (LOA→Ceding pipeline), Document Inbox, Ceding Checklist, Missing Data, Provider Directory, Automations, Call Assist, Founder View
- 10-stage case workflow with stage-gated navigation
- Roles: CA_TEAM, ADVISER, PARAPLANNER, ADMIN
- Existing screenshots show current Lovable prototype state

Before I design anything, I need to know what you actually want me to make. A few quick questions:

_[tool: questions_v2]_

## User

Questions answered:
- scope: 12
- what_to_design: The Missing Data Resolution flow (call script + field-by-field)
- visual_direction: Push the design further — more polished, opinionated
- user_role: CA Team (Chennai) — uploads, runs extraction, owns the pipeline
- novelty: Mostly familiar, with a few interesting moments
- interaction_focus: Confidence-scored field review (approve/edit/source), PDF viewer ↔ checklist split view with citations, Stage progression / pipeline navigation, Call Assist — script generation, transcript paste, auto-fill, Missing Data triage, LOA send & chase tracking, Export to Excel / Zoho WorkDrive, Document upload & AI extraction progress
- audience: Personal exploration

## Assistant

_[tool: update_todos]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: snip]_

Now let me peek at the seed data so I have realistic field names to use, then read CallWorkspace which is the actual per-case implementation.

_[tool: local_read]_

_[tool: local_read]_

_[tool: snip]_

I have everything I need. Now let me design.

## Design plan

**The frame:** A reimagined **Missing Data Resolution** workspace for the CA Team. The current product splits this across two pages (Missing Data + Call Assist) with a draggable script panel — I'll fuse them into one focused workspace with a clear flow:

**Layout (full-bleed, 1440 design width):**
- **Furnley navy sidebar** (collapsed, icons-only with active "Missing Data") — keeps it grounded in the existing app shell
- **Top bar** — case context (client, provider, plan number), routing match, primary "Call Provider" CTA
- **Three-column workspace:**
  1. **Left rail (320px)** — case queue: cases needing resolution, sorted by urgency, with field counts + confidence ring
  2. **Center (flex)** — main resolution canvas. Two modes via a quiet segmented switch:
     - **Fields mode** (default): Missing fields + Needs Review fields, grouped by section, each card shows label, evidence quote (when present), inline value entry, "ask on call" tag, confirm/edit
     - **Call mode**: AI-generated script with question chips that map 1:1 to fields. Live-mode shows a transcript pane on the right that auto-extracts and pushes values back into the field cards.
  3. **Right rail (380px)** — provider context (routing rule matched, dept, phone), call status (RingCentral state), recent transcripts

**Type system:**
- Inter throughout (already in app)
- Display: 28/32 semibold for page titles, 18/24 for section heads
- Body: 14/20 regular, 12/16 medium for labels/meta
- Numerics: tabular-nums on plan numbers, values, confidence %

**Color usage (Furnley palette):**
- Navy `#0D1B2A` for sidebar, primary CTAs, headings
- Teal `#00C2CB` for active states, links, interactive accents
- Confidence: green `#16a34a` / amber `#f59e0b` / red `#dc2626`
- Soft tinted backgrounds for status (e.g. `bg-red-50` for Missing rows)
- White cards with `0 1px 3px rgba(13,27,42,.06)` shadows

**Novel moments (the "few interesting moments"):**
1. **Question→Field linking** — hovering a script question highlights the field card it answers (and vice versa); clicking auto-scrolls
2. **Live transcript extraction** — as transcript text streams in, low-confidence values appear as ghost suggestions on field cards with one-click accept
3. **Confidence dial** — a single donut showing case completion (e.g. 12/15 fields) instead of a flat progress bar
4. **Routing badge** — when the plan number matches a provider routing rule, show a chip like `TK → Aviva, Pensions Servicing` with the prefix highlighted

**12 screens/states to cover (slide-deck-style with goToFrame):**
1. Overview — case queue + workspace at rest
2. Fields mode — full field list with section grouping
3. Inline value entry on a missing field
4. Confidence dial expanded with field breakdown
5. Generate Script (AI loading state)
6. Call mode — script with question chips
7. Routing prompt before dialing
8. Live call — connected, transcript streaming
9. Auto-extracted ghost suggestion on a field
10. Field confirmed (green flash + collapse)
11. Case complete state
12. Empty state — no missing data

**Tweaks:**
- Theme (Furnley default / Forest / Royal)
- Density (Comfortable / Compact)
- Sidebar (Icons / Labels)
- Show evidence quotes (on/off)

Let me build it. I'll use a starter component for the prototype scaffolding plus tweaks_panel.

_[tool: copy_starter_component]_

_[tool: copy_files]_

_[tool: snip]_

_[tool: read_file]_

Now I'll build the prototype. Let me write the main HTML file, splitting components across files.

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: write_file]_

_[tool: snip]_

_[tool: write_file]_

Now let me write the icons file and the main HTML with all phases of the flow.

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: copy_starter_component]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: done]_

_[tool: update_todos]_

_[tool: fork_verifier_agent]_

Built a full-bleed CA-Team prototype for the Missing Data Resolution flow — 5 phases (Triage → Prepare Script → Live Call → Apply Findings → Hand Off) with role-true Furnley House navy/teal styling, confidence-scored field cards with source quotes, AI-drafted call script linked to checklist fields, live transcript with auto-extraction, and Tweaks panel for phase navigation and display options.

## User

https://github.com/Furnley-House/ceding_automation/tree/main/ceding_automation/ceding_automation

this is the current repo after importing the lovable design, do the same kind of design changes using the current repo

## Assistant

_[tool: snip]_

_[tool: github_get_tree]_

_[tool: github_list_repos]_

_[tool: snip]_

_[tool: github_get_tree]_

_[tool: github_prompt_install]_

I can't access the `Furnley-House/ceding_automation` repo yet — looks like it's private and the GitHub App needs to be installed on that org. Click the install banner above to grant access, then send a message and I'll pick up the new repo and apply the same design treatment.

## User

i made it public, try now

## Assistant

_[tool: snip]_

_[tool: github_get_tree]_

_[tool: github_get_tree]_

I have access to the new `ceding_automation` repo. Let me read the key new files to see what's changed from the providerhub-ai version, then redo the design changes against this repo.

_[tool: snip]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: github_read_file]_

_[tool: snip]_

The new repo has all the same surface area as before, plus several real-world additions I should design against:

**What's new in the current repo vs. the Lovable prototype:**
- **RingCentral integration** — live dial-out via agent's phone, with `dialling → connected → ended` phases and a "demo mode" fallback
- **Provider routing rules** — plan-prefix-based matching to a specific department's phone/email (e.g. `TK` → Pensions Servicing)
- **Draggable floating script panel** — separate from the field list
- **Two-step AI flow**: generate script before call → analyse transcript after call → modal review with checkboxes for accepting extracted fields
- **Protected fields** — manually-overridden / already-approved fields skip auto-merge
- **Palindrome STT** — transcript appears automatically after hangup when RC is configured

Let me copy the v1 to preserve it, then evolve the design to reflect the real product surface.

_[tool: copy_files]_

_[tool: github_import_files]_

_[tool: snip]_

_[tool: list_files]_

_[tool: list_files]_

_[tool: list_files]_

_[tool: copy_files]_

_[tool: snip]_

Now I'll evolve the design to reflect the real repo's product surface — the routing rules, RingCentral states, draggable script panel, and the two-step propose/merge flow.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now let me check the current state of the prototype and add the repo-specific features (RingCentral, routing rules, propose/merge):

_[tool: list_files]_

_[tool: snip]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: snip]_

Now I'll evolve the prototype to reflect the real repo. Key additions: **Routing rules card** (showing the prefix → provider matching), **RingCentral call states** (configured / not configured / dialling / live), **Two-step propose-then-merge flow** (extracted findings preview before persisting), **Stage strip** with all 10 stages, and **realistic agent phone display**.

_[tool: read_file]_

_[tool: snip]_

I notice the HTML file uses an older structure (with `.workspace`, `.dial-card`) but the components I just looked at don't quite match the CSS in `missing-data-resolution.html`. Let me verify what's actually there:

_[tool: read_file]_

_[tool: snip]_

Now let me make targeted, repo-faithful improvements. I'll add:
1. **RingCentral phone-config indicator** in the ProviderRail (showing agent phone `***4427`)
2. **Routing rule "matched from"** showing how the prefix was derived
3. **A new FieldCard variant for "Apply Findings"** that shows side-by-side propose/merge

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Updated the prototype with repo-faithful details:

- **Routing rule** now shows it was *matched from* the plan prefix (`AV-PP` → Pensions Servicing)
- **RingCentral indicator** showing the configured agent extension `***4427`
- **Realistic case data**: Eleanor Whitmore, plan `AV-PP-55021`, LOA dated 2 Apr 2026, PDF received 18 Apr — values around £127k

Use the Tweaks panel to step through the 5 phases.

## User

Verifier agent check completed

## Assistant

Quick fix:

_[tool: str_replace_edit]_

Now I should also check whether the rest of the layout matches the inline CSS. The verifier said classes like `.workspace`, `.dial-card`, `.fields-group` etc. are referenced in app.jsx but the inline CSS uses different class names (`.ws`, `.dial`, etc.). Let me check:

_[tool: grep]_

The CSS doesn't have most of the classes app.jsx references. There's a major mismatch — app.jsx was written assuming a different CSS file. Let me check if `styles.css` has them:

_[tool: grep]_

The fix is to load `styles.css` in the HTML file:

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Layout fixed — sidebar grid + workspace styles now load correctly.

## User

Verifier agent check completed

## Assistant

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Sidebar fixed — collapsed to icon-only layout to match the 64px grid track.

## User

Verifier agent check completed

## Assistant

_[tool: read_file]_

_[tool: snip]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Header rows now hold their height — stage strip and phase bar render correctly above the workspace.

## User

Verifier agent check completed

## Assistant

_[tool: read_file]_

_[tool: grep]_

_[tool: run_script]_

_[tool: snip]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Removed the stale inline stylesheet — only canonical `styles.css` rules apply now.

## User

Verifier agent check completed

## Assistant

_[tool: str_replace_edit]_

_[tool: snip]_

Got it. Let me look at your actual current design (the repo screenshots) so I can mimic that minimal aesthetic — and then I'll make the prototype fix the layout AND simplify visually in one go.

_[tool: view_image]_

_[tool: view_image]_

_[tool: local_ls]_

_[tool: local_copy_to_project]_

_[tool: view_image]_

_[tool: view_image]_

Now I see your actual design — clean white cards, **wide labelled dark-green sidebar**, generous whitespace, **simple form fields with [Enter Value] and [Call] buttons inline**, no dial donut, no dense queue cards, no routing badges. Let me rebuild minimally.

_[tool: snip]_

_[tool: write_file]_

Now let me check what helper files exist and confirm icons.jsx, data.jsx, tweaks-panel.jsx are present:

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

_[tool: snip]_

Stripped down to match your existing minimal aesthetic:

- **Wide labelled sidebar** in navy with all 9 nav items visible
- **Plain field rows** — label on left, single input, small confidence chip, [Call] button — no dial, no dense queue grid, no routing badge cards
- **5-phase tab strip** at top (Triage → AI Script → Live Call → Apply → Hand Off) — replaces the old phase pills
- **Generous whitespace**, ~1040px column, white cards with subtle borders only
- Same Furnley navy/teal palette, Inter throughout

Toggle phases via the Tweaks panel or by clicking the tabs. Let me know which screens still feel heavy and I'll lighten them further.

## User

remove the unneccessary fiel which is not available in the recent repo given

## Assistant

I'll check the current `ceding_automation` repo to see which fields actually exist in the checklist templates, then trim the prototype to match.

_[tool: local_ls]_

_[tool: local_read]_

Now I have the real Pension checklist field set. The current prototype uses fictional fields like "Selected Retirement Age", "Expression of Wishes", "Annual Management Charge", "Funds Held", "Safeguarded Benefits", "Platform Charge", "NI Number" — these don't map to the seed file. Let me replace with real fields from the **Pension** template (since the case is a Personal Pension).

I'll update `data.jsx` to use real `fieldKey` / `label` / `section` values from the seed.

_[tool: write_file]_

Now I need to update `missing-data-resolution.html` to remove references to the deleted `f6` and the now-fictional `Date of Birth` / `NI Number` rows in Phase 4 (Apply view). Let me check what's in Phase 4 currently:

_[tool: grep]_

Update the apply-view defaults to match the renamed fields:

_[tool: str_replace_edit]_

_[tool: done]_

Updated to match the real Pension checklist template in `backend/prisma/seed.ts`. Removed:

- **Annual Management Charge** → replaced with **Fund Charges (Weighted Average)**
- **Selected Retirement Age** → replaced with **Drawdown Options Available**
- **Expression of Wishes** → replaced with **Death Benefits**
- **Funds Held** (`f6`) → removed entirely (covered by the new Fund Lines table in your schema)
- **Safeguarded Benefits** → narrowed to **Guaranteed Minimum Pension (GMP)** (matches `gmp` field key)
- **Date of Birth** / **NI Number** → removed (those are client-record fields, not in the checklist template)

Sections now match seed.ts: Basic Details, Valuation, Charges, Guarantees, Benefits & Options. Owner is **Revathy S** (the default CA Team user from seed) and the routing line uses Aviva's real ceding-dept number `0800 285 1098`.

