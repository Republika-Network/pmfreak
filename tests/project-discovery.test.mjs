import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const migration = fs.readFileSync('supabase/migrations/20260605020000_project_discovery.sql', 'utf8');
const payloadHashMigration = fs.readFileSync('supabase/migrations/20260605030000_project_discovery_payload_hash.sql', 'utf8');
const agent = fs.readFileSync('src/lib/project-discovery/discovery-agent.ts', 'utf8');
const repository = fs.readFileSync('src/lib/project-discovery/discovery-repository.ts', 'utf8');
const route = fs.readFileSync('src/app/api/project-discovery/route.ts', 'utf8');
const processor = fs.readFileSync('src/lib/project-evidence/evidence-processor.ts', 'utf8');
const shell = fs.readFileSync('src/components/pmfreak/operational-shell.tsx', 'utf8');

test('project_discovery migration creates versioned traceable discovery table', () => {
  assert.match(migration, /create table if not exists public\.project_discovery/);
  for (const column of ['id', 'project_id', 'workspace_id', 'version', 'stakeholders_json', 'dependencies_json', 'risks_json', 'milestones_json', 'deliverables_json', 'assumptions_json', 'unknowns_json', 'confidence_score', 'evidence_count', 'generated_at', 'created_at', 'updated_at']) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration, /unique\(project_id, version\)/);
  assert.match(migration, /confidence_score >= 0 and confidence_score <= 100/);
  assert.match(migration, /alter table public\.project_discovery enable row level security/);
  assert.match(migration, /public\.is_workspace_member\(workspace_id\)/);
});

test('project_discovery payload hash migration adds deduplication hash and lookup index', () => {
  assert.match(payloadHashMigration, /add column if not exists discovery_payload_hash text/);
  assert.match(payloadHashMigration, /create index if not exists project_discovery_project_payload_hash_idx/);
  assert.match(payloadHashMigration, /on public\.project_discovery\(project_id, discovery_payload_hash\)/);
});

test('discovery agent focuses on operational execution signals with evidence traceability', () => {
  for (const signal of ['stakeholders', 'dependencies', 'risks', 'milestones', 'deliverables', 'assumptions', 'unknowns']) {
    assert.match(agent, new RegExp(signal));
  }
  assert.match(agent, /PROJECT_DISCOVERY_AGENT_SYSTEM_PROMPT/);
  assert.match(agent, /Your objective is not to summarize/);
  assert.match(agent, /evidence_id/);
  assert.match(agent, /source_file_name/);
  assert.match(agent, /confidence_score/);
  assert.match(agent, /generateProjectDiscovery/);
});

test('discovery repository persists new versions and logs lifecycle events', () => {
  assert.match(repository, /regenerateProjectDiscovery/);
  assert.match(repository, /from\("project_evidence_content"\)/);
  assert.match(repository, /from\("project_discovery"\)/);
  assert.match(repository, /latestVersion \+ 1/);
  assert.match(repository, /discovery_payload_hash/);
  assert.match(repository, /hashDiscoveryPayload/);
  assert.match(repository, /Discovery Started/);
  assert.match(repository, /Discovery Completed/);
  assert.match(repository, /Discovery Failed/);
  assert.match(repository, /findingsCount/);
  assert.match(repository, /durationMs/);
});

test('discovery resolves the tenant from projects, never from an evidence row (F22-A)', () => {
  // A member of another workspace could store evidence against this project id before
  // 20261025000000; legacy rows may still exist. The privileged regeneration must scope every
  // read by the project's own workspace.
  const body = repository.slice(repository.indexOf('export async function regenerateProjectDiscovery'));
  // PD-25 added `status` to this read (an archived project derives no new discovery).
  assert.match(body, /from\("projects"\)\s*\.select\("id,workspace_id(,status)?"\)\s*\.eq\("id", input\.projectId\)/);
  assert.match(body, /const workspaceId = project\.workspace_id;/);
  assert.match(body, /from\("project_evidence_content"\)[\s\S]*?\.eq\("project_id", input\.projectId\)\s*\.eq\("workspace_id", workspaceId\)/);
  assert.match(body, /from\("project_discovery"\)[\s\S]*?\.eq\("workspace_id", workspaceId\)/);
  assert.doesNotMatch(body, /typedEvidence\[0\]\.workspace_id|evidenceRows\?\.\[0\]\??\.workspace_id/);
  assert.ok(body.indexOf('from("projects")') < body.indexOf('from("project_evidence_content")'), 'workspace is resolved before evidence is read');
});

