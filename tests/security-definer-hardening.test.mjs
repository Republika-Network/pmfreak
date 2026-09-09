// ============================================================================
// Regression coverage for the SECURITY DEFINER effective-grant model
// (scripts/check-security-definer-hardening.mjs) and the declarative matrix
// (supabase/security/security-definer-grant-matrix.json).
//
// WHAT THESE TESTS REPLACED
// -------------------------
// The previous version of this file asserted that every SECURITY DEFINER
// function "has an explicit PUBLIC execute revocation" and that the checker
// exits 0. Both assertions passed while 26 SECURITY DEFINER functions were
// executable by `anon` on the hosted project, because on Supabase PUBLIC and
// anon are DISTINCT principals and `revoke ... from public` does not revoke
// anon. Those assertions are deliberately gone: re-adding them would restore
// a green signal for a property that does not imply security.
//
// What is asserted now is the EFFECTIVE final privilege state reconstructed by
// replaying the migration chain in canonical order, diffed against the
// declared matrix, plus the specific modelling semantics that the previous
// checker got wrong (CREATE OR REPLACE vs DROP+CREATE, overloads, late
// grants, PUBLIC-vs-anon, and failing closed on unparseable input).
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  PRINCIPALS,
  PLATFORM_DEFAULT_FUNCTION_ACL,
  replayMigrations,
  finalSecurityDefiner,
  diffAgainstMatrix,
  loadMigrations,
  loadMatrix,
  parseIdentityArguments,
  normalizeSearchPath,
  routineOptionsText,
} from "../scripts/check-security-definer-hardening.mjs";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/check-security-definer-hardening.mjs");
const MATRIX_PATH = path.join(ROOT, "supabase/security/security-definer-grant-matrix.json");
const REMEDIATION = "supabase/migrations/20260910000000_security_definer_effective_grant_hardening.sql";

const EXPECTED_TOTAL = 30;
const EXPECTED_AUTHENTICATED = 23;

// The four functions whose only legitimate invocation path is another
// SECURITY DEFINER function or a privileged/scheduled context. No client role
// may execute them.
const INTERNAL_OR_SERVICE_ONLY = [
  "public.operational_workspace_role(uuid)",
  "public.operational_authority_evaluation(uuid,text,text)",
  "public.p2_08_validate_execution_governance(uuid,uuid)",
  "public.purge_expired_nonces()",
];

const TRIGGER_ONLY = "public.prepare_decision_evidence_link()";

// The seven RLS-policy helpers. Their `authenticated` EXECUTE is load-bearing:
// an RLS policy expression is evaluated with the CALLER's privileges, so
// revoking these breaks tenant isolation rather than tightening it.
const RLS_HELPERS = [
  "public.can_access_operational_project(uuid,uuid)",
  "public.can_write_operational_project(uuid,uuid)",
  "public.is_bridge_owner(uuid,uuid)",
  "public.is_organizational_pattern_governor(uuid)",
  "public.is_workspace_admin(uuid)",
  "public.is_organizational_memory_governor(uuid)",
  "public.is_decision_effectiveness_governor(uuid)",
];

let cachedState = null;
function realState() {
  if (!cachedState) {
    const { functions, unresolved } = replayMigrations(loadMigrations());
    cachedState = { functions, unresolved };
  }
  return cachedState;
}
const bySignature = () => new Map(finalSecurityDefiner(realState().functions).map((f) => [f.signature, f]));

// --- synthetic replay helper -------------------------------------------------
const sql = (...lines) => lines.join("\n");
function replay(files) {
  return replayMigrations(files.map(([file, body]) => ({ file, sql: body })));
}
const DEF = (name, args, extra = "security definer set search_path = ''") =>
  `create or replace function public.${name}(${args}) returns boolean language sql ${extra} as $$ select true $$;`;

// ============================================================================
// Wiring
// ============================================================================

test("npm script and checker script exist and the gate wires it as blocking", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:security-definer-hardening"], "node scripts/check-security-definer-hardening.mjs");
  assert.equal(existsSync(SCRIPT), true);
  const gate = readFileSync(path.join(ROOT, "scripts/check-beta-release.mjs"), "utf8");
  assert.match(gate, /check:security-definer-hardening/);
});

