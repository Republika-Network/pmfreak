/**
 * Shared environment for tests/db-regression/: a DISPOSABLE, LOOPBACK-ONLY Supabase stack.
 *
 * Fails (never skips) when configuration is missing and refuses any non-loopback URL —
 * these tests create and delete users and rows. In CI the values come from the
 * OPERATIONAL_FLOW_TEST_* variables release-governance.yml already exports.
 */
import { createClient } from "@supabase/supabase-js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const SOURCES = {
  url: ["DB_REGRESSION_SUPABASE_URL", "OPERATIONAL_FLOW_TEST_SUPABASE_URL"],
  anonKey: ["DB_REGRESSION_ANON_KEY", "OPERATIONAL_FLOW_TEST_ANON_KEY"],
  serviceRoleKey: ["DB_REGRESSION_SERVICE_ROLE_KEY", "OPERATIONAL_FLOW_TEST_SERVICE_ROLE_KEY"],
};

export function requireDbEnv() {
  const env = {};
  const missing = [];
  for (const [key, names] of Object.entries(SOURCES)) {
    const name = names.find((candidate) => process.env[candidate]);
    if (name) env[key] = process.env[name];
    else missing.push(names.join(" or "));
  }
  if (missing.length) {
    throw new Error(`[db-regression] Missing required configuration: ${missing.join("; ")}. Refusing to skip.`);
  }
  let hostname;
  try {
    hostname = new URL(env.url).hostname;
  } catch {
    throw new Error("[db-regression] Supabase URL is not a valid URL. Refusing to run.");
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`[db-regression] Refusing non-loopback Supabase host '${hostname}'. Disposable local stacks only.`);
  }
  return env;
}

const clientOptions = { auth: { autoRefreshToken: false, persistSession: false } };

export const adminClient = (env) => createClient(env.url, env.serviceRoleKey, clientOptions);

export async function signedInClient(env, email, password) {
  const client = createClient(env.url, env.anonKey, clientOptions);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`[db-regression] fixture sign-in failed: ${error?.message ?? "no session"}`);
  return client;
}
