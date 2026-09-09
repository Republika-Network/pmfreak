#!/usr/bin/env node
// ============================================================================
// SECURITY DEFINER effective-grant checker (Gate-3 remediation).
//
// WHAT REPLACED WHAT, AND WHY
// ---------------------------
// The previous implementation of this file asked one lexical question per
// SECURITY DEFINER function: "does the string `revoke all on function <name>(`
// appear anywhere in the migration corpus?" It then reported PASS. That is a
// property of the migration TEXT, not a property of the resulting PRIVILEGES,
// and the two came apart on a real hosted project: a live Security Advisor run
// against a freshly migrated canonical project reported 26 SECURITY DEFINER
// functions executable by `anon` while this checker reported PASS.
//
// The reason is that PUBLIC, anon, authenticated and service_role are FOUR
// DISTINCT PRIVILEGE PRINCIPALS. On Supabase the platform bootstrap runs, in
// effect:
//
//     alter default privileges in schema public
//       grant execute on functions to anon, authenticated, service_role;
//
// (certified verbatim by this repository's STOCK_DEFAULT_ACL fixture in
// scripts/check-fresh-db-migrations.mjs, which records
// "anon=X/postgres,authenticated=X/postgres,..." for objtype "f" in schema
// public). So every function created in schema public carries its own EXPLICIT
// per-role ACL entries for anon and authenticated, separate from the PUBLIC
// pseudo-role entry, and:
//
//     REVOKE ... FROM PUBLIC   DOES NOT REVOKE anon.
//     REVOKE ... FROM PUBLIC   DOES NOT REVOKE authenticated.
//
// That assumption is retired. This checker never treats a PUBLIC revoke as
// evidence about any named role.
//
// WHAT THIS CHECKER DOES INSTEAD
// ------------------------------
// It reconstructs the EFFECTIVE final ACL by replaying every migration in
// canonical filename order:
//
//   * function identity is schema + name + IDENTITY ARGUMENT TYPES, so
//     overloads are tracked independently and never collapsed by name;
//   * CREATE FUNCTION seeds the ACL from the certified platform default;
//   * CREATE OR REPLACE FUNCTION PRESERVES the existing ACL (PostgreSQL
//     semantics) and updates only the definition;
//   * DROP FUNCTION destroys the ACL, so a later CREATE re-seeds it from the
//     platform default -- silently undoing every earlier revoke;
//   * GRANT and REVOKE are applied per NAMED PRINCIPAL, in order.
//
// The reconstructed state is then diffed against the declarative matrix in
// supabase/security/security-definer-grant-matrix.json, which is the authority
// for intent. A SECURITY DEFINER function missing from the matrix fails; a
// matrix entry with no corresponding final function fails; any principal whose
// effective privilege differs from the declared one fails.
//
// FAIL-CLOSED
// -----------
// This checker refuses to guess. Anything it cannot model exactly is reported
// as an unresolved finding and fails the run rather than being skipped:
// ALTER FUNCTION, ALTER ROUTINE, ALTER DEFAULT PRIVILEGES, GRANT/REVOKE ON ALL
// FUNCTIONS IN SCHEMA, unparseable identity-argument syntax, unrecognised
// grantee roles, and unterminated dollar-quoted bodies. None of these
// constructs exist in the corpus today; if one is introduced, this file must
// be extended before the gate can pass again.
//
// Usage: npm run check:security-definer-hardening
// ============================================================================

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const MATRIX_PATH = path.join(ROOT, "supabase/security/security-definer-grant-matrix.json");

/** The four principals whose EXECUTE privilege this checker models. */
export const PRINCIPALS = Object.freeze(["public", "anon", "authenticated", "service_role"]);

// Supabase's certified default ACL for a newly created function in schema
// `public`: PostgreSQL's own default EXECUTE-to-PUBLIC grant, plus the three
// platform roles from the bootstrap ALTER DEFAULT PRIVILEGES rule. Kept in
// sync with STOCK_DEFAULT_ACL ("anon=X/postgres,authenticated=X/postgres,
// postgres=X/postgres,service_role=X/postgres" for objtype "f") in
// scripts/check-fresh-db-migrations.mjs.
export const PLATFORM_DEFAULT_FUNCTION_ACL = Object.freeze({
  public: true,
  anon: true,
  authenticated: true,
  service_role: true,
});

