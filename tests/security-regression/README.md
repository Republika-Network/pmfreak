# Security regression harness (PR-0)

Regression tests for the authorization and tenant-isolation findings from the Phase 1.5
security remediation design. They run against a **disposable, loopback-only** Supabase
stack and exercise real GoTrue sessions, real PostgREST/RLS and real application code.

| File | Finding | What it proves |
|---|---|---|
| `f1-tenant-identity-spoofing.test.mjs` | F1 | A user who rewrites their own `user_metadata.company_id` through GoTrue gains nothing: `current_company_id()` and the app-layer `companyId` stay their own id, and they cannot read, write or delete another company's rows (including its usage counter and quota reservations) — remediated by PR-1 |
| `f2-billing-tenant-isolation.test.mjs` | F2 | After the F1 spoof, `/api/billing/state` still resolves the caller's own Free plan — never the victim's Pro plan, Stripe ids or AI entitlement (remediated by PR-1); checkout/portal stay hard-stopped while the release flag is off |
| `f3-f20-quota-manipulation.test.mjs` | F3, F20 | A signed-in user can neither call the quota RPCs directly (own company included), supply their own limit, nor write `company_usage` / `quota_reservations` through PostgREST (PR-2); the quota functions refuse cross-tenant, anonymous and F1-spoofed callers (C1). The real server engine (`src/lib/quota/upload-quota.ts`) keeps the reserve / commit / cancel lifecycle working, derives the limit from the server-written subscription, cannot be driven past the plan limit by concurrent requests, refuses a company other than the actor's own, and records every privileged access |
| `f5-privileged-server-actions.test.mjs` | F5 | Viewers and pms cannot run `savePmoTenant` / `saveTeamInvites` / `saveWorkspaceGovernance` (owner/admin only since PR-3) and leave no partial write; owner/admin flows keep working, re-activation never transfers `data_owner`, and invite roles/domain foci outside the closed PMO sets are rejected |
| `f6-operator-access.test.mjs` | F6 | Operator authority is the verified user id listed in `FOUNDER_OPERATOR_USER_IDS` with a confirmed email (PR-4): unlisted `@pmfreak.ai` / `@onchainfest.xyz` signups, a listed-but-unconfirmed user, tenant owners/admins, forged body identities, `FOUNDER_EMAIL_ALLOWLIST` and missing/malformed configuration all get 403 on the early-access founder routes and the founder-program operator gate, with no early-access write; the configured operator keeps the summary / invite / trial-extension / revocation / dashboard workflows |
| `f21-viewer-rls-writes.test.mjs` | F21, F5 (RLS) | Real PostgREST calls: viewers cannot insert / update / upsert / delete projects, tasks, milestones, RAID items or dependencies; changed workspace ids and cross-tenant foreign keys (project, task, milestone, RAID item, document) cannot launder a write; pms create and update, only owners/admins delete; cross-tenant writes refused — every refusal checked against a two-tenant snapshot (F21). Workspace governance is read-only for viewers and pms and writable by owners/admins (F5, PR-3) |
| `f21-product-workflows.test.mjs` | F21 | The real app write paths under the new RLS: project creation (API, wizard, Command Center) refuses viewers with `insufficient_role` before any write; the wizard's privileged compensating rollback removes a pm's half-created project; pm edits, admin deletes; task / milestone / dependency APIs and vault intake (RAID materialization) work for a pm and write nothing for a viewer. `compat/f21-evidence-workflows.test.mjs` (manual — append-only evidence needs a stack reset) covers the pm wizard and Command Center happy paths |
| `f22a-tenant-isolation-and-escalation.test.mjs` | F22-A (R1–R3) | R1: no member of tenant B (viewer → owner), nor a privileged writer, can store evidence, evidence content or discovery whose workspace differs from its project's; viewers cannot write evidence at all; tenant A's discovery (run by the real `regenerateProjectDiscovery`) lands only in A and B's viewer reads none of it; pms keep the evidence workflow. R2: admins cannot create or edit owner invitations, re-target, re-token, pre-accept or reopen invitations, or issue in another user's name; acceptance (the real `acceptWorkspaceInvite`) never changes an existing membership and voids invitations whose inviter lost the right to grant them; legitimate owner/admin invitations and revocation still work. R3: viewers cannot write decisions; writers cannot impersonate a creator / approver / rejecter / implementer, clear or re-attribute an approval, skip review, or move a decision; the draft → review → approve → implement lifecycle still works |
| `f22b-active-workflow-authorization.test.mjs` | F22-B | Real PostgREST calls as owner / admin / pm / viewer of tenant B and the owner of tenant A: viewers cannot write vault documents or signals, task drafts, execution task events, recommended-action decision rows, governance violations or commitments; writers cannot impersonate a creator / actor / decider, reference another tenant's project, document, action, RAID item, task or governance action, store an evidence storage path outside their own upload prefix, or change a stored path / uploader; no client reads invitation token hashes; members read and write only their own copilot state; an account with an unconfirmed email cannot accept an invitation (real `acceptWorkspaceInvite` against GoTrue) until it is confirmed — every refusal checked against a two-tenant snapshot |
| `f22b-product-workflows.test.mjs` | F22-B | The real routes: vault intake for owner / admin / pm and refused for a viewer or another tenant; task draft materialization → status → approval → conversion (draft, decision row and task-created event recorded as the acting pm), refused status change for a viewer; recommended-action decisions; real upload + evidence deletion removing the verified object, and a legacy row whose path points at another tenant's object deleted WITHOUT touching that object |
| `pd14-project-duplicate-quota.test.mjs` | PD-14 (QA W2) | Duplicating a project counts against the plan's project limit: no client role can execute `duplicate_project_within_limit` (so nobody supplies their own limit); through the real route a Free owner duplicates up to 3 and then gets 402 `upgrade_required`; 8 concurrent duplicates by one user through the real engine create exactly up to the limit; a refused duplicate consumes nothing; viewers and another tenant are refused (route and in-database) with nothing written; a paid plan keeps duplicating beyond 3 |
| `sec-w3-brief-authz-and-extraction-bounds.test.mjs` | SEC-W3-1, SEC-W3-2 (QA W3) | Governance brief regeneration: owner, admin and pm succeed (attributed); a viewer is refused by the route and by RLS (PostgREST update/insert) with the brief unchanged; another tenant is refused and cannot squat a project's brief slot from its own workspace. Document bounds: DOCX and XLSX inflation bombs and a ZIP that is not the declared container get 400 `UNSAFE_DOCUMENT` at upload with no row, stored object or quota charge; a small legitimate DOCX is still extracted; text beyond the extraction bound ends `failed` with no stored content. Limits are lowered for the file so every archive stays a few MB |
| `pd22-pd23-document-formats.test.mjs` | PD-22, PD-23 (QA W3) | Every supported format reaches extracted content through the real route, bucket and background processor: a valid XLSX, PPTX and multi-page PDF are stored, processed and their text persisted in the project's workspace (the bucket's MIME allowlist matches the route's); a viewer still cannot upload (nothing stored or charged); another tenant cannot read the extracted text. PD-22 itself is build-specific and is proven by the production-build browser harness and the CI build |
| `pd25-pd26-project-lifecycle.test.mjs` | PD-25, PD-26 (QA W3) | Archive is read-only: after a pm archives the project, upload, vault intake, Brain turn, operational capture and rename are refused with 409 `project_archived` (route and `can_write_operational_project` in the database, PostgREST insert refused under RLS) and nothing is written; the project and its evidence stay readable; a writer can still duplicate it; a viewer and another tenant cannot reactivate, a pm can, and writes resume. Delete leaves nothing behind: the real route removes the evidence rows, both uploaders' bucket objects, the project's vault documents and digestion runs (no orphan at workspace level), another project's objects stay, the cleanup job completes; the drain is idempotent and a retried job completes as a no-op; a project with execution tasks is refused with 409 `project_has_retained_history` and nothing is deleted or enqueued; viewers and another tenant cannot delete |
| `q12-project-create-quota.test.mjs` | Q12 (QA W2) | Creating a project counts against the plan's project limit atomically on every create path: no client role can execute `create_project_within_limit`; 8 concurrent creates by one Free user through the real engine → exactly 3; 3 creates racing 3 duplicates from 2 projects → exactly 1 (one shared per-actor lock); 8 concurrent `POST /api/projects` → three 201, five 402 `upgrade_required`; the API, Command Center and wizard racing each other never exceed the limit, and a rolled-back wizard insert frees its slot; refused and failed creates consume nothing; viewers and another tenant are refused by every entry point and in-database; a paid plan keeps creating and duplicating in parallel. The wizard runs only with an injected downstream failure (its success path writes append-only evidence) |
| `b6-ai-cost-ledger.test.mjs` | B6 (AI cost control) | No client role can call `reserve_ai_cost` / `settle_ai_cost` or read or write `ai_cost_reservations`; 12 concurrent reservations stop exactly at the workspace ceiling; settlement frees exactly the unused part, is final, and only a definitive non-generation may release; a key in flight or answered is never spent twice while a failed one keeps its charge on retry; workspaces are isolated and the user and deployment-wide ceilings span them; a viewer's Project Brain turn through the real route is reserved, sent once to a synthetic OpenAI and settled at the real cost of `gpt-4.1-mini-2025-04-14` (the dated id that recorded NULL cost in production), an exhausted budget answers in limited mode without calling the model, and another tenant cannot spend the workspace's budget |
| `registry.test.mjs` | — | `known-vulnerabilities.json` and the test files stay in lockstep (static) |

