# P2-18 — Learning Candidate Eligibility and Lineage

## Prompt Metadata

- **Prompt ID:** P2-18
- **Work Package:** WP10
- **Title:** Learning Candidate Eligibility and Lineage
- **Phase:** Expansion
- **Primary Track:** Track A
- **Parallelizable:** yes after P2-10
- **Depends On:** P2-10 VERIFIED
- **Unlocks:** P2-19
- **Risk Level:** medium
- **Expected Review Size:** large
- **Status:** `NOT_STARTED`
- **Migration:** possible additive; forward-only, additive if used; destructive changes prohibited.

## Role

Act as the implementation owner for this bounded vertical increment. Read `../PMFREAK_PRODUCT_BASELINE_V2.md`, `../PMFREAK_FOCUSED_ASSESSMENT_P1.md`, and `../PMFREAK_SEQUENTIAL_BUILD_PLAN_P2.md` first. Preserve P0 target, P1 observed state, and ratified D1–D7. Start by recording branch, HEAD, working tree and applicable `AGENTS.md` instructions.

## Product Outcome

A complete outcome lineage can create a scoped Learning Candidate with evidence and limitations, never organizational truth.

## Current State and Evidence

- **Reusable:** src/lib/constitutional-learning/; src/lib/institutional-learning/; src/lib/operational-decision-outcome/; supabase/migrations/; tests/.
- **Partial:** P1 proves substantial components but no complete commercial chain.
- **Conflicting:** governed `operational_decision_records` coexists with legacy recommendation, `project_decisions`, task-draft and agent decision models.
- **Missing for this increment:** Define candidate eligibility, tiers, correlation-only language, retention and deduplication; emit candidate event without elevation.
- **Candidate adapters:** prefer existing services/ports in the listed areas; inventory consumers before adding a parallel model.

## Scope

Define candidate eligibility, tiers, correlation-only language, retention and deduplication; emit candidate event without elevation. End when this outcome is behaviorally tested and independently reviewable; do not absorb downstream prompts.

## Non-Goals

No broad redesign, external provider rollout, historical-model deletion, unrelated refactor, remote decision writeback, or implementation of later WP outcomes. Documentation alone is not completion.

## Dependencies and Preconditions