// Roles that may legitimately appear as a GRANT/REVOKE grantee. Anything else
// is an unresolved finding rather than a silent no-op.
const KNOWN_ROLES = new Set([
  ...PRINCIPALS,
  "postgres",
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "dashboard_user",
  "authenticator",
]);

// Constructs that would invalidate the reconstruction if present.
const UNSUPPORTED_CONSTRUCTS = [
  { re: /\balter\s+function\b/i, what: "ALTER FUNCTION" },
  { re: /\balter\s+routine\b/i, what: "ALTER ROUTINE" },
  { re: /\balter\s+procedure\b/i, what: "ALTER PROCEDURE" },
  { re: /\balter\s+default\s+privileges\b/i, what: "ALTER DEFAULT PRIVILEGES" },
  { re: /\bon\s+all\s+functions\s+in\s+schema\b/i, what: "GRANT/REVOKE ON ALL FUNCTIONS IN SCHEMA" },
  { re: /\bon\s+all\s+routines\s+in\s+schema\b/i, what: "GRANT/REVOKE ON ALL ROUTINES IN SCHEMA" },
  { re: /\bon\s+routine\b/i, what: "GRANT/REVOKE ON ROUTINE" },
];

// ---------------------------------------------------------------------------
// Lexing: split SQL into statements while respecting dollar-quoted bodies
// (any tag, not just `$$`), single-quoted literals and comments.
// ---------------------------------------------------------------------------

/**
 * Split `sql` into top-level statements. Returns { statements, error }.
 * `error` is non-null when a dollar-quoted body or literal is unterminated,
 * in which case the caller must fail closed rather than use the statements.
 */
export function splitStatements(sql) {
  const statements = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    // line comment
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    // block comment (nesting per PostgreSQL)
    if (two === "/*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") { depth++; i += 2; }
        else if (sql.slice(i, i + 2) === "*/") { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) return { statements, error: "unterminated block comment" };
      continue;
    }
    // single-quoted literal ('' escapes a quote)
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j++;
      }
      if (j >= n) return { statements, error: "unterminated single-quoted literal" };
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // double-quoted identifier
    if (sql[i] === '"') {
      let j = i + 1;
      while (j < n && sql[j] !== '"') j++;
      if (j >= n) return { statements, error: "unterminated quoted identifier" };
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // dollar-quoted body with an arbitrary tag: $$ ... $$ or $tag$ ... $tag$
    if (sql[i] === "$") {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close < 0) return { statements, error: `unterminated dollar-quoted body ${tag}` };
        buf += sql.slice(i, close + tag.length);
        i = close + tag.length;
        continue;
      }
    }
    if (sql[i] === ";") {
      if (buf.trim()) statements.push(buf.trim());
      buf = "";
      i++;
      continue;
    }
    buf += sql[i];
    i++;
  }
  if (buf.trim()) statements.push(buf.trim());
  return { statements, error: null };
}

// ---------------------------------------------------------------------------
// Identity argument parsing
// ---------------------------------------------------------------------------

const TYPE_ALIASES = new Map(Object.entries({
  int: "integer", int4: "integer", int2: "smallint", int8: "bigint",
  bool: "boolean", float4: "real", float8: "double precision",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time with time zone": "timetz",
  "time without time zone": "time",
  "character varying": "varchar",
  character: "char",
  decimal: "numeric",
}));

// A leading token that is itself part of a type name rather than a parameter
// name. Used to decide whether the first word is a parameter name to drop.
const TYPE_LEAD = /^(character|double|timestamp|time|bit|numeric|decimal|smallint|integer|bigint|boolean|text|uuid|jsonb|json|bytea|date|interval|real|money|inet|cidr|macaddr|xml|void|record|trigger|tsvector|tsquery|int|int2|int4|int8|bool|float4|float8|varchar|char|serial|bigserial|anyelement|anyarray)\b/;

const VALID_TYPE = /^[a-z_][a-z0-9_]*( [a-z][a-z0-9_]*)*(\[\])*$/;

