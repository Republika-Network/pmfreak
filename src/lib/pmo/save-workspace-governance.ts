"use server";

import { getAuthUser } from "@/lib/auth";
import { resolveCanonicalWorkspace } from "@/lib/workspaces/canonical-workspace-resolver";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { requireWorkspaceRole } from "@/lib/workspace-access";
import type { PMOGovernanceSkeleton } from "./pmo-governance-types";

const GOVERNANCE_SCHEMA_VERSION = 1;

export type GovernanceSaveResult = { ok: boolean; error?: string };

/**
 * Persists a PMOGovernanceSkeleton to the workspace_governance table in Supabase.
 *
 * The skeleton becomes the governance contract PMFreak will later hydrate into
 * runtime context for reasoning, escalation, delivery controls, and communication.
 *
 * Falls back gracefully — the caller is responsible for client-side caching
 * (localStorage) so the wizard can proceed even if Supabase is unreachable.
 */
export async function saveWorkspaceGovernance(
  skeleton: PMOGovernanceSkeleton
): Promise<GovernanceSaveResult> {
  try {
    const user = await getAuthUser();
    if (!user) return { ok: false, error: "Not authenticated" };

    const resolution = await resolveCanonicalWorkspace(user.id);
    if (!resolution.workspaceId) {
      return { ok: false, error: "No active workspace found for user" };
    }

    // Authorization BEFORE any service-role write (F5): governance is owner/admin only,
    // read from workspace_memberships — never from the client or the display role.
    try {
      await requireWorkspaceRole(resolution.workspaceId, "admin");
    } catch {
      return { ok: false, error: "Only a workspace owner or admin can change workspace governance." };
    }

    const supabase = createSupabaseServiceRoleClient({
      routeId: "pmo/save-workspace-governance",
      operation: "upsert",
      reason: "pmo_governance_wizard_completion",
      workspaceId: resolution.workspaceId,
      actorUserId: user.id,
    });

    const { error } = await supabase.from("workspace_governance").upsert(
      {
        workspace_id: resolution.workspaceId,
        schema_version: GOVERNANCE_SCHEMA_VERSION,
        governance_jsonb: skeleton as unknown as Record<string, unknown>,
        status: "active",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id" }
    );

    if (error) {
      console.error("[pmo] workspace_governance upsert failed:", error.message);
      return { ok: false, error: error.message };
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[pmo] saveWorkspaceGovernance error:", message);
    return { ok: false, error: message };
  }
}
