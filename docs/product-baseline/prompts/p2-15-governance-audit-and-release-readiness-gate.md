# P2-15 — Governance, Audit and Release Readiness Gate

## Prompt Metadata

- **Prompt ID:** P2-15
- **Work Package:** WP7
- **Title:** Governance, Audit and Release Readiness Gate
- **Phase:** Founder Invite
- **Primary Track:** Track D
- **Parallelizable:** no
- **Depends On:** P2-14 VERIFIED
- **Unlocks:** G3
- **Risk Level:** high
- **Expected Review Size:** large
- **Status:** `VERIFIED` — dependency P2-14 repaired; verified on committed SHA `0fd86b561326c7895980fffb5c47c8aa6b8585c5` 2026-09-20. See Verification Evidence — 2026-09-19 (initial blocker) and Post-Repair Verification — 2026-09-20. (Previously recorded `NOT_STARTED`: stale metadata; the 2026-09-19 exact-head pass recorded `BLOCKED`.)
- **Migration:** no; forward-only, additive if used; destructive changes prohibited.

## Role

Act as the implementation owner for this bounded vertical increment. Read `../PMFREAK_PRODUCT_BASELINE_V2.md`, `../PMFREAK_FOCUSED_ASSESSMENT_P1.md`, and `../PMFREAK_SEQUENTIAL_BUILD_PLAN_P2.md` first. Preserve P0 target, P1 observed state, and ratified D1–D7. Start by recording branch, HEAD, working tree and applicable `AGENTS.md` instructions.

## Product Outcome

Release evidence reproducibly proves allow/deny/revoke/unavailable, complete audit lineage, build health and honest demo limitations.

## Current State and Evidence

- **Reusable:** scripts/check-beta-release.mjs; scripts/check-release-readiness.mjs; .github/workflows/; artifacts/; docs/.
- **Partial:** P1 proves substantial components but no complete commercial chain.
- **Conflicting:** governed `operational_decision_records` coexists with legacy recommendation, `project_decisions`, task-draft and agent decision models.
- **Missing for this increment:** Add acceptance orchestration and CI/release gate wiring only after local proof; verify jobs actually execute, audit export, cleanup and support diagnostics.
- **Candidate adapters:** prefer existing services/ports in the listed areas; inventory consumers before adding a parallel model.

## Scope

Add acceptance orchestration and CI/release gate wiring only after local proof; verify jobs actually execute, audit export, cleanup and support diagnostics. End when this outcome is behaviorally tested and independently reviewable; do not absorb downstream prompts.

## Non-Goals

No broad redesign, external provider rollout, historical-model deletion, unrelated refactor, remote decision writeback, or implementation of later WP outcomes. Documentation alone is not completion.

## Dependencies and Preconditions

