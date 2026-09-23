// PMFreak governance evaluation pipeline.
// OWNERSHIP: PMFreak. Not Soberania Protocol, not Frontera.
// GOVERNANCE_POLICY_REGISTRY below IS PMFreak's route-level authority policy:
// which actor types may perform which action, at what permission and risk, and
// what is audited on denial. Changing it changes authority.
// This layer has no canonical counterpart. Frontera exports functions with two of
// the same names (evaluateEnforcementPipeline, enforceEnforcementPipeline) over a
// completely different contract; PMFreak's are named *GovernancePipeline in
// ./index.ts precisely so the two can never be confused.
import type { GovernancePermission, GovernanceAction, GovernanceDecisionState, GovernanceRiskLevel, GovernanceActorRole } from "@/lib/governance/authority/actor-model";
import type { GovernanceAuditEventType } from "@/lib/governance/authority/ports/security-audit";
import { GovernanceAccessDeniedError } from "@/lib/governance/authority/ports/access-verification";
import type { RuntimeContext } from "./context";

export type GovernanceActorType = "user" | "ai_agent" | "system";
export type GovernanceDecisionStatus = "evaluated" | "pending_approval" | "approved" | "rejected" | "expired" | "cancelled" | "executed_after_approval";
// GovernanceAction and GovernanceDecisionState were previously re-declared here as
// aliases of the Aoc*-prefixed originals. The prefixed duplicates are gone; these
// names now have exactly one definition, in ../actor-model, re-exported here so
// existing consumer import sites are unaffected.
export type { GovernanceAction, GovernanceDecisionState };

type ApprovalType = "human" | "admin";

export type GovernanceEvaluationInput = { actorType: GovernanceActorType; actorUserId?: string | null; actorAgentId?: string | null; workspaceId?: string | null; projectId?: string | null; actorRole?: GovernanceActorRole | null; requestedPermission?: GovernancePermission | null; resourceType?: string | null; resourceId?: string | null; action: GovernanceAction; routeId: string; metadata?: Record<string, unknown>; agentToken?: string | null; systemActor?: string | null; };
type GovernancePolicy = { requiredPermission: GovernancePermission; minimumRole?: GovernanceActorRole; allowedActorTypes: GovernanceActorType[]; agentCompatible: boolean; denyEventType: GovernanceAuditEventType; riskLevel: GovernanceRiskLevel; projectScoped?: boolean; workspaceScoped?: boolean; requiresSystemContext?: boolean };
export const GOVERNANCE_POLICY_REGISTRY: Record<GovernanceAction, GovernancePolicy> = {
  "project.read": { requiredPermission: "read", allowedActorTypes: ["user", "ai_agent"], agentCompatible: true, denyEventType: "project_scope_violation", riskLevel: "low", projectScoped: true },
  "project.write": { requiredPermission: "write", allowedActorTypes: ["user", "ai_agent"], agentCompatible: true, denyEventType: "denied_permission", riskLevel: "medium", projectScoped: true },
  "memory.read": { requiredPermission: "read", allowedActorTypes: ["user", "ai_agent"], agentCompatible: true, denyEventType: "denied_permission", riskLevel: "medium", projectScoped: true },
  "memory.write": { requiredPermission: "write_memory", allowedActorTypes: ["user", "ai_agent"], agentCompatible: true, denyEventType: "denied_permission", riskLevel: "high", projectScoped: true },
  "document.upload": { requiredPermission: "upload_documents", allowedActorTypes: ["user", "ai_agent"], agentCompatible: true, denyEventType: "denied_permission", riskLevel: "high", projectScoped: true },
  "billing.manage": { requiredPermission: "manage_billing", minimumRole: "owner", allowedActorTypes: ["user"], agentCompatible: false, denyEventType: "billing_governance_denied", riskLevel: "critical", workspaceScoped: true },
  "members.manage": { requiredPermission: "manage_members", allowedActorTypes: ["user"], agentCompatible: false, denyEventType: "governance_violation", riskLevel: "high", workspaceScoped: true },
  "ai.execute": { requiredPermission: "execute_ai_action", allowedActorTypes: ["user", "ai_agent"], agentCompatible: true, denyEventType: "unsafe_agent_attempt", riskLevel: "high", workspaceScoped: true },
  "ai.manage": { requiredPermission: "manage_ai", allowedActorTypes: ["user"], agentCompatible: false, denyEventType: "governance_violation", riskLevel: "high", workspaceScoped: true },
  "workspace.manage": { requiredPermission: "manage_workspace", allowedActorTypes: ["user"], agentCompatible: false, denyEventType: "workspace_scope_violation", riskLevel: "critical", workspaceScoped: true },
  "executive.view": { requiredPermission: "view_executive", allowedActorTypes: ["user", "ai_agent"], agentCompatible: true, denyEventType: "denied_permission", riskLevel: "medium", workspaceScoped: true },
  "privileged.use": { requiredPermission: "manage_workspace", allowedActorTypes: ["system"], agentCompatible: false, denyEventType: "suspicious_permission_escalation", riskLevel: "critical", workspaceScoped: true, requiresSystemContext: true },
  // PB-CHAT-01 — interactive Project Brain conversation. Project-scoped read: the
  // caller must hold `read` on THIS project (requireProjectPermission), so a
  // member of workspace W cannot converse about a project outside W. Humans only
  // (not agent-compatible), low risk because the action is read-only against
  // project state: the only writes behind it are the transcript itself and AI
  // usage accounting. It is intentionally absent from decisionNeedsApproval —
  // an ordinary chat turn needs no approval workflow — and it grants nothing
  // that "ai.execute", "project.write", "memory.write" or "document.upload"
  // gate. Provider usage/cost controls still apply inside runInference.
  "project_brain.converse": { requiredPermission: "read", allowedActorTypes: ["user"], agentCompatible: false, denyEventType: "project_scope_violation", riskLevel: "low", projectScoped: true },
};

