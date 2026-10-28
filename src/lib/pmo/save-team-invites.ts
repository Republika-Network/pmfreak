"use server";

import { getAuthUser } from "@/lib/auth";
import { resolveCanonicalWorkspace } from "@/lib/workspaces/canonical-workspace-resolver";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { requireWorkspaceRole } from "@/lib/workspace-access";
import { PMO_DOMAIN_FOCUS_OPTIONS, PMO_ROLES_ORDERED, type PmoTeamRole, type PmoDomainFocus } from "./team-roles";

export type PmoTeamInviteInput = {
  email: string;
  role: PmoTeamRole;
  domainFocus: PmoDomainFocus[];
};

export type SaveTeamInvitesResult =
  | { ok: true; savedCount: number }
  | { ok: false; error: string };

export async function saveTeamInvites(
  invites: PmoTeamInviteInput[]
): Promise<SaveTeamInvitesResult> {
  try {
    const user = await getAuthUser();
    if (!user) return { ok: false, error: "Not authenticated" };

    const resolution = await resolveCanonicalWorkspace(user.id);
    if (!resolution.workspaceId) {
      return { ok: false, error: "No active workspace found" };
    }

    // Authorization BEFORE any service-role write (F5): inviting the PMO team requires an
    // owner/admin membership in the resolved workspace, read from workspace_memberships.
    try {
      await requireWorkspaceRole(resolution.workspaceId, "admin");
    } catch {
      return { ok: false, error: "Only a workspace owner or admin can invite the PMO team." };
    }

    // Server-side validation: role and domain focus must come from the closed sets; any
    // other value rejects the whole batch rather than being silently written.
    if (!Array.isArray(invites)) return { ok: false, error: "Invalid invites." };
    const isValidInvite = (i: PmoTeamInviteInput) =>
      typeof i?.email === "string" &&
      (PMO_ROLES_ORDERED as readonly string[]).includes(i.role) &&
      Array.isArray(i.domainFocus) &&
      i.domainFocus.every((focus) => (PMO_DOMAIN_FOCUS_OPTIONS as readonly string[]).includes(focus));
    if (!invites.every(isValidInvite)) return { ok: false, error: "Invalid invite role or domain focus." };

    const validInvites = invites.filter((i) => {
      const email = i.email.trim().toLowerCase();
      return email.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    });

    if (validInvites.length === 0) {
      return { ok: true, savedCount: 0 };
    }

    const supabase = createSupabaseServiceRoleClient({
      routeId: "pmo/save-team-invites",
      operation: "insert",
      reason: "pmo_onboarding_team_invites",
      workspaceId: resolution.workspaceId,
      actorUserId: user.id,
    });

    const rows = validInvites.map((i) => ({
      workspace_id: resolution.workspaceId,
      invited_by_user_id: user.id,
      email: i.email.trim().toLowerCase(),
      role: i.role,
      domain_focus: i.domainFocus,
      status: "pending" as const,
    }));

    const { error } = await supabase.from("pmo_team_invites").insert(rows);
    if (error) {
      console.error("[pmo] team invites insert failed:", error.message);
      return { ok: false, error: "Failed to save invites. Please try again." };
    }

    return { ok: true, savedCount: validInvites.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[pmo] saveTeamInvites error:", message);
    return { ok: false, error: "An unexpected error occurred." };
  }
}
