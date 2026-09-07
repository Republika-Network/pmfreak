import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const migration = fs.readFileSync("supabase/migrations/20260602020000_raid_auto_extraction.sql", "utf8");
const raidTypes = fs.readFileSync("src/lib/raid/types.ts", "utf8");
const raidEngine = fs.readFileSync("src/lib/raid/extraction.ts", "utf8");
const raidStorage = fs.readFileSync("src/lib/raid/storage.ts", "utf8");
const raidIndex = fs.readFileSync("src/lib/raid/index.ts", "utf8");
const vaultPipeline = fs.readFileSync("src/lib/vault/intake/pipeline.ts", "utf8");
const vaultStorage = fs.readFileSync("src/lib/vault/intake/storage.ts", "utf8");
const briefTypes = fs.readFileSync("src/lib/projects/first-insight/operational-governance-brief-types.ts", "utf8");
const briefEngine = fs.readFileSync("src/lib/projects/first-insight/operational-governance-brief-engine.ts", "utf8");
const briefOrchestrator = fs.readFileSync("src/lib/projects/first-insight/operational-governance-brief-orchestrator.ts", "utf8");
const commandCenter = fs.readFileSync("src/modules/workspace/screens/command-center/command-center-client.tsx", "utf8");
const vaultIntakePanel = fs.readFileSync("src/modules/workspace/presentation/command-center/vault-intake-panel.tsx", "utf8");

const runtimeProbe = String.raw`
import assert from "node:assert/strict";
import { ingestVaultDocument, normalizeVaultContent, extractVaultOperationalSignals } from "./src/lib/vault/intake/index.ts";
import { buildRaidOverview, calculateProjectRaidHealth, canonicalRaidFingerprint, detectRaidDueDate, detectRaidOwner, extractRaidItems } from "./src/lib/raid/index.ts";
import { generateOperationalGovernanceBrief } from "./src/lib/projects/first-insight/index.ts";

(async () => {
const ids = (() => { let i = 0; return () => "00000000-0000-0000-0000-" + String(++i).padStart(12, "0"); })();
const now = "2026-06-02T00:00:00.000Z";
const document = {
  id: ids(),
  workspaceId: "00000000-0000-0000-0000-000000000101",
  projectId: "00000000-0000-0000-0000-000000000202",
  title: "Firewall meeting",
  sourceType: "meeting_notes",
  rawContent: "El proveedor no entregará el firewall hasta el 15 de julio. Firewall delivery has an issue and uncertainty. Carlos actualizará el cronograma by Friday. La instalación depende del acceso al sitio. Se asume disponibilidad del equipo la próxima semana. Expected delivery is planned under vendor availability. Se aprobó continuar.",
  normalizedContent: "",
  createdAt: now,
  createdBy: "00000000-0000-0000-0000-000000000303",
  ingestionStatus: "document_persisted",
  classification: "mixed",
};
document.normalizedContent = normalizeVaultContent(document.rawContent);
const signals = extractVaultOperationalSignals({ documentId: document.id, workspaceId: document.workspaceId, projectId: document.projectId, normalizedContent: document.normalizedContent, createdAt: now, idFactory: ids });
const raidItems = extractRaidItems({ document, signals, idFactory: ids });
const risk = raidItems.find((item) => item.category === "risk");
const issue = raidItems.find((item) => item.category === "issue");
const dependency = raidItems.find((item) => item.category === "dependency");
const assumption = raidItems.find((item) => item.category === "assumption");
assert.ok(risk, "risk item is created from risk signal");
assert.ok(issue, "issue item is created from issue signal");
assert.ok(dependency, "dependency item is created from dependency signal");
assert.ok(assumption, "assumption item is created from assumption phrase");
assert.equal(detectRaidOwner("Juan revisará el plan"), "Juan");
assert.equal(detectRaidOwner("Carlos will update the timeline"), "Carlos");
assert.equal(detectRaidOwner("Owner: Victor"), "Victor");
assert.equal(detectRaidDueDate("entrega hasta el 15 de julio", now), "2026-07-15");
assert.equal(detectRaidDueDate("Expected delivery on July 15", now), "2026-07-15");
assert.equal(detectRaidDueDate("expected delivery next week", now), "2026-06-09");
assert.equal(detectRaidDueDate("Carlos will review by Friday", now), "2026-06-05");
assert.equal(canonicalRaidFingerprint("risk", "The vendor delivery delay!"), canonicalRaidFingerprint("risk", "Vendor delivery delay"));
assert.ok(risk.confidenceScore >= 60 && risk.confidenceScore <= 100);
const health = calculateProjectRaidHealth(raidItems);
const overview = buildRaidOverview(raidItems);
const brief = generateOperationalGovernanceBrief({ workspaceId: document.workspaceId, projectId: document.projectId, detectedRaidOverview: { topRisks: overview.topRisks, topIssues: overview.topIssues, keyDependencies: overview.keyDependencies, keyAssumptions: overview.keyAssumptions, snapshot: overview.snapshot, healthScore: overview.health.healthScore } });
assert.ok(brief.detectedRaidOverview.snapshot.risks >= 1);
assert.ok(brief.sourceSummary.signalsEvaluated.includes("detected_raid_overview"));

const calls = { documents: [], signals: [], raidCreated: [], raidUpdated: [], statuses: [], synthesis: [] };
const seen = new Map();
const store = {
  async persistDocument(doc) { calls.documents.push(doc); return { ok: true }; },
  async persistSignals(items) { calls.signals.push(...items); return { ok: true }; },
  async updateDocumentStatus(documentId, status) { calls.statuses.push({ documentId, status }); return { ok: true }; },
  async persistRaidItems(items) {
    const created = [];
    const updated = [];
    for (const item of items) {
      const key = item.fingerprint;
      if (seen.has(key)) {
        const previous = seen.get(key);
        const next = { ...previous, occurrenceCount: previous.occurrenceCount + 1, confidenceScore: Math.min(100, previous.confidenceScore + 4), lastDetectedAt: item.detectedAt };
        seen.set(key, next);
        updated.push(next);
      } else {
        seen.set(key, item);
        created.push(item);
      }
    }
    calls.raidCreated.push(...created);
    calls.raidUpdated.push(...updated);
    return { ok: true, created, updated };
  },
  async triggerExecutiveSynthesisUpdate(input) { calls.synthesis.push(input); return { ok: true }; },
};
const input = { workspaceId: document.workspaceId, companyId: "company-1", projectId: document.projectId, rawContent: document.rawContent, createdBy: document.createdBy, now, sourceType: "meeting_notes", store, idFactory: ids };
const first = await ingestVaultDocument(input);
const second = await ingestVaultDocument({ ...input, rawContent: document.rawContent, idFactory: ids });
assert.equal(first.ingestionStatus, "completed");
assert.equal(first.raidSnapshot.risks >= 1, true);
assert.equal(first.raidItemsCreated > 0, true);
assert.equal(second.raidItemsUpdated > 0, true);
assert.equal(calls.synthesis.at(-1).raidItems.length > 0, true);
const payload = { categories: raidItems.map((i) => i.category), risk, issue, dependency, assumption, ownerSpanish: detectRaidOwner("Juan revisará el plan"), ownerEnglish: detectRaidOwner("Assigned to Carlos"), dueSpanish: detectRaidDueDate("entrega hasta el 15 de julio", now), dueEnglish: detectRaidDueDate("July 15", now), dueNextWeek: detectRaidDueDate("next week", now), dueWeekday: detectRaidDueDate("Friday", now), fingerprintA: canonicalRaidFingerprint("risk", "The vendor delivery delay!"), fingerprintB: canonicalRaidFingerprint("risk", "Vendor delivery delay"), health, overview, first, second, synthesisRaidCount: calls.synthesis.at(-1).raidItems.length, synthesisRaidItems: calls.synthesis.at(-1).raidItems };
console.log(JSON.stringify(payload));
})();
`;

