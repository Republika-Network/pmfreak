# P2-19 — Governed Ratification, Revocation and Learning Review

## Prompt Metadata

- **Prompt ID:** P2-19
- **Work Package:** WP10
- **Title:** Governed Ratification, Revocation and Learning Review
- **Phase:** Expansion
- **Primary Track:** Track B/C
- **Parallelizable:** no
- **Depends On:** P2-18 VERIFIED
- **Unlocks:** Expansion gate
- **Risk Level:** high
- **Expected Review Size:** large
- **Status:** `NOT_STARTED`
- **Migration:** possible additive; forward-only, additive if used; destructive changes prohibited.

## Role

Act as the implementation owner for this bounded vertical increment. Read `../PMFREAK_PRODUCT_BASELINE_V2.md`, `../PMFREAK_FOCUSED_ASSESSMENT_P1.md`, and `../PMFREAK_SEQUENTIAL_BUILD_PLAN_P2.md` first. Preserve P0 target, P1 observed state, and ratified D1–D7. Start by recording branch, HEAD, working tree and applicable `AGENTS.md` instructions.

## Product Outcome

An authorized reviewer ratifies or rejects a Candidate through AOC-E, retrieves scoped knowledge, and revocation removes future use while retaining audit lineage.

## Current State and Evidence

- **Reusable:** src/aoc/runtime-consumer/; src/lib/constitutional-learning/; src/app/api/agents/execution/learning/; src/app/(protected)/operational-memory/; tests/.
- **Partial:** P1 proves substantial components but no complete commercial chain.
- **Conflicting:** governed `operational_decision_records` coexists with legacy recommendation, `project_decisions`, task-draft and agent decision models.
- **Missing for this increment:** Connect AOC elevation authority, memory tiers, review/retrieval UI, revoke/retention and audit; no causal overclaim or automatic promotion.
- **Candidate adapters:** prefer existing services/ports in the listed areas; inventory consumers before adding a parallel model.

## Scope

Connect AOC elevation authority, memory tiers, review/retrieval UI, revoke/retention and audit; no causal overclaim or automatic promotion. End when this outcome is behaviorally tested and independently reviewable; do not absorb downstream prompts.

## Non-Goals

No broad redesign, external provider rollout, historical-model deletion, unrelated refactor, remote decision writeback, or implementation of later WP outcomes. Documentation alone is not completion.

## Dependencies and Preconditions

