import { createSupabaseServerClient } from "@/lib/supabase/server";
import { type Permission } from "@/lib/security/rbac";
import { AccessDeniedError, requireWorkspaceRole } from "@/lib/security/access-guards";
import { requireAuthenticatedUser } from "@/lib/security/server-authorization";
import { authorizeRuntimeAction, buildEnterpriseRuntimeRequest } from "@/aoc/runtime-consumer";
import { CAPABILITY_PERMISSION_TO_GOVERNANCE_ACTION, resolveGovernanceAction } from "@/lib/aoc/runtime/governance-actions";

// Named for this flow rather than after the canonical @aoc/protocol contracts:
// these are narrower PMFreak request/grant vocabularies, not canonical capability
// permissions or resource types. Enforced by scripts/check-governance-collisions.mjs.
export type CapabilityFlowPermission = "read" | "write" | "approve" | "manage" | "execute" | "delegate";
export type CapabilityFlowResourceType = "workspace" | "project" | "operational_memory" | "governance_object" | "ai_coprocess";

function nowIso() { return new Date().toISOString(); }

async function audit(workspaceId: string, eventType: "requested" | "approved" | "denied" | "revoked" | "expired" | "consumed", actorUserId: string, detail: Record<string, unknown>, ids: { requestId?: string; grantId?: string } = {}) {
  const supabase = await createSupabaseServerClient();
  await supabase.from("capability_audit_events").insert({ workspace_id: workspaceId, actor_user_id: actorUserId, request_id: ids.requestId ?? null, grant_id: ids.grantId ?? null, event_type: eventType, event_detail: detail });
}

export async function createCapabilityRequest(input: { workspaceId: string; targetResourceType: CapabilityFlowResourceType; targetResourceId: string; requestedPermission: CapabilityFlowPermission; requestedScope?: Record<string, unknown>; justification?: string; expiresAt?: string | null; }) {
  const { user } = await requireAuthenticatedUser();
  await requireWorkspaceRole(input.workspaceId, ["owner", "admin", "PM", "contributor", "executive_viewer", "external_stakeholder", "ai_agent"]);
  const supabase = await createSupabaseServerClient();

  const action = CAPABILITY_PERMISSION_TO_GOVERNANCE_ACTION[input.requestedPermission];
  let runtimeDecision: Awaited<ReturnType<typeof authorizeRuntimeAction>> | null = null;
  try {
    runtimeDecision = await authorizeRuntimeAction(
      buildEnterpriseRuntimeRequest({
        user,
        action,
        routeId: "createCapabilityRequest",
        workspaceId: input.workspaceId,
        projectId: input.targetResourceType === "project" ? input.targetResourceId : null,
        resourceType: input.targetResourceType,
        resourceId: input.targetResourceId,
        metadata: { requestedPermission: input.requestedPermission, justification: input.justification },
      }),
    );
  } catch {
    // Fail closed: runtime unavailable → deny auto-approval; persist as denied.
    runtimeDecision = null;
  }

  let initialStatus: "approved" | "pending" | "denied";
  if (runtimeDecision === null) {
    initialStatus = "denied";
  } else if (runtimeDecision.allowed) {
    initialStatus = "approved";
  } else {
    const requiredApprovalType =
      (runtimeDecision.runtimeMetadata as { requiredApprovalType?: string | null } | undefined)?.requiredApprovalType;
    initialStatus = requiredApprovalType ? "pending" : "denied";
  }

  const { data, error } = await supabase.from("capability_requests").insert({ workspace_id: input.workspaceId, requester_user_id: user.id, target_resource_type: input.targetResourceType, target_resource_id: input.targetResourceId, requested_permission: input.requestedPermission, requested_scope: input.requestedScope ?? {}, justification: input.justification ?? null, grant_expires_at: input.expiresAt ?? null, status: initialStatus }).select("id").single<{ id: string }>();
  if (error || !data) throw new Error(error?.message ?? "Failed to create capability request");

  if (runtimeDecision?.allowed) {
    await supabase.from("capability_requests").update({ status: "approved", evaluator_user_id: user.id, decided_at: nowIso(), updated_at: nowIso() }).eq("id", data.id);
    const { data: grant } = await supabase.from("capability_grants").insert({ capability_request_id: data.id, workspace_id: input.workspaceId, granted_user_id: user.id, granted_by_user_id: user.id, target_resource_type: input.targetResourceType, target_resource_id: input.targetResourceId, permission: input.requestedPermission, scope: input.requestedScope ?? {}, expires_at: input.expiresAt ?? null }).select("id").single<{ id: string }>();
    await audit(input.workspaceId, "approved", user.id, { autoApproved: true, runtimeDecisionId: runtimeDecision.decisionId, runtimeReason: runtimeDecision.reason }, { requestId: data.id, grantId: grant?.id });
    return data.id;
  }

  await audit(input.workspaceId, "requested", user.id, { targetResourceType: input.targetResourceType, targetResourceId: input.targetResourceId, requestedPermission: input.requestedPermission, runtimeDecision: runtimeDecision ? "deny" : "runtime_error", runtimeReason: runtimeDecision?.reason ?? "runtime_unavailable" }, { requestId: data.id });
  return data.id;
}

// evaluateCapabilityAccess delegates final authorization to the AOC Enterprise Runtime.
// Local DB grant evidence is incorporated by the runtime's registered PolicyEvaluatorPort adapter.
// Fails closed: if the runtime is unavailable or denies, access is denied with no local fallback.
export async function evaluateCapabilityAccess(input: { workspaceId: string; projectId?: string; permission: Permission }) {
  const { user } = await requireAuthenticatedUser();
  const action = resolveGovernanceAction(input.permission, input.projectId ? "project" : "workspace");
  let decision: Awaited<ReturnType<typeof authorizeRuntimeAction>>;
  try {
    decision = await authorizeRuntimeAction(
      buildEnterpriseRuntimeRequest({
        user,
        action,
        routeId: "evaluateCapabilityAccess",
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        resourceType: input.projectId ? "project" : "workspace",
        resourceId: input.projectId ?? input.workspaceId,
        metadata: { requestedPermission: input.permission },
      }),
    );
  } catch {
    // Fail closed: runtime unavailable or threw → deny access.
    throw new AccessDeniedError("Capability access denied: runtime authorization unavailable.", {
      reason: "runtime_unavailable",
      workspaceId: input.workspaceId,
      permission: input.permission,
      projectId: input.projectId,
    });
  }
  if (decision.allowed) {
    return { allowed: true as const, reason: decision.reason };
  }
  throw new AccessDeniedError("Capability access denied by enterprise runtime.", {
    reason: decision.reason,
    workspaceId: input.workspaceId,
    permission: input.permission,
    projectId: input.projectId,
  });
}
