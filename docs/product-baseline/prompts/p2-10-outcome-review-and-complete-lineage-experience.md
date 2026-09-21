# P2-10 — Outcome Review and Complete Lineage Experience

## Prompt Metadata

- **Prompt ID:** P2-10
- **Work Package:** WP5
- **Title:** Outcome Review and Complete Lineage Experience
- **Phase:** Founder Invite
- **Primary Track:** Track A/C
- **Parallelizable:** no
- **Depends On:** P2-09 VERIFIED
- **Unlocks:** P2-12, P2-20, G2
- **Risk Level:** high
- **Expected Review Size:** large
- **Status:** `VERIFIED` — `P2-10-LINEAGE-FINDING-UNRESOLVED` repaired under authorization; verified on committed SHA `0fd86b561326c7895980fffb5c47c8aa6b8585c5` 2026-09-20. See Verification Evidence — 2026-09-19 (initial blocker) and Post-Repair Verification — 2026-09-20. (Previously recorded `NOT_STARTED`: stale metadata; the 2026-09-19 exact-head pass recorded `BLOCKED`.)
- **Migration:** possible additive; forward-only, additive if used; destructive changes prohibited.

## Role

Act as the implementation owner for this bounded vertical increment. Read `../PMFREAK_PRODUCT_BASELINE_V2.md`, `../PMFREAK_FOCUSED_ASSESSMENT_P1.md`, and `../PMFREAK_SEQUENTIAL_BUILD_PLAN_P2.md` first. Preserve P0 target, P1 observed state, and ratified D1–D7. Start by recording branch, HEAD, working tree and applicable `AGENTS.md` instructions.

## Product Outcome

A PM reviews observed versus expected Outcome and traverses Evidence→Finding→Recommendation→Decision→Action→Task→Observation with gaps/disputes shown honestly.

## Current State and Evidence

- **Reusable:** src/lib/operational-flow/; src/lib/decision-outcome-engine/; src/components/pmfreak/intelligence-inbox/; src/app/api/operational-flow/; tests/.
- **Partial:** P1 proves substantial components but no complete commercial chain.
- **Conflicting:** governed `operational_decision_records` coexists with legacy recommendation, `project_decisions`, task-draft and agent decision models.
- **Missing for this increment:** Complete correlation projection, audit reconstruction API/UI, observation review and incomplete/disputed states; correlation never becomes causation.
- **Candidate adapters:** prefer existing services/ports in the listed areas; inventory consumers before adding a parallel model.

## Scope

Complete correlation projection, audit reconstruction API/UI, observation review and incomplete/disputed states; correlation never becomes causation. End when this outcome is behaviorally tested and independently reviewable; do not absorb downstream prompts.

## Non-Goals

No broad redesign, external provider rollout, historical-model deletion, unrelated refactor, remote decision writeback, or implementation of later WP outcomes. Documentation alone is not completion.

## Dependencies and Preconditions

