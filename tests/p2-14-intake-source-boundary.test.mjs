/**
 * P2-14 review repair — the DEMO / LIVE Source boundary.
 *
 * Two independent reviews reproduced the same provenance-integrity defect: whoever chose
 * the intake `sourceKey` chose whether the resulting Evidence was DEMO_FIXTURE or LIVE,
 * because each capture contract MINTS a Source on first use of a key and only one of them
 * checked what it had resolved. Both collision directions were reachable by an ordinary
 * authorized writer.
 *
 * These tests prove the SHAPE of the repair — that the product boundary no longer accepts a
 * caller-chosen Source identity, and that the database contract defends its own semantics
 * rather than trusting the layer above it.
 *
 * The RUNTIME proof is `scripts/check-p2-14-db.mjs` (both directions refused at both
 * layers, against a real database) and the browser story in
 * `tests/e2e/p2-14-founder-story.spec.ts`. Source reading supplements those; it never
 * replaces them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const route = read("src/app/api/operational-flow/route.ts");
const sourceKeys = read("src/lib/operational-flow/intake-source-keys.ts");
const clientData = read("src/modules/workspace/presentation/command-center/operational-data.ts");
const intakePanel = read("src/modules/workspace/presentation/command-center/vault-intake-panel.tsx");
const logoutRoute = read("src/app/logout/route.ts");
const shell = read("src/components/pmfreak/operational-shell.tsx");
const textCaptureModal = read("src/components/pmfreak/intelligence-inbox/text-capture-modal.tsx");
// The migration corpus is CRLF; normalise so positional assertions below compare text,
// not line endings.
const hardening = read("supabase/migrations/20260907000000_p2_14_intake_source_classification_hardening.sql").replace(/\r\n/g, "\n");

/** The body of a `create or replace function` block, by function name. */
function functionBody(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.notEqual(start, -1, `${name} must be defined in the hardening migration`);
  const body = sql.slice(start);
  const end = body.indexOf("$$;");
  assert.notEqual(end, -1, `${name} must be terminated`);
  return body.slice(0, end);
}

// ───────────────────────────── product / HTTP boundary ─────────────────────────────

