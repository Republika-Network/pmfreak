import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const migration = fs.readFileSync("supabase/migrations/20260602010000_vault_intake_reliability.sql", "utf8");
const types = fs.readFileSync("src/lib/vault/intake/types.ts", "utf8");
const storage = fs.readFileSync("src/lib/vault/intake/storage.ts", "utf8");
const pipeline = fs.readFileSync("src/lib/vault/intake/pipeline.ts", "utf8");
const extraction = fs.readFileSync("src/lib/vault/intake/signal-extraction.ts", "utf8");
const route = fs.readFileSync("src/app/api/vault/intake/route.ts", "utf8");
const vaultIntakePanel = fs.readFileSync("src/modules/workspace/presentation/command-center/vault-intake-panel.tsx", "utf8");

const runtimeProbe = String.raw`
import assert from "node:assert/strict";
import { ingestVaultDocument, extractVaultOperationalSignals, normalizeVaultContent, classifyVaultDocument } from "./src/lib/vault/intake/index.ts";
const makeStore = (overrides = {}) => {
  const calls = { documents: [], signals: [], statuses: [], synthesis: [] };
  return { calls, store: {
    async persistDocument(document) { calls.documents.push(document); return { ok: true }; },
    async persistSignals(signals) { calls.signals.push(...signals); return { ok: true }; },
    async updateDocumentStatus(documentId, status) { calls.statuses.push({ documentId, status }); return { ok: true }; },
    async triggerExecutiveSynthesisUpdate(input) { calls.synthesis.push(input); return { ok: true }; },
    ...overrides,
  } };
};
const baseInput = (store) => ({
  workspaceId: "00000000-0000-0000-0000-000000000001",
  projectId: "00000000-0000-0000-0000-000000000002",
  rawContent: "El proveedor no entregará el firewall hasta el 15 de julio. Carlos actualizará el cronograma. La instalación depende del acceso al sitio. Se aprobó el plan de mitigación.",
  createdBy: "00000000-0000-0000-0000-000000000003",
  now: "2026-06-02T00:00:00.000Z",
  idFactory: (() => { let i = 0; return () => "00000000-0000-0000-0000-" + String(++i).padStart(12, "0"); })(),
  store,
});
const extractionFor = (text) => extractVaultOperationalSignals({ documentId: "d", workspaceId: "w", projectId: "p", normalizedContent: normalizeVaultContent(text), createdAt: "now", idFactory: () => crypto.randomUUID() });
(async () => {
const { calls, store } = makeStore();
const result = await ingestVaultDocument(baseInput(store));
let j = 0;
const extractionFailureStore = makeStore();
const extractionFailure = await ingestVaultDocument({ ...baseInput(extractionFailureStore.store), idFactory: () => { j += 1; if (j > 1) throw new Error("synthetic signal extraction failure"); return "00000000-0000-0000-0000-000000000001"; } });
const persistenceFailureStore = makeStore({ async persistDocument() { return { ok: false, error: "db_down" }; } });
const persistenceFailure = await ingestVaultDocument(baseInput(persistenceFailureStore.store));
const payload = {
  documentPersisted: calls.documents.length,
  normalizedContent: calls.documents[0].normalizedContent,
  signalsPersisted: calls.signals.length,
  result,
  risk: extractionFor("Hay atraso y blocked dependency waiting on vendor.").map((s) => s.signalType),
  issue: extractionFor("Hay una falla y un problema de outage.").map((s) => s.signalType),
  dependency: extractionFor("La instalación depende del acceso and requires site approval.").map((s) => s.signalType),
  actionCount: extractionFor("Carlos hará la actualización. Juan actualizará el cronograma. Se acuerda enviar minuta. Assigned to Carlos. Assigned to Juan. Owner: Victor. Victor will review. Carlos will update.").filter((s) => s.signalType === "action").length,
  decisionCount: extractionFor("Se aprobó el cambio. Se decidió continuar. Approved by sponsor.").filter((s) => s.signalType === "decision").length,
  classification: classifyVaultDocument("Firewall technical issue with sponsor approval and budget payment"),
  extractionFailure: { result: extractionFailure, documents: extractionFailureStore.calls.documents.length, signals: extractionFailureStore.calls.signals.length, statuses: extractionFailureStore.calls.statuses },
  persistenceFailure,
  synthesisCalls: calls.synthesis.length,
};
assert.equal(payload.result.ingestionStatus, "completed");
console.log(JSON.stringify(payload));
})();
`;

const runtime = JSON.parse(execFileSync("npx", ["tsx", "--eval", runtimeProbe], { encoding: "utf8" }).trim().split("\n").at(-1));

test("document persistence contract exists with RLS, indexes and foreign keys", () => {
  assert.match(migration, /create table if not exists public\.vault_documents/);
  assert.match(migration, /workspace_id uuid not null references public\.workspaces\(id\) on delete cascade/);
  assert.match(migration, /project_id uuid null references public\.projects\(id\) on delete set null/);
  assert.match(migration, /created_by uuid null references auth\.users\(id\) on delete set null/);
  assert.match(migration, /alter table public\.vault_documents enable row level security/);
  assert.match(migration, /vault_documents_workspace_created_idx/);
  assert.match(storage, /from\("vault_documents"\)\.insert/);
});

