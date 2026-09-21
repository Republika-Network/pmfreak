/**
 * P2-17 — caller-trusted portfolio metrics are refused, executed.
 *
 * Runs the REAL, unmodified POST exports of the five retired personal-portfolio compute routes
 * with the real `requireAuthenticatedUser()` → `getAuthUser()` → `createSupabaseServerClient()`
 * chain. Only the true I/O boundary is mocked (`next/headers`, `@supabase/ssr`), exactly like the
 * other files in this directory, which also explains why this is a separate `node --test` file.
 *
 * Each request carries deliberately forged metrics (a critical project claiming health 100,
 * risk 0). The routes must authenticate, then answer 410 without reading the body, so none of
 * those values can reach a computation, a response or a table: the fake Supabase client records
 * every table and RPC touched and must see none.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeCookieJar, mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const ROUTES = ["snapshot", "prioritize", "attention", "neglect", "command-center"];

const FORGED = {
  workspaceId: "00000000-0000-4000-8000-0000000000a1",
  portfolioId: "00000000-0000-4000-8000-0000000000c1",
  projectId: "00000000-0000-4000-8000-000000000101",
  projectMetrics: [
    {
      projectId: "00000000-0000-4000-8000-000000000101",
      projectName: "Forged Critical Project",
      healthScore: 100,
      riskScore: 0,
      blockedTaskCount: 0,
      overdueTaskCount: 0,
      openDecisionsCount: 0,
      openCommitmentsCount: 0,
      criticalFocusCount: 0,
      attentionItems: ["INJECTED ATTENTION ITEM"],
      status: "healthy",
    },
  ],
};

test("P2-17: every retired personal-portfolio compute route refuses forged metrics with 410 and touches no data", async (t) => {
  const touched = [];
  let signedIn = true;
  const jar = makeCookieJar({ writesSucceed: true });
  t.mock.module(resolveMockTarget("next/headers"), mockModuleOptions({ cookies: async () => jar, headers: async () => ({ get: () => null }) }));
  t.mock.module(
    resolveMockTarget("@supabase/ssr"),
    mockModuleOptions({
      createServerClient: () => ({
        auth: {
          getUser: async () =>
            signedIn
              ? { data: { user: { id: "user-1", email: "pmo@example.com", user_metadata: {} } }, error: null }
              : { data: { user: null }, error: null },
        },
        from: (table) => {
          touched.push(`from:${table}`);
          throw new Error(`unexpected table read: ${table}`);
        },
        rpc: (name) => {
          touched.push(`rpc:${name}`);
          throw new Error(`unexpected rpc: ${name}`);
        },
      }),
    }),
  );

  const routes = {};
  for (const name of ROUTES) routes[name] = await import(`../../src/app/api/personal-portfolio/${name}/route.ts`);

  for (const name of ROUTES) {
    let bodyRead = false;
    const request = new Request(`https://pmfreak.test/api/personal-portfolio/${name}`, { method: "POST", body: JSON.stringify(FORGED), headers: { "content-type": "application/json" } });
    const original = request.json.bind(request);
    request.json = async () => { bodyRead = true; return original(); };

    const response = await routes[name].POST(request);
    assert.equal(response.status, 410, `${name} must refuse caller metrics`);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.failureClass, "caller_metrics_not_accepted");
    assert.equal(bodyRead, false, `${name} must not read the body`);
    const serialized = JSON.stringify(body);
    for (const forged of ["Forged Critical Project", "INJECTED ATTENTION ITEM", "healthScore", "riskScore"]) {
      assert.ok(!serialized.includes(forged), `${name} echoed forged value ${forged}`);
    }
  }
  assert.deepEqual(touched, [], "no table or RPC may be touched");

  // Unauthenticated callers still get 401, not the retirement notice.
  signedIn = false;
  for (const name of ROUTES) {
    const response = await routes[name].POST(new Request(`https://pmfreak.test/api/personal-portfolio/${name}`, { method: "POST", body: JSON.stringify(FORGED) }));
    assert.equal(response.status, 401, `${name} unauthenticated`);
  }
});