Required state: P2-14 VERIFIED. Every dependency must be `VERIFIED`; a contract-based parallel start is allowed only where metadata says so. Use an isolated development database for migrations/runtime tests. D1–D7 are ratified. Any fixture must say `DEMO / FIXTURE`, conform to the verified contract, and expire when G3 becomes verified. Inspect migration ordering and overlapping working-tree changes before editing.

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
npx tsx --test tests/local-authority-bypass-hardening.test.mjs tests/aoc-session-free-governance-contract.test.mjs
npm run typecheck
npm run lint
git diff --check
```

For migration/operational-flow scope also run `npm run check:operational-flow-db` against isolated infrastructure. For AOC scope run `npm run check:aoc-boundaries && npm run check:no-local-auth-bypass`. For UI/high-risk integration run `npm run build` and the repository browser/runtime scenario added by this prompt. Expected result: the Product Outcome is observable, negative/degraded cases pass, no unrelated regression occurs, and evidence is attached. Do not mark `VERIFIED` if an applicable command is skipped.

## Files Expected to Change

Expected areas: `scripts/check-beta-release.mjs; scripts/check-release-readiness.mjs; .github/workflows/; artifacts/; docs/`. Tests and narrowly scoped docs may change. Adjust paths only when better repository evidence is found and justify every deviation. Migration files, if needed, must be new and forward-only.

## Prohibited Changes

Do not enable remote writeback; delete/fuse legacy models; bypass AOC or membership/RLS; use zero/placeholder hashes; insert Evidence directly where Raw/Event is required; auto-create downstream canonical states; treat Task completion as Outcome; show fixtures as live; hardcode success; weaken tenant isolation; run destructive migration; redesign unrelated UI; or modify unrelated CI/dependencies.

## Verification Evidence — 2026-09-19

Exact-head reconciliation run. Status earlier in this file was historical/stale metadata; it is superseded here, not rewritten.

- **SHA:** `95c928b2ceb8f0f40465965c751ef9c3230a1d8c` (`origin/main`, merge of #613), plus the P2-14 spec reconciliation recorded under P2-14.
- **Environment:** native Linux scratch clone at that SHA; Node v22.23.1 / npm 10.9.8 (`npm ci`); local Supabase `127.0.0.1:54321`/`54322`, 165/165 migrations through `20260911000000`; Frontera `@aoc-enterprise/runtime` 1.2.1 on a disposable OS-temp SQLite store.

- **Result:** `BLOCKED`. The dependency P2-14 is `BLOCKED` (through P2-12 / P2-10, and `D1-INVITE-ACCEPT-LAYOUT-RACE`). P2-15's own release gates are green.
- `npx tsx --test tests/local-authority-bypass-hardening.test.mjs tests/aoc-session-free-governance-contract.test.mjs` — 28/28 pass. `tests/p2-15-governance-release-gate.test.ts` — 13/13 pass.
- Release and governance gates, each PASS:
  - `npm run check:governance` (full chain, including `check:frontera-consumer` `FRONTERA_PRODUCT_RUNTIME_CONSUMPTION=PASS`, package purity, release readiness and CI workflow integrity);
  - `check:aoc-boundaries`;
  - `check:no-local-auth-bypass`;
  - `check:security-definer-hardening` (30 functions match the grant matrix, `search_path` pinned);
  - `check:release-readiness`;
  - `compliance:check` (734 packages semantically current; 18/18);
  - `check:fresh-db-migrations` — 165/165 applied from empty on an independent disposable Postgres, 433 tables, 1 pre-existing table without RLS.
- `npm run check:beta-release`, with CI-equivalent env and a freshly seeded P2-13 scenario — **CONDITIONAL GO**:
  - every blocking gate PASS, including the P0-LAUNCH-06 rehearsal;
  - Dependency Security is WARN (`severity: "advisory"`).
- CI: Release Governance run `35460821040` executed on this SHA. Beta Release Validation succeeded, 13 steps, with the same CONDITIONAL GO shape.
- `npm run typecheck` — PASS. `npm run lint` — 0 errors / 643 warnings. `npm test` — 14,432 pass / 0 fail / 23 skipped, plus module mocks 18/18. `npm run build` — PASS, 415 pages.
- **Residuals:**
  - `check:dependency-security` reports 3 unexpected advisories with no residual-risk entry: `next` critical (fix 16.3.5, non-major), `sharp` high, `js-yaml` high. This is advisory per the gate, but needs a separate dependency PR.
  - The P0-LAUNCH-06 D1 check is intermittently exposed to `D1-INVITE-ACCEPT-LAYOUT-RACE` (see P2-14).

## Exact-head post-repair verification — 2026-09-20

**Verified executable candidate SHA: `0fd86b561326c7895980fffb5c47c8aa6b8585c5` (C4).**

Chronology, so the record is not read backwards: `95c928b2` is the exact-main baseline on which the blockers were discovered and reproduced — never a SHA carrying the repairs. C1–C3 are the Founder/G2/G3 repair candidate. Exact-head validation of that candidate then surfaced a *pre-existing* governance defect (a revoked Material Action could still be dispatched into a Task and could still start), which reproduces identically at `95c928b2`; C4 repairs it and is the SHA every result in this section was verified on.

The dependency blocker recorded above was repaired under explicit authorization (see P2-14). P2-15 itself needed no product change.

Verified on committed SHA `0fd86b561326c7895980fffb5c47c8aa6b8585c5` (C4 = C1+C2+C3+C4), checked out clean with none of this reconciliation's documentation edits present. Same local environment as the 2026-09-19 pass: Node v22.23.1 / npm 10.9.8, local Supabase `127.0.0.1:54321`/`54322` at migration head `20260911000000` (165/165, unchanged — no migration was added), Frontera `@aoc-enterprise/runtime` 1.2.1 on a fresh disposable OS-temp store.

- **A third defect was found by this validation and repaired in C4, not deferred.** Exact-head validation of the C1–C3 candidate showed that governance precedence at both canonical execution boundaries was decided by `evaluated_at`, a descriptive timestamp supplied by the writer, so a committed and visible revocation could be masked by an authorization that merely sorted newer: a revoked Material Action could still be dispatched into a canonical Task (with a genuine Frontera ALLOW minted), and a revoked queued execution could still start. It reproduces identically at `95c928b2`, so it is pre-existing and independent of the Founder Invite work. C4 makes revocation terminal at both boundaries — asserted by existence, never by recency — with the live verifiers now recording a revocation timestamped OLDER than the authorization it revokes and proving it still wins (P2-07 267 assertions, P2-08 176; 10/10 forced inversions and 10/10 ordinary flows at each boundary). Forward migration replacing two function bodies; no table, column, index, trigger, RLS or grant change.
- **Release and governance gates, all PASS:** `check:governance` (full chain), `check:aoc-boundaries`, `check:no-local-auth-bypass`, `check:frontera-consumer`, `check:security-definer-hardening` (30 functions), `check:release-readiness`, `compliance:check`, and `check:fresh-db-migrations` — 165/165 migrations applied from empty on an independent disposable Postgres, 433 tables, 1 pre-existing table without RLS. The migration count is unchanged: neither repair added one.
- **`npm run check:beta-release`: CONDITIONAL GO.** Every blocking gate passes, including the P0-LAUNCH-06 rehearsal under its now-stricter D1 contract. Dependency Security is WARN (`severity: "advisory"`).
- **Static battery:** typecheck PASS; lint 0 errors / 643 warnings (baseline restored — the repair removed the dead binding it would otherwise have added); `npm test` 14,466 tests, 14,443 pass, 0 fail, 23 skipped, plus module mocks 18/18; build PASS, 415 pages.
- **Residual, unchanged and out of scope for this repair:** `check:dependency-security` reports 3 unexpected advisories with no residual-risk entry — `next` critical (fix 16.3.5, non-major), `sharp` high, `js-yaml` high. No package file was modified in this branch; this remains a separate dependency increment.
- **Post-repair status:** `VERIFIED` on `0fd86b561326c7895980fffb5c47c8aa6b8585c5`.

## Required Delivery Report

Report status (`VERIFIED` only with all evidence), summary, files changed, migrations, contracts added/changed, exact tests/results, acceptance evidence/screenshots where applicable, deviations, known limitations, unlocked prompt, rollback/recovery instructions, compatibility/fixture expiry, and confirmation of no unrelated changes. Include branch/commit, diff summary and `git diff --check`.

## Stop Conditions

Stop as `BLOCKED` if a dependency is not `VERIFIED`; a non-ratified human decision or unavailable credential/infrastructure is required; migrations conflict; working-tree changes overlap; authorization would need weakening; canonical AOC contract cannot be determined; existing tests contradict P0 without authority; or scope exceeds this prompt. Use `IMPLEMENTED_NOT_VERIFIED` only when code exists but an acceptance command/environment remains incomplete; never continue a dependent prompt from that state.