test("signal persistence contract exists", () => {
  assert.match(migration, /create table if not exists public\.vault_operational_signals/);
  assert.match(migration, /signal_type text not null check \(signal_type in \('risk', 'issue', 'dependency', 'action', 'decision'\)\)/);
  assert.match(migration, /document_id uuid not null references public\.vault_documents\(id\) on delete cascade/);
  assert.match(migration, /vault_operational_signals_workspace_type_idx/);
  assert.match(storage, /from\("vault_operational_signals"\)\.insert/);
});

test("VaultDocument and VaultIngestionResult canonical types exist", () => {
  for (const field of ["id", "workspaceId", "projectId", "title", "sourceType", "rawContent", "normalizedContent", "createdAt", "createdBy", "ingestionStatus", "classification"]) {
    assert.match(types, new RegExp(`${field}:`));
  }
  for (const field of ["documentId", "risksDetected", "issuesDetected", "dependenciesDetected", "actionsDetected", "decisionsDetected", "confidenceScore", "ingestionSummary"]) {
    assert.match(types, new RegExp(`${field}:`));
  }
});

test("document persistence happens before extraction and signal persistence", () => {
  assert.equal(runtime.result.ingestionStatus, "completed");
  assert.equal(runtime.documentPersisted, 1);
  assert.ok(runtime.normalizedContent.includes("Carlos actualizará"));
  assert.ok(runtime.signalsPersisted >= 3);
});

test("risk extraction detects delay/blocker/dependency language", () => {
  assert.ok(runtime.risk.includes("risk"));
});

test("issue extraction detects defects/problems/outages", () => {
  assert.ok(runtime.issue.includes("issue"));
});

test("dependency extraction detects depende/dependency/requires", () => {
  assert.ok(runtime.dependency.includes("dependency"));
});

test("action extraction detects owner commitments", () => {
  assert.ok(runtime.actionCount >= 8);
});

test("decision extraction detects approvals and decisions", () => {
  assert.ok(runtime.decisionCount >= 3);
});

test("mixed document returns counts and classification assignment", () => {
  assert.ok(runtime.result.risksDetected >= 1);
  assert.ok(runtime.result.dependenciesDetected >= 1);
  assert.ok(runtime.result.actionsDetected >= 1);
  assert.ok(runtime.result.decisionsDetected >= 1);
  assert.equal(runtime.result.classification, "mixed");
  assert.equal(runtime.classification, "mixed");
});

test("ingestion summary matches success criteria", () => {
  assert.match(runtime.result.ingestionSummary, /Meeting captured\./);
  assert.match(runtime.result.ingestionSummary, /Risks detected\./);
  assert.match(runtime.result.ingestionSummary, /Dependency detected\./);
  assert.match(runtime.result.ingestionSummary, /Action Items detected\./);
  assert.match(runtime.result.ingestionSummary, /Executive synthesis updated\./);
});

test("extraction failure fallback keeps document stored", () => {
  assert.equal(runtime.extractionFailure.documents, 1);
  assert.equal(runtime.extractionFailure.result.ingestionStatus, "extraction_failed");
  assert.equal(runtime.extractionFailure.signals, 0);
  assert.ok(runtime.extractionFailure.statuses.some((s) => s.status === "extraction_failed"));
  assert.match(pipeline, /persistDocument/);
});

test("persistence failure handling stops extraction because evidence was not stored", () => {
  assert.equal(runtime.persistenceFailure.ingestionStatus, "document_persistence_failed");
  assert.equal(runtime.persistenceFailure.documentId, "00000000-0000-0000-0000-000000000001");
  assert.deepEqual(runtime.persistenceFailure.errors, ["db_down"]);
});

test("explicit document-ingestion pipeline invokes executive synthesis and remains API-wired", () => {
  assert.equal(runtime.result.executiveSynthesisUpdated, true);
  assert.equal(runtime.synthesisCalls, 1);
  assert.match(storage, /triggerExecutiveSynthesisUpdate/);
  assert.match(storage, /operational_memory_runtime_records/);
  assert.match(route, /ingestVaultDocument/);
});

test("manual P2-04 intake derives Evidence without invoking executive synthesis", () => {
  assert.match(vaultIntakePanel, /Capture and derive Evidence/);
  // Was `captureAndDeriveDemoEvidence`. The lineage changed with UX-P0-01; the property this
  // test guards did not — manual intake still derives Evidence through the canonical
  // two-transition path and still runs no synthesis.
  assert.match(vaultIntakePanel, /captureAndDeriveLiveEvidence/);
  assert.match(vaultIntakePanel, /Intelligence has not run\./);
  assert.doesNotMatch(vaultIntakePanel, /Analyze notes/i);
  assert.doesNotMatch(vaultIntakePanel, /postVaultIntake/);
  assert.doesNotMatch(
    vaultIntakePanel,
    /triggerExecutiveSynthesisUpdate|executiveSynthesisUpdated/,
  );
});

test("source enums include all canonical source types", () => {
  for (const sourceType of ["meeting_notes", "transcript", "email", "project_update", "risk_log", "issue_log", "action_log", "decision_log", "generic_note"]) {
    assert.match(types, new RegExp(`"${sourceType}"`));
    assert.match(migration, new RegExp(`'${sourceType}'`));
  }
  assert.match(extraction, /SIGNAL_PATTERNS/);
});
