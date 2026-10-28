import { NextResponse } from "next/server";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser, requireProjectAccess } from "@/lib/security/server-authorization";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { safeLegacyErrorResponse } from "@/lib/security/safe-route-error";
import { generateAndPersistOperationalGovernanceBrief } from "@/lib/projects/first-insight";

const ROUTE_ID = "/api/projects/[id]/operational-governance-brief";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Regenerates (overwrites) the project's operational governance brief.
 *
 * A mutation, so it requires the project WRITE permission — owner, admin or pm of the
 * project's workspace — before anything is read or written (SEC-W3-1: a viewer could
 * rewrite the brief because this route only authenticated). RLS on
 * operational_governance_briefs enforces the same writer rule underneath
 * (20261029000000_sec_w3_1_governance_brief_writers.sql).
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const projectId = id.trim();
  if (!projectId) return NextResponse.json({ error: "project_not_found" }, { status: 404 });

  try {
    const { user } = await requireAuthenticatedUser();
    await requireProjectAccess(projectId, "write");

    const body = await request.json().catch(() => ({}));
    const requestedWorkspaceId = typeof body.workspaceId === "string" ? body.workspaceId : null;
    const supabase = await createSupabaseServerClient();

    const { data: project, error } = await supabase
      .from("projects")
      .select("id, workspace_id, onboarding_payload")
      .eq("id", projectId)
      .maybeSingle<{ id: string; workspace_id: string; onboarding_payload: Record<string, unknown> | null }>();

    if (error || !project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
    if (requestedWorkspaceId && requestedWorkspaceId !== project.workspace_id) {
      return NextResponse.json({ error: "workspace_mismatch" }, { status: 403 });
    }

    const result = await generateAndPersistOperationalGovernanceBrief({
      workspaceId: project.workspace_id,
      projectId: project.id,
      projectOnboardingPayload: project.onboarding_payload,
      createdBy: user.id,
      supabase,
    });

    if (!result.ok) return NextResponse.json({ error: result.error, brief: result.brief }, { status: 500 });
    return NextResponse.json({ brief: result.brief });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (String(error.metadata.reason) === "unauthorized") {
        return denyResponse({ status: 401, routeId: ROUTE_ID, message: "Unauthorized", reason: "unauthorized" });
      }
      return denyFromAccessError(error, { status: 403, routeId: ROUTE_ID, message: "Invalid project context.", projectId, requestedPermission: "write", deniedPermission: "write", eventType: "project_scope_violation" });
    }
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to regenerate the governance brief.");
  }
}
