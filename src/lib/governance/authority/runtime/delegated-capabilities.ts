// PMFreak governance runtime — delegation chain management.
// OWNERSHIP: PMFreak. Not Soberania Protocol, not Frontera.
// Host services arrive through explicit RuntimeContext injection.
import { createHash, randomBytes } from "node:crypto";
import type { PolicyEvaluationOutcome } from "@/lib/governance/authority/ports/policy-evaluation";
import type { GovernanceActorContext } from "@/lib/governance/authority/actor-model";
import type { RuntimeContext } from "./context";
import type { DelegationConstraints, DelegationDecision, DelegationInput } from "./runtime-input-contracts";
export type { DelegationConstraints, DelegationDecision, DelegationInput } from "./runtime-input-contracts";
// Knowledge ratification/rejection/revocation is never delegable (P2-19: the attributable human decides).
const FORBIDDEN = new Set(["billing.manage", "members.manage", "workspace.manage", "privileged.use", "knowledge.ratify", "knowledge.reject", "knowledge.revoke"]);
const OWNER_ADMIN_ALLOWED = new Set(["project.read", "memory.read", "memory.write", "document.upload", "ai.execute"]);
const PM_ALLOWED = new Set(["project.read", "memory.read", "memory.write", "document.upload"]);
const DEFAULT_MAX_DELEGATION_DEPTH = 3;

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const genToken = () => randomBytes(32).toString("base64url");
const getActorKey = (row: Record<string, unknown>, mode: "delegator" | "delegate") => row?.[`${mode}_user_id`] ? `user:${row[`${mode}_user_id`]}` : row?.[`${mode}_agent_id`] ? `agent:${row[`${mode}_agent_id`]}` : `${mode}:unknown`;


export function buildAuthorityLineage(input: DelegationInput) {
  return { parentGrantId: input.parentGrantId ?? null, parentDelegationId: input.parentDelegationId ?? null, parentDecisionId: input.parentDecisionId ?? null, delegatorUserId: input.delegatorUserId ?? null, delegatorAgentId: input.delegatorAgentId ?? null, delegateeUserId: input.delegateeUserId ?? null, delegateeAgentId: input.delegateeAgentId ?? null, action: input.action, requestedPermission: input.requestedPermission, workspaceId: input.workspaceId, projectId: input.projectId ?? null, scope: { resourceType: input.resourceType ?? null, resourceId: input.resourceId ?? null }, issuedAt: new Date().toISOString(), expiresAt: input.expiresAt ?? null, depth: input.depth ?? 1 };
}
export function explainDelegationChain(lineage: ReturnType<typeof buildAuthorityLineage>) { return `Delegated via ${lineage.parentDelegationId ?? lineage.parentGrantId ?? "root"} for ${lineage.action}.`; }

function assertDelegationRules(input: DelegationInput) {
  if (FORBIDDEN.has(input.action)) throw new Error("forbidden_action");
  if ((input.delegatorRole === "owner" || input.delegatorRole === "admin") && !OWNER_ADMIN_ALLOWED.has(input.action)) throw new Error("owner_admin_action_denied");
  if (input.delegatorRole === "pm" && !PM_ALLOWED.has(input.action)) throw new Error("pm_action_denied");
  if (input.delegatorRole === "pm" && !input.projectId) throw new Error("pm_requires_project_scope");
  if (input.expiresAt && input.parentGrant?.expires_at && new Date(input.expiresAt).getTime() > new Date(input.parentGrant.expires_at).getTime()) throw new Error("ttl_extension");
  if ((input.constraints?.delegationDepth ?? 0) > (input.parentConstraints?.delegationDepth ?? 1)) throw new Error("depth_exceeded");
  if (input.parentGrant?.project_id && input.projectId && input.parentGrant.project_id !== input.projectId) throw new Error("scope_broadening");
  if (input.parentGrant?.requested_permission && input.parentGrant.requested_permission !== input.requestedPermission) throw new Error("permission_broadening");
  if (input.delegatorUserId && input.delegateeUserId && input.delegatorUserId === input.delegateeUserId) throw new Error("self_loop");
  if (input.delegatorAgentId && input.delegateeAgentId && input.delegatorAgentId === input.delegateeAgentId) throw new Error("self_loop");
}

