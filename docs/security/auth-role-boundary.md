# Auth role boundary

Trust boundary for every role concept in PMFreak: where it comes from, who can set it, and what it may gate.

## The vulnerability this closes

Before this fix, `src/app/signup/page.tsx` let a public, unauthenticated visitor pick `role` (`admin` / `pm` / `viewer`) from a `<select>`. `src/app/signup/actions.ts` wrote that client-supplied value straight into Supabase `user_metadata.role`. `isFounderOrInternalUser()` in `src/lib/auth.ts` then trusted `user.role === "owner" || user.role === "admin"` to grant access to founder-only endpoints (`/api/early-access/invites`, `/api/early-access/founder-actions`, `/api/early-access/summary`) and to bypass trial-expiry checks in `resolveOnboardingState`.

Net effect: anyone could `curl` a signup request (or use DevTools) with `role=admin`, and their own self-reported metadata would grant them founder/admin authorization — full privilege escalation with no invitation, no workspace membership, and no review.

## Roles that exist

| Role concept | Type | Trusted source | What it may gate |
| --- | --- | --- | --- |
| **Display role** (`AuthUserContext.role`) | `"owner" \| "admin" \| "pm" \| "viewer"` | `user_metadata.role`, clamped by `toDisplayRole()` in `src/lib/auth.ts` | **Nothing authoritative.** UI copy/labels only. |
| **Workspace role** (`workspace_memberships.role`) | `"owner" \| "admin" \| "pm" \| "viewer"` | `workspace_memberships` table, read via `requireWorkspaceRole()` / `requireBillingManageMembership()` in `src/lib/workspace-access.ts` | Workspace management, invites, billing (`canManageWorkspace`, `canInviteMembers`, `canManageBilling` — see [`billing-authorization-boundary.md`](./billing-authorization-boundary.md)) |
| **Founder/internal role** | boolean | `isFounderOrInternalUser()` in `src/lib/auth.ts`: internal email domains (`@pmfreak.ai`, `@onchainfest.xyz`) or the `FOUNDER_EMAIL_ALLOWLIST` env var | Early-access founder endpoints, trial-expiry bypass |
| **Requested role** (signup form input) | n/a | **Does not exist.** The signup form no longer collects a role. | Nothing — the field is gone from the UI and ignored server-side if injected manually. |

Workspace read authorization never consults the display role: the runtime resolves the caller's `workspace_memberships.role` in the access-verification adapter, which normalizes the persisted `pm` → `PM` and `viewer` → `external_stakeholder` (both hold `read`). A display role of "viewer" shown in the UI is therefore unrelated to whether a workspace read is allowed — see [`workspace-read-authorization-boundary.md`](./workspace-read-authorization-boundary.md) (SIT-024).

## What client input is never trusted

- The signup form (`src/app/signup/page.tsx`) has no role selector.
- `signupAction` (`src/app/signup/actions.ts`) delegates field extraction to `buildSignupProfile()` (`src/app/signup/build-signup-profile.ts`), which **never reads `formData.get("role")`**. Every public signup is assigned `DEFAULT_SIGNUP_ROLE` (`"viewer"`), full stop — a `role=admin` field appended via curl or a modified request is silently discarded.
- `user_metadata.role` (the "display role") is informational only. `toDisplayRole()` clamps it to `"pm" | "viewer"` — it can never read back as `"owner"` or `"admin"`, even if that value is present from historical data, a tampered client, or a direct DB edit. No legitimate code path writes `"owner"`/`"admin"` into `user_metadata.role`; if one is ever found there, it is degraded to `"viewer"` rather than trusted.
- `isFounderOrInternalUser()` does not read `user.role` at all.

## How an elevated role is actually assigned

