import { NextRequest, NextResponse } from "next/server";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { requireAuthenticatedUser, requireWorkspaceMember } from "@/lib/security/server-authorization";
import { PM_ASSIGNMENT_SELECTABLE_COLUMNS } from "@/lib/db/database-contract";
import type { PMAssignmentRow } from "@/lib/db/database-contract";
import { unassignProjectManager } from "@/lib/pm-registry";
import type { PMAssignmentType } from "@/lib/pm-registry";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getProjectWorkspaceId } from "@/lib/projects/project-admin-service";

const ROUTE = "/api/projects/[id]/pm-assignments/[assignmentId]";

type Props = { params: Promise<{ id: string; assignmentId: string }> };

/**
 * Removes ONE assignment from ONE project.
 *
 * The workspace is the PROJECT'S, read from `projects.workspace_id`, exactly as
 * in the collection route beside this one — not `getUserWorkspaces(user.id)[0]`,
 * which this handler used to trust. That was the caller's first workspace in
 * whatever order the query returned, so for anyone in more than one workspace a
 * removal on a project in workspace B authorized against an unrelated workspace A:
 * the assignment lookup below is filtered by `workspace_id` too, so the request
 * 404'd on an assignment the caller could plainly see, and `unassignProjectManager`
 * was being told the wrong tenant.
 *
 * Both filters below still stand, and now they agree: the assignment must belong
 * to THIS project AND to that project's own workspace, so a cross-workspace
 * mismatch removes nothing rather than mutating another tenant's row. A project
 * the caller has no membership in reads as `null` through their own RLS-scoped
 * client and answers the same 404 as one that does not exist.
 */
export async function DELETE(_request: NextRequest, { params }: Props) {
  try {
    const { user } = await requireAuthenticatedUser();
    const { id: projectId, assignmentId } = await params;

    const workspaceId = await getProjectWorkspaceId(projectId);
    if (!workspaceId) {
      return NextResponse.json({ ok: false, error: { code: "not_found", message: "Assignment not found." } }, { status: 404 });
    }
    await requireWorkspaceMember(workspaceId);

    const supabase = await createSupabaseServerClient();
    const ASSIGN_COLS = PM_ASSIGNMENT_SELECTABLE_COLUMNS.join(",");

    // Fetch assignment to verify ownership and get pm_id/type
    const { data: assignment } = await supabase
      .from("pm_assignments")
      .select(ASSIGN_COLS)
      .eq("id", assignmentId)
      .eq("project_id", projectId)
      .eq("workspace_id", workspaceId)
      .maybeSingle<PMAssignmentRow>();

    if (!assignment) {
      return NextResponse.json({ ok: false, error: { code: "not_found", message: "Assignment not found." } }, { status: 404 });
    }

    if (assignment.removed_at !== null) {
      return NextResponse.json({ ok: false, error: { code: "already_removed", message: "Assignment is already removed." } }, { status: 409 });
    }

    const result = await unassignProjectManager({
      workspaceId,
      pmId: assignment.pm_id,
      projectId,
      assignmentType: assignment.assignment_type as PMAssignmentType,
      actorId: user.id,
    });

    if (!result.ok) {
      const status = result.failureClass === "not_found" ? 404 : 500;
      return NextResponse.json({ ok: false, error: { code: result.failureClass, message: result.error } }, { status });
    }
    return NextResponse.json({ ok: true, data: result.data });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (String(error.metadata.reason) === "unauthorized") {
        return denyResponse({ status: 401, routeId: ROUTE, message: "Unauthorized", reason: "unauthorized" });
      }
      return denyFromAccessError(error, { status: 403, routeId: ROUTE, message: "Forbidden" });
    }
    throw error;
  }
}
