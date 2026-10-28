# Pilot Operational Runbook — PMFreak Closed Beta

Perilla 11 deliverable. Audience: the pilot operator (currently the repo
owner). Everything here assumes the Vercel + hosted-Supabase deployment
topology enforced by `docs/security/production-deployment-boundary.md`.

## 1. Pre-deployment checklist

- [ ] `npm run check:beta-release` passes on the release commit (blocking
      gates all PASS; advisory gates at worst CONDITIONAL with every
      condition tracked in `residual-risk-register.md`).
- [ ] Pilot-blocker conditions cleared: RR-XLSX (SheetJS 0.20.3 installed),
      RR-MIGRATE (fresh-DB migration apply + `check:operational-flow-db`
      green on staging), RR-BACKUP (restore rehearsed).
- [ ] `docs/release/beta-release-gate-results.md` regenerated for the release
      commit.

## 2. Environment validation

- [ ] All server-only vars set in Vercel (production scope):
      `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`,
      `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRO_PRICE_ID`, `STRIPE_PMO_PRICE_ID`,
      `OPENAI_API_KEY`, `ABUSE_HASH_PEPPER` (real value, not default).
      **Under the closed-free-beta profile the `STRIPE_*` variables are not
      required and no billing surface is exercised** — see §6. They remain
      declared production-required by
      `src/lib/security/deployment-boundary-registry.ts`; that contradiction is
      narrowed but not eliminated (`RR-PRODUCTION-ENV-GUARD`, split out of the
      now-resolved `RR-BOOT-ENV-GUARD` because the beta and full-production
      environment contracts are not the same contract).
- [ ] **Closed-free-beta profile selected.** Set
      `PMFREAK_OPERATING_PROFILE=closed-free-beta` and start the runtime with
      `npm run start:closed-free-beta` (**not** a bare `next start`). That script
      runs `npm run check:beta-environment` first, through the `tsx` loader, which
      is a **runtime dependency** precisely so the preflight survives
      `npm ci --omit=dev` — verified in a production-style install. It refuses to
      start on any
      violation, printing `{"ok":false,"failureClass":"CONFIGURATION_FAILURE",...}`
      with the violation codes. It validates: profile selected, Supabase trio
      present, `NEXT_PUBLIC_APP_URL` present **and a valid http(s) URL**, no
      secret-shaped `NEXT_PUBLIC_*` name, and the capability claim secret when
      governance is enabled. Stripe variables are **not** required.
      **A bare `next start` is UNSUPPORTED for the accepted local closed-beta
      path.** It bypasses the preflight entirely, and a runtime started that way
      is outside what P0-LAUNCH-05 accepted — do not use it, and do not treat a
      runtime started that way as having passed the beta environment contract
      (`RR-BETA-PREFLIGHT-BYPASSABLE`). There is still no in-process boot guard
      on either path — the beta contract is enforced by the start command
      (`RR-BETA-PREFLIGHT-BYPASSABLE`) and the full-production contract is not
      wired at all (`RR-PRODUCTION-ENV-GUARD`) — so the start command is the
      enforcement point.
- [ ] Public vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
      `NEXT_PUBLIC_APP_URL` (+ `NEXT_PUBLIC_SITE_URL` kept in sync) — real
      https URLs. The beta preflight above now rejects a malformed or non-http
      `NEXT_PUBLIC_APP_URL`, which it previously did not. It does **not** reject
      a well-formed `http://localhost` origin, so **still confirm by hand that
      these point at the deployed origin**, and keep `NEXT_PUBLIC_SITE_URL` in
      sync manually — it is not covered by the preflight.
- [ ] Optional guardrail tuning reviewed: `AI_*` limits, `LOG_LEVEL`,
      `HEALTHCHECK_DATABASE_TIMEOUT_MS`, `INVITE_TOKEN_TTL_HOURS`,
      `UPLOAD_MAX_*`. Unset = conservative defaults; invalid values fall back
      to defaults by design.
