import { getAuthUser, type AuthUserContext } from "@/lib/auth";
import { AccessDeniedError } from "@/lib/security/access-guards";
import type { Permission, WorkspaceRole } from "@/lib/security/rbac";
import { authorizeRuntimeAction, buildEnterpriseRuntimeRequest } from "@/aoc/runtime-consumer";
import { resolveGovernanceAction } from "@/lib/aoc/runtime/governance-actions";

export type AuthenticatedContext = { user: AuthUserContext };

export async function requireAuthenticatedUser(): Promise<AuthenticatedContext> {
  const user = await getAuthUser();
  if (!user) {
    throw new AccessDeniedError("Unauthorized.", { reason: "unauthorized" });
  }
  return { user };
}

export async function requireWorkspaceContext(workspaceId: string | null | undefined) {
  const normalizedWorkspaceId = workspaceId?.trim();
  if (!normalizedWorkspaceId) {
    throw new AccessDeniedError("Workspace context required.", { reason: "workspace_missing" });
  }
  return { workspaceId: normalizedWorkspaceId };
}

export async function requireWorkspaceMember(workspaceId: string) {
  return evaluateCapability({ permission: "read", workspaceId });
}

export async function requireWorkspaceRole(workspaceId: string, _allowedRoles: WorkspaceRole[]) {
  return evaluateCapability({ permission: "manage_workspace", workspaceId });
}

export async function requireProjectAccess(projectId: string, permission: Permission = "read") {
  return evaluateCapability({ projectId, permission });
}

export async function requireResourceWorkspaceAccess(input: { workspaceId?: string; projectId?: string; permission?: Permission }) {
  if (input.projectId) return requireProjectAccess(input.projectId, input.permission ?? "read");
  if (input.workspaceId) return requireWorkspaceMember(input.workspaceId);
  throw new AccessDeniedError("Scoped access requires workspaceId or projectId.", { reason: "scope_missing" });
}

export function requireSystemOrWebhookSecret(receivedSecret: string | null | undefined, expectedSecret: string | undefined) {
  if (!expectedSecret || !receivedSecret || receivedSecret !== expectedSecret) {
    throw new AccessDeniedError("Invalid webhook authorization.", { reason: "invalid_webhook_secret" });
  }
}

export type CapabilityRequirement = { permission: Permission; workspaceId?: string; projectId?: string };

export async function evaluateCapability(requirement: CapabilityRequirement) {
  const { user } = await requireAuthenticatedUser();
  const resourceType = requirement.projectId ? "project" : "workspace";
  const resourceId = requirement.projectId ?? requirement.workspaceId ?? null;
  const decision = await authorizeRuntimeAction(
    buildEnterpriseRuntimeRequest({
      user,
      // Scope-aware (SIT-024): a workspace-only `read` is "workspace.read"; with a
      // projectId it stays the project-scoped "project.read".
      action: resolveGovernanceAction(requirement.permission, resourceType),
      routeId: "server-authorization.evaluateCapability",
      workspaceId: requirement.workspaceId ?? user.companyId ?? null,
      projectId: requirement.projectId ?? null,
      resourceType,
      resourceId,
      metadata: { requestedPermission: requirement.permission },
    }),
  );

  if (decision.allowed) return { allowed: true as const, reason: decision.reason, evaluation: decision };
  throw new AccessDeniedError("Capability denied by enterprise runtime.", { reason: decision.reason, evaluation: decision });
}

export async function requireCapability(requirement: CapabilityRequirement) {
  return evaluateCapability(requirement);
}
