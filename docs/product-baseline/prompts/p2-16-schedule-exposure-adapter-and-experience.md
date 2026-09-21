# P2-16 — Schedule Exposure Adapter and Experience

## Prompt Metadata

- **Prompt ID:** P2-16
- **Work Package:** WP8
- **Title:** Schedule Exposure Adapter and Experience
- **Phase:** PMO Pilot
- **Primary Track:** Track A/C
- **Parallelizable:** yes after P2-04
- **Depends On:** G1 and P2-04 VERIFIED
- **Unlocks:** P2-17, G4
- **Risk Level:** high
- **Expected Review Size:** large
- **Status:** `NOT_STARTED`
- **Migration:** possible additive; forward-only, additive if used; destructive changes prohibited.

## Role

Act as the implementation owner for this bounded vertical increment. Read `../PMFREAK_PRODUCT_BASELINE_V2.md`, `../PMFREAK_FOCUSED_ASSESSMENT_P1.md`, and `../PMFREAK_SEQUENTIAL_BUILD_PLAN_P2.md` first. Preserve P0 target, P1 observed state, and ratified D1–D7. Start by recording branch, HEAD, working tree and applicable `AGENTS.md` instructions.

## Product Outcome

A typed dependency or milestone change produces a deterministic snapshot-bound Finding and governed Recommendation with confidence/missing data, visible to the PM.

## Current State and Evidence

- **Reusable:** src/lib/critical-path/; src/app/api/critical-path/; src/app/api/execution-task-dependencies/; src/components/pmfreak/operational-shell.tsx; tests/.
- **Partial:** P1 proves substantial components but no complete commercial chain.
- **Conflicting:** governed `operational_decision_records` coexists with legacy recommendation, `project_decisions`, task-draft and agent decision models.
- **Missing for this increment:** Adapt H7–H9 evaluation context and snapshots into canonical evidence/finding/recommendation; invalid topology degrades; no engine rewrite.
- **Candidate adapters:** prefer existing services/ports in the listed areas; inventory consumers before adding a parallel model.

## Scope

Adapt H7–H9 evaluation context and snapshots into canonical evidence/finding/recommendation; invalid topology degrades; no engine rewrite. End when this outcome is behaviorally tested and independently reviewable; do not absorb downstream prompts.

## Non-Goals

No broad redesign, external provider rollout, historical-model deletion, unrelated refactor, remote decision writeback, or implementation of later WP outcomes. Documentation alone is not completion.

## Dependencies and Preconditions