test("P2-14 repair: the canonical Source identities are declared server-side", () => {
  assert.match(sourceKeys, /export const DEMO_FIXTURE_INTAKE_SOURCE_KEY = "manual-demo:v1";/);
  assert.match(sourceKeys, /export const LIVE_INTAKE_SOURCE_KEY = "live-observation:v1";/);
  // The operation -> identity table is the product-side statement of DEMO_FIXTURE != LIVE.
  assert.match(sourceKeys, /capture_input: DEMO_FIXTURE_INTAKE_SOURCE_KEY/);
  assert.match(sourceKeys, /capture_live_input: LIVE_INTAKE_SOURCE_KEY/);
  // Frozen: a mutable mapping would be one assignment away from the defect it closes.
  assert.match(sourceKeys, /Object\.freeze\(\{/);
});

test("P2-14 repair: BOTH intake operations resolve their Source key from the operation", () => {
  // The defect was `String(body.sourceKey ?? "<default>")` — a caller-supplied identity with
  // a default, not a pin. Neither operation may read the request body for its Source again.
  assert.ok(
    !/sourceKey: String\(body\.sourceKey/.test(route),
    "no intake operation may take its Source identity from the request body"
  );
  for (const operation of ["capture_input", "capture_live_input"]) {
    assert.ok(
      route.includes(`const sourceKey = pinnedIntakeSourceKey("${operation}", body);`),
      `${operation} must pin its Source key server-side`
    );
  }
  // Both branches surface the refusal rather than continuing with a coerced key.
  assert.equal(
    (route.match(/if \(sourceKey instanceof Response\) return sourceKey;/g) ?? []).length,
    2,
    "both intake branches must return the refusal"
  );
});

test("P2-14 repair: a non-canonical Source key is REFUSED, never silently accepted", () => {
  const start = route.indexOf("function pinnedIntakeSourceKey(");
  assert.notEqual(start, -1, "the pin helper must exist");
  const body = route.slice(start, route.indexOf("\n}\n", start));

  // Refusal, not coercion: a caller who believes it selected a different Source must learn
  // that it did not, rather than have its intent rewritten into another provenance lineage.
  assert.match(body, /supplied !== null && supplied !== pinned/);
  assert.match(body, /INTAKE_SOURCE_KEY_NOT_PERMITTED/);
  assert.match(body, /status: 400/);
  // The canonical key is what reaches the contract in every accepted case.
  assert.match(body, /return pinned;/);
  assert.match(sourceKeys, /export const INTAKE_SOURCE_KEY_NOT_PERMITTED = "intake_source_key_not_permitted";/);
});

test("P2-14 repair: the browser no longer states a Source identity", () => {
  assert.ok(
    !/sourceKey:/.test(clientData),
    "no client intake helper may send a sourceKey"
  );
  assert.ok(
    !/LIVE_INTAKE_SOURCE_KEY|manual-demo:v1|live-observation:v1/.test(clientData),
    "the client must not name a canonical Source key at all"
  );
  // What it sends instead is the mode the human chose, as the operation.
  assert.match(clientData, /operation: "capture_input", idempotencyKey:/);
  assert.match(clientData, /operation: "capture_live_input",\n\s+idempotencyKey:/);

  // Every OTHER browser intake surface too — one client still naming an identity would
  // reopen the collision, because the route accepts a supplied key that matches.
  assert.ok(
    !/sourceKey/.test(textCaptureModal),
    "the Intelligence Inbox capture modal must not send a sourceKey"
  );
  // It reaches the operation through the shared LIVE helper rather than naming one inline
  // (UX-P0-01). The helper's own operation naming is asserted on `clientData` above, so the
  // property still holds end to end: the browser names an OPERATION, never a Source.
  assert.match(textCaptureModal, /captureAndDeriveLiveEvidence\(workspaceId, projectId,/);
});

// ───────────────────────────── database contract ─────────────────────────────

test("P2-14 repair: the hardening migration is additive and forward-only", () => {
  // No destructive DDL, no schema redesign, no RLS or policy change, no data change.
  for (const forbidden of [
    /drop\s+table/i,
    /drop\s+function/i,
    /drop\s+column/i,
    /alter\s+table/i,
    /alter\s+policy/i,
    /create\s+policy/i,
    /drop\s+policy/i,
    /row\s+level\s+security/i,
    /\bdelete\s+from\b/i,
    /\btruncate\b/i,
  ]) {
    assert.ok(!forbidden.test(hardening), `hardening migration must not contain ${forbidden}`);
  }
  // An UPDATE would mean relabelling a Source that already has derived provenance.
  assert.ok(!/\bupdate\s+public\./i.test(hardening), "hardening migration must not relabel any Source");
});

test("P2-14 repair: reserved identities belong to exactly one lineage", () => {
  assert.match(hardening, /create or replace function public\.reserved_intake_source_class\(p_source_key text\)/);
  assert.match(hardening, /when 'manual-demo:v1' then 'FIXTURE'/);
  assert.match(hardening, /when 'live-observation:v1' then 'LIVE'/);
  // A caller-defined key belongs to neither and keeps its existing freedom.
  assert.match(hardening, /else null/);
});

test("P2-14 repair: the DEMO contract refuses the reserved LIVE identity and any non-fixture Source", () => {
  const body = functionBody(hardening, "capture_operational_input");

  // Direction B — the denial of service. Refused BEFORE the insert, so no fixture Source is
  // ever minted under the LIVE key.
  const reserved = body.indexOf("reserved_intake_source_class(p_source_key) = 'LIVE'");
  const insert = body.indexOf("insert into public.operational_sources");
  assert.notEqual(reserved, -1, "the DEMO contract must refuse the reserved LIVE key");
  assert.ok(reserved < insert, "the reserved-key refusal must precede the Source insert");
  assert.match(body, /raise exception 'intake_source_key_reserved'/);

  // Direction A — the promotion. The `on conflict do nothing` insert means the SELECT can
  // return a Source this contract did not create, which is exactly what was never checked.
  assert.match(body, /if not v_source\.is_fixture then raise exception 'intake_source_kind_mismatch'; end if;/);
  assert.match(body, /if v_source\.id is null then raise exception 'intake_source_creation_failed'; end if;/);

  // The assertion has to sit between resolving the Source and writing anything against it.
  const select = body.indexOf("select * into v_source");
  const mismatch = body.indexOf("intake_source_kind_mismatch");
  const rawInsert = body.indexOf("insert into public.operational_raw_inputs");
  assert.ok(select < mismatch && mismatch < rawInsert, "classification must be asserted before any write");
});

test("P2-14 repair: the LIVE contract refuses the reserved DEMO identity and keeps its fixture refusal", () => {
  const body = functionBody(hardening, "capture_live_operational_input");

  const reserved = body.indexOf("reserved_intake_source_class(p_source_key) = 'FIXTURE'");
  const select = body.indexOf("select *\n    into v_source");
  assert.notEqual(reserved, -1, "the LIVE contract must refuse the reserved DEMO key");
  assert.ok(reserved < select, "the reserved-key refusal must precede Source resolution");
  assert.match(body, /raise exception 'intake_source_key_reserved'/);

  // The pre-existing refusals are intact: this repair adds, it does not relax.
  assert.equal(
    (body.match(/raise exception 'intake_source_fixture_prohibited'/g) ?? []).length,
    2,
    "both fixture refusals must survive"
  );
  // And it still mints a NON-fixture Source — the single reason derived Evidence is LIVE.
  assert.match(body, /'connector',\s*\n\s*'Live observation intake',\s*\n\s*'active',\s*\n\s*false,/);
});

test("P2-14 repair: both hardened contracts keep their signature, definer pinning and grants", () => {
  for (const name of ["capture_operational_input", "capture_live_operational_input"]) {
    const body = functionBody(hardening, name);
    assert.match(body, /security definer/, `${name} must remain SECURITY DEFINER`);
    assert.match(body, /set search_path = pg_catalog, public, extensions/, `${name} must pin search_path`);
    // Authority is still re-enforced inside the contract, under RLS.
    assert.match(body, /can_write_operational_project\(p_workspace_id, p_project_id\)/);
    assert.match(body, /raise exception 'intake_unauthenticated'/);
    assert.ok(
      new RegExp(`revoke all on function public\\.${name}\\(`).test(hardening),
      `${name} must revoke PUBLIC execute`
    );
    assert.ok(
      new RegExp(`grant execute on function public\\.${name}\\(`).test(hardening),
      `${name} must grant execute to authenticated`
    );
  }
  // Signatures unchanged: ten parameters, same order, for both.
  assert.equal(
    (hardening.match(/\(uuid,uuid,text,text,text,text,timestamptz,uuid,uuid,text\)/g) ?? []).length >= 3,
    true,
    "the hardened contracts keep their existing signatures"
  );
});

test("P2-14 repair: the route maps the new refusals to honest client statuses", () => {
  // `intake_source_key_reserved` would otherwise fall through to a 500, reporting a
  // client-correctable request as a server fault.
  assert.match(route, /required\|mismatch\|reserved\|invalid/);
});

// ───────────────────────────── observer judgement ─────────────────────────────

test("P2-14 repair: an empty confidence field is refused, and an explicit 0 is not", () => {
  // `Number("")` is 0, so an emptied field used to pass every range check and persist the
  // strongest possible "no confidence at all" claim as though the observer had made it.
  assert.match(intakePanel, /const confidenceEntered = confidenceScore\.trim\(\);/);
  assert.match(intakePanel, /confidenceEntered !== "" && Number\.isFinite\(confidence\)/);
  // The range check itself is unchanged, so a deliberate 0 remains a valid answer.
  assert.match(intakePanel, /confidence >= 0 && confidence <= 1/);
  // And it is still enforced before anything is submitted. The `isLive &&` qualifier is
  // gone because the customer panel no longer has a non-live branch to qualify (UX-P0-01),
  // which makes the guard unconditional rather than weaker.
  assert.match(intakePanel, /if \(!confidenceValid\) \{ setError\(/);

  // The SAME guard on the other intake surface. That surface now derives LIVE Evidence too,
  // so a fabricated zero can reach an Observation and the guard matters MORE than it did
  // when this modal wrote the fixture lineage.
  assert.match(textCaptureModal, /const confidenceEntered = confidenceScore\.trim\(\);/);
  assert.match(textCaptureModal, /if \(confidenceEntered === "" \|\| !Number\.isFinite\(confidence\)/);
  assert.match(textCaptureModal, /confidence < 0 \|\| confidence > 1/);
});

test("P2-14 repair: the canonical source-key module exports nothing dead", () => {
  // A type guard that no call site narrows through reads as the module's intended boundary
  // check and invites future code to route around the real one. The route dispatches on
  // string literals and resolves the key through `canonicalIntakeSourceKey`.
  assert.ok(!/isBuiltInIntakeOperation/.test(sourceKeys), "unused type guard must not linger");
  assert.match(sourceKeys, /export function canonicalIntakeSourceKey\(/);
  assert.match(sourceKeys, /export const CANONICAL_INTAKE_SOURCE_KEYS/);
});

test("P2-14 repair: one logical LIVE submission keeps one identity across a retry", () => {
  // The panel minted a fresh id per click, so a retry after a partial capture appended a
  // second Raw Input and Normalized Event for one human submission.
  assert.match(intakePanel, /const attemptKey = intakeAttemptKey\(workspaceId, projectId, mode, await sha256Hex\(content\.trim\(\)\)\);/);
  assert.match(intakePanel, /loadSubmissionAttempt\(attemptKey, \{ ttlMs: INTAKE_ATTEMPT_WINDOW_MS \}\)/);
  assert.match(intakePanel, /submissionId: attempt\.attemptId,/);
  // Retired on success, so the next deliberate capture is its own submission.
  assert.match(intakePanel, /clearSubmissionAttempt\(attemptKey\);/);

  // Both idempotency keys derive from it, which is what makes the retry reconcile.
  assert.match(clientData, /idempotencyKey: `live-capture:\$\{submissionId\}`/);
  assert.match(clientData, /idempotencyKey: `live-evidence:\$\{submissionId\}`/);

  // The attempt id must NOT become canonical identity: the attempt store's own contract is
  // that it only ever contributes to an idempotency key.
  assert.ok(
    !/correlationId: submissionId/.test(clientData),
    "a client attempt id must never be used as a correlation id"
  );
  assert.match(clientData, /const correlationId = crypto\.randomUUID\(\);/);
});

// ───────────────────────────── destructive GET ─────────────────────────────

test("P2-15 repair: sign-out is a POST, and GET cannot mutate authentication at all", () => {
  // P2-14 made a state-changing GET SAFE by recognising speculative requests. P2-15 makes
  // it INERT: the GET handler performs no session mutation, so a speculative request this
  // route fails to classify can no longer end a session. Recognition is defence in depth,
  // not the mechanism.
  const getHandler = logoutRoute.slice(
    logoutRoute.indexOf("export async function GET"),
    logoutRoute.indexOf("export async function POST")
  );
  assert.ok(getHandler.length > 0, "GET handler must exist");
  assert.ok(!/signOut/.test(getHandler), "GET must never call signOut");
  assert.ok(!/createSupabaseServerClient/.test(getHandler), "GET must not open an auth-capable client");
  assert.match(getHandler, /status:\s*405/);
  assert.match(getHandler, /Allow:\s*"POST"/);

  // The destructive transition exists, on POST only.
  assert.match(logoutRoute, /export async function POST\(request: Request\)/);
  const postHandler = logoutRoute.slice(logoutRoute.indexOf("export async function POST"));
  assert.match(postHandler, /await supabase\.auth\.signOut\(\);/);
  assert.match(postHandler, /NextResponse\.redirect\(new URL\("\/login", request\.url\), 303\)/);

  // Retained defence in depth: PRESENCE, not one exact value. `Next-Router-Prefetch` is an
  // enum of fetch strategies, not a boolean — Next 16.2.10 sends `2` for the segment
  // cache's PPR runtime strategy, so a guard pinned to `"1"` would stop recognising it.
  assert.match(logoutRoute, /request\.headers\.has\("next-router-prefetch"\)/);
  assert.ok(
    !/headers\.get\("next-router-prefetch"\) === "1"/.test(logoutRoute) &&
      !/header\("next-router-prefetch"\) === "1"/.test(logoutRoute),
    "the guard must not depend on one exact header value"
  );
  assert.match(logoutRoute, /\/\\bprefetch\\b\/i\.test\(header\("purpose"\)\)/);
  assert.match(logoutRoute, /\/\\bprefetch\\b\/i\.test\(header\("sec-purpose"\)\)/);
});

test("P2-15 repair: the shell submits sign-out rather than linking to it", () => {
  // A <Link> made sign-out a GET, and Next prefetches links entering the viewport — which
  // is how rendering the shell ended the session. A form POST is not prefetchable.
  assert.match(shell, /<form action="\/logout" method="post"/);
  assert.match(shell, /<button\s*\n?\s*type="submit"/);
  assert.ok(!/href="\/logout"/.test(shell), "sign-out must not be a navigable GET target");
});

// ───────────────────────────── error leakage ─────────────────────────────

test("P2-14 repair: an unauthenticated intake fault never returns raw RPC text", () => {
  // `intake_unauthenticated` is only reachable when the request-scoped client resolved no
  // `auth.uid()` AFTER requireAuthenticatedUser() already succeeded — a server-side fault.
  // It is answered honestly as 401, but with the shared unauthorized vocabulary.
  assert.match(route, /return Response\.json\(\{ error: GENERIC_UNAUTHORIZED_MESSAGE \}, \{ status: 401 \}\);/);
  // The real error is preserved server-side through the same redacting logger the shared
  // safe-response helper uses.
  assert.match(route, /logger\.error\("route_internal_error", \{ route: ROUTE_ID, error_detail: safeErrorMessage\(error\) \}\);/);
  // Anchored, so an unexpected driver error that merely CONTAINS the word is not reported
  // as 401 with its raw text — it falls through to the generic 500 envelope.
  assert.match(route, /const unauthenticated = \/\(\?:\^\|\[\\s:\]\)\[a-z_\]\*unauthenticated\$\/\.test\(message\);/);
  assert.match(route, /if \(status === 500\) return safeLegacyErrorResponse\(/);
});
