/**
 * Launch UAT hotfix — `/projects/new` failed in production with
 * `project.create.failed / unexpected_exception / Privileged billing access requires explicit context.`
 *
 * `canCreateMoreProjects()` created a correctly contextualized privileged client
 * (feature-gates.canCreateMoreProjects / feature_limit_enforcement / actorUserId) but then called
 * `getCompanySubscription(companyId, { useServiceRole: true })` without `privilegedContext`, which
 * billing.ts rightly refuses. The fix reuses the already-contextualized client.
 *
 * Runs the REAL feature-gates.ts → billing.ts → privileged-access.ts → telemetry.ts chain. Only the
 * true I/O boundary is mocked (`@supabase/supabase-js`, `@supabase/ssr`, `next/headers`), like the
 * other files in this directory.
 *
 * Attribution of each privileged client to its context is observed, not assumed:
 * `createPrivilegedSupabaseClient(ctx)` synchronously inserts the `privileged_client_used`
 * security event (route_id = ctx.routeId) and then calls `createClient()` for the privileged client,
 * so the client created right after a telemetry insert belongs to that insert's route.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { makeCookieJar, mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

const USER_ID = "00000000-0000-4000-8000-0000000000u1";
const COMPANY_ID = "00000000-0000-4000-8000-0000000000c1";

const state = {
  subscriptionRow: null,
  projectCount: 0,
  clients: [],
  telemetry: [],
  pendingRoute: null,
  serverClientCreated: 0,
};

const resetState = ({ subscriptionRow = null, projectCount = 0 } = {}) => {
  state.subscriptionRow = subscriptionRow;
  state.projectCount = projectCount;
  state.clients = [];
  state.telemetry = [];
  state.pendingRoute = null;
  state.serverClientCreated = 0;
};

const makeServiceRoleClient = () => {
  const client = { routeId: state.pendingRoute, queries: [] };
  state.pendingRoute = null;
  state.clients.push(client);

  client.auth = {
    admin: {
      getUserById: async (id) => ({ data: { user: { id, user_metadata: { company_id: COMPANY_ID } } }, error: null }),
    },
  };

  client.from = (table) => {
    client.queries.push(table);
    if (table === "security_events") {
      return {
        insert: async (row) => {
          state.telemetry.push(row);
          state.pendingRoute = row.route_id;
          return { error: null };
        },
      };
    }
    if (table === "company_subscriptions") {
      return {
        select: () => ({
          eq: (column, value) => {
            assert.equal(column, "company_id");
            assert.equal(value, COMPANY_ID);
            return { maybeSingle: async () => ({ data: state.subscriptionRow, error: null }) };
          },
        }),
      };
    }
    if (table === "projects") {
      return {
        select: (_columns, options) => {
          assert.deepEqual(options, { head: true, count: "exact" });
          return {
            eq: async (column, value) => {
              assert.equal(column, "user_id");
              assert.equal(value, USER_ID);
              return { count: state.projectCount, error: null };
            },
          };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };

  return client;
};

// tsx loads src/*.ts through the CommonJS entry of @supabase/supabase-js, while import.meta.resolve()
// yields the ESM entry, so both resolved targets are mocked to guarantee no real client is built.
const supabaseJsTargets = new Set([
  resolveMockTarget("@supabase/supabase-js"),
  pathToFileURL(createRequire(import.meta.url).resolve("@supabase/supabase-js")).href,
]);
for (const target of supabaseJsTargets) {
  mock.module(target, mockModuleOptions({ createClient: () => makeServiceRoleClient() }));
}
mock.module(
  resolveMockTarget("@supabase/ssr"),
  mockModuleOptions({
    createServerClient: () => {
      state.serverClientCreated += 1;
      throw new Error("canCreateMoreProjects must not fall back to the cookie-bound server client");
    },
  }),
);
mock.module(
  resolveMockTarget("next/headers"),
  mockModuleOptions({ cookies: async () => makeCookieJar({ writesSucceed: true }), headers: async () => ({ get: () => null }) }),
);

const { canCreateMoreProjects } = await import("../../src/lib/feature-gates.ts");
const { getCompanySubscription } = await import("../../src/lib/billing.ts");

const privilegedClientsFor = (routeId) => state.clients.filter((client) => client.routeId === routeId);

test("brand-new free user with zero projects passes the gate via the contextualized privileged client", async () => {
  resetState({ subscriptionRow: null, projectCount: 0 });

  const result = await canCreateMoreProjects(USER_ID);

  assert.deepEqual(result, { ok: true, plan: "free", projectLimit: 3 });

  // Exactly one privileged client is attributable to the limit check, and it is the one that read
  // billing AND counted projects — no second, unscoped or uncontextualized privileged client.
  const [gateClient, ...extra] = privilegedClientsFor("feature-gates.canCreateMoreProjects");
  assert.ok(gateClient, "feature-gates.canCreateMoreProjects privileged client was created");
  assert.equal(extra.length, 0);
  assert.deepEqual(gateClient.queries, ["company_subscriptions", "projects"]);

  const gateEvent = state.telemetry.find((row) => row.route_id === "feature-gates.canCreateMoreProjects");
  assert.equal(gateEvent.event_type, "privileged_client_used");
  assert.equal(gateEvent.actor_user_id, USER_ID);
  assert.deepEqual(gateEvent.metadata, { operation: "count_projects", reason: "feature_limit_enforcement" });

  // Every privileged client created is attributable to a known context (telemetry clients are the
  // recursion-bypass ones, created before their own insert).
  const attributed = state.clients.filter((client) => client.routeId !== null).map((client) => client.routeId);
  assert.deepEqual(attributed, ["feature-gates.getCompanyIdByUserId", "feature-gates.canCreateMoreProjects"]);
  assert.ok(state.clients.every((client) => client.routeId !== null || client.queries.every((table) => table === "security_events")));
  assert.equal(state.serverClientCreated, 0);
});

test("project limits are unchanged: free = 3, pro = 25, pmo = effectively unlimited", async () => {
  const cases = [
    { plan: null, count: 2, ok: true, limit: 3 },
    { plan: null, count: 3, ok: false },
    { plan: "free", count: 3, ok: false },
    { plan: "pro", count: 24, ok: true, limit: 25 },
    { plan: "pro", count: 25, ok: false },
    { plan: "pmo", count: 10_000, ok: true, limit: Number.MAX_SAFE_INTEGER },
  ];

  for (const { plan, count, ok, limit } of cases) {
    resetState({
      subscriptionRow: plan
        ? { plan, subscription_status: "active", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: null }
        : null,
      projectCount: count,
    });

    const result = await canCreateMoreProjects(USER_ID);
    const label = `${plan ?? "no subscription row"} with ${count} projects`;
    if (ok) {
      assert.deepEqual(result, { ok: true, plan: plan ?? "free", projectLimit: limit }, label);
    } else {
      assert.deepEqual(result, { ok: false, error: "upgrade_required", feature: "personal_projects", requiredPlan: "pro" }, label);
    }
  }
});

test("billing security invariant holds: useServiceRole without privilegedContext or client throws", async () => {
  resetState();

  await assert.rejects(() => getCompanySubscription(COMPANY_ID, { useServiceRole: true }), {
    message: "Privileged billing access requires explicit context.",
  });
  assert.equal(state.clients.length, 0, "no service-role client is created when context is missing");
  assert.equal(state.serverClientCreated, 0, "no silent fallback to another client");
});

test("billing reuses a caller-supplied client instead of creating one", async () => {
  resetState({ subscriptionRow: { plan: "pro", subscription_status: "active", stripe_customer_id: null, stripe_subscription_id: null, current_period_end: null } });
  const supplied = makeServiceRoleClient();
  const before = state.clients.length;

  const subscription = await getCompanySubscription(COMPANY_ID, { client: supplied });

  assert.equal(subscription.plan, "pro");
  assert.equal(state.clients.length, before);
  assert.deepEqual(supplied.queries, ["company_subscriptions"]);
});
