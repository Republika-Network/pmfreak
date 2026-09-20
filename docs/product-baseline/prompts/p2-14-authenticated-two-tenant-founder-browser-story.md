# P2-14 — Authenticated Two-Tenant Founder Browser Story

## Prompt Metadata

- **Prompt ID:** P2-14
- **Work Package:** WP7
- **Title:** Authenticated Two-Tenant Founder Browser Story
- **Phase:** Founder Invite
- **Primary Track:** Track D
- **Parallelizable:** no
- **Depends On:** P2-12 and P2-13 VERIFIED
- **Unlocks:** P2-15
- **Risk Level:** high
- **Expected Review Size:** large
- **Status:** `VERIFIED` — `D1-INVITE-ACCEPT-LAYOUT-RACE` and the P2-10 dependency repaired under authorization; verified on committed SHA `0fd86b561326c7895980fffb5c47c8aa6b8585c5` 2026-09-20. See Verification Evidence — 2026-09-19 (initial blocker) and Post-Repair Verification — 2026-09-20. (Previously recorded `NOT_STARTED`: stale metadata; the 2026-09-19 exact-head pass recorded `BLOCKED`.)
- **Migration:** no; forward-only, additive if used; destructive changes prohibited.

## Role

Act as the implementation owner for this bounded vertical increment. Read `../PMFREAK_PRODUCT_BASELINE_V2.md`, `../PMFREAK_FOCUSED_ASSESSMENT_P1.md`, and `../PMFREAK_SEQUENTIAL_BUILD_PLAN_P2.md` first. Preserve P0 target, P1 observed state, and ratified D1–D7. Start by recording branch, HEAD, working tree and applicable `AGENTS.md` instructions.

## Product Outcome

An invited user refreshes session, enters the correct Workspace/Project and completes all 17 Founder steps while another tenant cannot read or mutate them.

## Current State and Evidence

- **Reusable:** tests/e2e/ or repository browser harness; scripts/; docs/; auth/workspace regression tests.
- **Partial:** P1 proves substantial components but no complete commercial chain.
- **Conflicting:** governed `operational_decision_records` coexists with legacy recommendation, `project_decisions`, task-draft and agent decision models.
- **Missing for this increment:** Implement browser/runtime E2E, session refresh, invite, IDOR/RLS negatives, fixture label and screenshots; no product behavior shortcuts.
- **Candidate adapters:** prefer existing services/ports in the listed areas; inventory consumers before adding a parallel model.

## Scope

Implement browser/runtime E2E, session refresh, invite, IDOR/RLS negatives, fixture label and screenshots; no product behavior shortcuts. End when this outcome is behaviorally tested and independently reviewable; do not absorb downstream prompts.

## Non-Goals

No broad redesign, external provider rollout, historical-model deletion, unrelated refactor, remote decision writeback, or implementation of later WP outcomes. Documentation alone is not completion.

## Dependencies and Preconditions