test("the forward-only remediation migration exists and edits no historical migration", () => {
  assert.equal(existsSync(path.join(ROOT, REMEDIATION)), true);
  const body = readFileSync(path.join(ROOT, REMEDIATION), "utf8");
  // It must only adjust privileges — never redefine or drop anything.
  assert.equal(/\bcreate\s+(or\s+replace\s+)?function\b/i.test(body), false, "remediation must not redefine functions");
  assert.equal(/\bdrop\s+function\b/i.test(body), false, "remediation must not drop functions");
  assert.equal(/\balter\s+table\b/i.test(body), false, "remediation must not alter tables");
});

test("the checker passes (exit 0) against the current migration set", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 0, `expected PASS, got:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS: reconstructed effective EXECUTE privileges/);
});

test("replaying the real migration chain resolves every construct (fail-closed model reports nothing unresolved)", () => {
  assert.deepEqual(realState().unresolved, []);
});

// ============================================================================
// Effective final state — the numbers the hosted certification checks
// ============================================================================

test(`there are exactly ${EXPECTED_TOTAL} final SECURITY DEFINER functions`, () => {
  assert.equal(finalSecurityDefiner(realState().functions).length, EXPECTED_TOTAL);
});

test("PUBLIC EXECUTE on SECURITY DEFINER functions is 0", () => {
  const granted = finalSecurityDefiner(realState().functions).filter((f) => f.acl.public);
  assert.deepEqual(granted.map((f) => f.signature), []);
});

test("anon EXECUTE on SECURITY DEFINER functions is 0", () => {
  const granted = finalSecurityDefiner(realState().functions).filter((f) => f.acl.anon);
  assert.deepEqual(granted.map((f) => f.signature), []);
});

test(`authenticated EXECUTE on SECURITY DEFINER functions is exactly ${EXPECTED_AUTHENTICATED}`, () => {
  const granted = finalSecurityDefiner(realState().functions).filter((f) => f.acl.authenticated);
  assert.equal(granted.length, EXPECTED_AUTHENTICATED);
});

test("authenticated is DENIED on the four internal / service-role-only functions", () => {
  const map = bySignature();
  for (const sig of INTERNAL_OR_SERVICE_ONLY) {
    const fn = map.get(sig);
    assert.ok(fn, `${sig} missing from final SECURITY DEFINER state`);
    assert.equal(fn.acl.authenticated, false, `${sig} must not be executable by authenticated`);
    assert.equal(fn.acl.anon, false, `${sig} must not be executable by anon`);
    assert.equal(fn.acl.service_role, true, `${sig} must retain service_role EXECUTE`);
  }
});

test("authenticated is ALLOWED on every declared authenticated RPC and RLS helper", () => {
  const map = bySignature();
  const matrix = loadMatrix(MATRIX_PATH);
  const declaredAuth = matrix.functions.filter((f) => f.authenticated);
  assert.equal(declaredAuth.length, EXPECTED_AUTHENTICATED);
  for (const spec of declaredAuth) {
    const fn = map.get(spec.signature);
    assert.ok(fn, `${spec.signature} missing from final state`);
    assert.equal(fn.acl.authenticated, true, `${spec.signature} must remain executable by authenticated`);
  }
});

test("the seven RLS-policy helpers keep their load-bearing authenticated EXECUTE", () => {
  const map = bySignature();
  const matrix = loadMatrix(MATRIX_PATH);
  for (const sig of RLS_HELPERS) {
    const fn = map.get(sig);
    assert.ok(fn, `${sig} missing from final state`);
    assert.equal(fn.acl.authenticated, true, `${sig}: revoking authenticated would break RLS policy evaluation`);
    const spec = matrix.functions.find((f) => f.signature === sig);
    assert.equal(spec.intended_caller, "authenticated_rls_helper");
  }
  assert.equal(matrix.functions.filter((f) => f.intended_caller === "authenticated_rls_helper").length, RLS_HELPERS.length);
});

test("service_role EXECUTE matches the matrix declaration for every function", () => {
  const map = bySignature();
  const matrix = loadMatrix(MATRIX_PATH);
  for (const spec of matrix.functions) {
    const fn = map.get(spec.signature);
    assert.ok(fn, `${spec.signature} missing from final state`);
    assert.equal(fn.acl.service_role, spec.service_role, `${spec.signature}: service_role mismatch`);
  }
  assert.equal(matrix.totals.service_role_executable, EXPECTED_TOTAL);
});

test("the trigger-only exception is explicitly represented, not inferred", () => {
  const matrix = loadMatrix(MATRIX_PATH);
  const triggers = matrix.functions.filter((f) => f.trigger_only);
  assert.deepEqual(triggers.map((f) => f.signature), [TRIGGER_ONLY]);
  const spec = triggers[0];
  assert.equal(spec.intended_caller, "trigger_only");
  assert.ok(/trigger/i.test(spec.rationale), "the trigger-only exception must carry a written rationale");
  // and it is denied to every client principal in the reconstructed state
  const fn = bySignature().get(TRIGGER_ONLY);
  assert.equal(fn.isTrigger, true);
  assert.equal(fn.acl.public, false);
  assert.equal(fn.acl.anon, false);
  assert.equal(fn.acl.authenticated, false);
});

test("every SECURITY DEFINER function pins search_path", () => {
  for (const fn of finalSecurityDefiner(realState().functions)) {
    assert.ok(fn.searchPath !== null && fn.searchPath !== undefined, `${fn.signature} has no pinned search_path`);
  }
});

test("the reconstructed state diffs clean against the declarative matrix", () => {
  const { problems, totals } = diffAgainstMatrix(realState().functions, loadMatrix(MATRIX_PATH));
  assert.deepEqual(problems, []);
  assert.equal(totals.security_definer_total, EXPECTED_TOTAL);
  assert.equal(totals.public_executable, 0);
  assert.equal(totals.anon_executable, 0);
  assert.equal(totals.authenticated_executable, EXPECTED_AUTHENTICATED);
  assert.equal(totals.service_role_executable, EXPECTED_TOTAL);
  assert.equal(totals.unpinned_search_path, 0);
});

test("matrix totals agree with the matrix contents", () => {
  const m = loadMatrix(MATRIX_PATH);
  assert.equal(m.functions.length, m.totals.security_definer_total);
  assert.equal(m.functions.filter((f) => f.public).length, m.totals.public_executable);
  assert.equal(m.functions.filter((f) => f.anon).length, m.totals.anon_executable);
  assert.equal(m.functions.filter((f) => f.authenticated).length, m.totals.authenticated_executable);
  assert.equal(m.functions.filter((f) => f.service_role).length, m.totals.service_role_executable);
  assert.equal(m.totals.anon_executable, 0, "no SECURITY DEFINER function may be intentionally anon-executable");
  for (const f of m.functions) {
    assert.ok(f.rationale && f.rationale.length > 20, `${f.signature} needs a rationale`);
    assert.ok(f.identity_arguments !== undefined, `${f.signature} needs identity_arguments`);
    assert.equal(f.signature, `${f.schema}.${f.name}(${f.identity_arguments})`);
  }
});

// ============================================================================
// Modelling semantics the previous checker got wrong
// ============================================================================

test("REVOKE FROM PUBLIC alone does NOT satisfy anon-denied", () => {
  const { functions } = replay([
    ["001_a.sql", sql(DEF("f", "uuid"), "revoke all on function public.f(uuid) from public;")],
  ]);
  const fn = functions.get("public.f(uuid)");
  assert.equal(fn.acl.public, false, "PUBLIC should be revoked");
  assert.equal(fn.acl.anon, true, "anon must still hold the platform-default grant");
  assert.equal(fn.acl.authenticated, true, "authenticated must still hold the platform-default grant");
});

test("a PUBLIC-only revoke is reported as an anon violation against the matrix", () => {
  const { functions } = replay([
    ["001_a.sql", sql(DEF("f", "uuid"), "revoke all on function public.f(uuid) from public;")],
  ]);
  const matrix = { functions: [{ schema: "public", name: "f", identity_arguments: "uuid", signature: "public.f(uuid)", public: false, anon: false, authenticated: false, service_role: true, trigger_only: false }] };
  const { problems } = diffAgainstMatrix(functions, matrix);
  assert.ok(problems.some((p) => /anon EXECUTE is GRANTED/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /does NOT revoke anon/.test(p)), "the failure must explain the PUBLIC-vs-anon distinction");
});

test("an explicit REVOKE FROM anon does deny anon", () => {
  const { functions } = replay([
    ["001_a.sql", sql(DEF("f", "uuid"), "revoke execute on function public.f(uuid) from public, anon, authenticated;", "grant execute on function public.f(uuid) to service_role;")],
  ]);
  const acl = functions.get("public.f(uuid)").acl;
  assert.deepEqual(acl, { public: false, anon: false, authenticated: false, service_role: true });
});

test("CREATE OR REPLACE preserves the ACL", () => {
  const { functions } = replay([
    ["001_a.sql", sql(DEF("f", "uuid"), "revoke execute on function public.f(uuid) from public, anon, authenticated;")],
    ["002_b.sql", DEF("f", "uuid")], // redefinition only
  ]);
  const fn = functions.get("public.f(uuid)");
  assert.equal(fn.definitions.length, 2);
  assert.equal(fn.acl.anon, false, "CREATE OR REPLACE must not restore the platform-default anon grant");
  assert.equal(fn.acl.authenticated, false);
});

test("DROP + CREATE resets the ACL to the platform defaults", () => {
  const { functions } = replay([
    ["001_a.sql", sql(DEF("f", "uuid"), "revoke execute on function public.f(uuid) from public, anon, authenticated;")],
    ["002_b.sql", sql("drop function if exists public.f(uuid);", DEF("f", "uuid"))],
  ]);
  const fn = functions.get("public.f(uuid)");
  assert.equal(fn.dropped, false, "the function exists again after the recreate");
  assert.deepEqual(fn.acl, { ...PLATFORM_DEFAULT_FUNCTION_ACL }, "a drop destroys the ACL, so the recreate re-seeds platform defaults");
  assert.equal(fn.acl.anon, true, "the earlier revoke must NOT survive a DROP");
});

test("a DROP with no matching recreate leaves no final function", () => {
  const { functions } = replay([
    ["001_a.sql", DEF("f", "uuid")],
    ["002_b.sql", "drop function if exists public.f(uuid);"],
  ]);
  assert.equal(finalSecurityDefiner(functions).length, 0);
});

test("overloads are tracked independently and never collapsed by name", () => {
  const { functions } = replay([
    ["001_a.sql", sql(
      DEF("f", "uuid"),
      DEF("f", "uuid, text"),
      "revoke execute on function public.f(uuid) from public, anon, authenticated;",
    )],
  ]);
  const one = functions.get("public.f(uuid)");
  const two = functions.get("public.f(uuid,text)");
  assert.ok(one && two, "both overloads must exist as distinct entries");
  assert.equal(one.acl.anon, false, "the revoked overload is denied");
  assert.equal(two.acl.anon, true, "the un-revoked overload must NOT inherit the sibling's revoke");
  assert.equal(finalSecurityDefiner(functions).length, 2);
});

test("a late GRANT TO anon causes failure even after a correct revoke", () => {
  const { functions } = replay([
    ["001_a.sql", sql(DEF("f", "uuid"), "revoke execute on function public.f(uuid) from public, anon, authenticated;")],
    ["002_b.sql", "grant execute on function public.f(uuid) to anon;"],
  ]);
  assert.equal(functions.get("public.f(uuid)").acl.anon, true, "ordering matters: the later grant wins");
  const matrix = { functions: [{ schema: "public", name: "f", identity_arguments: "uuid", signature: "public.f(uuid)", public: false, anon: false, authenticated: false, service_role: false, trigger_only: false }] };
  const { problems } = diffAgainstMatrix(functions, matrix);
  assert.ok(problems.some((p) => /anon EXECUTE is GRANTED/.test(p)), problems.join("\n"));
});

// ============================================================================
// Fail-closed behaviour
// ============================================================================

test("an unparseable SECURITY DEFINER definition fails closed", () => {
  const { unresolved } = replay([
    ["001_a.sql", "create or replace function public.f(p_x weird%rowtype) returns boolean language sql security definer set search_path = '' as $$ select true $$;"],
  ]);
  assert.ok(unresolved.length > 0, "unsupported identity-argument syntax must be reported, not skipped");
  assert.ok(unresolved.some((u) => /unsupported identity-argument syntax/.test(u)), unresolved.join("\n"));
});

test("an unterminated dollar-quoted body fails closed", () => {
  const { unresolved } = replay([["001_a.sql", "create function public.f() returns void language plpgsql as $tag$ begin end;"]]);
  assert.ok(unresolved.some((u) => /unterminated dollar-quoted body/.test(u)), unresolved.join("\n"));
});

test("ALTER FUNCTION, ALTER DEFAULT PRIVILEGES and schema-wide grants fail closed", () => {
  for (const [stmt, expected] of [
    ["alter function public.f(uuid) security invoker;", /ALTER FUNCTION/],
    ["alter default privileges in schema public grant execute on functions to anon;", /ALTER DEFAULT PRIVILEGES/],
    ["grant execute on all functions in schema public to anon;", /ON ALL FUNCTIONS IN SCHEMA/],
    ["alter routine public.f(uuid) security invoker;", /ALTER ROUTINE/],
  ]) {
    const { unresolved } = replay([["001_a.sql", stmt]]);
    assert.ok(unresolved.some((u) => expected.test(u)), `${stmt} should be unresolved; got ${unresolved.join("|")}`);
  }
});

test("an unrecognised grantee role fails closed", () => {
  const { unresolved } = replay([
    ["001_a.sql", sql(DEF("f", "uuid"), "grant execute on function public.f(uuid) to some_unknown_role;")],
  ]);
  assert.ok(unresolved.some((u) => /unrecognised grantee role/.test(u)), unresolved.join("\n"));
});

test("a SECURITY DEFINER function absent from the matrix fails", () => {
  const { functions } = replay([["001_a.sql", DEF("undeclared_fn", "uuid")]]);
  const { problems } = diffAgainstMatrix(functions, { functions: [] });
  assert.ok(problems.some((p) => /absent from security-definer-grant-matrix\.json/.test(p)), problems.join("\n"));
});

test("a matrix entry with no corresponding final function fails", () => {
  const { functions } = replay([["001_a.sql", "-- nothing here"]]);
  const matrix = { functions: [{ schema: "public", name: "ghost", identity_arguments: "uuid", signature: "public.ghost(uuid)", public: false, anon: false, authenticated: false, service_role: true, trigger_only: false }] };
  const { problems } = diffAgainstMatrix(functions, matrix);
  assert.ok(problems.some((p) => /is not a final SECURITY DEFINER function/.test(p)), problems.join("\n"));
});

test("a SECURITY DEFINER function without a pinned search_path fails", () => {
  const { functions } = replay([
    ["001_a.sql", "create function public.f(p_x uuid) returns boolean language sql security definer as $$ select true $$;"],
  ]);
  const matrix = { functions: [{ schema: "public", name: "f", identity_arguments: "uuid", signature: "public.f(uuid)", public: true, anon: true, authenticated: true, service_role: true, trigger_only: false }] };
  const { problems } = diffAgainstMatrix(functions, matrix);
  assert.ok(problems.some((p) => /without a pinned 'set search_path'/.test(p)), problems.join("\n"));
});

// ============================================================================
// Identity-argument normalisation
// ============================================================================

test("identity arguments drop parameter names, defaults, modifiers and OUT params", () => {
  const cases = [
    ["", ""],
    ["p_a uuid, p_b text", "uuid,text"],
    ["uuid, text", "uuid,text"],
    ["p_a numeric(10,2)", "numeric"],
    ["p_ids uuid[]", "uuid[]"],
    ["p_when timestamptz", "timestamptz"],
    ["p_when timestamp with time zone", "timestamptz"],
    ["p_n int", "integer"],
    ["p_flag boolean default false", "boolean"],
    ["in p_a uuid, out p_b text", "uuid"],
    ["variadic p_rest text[]", "VARIADIC text[]"],
  ];
  for (const [input, expected] of cases) {
    const { args, error } = parseIdentityArguments(input);
    assert.equal(error, null, `${input}: ${error}`);
    assert.equal(args, expected, `${input} -> ${args}, expected ${expected}`);
  }
});

test("every matrix signature round-trips through the identity-argument parser", () => {
  for (const f of loadMatrix(MATRIX_PATH).functions) {
    const { args, error } = parseIdentityArguments(f.identity_arguments);
    assert.equal(error, null, `${f.signature}: ${error}`);
    assert.equal(args, f.identity_arguments, `${f.signature} is not in canonical identity form`);
  }
});

test("PRINCIPALS models PUBLIC and anon as distinct entries", () => {
  assert.ok(PRINCIPALS.includes("public"));
  assert.ok(PRINCIPALS.includes("anon"));
  assert.notEqual(PRINCIPALS.indexOf("public"), PRINCIPALS.indexOf("anon"));
});

// ============================================================================
// Codex PR #602 review findings — regression coverage
// ============================================================================

// P1: PostgreSQL accepts routine options on EITHER side of the body. Reading
// only the text before it classified such a function as SECURITY INVOKER and
// dropped it from matrix enforcement — a false negative in the one direction
// that matters.
test("P1: SECURITY DEFINER declared AFTER the dollar-quoted body is recognised", () => {
  const { functions, unresolved } = replay([
    ["001_a.sql", [
      "create or replace function public.late_options(p_id uuid) returns boolean",
      "as $$ select true $$",
      "language sql",
      "security definer",
      "set search_path = '';",
    ].join("\n")],
  ]);
  assert.deepEqual(unresolved, []);
  const fn = functions.get("public.late_options(uuid)");
  assert.ok(fn, "function must be parsed");
  assert.equal(fn.securityDefiner, true, "SECURITY DEFINER after the body must be recognised");
  assert.equal(fn.searchPath, "''", "SET search_path after the body must be recognised");
  assert.equal(finalSecurityDefiner(functions).length, 1);
});

test("P1: a post-body SECURITY DEFINER function is included in matrix enforcement", () => {
  const { functions } = replay([
    ["001_a.sql", [
      "create or replace function public.late_options(p_id uuid) returns boolean",
      "as $$ select true $$",
      "language sql",
      "security definer",
      "set search_path = '';",
    ].join("\n")],
  ]);
  // Absent from the matrix -> must fail, rather than being silently skipped.
  const { problems } = diffAgainstMatrix(functions, { functions: [] });
  assert.ok(
    problems.some((p) => /late_options\(uuid\).*absent from security-definer-grant-matrix\.json/.test(p)),
    problems.join("\n"),
  );
  // And its anon grant is enforced like any other.
  const matrix = { functions: [{ schema: "public", name: "late_options", identity_arguments: "uuid", signature: "public.late_options(uuid)", public: false, anon: false, authenticated: false, service_role: true, trigger_only: false, search_path: "''" }] };
  const { problems: p2 } = diffAgainstMatrix(functions, matrix);
  assert.ok(p2.some((p) => /anon EXECUTE is GRANTED/.test(p)), p2.join("\n"));
});

test("P1: post-body trigger and RETURNS TRIGGER are still classified correctly", () => {
  const { functions, unresolved } = replay([
    ["001_a.sql", [
      "create or replace function public.late_trigger() returns trigger",
      "as $$ begin return new; end $$",
      "language plpgsql security definer set search_path = public;",
    ].join("\n")],
  ]);
  assert.deepEqual(unresolved, []);
  const fn = functions.get("public.late_trigger()");
  assert.equal(fn.securityDefiner, true);
  assert.equal(fn.isTrigger, true);
  assert.equal(fn.searchPath, "public");
});

test("P1: the body itself is excluded, so its text cannot flip classification", () => {
  const { functions } = replay([
    ["001_a.sql", [
      "create or replace function public.invoker_fn() returns text",
      "as $$ select 'security definer'::text $$",
      "language sql;",
    ].join("\n")],
  ]);
  assert.equal(functions.get("public.invoker_fn()").securityDefiner, false,
    "a string literal inside the body must not be read as a routine option");
});

test("P1: an unterminated body in CREATE FUNCTION fails closed", () => {
  const { error } = routineOptionsText("create function public.f() returns int as $tag$ begin", 0);
  assert.match(error ?? "", /unterminated dollar-quoted body/);
});

// P2: `REVOKE GRANT OPTION FOR EXECUTE ... FROM r` removes only r's ability to
// re-grant EXECUTE. r KEEPS EXECUTE. Modelling it as EXECUTE=false would report
// a held privilege as denied.
test("P2: REVOKE GRANT OPTION FOR cannot conclude anon EXECUTE=false", () => {
  const { functions, unresolved } = replay([
    ["001_a.sql", sql(DEF("f", "uuid"), "revoke grant option for execute on function public.f(uuid) from anon;")],
  ]);
  assert.ok(unresolved.some((u) => /GRANT OPTION FOR is not modelled/.test(u)),
    `expected fail-closed, got: ${unresolved.join("|")}`);
  // The privilege state must be left untouched — never flipped to denied.
  assert.equal(functions.get("public.f(uuid)").acl.anon, true,
    "anon retains EXECUTE: only the grant option was revoked");
});

test("P2: GRANT OPTION FOR fails closed for every role and both verbs", () => {
  for (const stmt of [
    "revoke grant option for execute on function public.f(uuid) from anon;",
    "revoke grant option for execute on function public.f(uuid) from authenticated;",
    "revoke grant option for all on function public.f(uuid) from service_role;",
  ]) {
    const { unresolved } = replay([["001_a.sql", sql(DEF("f", "uuid"), stmt)]]);
    assert.ok(unresolved.some((u) => /GRANT OPTION FOR is not modelled/.test(u)), stmt);
  }
});

test("P2: WITH GRANT OPTION on a GRANT still correctly models EXECUTE=true", () => {
  const { functions, unresolved } = replay([
    ["001_a.sql", sql(
      DEF("f", "uuid"),
      "revoke execute on function public.f(uuid) from public, anon, authenticated;",
      "grant execute on function public.f(uuid) to authenticated with grant option;",
    )],
  ]);
  assert.deepEqual(unresolved, []);
  const acl = functions.get("public.f(uuid)").acl;
  assert.equal(acl.authenticated, true, "WITH GRANT OPTION grants EXECUTE and is modelled as such");
  assert.equal(acl.anon, false);
});

// P2 (fresh-db): a pinned search_path is necessary but not sufficient — it must
// be the one the matrix declares.
test("P3: search_path normalisation ignores formatting but not substance", () => {
  assert.equal(normalizeSearchPath("''"), normalizeSearchPath('""'), "'' and \"\" are the same empty path");
  assert.equal(normalizeSearchPath("''"), "");
  assert.equal(normalizeSearchPath("pg_catalog, public, extensions"), normalizeSearchPath("pg_catalog,public,  extensions"));
  assert.equal(normalizeSearchPath("PUBLIC"), normalizeSearchPath("public"));
  assert.equal(normalizeSearchPath('"public", pg_temp'), normalizeSearchPath("public, pg_temp"));
  assert.notEqual(normalizeSearchPath("public"), normalizeSearchPath("public, pg_temp"));
  assert.notEqual(normalizeSearchPath("public"), normalizeSearchPath("''"));
  assert.equal(normalizeSearchPath(null), null, "null (no pinned path) is distinct from the empty path");
});

test("P3: a non-null but unexpected search_path FAILS the source-side diff", () => {
  const { functions } = replay([
    ["001_a.sql", sql(
      DEF("f", "uuid", "security definer set search_path = pg_temp"),
      "revoke execute on function public.f(uuid) from public, anon, authenticated;",
      "grant execute on function public.f(uuid) to service_role;",
    )],
  ]);
  const matrix = { functions: [{ schema: "public", name: "f", identity_arguments: "uuid", signature: "public.f(uuid)", public: false, anon: false, authenticated: false, service_role: true, trigger_only: false, search_path: "''" }] };
  const { problems } = diffAgainstMatrix(functions, matrix);
  assert.ok(problems.some((p) => /search_path is "pg_temp" but the matrix declares "''"/.test(p)), problems.join("\n"));
});

test("P3: an equivalent-but-differently-spelled search_path does NOT fail", () => {
  const { functions } = replay([
    ["001_a.sql", sql(
      DEF("f", "uuid", "security definer set search_path = pg_catalog,public,  extensions"),
      "revoke execute on function public.f(uuid) from public, anon, authenticated;",
      "grant execute on function public.f(uuid) to service_role;",
    )],
  ]);
  const matrix = { functions: [{ schema: "public", name: "f", identity_arguments: "uuid", signature: "public.f(uuid)", public: false, anon: false, authenticated: false, service_role: true, trigger_only: false, search_path: "pg_catalog, public, extensions" }] };
  const { problems } = diffAgainstMatrix(functions, matrix);
  assert.deepEqual(problems, []);
});

test("P3: the fresh-DB certification compares live search_path against the matrix", () => {
  const src = readFileSync(path.join(ROOT, "scripts/check-fresh-db-migrations.mjs"), "utf8");
  assert.match(src, /normalizeSearchPath/, "must use the shared normaliser");
  assert.match(src, /search_path in the applied database is .* but the matrix declares/,
    "must report a live-vs-matrix search_path mismatch, not merely a missing pin");
});