Required state: G1 and P2-04 VERIFIED. Every dependency must be `VERIFIED`; a contract-based parallel start is allowed only where metadata says so. Use an isolated development database for migrations/runtime tests. D1–D7 are ratified. Any fixture must say `DEMO / FIXTURE`, conform to the verified contract, and expire when P2-17, G4 becomes verified. Inspect migration ordering and overlapping working-tree changes before editing.

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
npx tsx --test tests/critical-path.test.mjs tests/critical-path-intelligence.test.mjs tests/critical-path-materialize-write-authorization.test.mjs
npm run typecheck
npm run lint
git diff --check
```

For migration/operational-flow scope also run `npm run check:operational-flow-db` against isolated infrastructure. For AOC scope run `npm run check:aoc-boundaries && npm run check:no-local-auth-bypass`. For UI/high-risk integration run `npm run build` and the repository browser/runtime scenario added by this prompt. Expected result: the Product Outcome is observable, negative/degraded cases pass, no unrelated regression occurs, and evidence is attached. Do not mark `VERIFIED` if an applicable command is skipped.

## Files Expected to Change

Expected areas: `src/lib/critical-path/; src/app/api/critical-path/; src/app/api/execution-task-dependencies/; src/components/pmfreak/operational-shell.tsx; tests/`. Tests and narrowly scoped docs may change. Adjust paths only when better repository evidence is found and justify every deviation. Migration files, if needed, must be new and forward-only.

## Prohibited Changes

Do not enable remote writeback; delete/fuse legacy models; bypass AOC or membership/RLS; use zero/placeholder hashes; insert Evidence directly where Raw/Event is required; auto-create downstream canonical states; treat Task completion as Outcome; show fixtures as live; hardcode success; weaken tenant isolation; run destructive migration; redesign unrelated UI; or modify unrelated CI/dependencies.

## Verification Evidence — 2026-09-20

The `NOT_STARTED` status in the metadata above is the planning-time value; it is superseded here, not rewritten.

- **Baseline:** `build/p2-16-schedule-exposure` on `d1f6fc160306ee7ebfaab3353e973c0d940e7e03` (post-#614 `main` plus one documentation-only SHA-map commit, accepted as baseline).
- **Committed executable verification SHA:** `b602363ec5f3536a16fdfc1a6368ffd004b8f027` (`feat(p2): implement p2-16 schedule exposure`). The full battery below was run on the identical uncommitted candidate tree; the exact-head proof further down was run on a clean checkout of this SHA.
- **Environment:** native Linux execution clone synced from the authoritative Windows worktree; Node v22.23.1 / npm 10.9.8; local Supabase `127.0.0.1:54321`/`54322` at 167/167 migrations; Frontera on a disposable OS-temp store.
- **Adapter:** a typed H7/H8 change (`dependency_change` or `milestone_date_change`, resolved from persisted rows only) is evaluated by the UNCHANGED H9 engine (`validateGraph → forwardPass → backwardPass → computeFloat → computeCriticalPath → computeCriticalMilestones`) over a content-addressed snapshot (`schedule-snapshot:v1`, no clock), then recorded as Raw Input → `schedule_exposure.evaluated` v1 Normalized Event → `INFERENCE`/`RISK` Evidence → `schedule_risk` Finding → governed `proposed` Recommendation (`source_signal_id`). No Decision, Action, Task, Outcome or Observation is created.
- **Migration (additive, forward-only):** `20260913000000_p2_16_schedule_exposure_adapter.sql` — `source_kind` gains `engine` (pinned both ways to the `schedule-engine:` key namespace), `evidence_items.source_type` gains `schedule_evaluation`, and three narrow SECURITY DEFINER RPCs (`capture_schedule_exposure_evaluation`, `derive_schedule_exposure_evidence`, `materialize_schedule_exposure_finding`). No table, column, policy or existing-function change.
- **Confidence:** Evidence 0–1 (`numeric(5,4)`, method `schedule-coverage:v1`, ceiling 0.9); Finding re-expressed on its persisted 0–100 scale in SQL (0.9 → 90.00, 0.6 → 60.00). `UNKNOWN` coverage and invalid topology (cycle, self-dependency, orphan edge, trigger outside the graph) are refused and record nothing.
- **Results:** critical-path minimum 159/159; P2-16 behavioural 26/26 and UI 10/10; `check:p2-16-db` PASS (132 assertions, two tenants); `check:operational-flow-db` ok; `check:fresh-db-migrations` PASS on an independent pristine stack (167/167, 433 tables, 33 SECURITY DEFINER — anon 0, PUBLIC 0); `check:security-definer-hardening` PASS (33); `check:aoc-boundaries` and `check:no-local-auth-bypass` PASS; typecheck 0; lint 0 errors / 643 warnings (identical to the untouched baseline); build exit 0; `npm test` 14,482 pass / 0 fail / 23 skipped; Chromium: P2-16 scenario 10/10, P2-14 journey + session continuity 38/38.
- **Product decisions (ratified at commit review):** `operational_sources.source_kind = engine` and `evidence_items.source_type = schedule_evaluation` for this adapter — `manual_note` and the external human/document types would misclassify deterministic engine output and contaminate customer-facing and project-memory semantics.
- **Exact-head proof on `b602363e`** (clean Linux checkout, `git status` empty; committed migration re-applied to the local stack so the live functions equal the committed SQL): P2-16 behavioural 26/26; P2-16 UI 10/10; `check:p2-16-db` PASS (132 assertions); critical-path minimum 159/159; `check:operational-flow-db` ok; `check:security-definer-hardening` PASS (33); typecheck 0; `git diff --check` clean; Chromium P2-16 scenario 10/10. Fresh-DB, full `npm test`, lint, build, AOC/no-bypass and P2-14 38/38 were not repeated: they passed on the identical candidate tree and the focused proof showed no drift.
- **Known limitations:** the engine models every dependency type as finish-to-start + lag, without calendars, and clamps float at 0 — stated on every exposure and reflected in the confidence ceiling. Evaluation is an explicit PM command on the Command Center, not an automatic hook on dependency/milestone writes. Residual P2-09 interaction (limitation, not a blocker): schedule Evidence is `LIVE`, `INFERENCE`, `RISK`, `CURRENT`, `RECORDED` and provenance-bearing, and the P2-09 Observation eligibility contract does not filter by assertion type or classification, so an authorized human could cite it in an Observation. P2-16 never auto-creates an Observation, never auto-achieves an Outcome, and does not claim schedule inference is factual outcome evidence; P2-09 is not redesigned here. A pre-existing hydration mismatch in `operational-shell.tsx` navigation links (client-only `projectId`) was observed in dev and is not caused by this increment.

## Required Delivery Report

Report status (`VERIFIED` only with all evidence), summary, files changed, migrations, contracts added/changed, exact tests/results, acceptance evidence/screenshots where applicable, deviations, known limitations, unlocked prompt, rollback/recovery instructions, compatibility/fixture expiry, and confirmation of no unrelated changes. Include branch/commit, diff summary and `git diff --check`.

## Stop Conditions

Stop as `BLOCKED` if a dependency is not `VERIFIED`; a non-ratified human decision or unavailable credential/infrastructure is required; migrations conflict; working-tree changes overlap; authorization would need weakening; canonical AOC contract cannot be determined; existing tests contradict P0 without authority; or scope exceeds this prompt. Use `IMPLEMENTED_NOT_VERIFIED` only when code exists but an acceptance command/environment remains incomplete; never continue a dependent prompt from that state.