const decisionNeedsApproval = (input: GovernanceEvaluationInput, riskLevel: string): { decision: GovernanceDecisionState; approvalType: ApprovalType; reviewerRoleRequired: GovernanceActorRole } | null => {
  if (input.action === "ai.execute" && riskLevel === "high") return { decision: "require_human_approval", approvalType: "human", reviewerRoleRequired: "admin" };
  if (input.action === "document.upload" && input.actorRole === "external_stakeholder") return { decision: "require_human_approval", approvalType: "human", reviewerRoleRequired: "admin" };
  if (input.action === "billing.manage" && input.actorRole === "admin") return { decision: "require_admin_approval", approvalType: "admin", reviewerRoleRequired: "owner" };
  if (input.action === "privileged.use" && input.systemActor !== "trusted_webhook") return { decision: "require_admin_approval", approvalType: "admin", reviewerRoleRequired: "admin" };
  return null;
};

export async function evaluateGovernanceAction(runtime: RuntimeContext, input: GovernanceEvaluationInput) {
  const audit = runtime.securityAudit;
  const access = runtime.accessVerification;
  const attestation = runtime.agentAttestation;

  const policy = GOVERNANCE_POLICY_REGISTRY[input.action]; const decisionId = crypto.randomUUID(); const trace: Array<Record<string, unknown>> = [];
  const deny = (reason: string) => ({ allowed: false as const, decision: "deny" as GovernanceDecisionState, reason });
  trace.push({ rule: "policy_registry", result: "checked", reason: `matched ${input.action}` });
  if (!policy.allowedActorTypes.includes(input.actorType)) return finalize(deny(`Denied because actor type ${input.actorType} cannot execute ${input.action}.`));
  if (input.actorType === "ai_agent" && !policy.agentCompatible) return finalize(deny(`Denied because ${input.action} is not agent compatible.`));
  if (policy.workspaceScoped && !input.workspaceId) return finalize(deny("Denied because workspace scope is missing."));
  if (policy.projectScoped && !input.projectId) return finalize(deny("Denied because project scope is missing for project-scoped action."));
  if (input.actorType === "system" && policy.requiresSystemContext && !input.systemActor) return finalize(deny("Denied because systemActor context is required."));
  try { if (input.actorType === "user") { if (policy.projectScoped && input.projectId) { const ctx = await access.requireProjectPermission(input.projectId, policy.requiredPermission); trace.push({ rule: "project_binding_checked", roleChecked: ctx.role, scopeChecked: "project", result: "passed", reason: "project permission granted" }); } else if (policy.workspaceScoped && input.workspaceId) { const ctx = await access.requireGovernancePermission(input.workspaceId, policy.requiredPermission); trace.push({ rule: "workspace_membership_checked", roleChecked: ctx.role, scopeChecked: "workspace", result: "passed", reason: "workspace governance permission granted" }); } }
    if (input.actorType === "ai_agent") { if (!input.actorAgentId) return finalize(deny("Denied because AI agent actor id is missing.")); if (!input.workspaceId) return finalize(deny("Denied because AI agent workspace scope is missing.")); if (input.agentToken) { await attestation.verifyAttestation({ token: input.agentToken, expectedAgentId: input.actorAgentId, workspaceId: input.workspaceId, permission: policy.requiredPermission, projectId: input.projectId ?? undefined }); trace.push({ rule: "agent_attestation_checked", agentScopeChecked: true, result: "passed", reason: "attestation verified" }); } await access.requireAgentScope({ workspaceId: input.workspaceId, agentId: input.actorAgentId, permission: policy.requiredPermission, projectId: input.projectId ?? undefined }); trace.push({ rule: "agent_scope_checked", projectBindingChecked: input.projectId ?? null, result: "passed", reason: "agent scope granted" }); }
    if (input.actorType === "system" && input.workspaceId) { await access.requireWorkspaceMembership(input.workspaceId); trace.push({ rule: "system_workspace_binding", privilegedContextChecked: Boolean(input.systemActor), result: "passed", reason: "system actor has explicit context" }); }
  } catch (error) { const reason = error instanceof GovernanceAccessDeniedError ? String(error.context.reason ?? error.message) : "governance_denied"; trace.push({ rule: "composed_guard", result: "denied", reason }); return finalize(deny(`Denied because ${reason}.`)); }
  const approvalRule = decisionNeedsApproval(input, policy.riskLevel);
  if (approvalRule) return finalize({ allowed: false, decision: approvalRule.decision, reason: `Action requires ${approvalRule.approvalType} approval.`, requiredApprovalType: approvalRule.approvalType, reviewerRoleRequired: approvalRule.reviewerRoleRequired });
  return finalize({ allowed: true as const, decision: "allow" as GovernanceDecisionState, reason: "Allowed by governance policy and composed guard checks." });

  function finalize(result: { allowed: boolean; decision: GovernanceDecisionState; reason: string; requiredApprovalType?: ApprovalType; reviewerRoleRequired?: GovernanceActorRole }) {
    const allowedEventType = "governance_action_allowed" as const;
    const output = { allowed: result.allowed, decision: result.decision, decisionId, reason: result.reason, requiredPermission: policy.requiredPermission, matchedPolicy: input.action, evaluatedAt: new Date().toISOString(), actor: { type: input.actorType, userId: input.actorUserId ?? null, agentId: input.actorAgentId ?? null, role: input.actorRole ?? null, systemActor: input.systemActor ?? null }, scope: { workspaceId: input.workspaceId ?? null, projectId: input.projectId ?? null, resourceType: input.resourceType ?? null, resourceId: input.resourceId ?? null }, riskLevel: policy.riskLevel, status: result.decision.includes("approval") ? "pending_approval" : "evaluated", requiredApprovalType: result.requiredApprovalType ?? null, reviewerRoleRequired: result.reviewerRoleRequired ?? null, auditEventType: result.allowed ? allowedEventType : policy.denyEventType, trace };
    void audit.logEvent(result.decision.includes("approval") ? "approval_requested" : (result.allowed ? allowedEventType : policy.denyEventType), { routeId: input.routeId, actorUserId: input.actorUserId ?? null, actorAgentId: input.actorAgentId ?? null, workspaceId: input.workspaceId ?? null, projectId: input.projectId ?? null, actorRole: input.actorRole ?? null, requested_permission: policy.requiredPermission, denied_permission: result.allowed ? null : policy.requiredPermission, resourceType: input.resourceType ?? null, resourceId: input.resourceId ?? null, metadata: { governanceDecision: output } });
    return output;
  }
}

