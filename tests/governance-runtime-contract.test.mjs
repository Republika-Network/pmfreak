import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const runtimeWrapper = fs.readFileSync('src/lib/aoc/enterprise/runtime.ts', 'utf8');
const legacyRuntime = fs.readFileSync('src/lib/governance/authority/runtime/governance-core.ts', 'utf8');
const pmfreakRuntimeWrapper = fs.readFileSync('src/lib/aoc/enterprise/runtime.ts', 'utf8');

const governedRoutes = [
  'src/app/api/copilot/route.ts',
  'src/app/api/upload/route.ts',
];

const billingRoutes = [
  'src/app/api/billing/create-checkout-session/route.ts',
  'src/app/api/billing/create-portal-session/route.ts',
];

const routeSources = governedRoutes.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
const billingRouteSources = billingRoutes.map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));

test('runtime wrapper exposes only evaluation and enforcement entrypoints', () => {
  assert.match(runtimeWrapper, /export async function evaluateRuntimeAuthorization/);
  assert.match(runtimeWrapper, /export async function enforceRuntimeAuthorization/);
  assert.doesNotMatch(runtimeWrapper, /export\s+\{[^}]*enforceGovernanceAction/);
  assert.doesNotMatch(runtimeWrapper, /export\s+\{[^}]*evaluateGovernanceAction/);
});

test('governed product routes consume AOC runtime wrapper and avoid direct legacy runtime imports', () => {
  for (const { file, source } of routeSources) {
    assert.match(source, /enforceRuntimeAuthorization/, `${file} should enforce runtime authorization through wrapper`);
    assert.doesNotMatch(source, /security\/governance-runtime/, `${file} must not import legacy runtime directly`);
  }
});

// billing.manage is deliberately NOT routed through the generic AOC governance
// wrapper. That wrapper (a) previously received actorRole from display role —
// the exact vulnerability closed here — and (b) carries a shared
// "admin requires additional approval" special case for billing.manage that
// would incorrectly block workspace admins from the direct-allow policy this
// surface requires. Billing routes use a dedicated, deterministic,
// workspace_memberships-backed gate instead. See
// docs/security/billing-authorization-boundary.md.
test('billing routes use the dedicated workspace-membership billing gate instead of the generic governance wrapper', () => {
  for (const { file, source } of billingRouteSources) {
    assert.match(source, /requireBillingManageMembership/, `${file} should gate billing.manage on workspace membership`);
    assert.doesNotMatch(source, /enforceRuntimeAuthorization/, `${file} must not derive billing authorization from the generic governance wrapper`);
    assert.doesNotMatch(source, /security\/governance-runtime/, `${file} must not import legacy runtime directly`);
  }
});

test('governance core owns governed action policy surface', () => {
  for (const action of ['project.read', 'project.write', 'memory.read', 'memory.write', 'document.upload', 'billing.manage', 'members.manage', 'ai.execute', 'ai.manage', 'workspace.manage', 'executive.view', 'privileged.use', 'knowledge.ratify', 'knowledge.reject', 'knowledge.revoke']) {
    assert.match(legacyRuntime, new RegExp(`"${action}"`));
  }
});

test('boundary lint rejects direct governance-runtime imports outside internal allowlist', () => {
  const output = execFileSync('node', ['scripts/lint-aoc-boundaries.mjs'], { encoding: 'utf8' });
  assert.match(output, /AOC boundary lint passed/);
});

test('PMFreak runtime wrapper constructs deny response for denied governance decisions', () => {
  assert.match(pmfreakRuntimeWrapper, /denyResponse\(\{/);
  assert.match(pmfreakRuntimeWrapper, /status: 403/);
  assert.match(pmfreakRuntimeWrapper, /reason: decision\.reason/);
  assert.match(pmfreakRuntimeWrapper, /actorUserId: decision\.actor\.userId/);
  assert.match(pmfreakRuntimeWrapper, /actorAgentId: decision\.actor\.agentId/);
  assert.match(pmfreakRuntimeWrapper, /workspaceId: decision\.scope\.workspaceId/);
  assert.match(pmfreakRuntimeWrapper, /projectId: decision\.scope\.projectId/);
});