// PRIVILEGED_ACCESS: Delegation chains traverse records owned by multiple actors; cross-actor authority resolution cannot be scoped to a single user's RLS context.
// AUDIT_REF: service-role-risk-register.md
export async function resolveAuthorityChain(runtime: RuntimeContext, input: { workspaceId: string; delegationId: string; maxDepth?: number }) {
  const supabase = runtime.privilegedDb.createClient({ routeId: "governance.delegations.resolve_chain", operation: "resolve_delegation_chain", reason: "delegation_evaluation", systemActor: "system", workspaceId: input.workspaceId });
  const seen = new Set<string>();
  const actorTransitions = new Set<string>();
  const chain: Record<string, unknown>[] = [];
  let currentId: string | null = input.delegationId;
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  while (currentId) {
    if (seen.has(currentId)) return { ok: false as const, reason: "invalid_chain" as DelegationDecision, chain };
    seen.add(currentId);
    const rowResult: { data: Record<string, unknown> | null } = await supabase.from("governance_delegations").select("*").eq("id", currentId).eq("workspace_id", input.workspaceId).maybeSingle();
    const data = rowResult.data;
    if (!data) return { ok: false as const, reason: "invalid_chain" as DelegationDecision, chain };
    const edge = `${getActorKey(data, "delegator")}=>${getActorKey(data, "delegate")}`;
    if (actorTransitions.has(edge)) return { ok: false as const, reason: "invalid_chain" as DelegationDecision, chain };
    actorTransitions.add(edge);
    chain.push(data);
    if (chain.length > maxDepth) return { ok: false as const, reason: "exceeded_depth" as DelegationDecision, chain };
    currentId = (data.parent_delegation_id as string | null | undefined) ?? null;
  }
  return { ok: true as const, chain };
}

export async function evaluateDelegatedAccess(runtime: RuntimeContext, input: DelegationInput & { delegationId?: string; delegationToken?: string }) {
  const validated = await validateDelegatedCapability(runtime, input);
  if (!validated.ok) return { decision: validated.reason as DelegationDecision, allowed: false, delegation: validated.delegation ?? null };
  const chainRes = await resolveAuthorityChain(runtime, { workspaceId: input.workspaceId, delegationId: validated.delegation.id, maxDepth: input.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH });
  if (!chainRes.ok) return { decision: chainRes.reason, allowed: false, delegation: validated.delegation, chain: chainRes.chain };
  const delegationActor: GovernanceActorContext = validated.delegation.delegatee_agent_id
    ? { actorId: validated.delegation.delegatee_agent_id, actorType: "ai_agent", workspaceId: input.workspaceId }
    : validated.delegation.delegatee_user_id
      ? { actorId: validated.delegation.delegatee_user_id, actorType: "user", workspaceId: input.workspaceId }
      : { actorId: "system:delegation", actorType: "system", workspaceId: input.workspaceId };
  const policy = await runtime.policyEvaluator.evaluatePolicyDecision({ actor: delegationActor, workspaceId: input.workspaceId, resourceType: (validated.delegation.resource_type ?? "workspace") as string, resourceId: (validated.delegation.resource_id ?? input.workspaceId) as string, permission: validated.delegation.requested_permission as string, rbacAllowed: true });
  if (policy.decision !== "allow") return { decision: "policy_denied" as const, allowed: false, delegation: validated.delegation, chain: chainRes.chain, policy };
  return { decision: "allow" as const, allowed: true, delegation: validated.delegation, chain: chainRes.chain, policy };
}

export async function issueDelegatedCapability(runtime: RuntimeContext, input: DelegationInput) { assertDelegationRules(input); const token = genToken(); const supabase = runtime.privilegedDb.createClient({ routeId: "governance.delegations.issue", operation: "issue_delegation", reason: "derived_authority", systemActor: "system", workspaceId: input.workspaceId, actorUserId: input.delegatorUserId ?? null }); const now = new Date().toISOString(); const constraints: DelegationConstraints = { ...(input.constraints ?? {}), maxUses: input.maxUses ?? 1 }; const payload = { parent_delegation_id: input.parentDelegationId ?? null, parent_grant_id: input.parentGrantId ?? null, parent_decision_id: input.parentDecisionId ?? null, workspace_id: input.workspaceId, project_id: input.projectId ?? null, delegator_actor_type: input.delegatorUserId ? "human" : "ai_agent", delegator_user_id: input.delegatorUserId ?? null, delegator_agent_id: input.delegatorAgentId ?? null, delegate_actor_type: input.delegateeUserId ? "human" : "ai_agent", delegatee_user_id: input.delegateeUserId ?? null, delegatee_agent_id: input.delegateeAgentId ?? null, action: input.action, permission: input.requestedPermission, requested_permission: input.requestedPermission, resource_type: input.resourceType ?? null, resource_id: input.resourceId ?? null, delegated_scope: input.constraints ?? {}, constraints, status: "active", delegation_depth: input.depth ?? (constraints.delegationDepth ?? 1), delegation_token_hash: hashToken(token), max_uses: input.maxUses ?? 1, uses_count: 0, expires_at: input.expiresAt, created_by_user_id: input.delegatorUserId ?? null, metadata: input.metadata ?? {}, created_at: now, updated_at: now }; const { data, error } = await supabase.from("governance_delegations").insert(payload).select("*").single(); if (error) throw new Error(`issue delegation failed: ${error.message}`); await runtime.securityAudit.logEvent("delegated_capability_issued", { workspaceId: data.workspace_id, projectId: data.project_id, actorUserId: data.delegator_user_id, actorAgentId: data.delegator_agent_id, requested_permission: data.requested_permission, metadata: { delegationId: data.id, parentDelegationId: data.parent_delegation_id, parentGrantId: data.parent_grant_id, parentDecisionId: data.parent_decision_id, delegateeUserId: data.delegatee_user_id, delegateeAgentId: data.delegatee_agent_id, action: data.action, status: data.status, depth: data.delegation_depth } }); return { delegation: data, delegationToken: token, lineage: buildAuthorityLineage(input) }; }

