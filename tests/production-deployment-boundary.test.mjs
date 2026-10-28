// Perilla 10 — Production Secrets / Env / CORS / Deployment Boundary
// Hardening. See docs/security/production-deployment-boundary.md.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  ALLOWED_PUBLIC_ENV_VARS,
  SERVER_ONLY_ENV_VARS,
  REQUIRED_PRODUCTION_ENV_VARS,
  ENV_VAR_INVENTORY,
  DEBUG_HEALTH_BUILD_ROUTES,
  CORS_SURFACES,
  KNOWN_PRODUCTION_RESIDUALS,
} from "../src/lib/security/deployment-boundary-registry.ts";
import {
  getRuntimeEnvironment,
  isSecretLikePublicEnvName,
  assertServerOnlyEnvBoundary,
  evaluateProductionEnvSafety,
} from "../src/lib/security/environment.ts";
import {
  getAllowedOrigins,
  isAllowedOrigin,
  buildCorsHeaders,
  resolveSafeRedirectUrl,
  resolveTrustedOrigin,
  getAppBaseUrl,
} from "../src/lib/security/origin-policy.ts";
import { getSecurityHeaders } from "../src/lib/security/security-headers.ts";
import { redactSecretLikeValues, safeErrorMessage } from "../src/lib/security/redaction.ts";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
      walk(p, out);
    } else {
      out.push(p.replaceAll("\\", "/"));
    }
  }
  return out;
}

const SRC_FILES = walk("src").filter((f) => /\.(ts|tsx)$/.test(f));
const SRC_TEXT = new Map(SRC_FILES.map((f) => [f, readFileSync(f, "utf8")]));

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── 1-4: registry existence / shape ─────────────────────────────────────────

test("1. deployment boundary registry file exists and exports non-empty allowlists", () => {
  assert.ok(existsSync("src/lib/security/deployment-boundary-registry.ts"));
  assert.ok(ALLOWED_PUBLIC_ENV_VARS.length > 0);
  assert.ok(SERVER_ONLY_ENV_VARS.length > 0);
  assert.ok(REQUIRED_PRODUCTION_ENV_VARS.length > 0);
  assert.ok(ENV_VAR_INVENTORY.length >= ALLOWED_PUBLIC_ENV_VARS.length);
});

test("2. allowed public env allowlist contains only genuinely public envs", () => {
  for (const name of ALLOWED_PUBLIC_ENV_VARS) {
    assert.ok(name.startsWith("NEXT_PUBLIC_"), `${name} should start with NEXT_PUBLIC_`);
    assert.equal(isSecretLikePublicEnvName(name), false, `${name} looks secret-shaped and should not be public`);
  }
});

