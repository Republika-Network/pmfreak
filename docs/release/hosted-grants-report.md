# Hosted Grants Report — SECURITY DEFINER EXECUTE privileges

## Status: source model corrected and enforced; hosted re-verification still required

**Supersedes the Perilla 13B / RR-MIGRATE revision of this document, whose
central claim was false.** That revision stated:

> "the migrations, if applied in order to an empty database, would not leave
> any SECURITY DEFINER function reachable by `anon`/PUBLIC by accident."

Gate 2 applied exactly those 163 migrations, in order, to an empty hosted
project and disproved it. A live Supabase Security Advisor run against the
freshly migrated canonical project reported **26 SECURITY DEFINER functions
executable by `anon`** and **28 executable by `authenticated`**.

That earlier revision *did* correctly disclaim being a live check. But the risk
it disclaimed — "a manual `grant`/`revoke` run outside a migration would not be
visible here" — is precisely the thing that **did not happen**. It caveated the
wrong hazard while affirming the wrong claim. Replaying the migration chain from
source reproduces 26 / 28 / 43 exactly, so the hosted findings were the
designed-in result of the canonical chain, not drift.

## The correction: four principals, not two

> **On Supabase, `PUBLIC`, `anon`, `authenticated` and `service_role` are four
> DISTINCT privilege principals. `REVOKE EXECUTE ... FROM PUBLIC` does NOT
> revoke an explicit EXECUTE privilege from `anon` or from `authenticated`.**

The platform bootstrap runs, in effect:

```sql
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
```

This repository already certifies that fact: `STOCK_DEFAULT_ACL` in
[`scripts/check-fresh-db-migrations.mjs`](../../scripts/check-fresh-db-migrations.mjs)
records `anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres`
for `objtype: "f"` in schema `public`. Every function created in `public`
therefore carries its **own explicit per-role ACL entries** for `anon` and
`authenticated`, separate from the PUBLIC pseudo-role entry `=X/owner`. A
revoke aimed at PUBLIC removes only that one entry.

The proof is a clean 1:1 correspondence. Across the 163 canonical migrations
there is **no** `GRANT ... TO anon` on any function, and exactly **four**
function-level `REVOKE ... FROM anon`:

| Migration | Function | Flagged by the advisor? |
| --- | --- | --- |
| `20260819000000:65` | `abuse_rate_limit_increment` | No |
| `20260828000000:487` | `founder_program_transition` | No |
| `20260903000000:187` | `persist_governed_material_action` | No |
| `20260903000000:189` | `revoke_governed_material_action` | No |

30 SECURITY DEFINER functions − those 4 = **26**, the advisor's exact count.

