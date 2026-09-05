# Backup / Restore Drill — RR-BACKUP evidence

## Current disposition (P0-LAUNCH-06)

```
AUTHORITATIVE_RR_BACKUP_REHEARSAL=PASS_ISOLATED_LOCAL_LOGICAL_RESTORE_SINGLE_PASS
RESTORE_ATTEMPTS_IN_AUTHORITATIVE_RUN=1
RESTORE_EXIT=0
SCHEMA_CONTRACT_CHECKS=PASS
RLS_SMOKE_TEST=PASS
RR_BACKUP=RESOLVED            (scoped: closed-beta logical-backup recoverability)
HOSTED_PLATFORM_RESTORE_REHEARSAL=NOT_PERFORMED
```

RR-BACKUP is RESOLVED **for the scoped closed-beta logical-backup recoverability
claim**: the logical backup artifacts taken from the hosted validation project can
actually reconstruct PMFreak. A hosted-platform restore (Supabase dashboard restore, or
restore into a hosted project) was deliberately **not** performed — the hosted validation
project was preserved intact as the authoritative RR-MIGRATE artifact rather than
destroyed to obtain that evidence. Those two facts are compatible and both stand.

### Logical backup export (Phase A, source `ecwkldflddnmdwusatuh`)

Six artifacts via `supabase db dump --linked` (CLI 2.116.0). `--linked` was used rather
than `--db-url` so no password entered argv or logs. Artifacts are retained LOCAL ONLY
under a gitignored directory and are never committed.

| Artifact | Bytes | SHA256 |
| --- | --- | --- |
| roles.sql | 358 | `4350a72b5ec109888e740c17f3eb4da2fcd95ab73af26499538ed0bf615db543` |
| schema.sql | 1528582 | `af76c1177cf913b969fb15ce7297d91fd149773659396e4256910cd1c1d18301` |
| data.sql | 169109 | `8d440e054bf43861863b119480372613c031f908d64f2b347a0c568b2a7f7b64` |
| history_schema.sql | 887 | `18b99fbbb3ec9fbb964bb255a56171329acd99b6977ece2addd89fdf5aa5105b` |
| history_data.sql | 1274035 | `fe243d1908d10b65609b6dd466c76b4e4040c7c9bef0966f5e22b0773a7af0fd` |
| storage_pmfreak_objects.sql | 591 | `d0d75ca0e258c84165ddf1ef9a49f5e480b49436bb5d305e412f35ee0dcacc75` |

**Managed-schema gap, found and covered.** `supabase db dump` excludes the `storage`
schema, so `schema.sql` does NOT contain the PMFreak-owned
`storage.objects` policy `service_role_full_access`
(`grep -c service_role_full_access schema.sql` = 0). The bucket ROW is recoverable
(the data-only dump does include `storage.buckets`), but the POLICY is not.
`storage_pmfreak_objects.sql` is the minimal supplement that closes it. Roles/schema/data
alone would therefore NOT have fully restored PMFreak.

### Authoritative restore rehearsal (Phase B)

Isolated disposable local Supabase stack, Postgres 17.6 against the hosted source's
17.6.1.141, on its own project id and port block, started empty (migrations and seed
disabled) and proven empty before the restore: 0 public tables, 0 functions, 0 policies,
no `supabase_migrations` schema, 0 buckets, 0 auth users.

ONE pass, ONE attempt, as the platform superuser from the first statement:

```bash
psql -U supabase_admin --dbname postgres \
  --single-transaction --variable ON_ERROR_STOP=1 \
  --file roles.sql --file schema.sql \
  --command 'SET session_replication_role = replica' \
  --file data.sql --file history_schema.sql --file history_data.sql \
  --file storage_pmfreak_objects.sql
# exit 0
```

Trigger suppression was REQUIRED, not optional: `pg_dump` reported circular foreign keys
on `governance_delegations` and `operational_memory_runtime_records`.

| Metric | Source | Restored |
| --- | --- | --- |
| public tables | 433 | 433 |
| functions | 92 | 92 |
| policies | 877 | 877 |
| RLS-enabled tables | 432 | 432 |
| indexes | 1185 `CREATE INDEX` | 1185 matched by name, 0 missing |
| foreign keys | 1114 | 1114 |
| triggers | 88 | 88 |
| migration history | 161 | 161 (0 missing, 0 unexpected, 0 duplicates) |

First/last restored migration `20260428120000` / `20260907000000`. The
`pmfreak-documents` bucket and the `storage.objects` `service_role_full_access` policy
were both present after restore. Data restored was exactly the 2 rows the near-empty
source held (`storage.buckets` 1, `public.founder_program_settings` 1; `auth.users` 0) —
a raw row count also shows 77 `auth.schema_migrations` + 63 `storage.migrations` rows,
which are the local GoTrue/storage-api services' own ledgers, precisely the tables the
dump `--exclude-table`'d, and therefore target-native rather than restored.

On the restored database: `npm run check:db-contract` PASS, and
`scripts/fresh-db-rls-smoke-test.sql` **10/10 PASS** — cross-tenant INSERT correctly
rejected with `new row violates row-level security policy for table "projects"`, which is
that case's pass condition.