const runtime = JSON.parse(execFileSync("npx", ["tsx", "--eval", runtimeProbe], { encoding: "utf8" }).trim().split("\n").at(-1));

test("migration creates raid_items", () => {
  assert.match(migration, /create table if not exists public\.raid_items/);
});

test("migration has RAID foreign keys", () => {
  assert.match(migration, /workspace_id uuid not null references public\.workspaces\(id\) on delete cascade/);
  assert.match(migration, /project_id uuid null references public\.projects\(id\) on delete cascade/);
  assert.match(migration, /source_document_id uuid not null references public\.vault_documents\(id\) on delete cascade/);
  assert.match(migration, /source_signal_id uuid null references public\.vault_operational_signals\(id\) on delete set null/);
});

test("migration has RLS policies", () => {
  assert.match(migration, /alter table public\.raid_items enable row level security/);
  assert.match(migration, /workspace members can read raid_items/);
  assert.match(migration, /workspace members can insert raid_items/);
  assert.match(migration, /workspace members can update raid_items/);
  assert.match(migration, /public\.is_workspace_member\(workspace_id\)/);
});

test("migration does not use CREATE POLICY IF NOT EXISTS", () => {
  assert.doesNotMatch(migration, /create policy if not exists/i);
});

test("canonical RAID types exist", () => {
  for (const field of ["workspaceId", "projectId", "sourceDocumentId", "sourceSignalId", "category", "status", "confidenceScore", "detectedAt", "lastDetectedAt", "owner", "dueDate", "autoGenerated", "fingerprint", "occurrenceCount"]) {
    assert.match(raidTypes, new RegExp(`${field}:`));
  }
  assert.match(raidIndex, /persistRaidItems/);
});

