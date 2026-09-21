import type { SupabaseClient } from "@supabase/supabase-js";
import { createPrivilegedSupabaseClient } from "@/lib/security/privileged-access";

/**
 * P2-16 trusted write transport for the three schedule-exposure adapter RPCs
 * (capture_schedule_exposure_evaluation, derive_schedule_exposure_evidence,
 * materialize_schedule_exposure_finding), which are executable by service_role only.
 *
 * Why a privileged client at all: the database cannot recompute the H9 engine, so a
 * browser-reachable RPC would let any project writer record hand-written "engine" output.
 * The only caller that has actually run the engine is this server, so only this server may
 * write. The service role is TRANSPORT, never authority:
 *   - it is created only after the route has authenticated the human, checked project write
 *     access and read the schedule through the human's own RLS client;
 *   - every RPC receives that human as `p_actor_user_id`, and the database re-verifies the
 *     actor's current owner/admin/pm membership of the exact workspace + project;
 *   - it is never used for reads.
 */
export function createScheduleExposureTrustedWriter(input: {
  workspaceId: string;
  actorUserId: string;
  operation: "evaluate_schedule_exposure" | "resume_schedule_exposure_materialization";
}): SupabaseClient {
  return createPrivilegedSupabaseClient({
    routeId: "/api/critical-path/schedule-exposure",
    operation: input.operation,
    reason: "P2-16 trusted schedule-exposure adapter write after server-side H9 evaluation; human actor re-verified in the database.",
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
  });
}
