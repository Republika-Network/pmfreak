"use server";

import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveRoutedWorkspace } from "@/lib/workspaces/routed-workspace";
import {
  readInitialIngestionStatus,
  withInitialIngestionStatus,
  type InitialIngestionStatus,
} from "@/lib/projects/initial-ingestion-state";

export type MarkInitialIngestionResult = { ok: boolean };

/**
 * Advances the durable initial-ingestion marker on `projects.onboarding_payload`.
 *
 * Authorization is unconditional: both the read and the write are scoped to the
 * project id AND the ROUTED workspace the caller is actually viewing, which is
 * authorized here rather than trusted. RLS remains the backstop — this uses the
 * user-scoped client, never the service role.
 *
 * The workspace used to be re-resolved from the preferred-workspace cookie. On a
 * canonical deep link to workspace B while the cookie still named A, that looked
 * up B's project under A, matched nothing, and returned `{ ok: false }` — so the
 * durable marker never advanced and the guided ingestion view reappeared on
 * every refresh. The workspace is now passed in from the route that rendered the
 * screen.
 *
 * Archived workspaces are refused: this writes, and archived is read-only
 * (`07-route-layout-and-navigation-architecture.md` §7).
 *
 * Monotonic by design: a completed guided entry is never regressed back to
 * in_progress, so re-entering the Inbox later cannot re-trigger onboarding.
 */
export async function markInitialIngestionAction(
  workspaceId: string,
  projectId: string,
  status: Extract<InitialIngestionStatus, "in_progress" | "completed">,
): Promise<MarkInitialIngestionResult> {
  const user = await requireAuthUser();

  const access = await resolveRoutedWorkspace(user.id, workspaceId);
  if (access.access !== "granted") {
    return { ok: false };
  }

  const supabase = await createSupabaseServerClient();

  const { data: row, error: readError } = await supabase
    .from("projects")
    .select("onboarding_payload")
    .eq("id", projectId)
    .eq("workspace_id", access.workspaceId)
    .maybeSingle<{ onboarding_payload: unknown }>();

  if (readError || !row) {
    return { ok: false };
  }

  const current = readInitialIngestionStatus(row.onboarding_payload ?? null);

  // Already where we want to be, or already finished — nothing to write.
  if (current === status || current === "completed") {
    return { ok: true };
  }

  const nextPayload = withInitialIngestionStatus(
    row.onboarding_payload ?? null,
    status,
    new Date().toISOString(),
  );

  const { error: writeError } = await supabase
    .from("projects")
    .update({ onboarding_payload: nextPayload })
    .eq("id", projectId)
    .eq("workspace_id", access.workspaceId);

  if (writeError) {
    console.error(
      JSON.stringify({
        event: "command_center.initial_ingestion_write_failed",
        projectId,
        status,
        reason: writeError.message,
      }),
    );
    return { ok: false };
  }

  return { ok: true };
}
