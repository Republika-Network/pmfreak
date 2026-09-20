# P2-12 — PM Execution Center Action-to-Outcome and Accessibility Gate

## Prompt Metadata

- **Prompt ID:** P2-12
- **Work Package:** WP6
- **Title:** PM Execution Center Action-to-Outcome and Accessibility Gate
- **Phase:** Founder Invite
- **Primary Track:** Track C
- **Parallelizable:** no
- **Depends On:** P2-08, P2-10, P2-11 VERIFIED
- **Unlocks:** P2-13, G3
- **Risk Level:** high
- **Expected Review Size:** large
- **Status:** `VERIFIED` — dependency P2-10 repaired; verified on committed SHA `0fd86b561326c7895980fffb5c47c8aa6b8585c5` 2026-09-20. See Verification Evidence — 2026-09-19 (initial blocker) and Post-Repair Verification — 2026-09-20. (Previously recorded `NOT_STARTED`: stale metadata; the 2026-09-19 exact-head pass recorded `BLOCKED`.)
- **Migration:** no; forward-only, additive if used; destructive changes prohibited.

## Role

Act as the implementation owner for this bounded vertical increment. Read `../PMFREAK_PRODUCT_BASELINE_V2.md`, `../PMFREAK_FOCUSED_ASSESSMENT_P1.md`, and `../PMFREAK_SEQUENTIAL_BUILD_PLAN_P2.md` first. Preserve P0 target, P1 observed state, and ratified D1–D7. Start by recording branch, HEAD, working tree and applicable `AGENTS.md` instructions.

## Product Outcome

An authenticated PM completes attention→decision→governed action→task→outcome in one accessible project experience with complete lineage and denied/degraded states.

## Current State and Evidence

- **Reusable:** src/app/(protected)/command-center/; src/components/pmfreak/intelligence-inbox/; src/components/pmfreak/operational-shell.tsx; tests/.
- **Partial:** P1 proves substantial components but no complete commercial chain.
- **Conflicting:** governed `operational_decision_records` coexists with legacy recommendation, `project_decisions`, task-draft and agent decision models.
- **Missing for this increment:** Integrate only real P2-06/08/10 contracts, remove/expire fixtures, consolidate duplicate surfaces, accessibility/responsive/no-layout regression and browser evidence.
- **Candidate adapters:** prefer existing services/ports in the listed areas; inventory consumers before adding a parallel model.

## Scope

Integrate only real P2-06/08/10 contracts, remove/expire fixtures, consolidate duplicate surfaces, accessibility/responsive/no-layout regression and browser evidence. End when this outcome is behaviorally tested and independently reviewable; do not absorb downstream prompts.

## Non-Goals

No broad redesign, external provider rollout, historical-model deletion, unrelated refactor, remote decision writeback, or implementation of later WP outcomes. Documentation alone is not completion.

## Dependencies and Preconditions

Required state: P2-08, P2-10, P2-11 VERIFIED. Every dependency must be `VERIFIED`; a contract-based parallel start is allowed only where metadata says so. Use an isolated development database for migrations/runtime tests. D1–D7 are ratified. Any fixture must say `DEMO / FIXTURE`, conform to the verified contract, and expire when P2-13, G3 becomes verified. Inspect migration ordering and overlapping working-tree changes before editing.

## Canonical Contracts and Invariants

Source ≠ Raw Input ≠ Normalized Event ≠ Evidence; Finding ≠ Recommendation; Recommendation ≠ Decision; Decision ≠ Action; Action ≠ Task; Task completion ≠ Outcome achievement; business authority ≠ AOC policy decision; inference ≠ fact; Command Center is an experience/read model, not a hierarchy entity; tenant/workspace/project boundaries are explicit. Preserve stable IDs, explicit actor/evaluation timestamps, evidence references, lifecycle transitions and authority boundaries. Remote `allowDecisionWriteback` remains `false`.

## Implementation Requirements

1. Implement the scoped observable transition using preserve → connect → adapt → repair priority.
2. Reuse the cited components; add a compatibility adapter before any duplicate aggregate.
3. Make state transitions explicit, idempotent where retryable, and durable where material.
4. Carry `evaluatedAt`/occurred/recorded times, correlation and causation, provenance, confidence/missing data where applicable.
5. Inventory affected consumers and maintain compatibility; any migration is additive and RLS-aware.
6. Ensure fixtures cannot be returned or rendered as live data.

