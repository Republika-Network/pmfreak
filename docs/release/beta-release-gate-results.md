# Beta Release Gate Results — Perillas 11–13B

## Perilla 13B update (2026-07-11) — hosted Supabase validation prep (RR-MIGRATE remains OPEN)

Executed on branch `claude/supabase-migration-validation-2kugdm` (based on
`main` @ `02e09c6` post-Perilla 13). No hosted Supabase credentials were
available in this environment — see
[`hosted-supabase-migration-proof.md`](./hosted-supabase-migration-proof.md).
This run covers only what's achievable without hosted access: baseline
re-verification, harness/safety-guard hardening, and a static SECURITY
DEFINER audit that found and fixed 2 real gaps (2 new corrective
migrations, 144→146 total).

| Command | Result |
| ------- | ------ |
| `rm -rf node_modules .next && npm ci` | PASS |
| `npm run typecheck` | PASS — 0 errors |
| `npm run lint` | PASS — 0 errors (620 pre-existing warnings, unchanged class) |
| `npm test` | PASS — see exact count below (baseline 12,218 + new safety-guard/hardening tests) |
| `npm run build` | PASS — production build |
| `npm run check:db-contract` | PASS |
| `npm run check:fresh-db-migrations` (verify-only) | PASS — 146 migration files, 0 duplicate timestamps, correct ordering |
| `npm run check:security-definer-hardening` (new) | PASS — 18 SECURITY DEFINER functions, all pinned `search_path`, all explicit PUBLIC-execute-revoked (2 corrective migrations landed this session)<br>**SUPERSEDED (Gate 3).** This row records a PASS from the original lexical checker, which could not prove anything about `anon`. On Supabase `REVOKE ... FROM PUBLIC` does not revoke `anon`, and a live advisor run later found 26 SECURITY DEFINER functions anon-executable. The checker has been rewritten as an ordered effective-state reconstruction and the inventory is now 30 functions — see [`hosted-grants-report.md`](./hosted-grants-report.md). |
| `npm run check:governance` (after `npm run build:aoc`) | PASS |
| `npm run check:dependency-security` | CONDITIONAL (exit 2, 0 unexpected — unchanged from Perilla 13) |
| `npm run check:beta-release` | **CONDITIONAL GO** — all blocking gates PASS (now includes the SECURITY DEFINER hardening gate), dependency-security CONDITIONAL as expected |

**RR-MIGRATE: OPEN** (unchanged from Perilla 13 — no hosted Supabase apply
was attempted or fabricated this session either). See
[`residual-risk-register.md`](./residual-risk-register.md) for the exact
Perilla 13B addendum.

## Perilla 13 update (2026-07-11) — fresh-database migration proof re-run

Executed on branch `claude/pmfreak-fresh-migration-proof-ei6kal` (based on
`main` @ `8422302` post-Perilla 12), after fixing 26 migration defects (see
[`migration-failure-remediation-log.md`](./migration-failure-remediation-log.md))
and adding 2 corrective migrations + `scripts/check-fresh-db-migrations.mjs`.

| Command | Result |
| ------- | ------ |
| `npm ci` | PASS |
| `npm run typecheck` | PASS — 0 errors |
| `npm run lint` | PASS — 0 errors (pre-existing warnings only, unchanged class) |
| `npm test` | PASS — **12,207 tests, 498 suites, 0 failures, 0 skipped** |
| `npm run build` | PASS — production build |
| `npm run check:db-contract` | PASS |
| `npm run check:governance` | PASS |
| `npm run check:launch-readiness` | PASS |
| `npm run test:launch-smoke` | PASS |
| `npm run check:dependency-security` | CONDITIONAL (exit 2, 0 unexpected — unchanged from Perilla 12) |
| `npm run check:beta-release` | **CONDITIONAL GO** — all blocking gates PASS, dependency-security CONDITIONAL as expected |
| `npm run check:fresh-db-migrations` (verify-only, no DB configured) | PASS — 144 migration files, 0 duplicate timestamps, correct ordering |
| `npm run check:fresh-db-migrations` (local mode, `FRESH_DB_URL` + `ALLOW_DESTRUCTIVE_FRESH_DB_TEST=true` against an isolated local Postgres) | **PASS** — 144/144 migrations applied, 409 tables, 408/409 RLS-enabled |
| `psql -f scripts/fresh-db-rls-smoke-test.sql` against the fresh-applied local DB | **PASS — 10/10** cross-tenant SELECT/INSERT/UPDATE/DELETE checks (see [`rls-tenant-isolation-report.md`](./rls-tenant-isolation-report.md)) |

