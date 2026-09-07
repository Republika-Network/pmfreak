/**
 * P2-14 — focused contract tests for the LIVE operational intake exposure.
 *
 * These prove the SHAPE of the change: that P2-14 connected an already-verified contract
 * to the existing product boundary rather than inventing a second intake model, and that
 * the fixture/live invariant survived the connection.
 *
 * Runtime behaviour (authentication, tenancy, IDOR, idempotency, fixture refusal against a
 * live database) is proven separately by the browser suite in
 * `tests/e2e/p2-14-founder-story.spec.ts`, which drives the real server. Source reading
 * supplements that; it never replaces it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const route = read("src/app/api/operational-flow/route.ts");
const service = read("src/lib/operational-flow/operational-flow-service.ts");
const clientData = read("src/modules/workspace/presentation/command-center/operational-data.ts");
const intakePanel = read("src/modules/workspace/presentation/command-center/vault-intake-panel.tsx");
const p2_09Migration = read("supabase/migrations/20260906000000_p2_09_outcome_observation_contract.sql");
const sourceKeys = read("src/lib/operational-flow/intake-source-keys.ts");
const fixturePanel = read("src/components/internal/governance-lab/fixture-intake-panel.tsx");

test("P2-14: the LIVE intake operation is exposed on the EXISTING operational-flow route", () => {
  // No new route: the existing boundary represents the operation.
  assert.match(route, /"capture_live_input",/);
  assert.match(route, /if \(operation === "capture_live_input"\)/);
  assert.match(route, /captureLiveOperationalInput\(authorized\.supabase, scope,/);

  // The same authorize() gate as every other write on this route.
  assert.match(route, /const authorized = await authorize\(projectId, workspaceId, "write"\);/);
});

test("P2-14: no new API route file was introduced for live intake", () => {
  const apiRoot = new URL("../src/app/api/", import.meta.url);
  const names = readdirSync(apiRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const forbidden of ["live-intake", "live-input", "observation-intake", "operational-intake"]) {
    assert.ok(!names.includes(forbidden), `unexpected new API route directory: ${forbidden}`);
  }
});

test("P2-14: the service DELEGATES to the verified RPC and reimplements none of it", () => {
  assert.match(service, /export async function captureLiveOperationalInput\(/);
  assert.match(service, /client\.rpc\("capture_live_operational_input", \{/);

  // Role gate reuses the existing authority contract rather than a new one.
  const fn = service.slice(service.indexOf("export async function captureLiveOperationalInput("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /canCreateOperationalEvidence\(scope\.role \?\? null\)/);

  // It must not fabricate any canonical node itself: no direct table writes, and no
  // Evidence creation smuggled into capture.
  assert.ok(!/\.from\("operational_raw_inputs"\)[\s\S]{0,80}\.insert/.test(body), "service must not insert Raw Input directly");
  assert.ok(!/\.from\("operational_normalized_events"\)[\s\S]{0,80}\.insert/.test(body), "service must not insert Normalized Events directly");
  assert.ok(!/\.from\("evidence_items"\)/.test(body), "service must not touch evidence_items");
  assert.ok(!/derive_operational_evidence/.test(body), "capture must not collapse into Evidence derivation");
});

test("P2-14: capture and Evidence derivation remain two separate transitions", () => {
  const fn = clientData.slice(clientData.indexOf("export async function captureAndDeriveLiveEvidence("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  // Two distinct canonical operations, in order, against the same correlation.
  assert.match(body, /operation: "capture_live_input"/);
  assert.match(body, /operation: "derive_evidence"/);
  // Evidence quality is supplied, never defaulted into a fabricated certainty.
  assert.match(body, /assertionType: input\.assertionType/);
  assert.match(body, /confidenceScore: input\.confidenceScore/);
  assert.match(body, /missingDataState: input\.missingDataState/);
});

test("P2-14: the LIVE source key is distinct from every fixture source key", () => {
  // Owned by the server since the P2-14 review repair: the browser names a MODE, and the
  // route resolves the identity that mode may write against.
  assert.match(sourceKeys, /export const LIVE_INTAKE_SOURCE_KEY = "live-observation:v1";/);
  assert.match(sourceKeys, /export const DEMO_FIXTURE_INTAKE_SOURCE_KEY = "manual-demo:v1";/);
  // Not the DEMO / FIXTURE manual key, and not a P2-13 fixture key.
  assert.ok(!/LIVE_INTAKE_SOURCE_KEY = "manual-demo:v1"/.test(sourceKeys));
  assert.ok(!/live-observation:v1[\s\S]{0,40}p2-13-founder-fixture/.test(sourceKeys));
});

test("P2-14: the verified RPC still creates a NON-fixture source and refuses fixture sources", () => {
  // The single reason derived Evidence becomes LIVE. Asserted against the migration so a
  // future edit that flips it fails here rather than silently in the browser suite.
  const fn = p2_09Migration.slice(p2_09Migration.indexOf("create or replace function public.capture_live_operational_input"));
  const body = fn.slice(0, fn.indexOf("\n$$;"));
  assert.match(body, /is_fixture[\s\S]{0,400}false/);
  assert.match(body, /raise exception 'intake_source_fixture_prohibited'/);
  // Still granted to the ordinary authenticated role — no privileged proxy.
  assert.match(p2_09Migration, /grant execute on function public\.capture_live_operational_input\([\s\S]*?\) to authenticated;/);
});

test("P2-14: P2-09 observation eligibility was NOT weakened", () => {
  // Observation still requires at least one reference, and every reference must be LIVE.
  assert.match(p2_09Migration, /raise exception 'observation_evidence_required'/);
  assert.match(p2_09Migration, /and e\.fixture_state = 'LIVE'/);
  assert.match(p2_09Migration, /raise exception 'observation_evidence_scope_invalid'/);
});

/** Comments explain the invariant; only executable code can break it. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("P2-14: nothing promotes DEMO_FIXTURE evidence to LIVE", () => {
  for (const [name, source] of [["route", route], ["service", service], ["client", clientData], ["panel", intakePanel]]) {
    const code = codeOnly(source);
    // An assignment or object property that sets fixture_state to LIVE. Reading or
    // comparing it (the eligibility filter does exactly that) is legitimate; writing it
    // from application code is not — only the verified derivation RPC may decide it.
    assert.ok(
      !/fixture_state["']?\s*[:=]\s*["']LIVE["']/.test(code),
      `${name} must never assign fixture_state = LIVE`
    );
    assert.ok(!/DEMO_FIXTURE[^\n]{0,30}->[^\n]{0,30}LIVE/.test(code), `${name} must not promote fixture evidence`);
  }
});

test("P2-14 / UX-P0-01: the customer surface records LIVE, and the fixture lineage keeps its own surface", () => {
  // This assertion used to read `useState<IntakeMode>("fixture")` — it proved the panel
  // asked the PM to classify their own notes and defaulted them onto the lineage that can
  // never support an Outcome. UX-P0-01 removed the question from customer UX. What P2-14
  // actually needs to stay true is that both lineages remain wired to their own contract
  // and never merge, so that is what is asserted now.
  assert.match(intakePanel, /captureAndDeriveLiveEvidence\(/);
  assert.ok(!/captureAndDeriveDemoEvidence/.test(intakePanel), "the customer panel must not reach the fixture contract");
  assert.ok(!/useState<IntakeMode>/.test(intakePanel), "the customer panel must not offer a lineage choice");

  // The fixture contract is not deleted — it moved to the internal-only surface, and still
  // calls the same shared primitive rather than restating any canonical write.
  assert.match(fixturePanel, /captureAndDeriveDemoEvidence\(/);
  assert.match(clientData, /export async function captureAndDeriveDemoEvidence\(/);

  // Scoped ids, because the Command Center mounts responsive surfaces simultaneously.
  assert.match(intakePanel, /const uid = useId\(\);/);
});

test("P2-14: canonical intake failures map to honest client statuses, not 500", () => {
  // `intake_source_fixture_prohibited` and `*_unauthenticated` previously fell through to
  // 500, reporting a client-correctable request as a server fault.
  // Anchored to the canonical code since the repair, and answered with the shared
  // unauthorized vocabulary rather than the RPC's own text.
  assert.match(route, /const unauthenticated = \/\(\?:\^\|\[\\s:\]\)\[a-z_\]\*unauthenticated\$\/\.test\(message\);/);
  assert.match(route, /unauthenticated \? 401/);
  assert.match(route, /fixture_prohibited/);
  // A canonical idempotency conflict is still answered 409 — P2-15 moved it OFF the inline
  // status ladder into the stable conflict vocabulary, because the ladder returned the raw
  // `<rpc>: <postgres message>` string as the body. Same status, no driver text.
  assert.match(route, /const conflict = resolveOperationalFlowConflict\(message\);/);
  assert.match(route, /\{ status: 409 \}/);
  assert.ok(
    !/\{ error: message \}, \{ status: 409 \}/.test(route),
    "a conflict must never be answered with the raw RPC message"
  );
});

test("P2-14: the browser never supplies identity, authority or governance time", () => {
  const branch = route.slice(route.indexOf('if (operation === "capture_live_input")'));
  const body = branch.slice(0, branch.indexOf("\n    }"));
  for (const forbidden of ["userId", "actorId", "auth.uid", "role:", "serviceRole", "service_role"]) {
    assert.ok(!body.includes(forbidden), `live intake must not read ${forbidden} from the request body`);
  }
  // Scope comes from the server-resolved authorization, not the payload.
  assert.match(body, /authorized\.supabase, scope/);
});

test("P2-14: the only migration added is the review-repair contract hardening", () => {
  // P2-14 shipped with no migration. The independent review then proved the DATABASE-level
  // invariant was incomplete — the DEMO contract never checked the classification of the
  // Source it resolved — so exactly one forward-only hardening migration is expected, and
  // nothing else.
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql"));
  const p2_14 = migrations.filter((name) => /p2[_-]?14/i.test(name));
  assert.deepEqual(p2_14, ["20260907000000_p2_14_intake_source_classification_hardening.sql"]);
});
