# Hosted Supabase Migration Proof — Perilla 13B, executed at P0-LAUNCH-06

## Status: EXECUTED (P0-LAUNCH-06) — scoped

**The hosted fresh apply has been executed and RR-MIGRATE is RESOLVED.**

```
HOSTED_TARGET_REF=ecwkldflddnmdwusatuh   (pmfreak-migration-validation, disposable)
HOSTED_FRESH_APPLY=PASS
HOSTED_MIGRATIONS_APPLIED=161/161
HOSTED_PENDING_MIGRATIONS=0
HOSTED_UNEXPECTED_MIGRATIONS=0
LOCAL_REMOTE_MIGRATION_COUNT_MATCH=YES
HOSTED_MANUAL_REPAIR=NO
RR_MIGRATE=RESOLVED
```

No `migration repair` was used, and no manual intervention manufactured the
successful result. The active PMFreak project (`refvllnadfzjkxlpidrr`) was never
a target and was never contacted.

**This closure is deliberately SCOPED.** What is proven here is the hosted
*fresh migration execution*. It is NOT a hosted RLS/role-matrix/grants
certification, and it is NOT a deployment-topology certification. The rows still
marked NOT EXECUTED in the result table below remain genuinely unexecuted on
hosted — see them, not this heading, for what is and is not covered:

```
HOSTED_DATA_TIER_CERTIFICATION=PASS_FOR_FRESH_MIGRATION_AND_LOGICAL_BACKUP_RECOVERABILITY
HOSTED_PLATFORM_RESTORE_REHEARSAL=NOT_PERFORMED
FULL_BETA_DEPLOYMENT_TOPOLOGY_CERTIFIED=NO
```

The companion logical-backup/recoverability evidence is in
[`backup-restore-drill.md`](./backup-restore-drill.md) (RR-BACKUP).

### How the migration count was established, and re-verified

The hosted apply was verified with `supabase migration list --linked` against
`ecwkldflddnmdwusatuh`: 161 rows, every row matched local+remote, 0 remote-pending,
0 remote-unexpected.

That verification initially produced a FALSE NEGATIVE. The repeatability parser in
`scripts/check-fresh-db-migrations.mjs` accepted only bare 14-digit timestamps, while
the installed Supabase CLI (2.116.0) emits them backtick-wrapped:

```
`20260428120000` | `20260428120000` | 2026-04-28 12:00:00
```

The old row regex matched **zero** rows against that output and therefore reported all
161 local migrations as remote-pending. The parser now accepts both renderings and has
regression controls for each; the hosted state was never at fault.

The 161-version chain is independently re-verifiable **offline** from the migration
history dumped out of the hosted project itself
(`history_data.sql`, sha256 `fe243d1908d10b65609b6dd466c76b4e4040c7c9bef0966f5e22b0773a7af0fd`,
retained locally and never committed). Set-comparing the versions in that hosted dump
against `supabase/migrations/*.sql`:

```
hosted distinct versions = 161      local distinct versions = 161
min = 20260428120000                max = 20260907000000    (identical on both sides)
in local but not hosted  = 0        in hosted but not local = 0
```

## Historical context (Perilla 13B, superseded by the above)

At Perilla 13B no hosted Supabase project or credentials were available, so this
document was written as an execution plan and evidence template rather than closure
evidence, and RR-MIGRATE was correctly held OPEN at that time. The plan below is
retained because it is the procedure that was ultimately followed. See
[`fresh-database-migration-proof.md`](./fresh-database-migration-proof.md) for the
local PostgreSQL 16 evidence gathered before hosted access existed.

## What exists today, ready to run the moment credentials are available

| Prerequisite | Status |
| --- | --- |
| Hosted-mode code path in `scripts/check-fresh-db-migrations.mjs` | Ready — `link`, `db push`, and (new, Perilla 13B) post-push repeatability verification via `supabase migration list --linked` |
| Safety guard (project-ref match, destructive-confirmation, production-host rejection) | Ready — behavioral tests in `tests/fresh-db-migrations-safety-guard.test.mjs` (Perilla 13B) |
| Migration files | 146 (144 at Perilla 13 close + 2 Perilla 13B SECURITY DEFINER hardening fixes — see [`hosted-grants-report.md`](./hosted-grants-report.md)) |
| RPC inventory (static) | Done — [`hosted-rpc-signature-report.md`](./hosted-rpc-signature-report.md) |
| SECURITY DEFINER / grants review (static) | Done — [`hosted-grants-report.md`](./hosted-grants-report.md) |
| Runbook | [`database-bootstrap-runbook.md`](./database-bootstrap-runbook.md) §1 "Hosted Supabase (preferred)" |

