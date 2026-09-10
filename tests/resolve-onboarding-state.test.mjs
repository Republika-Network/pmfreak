import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveOnboardingState } from '../src/lib/auth/resolve-onboarding-state.ts';
import { getOnboardingRedirect, isOnboardingComplete } from '../src/lib/auth/onboarding-route-map.ts';

const resolverSrc = readFileSync('src/lib/auth/resolve-onboarding-state.ts', 'utf8');
const routeMapSrc = readFileSync('src/lib/auth/onboarding-route-map.ts', 'utf8');
const postAuthSrc = readFileSync('src/lib/auth/resolve-post-auth-destination.ts', 'utf8');
const proxySrc = readFileSync('src/proxy.ts', 'utf8');
const layoutSrc = readFileSync('src/app/(protected)/layout.tsx', 'utf8');
const callbackSrc = readFileSync('src/app/auth/callback/route.ts', 'utf8');
const authRedirectSrc = readFileSync('src/lib/auth-redirect.ts', 'utf8');

// --- fake Supabase query client (real invocation, not source-text) ---

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

const user = { id: 'user-1', email: 'u@test.dev', fullName: 'U', companyId: 'c1', companyName: 'Acme', role: 'owner', onboardingCompleted: false };

// --- resolve-onboarding-state.ts: real invocation ---

test('OnboardingState type covers all 4 states (no needs_pmo_setup)', () => {
  assert.match(resolverSrc, /"no_workspace"/);
  assert.match(resolverSrc, /"needs_project"/);
  assert.match(resolverSrc, /"active"/);
  assert.match(resolverSrc, /"trial_blocked"/);
  assert.doesNotMatch(resolverSrc, /"needs_pmo_setup"/);
});

test('returns "no_workspace" when workspaceId is null', async () => {
  const state = await resolveOnboardingState(user, null);
  assert.equal(state, 'no_workspace');
});

test('returns "trial_blocked" for a revoked trial', async () => {
  const client = fakeClient({
    workspace_memberships: { data: [{ workspace_id: 'ws-1' }], error: null },
    trial_licenses: { data: { id: 't1', invite_id: 'i1', workspace_id: 'ws-1', trial_status: 'revoked', trial_end_at: '2020-01-01' }, error: null },
  });
  const state = await resolveOnboardingState(user, 'ws-1', { getClient: () => client });
  assert.equal(state, 'trial_blocked');
});

test('returns "needs_project" when a workspace has zero PMOs and zero projects — no PMO precondition', async () => {
  const client = fakeClient({ projects: { data: [], error: null } });
  const state = await resolveOnboardingState(user, 'ws-1', { isRecovered: true, getClient: () => client });
  assert.equal(state, 'needs_project');
});

test('returns "needs_task" (not blocked at needs_project) when a real project exists with no task and no PMO', async () => {
  // "active" now specifically means Command Center is active (see
  // tests/pmf-001-002-state-authority-reconciliation.test.mjs for the full
  // reconciliation) — a bare project alone is "needs_task". The invariant
  // this test protects (no PMO precondition) still holds: it never falls
  // back to needs_project or any PMO-gated state.
  const client = fakeClient({ projects: { data: [{ id: 'p1' }], error: null }, execution_tasks: { data: [], error: null } });
  const state = await resolveOnboardingState(user, 'ws-1', { isRecovered: true, getClient: () => client });
  assert.equal(state, 'needs_task');
});

test('returns "active" once Command Center is active (a real pmos row exists), regardless of task existence', async () => {
  const client = fakeClient({ projects: { data: [{ id: 'p1' }], error: null }, execution_tasks: { data: [], error: null }, pmos: { data: [{ id: 'pmo1' }], error: null } });
  const state = await resolveOnboardingState(user, 'ws-1', { isRecovered: true, getClient: () => client });
  assert.equal(state, 'active');
});

test('resolver never queries the pmos table (no PMO precondition anywhere in resolution)', () => {
  assert.doesNotMatch(resolverSrc, /\.from\("pmos"\)/);
  assert.doesNotMatch(resolverSrc, /loadPmoTenant/);
});

test('bypasses trial check for internal/founder users (isRecovered option)', () => {
  assert.match(resolverSrc, /isFounderOrInternalUser/);
  assert.match(resolverSrc, /isRecovered/);
});

test('no JWT-boolean-derived sync resolver exists — DB-derived resolveOnboardingState is the only resolver', () => {
  assert.doesNotMatch(resolverSrc, /resolveOnboardingStateFromJwt/);
});

// --- onboarding-route-map.ts ---

test('getOnboardingRedirect maps needs_project to /projects/new (no PMO/Command Center route)', () => {
  assert.equal(getOnboardingRedirect('needs_project'), '/projects/new');
});

test('getOnboardingRedirect maps no_workspace to /projects/new (safe fallback, never the legacy wizard)', () => {
  assert.equal(getOnboardingRedirect('no_workspace'), '/projects/new');
});