- [ ] **Release blocker (F6 / PR-4):** `FOUNDER_OPERATOR_USER_IDS` (server-only)
      contains exactly the operator accounts' `auth.users.id` values,
      comma-separated, each a UUID. Each listed account has a confirmed email.
      Unset, empty or any malformed entry locks every operator out of every
      founder/internal surface (fails closed). Email domains and
      `FOUNDER_EMAIL_ALLOWLIST` no longer grant anything; remove the old
      variable once the new one is confirmed. Verify after deploy by signing
      in as each operator and opening `/early-access`.
- [ ] Pilot capability posture (Pilot Gate Sprint 01):
      `PMFREAK_GOVERNANCE_CAPABILITY_ENABLED` unset/false and
      `PMFREAK_CAPABILITY_PROFILE` unset for the pilot deployment (curated
      pilot surface; governance signing off — see
      `docs/release/pilot-capability-set.md`). `/api/ready` fails if the
      governance switch is on without `PMFREAK_CAPABILITY_CLAIM_SECRET`.
- [ ] `OPENAI_API_KEY` verified working (the copilot inference path fails
      hard without it — no canned fallback).

## 3. Database migration procedure

1. Snapshot first: confirm the latest Supabase backup is recent (Dashboard →
   Backups) or trigger one.
2. Apply migrations in filename order (Supabase CLI `supabase db push`, or
   the SQL editor for hosted-only setups). All Perilla-11 migrations
   (`20260820…`, `20260821…`, `20260822…`) are idempotent.
3. Post-apply verification queries:
   * `select column_name from information_schema.columns where table_name = 'workspace_invitations';`
     → must include `token_hash`, `revoked_at`; must **not** include `token`.
   * `select count(*) from public.ai_usage_events;` → table exists (0 rows).
   * `select relrowsecurity from pg_class where relname in ('ai_usage_events','dashboard_task_lifecycle_records');` → `t`.
4. `npm run check:db-contract` against the deployed commit.

## 4. Rollback procedure

* **Application:** Vercel → Deployments → promote the previous production
  deployment (instant). The Perilla-11 schema is backward-compatible with the
  previous app release *except* invite acceptance (the plaintext column is
  gone) — legacy invites were already revoked by design, so rollback keeps a
  working system where owners simply re-issue invites.
* **Database:** forward-fix only. If a migration misbehaves, write a
  corrective migration; restore from backup only for data corruption (see §8).

## 5. Health verification (after every deploy)

```
curl -s https://<app>/api/health   # 200, status:"ok", adapter list
curl -s https://<app>/api/ready    # 200, status:"ready"
```
Under `PMFREAK_OPERATING_PROFILE=closed-free-beta`, `/api/ready` reports **four**
checks — `configuration`, `governance_capability`, `database` and **`auth`**.
The `auth` check (added by P0-LAUNCH-05) probes GoTrue `/auth/v1/health` with the
anon key under the `HEALTHCHECK_DATABASE_TIMEOUT_MS` deadline. Outside that
profile the `auth` check is **absent from `checks` entirely** — the profile gate
is at the call site, not inside the check, so no `auth` entry is reported at all
rather than a passing one. A passing entry would silently widen the declared
dependency set for every non-beta consumer, which is why
`tests/observability-readiness.test.mjs` pins the non-beta set to exactly
`configuration`, `database`, `governance_capability`. So if you see **three**
checks and no `auth`, **the profile is not set** and you are not running the
beta posture.

`/api/ready` returning 503 names the failing check (config var *names*,
database reachability, or `auth` = `unreachable` / `timeout after Nms` /
`upstream <status>`) — fix env or Supabase before exposing traffic.
Readiness is **advisory**: a NOT READY instance still serves
(`RR-READINESS-NOT-A-GOVERNED-GATE`), so withdraw it from rotation yourself.
Then: log in with a pilot account, load `/command-center`, create a test
project, upload one small file, run one AI suggestion.

## 6. Billing mode confirmation

**Closed free beta: there is no billing.** Participants are on the free plan and
no charge is made. `npm run check:beta-environment` requires **no** `STRIPE_*`
variable, and P0-LAUNCH-05 focused-gate assertion 9 proves the beta environment
contract still passes with `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` both
absent.

- [ ] Confirm the beta is being run as **free** and say so to participants
      explicitly.
- [ ] If Stripe variables are set anyway, keep them in **test** mode. Never mix
      modes (`RR-STRIPE-ENV`).
