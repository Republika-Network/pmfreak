/**
 * Companion to signup-onboarding-resolution-failure-fixed.test.mjs. That
 * file proves the try/catch fallback engages correctly ON FAILURE; this
 * file proves it does NOT engage when resolution succeeds — i.e. the fix
 * doesn't quietly turn every signup into a hardcoded /projects/new
 * redirect regardless of actual onboarding state.
 *
 * This does NOT route the success case through `signupAction` itself, for
 * a confirmed, reproduced reason: `resolveCanonicalWorkspace`/
 * `resolveOnboardingState`'s DB access goes through
 * `createPrivilegedSupabaseClient` (src/lib/security/privileged-access.ts)
 * -> `@supabase/supabase-js`'s `createClient`. Unlike every other package
 * mocked in this test suite, `@supabase/supabase-js` ships its raw `.ts`
 * source alongside `dist/` inside `node_modules` (`"files": ["dist",
 * "src"]`) — confirmed by direct reproduction: importing it from a `.ts`
 * file (any `.ts` file, not specific to this codebase) resolves through
 * tsx to `node_modules/@supabase/supabase-js/src/index.ts`, not
 * `dist/index.mjs`, in a way that bypasses `node:test`'s
 * `t.mock.module()` hook entirely — mocking both the `dist` and `src`
 * target URLs was tried and neither intercepts the call. This is a tsx
 * resolution behavior specific to this one package, not the `@/`-alias
 * issue documented in the other test files.
 *
 * Given that, this exercises the real, unmocked `resolveOnboardingState`
 * (real evidence-collection logic, real state-machine rules) via its own,
 * already-existing `opts.getClient` test seam — the same seam
 * `(protected)/layout.tsx`'s own tests would use — supplying a
 * `workspaceId` directly rather than also routing through
 * `resolveCanonicalWorkspace` (whose own success/failure behavior is
 * already covered by signup-onboarding-resolution-failure-{pre-fix,fixed})
 * — plus the real, unmocked `resolvePostAuthDestination`, proving that
 * `signupAction`'s actual call shape
 * (`resolvePostAuthDestination({ onboardingState: await
 * resolveOnboardingState(...), ... })`) reaches the real, evidence-derived
 * `/command-center` destination when resolution succeeds, not the
 * try/catch's `/projects/new` fallback.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { makeFakeAdminQueryClient } from "./release-gate-01-fake-supabase.mjs";

test("SUCCESS PATH UNCHANGED: resolveOnboardingState + resolvePostAuthDestination reach /command-center (not the failure-fallback /projects/new) when Command Center is already active", async () => {
  const { resolveOnboardingState } = await import("../../src/lib/auth/resolve-onboarding-state.ts");
  const { resolvePostAuthDestination } = await import("../../src/lib/auth/resolve-post-auth-destination.ts");

  const adminClient = makeFakeAdminQueryClient({
    workspace_memberships: { data: [{ workspace_id: "ws-1", role: "owner", created_at: "2020-01-01T00:00:00Z", user_id: "user-new-1" }] },
    workspaces: { data: [{ id: "ws-1", status: "active", owner_type: "user" }] },
    // created_at is NOT NULL in trial_licenses; the entitlement resolver orders by it.
    trial_licenses: { data: [{ id: "trial-1", invite_id: null, workspace_id: "ws-1", trial_status: "active", trial_end_at: "2999-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" }] },
    pmos: { data: [{ id: "pmo-1" }] },
    projects: { data: [{ id: "project-1" }] },
  });

  // Byte-for-byte the call shape live in src/app/signup/actions.ts (and
  // src/app/api/login/route.ts): resolveOnboardingState(authUser,
  // workspaceId), its result threaded straight into
  // resolvePostAuthDestination({ onboardingState, ... }).
  const authUser = { id: "user-new-1", email: "newuser@example.com" };
  const onboardingState = await resolveOnboardingState(authUser, "ws-1", { getClient: () => adminClient });
  assert.equal(onboardingState, "active", "real evidence-collection logic must resolve to active Command Center given this evidence");

  const decision = resolvePostAuthDestination({
    isAuthenticated: true,
    onboardingState,
    requestedRoute: null,
    isRequestedRouteSafe: false,
  });
  assert.equal(decision.destination, "/command-center", "a successfully-resolved active state must reach /command-center, not the failure-fallback /projects/new");
  assert.notEqual(decision.reason, "onboarding-required", "must not be routed via the same reason code the try/catch fallback (undefined onboardingState) produces");
});
