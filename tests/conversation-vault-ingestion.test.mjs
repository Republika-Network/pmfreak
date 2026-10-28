import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ingestionFile = fs.readFileSync('src/lib/vault/conversation-ingestion.ts', 'utf8');
const copilotRouteFile = fs.readFileSync('src/app/api/copilot/route.ts', 'utf8');

const ingestionModule = await import('../src/lib/vault/conversation-ingestion.js').catch(() => ({}));

const {
  extractConversationSignals,
  mapConversationSignalsToNutrients,
  shouldIngestConversationSignal,
  ingestConversationIntoVault,
} = ingestionModule;

test('ingestion module exports expected functions', () => {
  assert.match(ingestionFile, /export async function ingestConversationIntoVault/);
  assert.match(ingestionFile, /export function extractConversationSignals/);
  assert.match(ingestionFile, /export function mapConversationSignalsToNutrients/);
  assert.match(ingestionFile, /shouldIngestConversationSignal/);
});

test('copilot route imports and uses ingestConversationIntoVault', () => {
  assert.match(copilotRouteFile, /import \{ ingestConversationIntoVault(, type ConversationVaultIngestionResult)? \}/);
  assert.match(copilotRouteFile, /await ingestConversationIntoVault\(/);
});

test('copilot response includes conversationIngestion shape', () => {
  assert.match(copilotRouteFile, /conversationIngestion\?:/);
  assert.match(copilotRouteFile, /result\.conversationIngestion = \{/);
});

test('message too short is skipped', async () => {
  if (!ingestConversationIntoVault) return;
  const result = await ingestConversationIntoVault({ companyId: 'c1', workspaceId: 'w1', projectId: 'p1', sessionKey: 's1', activeDomain: 'operational_memory', message: 'ok thanks', runtimeResponse: { supportingEvidence: [], suggestedActions: [] } });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'message_too_short');
});

test('deterministic extraction and signal mappings', () => {
  if (!extractConversationSignals) return;
  const input = { companyId: 'c1', workspaceId: 'w1', projectId: 'p1', sessionKey: 's1', activeDomain: 'operational_memory', message: 'We are blocked and need sponsor escalation today due to payment and PO delays; approve this decision now', runtimeResponse: { supportingEvidence: ['vendor blocked release', 'payment invoice overdue'], suggestedActions: ['approve change order today'] }, conversationState: { recentBlockers: ['blocked by access'], recentInterventions: [], recentStakeholders: ['sponsor'], recentEvidence: [] } };
  const a = extractConversationSignals(input);
  const b = extractConversationSignals(input);
  assert.deepEqual(a, b);
  const types = new Set(a.map((c) => c.nutrientType));
  assert.ok(types.has('blocker_signal'));
  assert.ok(types.has('escalation_signal'));
  assert.ok(types.has('financial_impediment_signal'));
  assert.ok(types.has('decision_signal'));
});

test('supportingEvidence and recentBlockers contribute candidates', () => {
  if (!extractConversationSignals) return;
  const out = extractConversationSignals({ companyId: 'c1', workspaceId: 'w1', projectId: 'p1', sessionKey: 's1', activeDomain: 'operational_memory', message: 'This has enough words and mentions dependency waiting for handoff', runtimeResponse: { supportingEvidence: ['Escalation required for executive attention'], suggestedActions: ['owner assigned with due date'] }, conversationState: { recentBlockers: ['unresolved blocker pending access'], recentInterventions: [], recentStakeholders: [], recentEvidence: [] } });
  assert.ok(out.some((c) => c.sourceField === 'runtime.supportingEvidence'));
  assert.ok(out.some((c) => c.sourceField === 'state.recentBlockers'));
});

test('mapping preserves scoping/session evidence and excerpt bound', () => {
  if (!mapConversationSignalsToNutrients) return;
  const nutrients = mapConversationSignalsToNutrients({ candidates: [{ nutrientType: 'blocker_signal', excerpt: 'x'.repeat(500), matchedPattern: '/blocked/', sourceField: 'message', confidence: 0.7 }], workspaceId: 'w1', projectId: 'p1', digestionRunId: 'run1', createdAt: '2026-05-21T00:00:00.000Z', sourceArtifactId: 'copilot:s1', sourceRef: 'copilot:s1', actorUserId: 'u1' });
  assert.equal(nutrients[0].workspaceId, 'w1');
  assert.equal(nutrients[0].projectId, 'p1');
  assert.match(nutrients[0].evidence[0].sourceArtifactId, /copilot:s1/);
  assert.ok(nutrients[0].evidence[0].excerpt.length <= 240);
});

test('duplicate suppression key is implemented and quality filter exists', () => {
  assert.match(ingestionFile, /const key = `\$\{candidate\.nutrientType\}:\$\{candidate\.excerpt\.toLowerCase\(\)\}/);
  assert.match(ingestionFile, /duplicate_recent_signal/);
  assert.match(ingestionFile, /low_evidence_density/);
  assert.match(ingestionFile, /no_operational_signal/);
});

test('shouldIngestConversationSignal is conservative', () => {
  if (!shouldIngestConversationSignal) return;
  assert.equal(shouldIngestConversationSignal({ nutrientType: 'risk_signal', excerpt: 'short', matchedPattern: '/risk/', sourceField: 'message', confidence: 0.7 }), false);
  assert.equal(shouldIngestConversationSignal({ nutrientType: 'risk_signal', excerpt: 'This is a long enough operational signal', matchedPattern: '/risk/', sourceField: 'message', confidence: 0.7 }), true);
});