The insight was not new to this codebase — only misapplied. `20260826000000_fix_agent_attestation_nonces_grants.sql`
names the same mechanism for **tables** ("on a hosted Supabase project, default
privileges give anon/authenticated full DML on newly created public tables …
Verified live") and fixes it correctly with `revoke ... from anon, authenticated`.
It was never carried across to **functions**. `20260905000000` contains both
patterns 178 lines apart: `revoke all on public.internal_task_executions from
anon, authenticated` at line 47, and `revoke all on function
public.p2_08_validate_execution_governance(uuid, uuid) from public` at line 225.

## Inventory: 30 SECURITY DEFINER functions (was 18)

The previous revision reported **18**. The corpus has since grown; the current
canonical chain ends at `20260909000000` with **30** final SECURITY DEFINER
functions in schema `public`, no overloaded names, and **all 30 pinning
`search_path`**.

## The intended matrix

The authority is [`supabase/security/security-definer-grant-matrix.json`](../../supabase/security/security-definer-grant-matrix.json),
which declares, per identity signature, the intended EXECUTE privilege for all
four principals plus an `intended_caller` classification and a written
rationale.

```
SECURITY_DEFINER_TOTAL     = 30
PUBLIC_EXECUTABLE          = 0
ANON_EXECUTABLE            = 0
AUTHENTICATED_EXECUTABLE   = 23
SERVICE_ROLE_EXECUTABLE    = 30
```

| `intended_caller` | Count | Contract |
| --- | --- | --- |
| `authenticated_rls_helper` | 7 | Referenced by RLS policy expressions. A policy expression is evaluated with the **caller's** privileges, so `authenticated` EXECUTE is **load-bearing** — revoking it breaks tenant isolation rather than tightening it. |
| `authenticated_rpc` | 16 | Invoked from application code via `createSupabaseServerClient` (anon key + session cookie → `authenticated`). Each re-derives authority server-side from `auth.uid()`; caller-supplied workspace/project/actor parameters are never trusted. |
| `service_role` | 3 | `abuse_rate_limit_increment`, `founder_program_transition`, `purge_expired_nonces`. No client role may execute. |
| `internal_security_definer_only` | 3 | `operational_workspace_role`, `operational_authority_evaluation`, `p2_08_validate_execution_governance`. Their primary legitimate invocation path is **from other SECURITY DEFINER functions**, which execute as the function owner and therefore need no client-role grant. Direct client EXECUTE is denied; `service_role` EXECUTE remains explicitly granted for operational and administrative access, not because a `service_role` caller is the routine path. |
| `trigger_only` | 1 | `prepare_decision_evidence_link()`. See below. |

### `anon` is never intentional

No migration grants EXECUTE to `anon` on any function; no application call site
invokes a SECURITY DEFINER function through an anon-role client. `ANON_EXECUTABLE`
is 0 by design, and the matrix has no mechanism to declare otherwise without an
explicit, reviewed edit.

### The trigger-only exception

`prepare_decision_evidence_link()` returns `trigger` and is bound to
`trg_prepare_decision_evidence_link` (`BEFORE INSERT` on
`public.decision_evidence_links`). PostgreSQL refuses direct invocation of a
trigger function regardless of EXECUTE ("trigger functions can only be called as
triggers"), and PostgREST excludes trigger-returning functions from the `/rpc/`
surface entirely. Its historical PUBLIC grant was therefore a **static linter
finding with no corresponding callable privilege boundary**. It is revoked in the
remediation as privilege hygiene, **not** as remediation of an exploitable RPC.
Trigger execution is unaffected: triggers run as the table owner and do not
consult the client role's EXECUTE privilege. This exception applies to this one
function and must never be extended to an ordinary function.

## Severity of the 26 anon findings

Twenty-four of the twenty-five non-trigger cases were **defence-in-depth
failures, not privilege escalation**. Two internal barriers held: the P2-era
RPCs open with `if v_actor is null then raise exception '..._unauthenticated'`,
and the older family gates on membership predicates resolving through
`wm.user_id = auth.uid()`, which degenerates to false for `anon`.

One case was materially different. `purge_expired_nonces()` is
`language sql`, `security definer`, has **no caller check of any kind**, and was
`anon`-executable — an unauthenticated, unrate-limited `delete` against the
replay-protection store, reachable with only the publishable anon key. Because
it is SECURITY DEFINER it executes as the owner and therefore **bypassed the
table-level `revoke ... from anon, authenticated` that `20260826000000` applied
to `agent_attestation_nonces`**. That table's grant boundary and this function's
grant gap were never reconciled. Impact was bounded (it deletes only
already-expired rows), but the control was defeated.

Secondary: `p2_08_validate_execution_governance` returns distinct `failureClass`
values, giving `anon` a task-UUID existence-and-state oracle.

## Remediation mechanism

Forward-only. No historical migration is edited.

1. **[`supabase/migrations/20260910000000_security_definer_effective_grant_hardening.sql`](../../supabase/migrations/20260910000000_security_definer_effective_grant_hardening.sql)**
   declares the complete intended matrix as one explicit revoke-then-grant pair
   per function, addressing each by its exact identity signature — 30 revokes,
   30 grants. `anon` is revoked from all 30; `authenticated` from the 7 that must
   not have it; `authenticated` is re-granted to the 23 that must; `service_role`
   is asserted on all 30. Idempotent and re-runnable.
2. **[`supabase/security/security-definer-grant-matrix.json`](../../supabase/security/security-definer-grant-matrix.json)**
   is the declarative authority for intent.
3. **[`scripts/check-security-definer-hardening.mjs`](../../scripts/check-security-definer-hardening.mjs)**
   was rewritten from a lexical test into an ordered effective-state
   reconstruction, and diffs its result against the matrix.
4. **[`scripts/check-fresh-db-migrations.mjs`](../../scripts/check-fresh-db-migrations.mjs)**
   gained a post-apply certification that reads real `pg_proc` ACLs and diffs
   them against the same matrix.

### What the rewritten checker fixes

The previous implementation asked one lexical question per function — does the
string `revoke all on function <name>(` appear anywhere in the corpus? — and
reported PASS. Seven structural defects made that unable to prove anything about
privileges:

1. No role modelling at all; `hasPublicRevoke` was the entire grant logic.
2. The regex terminated at the open paren, so it never checked the target role —
   `revoke all on function f(uuid) from service_role;` satisfied "has a PUBLIC revoke".
3. No ordering: the corpus was `join("\n")`-ed, so a later `GRANT ... TO anon` was invisible.
4. `DROP FUNCTION` was unmodelled, so a drop+recreate silently restored platform defaults.
5. Overloads collapsed by bare name, so one revoked overload certified all of them.
6. `hasSearchPath` was OR-unioned across all definitions, so an early pinned definition masked a later unpinned one.
7. Unparseable definitions were silently skipped rather than failing.

The rewrite replays migrations in canonical order; identifies functions by
schema + name + identity argument types; seeds each `CREATE` from the certified
platform default ACL; preserves the ACL across `CREATE OR REPLACE` and resets it
across `DROP` + `CREATE`; applies `GRANT`/`REVOKE` per named principal; and
**fails closed** on anything it cannot model exactly — `ALTER FUNCTION`,
`ALTER ROUTINE`, `ALTER DEFAULT PRIVILEGES`, `ON ALL FUNCTIONS IN SCHEMA`,
unrecognised grantee roles, unsupported identity-argument syntax and
unterminated dollar-quoted bodies. None of those constructs exist in the corpus
today; if one is introduced, the checker must be extended before the gate can
pass again.

The assumption `REVOKE FROM PUBLIC == anon denied` is retired, and
`tests/security-definer-hardening.test.mjs` now asserts the opposite explicitly
so it cannot be reintroduced.

## Out of scope here

The 43 mutable-`search_path` advisor warnings are a **disjoint** defect: every
one is a SECURITY INVOKER function, and all 30 SECURITY DEFINER functions pin
`search_path`. The audit classified them `CRITICAL=0`,
`HARDEN_RECOMMENDED=8`, `ACCEPTABLE_WITH_RATIONALE=35`. That cleanup is separate,
non-blocking follow-up work and is deliberately not bundled with this
security-critical diff.

RLS on `public.agent_attestation_nonces` remains intentionally disabled
(service-role-only by design, `20260826000000`); the `purge_expired_nonces`
revoke above is what closes the SECURITY DEFINER bypass of that boundary.

## To complete this report for real

The static and fresh-DB layers are now enforced in CI. What remains is hosted
re-verification, which must be a separate, explicitly authorized step — **no
manual `REVOKE` in the SQL editor, no `apply_migration`, no `migration repair`,
no `db reset`, no editing historical migrations**:

1. Apply `20260910000000` to the canonical project through the reviewed
   `source migration → tests → review → fresh/local certification → reviewed apply`
   path.
2. Run, against the linked project:
   ```sql
   select 'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature,
          p.prosecdef, p.proconfig,
          exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_execute,
          has_function_privilege('anon',          p.oid, 'execute') as anon_can_execute,
          has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
          has_function_privilege('service_role',  p.oid, 'execute') as service_role_can_execute
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
   order by 1;
   ```
3. Confirm the result matches `security-definer-grant-matrix.json` exactly:
   PUBLIC 0, anon 0, authenticated 23, service_role 30.
4. Confirm the Security Advisor reports 0 anon-executable SECURITY DEFINER
   functions.
5. Update this status line to "live-verified" with the query output attached,
   redacted of project-identifying detail.

**Gate 3 remains BLOCKED until step 5 is complete.**