1. **Workspace admin/owner**: only via `workspace_memberships`, set by:
   - Accepting a validated, single-use, expiring invite token (`acceptWorkspaceInvite` in `src/lib/workspace-team.ts`, called from `src/app/(protected)/accept-invite/[token]/page.tsx`) — the inviter must already hold `admin`/`owner` in `workspace_memberships`, verified server-side via `requireWorkspaceInviteActor`, and the invite's target role can never be `owner`. See [`invite-workspace-role-boundary.md`](./invite-workspace-role-boundary.md) (Perilla 3) for the full boundary, including the identity check (invite email must match the accepting user) added there.
   - Early-access invite activation (`acceptEarlyAccessInvite` in `src/lib/early-access.ts`), which assigns `owner` only after a hashed, single-use, non-expired invite token is validated server-side **and**, since Perilla 3, the invite's email matches the accepting user.
   - Direct DB/admin action.
2. **Updating an existing member's role** (once a `workspace_memberships` row already exists): only via `updateWorkspaceMemberRole` in `src/lib/workspace-team.ts`, whose actor/target roles are resolved server-side (`requireWorkspaceRoleUpdateActor`/`requireWorkspaceRoleUpdateTarget`) and gated by `canUpdateWorkspaceMemberRole` — never from `body.role`, `body.actorRole`, `user_metadata.role`, or display role. `owner` can never be the requested role through this path. See [`workspace-role-update-boundary.md`](./workspace-role-update-boundary.md) (Perilla 4).
3. **Founder/internal access**: only via the internal email domain allowlist or the `FOUNDER_EMAIL_ALLOWLIST` environment variable — both server-controlled, neither reachable from a signup form or request body. See [`admin-founder-endpoint-boundary.md`](./admin-founder-endpoint-boundary.md) (Perilla 5) for the full boundary across every founder/internal/admin/trial-license surface, including the `evaluateFounderOrInternalAccess` decision function and the founder dashboard page gate added there.

## How an administrative endpoint is validated

Founder-only routes (`/api/early-access/invites`, `/api/early-access/founder-actions`, `/api/early-access/summary`, and the `/early-access` dashboard page) all follow the same pattern:

```ts
const user = await requireAuthUser();
if (!isFounderOrInternalUser(user)) return NextResponse.json({ error: "Founder access is required." }, { status: 403 });
```

Workspace-scoped admin actions (e.g. inviting members) call `requireWorkspaceRole(workspaceId, "admin")`, which queries `workspace_memberships` directly — never the display role.

## Regression this fix prevents

- A newly registered user submitting `role=admin` (or `owner`, or `pm`) — via the form, DevTools, or a raw request — can no longer obtain elevated `user_metadata.role`, because the field is never read.
- A user whose `user_metadata.role` is `"admin"`/`"owner"` (spoofed pre-fix, or from stale/tampered data) can no longer pass `isFounderOrInternalUser()` or any founder-gated endpoint on that basis alone.
- Real founders and legitimately invited workspace admins/owners are unaffected — their access comes from the email allowlist and `workspace_memberships` respectively, neither of which this change touches.

## Residual, non-blocking notes

- `src/components/pmfreak/operational-shell.tsx` reads `user.role` to decide UI copy (`canUseGovernanceDirectives`, nav labeling). This is cosmetic — no mutation or governance action is authorized by it — but since `toDisplayRole()` now clamps to `"pm"/"viewer"`, it can no longer show the elevated copy to anyone regardless.
- ~~`src/app/api/billing/create-checkout-session/route.ts` maps the display role into `actorRole` for `enforceRuntimeAuthorization({ action: "billing.manage" })`.~~ **Closed** — see [`billing-authorization-boundary.md`](./billing-authorization-boundary.md) (Perilla 2: Billing Authorization Must Use Workspace Membership Role). Billing authorization (`create-checkout-session`, `create-portal-session`) is now resolved exclusively from `workspace_memberships.role` via `requireBillingManageMembership()`, never from display role, `user_metadata.role`, or any client-supplied field.
- ~~`src/app/(protected)/early-access/page.tsx` called `requireAuthUser()` but never checked `isFounderOrInternalUser()`, so any authenticated user could load the founder dashboard and see every invite email, trial license, and telemetry count.~~ **Closed** — see [`admin-founder-endpoint-boundary.md`](./admin-founder-endpoint-boundary.md) (Perilla 5: Admin / Founder / Early Access / Trial License Endpoint Hardening). The page now gates on `isFounderOrInternalUser()` before the service-role client is instantiated and returns `notFound()` for non-founder users.
