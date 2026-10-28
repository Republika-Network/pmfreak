// PMF-001/PMF-002 correction pass — requirement 16: verify the new
// login/signup post-auth destination resolution does not assume a
// getAuthUser()/cookie-backed session read succeeds immediately after
// sign-in/sign-up in the same request.
//
// Design: signup/actions.ts and api/login/route.ts now build the identity
// used for resolveOnboardingState/resolveCanonicalWorkspace directly from
// the sign-in/sign-up call's own response (`data.user`), never from a
// subsequent getAuthUser() call. resolveOnboardingState and
// resolveCanonicalWorkspace both use the service-role Supabase client (keyed
// explicitly by userId), which does not read cookies at all — so neither
// function's correctness depends on whether next/headers' cookies() has
// propagated the freshly-set session cookie within the same request.
//
// This test proves both halves: (1) the source no longer calls
// getAuthUser() in either flow, and (2) real invocation of
// resolveOnboardingState with only a minimal {id, email} — exactly what a
// sign-in/sign-up response provides, with no cookie read involved — resolves
// correctly against a fake, non-cookie-backed client.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveOnboardingState } from "../src/lib/auth/resolve-onboarding-state.ts";

const read = (p) => readFileSync(p, "utf8");

function fakeClient(tableResponses) {
  return {
    from(table) {
      const result = tableResponses[table] ?? { data: null, error: null };
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        update: () => builder,
        lt: () => builder,
        neq: () => builder,
        maybeSingle: async () => result,
        then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
      };
      return builder;
    },
  };
}

test("signup/actions.ts no longer calls getAuthUser() for post-signup destination resolution", () => {
  const src = read("src/app/signup/actions.ts");
  assert.doesNotMatch(src, /import\s*\{[^}]*getAuthUser/, "must not import getAuthUser");
  assert.doesNotMatch(src, /await getAuthUser\(\)/, "must not depend on a cookie-backed session read immediately after signUp()");
  // Since PR-4 (F6) the identity is a server-verified context built from the
  // response's own user, so operator checks downstream can trust it.
  assert.match(src, /data\.user\s*\?\s*\(buildAuthUserContext\(data\.user,\s*\{\s*verifiedByAuthServer:\s*true\s*\}\)\s*\?\?\s*\{\s*id:\s*data\.user\.id/, "must build identity directly from signUp's own response");
});

test("api/login/route.ts no longer calls getAuthUser() for post-login destination resolution", () => {
  const src = read("src/app/api/login/route.ts");
  assert.doesNotMatch(src, /import\s*\{[^}]*getAuthUser/, "must not import getAuthUser");
  assert.doesNotMatch(src, /await getAuthUser\(\)/, "must not depend on a cookie-backed session read immediately after signInWithPassword()");
  // Since PR-4 (F6) the identity is a server-verified context built from the
  // response's own user, so operator checks downstream can trust it.
  assert.match(src, /data\.user\s*\?\s*\(buildAuthUserContext\(data\.user,\s*\{\s*verifiedByAuthServer:\s*true\s*\}\)\s*\?\?\s*\{\s*id:\s*data\.user\.id/, "must build identity directly from signInWithPassword's own response");
});

test("resolveOnboardingState resolves correctly from only {id, email} — exactly what a sign-in/sign-up response provides, no session/cookie read involved", async () => {
  // Simulates the exact shape signup/actions.ts and api/login/route.ts now
  // construct from `data.user`. If this real invocation succeeds using only
  // a fake, explicitly-passed query client (no cookies() call anywhere in
  // this call chain), the destination decision is proven independent of
  // cookie propagation.
  const freshlyAuthenticatedUser = { id: "user-new-1", email: "new@test.dev" };
  const client = fakeClient({
    projects: { data: [], error: null },
  });
  const state = await resolveOnboardingState(freshlyAuthenticatedUser, "ws-1", {
    isRecovered: true,
    getClient: () => client,
  });
  assert.equal(state, "needs_project");
});

test("resolveOnboardingState's own client (service-role) is reused for evidence collection, never collectWorkspaceActivationEvidence's cookie/RLS-scoped default", () => {
  const src = read("src/lib/auth/resolve-onboarding-state.ts");
  assert.match(src, /getClient:\s*async\s*\(\)\s*=>\s*supabase/, "evidence collection must reuse this resolver's own already-constructed client, not create a new cookie-backed one");
});

test("OnboardingStateUser type is a minimal {id, email} shape, not the full cookie-derived AuthUserContext", () => {
  const src = read("src/lib/auth/resolve-onboarding-state.ts");
  assert.match(src, /export type OnboardingStateUser = \{ id: string; email: string \| null \}/);
});