## Expected failures

Vulnerabilities that are still present are registered in `known-vulnerabilities.json` and
written with `knownVulnerability(caseId, title, secureExpectation)`. The callback asserts
the **secure** behaviour, unweakened:

- the assertion fails → the vulnerability reproduced → reported as `EXPECTED FAILURE`, test passes;
- the assertion passes → `UNEXPECTED PASS`, test **fails** — the fix PR must convert the case
  to a regular test and delete it from the registry;
- anything other than an `AssertionError` (network, setup, missing table) → test **fails**.

Every file also contains positive controls that must pass, so an expected failure can only
be explained by the vulnerability itself.

## Running locally

Never point this suite at a hosted project — it creates and deletes users and tenant data.
It refuses any non-loopback URL and fails (never skips) when configuration is missing.

```bash
npx supabase start                       # disposable local stack, applies all migrations
eval "$(npx supabase status -o env)"     # exports API_URL / ANON_KEY / SERVICE_ROLE_KEY
SECURITY_HARNESS_SUPABASE_URL="$API_URL" \
SECURITY_HARNESS_ANON_KEY="$ANON_KEY" \
SECURITY_HARNESS_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
npm run test:security-regression
```

In CI (`release-governance.yml`) the values come from the `OPERATIONAL_FLOW_TEST_*`
variables the workflow already exports. Stripe and OpenAI configuration is removed from
the test process; no Stripe or model call is possible.

