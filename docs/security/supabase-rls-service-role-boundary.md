# Supabase RLS / Service-Role Boundary (Perilla 7)

Perillas 1-6 hardened the application layer: signup, billing checkout,
workspace membership, invite acceptance, role updates, founder/admin/early
access/trial endpoints, and the Stripe webhook/billing lifecycle all now
resolve authority from server-side `workspace_memberships.role` (or the
founder allowlist), never from client-supplied fields or `user_metadata`.

**Database policies must not reintroduce permissions that application guards
intentionally deny.** This document is the audit of the layer underneath the
application: Supabase Row Level Security (RLS) policies and service-role
("privileged client") usage. A hardened API route means nothing if a user can
reach the same table directly with their own JWT and a broader RLS policy.

## Trust model

| Client | How it's built | What it can see |
|---|---|---|
| `anon` | Public anon key, no session | Only tables/rows with an explicit `to anon` policy. None of the sensitive tables in this doc grant `anon` anything. |
| `authenticated` (RLS-scoped) | `createSupabaseServerClient()` (src/lib/supabase/server.ts), cookie-bound session | Only rows/columns an RLS policy explicitly allows for that user's `auth.uid()`. This is the default and preferred client for reads and for writes that a real end user should be able to perform directly. |
| Service-role (privileged) | `createSupabaseServiceRoleClient()` / `createPrivilegedSupabaseClient()` (src/lib/supabase/admin.ts → src/lib/security/privileged-access.ts) | Bypasses RLS entirely. Reserved for operations that cannot be expressed as "the authenticated user acting on their own row" — see "Approved service-role usages" below. |