- [ ] Only if a later pilot actually charges: use live-mode keys, configure the
      webhook endpoint with the deployed URL + matching `STRIPE_WEBHOOK_SECRET`,
      send a test event and confirm a `billing_webhook_events` row.

## 7. Alerts & monitoring (manual cadence during pilot)

No external platform is integrated (RR-MONITOR). Instrumentation points:
structured logs (Vercel log drain-ready), `security_events`,
`workspace_audit_events`, `billing_webhook_events`, `ai_usage_events`,
`/api/ready`.

**Alert-worthy events** (check daily; each maps to a query or log filter):

| Event | Where to look |
| ----- | ------------- |
| Repeated auth failures / abuse denials | `security_events` (`abuse_rate_limited`, auth_denied types) |
| Billing webhook failures | Stripe dashboard events + `billing_webhook_events` gaps |
| Database connectivity failure | `/api/ready` 503s, Vercel function logs `readiness_check_failed` |
| AI provider failure spike / circuit-open | logs `circuit is open`, `ai_usage_events.status = 'error'/'timeout'` |
| Rate-limit spike | `abuse_rate_limits` counters, `security_events` |
| Service-role use anomaly | `security_events` `privileged_client_used` outside registry expectations |
| Failed privileged operation | `security_events` denial types |
| Migration failure | deploy-time output; `/api/ready` database check |
| Cost threshold reached | `ai_usage_events` daily sum vs `AI_DAILY_COST_LIMIT_USD`; guardrail denials log `daily_cost_ceiling` |

## 8. Backup / restore

1. Confirm plan tier includes daily backups (+ PITR if budget allows) on the
   pilot project.
2. **Rehearsal (pilot precondition, RR-BACKUP):** the logical-path drill was
   executed 2026-07-15 with full evidence (timings, integrity diff, RLS
   re-verification) — see `docs/release/backup-restore-drill.md` for the
   reproducible procedure. Remaining hosted step: restore the latest backup
   into a scratch Supabase project; point a preview deployment at it; verify
   login + one workspace loads. Record date + duration in
   `backup-restore-drill.md`.
3. Operational cadence during pilot: `pg_dump -Fc` before every migration
   deploy and at least daily (defines the logical-path RPO).
4. Real restore: same procedure; then rotate any keys that changed and update
   Vercel env; redeploy; run §5.

## 9. Incident response

1. Triage with §5 checks + Vercel logs (filter by `request_id` — `/api/ready`
   and SDK routes echo `x-request-id`).
2. Contain: for a suspected credential leak, rotate the affected key
   (Supabase service role / Stripe / OpenAI) in its console + Vercel env,
   redeploy (all sessions survive; service-role consumers pick up the new key
   on cold start).
3. **AI provider disable switch:** unset/void `OPENAI_API_KEY` in Vercel and
   redeploy — the provider registry reports `not_configured`, `runInference`
   fails closed with a clean error, and no route crashes. Cheaper large-blast
   alternative: set `AI_DAILY_REQUEST_LIMIT=1`.
4. **Rate-limit adjustment:** abuse limits are per-route constants (registry
   documents each); AI ceilings are env-tunable (`AI_DAILY_REQUEST_LIMIT`,
   `AI_MAX_CONCURRENT_PER_WORKSPACE`) — change env + redeploy.
5. Record the incident (what/when/blast radius/fix) in `docs/audits/`.

## 10. Pilot user provisioning & workspace creation

1. Founder grants early access (founder-only endpoints, Perilla 5) or the
   participant signs up directly (self-serve role is never privileged —
   Perilla 1).
2. Participant creates their workspace (owner membership is bootstrapped
   server-side) and invites teammates from `/team` — invite links are
   returned once at creation (hashed at rest, 7-day default TTL) and
   delivered out-of-band by the inviter (RR-INVITE-DELIVERY).
