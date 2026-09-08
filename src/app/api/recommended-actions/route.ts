import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { requireAuthenticatedUser, requireProjectAccess } from "@/lib/security/server-authorization";

const normalizeParam = (request: Request, key: string) =>
  new URL(request.url).searchParams.get(key)?.trim() ?? "";

export async function GET(request: Request) {
  let userId: string | null = null;
  const projectId = normalizeParam(request, "projectId");
  const raidItemId = normalizeParam(request, "raidItemId");
  const status = normalizeParam(request, "status");

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
        return denyResponse({ status: 401, routeId: "/api/recommended-actions", message: "Unauthorized", reason: "unauthorized" });
      }
      return denyFromAccessError(error, {
        status: 403,
        routeId: "/api/recommended-actions",
        message: "Invalid project context.",
        actorUserId: userId,
        projectId,
        requestedPermission: "read",
        deniedPermission: "read",
        eventType: "project_scope_violation",
      });
    }
    throw error;
  }

  /**
   * Whether this actor may DECIDE these actions, evaluated by the same server authorization
   * boundary the write route enforces.
   *
   * `PATCH /api/recommended-actions/decision` requires project WRITE access, so a member who
   * can read the project — and therefore see these suggestions — may still be unable to act
   * on any of them. Without this the surface offered Accept/Reject/Defer to such a reader
   * and let the server refuse afterwards, promising an action it had already made
   * unavailable.
   *
   * Evaluated with the existing `requireProjectAccess`, so no role logic is duplicated and
   * nothing is inferred client-side. Read-only is a normal outcome here, not an error, so
   * the denial is caught and reported as a capability rather than failing the read. The
   * PATCH route keeps its own check regardless: this is presentation eligibility, never
   * authorization.
   */
  let canDecide = false;
  try {
    await requireProjectAccess(projectId, "write");
    canDecide = true;
  } catch (error) {
    if (!(error instanceof AccessDeniedError)) throw error;
  }

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("recommended_actions")
    .select("id,workspace_id,project_id,raid_item_id,title,description,recommended_action_type,status,confidence_score,impact_level,rationale,recommended_owner,recommended_due_window,evidence_summary,source_signal_id,fingerprint,decision_reason,decided_by,decided_at,deferred_until,converted_task_id,decision_metadata,created_at,updated_at")
    .eq("project_id", projectId)
    .is("governance_event_id", null)
    .order("confidence_score", { ascending: false })
    .order("created_at", { ascending: false });

  if (raidItemId) {
    query = query.eq("raid_item_id", raidItemId);
  }

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    return Response.json({ error: "Unable to load recommended actions." }, { status: 500 });
  }

  return Response.json({ recommendedActions: data ?? [], capabilities: { canDecide } });
}
