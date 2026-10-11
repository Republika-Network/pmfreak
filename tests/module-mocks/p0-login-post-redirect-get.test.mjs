/**
 * P0 — POST /api/login must answer with POST/Redirect/GET (303 See Other).
 *
 * `NextResponse.redirect()` defaults to 307, which tells the browser to repeat
 * the POST (method and body) against the destination. Every destination this
 * route produces is a page (`/login?error=…`, `/projects/new`,
 * `/command-center`, `/trial-inactive`), and page routes answer POST with
 * 405. Combined with Free accounts being misclassified as `trial_blocked`,
 * production users saw a 405 on /trial-inactive immediately after logging in.
 *
 * Exercises the real `POST` export with the real `createSupabaseServerClient`
 * cookie adapter, the real `resolveCanonicalWorkspace` and the real
 * `resolveOnboardingState`. Only the I/O boundary is mocked: `next/headers`,
 * `@supabase/ssr` (GoTrue) and `@supabase/supabase-js` (the service-role
 * PostgREST client). Module mocks are registered once, before the route is
 * imported, and read a mutable `world` so every test drives the same cached
 * module graph.
 */

import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { makeCookieJar, mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

const DAY = 24 * 60 * 60 * 1000;
const world = { jar: null, memberships: [], trial: null, projects: [] };

function fakeServiceRoleClient() {
  return {
    from(table) {
      const ops = [];
      const resolve = () => {
        if (ops.some((o) => o.name === "update" || o.name === "insert")) return { data: null, error: null };
        switch (table) {
          case "workspace_memberships":
            return { data: world.memberships.map((workspace_id) => ({ workspace_id, role: "owner", created_at: "2026-10-01T00:00:00Z" })), error: null };
          case "workspaces":
            return { data: world.memberships.map((id) => ({ id, status: "active", owner_type: "user" })), error: null };
          case "trial_licenses":
            return { data: world.trial, error: null };
          case "projects":
            return { data: world.projects, error: null };
          default:
            return { data: [], error: null };
        }
      };
      const builder = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (ok, err) => Promise.resolve(resolve()).then(ok, err);
            if (prop === "maybeSingle" || prop === "single") return async () => resolve();
            return (...args) => {
              ops.push({ name: prop, args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

function createServerClient(_url, _anonKey, { cookies }) {
  return {
    auth: {
      signInWithPassword: async ({ email, password }) => {
        if (password !== "correct-password") {
          return { data: { user: null, session: null }, error: { message: "Invalid login credentials", status: 400 } };
        }
        cookies.setAll([{ name: "sb-pmfreak-auth-token", value: "session-payload", options: { path: "/", httpOnly: true } }]);
        return { data: { user: { id: "user-free", email, user_metadata: {} }, session: { access_token: "a" } }, error: null };
      },
    },
  };
}

mock.module(resolveMockTarget("next/headers"), mockModuleOptions({ cookies: async () => world.jar, headers: async () => ({ get: () => null }) }));
mock.module(resolveMockTarget("@supabase/ssr"), mockModuleOptions({ createServerClient }));
// supabase-js ships separate ESM and CJS entry points; tsx may load either for
// src/lib/security/privileged-access.ts, so intercept both.
const serviceRoleMock = mockModuleOptions({ createClient: () => fakeServiceRoleClient() });
const supabaseJsEsm = resolveMockTarget("@supabase/supabase-js");
const supabaseJsCjs = pathToFileURL(createRequire(import.meta.url).resolve("@supabase/supabase-js")).href;
mock.module(supabaseJsEsm, serviceRoleMock);
if (supabaseJsCjs !== supabaseJsEsm) mock.module(supabaseJsCjs, serviceRoleMock);

const { POST } = await import("../../src/app/api/login/route.ts");

function loginRequest(fields) {
  return new Request("https://pmfreak.example.com/api/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function reset(overrides = {}) {
  world.jar = makeCookieJar({ writesSucceed: true });
  world.memberships = ["ws-free"];
  world.trial = null;
  world.projects = [];
  Object.assign(world, overrides);
}

const location = (response) => new URL(response.headers.get("location"));

test("Free account login: 303 See Other to /projects/new, never /trial-inactive, session cookie kept", async () => {
  reset();
  const response = await POST(loginRequest({ email: "free@customer.example", password: "correct-password" }));
  assert.equal(response.status, 303, "a form POST must be answered with 303 so the browser follows with GET");
  assert.equal(location(response).pathname, "/projects/new");
  assert.notEqual(location(response).pathname, "/trial-inactive");
  assert.equal(world.jar.getAll().find((c) => c.name === "sb-pmfreak-auth-token")?.value, "session-payload");
});

test("Free account with a project and a safe continuation still gets 303 (destination chosen by onboarding state)", async () => {
  reset({ projects: [{ id: "p1" }] });
  const response = await POST(loginRequest({ email: "free@customer.example", password: "correct-password", next: "/team" }));
  assert.equal(response.status, 303);
  assert.equal(location(response).pathname, "/command-center");
});

test("expired-trial account login: 303 to /trial-inactive (still blocked, now reachable with GET)", async () => {
  reset({ memberships: ["ws-trial"], trial: { id: "t1", invite_id: "i1", workspace_id: "ws-trial", trial_status: "expired", trial_end_at: new Date(Date.now() - DAY).toISOString() } });
  const response = await POST(loginRequest({ email: "trial@customer.example", password: "correct-password" }));
  assert.equal(response.status, 303);
  assert.equal(location(response).pathname, "/trial-inactive");
  assert.equal(world.jar.getAll().find((c) => c.name === "sb-pmfreak-auth-token")?.value, "session-payload");
});

test("invalid credentials: 303 back to /login with an error, no session cookie", async () => {
  reset();
  const response = await POST(loginRequest({ email: "free@customer.example", password: "wrong" }));
  assert.equal(response.status, 303);
  assert.equal(location(response).pathname, "/login");
  assert.equal(location(response).searchParams.get("error"), "Invalid login credentials");
  assert.equal(world.jar.getAll().length, 0);
});

test("missing fields: 303 back to /login with an error", async () => {
  reset();
  const response = await POST(loginRequest({ email: "", password: "" }));
  assert.equal(response.status, 303);
  assert.equal(location(response).pathname, "/login");
  assert.ok(location(response).searchParams.get("error"));
});

test("an unsafe continuation is never honoured", async () => {
  reset({ projects: [{ id: "p1" }] });
  const response = await POST(loginRequest({ email: "free@customer.example", password: "correct-password", next: "https://evil.example/steal" }));
  assert.equal(response.status, 303);
  assert.equal(location(response).origin, "https://pmfreak.example.com");
});
