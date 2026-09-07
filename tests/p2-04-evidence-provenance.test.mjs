import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/20260902000000_evidence_derivation_provenance.sql", "utf8");
const service = readFileSync("src/lib/operational-flow/operational-flow-service.ts", "utf8");
const route = readFileSync("src/app/api/operational-flow/route.ts", "utf8");
const modal = readFileSync("src/components/pmfreak/intelligence-inbox/text-capture-modal.tsx", "utf8");

test("P2-04 derives Evidence only through a verified Normalized Event command", () => {
  assert.match(migration, /derive_operational_evidence/);
  assert.match(migration, /v_event\.status <> 'accepted'/);
  assert.match(migration, /normalized_event_not_found_or_scope_mismatch/);
  assert.match(migration, /drop policy if exists evidence_items_writer_insert/);
  assert.doesNotMatch(service, /\.from\("evidence_items"\)\.insert/);
  assert.match(route, /operation === "derive_evidence"/);
  assert.doesNotMatch(route, /"create_evidence"/);
});

test("P2-04 digest and idempotency contracts reject placeholders and changed content", () => {
  assert.match(migration, /digest_algorithm = 'sha256'/);
  assert.match(migration, /canonicalization_version = 'evidence:v1'/);
  assert.match(migration, /derivation_digest <> 'sha256:' \|\| repeat\('0', 64\)/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /evidence_idempotency_conflict/);
  assert.match(migration, /unique index evidence_items_derivation_scope_key_uidx/);
});

test("P2-04 keeps classification, uncertainty, freshness and provenance explicit", () => {
  for (const value of ["FACT", "INFERENCE", "ASSUMPTION", "COMPLETE", "PARTIAL", "UNKNOWN", "CURRENT", "STALE"]) assert.match(migration, new RegExp(value));
  for (const reference of ["sourceId", "rawInputId", "normalizedEventId", "evidenceId"]) assert.match(migration, new RegExp(reference));
  assert.match(migration, /rawPayloadIncluded',false/);
  assert.match(migration, /'intelligenceRan',false/);
});

test("manual provenance UI is honest, accessible, and never auto-runs intelligence", () => {
  // Was `assert.match(modal, /DEMO \/ FIXTURE/)`. That label was ACCURATE — the modal wrote
  // the fixture lineage — so UX-P0-01 changed the contract it calls rather than the copy.
  // The provenance disclosure this test exists to protect is unchanged.
  assert.match(modal, /captureAndDeriveLiveEvidence/);
  assert.ok(!/DEMO \/ FIXTURE/.test(modal), "a customer surface must not carry fixture terminology");
  assert.match(modal, /Source to Evidence provenance chain/);
  assert.match(modal, /role="alert"/);
  assert.match(modal, /Intelligence has not run/);
  assert.match(modal, /Capture, then derive Evidence/);
  assert.doesNotMatch(modal, /run_chain/);
});
