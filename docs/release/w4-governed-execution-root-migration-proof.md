# W4 Governed Execution Root — Migration Proof

Migration under certification: `supabase/migrations/20260909000000_ux_w4_governed_execution_root_membership.sql`

## 1. Decision

```
W4_HOSTED_MIGRATION_CERTIFICATION=PASS
HOSTED_APPLY_STATUS=READY_FOR_SEPARATE_AUTHORIZATION
```

The migration artifact is certified as safe and technically ready for a later hosted application. That is the whole of the claim.

- Certification does **not** mean the migration has been applied to a hosted database.
- Hosted application remains a separate operational authorization that has not been given.
- No deployment occurred as part of this certification.

## 2. Honesty statement (read first)

This certification was executed against an **isolated, disposable, official Supabase CLI local stack**, built from the repository baseline below. It is a real database: real migrations applied in real order by the real CLI, and real SQL executed against the installed function through the platform's own `authenticated`/`anon` roles and RLS.

What that is **not**: it is not a hosted Supabase project, and this document does not describe hosted testing. Behaviour observed on the local stack is evidence about the migration artifact, not evidence about any hosted environment's current state.

Exercised:

- Official Supabase CLI local stack (`supabase start`, `supabase db reset`, `supabase migration up`).
- Official database image `public.ecr.aws/supabase/postgres:17.6.1.165`, matching `supabase/config.toml` `major_version = 17`.
- A disposable certification project namespace, isolated from any other local stack.
- The full migration chain, the installed function's catalog definition, its authorization boundary, and its membership semantics under seeded canonical fixtures.

Not exercised:

