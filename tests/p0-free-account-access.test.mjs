/**
 * P0 — production Free-plan accounts were sent to /trial-inactive.
 *
 * Root cause: `resolveOnboardingState` treated "no trial license" exactly like
 * "expired trial". Public /signup never provisions a trial license (only
 * early-access invite acceptance does — src/lib/early-access.ts), so every
 * self-serve Free account was `trial_blocked` on every request after the one
 * that bootstrapped its workspace (that request alone passes via
 * `isRecovered`). /api/login then answered with a 307 to /trial-inactive,
 * which re-POSTed to a GET-only page → 405.
 *
 * These tests invoke the real resolver/gate/post-auth functions against a fake
 * service-role client that answers per table AND per query shape, so the
 * first trial lookup, the expiry write and the refreshed read are distinct.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveOnboardingState, resolveTrialEntitlement } from "../src/lib/auth/resolve-onboarding-state.ts";
import { getOnboardingRedirect } from "../src/lib/auth/onboarding-route-map.ts";
import { shouldRedirectForOnboarding } from "../src/lib/auth/onboarding-gate.ts";
import { resolvePostAuthDestination } from "../src/lib/auth/resolve-post-auth-destination.ts";

const user = { id: "user-free", email: "free@customer.example" };
const DAY = 24 * 60 * 60 * 1000;

/**
 * `world` describes persisted rows. `trial` is the user's most recent trial
 * license (or null). `fail` names tables whose reads return an error.
 */
