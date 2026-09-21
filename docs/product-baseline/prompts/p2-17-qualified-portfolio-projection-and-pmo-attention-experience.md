# P2-17 — Qualified Portfolio Projection and PMO Attention Experience

## Prompt Metadata

- **Prompt ID:** P2-17
- **Work Package:** WP9
- **Title:** Qualified Portfolio Projection and PMO Attention Experience
- **Phase:** PMO Pilot
- **Primary Track:** Track A/C
- **Parallelizable:** no
- **Depends On:** P2-16 VERIFIED; G3 recommended
- **Unlocks:** G4
- **Risk Level:** high
- **Expected Review Size:** large
- **Status:** `NOT_STARTED`
- **Migration:** possible additive; forward-only, additive if used; destructive changes prohibited.

## Role

Act as the implementation owner for this bounded vertical increment. Read `../PMFREAK_PRODUCT_BASELINE_V2.md`, `../PMFREAK_FOCUSED_ASSESSMENT_P1.md`, and `../PMFREAK_SEQUENTIAL_BUILD_PLAN_P2.md` first. Preserve P0 target, P1 observed state, and ratified D1–D7. Start by recording branch, HEAD, working tree and applicable `AGENTS.md` instructions.

## Product Outcome

A PMO sees comparable deterioration, cross-project dependencies and supported conflicts with coverage/confidence and access-safe drill-down.

## Current State and Evidence

- **Reusable:** src/app/api/portfolio/; src/app/api/personal-portfolio/; src/app/(protected)/pmo-command-center/; src/app/(protected)/portfolio/; tests/personal-portfolio.test.mjs.
- **Partial:** P1 proves substantial components but no complete commercial chain.
- **Conflicting:** governed `operational_decision_records` coexists with legacy recommendation, `project_decisions`, task-draft and agent decision models.
- **Missing for this increment:** Project canonical spine into portfolio with evaluatedAt/membership snapshot/coverage; remove caller-trusted metrics; only claim resource conflicts when supported; UI and tenant negatives.
- **Candidate adapters:** prefer existing services/ports in the listed areas; inventory consumers before adding a parallel model.

## Scope

Project canonical spine into portfolio with evaluatedAt/membership snapshot/coverage; remove caller-trusted metrics; only claim resource conflicts when supported; UI and tenant negatives. End when this outcome is behaviorally tested and independently reviewable; do not absorb downstream prompts.

## Non-Goals

No broad redesign, external provider rollout, historical-model deletion, unrelated refactor, remote decision writeback, or implementation of later WP outcomes. Documentation alone is not completion.

## Dependencies and Preconditions

