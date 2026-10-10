/**
 * Production signup confirmation must never point at localhost.
 *
 * Regression: a real pmfreak.com signup produced a confirmation email whose
 * link opened http://localhost:3000. signupAction built emailRedirectTo from
 * NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"; with only
 * NEXT_PUBLIC_APP_URL configured in production, Supabase received a
 * localhost redirect_to, rejected it against the Redirect URLs allowlist,
 * and fell back to its Site URL (also localhost).
 *
 * Also covers /auth/confirm, the token_hash route that works when the email
 * is opened on a different device than the one that signed up (no PKCE
 * code_verifier cookie needed).
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { makeCookieJar, mockModuleOptions, resolveMockTarget } from "./release-gate-01-fake-supabase.mjs";

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
// Without a service-role key, onboarding resolution throws; both signup and
// /auth/confirm must then fall back to /projects/new without losing the session.
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const calls = { signUp: [], verifyOtp: [] };
let verifyOtpResult = { data: { user: null, session: null }, error: null };

mock.module(resolveMockTarget("next/headers"), mockModuleOptions({
  cookies: async () => makeCookieJar({ writesSucceed: true }),
  headers: async () => ({ get: () => null }),
}));
mock.module(resolveMockTarget("@supabase/ssr"), mockModuleOptions({
  createServerClient: () => ({
    auth: {
      signUp: async (args) => {
        calls.signUp.push(args);
        return { data: { user: null, session: null }, error: null };
      },
      verifyOtp: async (args) => {
        calls.verifyOtp.push(args);
        return verifyOtpResult;
      },
    },
  }),
}));

const ENV_KEYS = ["VERCEL_ENV", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SITE_URL", "APP_URL"];
function withEnv(overrides, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
  return Promise.resolve(fn()).finally(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function signupForm() {
  const formData = new FormData();
  formData.set("email", "new-user@example.com");
  formData.set("password", "a-strong-password");
  formData.set("fullName", "New User");
  formData.set("companyName", "Acme");
  return formData;
}

async function runSignup() {
  const { signupAction } = await import("../../src/app/signup/actions.ts");
  calls.signUp.length = 0;
  await assert.rejects(() => signupAction(signupForm()), (err) => {
    assert.match(err.digest ?? "", /^NEXT_REDIRECT;replace;\/signup\/confirm-email\?email=/);
    return true;
  });
  assert.equal(calls.signUp.length, 1);
  return calls.signUp[0].options.emailRedirectTo;
}

test("production signup sends the https production callback as emailRedirectTo (NEXT_PUBLIC_APP_URL only)", () =>
  withEnv({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://pmfreak.com" }, async () => {
    assert.equal(await runSignup(), "https://pmfreak.com/auth/callback");
  }));

test("production signup never falls back to localhost when no app URL is configured", () =>
  withEnv({ VERCEL_ENV: "production" }, async () => {
    const { signupAction } = await import("../../src/app/signup/actions.ts");
    calls.signUp.length = 0;
    await assert.rejects(() => signupAction(signupForm()), /NEXT_PUBLIC_APP_URL/);
    assert.equal(calls.signUp.length, 0, "signUp must not be called with a localhost redirect in production");
  }));

test("production signup refuses a localhost app URL", () =>
  withEnv({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:3000" }, async () => {
    const { signupAction } = await import("../../src/app/signup/actions.ts");
    calls.signUp.length = 0;
    await assert.rejects(() => signupAction(signupForm()), /NEXT_PUBLIC_APP_URL/);
    assert.equal(calls.signUp.length, 0);
  }));

test("local development keeps the localhost callback", () =>
  withEnv({ VERCEL_ENV: "development" }, async () => {
    assert.equal(await runSignup(), "http://localhost:3000/auth/callback");
  }));

async function runConfirm(query) {
  const { GET } = await import("../../src/app/auth/confirm/route.ts");
  calls.verifyOtp.length = 0;
  const response = await GET(new Request(`https://pmfreak.com/auth/confirm${query}`));
  return new URL(response.headers.get("location"));
}

test("/auth/confirm verifies the token_hash and continues into onboarding on the production origin", async () => {
  verifyOtpResult = { data: { user: { id: "user-1", email: "new-user@example.com" }, session: { access_token: "x" } }, error: null };
  const location = await runConfirm("?token_hash=hash-abc&type=email");
  assert.deepEqual(calls.verifyOtp, [{ type: "email", token_hash: "hash-abc" }]);
  assert.equal(location.origin, "https://pmfreak.com");
  assert.equal(location.pathname, "/projects/new", "unknown onboarding state must land on mandatory onboarding");
});

test("/auth/confirm ignores an unsafe next continuation", async () => {
  verifyOtpResult = { data: { user: { id: "user-1", email: "new-user@example.com" }, session: {} }, error: null };
  const location = await runConfirm("?token_hash=hash-abc&type=email&next=//evil.example");
  assert.equal(location.origin, "https://pmfreak.com");
  assert.equal(location.pathname, "/projects/new");
});

test("/auth/confirm sends expired or invalid tokens to /login with an error", async () => {
  verifyOtpResult = { data: { user: null, session: null }, error: { message: "Token has expired or is invalid", code: "otp_expired" } };
  const location = await runConfirm("?token_hash=stale&type=email");
  assert.equal(calls.verifyOtp.length, 1);
  assert.equal(location.pathname, "/login");
  assert.match(location.searchParams.get("error") ?? "", /invalid or expired/);
});

for (const query of ["", "?type=email", "?token_hash=hash-abc", "?token_hash=hash-abc&type=recovery"]) {
  test(`/auth/confirm rejects malformed link "${query}" without calling Supabase`, async () => {
    const location = await runConfirm(query);
    assert.equal(calls.verifyOtp.length, 0);
    assert.equal(location.pathname, "/login");
  });
}