Required state: P2-10 VERIFIED. Every dependency must be `VERIFIED`; a contract-based parallel start is allowed only where metadata says so. Use an isolated development database for migrations/runtime tests. D1–D7 are ratified. Any fixture must say `DEMO / FIXTURE`, conform to the verified contract, and expire when P2-19 becomes verified. Inspect migration ordering and overlapping working-tree changes before editing.

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
npx tsx --test tests/constitutional-learning-engine.test.ts tests/intervention-learning-engine.test.mjs
npm run typecheck
npm run lint
git diff --check
```

For migration/operational-flow scope also run `npm run check:operational-flow-db` against isolated infrastructure. For AOC scope run `npm run check:aoc-boundaries && npm run check:no-local-auth-bypass`. For UI/high-risk integration run `npm run build` and the repository browser/runtime scenario added by this prompt. Expected result: the Product Outcome is observable, negative/degraded cases pass, no unrelated regression occurs, and evidence is attached. Do not mark `VERIFIED` if an applicable command is skipped.

## Files Expected to Change

Expected areas: `src/lib/constitutional-learning/; src/lib/institutional-learning/; src/lib/operational-decision-outcome/; supabase/migrations/; tests/`. Tests and narrowly scoped docs may change. Adjust paths only when better repository evidence is found and justify every deviation. Migration files, if needed, must be new and forward-only.

## Prohibited Changes

Do not enable remote writeback; delete/fuse legacy models; bypass AOC or membership/RLS; use zero/placeholder hashes; insert Evidence directly where Raw/Event is required; auto-create downstream canonical states; treat Task completion as Outcome; show fixtures as live; hardcode success; weaken tenant isolation; run destructive migration; redesign unrelated UI; or modify unrelated CI/dependencies.

## Verification Evidence — 2026-09-21

The `NOT_STARTED` status in the metadata above is the planning-time value; it is superseded here, not rewritten.

- **Baseline:** `build/p2-18-learning-candidate-lineage` from `main` at `b571433444b8534504b83bec15f33639b2d6c05e` (G4 VERIFIED record merged; P2-10 VERIFIED).
- **Executable verification SHA:** `b93dd9fb` (`fix(learning): revoke direct table DML from service_role`), final. The initial implementation `a32335ff` was superseded after review found the direct-write gap described below; every result in this section was re-run on `b93dd9fb`.
- **Product outcome:** a complete canonical outcome lineage (Source → … → LIVE Observation) can create a scoped, non-authoritative Learning Candidate with evidence and limitations, never organizational truth. `POST/GET /api/learning-candidates`; service `src/lib/learning-candidates/`.
- **Model:** a candidate is a pattern hypothesis, identified per project by `pattern_key` = sha256 of the exact typed classifiers on the chain (Finding `signal_type`, Recommendation `recommended_action_type`, Action `action_class`). Evidence membership is relational in `canonical_learning_candidate_sources`, one row per qualifying Observation. The aggregate holds bounded summary fields only and carries no single correlation id; correlation/causation live on each source.
- **Eligibility:** the P2-10 projection must be `complete` and not fixture, and the database independently re-derives every rule from canonical rows, never looser than that projection. The Observation must be the Outcome's latest, with a qualifying result (achieved/partial/failed); no Observation in the Outcome's history may be disputed, inconclusive, incomplete (PARTIAL/UNKNOWN) or fixture; the Observation must be unexpired and its Evidence still meeting P2-09's promotion rule; Task and execution completed; the governance evaluation the execution ran under authorized/not_required, with no denied/revoked evaluation; the Decision accepted/modified and not superseded; the Recommendation, Finding and canonical LIVE Finding Evidence present and not degraded. Every failure is a named reason, and nothing is written.
- **Tiers (structural, not thresholds):** `single_lineage`, `multiple_consistent_lineages` (distinct Decisions, same result), `conflicting_lineages`. There is no review eligibility and no numeric corroboration threshold. Confidence is the weakest linked Observation's (`weakest_linked_observation:v1`), stated as not a probability that the pattern holds.
- **Correlation vs causation:** the RPC writes `causality_claim = 'correlation_only'` itself; it is persisted, emitted and returned with its statement. There is no value constraint: the qualifier reflects current evidence capability.
- **Dedupe / versioning:** a retry of the same Observation is a `duplicate` (no write, no event). A newer Observation supersedes the Outcome's previous source (kept, with `superseded_by`). A new Outcome of the same pattern adds a source. Every material change increments `version` and recomputes `evidence_digest`. Uniqueness is enforced by constraints, including one current source per Outcome, plus a per-pattern advisory lock.
- **Retention:** no numeric TTL. A source's `valid_until` is its Observation's own `stale_at`. Currency is derived on read (superseded / no longer latest / past validity / Evidence not current); nothing is deleted, and a provenance guard trigger refuses deletes and rewrites for every role. Memory-tier and duration retention are left to the owner decision and P2-19.
- **Event:** `CANONICAL_OUTCOME_LEARNING_CANDIDATE_V1` in `platform_events` (payload `eventType: canonical_outcome_learning_candidate.v1`, the name P2-09 reserved), written in the same transaction as the source link and candidate version, with before/after state, canonical references, `elevationInferred: false` and `candidateIsNotOrganizationalTruth: true`. `learning_eligible = false` per that column's documented meaning (the event is not re-fed to pattern extraction). Event correlation is the triggering Observation's real uuid correlation, otherwise null.
- **Authorization:** an authenticated SECURITY DEFINER RPC, `auth.uid()` + `can_write_operational_project` — the same predicate as `record_canonical_outcome_observation`, which produces the reserved candidate payload. No service role. Reads are RLS `can_access_operational_project`. No role holds DML on the two tables — `anon`, `authenticated` and `service_role` are all revoked (SELECT is granted only to `authenticated`, under RLS, and to `service_role` for verification), so the RPC is the only writer. The provenance guard trigger remains as defence in depth for owner-level paths. The route resolves identity and role server-side, uses the server clock, and names a handled refusal's stable `failureClass`.
- **Migration:** `20260914000000_p2_18_learning_candidate_lineage.sql`, additive and forward-only. Grant matrix: 34 SECURITY DEFINER functions, 24 authenticated.
- **Direct-write boundary (review follow-up):**
  - The first candidate revoked DML only from `anon`/`authenticated`. `service_role`, which bypasses RLS, kept full DML through Supabase's default privileges.
  - Reproduced on the isolated stack: a direct service-role UPDATE forged the tier (`conflicting_lineages` → `single_lineage`) with `version + 1`, a shape the guard permits for the RPC. It changed the aggregate with no source change and no event (4 events before and after), and forged candidate and source inserts also succeeded.
  - Closed by `revoke all … from anon, authenticated, service_role` plus explicit SELECT grants. `check:p2-18-db` now proves every such direct write is denied, with the aggregate, sources and event count unchanged.
  - An owner-level probe confirms the trigger still refuses deletes, lineage rewrites, re-keying and version skips.
- **Environment:** an isolated Supabase stack (`pmfreak-p2-18-verify`, loopback ports 553xx) with its own disposable Frontera store; the shared local stack stayed at `main`'s 167 migrations. No hosted project was touched.
- **Results:**
  - P2-18 behavioural/contract 23/23.
  - Minimum acceptance (`constitutional-learning-engine`, `intervention-learning-engine`) 77/77.
  - P2-09/P2-10/P2-20/decision-integrity contracts 122/122; P2-16/P2-17 81/81.
  - `check:p2-18-db` PASS (155 assertions; direct `service_role` candidate/source inserts and updates denied, with the aggregate, sources and events unchanged; LIVE lineages built through the product API; retries and 10 concurrent retries are duplicates; 8 concurrent first proposals give 1 link + 7 duplicates; supersession keeps history; tiers single → multiple_consistent → conflicting; events equal material changes; viewer/outsider/IDOR refused; the service role cannot delete or rewrite lineage). After the grant fix it passed on five consecutive runs (three of them before the snapshot labelling was added, at 154 assertions).
  - `check:fresh-db-migrations` PASS (168 migrations applied from zero; 435 tables; the only table without RLS is the pre-existing `agent_attestation_nonces`; SECURITY DEFINER grants PASS).
  - `check:operational-flow-db` ok (22/22); `check:p2-09-db` PASS (74, reserved payload intact); `check:p2-16-db` PASS (200).
  - `check:security-definer-hardening` PASS (34); governance/AOC and `check:no-local-auth-bypass` PASS.
  - typecheck 0; lint 0 errors / 642 warnings (= baseline); build exit 0 (417 pages); `git diff --check` clean.
  - `npm test` 14,549 pass / 25 skipped; its 2 failures are the WSL worktree line-ending pair, which pass 7/7 under native Windows Git. Module mocks 19/19.
- **Not run (not applicable):** no browser scenario, because P2-18 adds no UI; the route is exercised live by `check:p2-18-db`.
- **Deviations:** `src/lib/institutional-learning/` does not exist (it is the documentation name of `constitutional-learning`). `constitutional-learning` (published digest patterns, workspace scope) and `operational-decision-outcome` (legacy `operational_decisions`) are not inputs to the canonical chain and were left unchanged; so were `organizational_patterns` (workspace scope, member-writable, governance-owned `validated` lifecycle) and the P2-09 payload. New code lives in `src/lib/learning-candidates/` and `src/app/api/learning-candidates/`.
- **Fixtures:** none introduced. Fixture lineages are refused; `fixture_label` exists for convention and P2-18 never sets it.
- **Known limitations:**
  - An Outcome with any disputed or inconclusive Observation in its history can never be candidate evidence (P2-10's rule, applied conservatively).
  - Independence is structural (distinct Decisions), not statistical.
  - Cohorting is exact-classifier, per project; cross-project or generalised cohorts are future decisions.
  - The stored tier, counts and confidence are a snapshot as of the last material evaluation. The read contract labels them (`summaryBasis: "as_of_last_evaluation"`, `summaryAsOf`) and says when they no longer reflect current sources (`summaryReflectsCurrentSources`); currency (`currentSourceCount`, `operationallySupported`) is derived on read, and nothing re-evaluates automatically. The only consumers are the route (pass-through), the verifier and the tests; none treats the stored tier as current.
  - P2-10's projection does not traverse risk/governance-event rows; the RPC's own checks cover the governance evaluation and Decision.
- **Rollback:** stop calling the route. The migration is additive with no dependents, so a forward migration can drop the two tables, the guard function and the RPC.
- **Gate:** P2-18 `VERIFIED`. P2-19 is unlocked and not started; nothing here reviews, validates, rejects, requests elevation for, ratifies or revokes a candidate.

## Required Delivery Report

Report status (`VERIFIED` only with all evidence), summary, files changed, migrations, contracts added/changed, exact tests/results, acceptance evidence/screenshots where applicable, deviations, known limitations, unlocked prompt, rollback/recovery instructions, compatibility/fixture expiry, and confirmation of no unrelated changes. Include branch/commit, diff summary and `git diff --check`.

## Stop Conditions

Stop as `BLOCKED` if a dependency is not `VERIFIED`; a non-ratified human decision or unavailable credential/infrastructure is required; migrations conflict; working-tree changes overlap; authorization would need weakening; canonical AOC contract cannot be determined; existing tests contradict P0 without authority; or scope exceeds this prompt. Use `IMPLEMENTED_NOT_VERIFIED` only when code exists but an acceptance command/environment remains incomplete; never continue a dependent prompt from that state.
