/**
 * Project Brain activation marker (src/lib/projects/brain-activation-state.ts).
 * The end-to-end behaviour — resume, retry, partial initialization, concurrency
 * — runs against a real stack in tests/module-mocks/project-brain-activation-live.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BRAIN_ACTIVATION_KEY,
  composeActivationPayload,
  normalizeActivationRequestId,
  readBrainActivation,
} from "../src/lib/projects/brain-activation-state.ts";

const marker = { requestId: "act_123e4567-e89b-42d3-a456-426614174000", startedAt: "2026-10-11T18:00:00.000Z", setupContextCompletedAt: null, briefCompletedAt: null, completedAt: null };
const spanish = {
  identity: { projectName: "Lanzamiento de listalaboda.com", pmAssigned: "Víctor Valverde" },
  deliveryContext: { problemStatement: "Las parejas no tienen una forma sencilla de compartir su lista de bodas — ¿cómo lo resolvemos?" },
  discovery: { financialBlockers: "Presupuesto pendiente de aprobación (año fiscal 2026)" },
};

test("activation key: accepts the wizard's shape, rejects anything else", () => {
  assert.equal(normalizeActivationRequestId(marker.requestId), marker.requestId);
  assert.equal(normalizeActivationRequestId(`  ${marker.requestId}  `), marker.requestId);
  for (const bad of [null, undefined, 42, "", "short", "has space inside it", "x".repeat(101), "act_<script>", "act_123'; drop"]) {
    assert.equal(normalizeActivationRequestId(bad), null, String(bad));
  }
});

test("composeActivationPayload keeps the submitted (Spanish) content byte-for-byte and adds the server marker", () => {
  const out = composeActivationPayload(spanish, marker);
  const { [BRAIN_ACTIVATION_KEY]: m, ...content } = out;
  assert.deepEqual(content, spanish);
  assert.deepEqual(m, marker);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(out)).identity), JSON.stringify(spanish.identity));
});

test("a client-supplied brainActivation key is discarded, never trusted", () => {
  const forged = { ...spanish, [BRAIN_ACTIVATION_KEY]: { requestId: "act_forged-forged-forged", startedAt: "2020-01-01T00:00:00Z", completedAt: "2020-01-01T00:00:00Z" } };
  assert.deepEqual(composeActivationPayload(forged, marker)[BRAIN_ACTIVATION_KEY], marker);
});

test("server-owned keys already on the row (initialIngestion) survive a resume; client copies of them do not win", () => {
  const existing = { ...spanish, initialIngestion: { status: "completed", updatedAt: "2026-10-11T19:00:00Z" }, [BRAIN_ACTIVATION_KEY]: marker };
  const resubmitted = { ...spanish, initialIngestion: { status: "not_started" } };
  const out = composeActivationPayload(resubmitted, marker, existing);
  assert.deepEqual(out.initialIngestion, existing.initialIngestion);
});

test("readBrainActivation narrows untrusted payloads and fails safe to null", () => {
  assert.deepEqual(readBrainActivation({ [BRAIN_ACTIVATION_KEY]: marker }), marker);
  assert.deepEqual(readBrainActivation({ [BRAIN_ACTIVATION_KEY]: { ...marker, briefCompletedAt: "not a date" } }).briefCompletedAt, null);
  for (const bad of [null, "x", 1, {}, { [BRAIN_ACTIVATION_KEY]: "x" }, { [BRAIN_ACTIVATION_KEY]: { requestId: "bad id", startedAt: marker.startedAt } }, { [BRAIN_ACTIVATION_KEY]: { requestId: marker.requestId } }]) {
    assert.equal(readBrainActivation(bad), null);
  }
});

test("wizard: one activation key per draft — reused by every retry, cleared only with the draft on success, reset for a new project", async () => {
  const { readFileSync } = await import("node:fs");
  const wizard = readFileSync("src/components/pmfreak/projects/create-project-wizard.tsx", "utf8");
  assert.match(wizard, /activationRequestIdRef\.current \?\?= getActivationRequestId\(\);/, "retries in the same page reuse the key");
  assert.match(wizard, /localStorage\.getItem\(ACTIVATION_KEY\)/, "a reload reuses the stored key");
  const success = wizard.indexOf("clearDraft();\n    clearActivationRequestId();");
  const failureReturn = wizard.indexOf('if (result.status !== "success")');
  assert.ok(success > failureReturn && failureReturn > 0, "the key is cleared only after a confirmed success");
  assert.match(wizard, /if \(!loadDraft\(\)\) clearActivationRequestId\(\);/, "no draft = a new project = a new key");
  assert.match(wizard, /const DRAFT_KEY = "pmfreak\.project\.draft";/, "the draft's storage key and shape are unchanged");
});