function fakeClient(world) {
  const writes = [];
  let trial = world.trial ? { ...world.trial } : null;
  const client = {
    writes,
    from(table) {
      const ops = [];
      const resolve = (single) => {
        if (world.fail?.includes(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
        const op = (name) => ops.find((o) => o.name === name);
        switch (table) {
          case "workspace_memberships": {
            const rows = (world.memberships ?? []).map((workspace_id) => ({ workspace_id, user_id: user.id })).sort((a, b) => a.workspace_id.localeCompare(b.workspace_id));
            const range = op("range")?.args;
            return { data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null, count: rows.length };
          }
          case "trial_licenses": {
            const update = op("update");
            if (update) {
              writes.push({ table, values: update.args[0], filters: ops.filter((o) => ["eq", "lt"].includes(o.name)).map((o) => o.args) });
              const cutoff = op("lt")?.args[1];
              if (trial && trial.trial_status === "active" && cutoff && trial.trial_end_at < cutoff && world.expiryWriteLands !== false) {
                trial = { ...trial, ...update.args[0] };
              }
              return { data: null, error: null };
            }
            const row = trial ? { created_at: "2026-09-01T00:00:00.000000+00:00", ...trial } : null;
            if (single) return { data: row, error: null };
            // trial_licenses ⋈ the user's memberships (the resolver's !inner join).
            return { data: row && (world.memberships ?? []).includes(row.workspace_id) ? [row] : [], error: null };
          }
          case "projects":
            return { data: world.projects ?? [], error: null };
          case "execution_tasks":
            return { data: world.tasks ?? [], error: null };
          case "pmos":
            return { data: world.pmos ?? [], error: null };
          default:
            return { data: null, error: null };
        }
      };
      const builder = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "then") return (onOk, onErr) => Promise.resolve(resolve(false)).then(onOk, onErr);
            if (prop === "maybeSingle" || prop === "single") return async () => resolve(true);
            return (...args) => {
              ops.push({ name: prop, args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return client;
}

const resolveFor = (world, opts = {}) => {
  const client = fakeClient(world);
  return resolveOnboardingState(user, world.workspaceId ?? "ws-free", { ...opts, getClient: () => client }).then((state) => ({ state, client }));
};

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

// ─── Newly registered Free account, no trial license ─────────────────────────

test("a newly registered Free account with no trial license is not trial_blocked — it needs a project", async () => {
  const { state } = await resolveFor({ memberships: ["ws-free"], trial: null });
  assert.equal(state, "needs_project");
});

test("a Free account reaches /projects/new — never /trial-inactive — on every request after workspace bootstrap", async () => {
  // isRecovered is false on every request except the one that bootstrapped the
  // workspace; that is exactly where production users were being blocked.
  const { state } = await resolveFor({ memberships: ["ws-free"], trial: null }, { isRecovered: false });
  const dest = getOnboardingRedirect(state);
  assert.equal(dest, "/projects/new");
  assert.notEqual(dest, "/trial-inactive");

  // Protected layout on /projects/new: gate says "onboarding redirect" but the
  // loop guard renders the page itself (currentPath === dest).
  assert.equal(shouldRedirectForOnboarding({ state, routedWorkspaceArchived: false }), true);
  const currentPath = "/projects/new";
  assert.equal(currentPath === dest, true, "layout renders /projects/new instead of redirecting");
});

test("post-login destination for a Free account is /projects/new", async () => {
  const { state } = await resolveFor({ memberships: ["ws-free"], trial: null });
  const decision = resolvePostAuthDestination({ isAuthenticated: true, onboardingState: state, requestedRoute: null, isRequestedRouteSafe: false });
  assert.deepEqual(decision, { destination: "/projects/new", reason: "onboarding-required" });
});

test("a Free account without a trial license writes nothing to trial_licenses", async () => {
  const { client } = await resolveFor({ memberships: ["ws-free"], trial: null });
  assert.deepEqual(client.writes, []);
});

// ─── Normal onboarding progression for a Free account ────────────────────────

test("Free account progresses needs_project → needs_task → execution_started → active", async () => {
  const base = { memberships: ["ws-free"], trial: null };
  assert.equal((await resolveFor({ ...base })).state, "needs_project");
  assert.equal((await resolveFor({ ...base, projects: [{ id: "p1" }] })).state, "needs_task");
  assert.equal((await resolveFor({ ...base, projects: [{ id: "p1" }], tasks: [{ id: "t1" }] })).state, "execution_started");
  assert.equal((await resolveFor({ ...base, projects: [{ id: "p1" }], tasks: [{ id: "t1" }], pmos: [{ id: "pmo1" }] })).state, "active");
});

test("once a Free account has a project, general navigation is open (no onboarding redirect)", async () => {
  const { state } = await resolveFor({ memberships: ["ws-free"], trial: null, projects: [{ id: "p1" }] });
  assert.equal(shouldRedirectForOnboarding({ state, routedWorkspaceArchived: false }), false);
});

// ─── Active invited trial ─────────────────────────────────────────────────────

test("an active invited trial within its window is entitled", async () => {
  const trial = { id: "t1", invite_id: "i1", workspace_id: "ws-trial", trial_status: "active", trial_end_at: iso(7 * DAY) };
  const { state, client } = await resolveFor({ workspaceId: "ws-trial", memberships: ["ws-trial"], trial });
  assert.equal(state, "needs_project");
  assert.equal(client.writes.length, 1, "the expiry write is still attempted (guarded by trial_end_at < now)");
});

test("a pending (not yet activated) invited trial is entitled", async () => {
  const trial = { id: "t1", invite_id: "i1", workspace_id: "ws-trial", trial_status: "pending", trial_end_at: null };
  const { state } = await resolveFor({ workspaceId: "ws-trial", memberships: ["ws-trial"], trial });
  assert.equal(state, "needs_project");
});

// ─── Expired or revoked trial stays blocked ──────────────────────────────────

test("an expired trial is trial_blocked and redirects to /trial-inactive", async () => {
  const trial = { id: "t1", invite_id: "i1", workspace_id: "ws-trial", trial_status: "expired", trial_end_at: iso(-DAY) };
  const { state } = await resolveFor({ workspaceId: "ws-trial", memberships: ["ws-trial"], trial, projects: [{ id: "p1" }] });
  assert.equal(state, "trial_blocked");
  assert.equal(getOnboardingRedirect(state), "/trial-inactive");
  assert.equal(shouldRedirectForOnboarding({ state, routedWorkspaceArchived: true, routedProjectArchived: true }), true);
});

test("an active trial past trial_end_at is expired on read and blocked", async () => {
  const trial = { id: "t1", invite_id: "i1", workspace_id: "ws-trial", trial_status: "active", trial_end_at: iso(-DAY) };
  const { state, client } = await resolveFor({ workspaceId: "ws-trial", memberships: ["ws-trial"], trial });
  assert.equal(state, "trial_blocked");
  assert.deepEqual(client.writes[0].values, { trial_status: "expired" });
});

test("an active trial past trial_end_at is blocked even when the expiry write does not land", async () => {
  const trial = { id: "t1", invite_id: "i1", workspace_id: "ws-trial", trial_status: "active", trial_end_at: iso(-DAY) };
  const { state } = await resolveFor({ workspaceId: "ws-trial", memberships: ["ws-trial"], trial, expiryWriteLands: false });
  assert.equal(state, "trial_blocked");
});

test("a revoked trial is trial_blocked", async () => {
  const trial = { id: "t1", invite_id: "i1", workspace_id: "ws-trial", trial_status: "revoked", trial_end_at: iso(7 * DAY) };
  const { state } = await resolveFor({ workspaceId: "ws-trial", memberships: ["ws-trial"], trial });
  assert.equal(state, "trial_blocked");
});

test("an expired trial on ANY of the user's workspaces still blocks — switching to a trial-less workspace does not dodge it", async () => {
  const trial = { id: "t1", invite_id: "i1", workspace_id: "ws-trial", trial_status: "expired", trial_end_at: iso(-DAY) };
  const { state } = await resolveFor({ workspaceId: "ws-other", memberships: ["ws-trial", "ws-other"], trial });
  assert.equal(state, "trial_blocked");
});

// ─── Unauthorized access / no valid entitlement ──────────────────────────────

test("a user with no workspace membership at all is blocked", async () => {
  const { state } = await resolveFor({ workspaceId: "ws-someone-else", memberships: [], trial: null });
  assert.equal(state, "trial_blocked");
});

test("entitlement fails closed when memberships cannot be read", async () => {
  const { state } = await resolveFor({ memberships: ["ws-free"], trial: null, fail: ["workspace_memberships"] });
  assert.equal(state, "trial_blocked");
});

test("entitlement fails closed when trial licenses cannot be read", async () => {
  const { state } = await resolveFor({ memberships: ["ws-free"], trial: null, fail: ["trial_licenses"] });
  assert.equal(state, "trial_blocked");
});

test("resolveTrialEntitlement: Free → entitled, expired → blocked, revoked → blocked, active → entitled", async () => {
  const at = (status, end) => ({ id: "t1", invite_id: "i1", workspace_id: "ws", trial_status: status, trial_end_at: end });
  assert.equal(await resolveTrialEntitlement(fakeClient({ memberships: ["ws"], trial: null }), user.id), "entitled");
  assert.equal(await resolveTrialEntitlement(fakeClient({ memberships: ["ws"], trial: at("expired", iso(-DAY)) }), user.id), "blocked");
  assert.equal(await resolveTrialEntitlement(fakeClient({ memberships: ["ws"], trial: at("revoked", iso(DAY)) }), user.id), "blocked");
  assert.equal(await resolveTrialEntitlement(fakeClient({ memberships: ["ws"], trial: at("active", iso(DAY)) }), user.id), "entitled");
});

test("a null workspace is still no_workspace (never silently entitled to a workspace)", async () => {
  assert.equal(await resolveOnboardingState(user, null), "no_workspace");
});