Required state: P2-16 VERIFIED; G3 recommended. Every dependency must be `VERIFIED`; a contract-based parallel start is allowed only where metadata says so. Use an isolated development database for migrations/runtime tests. D1–D7 are ratified. Any fixture must say `DEMO / FIXTURE`, conform to the verified contract, and expire when G4 becomes verified. Inspect migration ordering and overlapping working-tree changes before editing.

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
- **Data:** migration `possible additive`; no destructive operation or silent dual-write. If temporary compatibility read/write is necessary, document owner, expiry prompt and reconciliation.
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
npx tsx --test tests/personal-portfolio.test.mjs tests/command-center-portfolio-availability.test.mjs
npm run typecheck
npm run lint
git diff --check
```

For migration/operational-flow scope also run `npm run check:operational-flow-db` against isolated infrastructure. For AOC scope run `npm run check:aoc-boundaries && npm run check:no-local-auth-bypass`. For UI/high-risk integration run `npm run build` and the repository browser/runtime scenario added by this prompt. Expected result: the Product Outcome is observable, negative/degraded cases pass, no unrelated regression occurs, and evidence is attached. Do not mark `VERIFIED` if an applicable command is skipped.

## Files Expected to Change

Expected areas: `src/app/api/portfolio/; src/app/api/personal-portfolio/; src/app/(protected)/pmo-command-center/; src/app/(protected)/portfolio/; tests/personal-portfolio.test.mjs`. Tests and narrowly scoped docs may change. Adjust paths only when better repository evidence is found and justify every deviation. Migration files, if needed, must be new and forward-only.

## Prohibited Changes

Do not enable remote writeback; delete/fuse legacy models; bypass AOC or membership/RLS; use zero/placeholder hashes; insert Evidence directly where Raw/Event is required; auto-create downstream canonical states; treat Task completion as Outcome; show fixtures as live; hardcode success; weaken tenant isolation; run destructive migration; redesign unrelated UI; or modify unrelated CI/dependencies.

## Verification Evidence — 2026-09-21

The `NOT_STARTED` status in the metadata above is the planning-time value; it is superseded here, not rewritten.

- **Baseline:** `build/p2-17-qualified-portfolio` on `705b35192d16f90876cadac925c8a5b624d85a3c` (`main` after P2-16 and its SHA map).
- **Executable verification SHA:** `9b9f689ec72dfd5dc2ab7b98b3ee9bc4dfd7f4d5` (`feat(p2): implement p2-17 qualified portfolio attention`). The battery below ran on the identical uncommitted tree; the commit adds only the `/artifacts/p2-17/` ignore line.
- **Environment:** native Linux execution clone; local Supabase `127.0.0.1:54321`/`54322` at 167/167 migrations; app `http://localhost:3000`. The `OPERATIONAL_FLOW_TEST_*` target was derived process-locally from the local env file; no hosted project was touched.
- **Projection:** `GET /api/pmos/{pmoId}/attention?workspaceId=…` (contract `pmfreak/pmo-portfolio-attention:v1`, rules `pmo-attention-rules:v1`) rebuilds attention from canonical rows on the caller's RLS client, filtered to the PMO's own projects. Each reason is one canonical fact placed by a published rule; projects are ordered lexicographically, with no composite score. Coverage and confidence are separate; missing inputs are reported, never read as health; a schedule exposure evaluated against a changed schedule is superseded. Missing PMO, foreign PMO and mismatched workspace claim return one indistinguishable 404.
- **Caller metrics retired:** `POST /api/personal-portfolio/{snapshot,prioritize,attention,neglect,command-center}` return 401 unauthenticated, else 410 `caller_metrics_not_accepted` before the body is read. Earlier snapshots stay readable as `caller_supplied_unverified`.
- **Migration:** none.
- **Results:** gate tests (`personal-portfolio`, `command-center-portfolio-availability`) plus P2-17 behavioural and UI 207/207; caller-metrics module-mock 1/1; `check:operational-flow-db` ok (22 checks); `check:aoc-boundaries` and `check:no-local-auth-bypass` PASS; typecheck 0; lint 0 errors / 642 warnings (none in P2-17 files); build exit 0; `npm test` 14,522 pass / 0 fail / 23 skipped plus module mocks 19/19; `git diff --check` clean (Linux `git` and `git.exe`); Chromium P2-17 scenario 9/9 steps in three consecutive runs (real sign-in, real signals, qualified attention, drill-down, superseded exposure, forged metrics ignored, tenancy refusals, accessibility, 390/768/1440 px). Screenshots are regenerated under the ignored `artifacts/p2-17/screenshots/`.
- **Not run (not applicable):** `check:fresh-db-migrations` and `check:security-definer-hardening` (no migration); the P2-14 Chromium journey (not a P2-17 gate).
- **Known limitations:** `/api/pmos` and `/api/projects` log pre-existing `project_scope_violation` security events for project-scoped capability checks made without a project; none carries the attention route id, which authenticates and reads through RLS without that check. The protected layout nests the page's own `<main>` inside its `<main>` (pre-existing landmark debt). Cross-project dependencies and resource conflicts are reported as unsupported/unavailable. The Playwright config still writes its report under `artifacts/p2-14/`; this is evidence-path debt only.
- **Gate:** G4 is technically unlocked by P2-16 + P2-17 and is **not** yet VERIFIED.

## Required Delivery Report

Report status (`VERIFIED` only with all evidence), summary, files changed, migrations, contracts added/changed, exact tests/results, acceptance evidence/screenshots where applicable, deviations, known limitations, unlocked prompt, rollback/recovery instructions, compatibility/fixture expiry, and confirmation of no unrelated changes. Include branch/commit, diff summary and `git diff --check`.

## Stop Conditions

Stop as `BLOCKED` if a dependency is not `VERIFIED`; a non-ratified human decision or unavailable credential/infrastructure is required; migrations conflict; working-tree changes overlap; authorization would need weakening; canonical AOC contract cannot be determined; existing tests contradict P0 without authority; or scope exceeds this prompt. Use `IMPLEMENTED_NOT_VERIFIED` only when code exists but an acceptance command/environment remains incomplete; never continue a dependent prompt from that state.