`createPrivilegedSupabaseClient` requires an explicit `PrivilegedAccessContext`
(`routeId`, `operation`, `reason`, and either `actorUserId` or `systemActor`)
and logs a `privileged_client_used` security-telemetry event on every
acquisition (see `docs/security/service-role-access-policy.md`). **Service
role is a privileged escape hatch, not a general-purpose database client** —
every usage site is required to be listed in
`src/lib/security/privileged-access-registry.ts` (enforced by
`tests/supabase-rls-service-role-boundary.test.mjs`, test #8).

## Sensitive table classification

| Table | RLS | Client-readable? | Client-writable? | Classification |
|---|---|---|---|---|
| `workspace_memberships` | Enabled | Own rows always; workspace owner/admin can read all rows in their workspace | **No** — no INSERT/UPDATE/DELETE policy for `authenticated` at all | workspace-scoped, **writes service-role/helper-only** |
| `workspace_invitations` | Enabled | Workspace members: column-scoped (`id, workspace_id, company_id, email, role, status, invited_by_user_id, accepted_by_user_id, expires_at, accepted_at, created_at` — **not `token`**); owner/admin can manage (insert/update/delete) rows in their workspace | Owner/admin, via the hardened `inviteWorkspaceMember` server action | workspace-scoped; **token is service-role/column-grant protected** |
| `company_subscriptions` | Enabled | `authenticated`: own row only (`current_company_id() = company_id`), **read-only** | **No** — writes are service-role-only | billing/webhook-only |
| `billing_webhook_events` | Enabled | Service-role only | Service-role only | webhook/service-role-only |
| `early_access_invites` | Enabled | Service-role only | Service-role only | founder/internal-only |
| `early_access_events` | Enabled | Service-role only | Service-role only | founder/internal-only |
| `trial_licenses` | Enabled | Service-role only | Service-role only | founder/internal-only |
| `workspace_activations` | Enabled | Service-role only | Service-role only | founder/internal-only |
| `pmo_team_invites` | Enabled | Workspace members (SELECT only) | **No** — no INSERT/UPDATE/DELETE policy for `authenticated`; writes go through `saveTeamInvites` (service-role, workspace resolved server-side) | workspace-scoped, writes service-role-only |
| `workspaces` | Enabled | Workspace members | Workspace members can create/update rows tied to their own membership (see `20260512160000_workspace_authorization_rewrite.sql` and later governance migrations) | workspace-scoped |
| `projects` | Enabled | Workspace members | Workspace members | workspace-scoped |
| `company_usage` | Enabled | Own company only (`current_company_id() = company_id`), **read-only** | **No** — since PR-2 (`20261022000000_quota_server_only_authority.sql`) writes happen only inside the SECURITY DEFINER quota RPCs, which are EXECUTE-able by service_role only and called from `src/lib/quota/upload-quota.ts` (F3/F20) | server-only writes |
| `quota_reservations` | Enabled | Own company only (`current_company_id() = company_id`), **read-only** | **No** — same as `company_usage` (PR-2) | server-only writes |
| `profiles` | N/A | — | — | **No `profiles` table exists in this schema.** User identity/display data lives in `auth.users.user_metadata`, not a `public.profiles` table. |
| `tasks` | N/A | — | — | **No literal `tasks` table exists.** Task-shaped data lives in `execution_tasks`, `task_drafts`, etc. (out of scope for this pass — not in Perilla 6's named regression set and not touched by Perillas 1-6). |

## How each sensitive table is protected

### `workspace_memberships`

The source of truth for workspace/billing authorization. Before this
perilla, `20260515100000_rls_governance_fixes.sql` (Phase 3c) had already
enabled RLS and added two SELECT-only policies:

- `users_can_read_own_workspace_memberships` — a user can always read their
  own row.
- `workspace_admins_can_read_all_memberships` — an owner/admin can read every
  row in their workspace.

**No INSERT/UPDATE/DELETE policy exists for `authenticated` at all.** RLS
default-denies any command with no matching policy, so a direct client write
to `workspace_memberships` fails regardless of the caller's role. All writes
go through one of three server helpers, all of which use the privileged
client and resolve the role/workspace from server-side state, never from a
client-supplied field:

1. `ensureWorkspaceMembership` (`src/lib/workspaces.ts`) — workspace
   creation bootstrap, `role: "owner"` for the creator only.
2. `acceptWorkspaceInvite` (`src/lib/workspace-team.ts`) — role always comes
   from the resolved invite record, never a parameter.
3. `updateWorkspaceMemberRole` (`src/lib/workspace-team.ts`) — role change
   gated by `canUpdateWorkspaceMemberRole` (owner-safety, no self-promotion,
   no last-owner demotion — see `docs/security/workspace-role-update-boundary.md`).

A fourth path, `src/lib/early-access.ts`, upserts a `role: "owner"` row when
an early-access invite activates a new workspace — same privileged-client
pattern, registered in the same inventory.

`tests/supabase-rls-service-role-boundary.test.mjs` (test #14) source-scans
every `.from("workspace_memberships")` call with an insert/update/upsert/
delete and fails if any file outside that allowlist writes to the table.

### `company_subscriptions`

**This perilla's primary fix.** The original migration
(`20260428120000_p0_state_tables.sql`) granted a single `for all to
authenticated using (current_company_id() = company_id) with check (...)`
policy — meaning any authenticated user could directly INSERT/UPDATE/DELETE
their own `company_subscriptions` row via the Supabase client/REST API,
setting `plan`, `subscription_status`, `stripe_customer_id`, or
`stripe_subscription_id` to anything they wanted. This completely bypassed
the Stripe webhook signature check (Perilla 6) and the checkout route's
workspace-membership billing gate (Perilla 2) — the exact class of bug those
perillas closed at the application layer, reopened one layer down.

`20260818000000_supabase_rls_service_role_boundary_hardening.sql` splits
that policy:

- `authenticated can read own company_subscriptions` — **SELECT only**,
  same scope as before (`current_company_id() = company_id`). Reads are
  unchanged: `src/app/(protected)/command-center/page.tsx`,
  `src/app/(protected)/billing/page.tsx`, `src/app/api/upload/route.ts`,
  `src/app/api/analyze-ai/route.ts`, `src/app/api/billing/state/route.ts`,
  and `src/app/api/copilot/route.ts` all still work unmodified.
- `service role manages company_subscriptions` — `for all to service_role`.
  Since only `src/lib/billing.ts` ever calls `.from("company_subscriptions")`
  with a write, and it accepts a caller-supplied client, this table now has
  exactly two approved writers:
  1. **`src/app/api/billing/webhook/route.ts`** → `billing-webhook-lifecycle.ts`
     → `billing.ts`, using the single privileged client built once, after
     `verifyStripeWebhookEvent` succeeds.
  2. **`src/app/api/billing/create-checkout-session/route.ts`**, which now
     explicitly passes `useServiceRole: true` to `updateCompanySubscription`
     when bootstrapping a first-time `stripe_customer_id`, gated on its own
     `requireBillingManageMembership` check (Perilla 2) — previously this
     call silently relied on the (now-removed) authenticated write policy.

`tests/supabase-rls-service-role-boundary.test.mjs` (tests #3, #15) assert
no authenticated write policy exists on this table and that `billing.ts` is
the only file writing to it.

### `billing_webhook_events`

Unchanged by this perilla — it was already correctly scoped:
`20260509120000_billing_webhook_events.sql` enables RLS and grants `for all`
only `to service_role`. No `authenticated`/`anon` policy exists. Idempotency
lifecycle writes (`beginBillingWebhookEventProcessing` /
`markBillingWebhookEventProcessed` / `...Ignored` / `...Failed`) all live in
`src/lib/billing.ts` and always run against the webhook route's
post-signature-verification privileged client.

### `early_access_invites` / `early_access_events` / `trial_licenses` / `workspace_activations`

Unchanged by this perilla — already correctly scoped:
`20260512198000_early_access_trials.sql` enables RLS on all four tables and
grants `for all` only `to service_role`. No normal authenticated user can
list invite emails, trial status, or activation telemetry via a direct
table query. The founder dashboard
(`src/app/(protected)/early-access/page.tsx`) and summary API
(`src/app/api/early-access/summary/route.ts`) both gate on
`isFounderOrInternalUser(user)` *before* the privileged client is
instantiated (Perilla 5). The public accept flow
(`src/app/api/early-access/accept/route.ts` → `acceptEarlyAccessInvite`)
validates the invite email against the authenticated session before any
mutation and never reads the founder gate.

### `workspace_invitations`

`token` **was** a plaintext, unhashed bearer secret (tracked as a known debt
in `docs/security/invite-workspace-role-boundary.md`). Before this perilla,
the member-read policy (`workspace members can read invitations`, added in
`20260515100000_rls_governance_fixes.sql`) made every column — including
`token` — visible to any workspace member via a direct table query, even
though the application itself only ever selects
`email, role, expires_at, status` for that audience
(`src/app/(protected)/team/page.tsx`). RLS is row-level, not column-level, so
the plaintext token was one crafted REST call away from any member's session.

`20260818000000_supabase_rls_service_role_boundary_hardening.sql` revokes the
blanket `authenticated` SELECT grant and re-grants a column-scoped SELECT
that excludes `token`.

**Perilla 11 closes the debt entirely**:
`20260820000000_workspace_invite_token_hashing.sql` drops the plaintext
`token` column, adds `token_hash` (sha256 of a 192-bit CSPRNG token, see
`src/lib/security/invite-tokens.ts`), revokes legacy pending plaintext
invitations, and re-issues the column-scoped SELECT grant so `token_hash` is
service-role-only. The only reader of `token_hash` is the service-role client
inside `acceptWorkspaceInvite` (`src/lib/workspace-team.ts`), which hashes
the presented token, validates status/expiry/revocation, and matches the
invite's email against the authenticated session's email (Perilla 3) before
ever writing a membership row. Invite creation (`inviteWorkspaceMember`)
still runs on the owner/admin's own RLS-scoped session and writes only the
hash; the plaintext exists once, in the returned accept URL.

### `pmo_team_invites`

RLS enabled, one SELECT policy scoping reads to workspace members. No
INSERT/UPDATE/DELETE policy for `authenticated` exists, so writes are
default-denied for a direct client and go only through `saveTeamInvites`
(`src/lib/pmo/save-team-invites.ts`), which resolves the workspace from the
authenticated user's own membership (`resolveCanonicalWorkspace`) before
writing via the privileged client.

## Approved service-role usages

Every direct `createSupabaseServiceRoleClient(`/`createPrivilegedSupabaseClient(`
call site is listed in `src/lib/security/privileged-access-registry.ts`,
each with its purpose, risk level, mitigations, and (where applicable) which
strict-legitimacy criterion it meets (L1 cross-tenant RLS block, L2 system
bootstrap/no session, L3 the operation IS the security primitive, L4
cross-tenant aggregation). At minimum, the approved categories are:

- **Stripe webhook** (`src/app/api/billing/webhook/route.ts`,
  `src/lib/billing.ts`) — no user session on an internet-facing webhook;
  signature verified before the privileged client is ever created.
- **Founder/internal early access dashboard and actions**
  (`src/app/(protected)/early-access/page.tsx`,
  `src/app/api/early-access/summary/route.ts`, `src/lib/early-access.ts`) —
  `isFounderOrInternalUser` gate runs before any privileged client.
- **Workspace invite acceptance** (`src/lib/workspace-team.ts`) — the
  invited user is not yet a member of the target workspace, so a scoped
  client cannot resolve/write the membership; email-match validated first.
- **Billing lifecycle** (`src/lib/billing.ts`,
  `src/app/api/billing/webhook/route.ts`,
  `src/app/api/billing/create-checkout-session/route.ts` via
  `useServiceRole: true`) — see the `company_subscriptions` section above.
- **Workspace bootstrap** (`src/lib/workspaces.ts`) — first-login, no
  workspace/membership exists yet for the user.
- **Storage** (`src/lib/storage/upload-provider.ts`) — the
  `pmfreak-documents` bucket's storage policy is `service_role`-only by
  design (`20260515200000_storage_bucket_setup.sql`); there is no scoped
  alternative.
- **Background/async processing** (`src/lib/project-evidence/evidence-processor.ts`,
  `src/lib/project-discovery/discovery-repository.ts`) — deferred via
  `setTimeout` after the HTTP response has already returned, so there is no
  request-scoped session left to build a scoped client from, even though the
  underlying tables (`project_evidence`, `project_evidence_content`,
  `project_discovery`) have workspace-member RLS policies that would permit
  a scoped read/write for an in-request caller.

## Prohibited service-role usages

- Any privileged client creation without the full `PrivilegedAccessContext`
  (`routeId`, `operation`, `reason`, `actorUserId`/`systemActor`) —
  enforced by `assertContext` in `createPrivilegedSupabaseClient`.
- Any privileged client creation from a `"use client"` file or a module it
  imports (`tests/supabase-rls-service-role-boundary.test.mjs` test #7).
- Any usage site not listed in `privileged-access-registry.ts`
  (`assertPrivilegedAccessJustified`, test #8).
- Using service role to satisfy a read/write that an RLS-scoped
  `createSupabaseServerClient()` could already perform for the authenticated
  actor's own data, purely for convenience. (Several existing usages —
  `src/app/(protected)/dashboard/page.tsx`,
  `src/lib/workspaces/canonical-workspace-resolver.ts`,
  `src/lib/pmo/load-pmo-tenant.ts`, `src/lib/pmo/save-workspace-governance.ts`
  — are flagged as SWAP candidates in the registry rather than swapped in
  this pass; see Residual risks.)

## Alignment with Perillas 1-6

| Perilla | Application guard | Database boundary that now agrees |
|---|---|---|
| 1 — Signup role escalation | `user_metadata.role` never authorizes | No RLS policy in the codebase authorizes off `user_metadata`/`raw_user_meta_data`/`jwt() ->> 'role'` (test #6) |
| 2 — Billing authorization via workspace role | `requireBillingManageMembership` gates checkout/portal | `company_subscriptions` has no authenticated write policy — a bypassed route can't reach the table directly either |
| 3 — Invite acceptance | Email-match + server-resolved role | `workspace_invitations.token` no longer broadly SELECT-able; `workspace_memberships` has no authenticated write policy |
| 4 — Role update / owner safety | `canUpdateWorkspaceMemberRole` denies self-promotion/last-owner demotion | Same — no authenticated UPDATE policy on `workspace_memberships.role` at all, so the DB can't be used to route around the helper |
| 5 — Founder/admin/early-access/trial endpoints | `isFounderOrInternalUser` gate before any privileged read | `early_access_invites/events`, `trial_licenses`, `workspace_activations` are `service_role`-only by RLS — no authenticated policy exists to read around the gate |
| 6 — Stripe webhook / billing lifecycle | Signature verified before any mutation | `billing_webhook_events` is `service_role`-only by RLS; `company_subscriptions` writes are now also `service_role`-only |

## Known residual risks

- **No live Supabase/Postgres instance in this test environment.** All
  guarantees in this document are enforced by source/migration text scans
  (`tests/supabase-rls-service-role-boundary.test.mjs`), not by exercising
  real anon/authenticated/service-role Postgres roles against a live
  database. A migration that is syntactically present but never applied, or
  a typo'd table/column name inside a policy body, would not be caught.
- **Remediated (PR-1, `20261021000000_current_company_id_from_auth_uid.sql`):
  `current_company_id()` now returns `auth.uid()::text` and no longer reads
  user-editable metadata; the history below is kept for context.** It
  previously read
  `auth.jwt() -> 'user_metadata' ->> 'company_id'`, and Supabase's
  `user_metadata` is client-editable via `supabase.auth.updateUser()`. This
  affects a broad set of legacy tables that predate the workspace model
  (`company_usage`, `project_memories`, `onboarding_analyses`,
  `operational_memory_domains`, `governance_audit_events`,
  `operational_memory_v1`, `operational_runtime_memory`,
  `operational_memory_nutrient_links`, `dashboard_source_snapshots`, and
  more) — a user who edits their own `user_metadata.company_id` could
  potentially read/write another `company_id`'s rows in any of these
  tables, if they can guess or discover a target `company_id`. This is a
  pre-existing architectural pattern spanning far more tables than the
  sensitive-table list this perilla scoped to, and fixing it (moving every
  `current_company_id()`-scoped table onto `workspace_memberships`-based
  RLS, as `projects` and others already were migrated in
  `20260512160000_workspace_authorization_rewrite.sql`) is a full data-model
  migration, not a bounded policy fix — out of scope for this perilla.
  `company_subscriptions`'s read policy (unlike its write policy, which this
  perilla fixed) still depends on `current_company_id()`, so this residual
  risk does apply to Stripe customer/subscription id disclosure via read,
  even though mutation is now fully closed.
- **Several service-role usages are documented as SWAP candidates, not
  swapped**: `src/app/(protected)/dashboard/page.tsx`,
  `src/lib/workspaces/canonical-workspace-resolver.ts`,
  `src/lib/pmo/load-pmo-tenant.ts`, `src/lib/pmo/save-workspace-governance.ts`
  read/write tables that already have an RLS policy permitting the
  equivalent scoped operation for the authenticated actor. They were left
  as service-role for this pass to avoid touching shared, high-traffic
  code paths (workspace resolution, PMO onboarding) without a live-DB
  regression pass. Swapping them would reduce blast radius further but is
  not required to close any of the gaps this perilla targets.
- ~~**`workspace_invitations.token` remains plaintext**~~ — **RESOLVED in
  Perilla 11**: `20260820000000_workspace_invite_token_hashing.sql` dropped
  the plaintext column and moved the table to sha256 `token_hash` storage
  (matching the pattern already used for
  `early_access_invites.invite_token_hash` and governance
  delegation/handshake tokens). See the `workspace_invitations` section
  above and `tests/workspace-invite-token-hashing.test.mjs`.
- **`governance_approval_requests`'s `approval_update_scope` policy** has
  `with check (true)` (unrestricted result) paired with a scoped `using`
  clause — a pre-existing governance-table pattern outside this perilla's
  named sensitive-table list (workspace_memberships, workspace_invitations,
  company_subscriptions, billing_webhook_events, early_access_*,
  pmo_team_invites). Not modified in this pass; flagged here for visibility.
- **No `profiles` or literal `tasks` table exists** in this schema (see the
  classification table above) — the corresponding items in the perilla's
  minimum table list are not applicable to this codebase.