Required state: P2-18 VERIFIED. Every dependency must be `VERIFIED`; a contract-based parallel start is allowed only where metadata says so. Use an isolated development database for migrations/runtime tests. D1–D7 are ratified. Any fixture must say `DEMO / FIXTURE`, conform to the verified contract, and expire when Expansion gate becomes verified. Inspect migration ordering and overlapping working-tree changes before editing.

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
npx tsx --test tests/constitutional-learning-engine.test.ts tests/agent-controlled-execution-learning-signals-governance-feedback-loop.test.mjs
npm run typecheck
npm run lint
git diff --check
```

For migration/operational-flow scope also run `npm run check:operational-flow-db` against isolated infrastructure. For AOC scope run `npm run check:aoc-boundaries && npm run check:no-local-auth-bypass`. For UI/high-risk integration run `npm run build` and the repository browser/runtime scenario added by this prompt. Expected result: the Product Outcome is observable, negative/degraded cases pass, no unrelated regression occurs, and evidence is attached. Do not mark `VERIFIED` if an applicable command is skipped.

## Files Expected to Change

Expected areas: `src/aoc/runtime-consumer/; src/lib/constitutional-learning/; src/app/api/agents/execution/learning/; src/app/(protected)/operational-memory/; tests/`. Tests and narrowly scoped docs may change. Adjust paths only when better repository evidence is found and justify every deviation. Migration files, if needed, must be new and forward-only.

## Prohibited Changes

Do not enable remote writeback; delete/fuse legacy models; bypass AOC or membership/RLS; use zero/placeholder hashes; insert Evidence directly where Raw/Event is required; auto-create downstream canonical states; treat Task completion as Outcome; show fixtures as live; hardcode success; weaken tenant isolation; run destructive migration; redesign unrelated UI; or modify unrelated CI/dependencies.

## Verification Evidence — 2026-09-22

The `NOT_STARTED` status in the metadata above is the planning-time value; it is superseded here, not rewritten.

- **Baseline:** `build/p2-19-governed-learning-review` from `main` at `8d593c6cb48bc66be907bfcebe7bc3ca1612764f` (PR #622 merge; P2-18 VERIFIED).
- **Executable verification SHA:** `f03b1183` (`feat(learning): add governed project knowledge review`). Every result below was produced on this exact tree.
- **Owner decisions this increment depends on (ratified 2026-09-22, P2-19 only):**
  - Dedicated in-process AOC-E actions `knowledge.ratify` / `knowledge.reject` / `knowledge.revoke`.
  - Owner/admin only, through `manage_workspace`.
  - No mandatory separate reviewer.
  - Project-scoped knowledge only, with applicability fixed to the source Project.
  - Explicit validity `until_revoked | until_date` and no automatic TTL.
  - One terminal review per exact Candidate version/digest.
  - Terminal revocation, never reactivated.
  - The generic Material Action `knowledge_elevation` stays hard-denied.
  - The pre-decision assessment found no canonical AOC-E contract and stopped as BLOCKED until these decisions were ratified.
- **Product outcome:** an owner/admin reviews one exact P2-18 Learning Candidate state and ratifies it into Project-scoped knowledge or rejects it. Authoritative retrieval returns only active, in-scope, unexpired, non-fixture knowledge. Revocation removes a record from retrieval immediately while keeping it, and its lineage, in history.
- **Governance:**
  - `GovernanceAction` and `GOVERNANCE_POLICY_REGISTRY` gain the three actions: permission `manage_workspace`, actor type user only, `agentCompatible: false`, Workspace-scoped, deny audit `governance_violation`, risk critical / high / critical.
  - They are listed as non-delegable, alongside `workspace.manage`.
  - Routes evaluate them through the real in-process runtime (`authorizeRuntimeAction`) with the concrete Candidate or Knowledge record as the resource, and only after resolving that record in the claimed Workspace and Project.
  - Only an explicit ALLOW with a decision id and evaluation time proceeds. DENY → 403; approval-routed → 403, never success; runtime unavailable or error → 503. None of them writes.
  - The generic `knowledge_elevation` Material Action path is unchanged (`operational-flow-service.ts` and the P2-06 RPC still deny it).
  - `allowDecisionWriteback` is untouched (false).
- **Authority in the database:** each command re-derives `manage_workspace` itself: the caller (`auth.uid()`) must be an owner or admin member of the Candidate's Workspace, with project access. It also refuses a governance reference that is not ALLOW for the exact action (`project_knowledge_governance_projection_mismatch`), as P2-06 does. A direct RPC call therefore cannot exceed the runtime's authority. The decision id itself is attested by the application layer and recorded verbatim.
- **Review contract:**
  - `canonical_learning_candidate_reviews` holds one terminal outcome (`ratified | rejected`) per exact `(candidate_id, candidate_version, candidate_evidence_digest)`, enforced by a unique constraint, never updated or deleted.
  - It records:
    - the reviewer and role, and the database time;
    - the Candidate's creator and last evaluator, plus `reviewer_is_candidate_creator` (kept visible; never called independent);
    - the bounded reviewed summary, including the current source ids;
    - the causality qualifier and limitations;
    - a required non-empty rationale (≤ 8000);
    - the ALLOW decision reference.
- **Stale review and support:**
  - Under the Candidate row lock (which also serialises against P2-18's evidence updates), a version or digest mismatch returns `stale_review` and writes no review, knowledge or event.
  - Ratification also requires the Candidate to be operationally supported now: the sources valid at the database clock (P2-18's validity predicate) must be non-empty and must digest to exactly the reviewed `evidence_digest`. Otherwise it returns `not_supported`, whatever the stored summary says.
  - The route checks the same things before governance, and the database re-checks them after.
- **Knowledge contract:**
  - `canonical_project_knowledge_records` requires a composite FK to a *ratified* review of the same exact Candidate state. Fields:
    - scope and provenance: workspace, project, Candidate id/version/digest, review id; the current source ids at ratification; `applicability_scope = 'source_project'`;
    - content: pattern key/signature; a bounded deterministic statement; tier, counts and results; confidence with its method; the causality claim copied verbatim; limitations, with `not_ratified` replaced by `applies_to_source_project_only` and `ratification_is_not_causal_evidence`;
    - lifecycle: status `active | revoked`; `validity_mode`, `effective_from/until`; ratified at/by; the governance decision id; version; revocation fields; fixture label.
  - At most one active record exists per Candidate.
  - A correlation-only Candidate yields correlation-only knowledge.
- **Candidate unchanged:** `canonical_learning_candidates` is not altered or updated; after ratification the Candidate stays `proposed` at the same version.
- **Validity:**
  - `until_revoked` → `effective_until` is null.
  - `until_date` → an explicit future date, validated by the client, the route and the database clock.
  - There is no default duration and no invented mode. Expiry is derived at read time (`effective_until <= now()`), and no expiry transition is persisted.
- **Rejection:** terminal for that exact state and creates no knowledge. A retry replays as `duplicate`, ratifying the rejected state is `already_finalized` (never a flip), and a newer Candidate version can be reviewed again with the rejection kept as history.
- **Revocation:**
  - `active → revoked` happens once and records `revoked_at/by`, the reason, and the governance decision id and time.
  - A retry returns `already_revoked` with no second event, and re-submitting the ratified state replays and never reactivates.
  - A guard trigger stops even owner-level paths from reactivating a record or editing its content or provenance.
- **Retrieval:** `retrieve_project_knowledge` runs as security invoker (RLS) and filters on workspace, project, `source_project`, `active`, non-fixture and unexpired at the database clock. It excludes Candidates, rejected reviews, revoked, expired, other-Project, other-Workspace and fixture records, proven at the data layer, in the service and in the browser. The history read (all reviews and records) is a separate contract, labelled, and never an authoritative source.
- **Direct-write boundary:**
  - Both tables revoke all privileges from `anon`, `authenticated` and `service_role`; SELECT is granted to `authenticated` (under RLS) and `service_role`.
  - Effective privileges, inspected with `has_table_privilege` and `has_function_privilege` on the fresh schema: SELECT is the only privilege held, by `authenticated` and `service_role`; `anon` holds none.
  - The two helpers are not executable by any client role, and the three commands are not executable by `anon`.
  - Denied behaviourally:
    - service-role insert/update/delete of reviews and knowledge, including a revoked → active reactivation;
    - owner-client inserts and updates;
    - anon inserts;
    - owner-level (superuser) reactivation, content edit, review flip and review delete, all stopped by `project_knowledge_immutable`.
- **Concurrency and idempotency** (database level, locks plus unique constraints):
  - A same-state retry replays.
  - 8 concurrent first ratifications give 1 `ratified` + 7 `duplicate`, 1 review, 1 record and 1 event.
  - A ratify/reject race (4 + 4 concurrent) has exactly one terminal winner, and every loser is `duplicate`/`already_finalized`.
  - 6 concurrent revocations give 1 `revoked` + 5 `already_revoked` and 1 event.
- **Events:** `CANONICAL_LEARNING_CANDIDATE_RATIFIED_V1`, `…_REJECTED_V1` and `CANONICAL_PROJECT_KNOWLEDGE_REVOKED_V1` are written in the same transaction as their rows. Each carries every actor identity and the governance reference; the ratified event also records `crossWorkspace: false`. `elevationInferred` is false and `learning_eligible` is false.
- **UI:**
  - A learning review panel on the Workspace Command Center for the selected project (`?projectId=`), the project-scoped surface that already hosts P2-16's governed panel. The Project Command Center is read-only by contract (Slice 1 and its route tests), so it was not changed.
  - It shows the full Candidate contract: pattern, version, summary as-of, whether the summary reflects current sources, operational support, tier, lineage count, result counts, confidence and method, the correlation-only statement, limitations, the source Project, and applicability "this project only".
  - It distinguishes a proposed Candidate, a rejected version, ratified/active knowledge, and revoked or expired knowledge. A ratified Candidate whose knowledge is no longer in effect says so ("Knowledge revoked — not in effect").
  - States covered: loading, denied, error, validation, stale, not-supported, governance-unavailable and success.
  - Controls appear only for owners/admins. Validity has no preselection, and there are no widening controls.
- **Environment:**
  - An isolated Supabase stack (`pmfreak-p2-19-verify`, loopback ports 553xx) with its own disposable Frontera store.
  - The shared local stack stayed at `main`'s migrations, and no hosted project was touched.
  - The isolated database was reset to pristine and fresh-applied before the final live runs.
- **Results (on `f03b1183`):**
  - P2-19 focused 25/25: the real in-process policy evaluator for owner/admin ALLOW and PM/viewer/contributor/executive-viewer/non-member/agent/system DENY on all three actions; the real runtime-consumer fail-closed UNAVAILABLE path; route sequencing; the UI states; and migration invariants.
  - Minimum acceptance (`constitutional-learning-engine`, `agent-controlled-execution-learning-signals-governance-feedback-loop`) PASS.
  - `check:p2-19-db` PASS, 270 assertions, on LIVE P2-18 lineages. It ran on the pre-reset schema, on the fresh schema, and again on `f03b1183`. The ratify/reject race was won by ratification in every run; the assertion accepts either winner.
  - Chromium `tests/e2e/p2-19-learning-review.spec.ts` 9/9: A owner ratifies · B admin ratifies with an explicit expiry · C PM inspects, no controls, API 403 · D rejection · E stale review · F revocation · G cross-tenant/IDOR · H generic `knowledge_elevation` denied · responsive 390/768/1440.
  - `check:fresh-db-migrations` PASS: 169/169 migrations from a pristine database; 437 tables; the only table without RLS is the pre-existing `agent_attestation_nonces`; the four P2-18/P2-19 tables have RLS with one SELECT policy each; SECURITY DEFINER 37 (authenticated 27), matching the matrix.
  - P2-18 regression: focused tests PASS; `check:p2-18-db` PASS (200) before the reset and on the fresh schema. On the fresh schema the first attempt failed one timing assertion because the host and database clocks briefly disagreed by more than 2s under load. The data showed the propose committed about 0.1s before the database-clock expiry. The unchanged checker then passed.
  - Negative regression: `check:p2-06-db` PASS (50; `knowledge_elevation` → `denied`); `check:p2-07-db` PASS; `check:p2-14-db` PASS (38). `check:p2-19-db` and the browser scenario H also re-assert the generic denial.
  - Other regressions: `check:operational-flow-db` ok, `check:p2-09-db` PASS (74) and `check:p2-16-db` PASS (200).
  - Governance registry and mapping contracts PASS: every exhaustive action list is updated deliberately, the registry is `Record<GovernanceAction, …>`, and the approval-routing list is correctly unchanged.
  - `check:governance` (AOC boundaries, no-local-auth-bypass, runtime-contract drift, DB contract and the rest) PASS; `check:security-definer-hardening` PASS (37).
  - typecheck 0; lint 0 errors / 642 warnings (= baseline); build exit 0 (420 pages); `git diff --check` clean.
  - `npm test` 14,569 pass / 2 fail / 25 skipped. The 2 failures are the WSL-worktree line-ending pair, which pass 7/7 under native Windows Git. Module mocks 19/19.
- **Deviations:**
  - New code lives in `src/lib/project-knowledge/`, `src/app/api/learning-candidates/review/`, `src/app/api/project-knowledge/` and `src/components/pmfreak/learning-review/`.
  - `/operational-memory` is legacy and not entity-scoped, and was not used.
  - The legacy `organizational_memory` and `organizational_patterns` tables, the constitutional-learning stores and `agent_memory_records` were not declared canonical and were left unchanged. They fail the contract: member-writable RLS, no ratified or revocation lifecycle, or no candidate link.
  - `listLearningCandidates` gained an optional `candidateId` filter (the same derivation, one row).
- **Fixtures:** none introduced; no product path can create a fixture review or record. The live checker inserts one owner-level row labelled `DEMO / FIXTURE — expires when the Expansion gate becomes VERIFIED` into its disposable stack only, to prove that retrieval excludes it. The UI labels fixture data "Demo data — not a live project record".
- **Known limitations:**
  - No correction or supersession of knowledge. Content is immutable; replacing knowledge means revoke plus a new Candidate version plus a new review.
  - At most one active record per Candidate, so ratifying a newer version while one is active returns `already_ratified`. An expired but still active record also blocks re-ratification until it is revoked.
  - The governance decision id is attested by the application layer; the database independently re-derives the authority it stands for.
  - There are no memory tiers and no Workspace or Enterprise elevation (later, separately governed steps).
  - A pre-existing sidebar hydration warning (nav links differing on `?projectId=` between server and client) appears in the dev server log on the Command Center. It does not involve the learning panel and was not changed here.
- **Rollback:** remove the panel mount and stop calling the three routes. The migration is additive with no dependents, so a forward migration can drop the two tables, the helpers, the three commands and `retrieve_project_knowledge`. The P2-18 tables are untouched.
- **Gate:** P2-19 `VERIFIED`. Expansion gate unlocked / ready for certification: the build plan defines it as P2-18/19 `VERIFIED` with candidate eligibility, governed ratify/reject/revoke and retrieval. As with G1–G4, it still needs its own certification on `main` after merge, and it is not recorded as `VERIFIED` here.

## Required Delivery Report

Report status (`VERIFIED` only with all evidence), summary, files changed, migrations, contracts added/changed, exact tests/results, acceptance evidence/screenshots where applicable, deviations, known limitations, unlocked prompt, rollback/recovery instructions, compatibility/fixture expiry, and confirmation of no unrelated changes. Include branch/commit, diff summary and `git diff --check`.

## Stop Conditions

Stop as `BLOCKED` if a dependency is not `VERIFIED`; a non-ratified human decision or unavailable credential/infrastructure is required; migrations conflict; working-tree changes overlap; authorization would need weakening; canonical AOC contract cannot be determined; existing tests contradict P0 without authority; or scope exceeds this prompt. Use `IMPLEMENTED_NOT_VERIFIED` only when code exists but an acceptance command/environment remains incomplete; never continue a dependent prompt from that state.
