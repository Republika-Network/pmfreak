// PMFreak host adapter for the AOC AccessVerificationPort.
//
// IMPORTANT BOUNDARY:
// This adapter is invoked FROM the Enterprise Runtime while that runtime is
// evaluating authority. It must therefore terminate at host-side identity,
// persistence, membership, RBAC, and agent-scope primitives.
//
// It MUST NOT call PMFreak access-guards that delegate back into the
// Enterprise Runtime, otherwise authorization becomes recursive.

import { getAuthUser } from "@/lib/auth";
import { PROJECT_ARCHIVED_CODE, PROJECT_MUTATING_PERMISSIONS, isArchivedProjectStatus } from "@/lib/projects/archived-project";
import { isArchivedProjectLifecycleOperation } from "@/lib/projects/archived-project-lifecycle";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AccessVerificationPort } from "@/lib/governance/authority/ports/access-verification";
import { GovernanceAccessDeniedError } from "@/lib/governance/authority/ports/access-verification";
import {
  ROLE_PERMISSION_MAP,
  WORKSPACE_ROLES,
  type Permission,
  type WorkspaceRole,
} from "@/lib/security/rbac";

const WORKSPACE_ROLE_SET = new Set<string>(WORKSPACE_ROLES);

function deny(
  message: string,
  context: Record<string, unknown>,
): never {
  throw new GovernanceAccessDeniedError(message, context);
}

function normalizeWorkspaceRole(rawRole: string): WorkspaceRole | null {
  // Persisted workspace_memberships currently uses the product vocabulary
  // owner/admin/pm/viewer. The canonical RBAC vocabulary uses PM and
  // external_stakeholder for the equivalent read-only role.
  const normalized =
    rawRole === "pm"
      ? "PM"
      : rawRole === "viewer"
        ? "external_stakeholder"
        : rawRole;

  return WORKSPACE_ROLE_SET.has(normalized)
    ? (normalized as WorkspaceRole)
    : null;
}

async function requireCurrentUser() {
  const user = await getAuthUser();

  if (!user) {
    deny("Unauthorized.", { reason: "unauthorized" });
  }

  return user;
}

async function requireDirectWorkspaceMembership(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    deny("Workspace membership lookup failed.", {
      workspaceId,
      userId,
      reason: "membership_lookup_failed",
    });
  }

  if (!data?.role) {
    deny("Workspace membership required.", {
      workspaceId,
      userId,
      reason: "missing_membership",
    });
  }

  const role = normalizeWorkspaceRole(String(data.role));

  if (!role) {
    deny("Workspace role is not recognized.", {
      workspaceId,
      userId,
      role: data.role,
      reason: "unsupported_workspace_role",
    });
  }

  return role;
}

function requireDirectPermission(
  role: WorkspaceRole,
  permission: string,
  context: Record<string, unknown>,
): void {
  const allowed = ROLE_PERMISSION_MAP[role]?.has(permission as Permission) ?? false;

  if (!allowed) {
    deny("Permission denied by workspace RBAC.", {
      ...context,
      role,
      permission,
      reason: "role_missing_permission",
    });
  }
}

export class PmfreakAccessVerificationAdapter
  implements AccessVerificationPort
{
  async requireWorkspaceMembership(workspaceId: string) {
    const user = await requireCurrentUser();

    const role = await requireDirectWorkspaceMembership(
      workspaceId,
      user.id,
    );

    return { role };
  }

  async requireProjectPermission(
    projectId: string,
    permission: string,
  ) {
    const user = await requireCurrentUser();
    const supabase = await createSupabaseServerClient();

    const { data: project, error } = await supabase
      .from("projects")
      .select("workspace_id, status")
      .eq("id", projectId)
      .maybeSingle();

    if (error || !project?.workspace_id) {
      deny("Project access denied.", {
        userId: user.id,
        projectId,
        reason: "project_not_found",
      });
    }

    const workspaceId = String(project.workspace_id);

    const role = await requireDirectWorkspaceMembership(
      workspaceId,
      user.id,
    );

    requireDirectPermission(role, permission, {
      userId: user.id,
      workspaceId,
      projectId,
    });

    // PD-25: an archived project is read-only. Checked after the role, so this refusal only
    // ever reaches an otherwise authorized writer. The only exception is the explicit lifecycle
    // scope (reactivation, permanent deletion, duplication — archived-project-lifecycle.ts),
    // which lifts this one rule and nothing above it.
    if (PROJECT_MUTATING_PERMISSIONS.has(permission) && isArchivedProjectStatus(project.status) && !isArchivedProjectLifecycleOperation()) {
      deny("Project is archived.", {
        userId: user.id,
        workspaceId,
        projectId,
        reason: PROJECT_ARCHIVED_CODE,
      });
    }

    return {
      role,
      workspaceId,
    };
  }

  async requireGovernancePermission(
    workspaceId: string,
    permission: string,
  ) {
    const user = await requireCurrentUser();

    const role = await requireDirectWorkspaceMembership(
      workspaceId,
      user.id,
    );

    requireDirectPermission(role, permission, {
      userId: user.id,
      workspaceId,
    });

    return { role };
  }

  async requireAgentScope(input: {
    workspaceId: string;
    agentId: string;
    permission: string;
    projectId?: string;
  }) {
    const user = await requireCurrentUser();

    // The human/session context must itself belong to the workspace. This is
    // an identity/binding check, not a second Enterprise Runtime decision.
    await requireDirectWorkspaceMembership(
      input.workspaceId,
      user.id,
    );

    const supabase = await createSupabaseServerClient();

    const { data: agent, error: agentError } = await supabase
      .from("ai_agents")
      .select("id,status")
      .eq("id", input.agentId)
      .eq("workspace_id", input.workspaceId)
      .maybeSingle();

    if (agentError || !agent) {
      deny("Agent access denied.", {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        reason: "agent_not_found",
      });
    }

    if (agent.status !== "active") {
      deny("Agent access denied.", {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        reason: agent.status === "revoked" ? "agent_revoked" : "agent_disabled",
      });
    }

    const resourceType = input.projectId ? "project" : "workspace";
    const resourceId = input.projectId ?? input.workspaceId;

    const { data: scopes, error: scopeError } = await supabase
      .from("ai_agent_scopes")
      .select("id,status,expires_at,permission,resource_type,resource_id")
      .eq("workspace_id", input.workspaceId)
      .eq("agent_id", input.agentId)
      .eq("status", "active")
      .eq("permission", input.permission)
      .eq("resource_type", resourceType)
      .eq("resource_id", resourceId)
      .limit(10);

    if (scopeError) {
      deny("Agent scope verification failed.", {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        permission: input.permission,
        projectId: input.projectId ?? null,
        reason: "agent_scope_lookup_failed",
      });
    }

    const nowIso = new Date().toISOString();

    const activeScope = (scopes ?? []).find(
      (scope) => !scope.expires_at || scope.expires_at > nowIso,
    );

    if (!activeScope) {
      const hasExpiredScope = (scopes ?? []).some(
        (scope) => scope.expires_at && scope.expires_at <= nowIso,
      );

      deny("Agent scope denied.", {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        permission: input.permission,
        projectId: input.projectId ?? null,
        reason: hasExpiredScope ? "scope_expired" : "scope_missing",
      });
    }

    return {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      permission: input.permission,
    };
  }
}