import { NextRequest, NextResponse } from "next/server";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { requireAuthenticatedUser, requireWorkspaceMember } from "@/lib/security/server-authorization";
import {
  assignProjectManager,
  listProjectAssignments,
  PM_ASSIGNMENT_TYPES,
} from "@/lib/pm-registry";
import type { PMAssignmentType } from "@/lib/pm-registry";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getProjectWorkspaceId } from "@/lib/projects/project-admin-service";
import { PROJECT_MANAGER_SELECTABLE_COLUMNS } from "@/lib/db/database-contract";
import type { ProjectManagerRow } from "@/lib/db/database-contract";

/**
 * WHY THE WORKSPACE IS READ FROM THE PROJECT ROW
 * ----------------------------------------------
 * These handlers used to derive `workspaceId` from `getUserWorkspaces(user.id)[0]`
 * — the caller's FIRST workspace, in whatever order that query returned. A PM
 * assignment is a fact about ONE project, and a project carries its own workspace
 * as a NOT NULL column, so "the first workspace this user happens to belong to"
 * was never the authority for it. For anyone in more than one workspace it was a
 * coin flip: canonical Project Home could correctly render a project in workspace
 * B while every assignment read and write on the same page authorized against an
 * unrelated workspace A — the project then failed the `.eq("workspace_id", …)`
 * filter and answered 404 for a project the caller could plainly see, and the
 * same derivation was handed to `assignProjectManager` /
 * `unassignProjectManager`, so a write could be scoped to the wrong tenant.
 *
 * `getProjectWorkspaceId` is the existing lookup for exactly this ("the
 * authoritative source for scope derivation — never trust a caller-supplied or
 * cookie-derived workspaceId for an entity that carries its own"). Reusing it
 * rather than re-querying here keeps project ancestry to one definition, the same
 * rule `resolveRoutedProject` and `POST /api/execution-tasks` already follow.
 *
 * WHY A NULL ANSWER IS THE 404, AND WHY THAT IS THE BOUNDARY
 * ---------------------------------------------------------
 * It reads through `createSupabaseServerClient()`, which carries the caller's own
 * session, and the `projects` select policy ("workspace members can select
 * projects", 20260512160000_workspace_authorization_rewrite.sql) admits a row only
 * when a `workspace_memberships` row exists for `auth.uid()`. A project the caller
 * has no membership for therefore reads as `null` — indistinguishable from one
 * that does not exist — and the handler answers the same 404 it always did. No
 * service-role access is introduced and no new authorization model is:
 * `requireWorkspaceMember` still runs, on the derived workspace, as the same
 * application-layer defence in depth it was before.
 */
const ROUTE = "/api/projects/[id]/pm-assignments";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  try {
    await requireAuthenticatedUser();
    const { id: projectId } = await params;

    // The project decides the workspace; the workspace never decides the project.
    const workspaceId = await getProjectWorkspaceId(projectId);
    if (!workspaceId) {
      return NextResponse.json({ ok: false, error: { code: "not_found", message: "Project not found in this workspace." } }, { status: 404 });
    }
    await requireWorkspaceMember(workspaceId);

    const supabase = await createSupabaseServerClient();

    const result = await listProjectAssignments(workspaceId, projectId);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: { code: result.failureClass, message: result.error } }, { status: 500 });
    }

    // Enrich with PM display info — fetch distinct PMs in one query
    const pmIds = [...new Set(result.data.map((a) => a.pm_id))];
    const pmMap: Record<string, { display_name: string; email: string }> = {};
    if (pmIds.length > 0) {
      const PM_COLS = PROJECT_MANAGER_SELECTABLE_COLUMNS.join(",");
      const { data: pms } = await supabase
        .from("project_managers")
        .select(PM_COLS)
        .in("id", pmIds)
        .eq("workspace_id", workspaceId)
        .returns<ProjectManagerRow[]>();
      if (pms) {
        for (const pm of pms) {
          pmMap[pm.id] = { display_name: pm.display_name, email: pm.email };
        }
      }
    }

    const enriched = result.data.map((a) => ({
      ...a,
      pm_display_name: pmMap[a.pm_id]?.display_name ?? null,
      pm_email: pmMap[a.pm_id]?.email ?? null,
    }));

    return NextResponse.json({ ok: true, data: enriched });
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

export async function POST(request: NextRequest, { params }: Props) {
  try {
    const { user } = await requireAuthenticatedUser();
    const { id: projectId } = await params;

    // Same ancestry rule as the read above: this write is authorized against the
    // project's own workspace, so it can never land in another tenant's.
    const workspaceId = await getProjectWorkspaceId(projectId);
    if (!workspaceId) {
      return NextResponse.json({ ok: false, error: { code: "not_found", message: "Project not found in this workspace." } }, { status: 404 });
    }
    await requireWorkspaceMember(workspaceId);

    let body: { pmId?: unknown; assignmentType?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return NextResponse.json({ ok: false, error: { code: "invalid_body", message: "Request body must be valid JSON." } }, { status: 400 });
    }

    if (typeof body.pmId !== "string" || !body.pmId.trim()) {
      return NextResponse.json({ ok: false, error: { code: "validation", message: "pmId is required." } }, { status: 400 });
    }
    if (!PM_ASSIGNMENT_TYPES.includes(body.assignmentType as PMAssignmentType)) {
      return NextResponse.json({ ok: false, error: { code: "validation", message: `assignmentType must be one of: ${PM_ASSIGNMENT_TYPES.join(", ")}.` } }, { status: 400 });
    }

    const result = await assignProjectManager({
      workspaceId,
      pmId: body.pmId,
      projectId,
      assignmentType: body.assignmentType as PMAssignmentType,
      actorId: user.id,
    });

    if (!result.ok) {
      const httpStatus =
        result.failureClass === "PM_ACTIVE_PROJECT_LIMIT_EXCEEDED" ? 422
        : result.failureClass === "validation" ? 409
        : result.failureClass === "not_found" ? 404
        : 500;
      return NextResponse.json(
        { ok: false, error: { code: result.failureClass, message: result.error, details: result.details ?? null } },
        { status: httpStatus }
      );
    }
    return NextResponse.json({ ok: true, data: result.data }, { status: 201 });
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
