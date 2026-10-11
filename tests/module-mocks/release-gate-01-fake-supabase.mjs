/**
 * Shared fakes for the release-gate-01 production-entry-point regression
 * tests (tests/release-gate-01-*-pattern.test.mjs). Each of those files runs
 * in its own `node --test` child process, so module-level mock state here
 * never leaks between them — see the comment in those files for why that
 * process boundary matters (it's what makes each file's `t.mock.module`
 * calls actually take effect on `src/lib/supabase/server.ts`'s already-
 * cached `@supabase/ssr` import).
 */

// node:test's mock.module() renamed its exports-object option between Node
// major versions: Node 22.x only recognizes `namedExports`; Node 24.x
// recognizes `exports` and only *deprecates* `namedExports` (still works,
// with a warning) — except passing BOTH keys at once throws
// ERR_INVALID_ARG_VALUE on Node 24. Since this repo's local dev, and its CI
// runner (which silently upgrades a pinned Node 20 to whatever the runner's
// current default is), can each land on either major, pick the key the
// running Node actually understands instead of hardcoding one and letting
// the other silently no-op (Node 22 given `exports` doesn't throw — it just
// never applies the mock).
export function mockModuleOptions(exportsObj) {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const key = nodeMajor >= 24 ? "exports" : "namedExports";
  return { [key]: exportsObj };
}

// `t.mock.module()` given a bare specifier (e.g. "next/headers") failed
// with ERR_MODULE_NOT_FOUND in CI ("Cannot find module
// '.../tests/module-mocks/next/headers'") on two different call shapes —
// called from this shared helper, and called directly in the test file
// itself — while never reproducing locally on either Node 22 or Node 24,
// from-scratch npm ci included. That rules out "which file calls
// t.mock.module()" as the variable; the actual cause is some
// non-deterministic edge case in how mock.module()'s bare-specifier
// resolution interacts with tsx's loader (visible in the stack trace:
// tsx's resolveDirectory/resolveBase, which has its own error-message
// text-parsing fallback for ERR_MODULE_NOT_FOUND) — apparently sensitive to
// something not pinned by the lockfile (exact Node patch build, timing).
// Rather than depend on that resolution succeeding, pre-resolve the
// specifier to a concrete file:// URL via `import.meta.resolve()` (which
// mock.module() accepts, and which still intercepts every other importer's
// plain `import ... from "next/headers"` — mock.module matches by resolved
// target, not specifier text) so there is no bare-specifier resolution step
// left for mock.module()/tsx to disagree about.
export function resolveMockTarget(specifier) {
  return import.meta.resolve(specifier);
}

// A real Next.js `cookies()` store, minimally reimplemented: `getAll()` plus
// a `set()` that either persists (Server Action / Route Handler / real
// middleware) or throws exactly as Next does in a Server Component render
// ("Cookies can only be modified in a Server Action or Route Handler"),
// which is what `createSupabaseServerClient`'s setAll try/catch is written
// to swallow.
export function makeCookieJar({ writesSucceed }) {
  const store = new Map();
  return {
    seed(name, value) {
      store.set(name, value);
    },
    getAll: () => Array.from(store.entries()).map(([name, value]) => ({ name, value })),
    set: (name, value) => {
      if (!writesSucceed) {
        throw new Error("Cookies can only be modified in a Server Action or Route Handler");
      }
      store.set(name, value);
    },
  };
}

// Models signUp() succeeding (writing the session cookie via the real
// cookies() adapter, exactly like signIn does) and getUser() reading that
// same cookie back — lets a test verify a second, independent request
// (e.g. a follow-up /api/debug-auth call sharing the same cookie jar)
// recognizes the session signUp established.
export function makeSignUpAndGetUserGoTrueFactory({ email, password, userId }) {
  return function createServerClient(_url, _anonKey, { cookies }) {
    return {
      auth: {
        signUp: async ({ email: attemptedEmail, password: attemptedPassword }) => {
          if (attemptedEmail !== email || attemptedPassword !== password) {
            return { data: { user: null, session: null }, error: { message: "Signup requires a valid email and password.", status: 400 } };
          }
          cookies.setAll([{ name: "sb-signup-auth-token", value: "signup-session-payload", options: { path: "/" } }]);
          return {
            data: {
              user: { id: userId, email: attemptedEmail, user_metadata: {} },
              session: { access_token: "access-1", user: { id: userId, email: attemptedEmail } },
            },
            error: null,
          };
        },
        getUser: async () => {
          const cookie = cookies.getAll().find((c) => c.name === "sb-signup-auth-token");
          if (cookie?.value === "signup-session-payload") {
            return { data: { user: { id: userId, email, user_metadata: {} } }, error: null };
          }
          return { data: { user: null }, error: { status: 401, message: "No session" } };
        },
      },
    };
  };
}