## Remediated cases

When a fix lands, its cases move out of `known-vulnerabilities.json` and become ordinary
tests that must keep passing:

- **C1** (`20261019000000_quota_rpc_caller_binding.sql`): cross-tenant reserve, commit and
  cancel; anonymous calls; and F1-spoofed callers are refused with `42501` and change no
  quota row. Fixtures use real `YYYY-MM` month keys now that B1
  (`20261020000000_fix_company_usage_current_month_check.sql`) accepts them.
- **F1 / PR-1** (`20261021000000_current_company_id_from_auth_uid.sql`, `src/lib/auth.ts`,
  `src/lib/feature-gates.ts`): tenant identity is the authenticated user id, never
  `user_metadata.company_id`. A spoofed caller cannot resolve another company through
  `current_company_id()`, read / write / delete its company-scoped rows, or inherit its plan,
  Stripe ids or AI entitlement (all F1 cases, and the F2 cases whose root cause was F1). F2's
  billing binding (PR-5) and every other finding remain registered.
- **F3 / F20 / PR-2** (`20261022000000_quota_server_only_authority.sql`,
  `src/lib/quota/upload-quota.ts`, `src/lib/usage-limits.ts`): the quota RPCs are EXECUTE-able by
  `service_role` only and both quota tables are read-own for `authenticated`. The application
  calls the RPCs through a context-tagged service-role client, only for the authenticated
  actor's own company, with the limit derived from the company's subscription row.
- **F5 / PR-3** (`20261023000000_workspace_governance_role_aware_rls.sql`,
  `src/lib/pmo/save-pmo-tenant.ts`, `save-team-invites.ts`, `save-workspace-governance.ts`): the
  three PMO server actions require an owner/admin membership (`requireWorkspaceRole`) before any
  service-role write, and `workspace_governance` writes are owner/admin-only under RLS.
- **F6 / PR-4** (`src/lib/auth.ts`): founder/internal operator authority is the GoTrue-verified
  user id listed in the server-only `FOUNDER_OPERATOR_USER_IDS`, with a confirmed email. Email
  domains and `FOUNDER_EMAIL_ALLOWLIST` grant nothing. Absent or malformed configuration denies
  every operator. The decision reads only identity facts recorded when `getAuthUser()` built the
  context, so a fabricated or copied user object is never an operator. F2's billing binding (PR-5)
  remains open.
- **F21** (`20261024000000_project_data_role_aware_rls.sql`): `projects`, `execution_tasks`,
  `project_milestones`, `raid_items` and `execution_task_dependencies` are written by owners /
  admins / pms only (USING and WITH CHECK), deleted by owners / admins only, and every referenced
  project / task / milestone / RAID item / draft / action / document must be in the row's own
  workspace. Membership-only write policies on the other ~200 tables are a tracked residual
  (per-table role decisions pending). The expected-failure registry is now empty.
- **F22-A** (`20261025000000_f22a_tenant_isolation_and_escalation.sql`, `discovery-repository.ts`,
  `workspace-team.ts`): discovery resolves the tenant from `projects` and reads evidence by
  `(project_id, workspace_id)`; composite foreign keys make evidence, evidence content and
  discovery rows whose workspace differs from their project's unstorable for every writer, and
  only owners / admins / pms write them (R1). Invitations carry invitable roles only, are issued
  by owners / admins in their own name and can afterwards only be revoked or expired; acceptance
  refuses owner roles, inviters who can no longer grant the role, and users who are already
  members (R2). Decisions are written by owners / admins / pms acting only as themselves, along
  the product's state machine (R3). Pre-deploy data checks: `docs/security/f22a-predeploy-checks.md`.
- **F22-B** (`20261026000000_f22b_active_workflow_authorization.sql`, the vault intake and task-draft
  status route gates, `isEvidenceStoragePathFor` in the evidence delete route, GoTrue-verified
  invitation acceptance): active-workflow tables are written by owners / admins / pms acting as
  themselves within their own workspace; evidence storage paths are bound to the uploader's prefix
  and immutable; the privileged storage delete re-validates the path; copilot state is the
  caller's own; invitations require a confirmed email. Pre-deploy data checks:
  `docs/security/f22b-predeploy-checks.md`.
