import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { requireAuthenticatedUser, requireProjectAccessAllowingArchived } from "@/lib/security/server-authorization";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { safeLegacyErrorResponse } from "@/lib/security/safe-route-error";
import { duplicateProject } from "@/lib/projects/project-admin-service";

const ROUTE_ID = "/api/projects/[id]/duplicate";

type Params = { params: Promise<{ id: string }> };

// Same statuses as POST /api/projects: a duplicate is a create (PD-14).
const DUPLICATE_FAILURE_STATUS = { upgrade_required: 402, insufficient_role: 403, not_found: 404 } as const;

export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const projectId = id.trim();
  if (!projectId) return Response.json({ error: "projectId is required." }, { status: 400 });

  try {
    const { user } = await requireAuthenticatedUser();
    // PD-25: duplicating reads the source and writes a new project, so an archived source is fine.
    await requireProjectAccessAllowingArchived(projectId, "write");

    const supabase = await createSupabaseServerClient();
    const { data: scoped } = await supabase
      .from("projects")
      .select("id, workspace_id")
      .eq("id", projectId)
      .maybeSingle<{ id: string; workspace_id: string }>();
    if (!scoped) return Response.json({ error: "Project not found." }, { status: 404 });

    const result = await duplicateProject(scoped.workspace_id, projectId, user.id);
    if (!result.ok) {
      return Response.json({ error: result.error, failureClass: result.failureClass }, { status: DUPLICATE_FAILURE_STATUS[result.failureClass] });
    }
    return Response.json({ project: result.project }, { status: 201 });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (String(error.metadata.reason) === "unauthorized") {
        return denyResponse({ status: 401, routeId: ROUTE_ID, message: "Unauthorized", reason: "unauthorized" });
      }
      return denyFromAccessError(error, { status: 403, routeId: ROUTE_ID, message: "Invalid project context.", projectId, requestedPermission: "write", deniedPermission: "write", eventType: "project_scope_violation" });
    }
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to duplicate project.");
  }
}
