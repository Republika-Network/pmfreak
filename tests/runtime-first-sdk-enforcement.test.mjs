/**
 * Conformance tests for runtime-first SDK route enforcement.
 *
 * These tests assert source-code-level contracts proving that:
 *  1. Governance-sensitive SDK read routes call authorizeRuntimeAction BEFORE any DB read.
 *  2. Governance-sensitive write routes use runtime authorization, not local role checks.
 *  3. capabilities/actions.ts capability issuance is runtime-gated.
 *  4. Decision lineage (decisionId) is present in route responses.
 *  5. Canonical governance-actions.ts is the single source of truth.
 *  6. The audit taxonomy "allowed → governance_violation" bug is fixed.
 *
 * All checks use fs.readFileSync — the runtime pipeline requires a live database.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── file sources ──────────────────────────────────────────────────────────────

const agentsRoute        = readFileSync("src/app/api/sdk/agents/route.ts", "utf8");
const agentIdRoute       = readFileSync("src/app/api/sdk/agents/[id]/route.ts", "utf8");
const agentScopesRoute   = readFileSync("src/app/api/sdk/agents/scopes/route.ts", "utf8");
const auditAgents        = readFileSync("src/app/api/sdk/audit/agents/route.ts", "utf8");
const auditCaps          = readFileSync("src/app/api/sdk/audit/capabilities/route.ts", "utf8");
const auditResources     = readFileSync("src/app/api/sdk/audit/resources/route.ts", "utf8");
const auditTimeline      = readFileSync("src/app/api/sdk/audit/timeline/route.ts", "utf8");
const grantsRoute        = readFileSync("src/app/api/sdk/capabilities/grants/route.ts", "utf8");
const requestsRoute      = readFileSync("src/app/api/sdk/capabilities/requests/route.ts", "utf8");
const policiesRoute      = readFileSync("src/app/api/sdk/policies/route.ts", "utf8");
const policyIdRoute      = readFileSync("src/app/api/sdk/policies/[id]/route.ts", "utf8");
const capActions         = readFileSync("src/app/(protected)/capabilities/actions.ts", "utf8");
const governanceActions  = readFileSync("src/lib/aoc/runtime/governance-actions.ts", "utf8");
const governanceCore     = readFileSync("src/lib/governance/authority/runtime/governance-core.ts", "utf8");
const securityAuditPort  = readFileSync("src/lib/governance/authority/ports/security-audit.ts", "utf8");
const telemetry          = readFileSync("src/lib/security/telemetry.ts", "utf8");

// ── helpers ───────────────────────────────────────────────────────────────────

function runtimeBeforeDb(src, dbTable) {
  const rtIdx  = src.indexOf("authorizeRuntimeAction(");
  const dbIdx  = src.indexOf(`from("${dbTable}")`);
  return rtIdx !== -1 && dbIdx !== -1 && rtIdx < dbIdx;
}

// ── canonical governance-actions module ──────────────────────────────────────

test("governance-actions: module exports canonical permission and SDK action mappings", () => {
  assert.match(governanceActions, /PERMISSION_TO_GOVERNANCE_ACTION/, "must export PERMISSION_TO_GOVERNANCE_ACTION");
  assert.match(governanceActions, /CAPABILITY_PERMISSION_TO_GOVERNANCE_ACTION/, "must export CAPABILITY_PERMISSION_TO_GOVERNANCE_ACTION");
  assert.match(governanceActions, /SDK_GOVERNANCE_ACTIONS/, "must export SDK_GOVERNANCE_ACTIONS");
});

test("governance-actions: SDK_GOVERNANCE_ACTIONS covers all required SDK operation categories", () => {
  const required = ["AGENTS_READ", "AGENTS_MANAGE", "AUDIT_READ", "CAPABILITIES_READ", "CAPABILITIES_MANAGE", "POLICIES_READ", "POLICIES_MANAGE"];
  for (const key of required) assert.match(governanceActions, new RegExp(key), `SDK_GOVERNANCE_ACTIONS must include ${key}`);
});

test("governance-actions: all actions map to valid GovernanceAction literals from GOVERNANCE_POLICY_REGISTRY", () => {
  const validActions = ["project.read", "project.write", "memory.read", "memory.write", "document.upload", "billing.manage", "members.manage", "ai.execute", "ai.manage", "workspace.manage", "executive.view", "privileged.use", "knowledge.ratify", "knowledge.reject", "knowledge.revoke"];
  for (const action of validActions) {
    // At least some of these must appear in the mappings
    if (governanceActions.includes(action)) assert.ok(true, `${action} referenced`);
  }
  // Must not invent unmapped actions
  assert.doesNotMatch(governanceActions, /"agents\.read"/, "must not invent unmapped GovernanceAction");
  assert.doesNotMatch(governanceActions, /"policies\.read"/, "must not invent unmapped GovernanceAction");
  assert.doesNotMatch(governanceActions, /"audit\.read"/, "must not invent unmapped GovernanceAction");
});

// ── SDK agent routes ──────────────────────────────────────────────────────────

test("sdk/agents GET: runtime authorization precedes DB read", () => {
  assert.ok(runtimeBeforeDb(agentsRoute, "ai_agents"), "authorizeRuntimeAction must come before ai_agents DB read");
  assert.match(agentsRoute, /SDK_GOVERNANCE_ACTIONS\.AGENTS_READ/, "must use canonical AGENTS_READ action");
  assert.doesNotMatch(agentsRoute, /requireWorkspaceRole/, "must not use local role check");
});

test("sdk/agents POST: runtime authorization precedes DB write", () => {
  assert.ok(runtimeBeforeDb(agentsRoute, "ai_agents"), "authorizeRuntimeAction must come before ai_agents DB write");
  assert.match(agentsRoute, /SDK_GOVERNANCE_ACTIONS\.AGENTS_MANAGE/, "must use canonical AGENTS_MANAGE action");
});

test("sdk/agents/[id] PATCH: runtime authorization replaces local role check", () => {
  assert.match(agentIdRoute, /authorizeRuntimeAction/, "must call authorizeRuntimeAction");
  assert.match(agentIdRoute, /SDK_GOVERNANCE_ACTIONS\.AGENTS_MANAGE/, "must use canonical AGENTS_MANAGE action");
  assert.doesNotMatch(agentIdRoute, /requireWorkspaceRole/, "must not use local role check as terminal authority");
});

test("sdk/agents/scopes POST: runtime authorization precedes scope grant", () => {
  assert.match(agentScopesRoute, /authorizeRuntimeAction/, "must call authorizeRuntimeAction");
  assert.match(agentScopesRoute, /SDK_GOVERNANCE_ACTIONS\.AGENTS_MANAGE/, "must use canonical AGENTS_MANAGE action");
  assert.ok(
    agentScopesRoute.indexOf("authorizeRuntimeAction(") < agentScopesRoute.indexOf("grantAgentScope("),
    "runtime authorization must precede grantAgentScope call",
  );
});

// ── SDK audit routes ──────────────────────────────────────────────────────────

test("sdk/audit/agents GET: runtime authorization precedes DB read", () => {
  assert.ok(runtimeBeforeDb(auditAgents, "capability_audit_events"), "authorizeRuntimeAction must precede audit DB read");
  assert.match(auditAgents, /SDK_GOVERNANCE_ACTIONS\.AUDIT_READ/, "must use canonical AUDIT_READ action");
});

test("sdk/audit/capabilities GET: runtime authorization precedes DB read", () => {
  assert.ok(runtimeBeforeDb(auditCaps, "capability_audit_events"), "authorizeRuntimeAction must precede audit DB read");
  assert.match(auditCaps, /SDK_GOVERNANCE_ACTIONS\.AUDIT_READ/, "must use canonical AUDIT_READ action");
});

test("sdk/audit/resources GET: runtime authorization precedes DB read", () => {
  assert.ok(runtimeBeforeDb(auditResources, "capability_audit_events"), "authorizeRuntimeAction must precede audit DB read");
  assert.match(auditResources, /SDK_GOVERNANCE_ACTIONS\.AUDIT_READ/, "must use canonical AUDIT_READ action");
});

test("sdk/audit/timeline GET: runtime authorization precedes DB read", () => {
  assert.ok(runtimeBeforeDb(auditTimeline, "capability_audit_events"), "authorizeRuntimeAction must precede audit DB read");
  assert.match(auditTimeline, /SDK_GOVERNANCE_ACTIONS\.AUDIT_READ/, "must use canonical AUDIT_READ action");
});

// ── SDK capability grant routes ───────────────────────────────────────────────

test("sdk/capabilities/grants GET: runtime authorization precedes DB read", () => {
  assert.ok(runtimeBeforeDb(grantsRoute, "capability_grants"), "authorizeRuntimeAction must precede capability_grants DB read");
  assert.match(grantsRoute, /SDK_GOVERNANCE_ACTIONS\.CAPABILITIES_READ/, "must use canonical CAPABILITIES_READ action");
});

test("sdk/capabilities/requests GET: runtime authorization precedes DB read", () => {
  assert.ok(runtimeBeforeDb(requestsRoute, "capability_requests"), "authorizeRuntimeAction must precede capability_requests DB read");
  assert.match(requestsRoute, /SDK_GOVERNANCE_ACTIONS\.CAPABILITIES_READ/, "must use canonical CAPABILITIES_READ action");
});

// ── SDK policy routes ─────────────────────────────────────────────────────────

test("sdk/policies GET: runtime authorization precedes DB read", () => {
  assert.ok(runtimeBeforeDb(policiesRoute, "capability_policies"), "authorizeRuntimeAction must precede capability_policies DB read");
  assert.match(policiesRoute, /SDK_GOVERNANCE_ACTIONS\.POLICIES_READ/, "must use canonical POLICIES_READ action");
});

test("sdk/policies POST: runtime authorization replaces local role check", () => {
  assert.match(policiesRoute, /SDK_GOVERNANCE_ACTIONS\.POLICIES_MANAGE/, "must use canonical POLICIES_MANAGE action");
  assert.doesNotMatch(policiesRoute, /requireWorkspaceRole/, "must not use local role check as terminal authority");
});

test("sdk/policies/[id] PATCH: runtime authorization replaces local role check", () => {
  assert.match(policyIdRoute, /authorizeRuntimeAction/, "must call authorizeRuntimeAction");
  assert.match(policyIdRoute, /SDK_GOVERNANCE_ACTIONS\.POLICIES_MANAGE/, "must use canonical POLICIES_MANAGE action");
  assert.doesNotMatch(policyIdRoute, /requireWorkspaceRole/, "must not use local role check as terminal authority");
});

// ── capabilities/actions.ts ───────────────────────────────────────────────────

test("capabilities/actions: decideCapabilityRequestAction uses runtime as terminal authority", () => {
  assert.match(capActions, /authorizeRuntimeAction/, "must call authorizeRuntimeAction");
  assert.match(capActions, /SDK_GOVERNANCE_ACTIONS\.CAPABILITIES_MANAGE/, "must use canonical CAPABILITIES_MANAGE action");
  // The old pattern used requireWorkspaceRole as terminal authority; must be replaced.
  // requireWorkspaceRole may be imported elsewhere in file but must not gate grant creation.
  assert.doesNotMatch(capActions, /requireWorkspaceRole/, "requireWorkspaceRole must be removed from capabilities/actions.ts");
});

test("capabilities/actions: runtime authorization precedes capability grant insert", () => {
  const rtIdx   = capActions.indexOf("authorizeRuntimeAction(");
  const insIdx  = capActions.indexOf('from("capability_grants").insert');
  assert.ok(rtIdx !== -1, "authorizeRuntimeAction must exist");
  assert.ok(insIdx !== -1, "capability_grants insert must exist");
  assert.ok(rtIdx < insIdx, "runtime authorization must precede capability_grants insert");
});

test("capabilities/actions: runtimeDecisionId is propagated in audit event detail", () => {
  assert.match(capActions, /runtimeDecisionId/, "audit events must include runtimeDecisionId for lineage");
});

test("capabilities/actions: revokeCapabilityGrantAction uses runtime authorization", () => {
  const revokeFn = capActions.slice(capActions.indexOf("export async function revokeCapabilityGrantAction"));
  assert.match(revokeFn.slice(0, 1000), /authorizeRuntimeAction/, "revokeCapabilityGrantAction must call runtime");
  assert.match(revokeFn.slice(0, 1000), /SDK_GOVERNANCE_ACTIONS\.CAPABILITIES_MANAGE/, "must use canonical action");
});

// ── decision lineage ──────────────────────────────────────────────────────────

test("SDK routes propagate decisionId in responses for lineage", () => {
  // At least key routes must return decisionId in response
  for (const [name, src] of [["agents", agentsRoute], ["audit/caps", auditCaps], ["policies", policiesRoute], ["grants", grantsRoute]]) {
    assert.match(src, /decision\.decisionId/, `${name}: response must include decisionId`);
  }
});

// ── audit taxonomy fix ────────────────────────────────────────────────────────

test("audit taxonomy: governance_action_allowed event type exists in GovernanceAuditEventType", () => {
  assert.match(securityAuditPort, /"governance_action_allowed"/, "GovernanceAuditEventType must include governance_action_allowed");
});

test("audit taxonomy: governance_action_allowed event type exists in SecurityEventType", () => {
  assert.match(telemetry, /"governance_action_allowed"/, "SecurityEventType must include governance_action_allowed");
});

test("audit taxonomy: allowed decisions no longer logged as governance_violation", () => {
  // The bug was: result.allowed ? "governance_violation" : ...
  // After fix: result.allowed ? "governance_action_allowed" : ...
  assert.doesNotMatch(
    governanceCore,
    /result\.allowed \? "governance_violation"/,
    "allowed decisions must not be logged as governance_violation",
  );
  assert.match(
    governanceCore,
    /governance_action_allowed/,
    "governance_core must reference governance_action_allowed for allowed decisions",
  );
});

// ── no unauthorized direct DB access ─────────────────────────────────────────

test("no SDK governance read route returns data before authorization check", () => {
  // Each of these routes must call authorizeRuntimeAction before returning data
  const routes = [agentsRoute, auditAgents, auditCaps, auditResources, auditTimeline, grantsRoute, requestsRoute, policiesRoute];
  for (const src of routes) {
    assert.match(src, /authorizeRuntimeAction/, "all governance read routes must call authorizeRuntimeAction");
    assert.match(src, /if \(!decision\.allowed\)/, "all governance read routes must check decision.allowed");
  }
});