Required state: P2-09 VERIFIED. Every dependency must be `VERIFIED`; a contract-based parallel start is allowed only where metadata says so. Use an isolated development database for migrations/runtime tests. D1–D7 are ratified. Any fixture must say `DEMO / FIXTURE`, conform to the verified contract, and expire when P2-12, P2-20, G2 becomes verified. Inspect migration ordering and overlapping working-tree changes before editing.

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
npx tsx --test tests/operational-flow-contract.test.mjs tests/decision-outcome-engine.test.mjs
npm run typecheck
npm run lint
git diff --check
```

For migration/operational-flow scope also run `npm run check:operational-flow-db` against isolated infrastructure. For AOC scope run `npm run check:aoc-boundaries && npm run check:no-local-auth-bypass`. For UI/high-risk integration run `npm run build` and the repository browser/runtime scenario added by this prompt. Expected result: the Product Outcome is observable, negative/degraded cases pass, no unrelated regression occurs, and evidence is attached. Do not mark `VERIFIED` if an applicable command is skipped.

## Files Expected to Change

Expected areas: `src/lib/operational-flow/; src/lib/decision-outcome-engine/; src/components/pmfreak/intelligence-inbox/; src/app/api/operational-flow/; tests/`. Tests and narrowly scoped docs may change. Adjust paths only when better repository evidence is found and justify every deviation. Migration files, if needed, must be new and forward-only.

## Prohibited Changes

Do not enable remote writeback; delete/fuse legacy models; bypass AOC or membership/RLS; use zero/placeholder hashes; insert Evidence directly where Raw/Event is required; auto-create downstream canonical states; treat Task completion as Outcome; show fixtures as live; hardcode success; weaken tenant isolation; run destructive migration; redesign unrelated UI; or modify unrelated CI/dependencies.

## Verification Evidence — 2026-09-19

Exact-head reconciliation run. Status earlier in this file was historical/stale metadata; it is superseded here, not rewritten.

- **SHA:** `95c928b2ceb8f0f40465965c751ef9c3230a1d8c` (`origin/main`, merge of #613), plus the P2-14 spec reconciliation recorded under P2-14.
- **Environment:** native Linux scratch clone at that SHA; Node v22.23.1 / npm 10.9.8 (`npm ci`); local Supabase `127.0.0.1:54321`/`54322`, 165/165 migrations through `20260911000000`; Frontera `@aoc-enterprise/runtime` 1.2.1 on a disposable OS-temp SQLite store.

- **Result:** `BLOCKED`. The implementation exists, and its focused suites pass: `npx tsx --test tests/operational-flow-contract.test.mjs tests/decision-outcome-engine.test.mjs` 79/79, and `tests/p2-10-outcome-review-lineage.test.ts` 44/44. The live runtime shows a lineage defect.
- **Blocker: `P2-10-LINEAGE-FINDING-UNRESOLVED` (product defect).**
  - `src/lib/operational-flow/operational-flow-service.ts` resolves the Finding as `recommendation?.signal_id || governance?.signal_id`.
  - Neither column exists. Governed Recommendations link through `recommended_actions.source_signal_id`, and `governance_events` links through `related_entity_type` / `related_entity_id`.
  - So for every chain produced by `materialize_operational_chain`, the lineage reports the Finding as missing:
    - step `finding` has status `missing` ("Finding missing.");
    - gap: "Finding: no operational finding linked.";
    - Evidence→Finding and Finding→Recommendation are `unlinked`;
    - the export reports `completeLineageCount: 0` and `overallStatus: incomplete`.
  - The data link is intact. The Founder chain's Recommendation carries a `source_signal_id` that resolves to an existing Signal in the same workspace.
  - Reproduced on two independent browser-created chains, outcomes `155ede1d-…` and `c1aba6e9-…`.
  - The unit fixtures in `tests/p2-10-outcome-review-lineage.test.ts` and `tests/p2-20-audit-export-compatibility-gate.test.ts` use a `signal_id` column the schema does not have, which is why the suites pass.
- **Verified live on the same chains:**
  - correlation-only edges are `isCausal: false`;
  - `taskCompletionImpliesOutcomeAchievement: false`;
  - the Observation is evidence-backed and LIVE;
  - AOC-E governance references are present;
  - the gap is reported, not synthesised;
  - cross-tenant reads get 403, and an unauthenticated request gets 401.
- **Smallest proposed repair** (product source; needs separate authorization; no migration):
  - resolve the Signal from `recommendation.source_signal_id` (and from `governance.related_entity_id` when `related_entity_type` names a signal);
  - correct both unit fixtures to the real column names;
  - add a live assertion that the canonical Founder chain exports `completeLineageCount: 1` with no Finding gap.

## Exact-head post-repair verification — 2026-09-20

**Verified executable candidate SHA: `0fd86b561326c7895980fffb5c47c8aa6b8585c5` (C4).**

Chronology, so the record is not read backwards: `95c928b2` is the exact-main baseline on which the blockers were discovered and reproduced — never a SHA carrying the repairs. C1–C3 are the Founder/G2/G3 repair candidate. Exact-head validation of that candidate then surfaced a *pre-existing* governance defect (a revoked Material Action could still be dispatched into a Task and could still start), which reproduces identically at `95c928b2`; C4 repairs it and is the SHA every result in this section was verified on.

The blocker recorded above was repaired under explicit authorization. The 2026-09-19 finding stands as written; this section records what changed and what now holds.

Verified on committed SHA `0fd86b561326c7895980fffb5c47c8aa6b8585c5` (C4 = C1+C2+C3+C4), checked out clean with none of this reconciliation's documentation edits present. Same local environment as the 2026-09-19 pass: Node v22.23.1 / npm 10.9.8, local Supabase `127.0.0.1:54321`/`54322` at migration head `20260912000000` (166/166 — C4 adds exactly one forward migration, `20260912000000_material_action_terminal_revocation.sql`, which replaces two function bodies and changes no table, column or RLS policy), Frontera `@aoc-enterprise/runtime` 1.2.1 on a fresh disposable OS-temp store.

- **Repair (product):** `src/lib/operational-flow/operational-flow-service.ts` now resolves the Finding through the one durable reference the canonical chain persists, `recommended_actions.source_signal_id`, written by `materialize_operational_chain` as the detected Signal's id. The previous `recommendation.signal_id || governance.signal_id` read two columns no table defines. The dead `governance_events` lookup that existed only to serve it was removed; the query, its error check and tenancy scoping are unchanged. No migration, no schema or RLS change.
- **Fixture drift corrected:** `tests/p2-10-outcome-review-lineage.test.ts` and `tests/p2-20-audit-export-compatibility-gate.test.ts` carried `signal_id` on `recommended_actions` rows — a column the schema has never defined — which is why both suites stayed green while the live projection could not resolve a Finding. They now use `source_signal_id`, and the P2-10 governance fixture uses `related_entity_type`/`related_entity_id`.
- **New regression cover** (`tests/p2-10-outcome-review-lineage.test.ts`): the canonical reference resolves the Finding with no false gap and a continuous Evidence→Finding→Recommendation chain; a legacy-shaped `signal_id` is NOT accepted as a Finding reference; a null `source_signal_id` still reports the gap honestly; and an unresolvable reference is a gap rather than a fabricated node.
- **Mutation-proved:** reintroducing the defective line fails 4 P2-10 and 2 P2-20 tests, including the pre-existing complete-chain assertions. The suites are now load-bearing for this relationship.
- **Automated:** `tests/p2-10-outcome-review-lineage.test.ts` 48/48; focused P2-10 command 79/79; `npm test` 14,443 pass / 0 fail / 23 skipped.
- **Live proof** (authenticated lineage and audit export over two independently browser-created Founder chains, outcomes `0f48d161-…` and `9cf281f7-…`):
  - the Finding step is `intact` and its id equals the persisted `source_signal_id`, confirmed against the database (`ce3f3fbb-…` for the final chain);
  - `gaps: []`, `gapCount: 0`, `overallStatus: complete`, `completeLineageCount: 1`, `isComplete: true`;
  - the full 12-node chain Source → Raw Input → Normalized Event → Evidence → Finding → Recommendation → Decision → Action → Task → Execution → Outcome → Observation is present;
  - Evidence→Finding and Finding→Recommendation are `direct_reference` rather than `unlinked`.
- **Preserved:** correlation-only edges remain explicitly non-causal, `taskCompletionImpliesOutcomeAchievement` remains `false`, and the AOC-E governance pointer is unchanged.
- **Post-repair status:** `VERIFIED` on `0fd86b561326c7895980fffb5c47c8aa6b8585c5`.

## Required Delivery Report

Report status (`VERIFIED` only with all evidence), summary, files changed, migrations, contracts added/changed, exact tests/results, acceptance evidence/screenshots where applicable, deviations, known limitations, unlocked prompt, rollback/recovery instructions, compatibility/fixture expiry, and confirmation of no unrelated changes. Include branch/commit, diff summary and `git diff --check`.

## Stop Conditions

Stop as `BLOCKED` if a dependency is not `VERIFIED`; a non-ratified human decision or unavailable credential/infrastructure is required; migrations conflict; working-tree changes overlap; authorization would need weakening; canonical AOC contract cannot be determined; existing tests contradict P0 without authority; or scope exceeds this prompt. Use `IMPLEMENTED_NOT_VERIFIED` only when code exists but an acceptance command/environment remains incomplete; never continue a dependent prompt from that state.