export type GovernanceDecisionResult = Awaited<ReturnType<typeof evaluateGovernanceAction>>;

export async function createApprovalRequestFromDecision(runtime: RuntimeContext, decision: GovernanceDecisionResult) {
  if (!decision.requiredApprovalType || !decision.scope.workspaceId) return null;
  // PRIVILEGED_ACCESS: Approval records are written by the system on behalf of the requesting actor; the actor cannot write their own approval record under RLS.
  // AUDIT_REF: service-role-risk-register.md
  const supabase = runtime.privilegedDb.createClient({ routeId: "governance.approvals", operation: "create_approval", reason: "persist_approval_request", systemActor: "system", workspaceId: decision.scope.workspaceId });
  const payload = { decision_id: decision.decisionId, workspace_id: decision.scope.workspaceId, project_id: decision.scope.projectId, actor_user_id: decision.actor.userId, actor_agent_id: decision.actor.agentId, action: decision.matchedPolicy, requested_permission: decision.requiredPermission, required_approval_type: decision.requiredApprovalType, reviewer_role_required: decision.reviewerRoleRequired, status: "pending_approval", reason: decision.reason, risk_level: decision.riskLevel, trace: decision.trace, metadata: {}, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
  const { data, error } = await supabase.from("governance_approval_requests").upsert(payload, { onConflict: "decision_id" }).select("id").single();
  if (error) throw new Error(`create approval failed: ${error.message}`);
  return data;
}

export function explainGovernanceDecision(decision: GovernanceDecisionResult) { return `${decision.allowed ? "Allowed" : "Denied"}: ${decision.reason} (policy=${decision.matchedPolicy}, permission=${decision.requiredPermission}, decisionId=${decision.decisionId})`; }

// Returns the governance decision only — HTTP response construction belongs to the route layer.
// Callers must check decision.allowed to gate behavior; the response field previously returned
// a NextResponse, which was a PMFreak/Next.js concern that has been removed from this layer.
export async function enforceGovernanceAction(runtime: RuntimeContext, input: GovernanceEvaluationInput) { const decision = await evaluateGovernanceAction(runtime, input); if (decision.decision.includes("approval")) await createApprovalRequestFromDecision(runtime, decision); return { decision }; }