export async function validateDelegatedCapability(runtime: RuntimeContext, input: DelegationInput) { const supabase = runtime.privilegedDb.createClient({ routeId: "governance.delegations.validate", operation: "validate_delegation", reason: "pre_execution_validation", systemActor: "system", workspaceId: input.workspaceId, actorUserId: input.actorUserId ?? null }); const query = input.delegationId ? supabase.from("governance_delegations").select("*").eq("id", input.delegationId) : supabase.from("governance_delegations").select("*").eq("delegation_token_hash", hashToken(input.delegationToken ?? "")); const { data } = await query.maybeSingle(); if (!data) return { ok: false, reason: "invalid_chain" }; if (data.status === "revoked") return { ok: false, reason: "revoked", delegation: data }; if (data.status !== "active") return { ok: false, reason: "deny", delegation: data }; if (new Date(data.expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired", delegation: data }; if (data.uses_count >= data.max_uses) return { ok: false, reason: "deny", delegation: data }; if (data.workspace_id !== input.workspaceId || (input.projectId && data.project_id && data.project_id !== input.projectId) || data.action !== input.action || data.requested_permission !== input.requestedPermission || (input.resourceType && data.resource_type && data.resource_type !== input.resourceType) || (input.resourceId && data.resource_id && data.resource_id !== input.resourceId) || (input.actorUserId && data.delegatee_user_id && data.delegatee_user_id !== input.actorUserId) || (input.actorAgentId && data.delegatee_agent_id && data.delegatee_agent_id !== input.actorAgentId)) return { ok: false, reason: "exceeded_scope", delegation: data }; return { ok: true, delegation: data }; }

export async function revokeDelegatedCapability(runtime: RuntimeContext, input: DelegationInput) { const supabase = runtime.privilegedDb.createClient({ routeId: "governance.delegations.revoke", operation: "revoke_delegation", reason: "delegation_revocation", systemActor: "system", workspaceId: input.workspaceId, actorUserId: input.actorUserId ?? null }); const now = new Date().toISOString(); const { data } = await supabase.from("governance_delegations").update({ status: "revoked", revoked_at: now, revoked_reason: input.revokedReason ?? "manual_revoke", updated_at: now }).eq("id", input.delegationId).select("*").maybeSingle(); if (!data) return { ok: false, reason: "not_found" }; const { data: descendants } = await supabase.from("governance_delegations").select("id,parent_delegation_id,workspace_id,project_id,requested_permission").eq("workspace_id", data.workspace_id);
  const queue = [data.id]; const childIds: string[] = []; const byParent = new Map<string, string[]>();
  for (const d of descendants ?? []) { if (!d.parent_delegation_id) continue; byParent.set(d.parent_delegation_id, [...(byParent.get(d.parent_delegation_id) ?? []), d.id]); }
  while (queue.length) { const id = queue.shift()!; for (const c of byParent.get(id) ?? []) { childIds.push(c); queue.push(c); } }
  if (childIds.length) await supabase.from("governance_delegations").update({ status: "revoked", revoked_at: now, revoked_reason: `parent_revoked:${data.id}`, updated_at: now }).in("id", childIds).eq("status", "active");
  await runtime.securityAudit.logEvent("delegated_capability_revoked", { workspaceId: data.workspace_id, projectId: data.project_id, actorUserId: input.actorUserId ?? null, requested_permission: data.requested_permission, metadata: { delegationId: data.id, propagatedRevocations: childIds.length } }); return { ok: true, delegation: data, propagatedRevocations: childIds.length }; }


export async function consumeDelegatedCapability(runtime: RuntimeContext, input: DelegationInput) {
  const evaluated = await evaluateDelegatedAccess(runtime, input);
  if (!evaluated.allowed) return { ok: false, reason: String(evaluated.decision), delegation: evaluated.delegation };
  const supabase = runtime.privilegedDb.createClient({ routeId: "governance.delegations.consume", operation: "consume_delegation", reason: "delegated_execution", systemActor: "system", workspaceId: input.workspaceId, actorUserId: input.actorUserId ?? null });
  const { data } = await supabase.from("governance_delegations").update({ uses_count: evaluated.delegation.uses_count + 1, status: evaluated.delegation.uses_count + 1 >= evaluated.delegation.max_uses ? "consumed" : "active", consumed_at: evaluated.delegation.uses_count + 1 >= evaluated.delegation.max_uses ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq("id", evaluated.delegation.id).eq("status", "active").select("*").maybeSingle();
  if (!data) return { ok: false, reason: "deny", delegation: evaluated.delegation };
  return { ok: true, delegation: data };
}