## Frontend / API / Domain / Data Implications

- **Frontend:** change only if required by outcome; consume verified contract; show loading/empty/error/denied/degraded and fixture label.
- **API:** server-validated scoped commands/queries; no composite command collapsing canonical transitions.
- **Domain:** contract/lifecycle change required only inside scope; retained models remain bounded.
- **Data:** migration `no`; no destructive operation or silent dual-write. If temporary compatibility read/write is necessary, document owner, expiry prompt and reconciliation.
- **Compatibility:** future consumers use canonical references; legacy reads remain until safety gate proves replacement.

## AOC Boundary

AOC-P owns portable integrity/identity/capability primitives; AOC-E owns policy, authority, obligations, grants, delegation and revocation. PMFreak owns PM business objects. Use AOC-E in-process for Founder Invite when governance is applicable; remote mode is unavailable/advisory and must not write decisions. Persist only AOC reference/status/evidence projections. Fail closed for material actions and show unavailable/stale explicitly.

## Authorization, Tenancy and Security Requirements

Resolve server-side identity; verify Workspace membership, Project relationship and required role/authority; prevent IDOR by scoping every read/write; preserve RLS. Service role is allowed only via registered, justified narrow operations and never as user authorization. Add same-tenant positive and cross-tenant negative behavior tests. Attribute agent actions to verified agent and human/policy checkpoint when applicable.

## Events, Evidence and Audit Requirements

Emit/version domain event(s) with actor, tenant/workspace/project, occurred/recorded timestamps, correlation ID, causation ID, canonical and source references, material before/after state and applicable AOC policy/grant reference. Preserve Evidence/provenance and audit corrections; redact secrets, tokens, raw provider errors and restricted cross-tenant content.

## Error, Denied and Degraded States

Handle applicable validation, unauthenticated, forbidden/IDOR, stale context, missing evidence, unsupported legacy path, duplicate retry, partial persistence and provider failure. For governance paths also cover AOC denied, revoked, stale and unavailable. Never optimistically report success; make recovery/retry safe and visible.

## Testing Requirements

Add unit/domain and contract tests plus integration behavior for persistence and critical transition. Include authorization/tenancy negative, idempotency/retry, degraded/error and regression tests for reused components. UI scope requires component/browser coverage and accessibility. Source scanning may supplement but cannot be the only proof. Migration scope requires isolated DB/RLS verification.

## Acceptance Gates and Commands

Run, at minimum:

```bash
npx tsx --test tests/operational-flow-contract.test.mjs tests/operational-command-center.test.ts
npm run typecheck
npm run lint
git diff --check
```

For migration/operational-flow scope also run `npm run check:operational-flow-db` against isolated infrastructure. For AOC scope run `npm run check:aoc-boundaries && npm run check:no-local-auth-bypass`. For UI/high-risk integration run `npm run build` and the repository browser/runtime scenario added by this prompt. Expected result: the Product Outcome is observable, negative/degraded cases pass, no unrelated regression occurs, and evidence is attached. Do not mark `VERIFIED` if an applicable command is skipped.

## Files Expected to Change

Expected areas: `src/app/(protected)/command-center/; src/components/pmfreak/intelligence-inbox/; src/components/pmfreak/operational-shell.tsx; tests/`. Tests and narrowly scoped docs may change. Adjust paths only when better repository evidence is found and justify every deviation. Migration files, if needed, must be new and forward-only.

## Prohibited Changes

Do not enable remote writeback; delete/fuse legacy models; bypass AOC or membership/RLS; use zero/placeholder hashes; insert Evidence directly where Raw/Event is required; auto-create downstream canonical states; treat Task completion as Outcome; show fixtures as live; hardcode success; weaken tenant isolation; run destructive migration; redesign unrelated UI; or modify unrelated CI/dependencies.

## Verification Evidence — 2026-09-19

Exact-head reconciliation run. Status earlier in this file was historical/stale metadata; it is superseded here, not rewritten.