test('project discovery API returns latest discovery with project read authorization', () => {
  assert.match(route, /export async function GET/);
  assert.match(route, /requireProjectAccess\(projectId, "read"\)/);
  assert.match(route, /from\("project_discovery"\)/);
  assert.match(route, /order\("version", \{ ascending: false \}\)/);
  assert.match(route, /discovery_payload_hash/);
  assert.match(route, /maybeSingle\(\)/);
});

test('canonical evidence processing triggers discovery regeneration', () => {
  assert.match(processor, /regenerateProjectDiscoveryInBackground/);
  assert.match(processor, /projectId: source\.project_id/);
});

test('operational shell displays discovery summary card counts and confidence', () => {
  assert.match(shell, /Discovery Summary/);
  assert.match(shell, /project-discovery/);
  for (const label of ['Stakeholders:', 'Dependencies:', 'Risks:', 'Milestones:', 'Deliverables:', 'Unknowns:', 'Discovery Confidence:']) {
    assert.match(shell, new RegExp(label));
  }
});


test('first project discovery regeneration inserts v1 with a payload hash', () => {
  assert.match(repository, /const latestVersion = Number\(latestDiscovery\?\.version \?\? 0\)/);
  assert.match(repository, /const nextVersion = latestVersion \+ 1/);
  assert.match(repository, /version: nextVersion/);
  assert.match(repository, /discovery_payload_hash: discoveryPayloadHash/);
});

test('identical project discovery regeneration skips inserting v2', () => {
  assert.match(repository, /latestDiscovery\?\.discovery_payload_hash === discoveryPayloadHash/);
  assert.match(repository, /skipped: true/);
  assert.match(repository, /reason: "unchanged_payload"/);
  assert.match(repository, /return latestDiscovery/);
});

test('changed project discovery payload continues versioning by inserting v2', () => {
  assert.match(repository, /generateProjectDiscovery\(typedEvidence\)/);
  assert.match(repository, /const discoveryPayloadHash = hashDiscoveryPayload\(discovery\)/);
  assert.match(repository, /const nextVersion = latestVersion \+ 1/);
  assert.match(repository, /\.insert\(\{[\s\S]*version: nextVersion[\s\S]*discovery_payload_hash: discoveryPayloadHash[\s\S]*\}\)/);
});

test('project discovery payload hash is deterministic despite object key ordering', () => {
  assert.match(repository, /Object\.keys\(value\)\s*\n\s*\.sort\(\)/);
  assert.match(repository, /deterministicDiscoveryPayloadStringify/);
  assert.match(repository, /createHash\("sha256"\)/);
  assert.doesNotMatch(repository, /JSON\.stringify\(buildDiscoveryPayload\(discovery\)\)/);
});

const materializer = fs.readFileSync('src/lib/project-discovery/raid-materialization.ts', 'utf8');

