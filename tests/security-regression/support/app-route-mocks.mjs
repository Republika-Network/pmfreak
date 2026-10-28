/**
 * Runs real route handlers / server actions as a chosen fixture user.
 *
 * Only the cookie transport is replaced: `next/headers` gets an empty in-memory jar and
 * `@supabase/ssr`'s `createServerClient` returns a REAL supabase-js client already signed
 * in (through real GoTrue) as the active fixture user. Everything else — getAuthUser,
 * workspace resolution, entitlement and billing reads, the privileged service-role client
 * — runs unmodified against the disposable stack. No `@/`-aliased internal module is
 * mocked (see tests/module-mocks/login-onboarding-resolution-failure-pre-fix.test.mjs for
 * why that is unreliable in CI).
 *
 * Must be installed BEFORE any src/ module is imported. Requires
 * `--experimental-test-module-mocks`.
 */
import { mock } from "node:test";
import { makeCookieJar, mockModuleOptions, resolveMockTarget } from "../../module-mocks/release-gate-01-fake-supabase.mjs";

let activeClient = null;

export function installAppRouteMocks() {
  mock.module(
    resolveMockTarget("next/headers"),
    mockModuleOptions({ cookies: async () => makeCookieJar({ writesSucceed: true }), headers: async () => ({ get: () => null }) }),
  );
  mock.module(
    resolveMockTarget("@supabase/ssr"),
    mockModuleOptions({
      createServerClient: () => {
        if (!activeClient) throw new Error("[security-regression] no active fixture session — call actAs() first.");
        return activeClient;
      },
    }),
  );
}

/** Subsequent server-side `createSupabaseServerClient()` calls act as this signed-in client. */
export function actAs(client) {
  activeClient = client;
}