// Minimal fake for `@supabase/supabase-js`'s `createClient` — the
// service-role/admin client `createPrivilegedSupabaseClient` builds
// (src/lib/security/privileged-access.ts), used by
// resolveCanonicalWorkspace, resolveOnboardingState,
// collectWorkspaceActivationEvidence, and the abuse-protection Supabase
// store. `.from(table)` returns a chainable query-builder stub: every
// chain method (select/eq/neq/in/order/limit/update/lt) returns itself,
// and both `.maybeSingle()` and awaiting the chain directly resolve to the
// canned `{ data, error }` configured for that table (default: empty
// array, no error, for any table not explicitly configured). `.rpc()`
// defaults to a low, always-allowed counter (for abuse-protection's
// increment RPC) unless overridden.
export function makeFakeAdminQueryClient(tableResponses = {}, rpcResponses = {}) {
  function makeChain(table) {
    const response = tableResponses[table] ?? { data: [], error: null };
    const rows = Array.isArray(response.data) ? response.data : response.data == null ? [] : [response.data];
    const chain = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      update: () => chain,
      lt: () => chain,
      gte: () => chain,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: response.error ?? null }),
      then: (resolve, reject) => Promise.resolve({ data: response.data, error: response.error ?? null }).then(resolve, reject),
    };
    return chain;
  }
  return {
    from: (table) => makeChain(table),
    rpc: async (name) => rpcResponses[name] ?? { data: 1, error: null },
  };
}

// Models the GoTrue HTTP client `@supabase/ssr`'s createServerClient hands
// back: single-use refresh tokens, an on-demand refresh on an expired access
// token, and (faithfully to real Supabase/GoTrue) the refresh call itself
// still succeeds even when the caller fails to persist the replacement —
// the corrupted state only surfaces on the NEXT call that presents the
// now-already-consumed refresh token.
export function makeFakeGoTrueFactory() {
  const consumedRefreshTokens = new Set();
  return function createServerClient(_url, _anonKey, { cookies }) {
    return {
      auth: {
        getUser: async () => {
          const refreshCookie = cookies.getAll().find((c) => c.name === "sb-refresh-token");
          const accessCookie = cookies.getAll().find((c) => c.name === "sb-access-token");
          const currentRefresh = refreshCookie?.value;
          const accessExpired = accessCookie?.value?.endsWith("-expired");

          if (!accessExpired) {
            return { data: { user: { id: "user-1", email: "uat@example.com", user_metadata: {} } }, error: null };
          }
          if (consumedRefreshTokens.has(currentRefresh)) {
            return { data: { user: null }, error: { status: 401, message: "Invalid Refresh Token: Already Used" } };
          }
          consumedRefreshTokens.add(currentRefresh);
          const nextRefresh = `${currentRefresh}-next`;
          try {
            cookies.set("sb-refresh-token", nextRefresh);
            cookies.set("sb-access-token", `access-for-${nextRefresh}`);
          } catch {
            // Real createSupabaseServerClient's setAll swallows this
            // ("Server Components can read cookies, but may not be allowed
            // to write them"). The in-flight call still succeeds — that's
            // the hazard: the caller walks away believing it's fine while
            // the persisted refresh token is now stale.
          }
          return { data: { user: { id: "user-1", email: "uat@example.com", user_metadata: {} } }, error: null };
        },
        getSession: async () => ({ data: { session: null } }),
      },
    };
  };
}