- Any hosted Supabase project, hosted credentials, or hosted environment.
- Any application deployment.
- GoTrue-issued real JWTs (role and subject were set through the platform's documented request-claim settings).

The developer's pre-existing local `pmfreak` development stack was **not** reset, migrated, or otherwise mutated; a separate disposable stack was created specifically so that it would not be.

```
HOSTED_DATABASE_TOUCHED=NO
HOSTED_MIGRATION_APPLIED=NO
DEPLOY_PERFORMED=NO
```

## 3. Baseline / provenance

```
MAIN_SHA=b2d13cd4577651f6c7b34218497ba3088ea93ce2
PR_NUMBER=600
REVIEWED_W4_HEAD=eb88387af95c409de6a883c470e1dc02abd15a41
MIGRATION_FILE=20260909000000_ux_w4_governed_execution_root_membership.sql
PRE_W4_SCHEMA_VERSION=20260908000000_p2_02_attention_membership_snapshot
```

W4 was merged (PR #600), post-merge verified, and frozen **before** this certification began. The merge commit's tree is byte-identical to the reviewed head, so the artifact certified here is the artifact that was reviewed.

## 4. Environment

| Field | Value |
| --- | --- |
| Environment type | Isolated official Supabase CLI local stack (disposable) |
| Database image | `public.ecr.aws/supabase/postgres:17.6.1.165` |
| PostgreSQL major version | 17 (image reports PostgreSQL 17.6) |
| `supabase/config.toml` `major_version` | 17 (matches) |
| Supabase CLI | 2.117.0 (invoked via `npx`) |
| Node.js | v22.23.1 |
| Container runtime | Docker 29.7.2 |
| Repository baseline | `b2d13cd4577651f6c7b34218497ba3088ea93ce2` |
| Hosted access used | No |
| Existing local dev stack mutated | No |
| Sanitized project identifier | n/a — disposable local stack, torn down after the run |

No database URL, port, project reference, JWT, service-role key, or credential appears in this document.

## 5. Fresh migration chain

The project's canonical local-stack path was used (`supabase start` / `supabase db reset` / `supabase migration up`), not a hand-built schema and not an isolated application of the W4 file onto an ad-hoc database. The W4 migration was proved to apply **after its actual predecessor set**.

| Metric | Value |
| --- | --- |
| Migration files discovered | 163 |
| Applied in order | 163 / 163 |
| Ledger rows after apply | 163 |
| Skipped unexpectedly | 0 |
| Failed | 0 |
| Duplicate ledger versions | 0 |
| W4 ledger entries | 1 |
| Predecessor applied immediately before W4 | `20260908000000_p2_02_attention_membership_snapshot` |

```
FRESH_DATABASE_BOOT=PASS
FULL_MIGRATION_CHAIN_APPLY=PASS
W4_MIGRATION_APPLY=PASS
```

## 6. Migration scope proof

Scope was established by catalog differential, not by reading the migration source.

Procedure:

1. The W4 migration file was held back and the stack reset, producing a genuine **pre-W4** database at 162 migrations. The function and index were confirmed absent.
2. A full `public`-schema catalog snapshot was taken: relations (kind, RLS flag, ACL), columns (type, nullability, default), constraints, indexes, RLS policies, non-internal triggers, functions (security, volatility, `search_path`, ACL, body digest), function comments, and sequences.
3. The W4 migration was applied as a delta through the canonical CLI.
4. The snapshot was repeated and diffed.

The complete diff is three added lines. Nothing was modified or removed.

| Object class | Pre-W4 | Post-W4 | Delta |
| --- | ---: | ---: | ---: |
| Relations | 433 | 433 | 0 |
| Columns | 5,370 | 5,370 | 0 |
| Constraints | 2,245 | 2,245 | 0 |
| Indexes | 1,709 | 1,710 | +1 |
| RLS policies | 878 | 878 | 0 |
| Non-internal triggers | 93 | 93 | 0 |
| Functions | 92 | 93 | +1 |
| Function comments | 92 | 93 | +1 |
| Sequences | 0 | 0 | 0 |

```
TABLES_CREATED=0
TABLES_DROPPED=0
COLUMNS_ADDED=0
COLUMNS_DROPPED=0
RLS_POLICIES_CHANGED=0
TRIGGERS_CHANGED=0
WRITE_RPC_SEMANTICS_CHANGED=0

INDEXES_ADDED=1
FUNCTIONS_CREATED_OR_REPLACED=1
FUNCTION_COMMENTS_CHANGED=1
FUNCTION_GRANTS_CHANGED=YES
```

The migration-owned objects are exactly:

```
material_action_proposals_source_decision_idx
get_governed_execution_root(uuid, uuid)
```

Because the snapshot carries a body digest for every function in `public`, and no `FUN` line was *modified* by the diff — only added — **no existing function body changed**. Write-path RPC semantics in `public` are therefore provably untouched by this migration.

## 7. Installed function contract

Read from `pg_catalog` on the installed database, not from the migration text.

| Property | Installed value |
| --- | --- |
| Name | `get_governed_execution_root` |
| Arguments | `p_workspace_id uuid, p_project_id uuid` |
| Language | `plpgsql` |
| Returns | `jsonb` |
| Volatility | `STABLE` |
| Security | `INVOKER` |
| `search_path` | `public` (pinned via `proconfig`) |

Authorization guard, first statement in the body:

```
public.can_access_operational_project(p_workspace_id, p_project_id)
  → false raises exception 'execution_root_access_denied'
```

Grants:

```
PUBLIC_EXECUTE_REVOKED=YES
AUTHENTICATED_EXECUTE_GRANTED=YES
```

### Non-blocking ACL observation

The installed ACL is `postgres=X`, `anon=X`, `authenticated=X`, `service_role=X`. The migration revokes `EXECUTE` from `PUBLIC` and grants it to `authenticated`; the `anon` and `service_role` entries arrive from Supabase's default privileges on newly created functions, which a `REVOKE ... FROM public` does not cover.

This is recorded rather than omitted. It is assessed as non-blocking because:

- the same ACL shape is present on the function's own guard, `can_access_operational_project`, and on the W3 read function `get_operational_assurance_summary`, so it is the established pattern for guarded read functions in this schema, not W4-specific drift;
- several pre-existing functions in the same schema are looser still, retaining a `PUBLIC` execute entry that W4's function does not have (these are trigger functions rather than callable read endpoints, so this is offered as context, not as a peer comparison);
- the function is `SECURITY INVOKER`, so an `anon` caller carries no membership and every underlying table's RLS policy applies to it; and
- denial was confirmed **behaviourally**, not inferred: an `anon` caller with no subject receives `execution_root_access_denied`.

No security bypass is claimed or implied by the `anon` grant.

## 8. Authorization and isolation

Each case was exercised by calling the installed function under the relevant platform role and request claims.

| Case | Expected | Observed |
| --- | --- | --- |
| Member of the workspace → own workspace/project | membership returned | returned |
| User with no workspace membership → workspace/project | denied | `execution_root_access_denied` |
| Member of workspace B → workspace A / project A | denied | `execution_root_access_denied` |
| Member of workspace A → workspace B / project B | denied | `execution_root_access_denied` |
| Workspace A paired with a project belonging to workspace B | denied | `execution_root_access_denied` |
| `anon` role, no subject claim | denied | `execution_root_access_denied` |

```
AUTHORIZED_PROJECT_ACCESS=PASS
UNAUTHORIZED_PROJECT_ACCESS=PASS
CROSS_WORKSPACE_ISOLATION=PASS
CROSS_PROJECT_ISOLATION=PASS
```

Open decisions seeded in a sibling project and in a second workspace were confirmed absent from the queried project's membership set.

## 9. Authoritative membership semantics

The contract the function implements:

```
open(D)
⇔
D.decision_status ∈ {accepted, modified}
AND
(
  no Material Action exists for D
  OR
  at least one Action branch beneath D is unresolved
)
```

A branch is terminal when:

```
Outcome.state = superseded
OR
( Outcome.state ∈ resolved  AND  a canonical Outcome Observation exists )
```

Resolved result states:

```
achieved
partially_achieved
not_achieved
disputed
inconclusive
```

Pending result states:

```
expected
observing
```

This is deliberately not "active work". A Decision with no Action yet is open. A Decision whose result is known but never observed is open. A Decision whose result was negative or inconclusive but *was* observed is closed. Achievement is not a condition of closure; observation is.

Schema cardinality supporting the branch predicate was verified on the installed database: `execution_tasks_governed_action_uidx` enforces at most one governed Task per Action, and `canonical_task_outcomes_one_per_task` at most one Outcome per Task. A terminal Task/Outcome pair therefore cannot mask a second unresolved Task beneath the same Action.

## 10. Behavioural scenario matrix

Fixtures were seeded through normal schema constraints. Two session settings were used, and both are set by the canonical write paths themselves rather than invented for this test: `pmfreak.p2_07_canonical_dispatch`, which `dispatch_governed_action_to_internal_task` sets via `set_config` before creating a governed Task, and `pmfreak.p2_08_internal_execution`, which the P2-08 execution functions set before moving a governed Task's lifecycle state. Seeding additionally ran under the service-role audit identity that `reject_audit_mutation` requires for append-only tables. No constraint, trigger, or policy was disabled, dropped, or weakened to make any case constructible.

Each case calls the **installed** function as an authorized member and inspects the returned canonical Decision ids.

| Scenario | Expected root membership | Result |
| --- | ---: | --- |
| rejected Decision | no | PASS |
| accepted, no Action | yes | PASS |
| modified, no Action | yes | PASS |
| Action, no Task | yes | PASS |
| completed Execution, no Outcome | yes | PASS |
| Outcome `expected` | yes | PASS |
| Outcome `observing` | yes | PASS |
| resolved Outcome + Observation (all five resolved states) | no | PASS |
| resolved Outcome without Observation (all five resolved states) | yes | PASS |
| Outcome `superseded` | no | PASS |
| terminal branch + open sibling | yes | PASS |
| all terminal branches | no | PASS |
| running branch + terminal sibling | yes | PASS |
| open Decision in a sibling project | not in this project's set | PASS |
| open Decision in a second workspace | not in this project's set | PASS |

```
LIVE_DB_SCENARIOS=29
LIVE_DB_SCENARIOS_PASS=29
LIVE_DB_SCENARIOS_FAIL=0
```

Two cases are worth naming explicitly because they are the ones a weaker implementation gets wrong:

- **`observing` is constructible.** The `canonical_task_outcomes_state_check` constraint permits it, so this was tested as a real row rather than argued statically. It remains open.
- **Resolved-without-Observation is constructible.** No database constraint requires an Observation to accompany a resolved Outcome, so the state was built legitimately for all five resolved states. In every case the Decision **remains open**:

```
RESULT_KNOWN=YES
LEARNING_PROVEN=NO
CHAIN_COMPLETE=NO
```

This is the W4-R7 correctness case, and it is exercised against the database, not only in the application harness.

## 11. Multi-branch proof

This section exists because the W4 review found a false whole-chain closure defect: one terminal branch must never close a Decision that still has an unresolved sibling. These cases are therefore mandatory regression evidence, not optional coverage.

| Fixture | Expected | Result |
| --- | --- | --- |
| superseded branch + open sibling (no Task) | OPEN | PASS |
| observed result + unresolved sibling | OPEN | PASS |
| all branches superseded | CLOSED | PASS |
| observed + superseded | CLOSED | PASS |
| all branches observed | CLOSED | PASS |
| running branch + terminal sibling | OPEN | PASS |

```
MULTIBRANCH_TERMINAL_PLUS_OPEN=PASS
MULTIBRANCH_ALL_TERMINAL=PASS
```

Closure is a property of the whole chain, and the membership predicate expresses it as "at least one branch is unresolved" rather than as a property of any single branch.

## 12. Identity, ordering, and scale

The function returns both `openExecutionDecisions` (a count) and `openExecutionDecisionIds` (the authoritative id list). Completeness downstream is proved by identity, so the two must agree and the ids must be canonical and stable.

```
COUNT_EQUALS_ID_SET=PASS
CANONICAL_ID_DEDUPE=PASS
DETERMINISTIC_ORDER=PASS
```

Ordering, as specified by the installed function definition:

```
created_at DESC
id ASC
```

Equal-timestamp ties were tested behaviourally: three Decisions sharing one `created_at` instant were returned in ascending id order, and repeated invocations returned an identical id array.

Scale test — the database must return the entire authoritative set:

```
ADDITIONAL_OPEN_DECISIONS_SEEDED=600
TOTAL_OPEN_DECISIONS_IN_SCOPE=617
FUNCTION_COUNT=617
FUNCTION_IDS=617
DISTINCT_IDS=617
ORDER_MISMATCHES=0

SQL_MEMBERSHIP_CAP=NONE
SERVER_MEMBERSHIP_TRUNCATION=NO
SERVER_RETURNS_ALL_MEMBERS=YES
```

The installed body contains no `LIMIT`, `OFFSET`, `FETCH FIRST`, or row-number ceiling.

The application layer independently owns an explicit 500-member completeness ceiling and treats anything above it as UNPROVEN. That remains correct and unchanged: the ceiling is a deliberate client-side honesty boundary, and this section proves only that the ceiling is the *client's* and not a silent truncation in SQL.

## 13. Single-snapshot / MVCC proof

The remediated architecture is:

```
one function invocation
one SQL statement
one derived membership relation
count(*) and jsonb_agg(...) evaluated over that same relation
```

Because both aggregates are computed over a single derived table inside a single statement, they are read from one MVCC snapshot and cannot disagree at the source.

```
AUTHORITATIVE_MEMBERSHIP_SINGLE_STATEMENT=PASS
COUNT_AND_IDS_SAME_DERIVED_SET=PASS
CROSS_STATEMENT_UNION_PRESENT=NO
```

The defect this replaced: membership had been assembled as a union of three independent root queries. Around the canonical transition

```
running Execution → completion commit → expected Outcome
```

each of the three reads could legally observe a different snapshot — one after the Execution stopped being "running", another before the Outcome became visible — so their union could be empty even though the Decision was continuously open. Emptiness inferred from cardinality across statements is not a proof of absence. The architectural argument belongs to the W4 PR (#600); this document records only that the property was certified, not re-derived.

Regression control, run against the repository's adversarial MVCC harness:

```
OLD_COUNTEREXAMPLE_REPRODUCTION=PASS
NEW_ARCHITECTURE_REPAIR=PASS
```

The harness reproduces the legacy three-statement root returning an empty set under the interleaved snapshot, and shows the current single-statement root recovering the member and reporting the journey as open.

## 14. Index proof

```
INDEX_PRESENT=PASS
INDEX_NAME=material_action_proposals_source_decision_idx
INDEX_KEYS=workspace_id, project_id, source_decision_id
INDEX_UNIQUE=NO
DECISION_ACTION_CARDINALITY_PRESERVED=YES
INDEX_PLANNER_AVAILABLE=YES
```

Uniqueness was checked from `pg_index.indisunique` (false). This matters: a unique index on these keys would have silently converted Decision → Material Action from 1:N to 1:1. It does not.

A representative lookup shaped like the function's inner branch predicate produced an `Index Only Scan` using this index. Planner selection on a small fixture table is not the correctness condition and is not treated as one; the certified property is that the index is defined correctly and is available to the planner.

## 15. Replay characteristics

```
MIGRATION_LEDGER_REAPPLY_EXPECTED=NO
DDL_REPLAY_SAFE=YES
```

The repository uses timestamped, one-time, ordered migrations recorded in the Supabase migration ledger. Re-application is therefore **not** expected and its absence is not a defect: a second canonical `migration up` against the migrated database applied nothing, which is the correct behaviour.

Separately, and only inside an isolated certification context, the migration's DDL was evaluated a second time to confirm it is not destructive if that were ever to happen. It uses `create index if not exists`, `create or replace function`, `comment on`, `revoke`, and `grant`. The second evaluation produced **no catalog delta** and left the ledger unchanged.

This is evidence about the DDL's replay characteristics. It is not an instruction to manually replay migrations against any deployed database.

## 16. W3 compatibility

```
W3_ATTENTION_MEMBERSHIP_CONTRACT_PRESENT=YES
W3_FUNCTION_SIGNATURE_UNCHANGED=YES
W3_MIGRATION_CHAIN_STILL_APPLIES=YES
```

W3's `get_operational_assurance_summary(uuid, uuid)` is installed with an unchanged signature and unchanged properties (`INVOKER`, `STABLE`, `search_path=public`), was callable by an authorized member after the W4 apply, and does not appear as a modified line in the pre/post catalog diff.

W4 preserves the discipline W3 introduced: completeness is proved by canonical identity against a named membership set, never by a matching count, a successful request, or a cardinality that stayed under a ceiling.

## 17. Older-database fail-safe

A hosted database that has not applied this migration will not expose `get_governed_execution_root`. The hosted database was not probed during this certification, so the function's current hosted presence or absence is not independently verified. That state is designed for, and the design was verified against current `main` without modifying any code.

```
W4 RPC unavailable
→ executionRootSnapshot = null
→ frozenExecutionMembershipIds = null
→ governedExecutionRootComplete = false
→ surface remains UNPROVEN
```

In `src/lib/operational-flow/operational-flow-service.ts`, the `get_governed_execution_root` call is deliberately excluded from the result set whose errors throw, so an older database degrades instead of failing to render. `governedExecutionRootComplete` is a conjunction that requires a server instant, a named frozen membership set, an agreeing count, and zero missing members — any absence makes it `false`. The command-center layout then treats `governedExecutionRootComplete !== true` as incomplete.

The consequence is the intended one: the page remains usable, and it makes **no** definitive empty-state claim and **no** completeness claim while the projection is absent.

```
OLDER_DB_FAIL_SAFE=PASS
```

This is a safe degradation, not a bug, and it persists until the migration is applied under separate authorization.

## 18. Test evidence

| Suite / check | Result |
| --- | --- |
| W4 migration / journey / execution-root suite (`tests/ux-w4-decision-execution-loop.test.mjs`) | 53 / 53 PASS |
| Live-database membership scenarios (this certification) | 29 / 29 PASS, 0 FAIL |
| Live-database scale membership | 600 additional seeded, 617 open in scope, 617 returned, 617 distinct |
| W3 regression (`tests/ux-w3-needs-you-interaction-quality.test.mjs`) | 94 / 94 PASS |
| Fresh-DB migration inventory (`tests/fresh-db-migrations-inventory.test.mjs`) | 11 / 11 PASS |
| Fresh-DB migration safety guard (`tests/fresh-db-migrations-safety-guard.test.mjs`) | 303 PASS / 1 SKIP |
| DB schema contract (`tests/db-schema-contract.test.mjs`) | 16 / 16 PASS |
| `check:fresh-db-migrations` (verify-only mode) | PASS — inventory and ordering |
| `check:security-definer-hardening` | PASS |
| `check:db-contract` | PASS |

The single skipped safety-guard case is `runNpx refuses arguments carrying cmd.exe metacharacters`, a Windows-only branch that does not execute on Linux. It is an environment-conditional skip, not a migration-content failure.

No test was weakened or modified for this certification, and no additional test was deliberately skipped. The single skip reported above is the suite's existing environment-conditional Windows-only case.

## 19. Change control

```
SOURCE_FILES_CHANGED_DURING_CERTIFICATION=0
COMMITS_CREATED=0
PUSHES=0

HOSTED_DATABASE_TOUCHED=NO
HOSTED_MIGRATION_APPLIED=NO
DEPLOY_PERFORMED=NO
W5_STARTED=NO
```

The database certification — stack boot, migration chain, catalog snapshots, and all seeded fixtures — ran against a disposable copy of the baseline tree in a scratch location, on a disposable local stack that was torn down after the run. The repository test suites and static checks listed in section 18 were executed read-only from the frozen W4 worktree, whose tree is byte-identical to `main` at the baseline SHA; that worktree remained clean at the reviewed head throughout.

The certification run itself modified no repository worktree and created no branch, worktree, or commit. The merged remote feature branch remains deleted, and W3 and the historical worktrees were not touched.

This document was subsequently authored on a dedicated documentation-only branch checked out from the certified baseline SHA, so that the proof does not land on the frozen W4 branch. It is the only file added, and no commit was created for it.

Out of scope, recorded only so it is not mistaken for certification output: the historical main-repo checkout carries four untracked files predating this work (`docs/ux/pass-4-implementation-plan.md` and three `p0-launch-06-hosted-structural-recertification.*` artifacts). They are unrelated to W4, form no part of this evidence, and were neither modified nor removed.

## 20. Certification decision / next gate

```
W4_HOSTED_MIGRATION_CERTIFICATION=PASS

HOSTED_APPLY_STATUS=READY_FOR_SEPARATE_AUTHORIZATION

HOSTED_DATABASE_TOUCHED=NO
HOSTED_MIGRATION_APPLIED=NO
DEPLOY_PERFORMED=NO
```

> This document certifies the migration artifact and its behaviour on an isolated local stack. It does not authorize, perform, or claim a hosted database change. Hosted migration application is a separate operational decision.

If the hosted database has not applied this migration, the application degrades through the certified fail-safe path described in section 17: `governedExecutionRootComplete=false`, execution membership UNPROVEN, and no false completeness or false empty-state claim.

Residual risk and what remains unverified:

- **Hosted apply is unverified by construction.** Hosted apply duration and lock behaviour under production load were not measured. The migration creates one non-unique index using ordinary `CREATE INDEX` rather than `CREATE INDEX CONCURRENTLY`, so lock behaviour and table size should be treated as explicit operational considerations before hosted apply. The function addition itself is read-only.
- **Hosted ACL defaults are unverified.** The `anon` execute grant described in section 7 was observed on the local stack. A hosted project's default privileges should be re-read after apply if that grant is considered material.
- **The local stack is not GoTrue-backed for claims.** Role and subject were supplied through documented request-claim settings rather than by issuing real tokens.
- **`HOSTED_FRESH_APPLY_VERIFIED=NO`** remains the correct recorded state.