const materializationProbe = `
import { materializeProjectDiscoveryRaidItems } from './src/lib/project-discovery/raid-materialization.ts';

(async () => {
const source = { evidence_id: '11111111-1111-4111-8111-111111111111', source_file_name: 'discovery.md', confidence: 82 };
const baseDiscovery = {
  stakeholders: [],
  dependencies: [{ dependency: 'Client VPN access must be approved before integration testing.', type: 'technical', confidence: 81, evidence_source: source }],
  risks: [{ risk: 'Vendor delivery delay may push the launch milestone.', category: 'schedule', confidence: 84, evidence_source: source }],
  milestones: [],
  deliverables: [],
  assumptions: [{ assumption: 'Assuming the security team is available for review.', confidence: 72, evidence_source: source }],
  unknowns: [{ unknown: 'Data migration owner is not confirmed.', severity: 'high', confidence: 79, evidence_source: source }],
  confidence_score: 79,
  evidence_count: 1,
};
const emptyDiscovery = { ...baseDiscovery, dependencies: [], risks: [], assumptions: [], unknowns: [], confidence_score: 0 };

function createSupabase(existingRows = [], existingVaultDocs = []) {
  const state = { vaultDocuments: existingVaultDocs.map((row) => ({ ...row })), raidItems: existingRows.map((row) => ({ ...row })), updates: [] };
  const matchRow = (rows, filters) => rows.find((row) => filters.every(([key, value]) => row[key] === value));
  const table = (name) => ({
    insert(payload) {
      if (name === 'vault_documents') {
        const row = { id: '22222222-2222-4222-8222-' + String(state.vaultDocuments.length + 1).padStart(12, '0'), ...payload };
        state.vaultDocuments.push(row);
        return { select: () => ({ single: async () => ({ data: { id: row.id }, error: null }) }) };
      }
      if (name === 'raid_items') {
        state.raidItems.push({ ...payload });
        return Promise.resolve({ error: null });
      }
      throw new Error('unexpected insert ' + name);
    },
    select() {
      const filters = [];
      return {
        eq(key, value) { filters.push([key, value]); return this; },
        limit() { return this; },
        async maybeSingle() {
          if (name === 'vault_documents') return { data: matchRow(state.vaultDocuments, filters) ?? null, error: null };
          return { data: matchRow(state.raidItems, filters) ?? null, error: null };
        },
      };
    },
    update(payload) {
      return {
        async eq(key, value) {
          const row = state.raidItems.find((item) => item[key] === value);
          if (row) Object.assign(row, payload);
          state.updates.push({ key, value, payload });
          return { error: null };
        },
      };
    },
  });
  return { state, client: { from: table } };
}

const first = createSupabase();
const firstResult = await materializeProjectDiscoveryRaidItems({ discovery: baseDiscovery, discoveryId: 'disc-1', discoveryVersion: 1, workspaceId: 'workspace-1', projectId: 'project-1', supabase: first.client });

// Same discovery context (same discoveryId, version, payload) — should reuse the vault document
const sameCtx = createSupabase(first.state.raidItems, first.state.vaultDocuments);
const sameCtxResult = await materializeProjectDiscoveryRaidItems({ discovery: baseDiscovery, discoveryId: 'disc-1', discoveryVersion: 1, workspaceId: 'workspace-1', projectId: 'project-1', supabase: sameCtx.client });

// Different discovery version — new vault doc, existing RAID items updated (occurrence_count from sameCtx = 2 → 3)
const duplicate = createSupabase(sameCtx.state.raidItems);
const duplicateResult = await materializeProjectDiscoveryRaidItems({ discovery: baseDiscovery, discoveryId: 'disc-2', discoveryVersion: 2, workspaceId: 'workspace-1', projectId: 'project-1', supabase: duplicate.client });

const manualRows = first.state.raidItems.map((row, index) => index === 0 ? { ...row, title: 'Manual title', description: 'Manual description', status: 'monitoring', owner: 'Ana', due_date: '2026-07-10', auto_generated: false, confidence_score: 20, last_detected_at: '2026-06-01T00:00:00.000Z' } : { ...row });
const manual = createSupabase(manualRows);
const manualResult = await materializeProjectDiscoveryRaidItems({ discovery: baseDiscovery, discoveryId: 'disc-3', discoveryVersion: 3, workspaceId: 'workspace-1', projectId: 'project-1', supabase: manual.client });
const manualRow = manual.state.raidItems.find((row) => row.auto_generated === false);

const empty = createSupabase();
const emptyResult = await materializeProjectDiscoveryRaidItems({ discovery: emptyDiscovery, discoveryId: 'disc-empty', discoveryVersion: 1, workspaceId: 'workspace-1', projectId: 'project-1', supabase: empty.client });

console.log(JSON.stringify({
  firstResult,
  firstVaultDocCount: first.state.vaultDocuments.length,
  firstCategories: first.state.raidItems.map((row) => row.category).sort(),
  sameCtxResult,
  sameCtxVaultDocCount: sameCtx.state.vaultDocuments.length,
  sameCtxOccurrenceCounts: sameCtx.state.raidItems.map((row) => row.occurrence_count),
  duplicateResult,
  duplicateCount: duplicate.state.raidItems.length,
  duplicateUpdates: duplicate.state.updates,
  duplicateOccurrenceCounts: duplicate.state.raidItems.map((row) => row.occurrence_count),
  manualResult,
  manualRow,
  manualOccurrenceCount: manualRow?.occurrence_count,
  emptyResult,
  emptyRaidCount: empty.state.raidItems.length,
  emptyVaultDocuments: empty.state.vaultDocuments.length,
}));
})();
`;

