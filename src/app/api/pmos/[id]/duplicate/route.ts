import { NextResponse } from "next/server";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { requireAuthenticatedUser, requireWorkspaceMember } from "@/lib/security/server-authorization";
import { requireWorkspaceRole as requireWorkspaceMinimumRole } from "@/lib/workspace-access";
import { safeLegacyErrorResponse } from "@/lib/security/safe-route-error";
import { duplicatePmo, getPmoWorkspaceId } from "@/lib/pmos/pmo-service";

const ROUTE_ID = "/api/pmos/[id]/duplicate";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const { user } = await requireAuthenticatedUser();
    const pmoId = id.trim();
    if (!pmoId) return NextResponse.json({ error: "PMO id is required." }, { status: 400 });

    // The source PMO's OWN workspace is where the copy belongs and whose role
    // gate applies — not the caller's preferred workspace, which would decide
    // both from a client-controlled cookie. Same reasoning as
    // `/api/pmos/[id]`; the lookup runs on the caller's own client, so a PMO
    // they cannot see reads as absent.
    const workspaceId = await getPmoWorkspaceId(pmoId);
    if (!workspaceId) return NextResponse.json({ error: "PMO not found." }, { status: 404 });

    await requireWorkspaceMember(workspaceId);
    try {
      await requireWorkspaceMinimumRole(workspaceId, "pm");
    } catch {
      return denyResponse({ status: 403, routeId: ROUTE_ID, message: "Forbidden", reason: "insufficient_role", actorUserId: user.id, eventType: "workspace_scope_violation" });
    }

    const pmo = await duplicatePmo(workspaceId, pmoId, user.id);
    return NextResponse.json({ pmo }, { status: 201 });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (String(error.metadata.reason) === "unauthorized") {
        return denyResponse({ status: 401, routeId: ROUTE_ID, message: "Unauthorized", reason: "unauthorized" });
      }
      return denyFromAccessError(error, { status: 403, routeId: ROUTE_ID, message: "Forbidden" });
    }
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to duplicate PMO.");
  }
}