Index reconciliation (not a gap): `pg_indexes` shows 1709 because `pg_dump` emits
PK/UNIQUE constraint indexes as `ALTER TABLE ADD CONSTRAINT` rather than `CREATE INDEX`
(524 of them), and 10 further `CREATE INDEX` unique indexes are referenced by composite
FKs. 1175 + 10 + 524 = 1709; a by-name diff of all 1185 source index names returns zero
missing.

Faithfully reproduced source property: exactly one public table lacks RLS on BOTH sides —
`agent_attestation_nonces` (433 tables / 432 enables on each side).

### Superseded, non-authoritative Phase B run

An earlier Phase B attempt is retained as historical evidence and is
**NON_AUTHORITATIVE**: its first restore failed on `roles.sql` (the connecting role was
`postgres`, which is not a superuser locally) and it was retried after changing the
connecting identity without authorization. Its technical result was a pass, but it is not
the authoritative rehearsal and must not be rewritten as one. The authoritative run above
is single-pass with one attempt.

---

## Historical — Pilot Gate Sprint 01 (2026-07-15)

Retained unchanged as the prior evidence baseline. It remains true for what it measured;
it is superseded only as the *current* RR-BACKUP disposition.

Date: 2026-07-15 (session clock). Executed against the fully-migrated
PostgreSQL 16.13 database from
[`pilot-gate-migration-proof.md`](./pilot-gate-migration-proof.md)
(409 tables, RLS-seeded two-workspace dataset).

## Current backup posture (documented)

- **Hosted (target for pilot)**: Supabase daily automated backups on all
  paid tiers; PITR is a Pro-tier add-on. **Tier/PITR status of the actual
  pilot project is UNCONFIRMED** — no hosted project/credentials exist in
  this environment. This is the sole remaining item for RR-BACKUP.
- **Logical backup path (rehearsed here)**: `pg_dump -Fc` → `pg_restore`
  to a scratch database. This is also the documented operator path for
  ad-hoc pre-migration snapshots and the RR-EXPORT operator commitment.

## Drill procedure (reproducible)

```bash
# 1. Capture pre-backup integrity state (10 metrics incl. data checksum)
psql -d pmfreak_fresh -f <state-capture.sql>   # see below
# 2. Timed logical backup
time pg_dump -h <host> -U postgres -d pmfreak_fresh -Fc -f pmfreak_fresh.dump
# 3. Timed restore to a scratch database
createdb pmfreak_restore_drill
time pg_restore -d pmfreak_restore_drill --no-owner pmfreak_fresh.dump
# 4. Re-capture state on the restored DB and diff
# 5. Re-run RLS spot-checks on the restored DB
```

State capture: public table count, RLS-enabled table count, policy count,
FK count, index count, row counts (workspaces / projects / memberships /
auth.users), and an md5 checksum over workspace ids+names.

## Measured results

| Metric | Value |
| --- | --- |
| Backup (pg_dump -Fc, 409-table schema + seed data) | **0.35 s**, 2.7 MB dump |
| Restore (pg_restore, full schema + data) | **13.5 s**, exit 0, **zero warnings** |
| Integrity diff (10 metrics pre vs post) | **IDENTICAL** (including data checksum `84101f51…`) |
| RLS on restored DB | Enforced — user A sees own workspace (1), foreign workspace (0), foreign project (0) |

Schema-only durations scale with data volume; the numbers above are the
empty-pilot baseline. Re-run the drill once pilot data exists to get a
realistic RTO envelope.

## RPO / RTO statement

- **RPO (logical path)**: equals dump cadence — on-demand today, so RPO is
  operator-defined. For the pilot: take a dump before every migration deploy
  and at least daily (runbook step added). Hosted daily backups give ≤24 h;
  PITR (if enabled on the pilot project) gives ~2 min granularity.
- **RTO (measured)**: 13.5 s restore on the empty-pilot dataset + operator
  time. Pilot-scale estimate: minutes, not hours. Hosted-restore RTO is
  Supabase-managed and must be confirmed with the tier check below.

## Consistency validation

- `pg_restore` completed with zero errors/warnings.
- All 854 RLS policies present post-restore; RLS behavior re-verified live.
- Row counts and the content checksum match exactly.

## Remaining (historical list from Pilot Gate Sprint 01 — superseded)

RR-BACKUP is now RESOLVED for the scoped logical-backup recoverability claim (see the
top of this document). The list below is retained as the plan written before that
rehearsal existed; item 2 was satisfied by the authoritative isolated local restore, while
items 1 and 3 (hosted backup tier / PITR confirmation, hosted restore rehearsal) remain
genuinely outstanding and are the reason
`HOSTED_PLATFORM_RESTORE_REHEARSAL=NOT_PERFORMED`.

### Original list

1. Confirm the pilot Supabase project's backup tier; enable PITR if the
   budget allows (recommended for real partner data).
2. Perform one hosted restore rehearsal to a scratch project (dashboard
   restore or `supabase db dump` + restore) and record its timings in this
   document.
3. Then — and only then — move RR-BACKUP to Closed in the risk register.