test("extract risk item from signal", () => {
  assert.ok(runtime.categories.includes("risk"));
  assert.equal(runtime.risk.category, "risk");
});

test("extract issue item from signal", () => {
  assert.ok(runtime.categories.includes("issue"));
  assert.equal(runtime.issue.category, "issue");
});

test("extract dependency item from signal", () => {
  assert.ok(runtime.categories.includes("dependency"));
  assert.equal(runtime.dependency.category, "dependency");
});

test("extract assumption from document content", () => {
  assert.ok(runtime.categories.includes("assumption"));
  assert.equal(runtime.assumption.category, "assumption");
});

test("owner detection Spanish", () => {
  assert.equal(runtime.ownerSpanish, "Juan");
});

test("owner detection English", () => {
  assert.equal(runtime.ownerEnglish, "Carlos");
});

test("due date Spanish", () => {
  assert.equal(runtime.dueSpanish, "2026-07-15");
});

test("due date English", () => {
  assert.equal(runtime.dueEnglish, "2026-07-15");
});

test("next week detection", () => {
  assert.equal(runtime.dueNextWeek, "2026-06-09");
});

test("weekday detection", () => {
  assert.equal(runtime.dueWeekday, "2026-06-05");
});

test("fingerprint normalization", () => {
  assert.equal(runtime.fingerprintA, runtime.fingerprintB);
});

test("duplicate prevention increments occurrence", () => {
  assert.ok(runtime.first.raidItemsCreated > 0);
  assert.ok(runtime.second.raidItemsUpdated > 0);
  assert.match(raidStorage, /occurrence_count: occurrenceCount/);
});

test("confidence scoring 0–100", () => {
  assert.ok(runtime.risk.confidenceScore >= 0 && runtime.risk.confidenceScore <= 100);
  assert.match(raidEngine, /Math\.max\(0, Math\.min\(100/);
});

test("project raid health score", () => {
  assert.ok(runtime.health.riskCount >= 1);
  assert.ok(runtime.health.issueCount >= 1);
  assert.ok(runtime.health.dependencyCount >= 1);
  assert.ok(runtime.health.assumptionCount >= 1);
  assert.ok(runtime.health.healthScore < 100);
});

test("raid overview", () => {
  assert.ok(runtime.overview.topRisks.length >= 1);
  assert.ok(runtime.overview.topIssues.length >= 1);
  assert.ok(runtime.overview.keyDependencies.length >= 1);
  assert.ok(runtime.overview.keyAssumptions.length >= 1);
});

test("vault pipeline calls extractRaidItems", () => {
  assert.match(vaultPipeline, /extractRaidItems/);
  assert.match(vaultStorage, /persistRaidItemsInSupabase/);
});

test("vault pipeline returns raidItemsCreated and raidItemsUpdated", () => {
  assert.ok(runtime.first.raidItemsCreated > 0);
  assert.ok(runtime.second.raidItemsUpdated > 0);
  assert.match(vaultPipeline, /raidItemsCreated/);
  assert.match(vaultPipeline, /raidItemsUpdated/);
});

test("executive synthesis feed includes raid items", () => {
  assert.ok(runtime.synthesisRaidCount > 0);
  assert.match(vaultStorage, /\[RAID:\$\{item\.category\}\]/);
  assert.match(vaultStorage, /source_ref: `raid_item:\$\{item\.id\}`/);
  assert.equal(runtime.first.executiveSynthesisUpdated, true);
});

test("first insight includes DetectedRaidOverview", () => {
  assert.match(briefTypes, /DetectedRaidOverview/);
  assert.match(briefEngine, /detectedRaidOverview/);
  assert.match(briefOrchestrator, /raid_items/);
});

test("Command Center surfaces RAID from the explicit vault pipeline", () => {
  assert.match(commandCenter, /void retryBrief\(\)/);
  assert.match(commandCenter, /onEvidenceAdded/);
  assert.match(commandCenter, /detectedRaidOverview\.snapshot\.issues/);
});

test("manual P2-04 vault intake derives Evidence without automatic RAID extraction", () => {
  // Was `captureAndDeriveDemoEvidence`; UX-P0-01 moved the customer surface onto the LIVE
  // contract. The property under test is unchanged: intake derives Evidence and does not
  // trigger RAID extraction.
  assert.match(vaultIntakePanel, /captureAndDeriveLiveEvidence/);
  assert.match(vaultIntakePanel, /Intelligence has not run\./);
  assert.doesNotMatch(vaultIntakePanel, /raidSnapshot/);
  assert.doesNotMatch(vaultIntakePanel, /postVaultIntake/);
  assert.doesNotMatch(
    vaultIntakePanel,
    /extractRaidItems|triggerExecutiveSynthesisUpdate/,
  );
});