Required state: P2-12 and P2-13 VERIFIED. Every dependency must be `VERIFIED`; a contract-based parallel start is allowed only where metadata says so. Use an isolated development database for migrations/runtime tests. D1–D7 are ratified. Any fixture must say `DEMO / FIXTURE`, conform to the verified contract, and expire when P2-15 becomes verified. Inspect migration ordering and overlapping working-tree changes before editing.

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
npx tsx --test tests/pmf-001-002-auth-session-visibility.test.mjs tests/invite-workspace-role-boundary.test.mjs
npm run typecheck
npm run lint
git diff --check
```

For migration/operational-flow scope also run `npm run check:operational-flow-db` against isolated infrastructure. For AOC scope run `npm run check:aoc-boundaries && npm run check:no-local-auth-bypass`. For UI/high-risk integration run `npm run build` and the repository browser/runtime scenario added by this prompt. Expected result: the Product Outcome is observable, negative/degraded cases pass, no unrelated regression occurs, and evidence is attached. Do not mark `VERIFIED` if an applicable command is skipped.

## Files Expected to Change

Expected areas: `tests/e2e/ or repository browser harness; scripts/; docs/; auth/workspace regression tests`. Tests and narrowly scoped docs may change. Adjust paths only when better repository evidence is found and justify every deviation. Migration files, if needed, must be new and forward-only.

## Prohibited Changes

Do not enable remote writeback; delete/fuse legacy models; bypass AOC or membership/RLS; use zero/placeholder hashes; insert Evidence directly where Raw/Event is required; auto-create downstream canonical states; treat Task completion as Outcome; show fixtures as live; hardcode success; weaken tenant isolation; run destructive migration; redesign unrelated UI; or modify unrelated CI/dependencies.

## Verification Evidence — 2026-09-19

Exact-head reconciliation run. Status earlier in this file was historical/stale metadata; it is superseded here, not rewritten.

- **SHA:** `95c928b2ceb8f0f40465965c751ef9c3230a1d8c` (`origin/main`, merge of #613), plus the P2-14 spec reconciliation recorded under P2-14.
- **Environment:** native Linux scratch clone at that SHA; Node v22.23.1 / npm 10.9.8 (`npm ci`); local Supabase `127.0.0.1:54321`/`54322`, 165/165 migrations through `20260911000000`; Frontera `@aoc-enterprise/runtime` 1.2.1 on a disposable OS-temp SQLite store.

- **Result:** `BLOCKED`. The browser journey is green, but P2-14 cannot be `VERIFIED` for two reasons:
  - its dependency P2-12 is `BLOCKED`;
  - `D1-INVITE-ACCEPT-LAYOUT-RACE`, a product consistency defect on the invite path (historical Founder step 1), is open.
- **Browser, real Chromium:** `seed:p2-13-founder -- reseed` → `provision:founder-frontera` → `npm run test:e2e:p2-14`. Two clean cycles, each on a fresh Frontera store, each **38/38 pass**, nothing skipped.
  - That is 31 founder-story tests plus 7 session-continuity tests.
  - STEP_12 carried a real `enforcement-decision-<uuid>` minted by `AocKernel.evaluate()`.
  - `npm run check:p2-14-db` — PASS, 38 assertions.
  - `npx tsx --test tests/pmf-001-002-auth-session-visibility.test.mjs tests/invite-workspace-role-boundary.test.mjs` — 32/32 pass.
- **17-step reconciliation.** The spec header claimed "the repository contains no independently enumerated historical 1–17 list". That was **inaccurate**: the list is in `PMFREAK_FOCUSED_ASSESSMENT_P1.md` ("Founder Invite Scenario Assessment"). The header now maps each historical step to executable checkpoints.
  - Historical step 16 ("PM sees result, why, next") had no browser assertion. STEP_16c was added. It asserts the closed journey card:
    - `loop_closed`;
    - "The expected result was achieved.";
    - "why" is the Decision's own rationale;
    - no fabricated next step.
  - No existing checkpoint was renumbered or removed.
- **Spec reconciliations**, each tracking an intentional product change:
  - STEP_07/08: exact heading names. UX-W3 added "Evidence & governance", which made the "Evidence" locator ambiguous. The label's "How PMFreak got here" claim is now actually asserted.
  - STEP_16: UX-W0 removed the DEMO/LIVE choice from customer intake, so it is now always LIVE. The test now asserts no DEMO / FIXTURE choice is offered. Every DB assertion (LIVE `fixture_state`, server-selected `live-observation:v1`, `is_fixture=false`, fixture lineage untouched) is unchanged.
  - ACCESSIBILITY: UX-W4 made the chain card a container around its `…-open` button, so focus now targets that button. The focused and Enter-activates assertions are unchanged.
- **D1 (`D1-INVITE-ACCEPT-LAYOUT-RACE`).**
  - `(protected)/layout.tsx` renders concurrently with `accept-invite/[token]/page.tsx`. For an invitee with no membership, the layout bootstraps a personal workspace and issues its onboarding redirect while `acceptWorkspaceInvite` may still be in flight.
  - Reproduced against the real route: 17 of 17 responses were the layout's `/projects/new`, never `/team`. In 1 of 17, the 3xx arrived before the invited membership committed. 17 of 17 created a stray personal workspace.
  - An email-mismatched invite also returned 307 → `/projects/new`, never showed its error, and left the invite `pending`.
  - Smallest proposed repair (product source; separate authorization): have `(protected)/layout.tsx` bypass workspace resolution and the onboarding redirect for `/accept-invite/*`, or move the route into its own route group with an auth-only layout. Then tighten the P0-LAUNCH-06 D1 assertion to exactly `/team`.

## Exact-head post-repair verification — 2026-09-20

**Verified executable candidate SHA: `0fd86b561326c7895980fffb5c47c8aa6b8585c5` (C4).**

Chronology, so the record is not read backwards: `95c928b2` is the exact-main baseline on which the blockers were discovered and reproduced — never a SHA carrying the repairs. C1–C3 are the Founder/G2/G3 repair candidate. Exact-head validation of that candidate then surfaced a *pre-existing* governance defect (a revoked Material Action could still be dispatched into a Task and could still start), which reproduces identically at `95c928b2`; C4 repairs it and is the SHA every result in this section was verified on.

Both blockers recorded above were repaired under explicit authorization: the P2-10 lineage defect, and `D1-INVITE-ACCEPT-LAYOUT-RACE` on the invite path (historical Founder step 1).

Verified on committed SHA `0fd86b561326c7895980fffb5c47c8aa6b8585c5` (C4 = C1+C2+C3+C4), checked out clean with none of this reconciliation's documentation edits present. Same local environment as the 2026-09-19 pass: Node v22.23.1 / npm 10.9.8, local Supabase `127.0.0.1:54321`/`54322` at migration head `20260911000000` (165/165, unchanged — no migration was added), Frontera `@aoc-enterprise/runtime` 1.2.1 on a fresh disposable OS-temp store.

- **Repair (product):** `src/app/(protected)/layout.tsx` now exempts the workspace invite-acceptance route family from WORKSPACE ONBOARDING only, immediately after authentication is established and before any workspace resolution, onboarding state or shell setup. The predicate `isWorkspaceInviteAcceptancePath` lives beside the link this product mints (`src/lib/workspace-team.ts`), so the route and its recogniser cannot drift apart; it matches only `/accept-invite/<single non-empty token>` and deliberately not the separate early-access `/accept-invite?token=` surface. No migration, schema or RLS change.
- **Authentication is not weakened:** `assertRuntimeAuthContinuity` still runs before the exemption, the page still calls `requireAuthUser`, validates the token server-side, enforces the invite email match, status, expiry and role, applies both the per-IP and per-token abuse limits, and keeps single-use semantics. Workspace, role and invited email are still read only from the invitation record.
- **Live acceptance proof, 12 fresh invitees** through the real route, each with zero prior memberships:
  - `/team` redirect: **12/12** (was 0/17 — the layout answered every time);
  - membership already committed when the response returned: **12/12** (was 16/17);
  - invited role bound from the invitation record: 12/12; invite consumed: 12/12;
  - stray personal workspace bootstrapped: **0/12** (was 17/17).
- **Email mismatch:** no `/projects/new` redirect, no membership, no stray workspace, the invitation remains `pending`, and the page's own refusal is what the caller receives. The page's pre-existing generic-error policy was not changed.
- **Existing negatives all still pass** (181 assertions): abuse-protection boundary, invite/workspace role boundary, early-access invite email boundary, route-guard consistency, invite token hashing, canonical onboarding, onboarding-state resolution, archived-workspace gate, onboarding guardrails, auth-session persistence and visibility.
- **New regression cover:** `tests/invite-acceptance-onboarding-isolation.test.ts` (7 tests) pins the exemption to exactly one path family, orders it after authentication and before every workspace/onboarding call, requires it to render the page rather than redirect, and asserts the page-level controls the exemption now depends on. Removing the exemption fails 3 of them.
- **Rehearsal assertion tightened** (`tests/acceptance/p0-launch-06-beta-release-rehearsal.test.ts`): D1 now requires exactly `/team` instead of a set that included the onboarding destinations, and requires zero memberships outside the invited tenant instead of tolerating a bootstrapped one. The rehearsal passes 28/28 under the stricter contract.
- **Browser:** 38/38 in real Chromium on the exact candidate SHA `0fd86b561326c7895980fffb5c47c8aa6b8585c5`, and repeatedly across the repair cycles, nothing skipped; all 17 historical Founder steps mapped, real `fronteraDecisionId` minted per run, two-tenant negatives, accessibility and three responsive widths.
- **Post-repair status:** `VERIFIED` on `0fd86b561326c7895980fffb5c47c8aa6b8585c5`.

## Required Delivery Report

Report status (`VERIFIED` only with all evidence), summary, files changed, migrations, contracts added/changed, exact tests/results, acceptance evidence/screenshots where applicable, deviations, known limitations, unlocked prompt, rollback/recovery instructions, compatibility/fixture expiry, and confirmation of no unrelated changes. Include branch/commit, diff summary and `git diff --check`.

## Stop Conditions

Stop as `BLOCKED` if a dependency is not `VERIFIED`; a non-ratified human decision or unavailable credential/infrastructure is required; migrations conflict; working-tree changes overlap; authorization would need weakening; canonical AOC contract cannot be determined; existing tests contradict P0 without authority; or scope exceeds this prompt. Use `IMPLEMENTED_NOT_VERIFIED` only when code exists but an acceptance command/environment remains incomplete; never continue a dependent prompt from that state.
