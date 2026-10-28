import { NextResponse } from "next/server";
import { isArchivedProjectStatus, projectArchivedResponse } from "@/lib/projects/archived-project";
import { getAuthUser } from "@/lib/auth";
import { requireWorkspaceMember } from "@/lib/security/server-authorization";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { safeInternalErrorResponse } from "@/lib/security/safe-route-error";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseVaultIntakeStore, ingestVaultDocument, type VaultDocumentSourceType } from "@/lib/vault/intake";
import { materializeRecommendedActions } from "@/lib/recommended-actions";
import { canWriteProjectData, normalizeWorkspaceRole, type WorkspaceRole } from "@/lib/workspace-access";

const ROUTE_ID = "/api/vault/intake";

const SOURCE_TYPES = new Set<VaultDocumentSourceType>([
  "meeting_notes",
  "transcript",
  "email",
  "project_update",
  "risk_log",
  "issue_log",
  "action_log",
  "decision_log",
  "generic_note",
]);

export type VaultIntakeDeps = {
  getAuthUser: typeof getAuthUser;
  requireWorkspaceMember: typeof requireWorkspaceMember;
  resolveWorkspaceRole: (workspaceId: string, userId: string) => Promise<WorkspaceRole | null>;
  createSupabaseServerClient: typeof createSupabaseServerClient;
  ingestVaultDocument: typeof ingestVaultDocument;
  materializeRecommendedActions: typeof materializeRecommendedActions;
};

/** The caller's own membership role, read through their RLS-scoped client. */
async function resolveWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_memberships")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle<{ role: string }>();
  if (error) throw new Error(error.message);
  return normalizeWorkspaceRole(data?.role);
}

const defaultDeps: VaultIntakeDeps = {
  getAuthUser,
  requireWorkspaceMember,
  resolveWorkspaceRole,
  createSupabaseServerClient,
  ingestVaultDocument,
  materializeRecommendedActions,
};

/**
 * Testable core of the route handler (same DI pattern as the billing
 * routes): `deps` defaults to the real implementations; tests inject fakes
 * so the authorization ordering can be verified without a live backend.
 */
export async function handleVaultIntake(request: Request, depsOverride: Partial<VaultIntakeDeps> = {}): Promise<Response> {
  const deps: VaultIntakeDeps = { ...defaultDeps, ...depsOverride };
  const user = await deps.getAuthUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const projectId = typeof body.projectId === "string" ? body.projectId : null;
  const rawContent = typeof body.rawContent === "string" ? body.rawContent : "";
  const title = typeof body.title === "string" ? body.title : undefined;
  const requestedSourceType = typeof body.sourceType === "string" && SOURCE_TYPES.has(body.sourceType as VaultDocumentSourceType)
    ? body.sourceType as VaultDocumentSourceType
    : "meeting_notes";

  if (!workspaceId || !rawContent.trim()) return NextResponse.json({ error: "workspace_and_content_required" }, { status: 400 });

  // F-13 (Pilot Gate Sprint 01): explicit app-layer membership check on the
  // client-supplied workspaceId, before any DB access — defense-in-depth on
  // top of RLS, matching the pm-registry/execution-tasks route pattern.
  try {
    await deps.requireWorkspaceMember(workspaceId);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }
    return safeInternalErrorResponse(ROUTE_ID, error);
  }

  // F22-B: intake stores documents, signals and RAID items — document upload is an owner /
  // admin / pm capability (rbac `upload_documents`); a viewer only reads. Also enforced by RLS.
  let role: WorkspaceRole | null;
  try {
    role = await deps.resolveWorkspaceRole(workspaceId, user.id);
  } catch (error) {
    return safeInternalErrorResponse(ROUTE_ID, error);
  }
  if (!role || !canWriteProjectData(role)) {
    return NextResponse.json({ error: "insufficient_role" }, { status: 403 });
  }

  const supabase = await deps.createSupabaseServerClient();
  if (projectId) {
    const { data: project, error } = await supabase
      .from("projects")
      .select("id, workspace_id, status")
      .eq("id", projectId)
      .maybeSingle<{ id: string; workspace_id: string; status: string }>();
    if (error || !project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
    if (project.workspace_id !== workspaceId) return NextResponse.json({ error: "workspace_mismatch" }, { status: 403 });
    // PD-25: an archived project takes no new vault intake.
    if (isArchivedProjectStatus(project.status)) return projectArchivedResponse();
  }

  const result = await deps.ingestVaultDocument({
    workspaceId,
    companyId: user.companyId,
    projectId,
    rawContent,
    title,
    sourceType: requestedSourceType,
    createdBy: user.id,
    store: createSupabaseVaultIntakeStore(supabase),
  });

  // Extracted RAID items become recommended actions (Accept/Reject/Defer in
  // the Command Center "Needs You" queue). Best-effort: intake already
  // succeeded, so a materialization failure must not fail the request.
  let recommendedActionsCreated = 0;
  if (projectId && result.ingestionStatus !== "document_persistence_failed" && result.ingestionStatus !== "extraction_failed") {
    try {
      const materialization = await deps.materializeRecommendedActions({ workspaceId, projectId, supabase });
      recommendedActionsCreated = materialization.created;
    } catch (error) {
      console.error("vault_intake.recommended_actions_failed", {
        projectId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  const status = result.ingestionStatus === "document_persistence_failed" ? 500 : 200;
  return NextResponse.json({ ...result, recommendedActionsCreated }, { status });
}

export async function POST(request: Request) {
  return handleVaultIntake(request);
}
