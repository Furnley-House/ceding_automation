# Known issues

Live list of issues we know about but haven't fixed yet. Items stay here until
they're closed or bundled into a sprint task. Newer at the top.

---

## KI-01 — Frontend type coverage: read paths noisy, write paths unchecked

**Filed:** 2026-09-07
**Owner:** unassigned
**Severity:** Medium — no live incident traces here yet, but this gap is what
let the H33-PR3 silent Edit no-op reach a runtime failure (third
missing-coverage bug in two days: the Edit no-op, the requireCaseAccess
:caseId precedence, and this).

### The gap

`npx tsc -b --noEmit` in `frontend/` reports **53 errors** across 7 files:

| File | Count | Path |
|---|---|---|
| `pages/Cases.tsx` | 16 | read + display |
| `pages/CaseDetail.tsx` | 16 | read + display |
| `components/layout/AppHeader.tsx` | 11 | read only |
| `pages/AuditTrail.tsx` | 6 | read only (useQuery generics) |
| `pages/ProviderDirectory.tsx` | 2 | cosmetic (Lucide `title` prop) |
| `lib/exportTemplate.ts` | 1 | write (Buffer→Uint8Array nominal cast) |
| `components/case/ExportWorkspace.tsx` | 1 | downstream of exportTemplate |

By error class: 25× TS2322, 14× TS2339, 5× TS2345, 4× TS2769, 4× TS2538,
1× TS2352.

### Root cause

`frontend/src/services/api.ts` transforms (`snakeKeys`, `flattenCase`) return
`Record<string, unknown>[]` because the runtime transform is dynamic. Every
downstream caller then hits `TS2339: property does not exist on unknown` when
accessing `.case_ref`, `.client_name`, etc., or `TS2322: unknown is not
assignable to ReactNode` when rendering.

### Why write paths look clean but aren't

Every mutation wrapper in `frontend/src/lib/api.ts` returns
`Promise<AxiosResponse<any>>` — no response type parameter. That means:

- `casesApi.updateStatus`, `checklistApi.updateField`,
  `contributionsApi.addManualTransaction`, and every other write returns
  `any` from `.data`.
- tsc **cannot** emit an error even if the response shape is wrong or the
  caller misuses the result — the type is fully erased.
- Effective type coverage on the paths that mutate client financial data
  is zero. Silent-failure bugs like the Edit no-op slip through because
  strict typing on `updateField` would have surfaced the missing
  return-value handling.

The 53 visible errors are read-path display. The unmeasurable-but-real
number on the write side is the load-bearing risk.

### Fix direction

1. Parameterise the axios wrappers by response type — e.g.
   `api.get<CaseResponse>` / `api.post<UpdateResult>` — so `.data` carries
   a real type through every consumer.
2. Type the `services/api.ts` transform outputs as `CaseRow[]` (the
   interface already exists at `lib/caseHelpers.ts`) rather than
   `Record<string, unknown>[]`. That clears most of the 53 read-path
   errors as a side effect.
3. Once the wrappers are typed, tighten `tsconfig.app.json` (`strict:
   true`, `strictNullChecks: true`) — the loose settings that hid this
   should not persist into Phase 2.

### Notes for whoever picks this up

- Vite's build uses SWC, not tsc — these errors do not block
  `npm run build` and have never failed a deploy. That's why they've
  accumulated. Any CI-gate work on this needs an explicit
  `npm run typecheck` step.
- Test the mutation-side coverage improvement by intentionally breaking a
  `checklistApi.updateField` call site and confirming tsc catches it.
  Read-path errors are easy to see; write-path silence is the point.