test('getOnboardingRedirect maps trial_blocked to /trial-inactive', () => {
  assert.equal(getOnboardingRedirect('trial_blocked'), '/trial-inactive');
});

test('getOnboardingRedirect maps active to /command-center', () => {
  assert.equal(getOnboardingRedirect('active'), '/command-center');
});

test('isOnboardingComplete returns true only for "active" state', () => {
  assert.equal(isOnboardingComplete('active'), true);
  assert.equal(isOnboardingComplete('needs_project'), false);
  assert.equal(isOnboardingComplete('no_workspace'), false);
  assert.equal(isOnboardingComplete('trial_blocked'), false);
});

test('no route map entry redirects to a PMO/Command Center creation route', () => {
  assert.doesNotMatch(routeMapSrc, /return\s+"\/create-command-center"/);
  assert.doesNotMatch(routeMapSrc, /return\s+"\/create-pmo"/);
});

// --- resolve-post-auth-destination.ts ---

test('PostAuthContext accepts onboardingState (canonical) field', () => {
  assert.match(postAuthSrc, /onboardingState\?.*OnboardingState/);
});

test('onboardingCompleted is deprecated in favor of onboardingState', () => {
  assert.match(postAuthSrc, /@deprecated/);
  assert.match(postAuthSrc, /onboardingCompleted\?/);
});

test('boolean-only fallback destination is project-first, not the legacy wizard', () => {
  assert.doesNotMatch(postAuthSrc, /"\/workspace\/setup"/);
});

test('Phase 4: non-active state overrides safe continuation route', () => {
  assert.match(postAuthSrc, /isOnboardingComplete\(state\)/);
  assert.match(postAuthSrc, /getOnboardingRedirect\(state\)/);
});

// --- proxy.ts: Edge middleware makes no onboarding-state decisions ---

test('proxy.ts contains no onboarding-state resolution or redirect logic', () => {
  assert.doesNotMatch(proxySrc, /resolveOnboardingStateFromJwt/);
  assert.doesNotMatch(proxySrc, /onboarding_completed/);
  assert.doesNotMatch(proxySrc, /getOnboardingRedirect/);
  assert.doesNotMatch(proxySrc, /"needs_project"/);
  assert.doesNotMatch(proxySrc, /"needs_pmo_setup"/);
});

test('proxy.ts still redirects unauthenticated users on protected routes and quarantines /workspace', () => {
  assert.match(proxySrc, /isProtectedPageRoute\(pathname\) && !user/);
  assert.match(proxySrc, /pathname === "\/workspace"/);
});

// --- layout.tsx: the sole onboarding-state redirect authority ---

test('protected layout uses resolveOnboardingState (canonical resolver) and redirects on needs_project too', () => {
  // The persistent route gate uses hasWorkspaceAccess (not
  // isOnboardingComplete): a Project may exist, and general navigation
  // remains open, before Command Center is active — see
  // tests/pmf-001-002-state-authority-reconciliation.test.mjs.
  // hasWorkspaceAccess is no longer called directly: the gate is now
  // shouldRedirectForOnboarding, which is EQUAL to !hasWorkspaceAccess for every
  // state on a non-archived render (asserted exhaustively in
  // tests/onboarding-gate-archived-workspace.test.ts) and differs only by
  // exempting an archived routed workspace from "needs_project". The invariant
  // this test guards — one canonical resolver, one derived destination, and
  // needs_project still redirecting — is unchanged.
  assert.match(layoutSrc, /resolveOnboardingState/);
  assert.match(layoutSrc, /shouldRedirectForOnboarding\(\{ state: onboardingState/);
  assert.match(layoutSrc, /getOnboardingRedirect\(onboardingState\)/);
});

test('protected layout has a loop guard against redirecting to the current path', () => {
  assert.match(layoutSrc, /currentPath !== dest/);
});

test('protected layout no longer checks user.onboardingCompleted directly', () => {
  assert.doesNotMatch(layoutSrc, /user\.onboardingCompleted/);
});

test('protected layout no longer calls loadPmoTenant directly', () => {
  assert.doesNotMatch(layoutSrc, /loadPmoTenant/);
});

// --- auth/callback/route.ts ---

test('callback route uses resolveOnboardingState', () => {
  assert.match(callbackSrc, /resolveOnboardingState/);
});

test('callback route no longer reads onboarding_completed boolean directly', () => {
  assert.doesNotMatch(callbackSrc, /user_metadata\?\.onboarding_completed/);
});

// --- auth-redirect.ts ---

test('resolvePostAuthRedirectPath uses canonical resolver', () => {
  assert.match(authRedirectSrc, /resolveOnboardingState/);
});

test('getPostAuthRedirectPath is marked deprecated', () => {
  assert.match(authRedirectSrc, /@deprecated/);
});
