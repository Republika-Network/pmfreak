/**
 * P0 — an already-authenticated browser visiting /signup.
 *
 * The proxy sends authenticated users away from auth routes. This drives the
 * real `proxy()` export (and the real `updateSession`) with only GoTrue
 * mocked, and checks the redirect lands on an authenticated surface with the
 * refreshed session cookies carried along. For a Free account that surface
 * (/command-center) is then gated by (protected)/layout.tsx, which — after the
 * entitlement fix — sends a project-less Free account to /projects/new rather
 * than /trial-inactive (see tests/p0-free-account-access.test.mjs).
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";

const session = { user: null, rotate: false };

function createServerClient(_url, _anonKey, { cookies }) {
  return {
    auth: {
      getUser: async () => {
        if (session.rotate) cookies.setAll([{ name: "sb-pmfreak-auth-token", value: "rotated", options: { path: "/" } }]);
        return session.user
          ? { data: { user: session.user }, error: null }
          : { data: { user: null }, error: { name: "AuthSessionMissingError", status: 400, message: "Auth session missing!" } };
      },
      getSession: async () => ({ data: { session: null } }),
    },
  };
}

mock.module(resolveMockTarget("@supabase/ssr"), mockModuleOptions({ createServerClient }));

const { NextRequest } = await import("next/server");
const { proxy } = await import("../../src/proxy.ts");

const visit = (path) => proxy(new NextRequest(new URL(path, "https://pmfreak.example.com"), { method: "GET" }));

test("authenticated browser on /signup is redirected to /command-center with refreshed cookies preserved", async () => {
  session.user = { id: "user-free", email: "free@customer.example", user_metadata: {} };
  session.rotate = true;
  const response = await visit("/signup");
  assert.ok(response.status >= 300 && response.status < 400, `expected a redirect, got ${response.status}`);
  assert.equal(new URL(response.headers.get("location")).pathname, "/command-center");
  assert.equal(response.cookies.get("sb-pmfreak-auth-token")?.value, "rotated");
});

test("authenticated browser on /signup?next=<safe> is sent to that continuation", async () => {
  session.user = { id: "user-free", email: "free@customer.example", user_metadata: {} };
  session.rotate = false;
  const response = await visit("/signup?next=/projects/new");
  assert.equal(new URL(response.headers.get("location")).pathname, "/projects/new");
});

test("authenticated browser on /signup?next=<unsafe> falls back to /command-center", async () => {
  session.user = { id: "user-free", email: "free@customer.example", user_metadata: {} };
  session.rotate = false;
  const response = await visit("/signup?next=https://evil.example/");
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://pmfreak.example.com");
  assert.equal(location.pathname, "/command-center");
});

test("anonymous browser on /signup is not redirected", async () => {
  session.user = null;
  session.rotate = false;
  const response = await visit("/signup");
  assert.equal(response.headers.get("location"), null);
});

test("anonymous browser on a protected route is sent to /login?next=", async () => {
  session.user = null;
  const response = await visit("/projects/new");
  const location = new URL(response.headers.get("location"));
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("next"), "/projects/new");
});