const materializationRuntime = JSON.parse(execFileSync('npx', ['tsx', '--eval', materializationProbe], { encoding: 'utf8' }).trim().split('\n').at(-1));

test('Project Discovery RAID materializer maps findings and emits lifecycle logs', () => {
  assert.match(materializer, /raid\.materialization\.started/);
  assert.match(materializer, /raid\.materialization\.completed/);
  assert.match(materializer, /raid\.materialization\.failed/);
  assert.match(materializer, /discovery\.risks\.map\(riskFinding\)/);
  assert.match(materializer, /discovery\.dependencies\.map\(dependencyFinding\)/);
  assert.match(materializer, /discovery\.assumptions\.map\(assumptionFinding\)/);
  assert.match(materializer, /discovery\.unknowns\.map\(unknownFinding\)/);
  assert.match(materializer, /discoveryRaidFingerprint/);
  assert.match(materializer, /createHash\("sha256"\)/);
});

test('new Project Discovery risks become RAID items', () => {
  assert.equal(materializationRuntime.firstResult.created, 4);
  assert.deepEqual(materializationRuntime.firstCategories, ['assumption', 'dependency', 'issue', 'risk']);
});

test('first Project Discovery materialization creates exactly one vault document', () => {
  assert.equal(materializationRuntime.firstVaultDocCount, 1);
});

test('same-context re-materialization reuses the existing vault document', () => {
  assert.equal(materializationRuntime.sameCtxResult.updated, 4);
  assert.equal(materializationRuntime.sameCtxVaultDocCount, 1);
});

test('re-detection increments occurrence_count on existing RAID items', () => {
  assert.ok(materializationRuntime.sameCtxOccurrenceCounts.every((c) => c === 2));
});

test('duplicate Project Discovery findings do not duplicate RAID items', () => {
  assert.equal(materializationRuntime.duplicateResult.created, 0);
  assert.equal(materializationRuntime.duplicateResult.updated, 4);
  assert.equal(materializationRuntime.duplicateCount, 4);
});

test('Project Discovery re-detection updates last_detected_at and increments occurrence_count', () => {
  assert.equal(materializationRuntime.duplicateUpdates.length, 4);
  assert.ok(materializationRuntime.duplicateUpdates.every((update) => typeof update.payload.last_detected_at === 'string'));
  assert.ok(materializationRuntime.duplicateUpdates.every((update) => Object.keys(update.payload).includes('confidence_score')));
  assert.ok(materializationRuntime.duplicateUpdates.every((update) => typeof update.payload.occurrence_count === 'number'));
  assert.ok(materializationRuntime.duplicateOccurrenceCounts.every((c) => c === 3));
});

test('Project Discovery RAID materialization preserves manual edits', () => {
  assert.equal(materializationRuntime.manualResult.updated, 4);
  assert.equal(materializationRuntime.manualRow.title, 'Manual title');
  assert.equal(materializationRuntime.manualRow.description, 'Manual description');
  assert.equal(materializationRuntime.manualRow.status, 'monitoring');
  assert.equal(materializationRuntime.manualRow.owner, 'Ana');
  assert.equal(materializationRuntime.manualRow.due_date, '2026-07-10');
  assert.equal(materializationRuntime.manualRow.auto_generated, false);
  assert.notEqual(materializationRuntime.manualRow.last_detected_at, '2026-06-01T00:00:00.000Z');
  assert.equal(materializationRuntime.manualOccurrenceCount, 2);
});

test('Project Discovery with no RAID findings creates no RAID items', () => {
  assert.equal(materializationRuntime.emptyResult.created, 0);
  assert.equal(materializationRuntime.emptyResult.updated, 0);
  assert.equal(materializationRuntime.emptyRaidCount, 0);
  assert.equal(materializationRuntime.emptyVaultDocuments, 0);
});

test('Project Discovery regeneration calls RAID materialization after successful generation', () => {
  assert.match(repository, /materializeProjectDiscoveryRaidItems/);
  assert.match(repository, /discoveryId: insertedDiscovery\.id/);
  assert.match(repository, /discoveryId: latestDiscovery\.id/);
});
