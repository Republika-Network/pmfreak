import { NextResponse } from "next/server";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { safeLegacyErrorResponse } from "@/lib/security/safe-route-error";
import { requireAuthenticatedUser, requireWorkspaceMember } from "@/lib/security/server-authorization";
import { requireWorkspaceRole as requireWorkspaceMinimumRole } from "@/lib/workspace-access";
import { deletePmo, getPmoById, getPmoWorkspaceId, normalizePmoType, updatePmo, type UpdatePmoInput } from "@/lib/pmos/pmo-service";

const ROUTE_ID = "/api/pmos/[id]";

type Params = { params: Promise<{ id: string }> };

function handleAccessError(error: unknown) {
  if (error instanceof AccessDeniedError) {
    if (String(error.metadata.reason) === "unauthorized") {
      return denyResponse({ status: 401, routeId: ROUTE_ID, message: "Unauthorized", reason: "unauthorized" });
    }
    return denyFromAccessError(error, { status: 403, routeId: ROUTE_ID, message: "Forbidden" });
  }
  return null;
}

/**
 * Resolves the workspace this request acts in FROM THE PMO ITSELF.
 *
 * `pmos.workspace_id` is the authority for a PMO's parent workspace, so it is
 * what the membership and role checks below are run against. The preferred-
 * workspace cookie used to stand in for it, which was wrong in two directions at
 * once:
 *
 *   - a PMO in any workspace other than the caller's preferred one was
 *     unreachable — `getPmoById(preferred, pmoId)` matched nothing and the caller
 *     was told a PMO they own does not exist; and
 *   - the workspace whose ROLE was checked was chosen by a client-controlled
 *     cookie rather than by the entity being mutated. It could only ever narrow
 *     (the scoped `getPmoById`/`updatePmo` filters meant a mismatch mutated zero
 *     rows), but "the wrong workspace's role gate happened to also fail" is a
 *     coincidence, not a design.
 *
 * This mirrors `/api/context-chat`, which derives a pmo scope's workspace from
 * `getPmoWorkspaceId` for the same reason (see the finding recorded in
 * `tests/workspace-pmo-project-validation-sprint.test.mjs`). The lookup runs on
 * the CALLER'S own client, so RLS on `pmos` already filters it: a PMO in a
 * workspace the caller is not a member of reads as absent and gets the same 404
 * as one that does not exist, and no service-role client is introduced here.
 *
 * The role rules are unchanged — pm-or-above to mutate, matching the "workspace
 * managers can manage pmos" RLS policy — they are simply asked of the right
 * workspace.
 */
async function resolveScopedRequest(pmoIdRaw: string) {
  const { user } = await requireAuthenticatedUser();
  const pmoId = pmoIdRaw.trim();
  if (!pmoId) return { error: NextResponse.json({ error: "PMO id is required." }, { status: 400 }) } as const;

  const workspaceId = await getPmoWorkspaceId(pmoId);
  if (!workspaceId) return { error: NextResponse.json({ error: "PMO not found." }, { status: 404 }) } as const;

  await requireWorkspaceMember(workspaceId);
  return { user, workspaceId, pmoId } as const;
}

/**
 * PMO mutations require workspace role pm-or-above, matching the "workspace
 * managers can manage pmos" RLS policy — enforced at the app layer so a
 * viewer gets a clean 403 instead of a generic 500 once the RLS write is
 * rejected by Postgres.
 */
async function resolveScopedMutation(pmoIdRaw: string) {
  const scoped = await resolveScopedRequest(pmoIdRaw);
  if ("error" in scoped) return scoped;
  try {
    await requireWorkspaceMinimumRole(scoped.workspaceId, "pm");
  } catch {
    return { error: denyResponse({ status: 403, routeId: ROUTE_ID, message: "Forbidden", reason: "insufficient_role", actorUserId: scoped.user.id, eventType: "workspace_scope_violation" }) } as const;
  }
  return scoped;
}

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const scoped = await resolveScopedRequest(id);
    if ("error" in scoped) return scoped.error;

    const pmo = await getPmoById(scoped.workspaceId, scoped.pmoId);
    if (!pmo) return NextResponse.json({ error: "PMO not found." }, { status: 404 });
    return NextResponse.json({ pmo });
  } catch (error) {
    const denied = handleAccessError(error);
    if (denied) return denied;
    throw error;
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const scoped = await resolveScopedMutation(id);
    if ("error" in scoped) return scoped.error;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: UpdatePmoInput = {};

    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "PMO name cannot be empty." }, { status: 400 });
      patch.name = name;
    }
    if (body.description !== undefined) {
      patch.description = typeof body.description === "string" && body.description.trim() ? body.description.trim() : null;
    }
    if (body.pmoType !== undefined) {
      const pmoType = normalizePmoType(body.pmoType);
      if (!pmoType) return NextResponse.json({ error: "Invalid PMO type." }, { status: 400 });
      patch.pmoType = pmoType;
    }
    if (body.icon !== undefined) patch.icon = typeof body.icon === "string" && body.icon.trim() ? body.icon.trim() : null;
    if (body.color !== undefined) patch.color = typeof body.color === "string" && body.color.trim() ? body.color.trim() : null;
    if (body.status !== undefined) {
      if (body.status !== "active" && body.status !== "archived") {
        return NextResponse.json({ error: "Invalid PMO status." }, { status: 400 });
      }
      patch.status = body.status;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No valid fields to update." }, { status: 400 });
    }

    const existing = await getPmoById(scoped.workspaceId, scoped.pmoId);
    if (!existing) return NextResponse.json({ error: "PMO not found." }, { status: 404 });

    const pmo = await updatePmo(scoped.workspaceId, scoped.pmoId, patch);
    return NextResponse.json({ pmo });
  } catch (error) {
    const denied = handleAccessError(error);
    if (denied) return denied;
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to update PMO.");
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const scoped = await resolveScopedMutation(id);
    if ("error" in scoped) return scoped.error;

    const existing = await getPmoById(scoped.workspaceId, scoped.pmoId);
    if (!existing) return NextResponse.json({ error: "PMO not found." }, { status: 404 });

    await deletePmo(scoped.workspaceId, scoped.pmoId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const denied = handleAccessError(error);
    if (denied) return denied;
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to delete PMO.");
  }
}
