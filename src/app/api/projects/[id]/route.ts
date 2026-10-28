import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { requireAuthenticatedUser, requireProjectAccess, requireProjectAccessAllowingArchived } from "@/lib/security/server-authorization";
import { isArchivedProjectStatus } from "@/lib/projects/archived-project";
import { drainDeletedProjectStorage } from "@/lib/project-evidence/deleted-project-storage-cleanup";
import { requireWorkspaceRole as requireWorkspaceMinimumRole } from "@/lib/workspace-access";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { safeLegacyErrorResponse } from "@/lib/security/safe-route-error";
import {
  ProjectHasRetainedHistoryError,
  deleteProject,
  normalizeProjectMethodology,
  normalizeProjectStatus,
  updateProject,
  type UpdateProjectInput,
} from "@/lib/projects/project-admin-service";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  let userId: string | null = null;
  const { id } = await params;
  const projectId = id.trim();

  if (!projectId) {
    return Response.json({ error: "projectId is required." }, { status: 400 });
  }

  try {
    const { user } = await requireAuthenticatedUser();
    userId = user.id;
    await requireProjectAccess(projectId, "read");
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (String(error.metadata.reason) === "unauthorized") {
        return denyResponse({ status: 401, routeId: "/api/projects/[id]", message: "Unauthorized", reason: "unauthorized" });
      }
      return denyFromAccessError(error, { status: 403, routeId: "/api/projects/[id]", message: "Invalid project context.", actorUserId: userId, projectId, requestedPermission: "read", deniedPermission: "read", eventType: "project_scope_violation" });
    }
    throw error;
  }

  const supabase = await createSupabaseServerClient();
  const { data: project } = await supabase.from("projects").select("id, name").eq("id", projectId).maybeSingle();

  if (!project) {
    return denyResponse({ status: 404, routeId: "/api/projects/[id]", message: "Project not found.", reason: "project_not_found_or_out_of_scope", actorUserId: userId, projectId, requestedPermission: "read", deniedPermission: "read", eventType: "project_scope_violation" });
  }

  return Response.json(project);
}

// allowArchived: PD-25 keeps an archived project read-only, except for reactivation and
// permanent deletion (requireProjectAccessAllowingArchived).
async function authorizeWrite(projectIdRaw: string, { allowArchived = false }: { allowArchived?: boolean } = {}) {
  const projectId = projectIdRaw.trim();
  if (!projectId) {
    return { error: Response.json({ error: "projectId is required." }, { status: 400 }) } as const;
  }
  try {
    const { user } = await requireAuthenticatedUser();
    if (allowArchived) await requireProjectAccessAllowingArchived(projectId, "write");
    else await requireProjectAccess(projectId, "write");
    return { user, projectId } as const;
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (String(error.metadata.reason) === "unauthorized") {
        return { error: denyResponse({ status: 401, routeId: "/api/projects/[id]", message: "Unauthorized", reason: "unauthorized" }) } as const;
      }
      return {
        error: denyFromAccessError(error, { status: 403, routeId: "/api/projects/[id]", message: "Invalid project context.", projectId, requestedPermission: "write", deniedPermission: "write", eventType: "project_scope_violation" }),
      } as const;
    }
    throw error;
  }
}