- **SHA:** `95c928b2ceb8f0f40465965c751ef9c3230a1d8c` (`origin/main`, merge of #613), plus the P2-14 spec reconciliation recorded under P2-14.
- **Environment:** native Linux scratch clone at that SHA; Node v22.23.1 / npm 10.9.8 (`npm ci`); local Supabase `127.0.0.1:54321`/`54322`, 165/165 migrations through `20260911000000`; Frontera `@aoc-enterprise/runtime` 1.2.1 on a disposable OS-temp SQLite store.

- **Result:** `BLOCKED`. The dependency P2-10 is `BLOCKED` (`P2-10-LINEAGE-FINDING-UNRESOLVED`). P2-12's product outcome includes complete lineage, which the live projection does not yet provide for canonical chains.
- `npx tsx --test tests/operational-flow-contract.test.mjs tests/operational-command-center.test.ts` — 205/205 pass.
- `tests/p2-12-pm-execution-center-action-to-outcome.test.mjs` — 95/95 pass.
- Browser, real Chromium (P2-14 STEP_11–STEP_16c, 38/38, run twice):
  - governed Action, real AOC-E plus Frontera ALLOW;
  - exactly one Task under retry;
  - internal execution lifecycle;
  - Task completion ≠ Outcome;
  - evidence-backed Observation;
  - the journey card shows the result, why, and no fabricated next step.
- Accessibility: keyboard reach and focus, no duplicate ids, drawer accessible close. Responsive: 390, 768 and 1440 px with no horizontal overflow.
- `npm run typecheck` — PASS. `npm run lint` — 0 errors. `npm run build` — PASS.
- **Residuals:** as P2-10, plus the non-blocking dev-mode navigation hydration mismatch noted under P2-11.

## Exact-head post-repair verification — 2026-09-20

**Verified executable candidate SHA: `0fd86b561326c7895980fffb5c47c8aa6b8585c5` (C4).**

Chronology, so the record is not read backwards: `95c928b2` is the exact-main baseline on which the blockers were discovered and reproduced — never a SHA carrying the repairs. C1–C3 are the Founder/G2/G3 repair candidate. Exact-head validation of that candidate then surfaced a *pre-existing* governance defect (a revoked Material Action could still be dispatched into a Task and could still start), which reproduces identically at `95c928b2`; C4 repairs it and is the SHA every result in this section was verified on.

The dependency blocker recorded above was repaired under explicit authorization (see P2-10). P2-12 itself needed no product change.

Verified on committed SHA `0fd86b561326c7895980fffb5c47c8aa6b8585c5` (C4 = C1+C2+C3+C4), checked out clean with none of this reconciliation's documentation edits present. Same local environment as the 2026-09-19 pass: Node v22.23.1 / npm 10.9.8, local Supabase `127.0.0.1:54321`/`54322` at migration head `20260911000000` (165/165, unchanged — no migration was added), Frontera `@aoc-enterprise/runtime` 1.2.1 on a fresh disposable OS-temp store.

- **Automated:** `tests/p2-12-pm-execution-center-action-to-outcome.test.mjs` 95/95; focused P2-11/P2-12 command 205/205.
- **Browser, real Chromium:** the P2-14 journey passed 38/38 on the exact candidate SHA, covering STEP_11 through STEP_16c — governed Action with real AOC-E and Frontera authorization, exactly one Task under retry, the internal execution lifecycle, Task completion ≠ Outcome, an evidence-backed Observation, and the journey card showing result, why and no fabricated next step.
- **Complete lineage**, the property that was blocked, is now proven live end to end: `completeLineageCount: 1`, `gaps: []`, with the Finding resolved.
- Accessibility and responsive coverage (390 / 768 / 1440 px) unchanged and passing.
- **Post-repair status:** `VERIFIED` on `0fd86b561326c7895980fffb5c47c8aa6b8585c5`.

## Required Delivery Report

Report status (`VERIFIED` only with all evidence), summary, files changed, migrations, contracts added/changed, exact tests/results, acceptance evidence/screenshots where applicable, deviations, known limitations, unlocked prompt, rollback/recovery instructions, compatibility/fixture expiry, and confirmation of no unrelated changes. Include branch/commit, diff summary and `git diff --check`.

## Stop Conditions

Stop as `BLOCKED` if a dependency is not `VERIFIED`; a non-ratified human decision or unavailable credential/infrastructure is required; migrations conflict; working-tree changes overlap; authorization would need weakening; canonical AOC contract cannot be determined; existing tests contradict P0 without authority; or scope exceeds this prompt. Use `IMPLEMENTED_NOT_VERIFIED` only when code exists but an acceptance command/environment remains incomplete; never continue a dependent prompt from that state.