## Execution plan (to run when credentials are available)

1. Create a new, empty, isolated Supabase project dedicated to this test
   (suggested name: `pmfreak-migration-validation`). Never reuse pilot,
   staging, or any project with real data.
2. Export (never commit) the required variables:
   ```bash
   export SUPABASE_PROJECT_REF=<ref>
   export FRESH_DB_EXPECTED_PROJECT_REF=<ref>   # must exactly match
   export SUPABASE_ACCESS_TOKEN=<token>
   export SUPABASE_DB_URL=<connection string>
   export SUPABASE_ANON_KEY=<anon key>
   export SUPABASE_SERVICE_ROLE_KEY=<service role key>
   export ALLOW_DESTRUCTIVE_FRESH_DB_TEST=true
   ```
3. Verify the project is empty of PMFreak objects (only the platform
   schemas `auth`/`storage`/`extensions`/`realtime` are expected).
4. `npx supabase link --project-ref "$SUPABASE_PROJECT_REF"` — confirm the
   linked ref matches `FRESH_DB_EXPECTED_PROJECT_REF`.
5. `npx supabase migration list` — record local/remote counts before apply
   (sanitized: counts only, no connection strings).
6. `npm run check:fresh-db-migrations` — applies all 146 migrations, then
   runs the new repeatability check (fails on remote-pending,
   remote-unexpected, or count mismatch).
7. Re-run step 6 a second time — expect "no pending migrations" both times
   (C.4 repeatability).
8. Run `psql -f scripts/fresh-db-rls-smoke-test.sql` against the linked
   project's connection string for the tenant-isolation smoke test, then
   the full E.2/E.3 role matrix (see
   [`hosted-rls-role-matrix.md`](./hosted-rls-role-matrix.md) for the
   template).
9. Execute the 8 RPCs in [`hosted-rpc-signature-report.md`](./hosted-rpc-signature-report.md)
   against real `authenticated`/`service_role` sessions.
10. Run `supabase gen types typescript --linked > /tmp/pmfreak-hosted-database.types.ts`
    and diff against the versioned types (see
    [`generated-types-drift-report.md`](./generated-types-drift-report.md)).
11. Update this document, `hosted-rls-role-matrix.md`,
    `generated-types-drift-report.md`,
    `existing-database-compatibility-report.md`, and
    `residual-risk-register.md` with the real results, and only then move
    RR-MIGRATE to Closed.

## Result table (P0-LAUNCH-06 actual run)

Only the rows marked PASS were actually executed against hosted. Everything still
marked NOT EXECUTED is genuinely unexecuted on hosted and is NOT covered by
`HOSTED_DATA_TIER_CERTIFICATION`.

```
Hosted Supabase fresh apply........ PASS (ecwkldflddnmdwusatuh, no manual repair)
Migration count..................... PASS 161/161 applied, 0 pending, 0 unexpected
Supabase platform compatibility..... PASS for migration apply (Postgres 17.6.1.141);
                                     runtime/platform behaviour beyond apply NOT EXECUTED
Auth schema compatibility........... N/A for DDL — PMFreak declares no auth-schema objects
                                     (auth.users is FK-referenced and auth.uid() called only);
                                     hosted auth RUNTIME behaviour NOT EXECUTED
Storage schema compatibility........ PASS for the PMFreak-owned object — the
                                     storage.objects policy "service_role_full_access"
                                     (bucket_id = 'pmfreak-documents') and the
                                     pmfreak-documents bucket row were both present on
                                     hosted and captured in the logical backup
RLS coverage......................... NOT EXECUTED
Tenant isolation..................... NOT EXECUTED
Full role matrix...................... NOT EXECUTED
RPC signatures......................... Static inventory done (hosted-rpc-signature-report.md); live execution NOT DONE
SECURITY DEFINER review................ Static review done (hosted-grants-report.md); live grants NOT VERIFIED
Grants.................................. NOT EXECUTED
Generated types drift................... NOT EXECUTED
Existing DB compatibility............... NOT EXECUTED

RR-MIGRATE: RESOLVED  (scoped to hosted fresh-migration execution — the
                       NOT EXECUTED rows above are NOT covered by it)
HOSTED_PLATFORM_RESTORE_REHEARSAL: NOT_PERFORMED
FULL_BETA_DEPLOYMENT_TOPOLOGY_CERTIFIED: NO
```