async function loadScopedProject(projectId: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("projects")
    .select("id, workspace_id")
    .eq("id", projectId)
    .maybeSingle<{ id: string; workspace_id: string }>();
  return data ?? null;
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  // An archived project accepts exactly one kind of edit: leaving `archived` (reactivation).
  const requestedStatus = body.status === undefined ? null : normalizeProjectStatus(body.status);
  const reactivating = requestedStatus !== null && !isArchivedProjectStatus(requestedStatus);
  const authorized = await authorizeWrite(id, { allowArchived: reactivating });
  if ("error" in authorized) return authorized.error;

  const scoped = await loadScopedProject(authorized.projectId);
  if (!scoped) return Response.json({ error: "Project not found." }, { status: 404 });

  const patch: UpdateProjectInput = {};

  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) return Response.json({ error: "Project name cannot be empty." }, { status: 400 });
    patch.name = name;
  }
  if (body.description !== undefined) {
    patch.description = typeof body.description === "string" && body.description.trim() ? body.description.trim() : null;
  }
  if (body.status !== undefined) {
    const status = normalizeProjectStatus(body.status);
    if (!status) return Response.json({ error: "Invalid project status." }, { status: 400 });
    patch.status = status;
  }
  if (body.methodology !== undefined) {
    if (body.methodology === null) {
      patch.methodology = null;
    } else {
      const methodology = normalizeProjectMethodology(body.methodology);
      if (!methodology) return Response.json({ error: "Invalid methodology." }, { status: 400 });
      patch.methodology = methodology;
    }
  }
  if (body.icon !== undefined) patch.icon = typeof body.icon === "string" && body.icon.trim() ? body.icon.trim() : null;
  if (body.color !== undefined) patch.color = typeof body.color === "string" && body.color.trim() ? body.color.trim() : null;
  if (body.pmoId !== undefined) {
    if (body.pmoId !== null && typeof body.pmoId !== "string") {
      return Response.json({ error: "Invalid pmoId." }, { status: 400 });
    }
    patch.pmoId = body.pmoId as string | null;
  }
  if (body.ownerUserId !== undefined) {
    if (typeof body.ownerUserId !== "string" || !body.ownerUserId.trim()) {
      return Response.json({ error: "Invalid ownerUserId." }, { status: 400 });
    }
    const ownerUserId = body.ownerUserId.trim();
    // Ownership must land on an actual workspace member — otherwise a
    // project could be silently reassigned to a user with no relationship
    // to the workspace, breaking every downstream "assigned PM" surface.
    const supabase = await createSupabaseServerClient();
    const { data: targetMembership } = await supabase
      .from("workspace_memberships")
      .select("user_id")
      .eq("workspace_id", scoped.workspace_id)
      .eq("user_id", ownerUserId)
      .maybeSingle();
    if (!targetMembership) {
      return Response.json({ error: "New owner must be a member of this workspace." }, { status: 400 });
    }
    patch.ownerUserId = ownerUserId;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "No valid fields to update." }, { status: 400 });
  }

  try {
    const project = await updateProject(scoped.workspace_id, authorized.projectId, patch);
    return Response.json({ project });
  } catch (error) {
    return safeLegacyErrorResponse("/api/projects/[id]", error, "Unable to update project.");
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  // Permanent deletion is the step after archival, so it is allowed for an archived project.
  const authorized = await authorizeWrite(id, { allowArchived: true });
  if ("error" in authorized) return authorized.error;

  const scoped = await loadScopedProject(authorized.projectId);
  if (!scoped) return Response.json({ error: "Project not found." }, { status: 404 });

  // Hard-deleting a project cascades through documents, tasks, risks, and
  // conversations with no way back — require at least admin. The projects
  // table's DELETE RLS policy enforces the same owner/admin rule (F21,
  // 20261024000000_project_data_role_aware_rls.sql); this check answers with
  // a clean 403 first.
  try {
    await requireWorkspaceMinimumRole(scoped.workspace_id, "admin");
  } catch {
    return denyResponse({ status: 403, routeId: "/api/projects/[id]", message: "Forbidden", reason: "insufficient_role", actorUserId: authorized.user.id, projectId: authorized.projectId, eventType: "project_scope_violation" });
  }

  try {
    await deleteProject(scoped.workspace_id, authorized.projectId);
  } catch (error) {
    if (error instanceof ProjectHasRetainedHistoryError) {
      return Response.json({ error: error.message, code: "project_has_retained_history" }, { status: 409 });
    }
    return safeLegacyErrorResponse("/api/projects/[id]", error, "Unable to delete project.");
  }

  // PD-26: the delete enqueued this project's Storage cleanup in the same transaction. Remove the
  // objects now; anything that fails stays queued and is retried by the next drain.
  let storageCleanup: "completed" | "pending" = "pending";
  try {
    const summary = await drainDeletedProjectStorage({ projectId: authorized.projectId });
    storageCleanup = summary.pending === 0 ? "completed" : "pending";
    void drainDeletedProjectStorage({ maxJobs: 10 }).catch(() => {}); // earlier pending jobs, best-effort
  } catch (error) {
    console.warn("[storage_cleanup] drain_failed_after_project_delete", { projectId: authorized.projectId, error: error instanceof Error ? error.message : "unknown" });
  }
  return Response.json({ deleted: true, storageCleanup });
}