**RR-MIGRATE: OPEN** (strong local-Postgres evidence; hosted-Supabase-or-official-local-stack evidence not available in this environment — see [`fresh-database-migration-proof.md`](./fresh-database-migration-proof.md) honesty statement). No hosted Supabase apply was attempted or fabricated.

## Perilla 12 update (2026-07-11) — RR-XLSX closure re-run

Executed on branch `claude/xlsx-dependency-security-35m85v` (based on `main`
@ `b735529` post-Perilla 11), clean environment
(`rm -rf node_modules .next && npm ci`), after replacing `xlsx@0.18.5` with
`exceljs@4.4.0` (see [`xlsx-replacement-decision.md`](./xlsx-replacement-decision.md)).

| Command | Result |
| ------- | ------ |
| `npm ci` (clean) | PASS — reproducible, lockfile integrity intact |
| `npm ls xlsx` | `(empty)` — vulnerable package absent from the tree |
| `npm audit --json` | **0 critical, 0 high**, 4 moderate (postcss/next — RR-POSTCSS, unchanged; uuid/exceljs — unreachable, documented), 0 low |
| `npm run typecheck` | PASS — 0 errors |
| `npm run lint` | PASS — 0 errors (620 pre-existing warnings, unchanged class) |
| `npm test` | PASS — **12,207 tests, 498 suites, 0 failures, 0 skipped** (+42 net new spreadsheet boundary/contract/export/dependency tests) |
| `npm run build` | PASS — production build incl. `/upload` with the lazily-loaded export engine |
| `npm run check:dependency-security` | **exit 2 (CONDITIONAL, 0 unexpected)** — xlsx forbidden-check green; 0 critical/high; the only remaining findings are accepted moderates (postcss/next — RR-POSTCSS; uuid via exceljs — unreachable) |
| `npx tsx --test tests/spreadsheet-*.test.* tests/prototype-pollution-guard.test.mjs` | PASS — 47/47 |
| `npm run check:beta-release` | **Decision: CONDITIONAL GO** (see below) |

Post-Perilla-12 gate summary (verbatim decision): the only remaining
conditional items are **RR-MIGRATE** and **RR-BACKUP** — RR-XLSX no longer
appears. The `cdn.sheetjs.com` egress block noted in "Not verifiable from
this environment" is now moot: no SheetJS artifact is needed at all.

Everything below this line is the Perilla 11 record, kept for traceability.

---

Executed: 2026-07-10, on the closure branch
(`claude/pmfreak-beta-closure-gate-gavpfd`, based on `main` @ `1f4119c`
post-Perilla 10). Environment: Linux (Claude Code remote), Node v22.22.2,
npm 10.9.7, clean container. Every command below was actually executed; no
result is asserted without a run.

## Baseline evidence (current `main`, before Perilla 11 changes)

| Command | Exit | Duration | Result | Notes |
| ------- | ---: | -------: | ------ | ----- |
| `rm -rf node_modules .next && npm ci` | 0 | ~2m | PASS | Reproducible; lockfile valid; local `@aoc/*` file deps resolve. `npm` reported 9 vulnerabilities (3 high / 5 moderate / 1 low) — see dependency review |
| `npm run typecheck` | 0 | 51s | PASS | 0 TypeScript errors |
| `npm run lint` | 0 | 98s | PASS | 0 errors, 620 warnings (all `@typescript-eslint/no-unused-vars`-class; none in the security/hooks/boundaries categories — AOC boundary lint is a separate blocking pass, clean) |
| `npm test` | 0 | 134s | PASS | **12,115 tests, 498 suites, 0 failed, 0 skipped** — includes `tests/workspace-compression.test.mjs` (4/4, the historical failure no longer exists on `main`) |
| `npm run build` | 0 | 73s | PASS | Production build incl. static generation, dynamic routes, `src/proxy.ts` middleware ("ƒ Proxy") — no reserved-convention conflicts |
| `npm run check:governance` | 1→0 | 5s / 24s | **FAIL then PASS** | Fails on a clean checkout because `check:package-exports` needs `@aoc/*` `dist/` artifacts; passes after `npm run build:aoc`. **Fixed**: the beta gate orders `build:aoc` first; `dist/` is now gitignored |
| `npm run check:launch-readiness` | 1 | 118s | **FAIL** | `spawnSync ENOBUFS` — the full test suite's TAP output outgrew the 1 MB default buffer; the gate could not produce a real verdict. **Fixed** (`maxBuffer` 64 MB); re-run below |
| `npm run test:launch-smoke` | 0 | <1s | PASS | 3/3 checks |
| `npm run check:runtime-hardening` | 0 | <1s | PASS | |
| `npm run check:production-runtime` | 0 | <1s | PASS | |
| `npm run check:enterprise-ux` | 0 | 1s | PASS | |
| `npm run check:runtime-contracts` | 0 | <1s | PASS | |
| `npm run check:db-contract` | 0 | <1s | PASS | |
| `npm run check:no-local-auth-bypass` | 0 | 1s | PASS | 8 informational WARNs (documented local-allow patterns), 0 violations |
| `npm run check:publish-integrity` | 0 | 17s | PASS | build:aoc + package purity + tarball purity + build reproducibility |
| `npm audit --json` | — | 2s | 9 findings | 3 high (next, ws, xlsx), 5 moderate, 1 low — full classification in `dependency-security-review.md` |
| `git diff --check` | 0 | <1s | PASS | No whitespace errors. Finding: `npm test` rewrote tracked `artifacts/vault-smoke-test-report.*` on every run — **fixed** (reports now written only on CLI invocation) |

