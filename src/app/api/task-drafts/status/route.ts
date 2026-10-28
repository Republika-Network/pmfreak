import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireAuthenticatedUser, requireProjectAccess } from "@/lib/security/server-authorization";
import type { TaskDraftRow, TaskDraftStatus } from "@/lib/db/database-contract";

const TASK_DRAFT_COLS =
  "id,workspace_id,project_id,recommended_action_id,raid_item_id,title,description,draft_status,suggested_owner,suggested_due_date,suggested_due_window,priority,source_type,source_payload,acceptance_criteria,checklist,confidence_score,created_by,created_at,updated_at";

const ALLOWED_STATUS_UPDATES: TaskDraftStatus[] = ["reviewed", "approved", "discarded"];

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return Response.json({ ok: false, error: "Request body required." }, { status: 400 });
  }

  const { draftId, status, reason } = body as Record<string, unknown>;

  if (!draftId || typeof draftId !== "string") {
    return Response.json({ ok: false, error: "draftId is required.", failureClass: "validation_failed" }, { status: 400 });
  }
  if (!status || typeof status !== "string") {
    return Response.json({ ok: false, error: "status is required.", failureClass: "validation_failed" }, { status: 400 });
  }
  if (!ALLOWED_STATUS_UPDATES.includes(status as TaskDraftStatus)) {
    return Response.json(
      { ok: false, error: `status must be one of: ${ALLOWED_STATUS_UPDATES.join(", ")}.`, failureClass: "validation_failed" },
      { status: 400 }
    );
  }

  let userId: string;
  try {
    const { user } = await requireAuthenticatedUser();
    userId = user.id;
  } catch {
    return Response.json({ ok: false, error: "Unauthenticated.", failureClass: "unauthenticated" }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: draft, error: loadError } = await supabase
    .from("task_drafts")
    .select("id,project_id,workspace_id,draft_status")
    .eq("id", draftId)
    .maybeSingle<{ id: string; project_id: string; workspace_id: string; draft_status: string }>();

  if (loadError) {
    return Response.json({ ok: false, error: "Unable to load draft.", failureClass: "persistence_failed" }, { status: 500 });
  }
  if (!draft) {
    return Response.json({ ok: false, error: "Task draft not found.", failureClass: "not_found" }, { status: 404 });
  }

  try {
    // Changing a draft's status is a project write (F22-B); viewers only read drafts.
    await requireProjectAccess(draft.project_id, "write");
  } catch (error) {
    if (error instanceof Error && error.message.includes("denied")) {
      return Response.json({ ok: false, error: "Access denied.", failureClass: "unauthorized" }, { status: 403 });
    }
    throw error;
  }

  console.info("task_draft.status_update.started", {
    draftId: draft.id,
    workspaceId: draft.workspace_id,
    projectId: draft.project_id,
    currentStatus: draft.draft_status,
    requestedStatus: status,
    actorUserId: userId,
  });

  const { data: updated, error: updateError } = await supabase
    .from("task_drafts")
    .update({ draft_status: status, updated_at: new Date().toISOString() })
    .eq("id", draftId)
    .select(TASK_DRAFT_COLS)
    .single<TaskDraftRow>();

  if (updateError || !updated) {
    console.error("task_draft.status_update.failed", {
      draftId: draft.id,
      workspaceId: draft.workspace_id,
      projectId: draft.project_id,
      requestedStatus: status,
      error: updateError?.message ?? "no row returned",
    });
    return Response.json({ ok: false, error: "Unable to update draft status.", failureClass: "persistence_failed" }, { status: 500 });
  }

  console.info("task_draft.status_update.completed", {
    draftId: draft.id,
    workspaceId: draft.workspace_id,
    projectId: draft.project_id,
    previousStatus: draft.draft_status,
    newStatus: status,
    reason: typeof reason === "string" ? reason : null,
    actorUserId: userId,
  });

  return Response.json({ ok: true, draft: updated });
}