2b. **Operator-side admission** (P0-LAUNCH-05), when the operator admits a
   participant rather than a workspace owner doing it in-app:

   ```bash
   npm run beta:invite-participant -- \
     --workspace <workspace-uuid> --email <participant@example.com> \
     --role <pm|admin|viewer> --inviter <operator-email-or-uuid> \
     [--emit-accept-path]
   ```

   It runs the SAME invitation domain the `/team` action uses
   (`createWorkspaceInvitationRecord`), so duplicate rejection, the role gate
   ("owner" is never invitable), token hashing, TTL and the `invitation_sent`
   audit event are identical. The inviter must already hold owner/admin
   membership in that workspace. It refuses a non-local target outright.
   The plaintext token exists exactly once and is **withheld unless
   `--emit-accept-path`** is passed — pass it only when you must deliver the
   link, and deliver it out-of-band. The participant then accepts through the
   normal `/accept-invite/<token>` page.

   Note: this path is **not Frontera-governed**
   (`OPERATOR_INVITE_FRONTERA_GOVERNED=NO`, `RR-BETA-OPERATOR-FRONTERA-BOUNDARY`)
   and does **not** enforce subscription seat limits
   (`OPERATOR_INVITE_SUBSCRIPTION_SEAT_GATED=NO`,
   `BETA_OPERATOR_SEAT_POLICY=OPERATOR_CONTROLLED_NOT_SUBSCRIPTION_GATED`).
   Both resolve an authenticated HTTP user and cannot run here. The operator
   boundary authorises through local isolation plus the workspace actor role
   instead, and admission count is controlled by the operator cohort.
3. **Offboarding a participant** (P0-LAUNCH-05): `DELETE /api/workspace-team/members`
   with `{ workspaceId, targetUserId }`, as an owner or admin of that workspace.

   **Authorization model:** authenticated HTTP session, then server-resolved actor
   and target membership, then the canonical owner/admin hierarchy. It is
   **NOT Frontera-governed** (`OFFBOARDING_FRONTERA_GOVERNED=NO`) — a deliberate
   beta decision, because `requireGovernancePermission` currently denies every
   caller (`RR-GOVERNANCE-PERMISSION-GUARD-BROKEN`). No client-supplied role is
   trusted. The enforced hierarchy: pm/viewer may remove nobody; admin may remove
   pm/viewer only; owner may remove any non-owner, non-self member; an owner
   target is never removable here (`deny_owner_removal_requires_transfer`, or
   `deny_last_owner` for the final owner); self-removal is denied.

   **If a removal returns `500 offboarding_audit_write_failed`:** the membership
   deletion and the audit write are separate operations
   (`RR-OFFBOARD-AUDIT-NONATOMIC`), so authority may ALREADY be removed. Inspect
   effective membership FIRST, treat it as an incident requiring reconciliation,
   and record the removal manually. **Do not blindly retry the deletion.**
   This removes the `workspace_memberships` row and writes a `member_removed`
   audit event carrying the previous role. It **removes tenant authority, not
   the identity** — the `auth.users` record is deliberately untouched. Refusals
   return 403 with a reason: `deny_self_removal` (you cannot remove yourself),
   `deny_last_owner` (the final owner cannot be orphaned),
   `deny_actor_insufficient_role`, `deny_target_not_member`. An unauthenticated
   request returns **401**; an authenticated but unauthorized one returns **403**;
   a malformed body returns **400** `invalid_offboarding_request`. Authority is
   re-derived through Frontera per request, so a removed member's existing
   session retains no governed authority — proven live by P0-LAUNCH-03's
   out-of-process revocation scenario. Not yet exercised end-to-end against two
   live tenants; see the P0-LAUNCH-05 evidence document §9.
4. Weekly during pilot: review `ai_usage_events` per workspace (cost trend)
   and `workspace_audit_events` for anomalies.

## 11. Support contact

Pilot support is direct-to-operator: vicvalch@gmail.com (repo owner). Include
the `x-request-id` from any failing response when reporting.

## 12. Pilot shutdown procedure

1. Announce to participants; agree data handling per workspace.
2. Disable signups/invites: set `AI_DAILY_REQUEST_LIMIT=1` is NOT the tool —
   instead pause the Vercel deployment (or protect it behind Vercel
   authentication) so the app stops taking traffic.
3. Export any requested workspace data (operator SQL export — RR-EXPORT).
4. Final backup snapshot; archive `ai_usage_events` + audit tables.
5. Rotate all production secrets (they were exposed to pilot traffic).
6. Tear down or retain the Supabase project per retention commitments
   (backups expire per plan window — see data-recovery-readiness §G.5).