## Closing evidence — `npm run check:beta-release` on the finished branch

Verbatim summary (per-gate logs in `.beta-release-logs/`, gitignored):

```
PMFreak Beta Release Gate

AOC Packages Build........ PASS  (5.0s, exit 0)
Typecheck................. PASS  (9.3s, exit 0)
Lint...................... PASS  (69.7s, exit 0)
Tests..................... PASS  (91.6s, exit 0)
Build..................... PASS  (83.6s, exit 0)
Governance................ PASS  (23.6s, exit 0)
Runtime Hardening......... PASS  (0.2s, exit 0)
Production Runtime........ PASS  (0.2s, exit 0)
Runtime Contracts......... PASS  (0.2s, exit 0)
Database Contract......... PASS  (0.3s, exit 0)
Launch Smoke.............. PASS  (0.2s, exit 0)
Auth Bypass Scan.......... PASS  (0.5s, exit 0)
Enterprise UX............. PASS  (0.2s, exit 0)
Dependency Security....... CONDITIONAL  (1.7s, exit 2)

Decision: CONDITIONAL GO
```

The closing `npm test` runs **12,165 tests / 0 failures** (the delta over
baseline is the ~60 new Perilla 11 tests across
`workspace-invite-token-hashing`, `ai-runtime-guardrails`,
`observability-readiness`, `prototype-pollution-guard`,
`beta-release-gate`).

`npm audit` after remediation: **0 critical, 1 high (xlsx — accepted with
pilot-blocking condition RR-XLSX), 2 moderate (postcss bundled in next —
accepted, RR-POSTCSS)**. `npm run check:dependency-security` exit 2
(CONDITIONAL, 0 unexpected).

`npm run check:launch-readiness` (post-fix, on the closing branch): exit 0
in 3m17s — all five embedded checks pass (`npm run build`, `npm test`,
`npm run check:governance`, launch smoke, runtime diagnostics).

| Check | Resultado | Severidad | Acción |
| ----- | --------- | --------: | ------ |
| npm ci (clean) | pass | blocking | — |
| typecheck | pass | blocking | — |
| lint | pass | blocking | — |
| tests (full suite) | pass | blocking | — |
| build | pass | blocking | — |
| governance battery | pass | blocking | fixed ordering (build:aoc first) |
| runtime hardening / production runtime / runtime contracts | pass | blocking | — |
| db contract | pass | blocking | — |
| launch smoke | pass | blocking | — |
| auth bypass scan | pass | blocking | — |
| launch readiness | pass (post-fix) | blocking | fixed ENOBUFS |
| enterprise UX | pass | important | — |
| dependency security | conditional | important | RR-XLSX / RR-POSTCSS tracked |
| operational-flow live-DB harness | not runnable here (exit 2 = infra absent, by design) | important | pilot precondition RR-MIGRATE |
| Vercel deployment | not executable from this environment | blocking at deploy time | runbook §1/§5 verifies on deploy |

## Not verifiable from this environment (explicit)

* **Vercel production deployment** — the build passes locally with the same
  builder; actual deploy verification is step §5 of the runbook.
* **Fresh-database migration apply + live RLS flows** — harness exists
  (`check:operational-flow-db`) but requires an isolated Supabase project;
  pilot-blocking condition RR-MIGRATE.
* **cdn.sheetjs.com fetch** for the xlsx upgrade — egress-blocked here
  (verified 403); pilot-blocking condition RR-XLSX.