/** Split on top-level commas, respecting nested parentheses and brackets. */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Normalise a PostgreSQL argument list to its IDENTITY arguments — the form
 * `pg_get_function_identity_arguments` produces: types only, no parameter
 * names, no DEFAULT clauses, no type modifiers, and OUT parameters excluded
 * (they are not part of a function's identity).
 *
 * Returns { args, error }. `error` is non-null for syntax this checker cannot
 * model exactly, and the caller must fail closed.
 */
export function parseIdentityArguments(raw) {
  if (raw === undefined || raw === null) return { args: null, error: "missing argument list" };
  if (!raw.trim()) return { args: "", error: null };
  const parts = splitTopLevel(raw);
  const types = [];
  for (const part of parts) {
    let t = part.trim().toLowerCase().replace(/\s+/g, " ");
    if (!t) continue;
    // strip DEFAULT / `=` initialisers
    t = t.replace(/\s+default\s+[\s\S]*$/i, "").replace(/\s*=\s*[\s\S]*$/, "").trim();
    // argument mode: OUT params are excluded from the identity entirely
    let mode = "";
    const mm = /^(in|out|inout|variadic)\s+/i.exec(t);
    if (mm) {
      const kw = mm[1].toLowerCase();
      t = t.slice(mm[0].length).trim();
      if (kw === "out") continue;
      if (kw === "inout") mode = "INOUT ";
      if (kw === "variadic") mode = "VARIADIC ";
    }
    // drop the parameter NAME when the remainder does not itself begin a type
    if (!TYPE_LEAD.test(t)) {
      const sp = t.indexOf(" ");
      if (sp > 0) t = t.slice(sp + 1).trim();
    }
    // strip type modifiers: numeric(10,2) -> numeric, varchar(64) -> varchar
    const arraySuffix = (t.match(/(\[\s*\d*\s*\])+$/) || [""])[0].replace(/[\s\d]/g, "");
    t = t.replace(/(\[\s*\d*\s*\])+$/, "").trim();
    t = t.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (TYPE_ALIASES.has(t)) t = TYPE_ALIASES.get(t);
    t = t + arraySuffix;
    if (!VALID_TYPE.test(t)) {
      return { args: null, error: `unsupported identity-argument syntax: ${JSON.stringify(part.trim())}` };
    }
    types.push(mode + t);
  }
  return { args: types.join(","), error: null };
}

/** Read a balanced parenthesised group starting at `open` (index of "("). */
function readParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) return { inner: s.slice(open + 1, i), end: i }; }
  }
  return null;
}

const normaliseName = (schema, name) => `${(schema || "public").toLowerCase()}.${name.toLowerCase()}`;
const signatureOf = (qualified, args) => `${qualified}(${args})`;

// ---------------------------------------------------------------------------
// Statement handlers
// ---------------------------------------------------------------------------


/**
 * The routine-option text of a CREATE FUNCTION statement: everything after the
 * argument list, with the dollar-quoted body span removed.
 *
 * Options are legal both before and after the body, so both sides are returned
 * joined. The body is excluded rather than included: including it would let
 * `-- security definer` in a comment, or the string 'SECURITY DEFINER', flip a
 * SECURITY INVOKER function's classification.
 *
 * Fails closed on an unterminated body tag.
 */
export function routineOptionsText(stmt, from) {
  const rest = stmt.slice(from);
  const bodyMatch = /\$([A-Za-z_]\w*)?\$/.exec(rest);
  if (!bodyMatch) {
    // No dollar-quoted body (e.g. `AS 'file', 'symbol'`, or a SQL-standard
    // `BEGIN ATOMIC` body). Scan the whole remainder: over-detecting SECURITY
    // DEFINER forces a matrix entry, which fails closed; under-detecting would
    // drop the function from enforcement.
    return { text: rest, error: null };
  }
  const tag = bodyMatch[0];
  const bodyStart = bodyMatch.index;
  const bodyEnd = rest.indexOf(tag, bodyStart + tag.length);
  if (bodyEnd < 0) {
    return { text: "", error: `unterminated dollar-quoted body ${tag} in CREATE FUNCTION` };
  }
  return { text: `${rest.slice(0, bodyStart)}\n${rest.slice(bodyEnd + tag.length)}`, error: null };
}