test("3. server-only env list includes the required critical secrets", () => {
  for (const required of ["SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "FOUNDER_OPERATOR_USER_IDS"]) {
    assert.ok(SERVER_ONLY_ENV_VARS.includes(required), `${required} must be listed as server-only`);
  }
});

test("4. required production envs are documented and covered by the doc", () => {
  const doc = readFileSync("docs/security/production-deployment-boundary.md", "utf8");
  for (const name of REQUIRED_PRODUCTION_ENV_VARS) {
    assert.ok(doc.includes(name), `doc should mention required production env ${name}`);
  }
});

// ── 5-7: NEXT_PUBLIC boundary ────────────────────────────────────────────────

test("5. no secret-looking NEXT_PUBLIC_ names appear anywhere in src/**", () => {
  const forbiddenFragments = ["SECRET", "SERVICE_ROLE", "PRIVATE", "WEBHOOK", "TOKEN", "PASSWORD", "HMAC"];
  const offenders = [];
  for (const [file, text] of SRC_TEXT) {
    const matches = text.match(/NEXT_PUBLIC_[A-Z0-9_]+/g) ?? [];
    for (const name of matches) {
      const upper = name.toUpperCase();
      if (forbiddenFragments.some((fragment) => upper.includes(fragment))) {
        offenders.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("6. every NEXT_PUBLIC_ reference in src/** is allowlisted", () => {
  const referenced = new Set();
  for (const text of SRC_TEXT.values()) {
    for (const match of text.match(/NEXT_PUBLIC_[A-Z0-9_]+/g) ?? []) referenced.add(match);
  }
  const unlisted = [...referenced].filter((name) => !ALLOWED_PUBLIC_ENV_VARS.includes(name));
  assert.deepEqual(unlisted, [], `unlisted NEXT_PUBLIC_ vars found: ${unlisted.join(", ")}`);
});

test("7. server-only env vars never appear in a \"use client\" file", () => {
  const offenders = [];
  for (const [file, text] of SRC_TEXT) {
    if (!/^\s*["']use client["']/.test(text)) continue;
    for (const secret of SERVER_ONLY_ENV_VARS) {
      if (text.includes(secret)) offenders.push(`${file}: ${secret}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("assertServerOnlyEnvBoundary passes for the current process env", () => {
  assert.doesNotThrow(() => assertServerOnlyEnvBoundary());
});

// ── 8-11: Supabase/Stripe boundary ──────────────────────────────────────────

test("8. service-role helper fails closed when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
  const src = readFileSync("src/lib/supabase/env.ts", "utf8");
  assert.match(src, /throw new Error\("Missing Supabase service role environment variables\."\)/);
});

test("9. Stripe webhook route requires STRIPE_WEBHOOK_SECRET and fails closed", () => {
  const src = readFileSync("src/lib/stripe-webhook-verification.ts", "utf8");
  assert.match(src, /missing_secret/);
  const routeSrc = readFileSync("src/app/api/billing/webhook/route.ts", "utf8");
  assert.match(routeSrc, /Invalid Stripe webhook request/);
});

test("10. STRIPE_SECRET_KEY never appears in a \"use client\" file", () => {
  for (const [file, text] of SRC_TEXT) {
    if (/^\s*["']use client["']/.test(text)) {
      assert.ok(!text.includes("STRIPE_SECRET_KEY"), `${file} must not reference STRIPE_SECRET_KEY`);
    }
  }
});

test("11. Stripe price ids are documented in the deployment boundary registry", () => {
  const keys = ENV_VAR_INVENTORY.map((e) => e.name);
  assert.ok(keys.includes("STRIPE_PRO_PRICE_ID"));
  assert.ok(keys.includes("STRIPE_PMO_PRICE_ID"));
});

// ── 12-15: CORS/origin ───────────────────────────────────────────────────────

test("12. no wildcard CORS with credentials anywhere in src/**", () => {
  const offenders = [];
  for (const [file, text] of SRC_TEXT) {
    const hasWildcardOrigin = /Access-Control-Allow-Origin["'`]?\s*[,:]\s*["'`]\*["'`]/.test(text);
    const hasCredentialsTrue = /Access-Control-Allow-Credentials["'`]?\s*[,:]\s*["'`]true["'`]/.test(text);
    if (hasWildcardOrigin && hasCredentialsTrue) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("13. no origin reflection without the allowlist helper", () => {
  const offenders = [];
  for (const [file, text] of SRC_TEXT) {
    if (file === "src/lib/security/origin-policy.ts") continue;
    if (/Access-Control-Allow-Origin["'`]\s*,\s*(origin|req\.headers\.get\("origin"\)|request\.headers\.get\("origin"\))/.test(text)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test("14. isAllowedOrigin rejects localhost in production", () => {
  withEnv({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://pmfreak.example.com" }, () => {
    assert.equal(getRuntimeEnvironment(), "production");
    assert.equal(isAllowedOrigin("http://localhost:3000"), false);
    assert.equal(isAllowedOrigin("http://127.0.0.1:3000"), false);
    assert.ok(!getAllowedOrigins().some((o) => o.includes("localhost")));
  });
});

test("isAllowedOrigin allows localhost outside production", () => {
  withEnv({ VERCEL_ENV: undefined, NODE_ENV: "development" }, () => {
    assert.equal(isAllowedOrigin("http://localhost:3000"), true);
  });
});

test("15. buildCorsHeaders never emits credentials with a wildcard origin, and never reflects an unlisted origin", () => {
  withEnv({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://pmfreak.example.com" }, () => {
    const allowed = buildCorsHeaders({ origin: "https://pmfreak.example.com", allowCredentials: true });
    assert.equal(allowed["Access-Control-Allow-Origin"], "https://pmfreak.example.com");
    assert.equal(allowed["Access-Control-Allow-Credentials"], "true");
    assert.notEqual(allowed["Access-Control-Allow-Origin"], "*");

    const denied = buildCorsHeaders({ origin: "https://evil.com", allowCredentials: true });
    assert.equal(denied["Access-Control-Allow-Origin"], undefined);
    assert.equal(denied["Access-Control-Allow-Credentials"], undefined);
  });
});

// ── 16-19: redirect safety ───────────────────────────────────────────────────

test("16. resolveSafeRedirectUrl blocks external/malicious redirect targets", () => {
  withEnv({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://pmfreak.example.com" }, () => {
    for (const malicious of ["https://evil.com", "//evil.com", "javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
      assert.equal(resolveSafeRedirectUrl({ requestedUrl: malicious, fallbackPath: "/safe" }), "/safe", `should block ${malicious}`);
    }
  });
});

test("17. resolveSafeRedirectUrl allows relative paths", () => {
  assert.equal(resolveSafeRedirectUrl({ requestedUrl: "/dashboard" }), "/dashboard");
  assert.equal(resolveSafeRedirectUrl({ requestedUrl: null, fallbackPath: "/home" }), "/home");
});

test("18. resolveSafeRedirectUrl allows allowlisted absolute origins", () => {
  withEnv({ NEXT_PUBLIC_APP_URL: "https://pmfreak.example.com" }, () => {
    assert.equal(resolveSafeRedirectUrl({ requestedUrl: "https://pmfreak.example.com/billing" }), "https://pmfreak.example.com/billing");
  });
});

test("19. no raw redirect(searchParams.get(...)) patterns anywhere in src/**", () => {
  const offenders = [];
  const rawPattern = /redirect\(\s*(new URL\()?\s*(request\.nextUrl\.)?searchParams\.get\(/;
  for (const [file, text] of SRC_TEXT) {
    if (rawPattern.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("resolveTrustedOrigin falls back to the app base URL for an unlisted origin", () => {
  withEnv({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://pmfreak.example.com" }, () => {
    assert.equal(resolveTrustedOrigin("https://evil.com"), "https://pmfreak.example.com");
    assert.equal(resolveTrustedOrigin("https://pmfreak.example.com"), "https://pmfreak.example.com");
  });
});

test("getAppBaseUrl fails closed in production without a valid NEXT_PUBLIC_APP_URL", () => {
  withEnv({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: undefined, NEXT_PUBLIC_SITE_URL: undefined, APP_URL: undefined }, () => {
    assert.throws(() => getAppBaseUrl());
  });
});

// ── 20-23: debug/health/build routes ─────────────────────────────────────────

test("20. debug/health/build routes are classified in the registry", () => {
  const paths = DEBUG_HEALTH_BUILD_ROUTES.map((r) => r.path);
  for (const expected of [
    "src/app/api/health/route.ts",
    "src/app/api/build-info/route.ts",
    "src/app/api/route-debug/route.ts",
    "src/app/api/runtime/hardening/route.ts",
    "src/app/api/debug-auth/route.ts",
  ]) {
    assert.ok(paths.includes(expected), `${expected} should be classified`);
  }
  for (const entry of DEBUG_HEALTH_BUILD_ROUTES) {
    assert.ok(existsSync(entry.path), `${entry.path} should exist`);
  }
});

test("21. runtime/hardening route remains founder/internal gated", () => {
  const src = readFileSync("src/app/api/runtime/hardening/route.ts", "utf8");
  assert.match(src, /requireAuthUser/);
  assert.match(src, /isFounderOrInternalUser/);
});

test("22. health/build-info/route-debug do not dump env, headers, or cookies", () => {
  const allowlistedEnvReads = new Set(["process.env.VERCEL_GIT_COMMIT_SHA", "process.env.VERCEL_GIT_COMMIT_REF", "process.env.VERCEL_ENV", "process.env.NEXT_PUBLIC_BUILD_TIMESTAMP", "process.env.npm_package_version"]);
  for (const routeFile of ["src/app/api/health/route.ts", "src/app/api/build-info/route.ts", "src/app/api/route-debug/route.ts"]) {
    const text = readFileSync(routeFile, "utf8");
    assert.ok(!/\bheaders\(\)/.test(text), `${routeFile} must not dump headers()`);
    assert.ok(!/\bcookies\(\)/.test(text), `${routeFile} must not dump cookies()`);
    const envReads = text.match(/process\.env\.[A-Za-z0-9_]+/g) ?? [];
    for (const read of envReads) {
      assert.ok(allowlistedEnvReads.has(read), `${routeFile} reads unlisted env var ${read}`);
    }
  }
});

test("23. debug-auth route is disabled in production", () => {
  const text = readFileSync("src/app/api/debug-auth/route.ts", "utf8");
  assert.match(text, /isProductionRuntime/);
  assert.match(text, /404/);
});

// ── 24-26: security headers ─────────────────────────────────────────────────

test("24. security headers helper returns the minimum required header set", () => {
  const headers = getSecurityHeaders({ environment: "development" });
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.ok(headers["X-Frame-Options"] === "DENY" || headers["X-Frame-Options"] === "SAMEORIGIN" || headers["Content-Security-Policy"]?.includes("frame-ancestors"));
  assert.ok(headers["Referrer-Policy"]);
  assert.ok(headers["Permissions-Policy"]);
});

test("25. HSTS is present in production/preview and absent in development", () => {
  assert.ok(getSecurityHeaders({ environment: "production" })["Strict-Transport-Security"]);
  assert.ok(getSecurityHeaders({ environment: "preview" })["Strict-Transport-Security"]);
  assert.equal(getSecurityHeaders({ environment: "development" })["Strict-Transport-Security"], undefined);
});

test("26. CSP is implemented (with a documented residual)", () => {
  const headers = getSecurityHeaders({ environment: "production" });
  assert.ok(headers["Content-Security-Policy"]?.includes("default-src 'self'"));
  const doc = readFileSync("docs/security/production-deployment-boundary.md", "utf8");
  assert.match(doc, /unsafe-inline/);
});

test("26a. CSP allows eval only in local development", () => {
  const developmentCsp = getSecurityHeaders({ environment: "development" })["Content-Security-Policy"];
  const testCsp = getSecurityHeaders({ environment: "test" })["Content-Security-Policy"];
  const previewCsp = getSecurityHeaders({ environment: "preview" })["Content-Security-Policy"];
  const productionCsp = getSecurityHeaders({ environment: "production" })["Content-Security-Policy"];

  assert.ok(developmentCsp?.includes("'unsafe-eval'"));
  assert.ok(!testCsp?.includes("'unsafe-eval'"));
  assert.ok(!previewCsp?.includes("'unsafe-eval'"));
  assert.ok(!productionCsp?.includes("'unsafe-eval'"));
});
test("next.config.ts applies security headers via headers()", () => {
  const src = readFileSync("next.config.ts", "utf8");
  assert.match(src, /getSecurityHeaders/);
  assert.match(src, /async headers\(\)/);
});

// ── 27-29: logs/errors ───────────────────────────────────────────────────────

test("27. no obvious raw secret logging in src/**", () => {
  const offenders = [];
  const secretEnvPattern = /console\.(log|error|warn|info)\([^)]*process\.env\.(SUPABASE_SERVICE_ROLE_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)/;
  for (const [file, text] of SRC_TEXT) {
    if (secretEnvPattern.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test("28. redactSecretLikeValues redacts secret-shaped values and sensitive keys", () => {
  const input = {
    stripeKey: "sk_live_abcdefghij1234567890",
    webhookSecret: "whsec_abcdefghij1234567890",
    authorization: "Bearer abcdefghij1234567890",
    nested: { serviceRoleKey: "service_role_abcdefghijklmno", safe: "keep-me" },
    message: "token leaked: Bearer abcdefghij1234567890 in logs",
  };
  const redacted = redactSecretLikeValues(input);
  assert.equal(redacted.stripeKey, "[redacted]");
  assert.equal(redacted.webhookSecret, "[redacted]");
  assert.equal(redacted.authorization, "[redacted]");
  assert.equal(redacted.nested.serviceRoleKey, "[redacted]");
  assert.equal(redacted.nested.safe, "keep-me");
  assert.match(redacted.message, /\[redacted\]/);
});

test("safeErrorMessage never exposes a stack trace", () => {
  const error = new Error("sk_test_abcdefghij1234567890 failed to charge card");
  assert.ok(!safeErrorMessage(error).includes("\n    at "));
  assert.match(safeErrorMessage(error), /\[redacted\]/);
});

test("29. production error responses do not expose stack traces (source scan)", () => {
  const offenders = [];
  for (const [file, text] of SRC_TEXT) {
    if (/route\.ts$/.test(file) && /NextResponse\.json\([^)]*error\.stack/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

// ── 30-31: source maps / build ──────────────────────────────────────────────

test("30. productionBrowserSourceMaps is not enabled", () => {
  const src = readFileSync("next.config.ts", "utf8");
  assert.match(src, /productionBrowserSourceMaps:\s*false/);
});

test("31. next.config does not enable an unsafe devtool override", () => {
  const src = readFileSync("next.config.ts", "utf8");
  assert.ok(!/devtool\s*:\s*["'`](?!false)/.test(src));
});

// ── 32-34: documentation ─────────────────────────────────────────────────────

test("32. production deployment boundary doc exists", () => {
  assert.ok(existsSync("docs/security/production-deployment-boundary.md"));
});

test("33. doc lists public vs server-only envs", () => {
  const doc = readFileSync("docs/security/production-deployment-boundary.md", "utf8").toLowerCase();
  for (const phrase of ["next_public", "server-only", "service-role", "stripe_secret_key", "stripe_webhook_secret"]) {
    assert.ok(doc.includes(phrase), `doc should mention "${phrase}"`);
  }
});

test("34. doc states production config is part of the security boundary", () => {
  const doc = readFileSync("docs/security/production-deployment-boundary.md", "utf8");
  assert.match(doc, /deployment configuration \*is\* part of the security\s*\nboundary|deployment configuration is part of the security boundary/i);
});

// ── extras ───────────────────────────────────────────────────────────────────

test("env registry has no duplicate names within a single list", () => {
  for (const list of [ALLOWED_PUBLIC_ENV_VARS, SERVER_ONLY_ENV_VARS, REQUIRED_PRODUCTION_ENV_VARS]) {
    assert.equal(new Set(list).size, list.length);
  }
});

test(".env.example contains only placeholder-shaped values, no live secrets", () => {
  const text = readFileSync(".env.example", "utf8");
  assert.ok(!/sk_live_[a-zA-Z0-9]{10,}/.test(text));
  assert.ok(!/whsec_[a-zA-Z0-9]{10,}/.test(text));
  assert.ok(!/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/.test(text));
});

test("CORS surfaces registry documents every entry as non-mutating or explicitly secret-free", () => {
  assert.ok(CORS_SURFACES.length > 0);
  for (const surface of CORS_SURFACES) {
    assert.ok(existsSync(surface.path.replace(/\[connectorId\]/, "[connectorId]")), `${surface.path} should exist`);
  }
});

test("known production residuals are documented", () => {
  assert.ok(KNOWN_PRODUCTION_RESIDUALS.length > 0);
  const doc = readFileSync("docs/security/production-deployment-boundary.md", "utf8");
  assert.match(doc, /Known residual risks/);
});

test("evaluateProductionEnvSafety flags missing secrets in production without throwing", () => {
  withEnv({
    VERCEL_ENV: "production",
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
    NEXT_PUBLIC_SUPABASE_URL: undefined,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
    NEXT_PUBLIC_APP_URL: undefined,
    NEXT_PUBLIC_SITE_URL: undefined,
  }, () => {
    const violations = evaluateProductionEnvSafety();
    assert.ok(violations.length > 0);
    assert.ok(violations.some((v) => v.code === "missing_required_secret"));
  });
});

test("evaluateProductionEnvSafety is quiet outside production", () => {
  withEnv({ VERCEL_ENV: undefined, NODE_ENV: "development" }, () => {
    assert.deepEqual(evaluateProductionEnvSafety(), []);
  });
});