function handleCreate(stmt, file, state, unresolved) {
  const head = /create\s+(or\s+replace\s+)?function\s+(?:("?[a-zA-Z_]\w*"?)\s*\.\s*)?("?[a-zA-Z_]\w*"?)\s*\(/i.exec(stmt);
  if (!head) return false;
  const isReplace = Boolean(head[1]);
  const strip = (s) => (s ? s.replace(/"/g, "") : s);
  const qualified = normaliseName(strip(head[2]), strip(head[3]));
  const open = stmt.indexOf("(", head.index + head[0].length - 1);
  const paren = readParen(stmt, open);
  if (!paren) {
    unresolved.push(`${file}: unbalanced argument list in CREATE FUNCTION ${qualified}`);
    return true;
  }
  const { args, error } = parseIdentityArguments(paren.inner);
  if (error) {
    unresolved.push(`${file}: ${qualified}: ${error}`);
    return true;
  }
  // Routine options may appear on EITHER side of the body. PostgreSQL accepts
  //     CREATE FUNCTION f() RETURNS int AS $$ ... $$
  //       LANGUAGE sql SECURITY DEFINER SET search_path = '';
  // just as it accepts the same options before `AS`. Reading only the text
  // before the body silently classified such a function as SECURITY INVOKER
  // and dropped it from matrix enforcement entirely — a false negative in the
  // one direction that matters. Scan both sides, and EXCLUDE the body itself so
  // that a comment or string literal inside it can never be read as an option.
  const options = routineOptionsText(stmt, paren.end + 1);
  if (options.error) {
    unresolved.push(`${file}: ${qualified}: ${options.error}`);
    return true;
  }
  const header = options.text;
  const sig = signatureOf(qualified, args);

  const securityDefiner = /\bsecurity\s+definer\b/i.test(header);
  const isTrigger = /\breturns\s+trigger\b/i.test(header);
  const spMatch = /\bset\s+search_path\s*(?:=|to)\s*([^\n]*?)(?=\s*(?:\bas\b|\blanguage\b|\bstable\b|\bimmutable\b|\bvolatile\b|\bsecurity\b|\bstrict\b|\bcost\b|\brows\b|\bparallel\b|\bset\b|$))/i.exec(header);
  const searchPath = spMatch ? spMatch[1].trim().replace(/\s+/g, " ").replace(/\s*\bas\b\s*$/i, "").trim() : null;

  let rec = state.get(sig);
  if (!rec) {
    rec = { signature: sig, qualified, args, acl: null, definitions: [] };
    state.set(sig, rec);
  }
  // PostgreSQL semantics: CREATE OR REPLACE preserves the existing ACL; a
  // fresh CREATE (or a CREATE after a DROP) seeds the platform default.
  if (!isReplace || rec.acl === null) rec.acl = { ...PLATFORM_DEFAULT_FUNCTION_ACL };
  rec.dropped = false;
  rec.securityDefiner = securityDefiner;
  rec.isTrigger = isTrigger;
  rec.searchPath = searchPath;
  rec.latestDefinition = file;
  rec.definitions.push({ file, replace: isReplace });
  return true;
}

function handleDrop(stmt, file, state, unresolved) {
  const head = /drop\s+function\s+(?:if\s+exists\s+)?(?:("?[a-zA-Z_]\w*"?)\s*\.\s*)?("?[a-zA-Z_]\w*"?)\s*\(/i.exec(stmt);
  if (!head) return false;
  const strip = (s) => (s ? s.replace(/"/g, "") : s);
  const qualified = normaliseName(strip(head[1]), strip(head[2]));
  const open = stmt.indexOf("(", head.index + head[0].length - 1);
  const paren = readParen(stmt, open);
  if (!paren) {
    unresolved.push(`${file}: unbalanced argument list in DROP FUNCTION ${qualified}`);
    return true;
  }
  const { args, error } = parseIdentityArguments(paren.inner);
  if (error) {
    unresolved.push(`${file}: ${qualified}: ${error}`);
    return true;
  }
  const rec = state.get(signatureOf(qualified, args));
  if (rec) {
    rec.dropped = true;
    rec.droppedIn = file;
    // Dropping destroys the ACL. A later CREATE re-seeds platform defaults,
    // silently undoing every revoke issued before the drop.
    rec.acl = null;
  }
  return true;
}

function handleGrantRevoke(stmt, file, state, unresolved) {
  const head = /^(grant|revoke)\s+(grant\s+option\s+for\s+)?([\s\S]*?)\s+on\s+function\s+/i.exec(stmt);
  if (!head) return false;
  const isGrant = head[1].toLowerCase() === "grant";
  // `REVOKE GRANT OPTION FOR EXECUTE ... FROM r` removes only r's ability to
  // re-grant EXECUTE. r KEEPS EXECUTE. Modelling it as EXECUTE=false would
  // report a privilege as denied while it is still held — the exact direction
  // of error this checker exists to prevent. Grant-option state is not
  // modelled, so fail closed rather than guess.
  if (head[2]) {
    unresolved.push(
      `${file}: GRANT OPTION FOR is not modelled by this checker (statement: ${stmt.slice(0, 100)}). ` +
      "It changes only the grant option, never the EXECUTE privilege itself; extend this checker to track grant-option state before using it.",
    );
    return true;
  }
  const privileges = head[3].trim().toLowerCase();
  if (!/^(all(\s+privileges)?|execute)$/.test(privileges)) {
    unresolved.push(`${file}: unsupported privilege list ${JSON.stringify(privileges)} in ${isGrant ? "GRANT" : "REVOKE"} ON FUNCTION`);
    return true;
  }
  // Parse a comma-separated list of function specs, then the grantee clause.
  let cursor = head.index + head[0].length;
  const specs = [];
  for (;;) {
    const rest = stmt.slice(cursor);
    const nameMatch = /^\s*(?:("?[a-zA-Z_]\w*"?)\s*\.\s*)?("?[a-zA-Z_]\w*"?)\s*\(/.exec(rest);
    if (!nameMatch) {
      unresolved.push(`${file}: could not parse function reference in ${isGrant ? "GRANT" : "REVOKE"}: ${stmt.slice(0, 120)}`);
      return true;
    }
    const strip = (s) => (s ? s.replace(/"/g, "") : s);
    const qualified = normaliseName(strip(nameMatch[1]), strip(nameMatch[2]));
    const open = cursor + rest.indexOf("(", nameMatch[0].length - 1);
    const paren = readParen(stmt, open);
    if (!paren) {
      unresolved.push(`${file}: unbalanced argument list in ${isGrant ? "GRANT" : "REVOKE"} for ${qualified}`);
      return true;
    }
    const { args, error } = parseIdentityArguments(paren.inner);
    if (error) {
      unresolved.push(`${file}: ${qualified}: ${error}`);
      return true;
    }
    specs.push(signatureOf(qualified, args));
    cursor = paren.end + 1;
    const sep = /^\s*,/.exec(stmt.slice(cursor));
    if (sep) { cursor += sep[0].length; continue; }
    break;
  }
  const granteeClause = /^\s*(?:from|to)\s+([\s\S]+)$/i.exec(stmt.slice(cursor));
  if (!granteeClause) {
    unresolved.push(`${file}: missing TO/FROM clause in ${isGrant ? "GRANT" : "REVOKE"}: ${stmt.slice(0, 120)}`);
    return true;
  }
  const roles = granteeClause[1]
    .replace(/\bwith\s+grant\s+option\b/i, "")
    .replace(/\b(cascade|restrict)\b/i, "")
    .split(",")
    .map((r) => r.trim().toLowerCase().replace(/^group\s+/, "").replace(/"/g, ""))
    .filter(Boolean);

  for (const role of roles) {
    if (!KNOWN_ROLES.has(role)) {
      unresolved.push(`${file}: unrecognised grantee role ${JSON.stringify(role)} — cannot model its effect`);
      return true;
    }
  }
  for (const sig of specs) {
    const rec = state.get(sig);
    if (!rec || rec.dropped || rec.acl === null) {
      unresolved.push(`${file}: ${isGrant ? "GRANT" : "REVOKE"} references ${sig}, which does not exist at this point in the migration order`);
      continue;
    }
    for (const role of roles) {
      if (!PRINCIPALS.includes(role)) continue; // modelled principals only
      rec.acl[role] = isGrant;
      (rec.aclLog ??= []).push(`${file}:${isGrant ? "GRANT" : "REVOKE"}:${role}`);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Replay migrations in the given order and reconstruct effective final state.
 * @param {{file: string, sql: string}[]} migrations
 * @returns {{functions: Map<string, object>, unresolved: string[]}}
 */
export function replayMigrations(migrations) {
  const state = new Map();
  const unresolved = [];
  for (const { file, sql } of migrations) {
    const { statements, error } = splitStatements(sql);
    if (error) {
      unresolved.push(`${file}: ${error} — cannot reconstruct ACL state from this file`);
      continue;
    }
    for (const stmt of statements) {
      for (const { re, what } of UNSUPPORTED_CONSTRUCTS) {
        if (re.test(stmt)) {
          unresolved.push(`${file}: ${what} is not modelled by this checker; extend it before this gate can pass (statement: ${stmt.slice(0, 100)})`);
        }
      }
      if (handleCreate(stmt, file, state, unresolved)) continue;
      if (handleDrop(stmt, file, state, unresolved)) continue;
      if (handleGrantRevoke(stmt, file, state, unresolved)) continue;
    }
  }
  return { functions: state, unresolved };
}

/** Final (not dropped) functions that were actually defined. */
export function finalFunctions(state) {
  return [...state.values()].filter((r) => !r.dropped && r.definitions.length > 0);
}

export function finalSecurityDefiner(state) {
  return finalFunctions(state)
    .filter((r) => r.securityDefiner)
    .sort((a, b) => a.signature.localeCompare(b.signature));
}

export function loadMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

export function loadMigrations() {
  return loadMigrationFiles().map((file) => ({
    file,
    sql: readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"),
  }));
}

export function loadMatrix(matrixPath = MATRIX_PATH) {
  return JSON.parse(readFileSync(matrixPath, "utf8"));
}

// ---------------------------------------------------------------------------
// Diff reconstructed state against the declarative matrix
// ---------------------------------------------------------------------------


/**
 * Canonical form of a `search_path` setting, so that the source-side model and
 * the live-catalog certification compare like with like.
 *
 * The same setting is spelled differently on each side: source says
 * `set search_path = ''` while pg_proc.proconfig reports `search_path=""`, and
 * element spacing varies freely. Normalising to a lowercased, unquoted,
 * comma-joined element list means an inconsequential formatting difference can
 * never raise a false mismatch — while a genuinely different path still does.
 * The empty path (`''`) normalises to the empty string, distinct from `null`
 * (no pinned search_path at all).
 */
export function normalizeSearchPath(value) {
  if (value === null || value === undefined) return null;
  return value
    .split(",")
    .map((part) => {
      let t = part.trim();
      if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
        t = t.slice(1, -1);
      }
      return t.trim().toLowerCase();
    })
    .filter((t) => t.length > 0)
    .join(", ");
}

/**
 * @returns {{problems: string[], totals: object}}
 */
export function diffAgainstMatrix(state, matrix) {
  const problems = [];
  const sd = finalSecurityDefiner(state);
  const declared = new Map(matrix.functions.map((f) => [f.signature, f]));
  const seen = new Set();

  for (const fn of sd) {
    const spec = declared.get(fn.signature);
    if (!spec) {
      problems.push(`${fn.signature}: SECURITY DEFINER function is absent from security-definer-grant-matrix.json — every SECURITY DEFINER function must declare its intended EXECUTE matrix`);
      continue;
    }
    seen.add(fn.signature);
    // 14. every SECURITY DEFINER function must pin search_path
    if (fn.searchPath === null || fn.searchPath === undefined) {
      problems.push(`${fn.signature}: SECURITY DEFINER without a pinned 'set search_path' in its latest definition (${fn.latestDefinition})`);
    } else if (
      spec.search_path !== undefined &&
      spec.search_path !== null &&
      normalizeSearchPath(spec.search_path) !== normalizeSearchPath(fn.searchPath)
    ) {
      problems.push(`${fn.signature}: search_path is ${JSON.stringify(fn.searchPath)} but the matrix declares ${JSON.stringify(spec.search_path)}`);
    }
    if (Boolean(spec.trigger_only) !== Boolean(fn.isTrigger)) {
      problems.push(`${fn.signature}: matrix declares trigger_only=${Boolean(spec.trigger_only)} but the definition ${fn.isTrigger ? "does" : "does not"} return trigger`);
    }
    for (const principal of PRINCIPALS) {
      const effective = Boolean(fn.acl?.[principal]);
      const intended = Boolean(spec[principal]);
      if (effective !== intended) {
        problems.push(
          `${fn.signature}: ${principal} EXECUTE is ${effective ? "GRANTED" : "DENIED"} by the migration chain but the matrix declares ${intended ? "ALLOW" : "DENY"}` +
          (principal === "anon" && effective
            ? " — note that 'revoke ... from public' does NOT revoke anon on Supabase; an explicit 'revoke ... from anon' is required"
            : "")
        );
      }
    }
  }

  for (const [sig] of declared) {
    if (!seen.has(sig)) {
      problems.push(`${sig}: declared in security-definer-grant-matrix.json but is not a final SECURITY DEFINER function in the migration chain (dropped, renamed, or no longer SECURITY DEFINER?)`);
    }
  }

  const totals = {
    security_definer_total: sd.length,
    public_executable: sd.filter((f) => f.acl?.public).length,
    anon_executable: sd.filter((f) => f.acl?.anon).length,
    authenticated_executable: sd.filter((f) => f.acl?.authenticated).length,
    service_role_executable: sd.filter((f) => f.acl?.service_role).length,
    unpinned_search_path: sd.filter((f) => f.searchPath === null || f.searchPath === undefined).length,
  };
  return { problems, totals };
}

// ---------------------------------------------------------------------------

function main() {
  const migrations = loadMigrations();
  const { functions, unresolved } = replayMigrations(migrations);

  // Fail closed: never diff a state we could not fully reconstruct.
  if (unresolved.length > 0) {
    console.error(`FAIL: ${unresolved.length} unresolved construct(s) — effective privilege state cannot be proven:`);
    unresolved.forEach((u) => console.error(`  - ${u}`));
    process.exitCode = 1;
    return;
  }

  const matrix = loadMatrix();
  const { problems, totals } = diffAgainstMatrix(functions, matrix);
  const sd = finalSecurityDefiner(functions);

  console.log(`SECURITY DEFINER effective-grant check — ${migrations.length} migration file(s) replayed in canonical order.\n`);
  console.log(`  final functions ............... ${finalFunctions(functions).length}`);
  console.log(`  SECURITY DEFINER .............. ${totals.security_definer_total}`);
  console.log(`  PUBLIC executable ............. ${totals.public_executable}`);
  console.log(`  anon executable ............... ${totals.anon_executable}`);
  console.log(`  authenticated executable ...... ${totals.authenticated_executable}`);
  console.log(`  service_role executable ....... ${totals.service_role_executable}`);
  console.log(`  unpinned search_path .......... ${totals.unpinned_search_path}\n`);

  for (const fn of sd) {
    const spec = matrix.functions.find((f) => f.signature === fn.signature);
    const acl = PRINCIPALS.map((p) => `${p}=${fn.acl?.[p] ? "X" : "-"}`).join(" ");
    console.log(`  ${fn.signature}\n      ${acl}  [${spec?.intended_caller ?? "UNDECLARED"}]`);
  }

  if (problems.length > 0) {
    console.error(`\nFAIL: ${problems.length} problem(s):`);
    problems.forEach((p) => console.error(`  - ${p}`));
    process.exitCode = 1;
    return;
  }
  console.log(`\nPASS: reconstructed effective EXECUTE privileges for all ${totals.security_definer_total} SECURITY DEFINER function(s) match supabase/security/security-definer-grant-matrix.json, and every one pins search_path.`);
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) main();
