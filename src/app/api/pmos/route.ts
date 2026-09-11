import { NextResponse } from "next/server";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { safeLegacyErrorResponse } from "@/lib/security/safe-route-error";
import { requireAuthenticatedUser, requireWorkspaceMember } from "@/lib/security/server-authorization";
import { requireWorkspaceRole as requireWorkspaceMinimumRole } from "@/lib/workspace-access";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import { createPmo, listPmosWithProjects, normalizePmoType } from "@/lib/pmos/pmo-service";

const ROUTE_ID = "/api/pmos";

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
 * PMO mutation routes require workspace role pm-or-above (owner/admin/pm),
 * matching the "workspace managers can manage pmos" RLS policy exactly —
 * app-layer enforcement so a viewer gets a clean 403 instead of relying
 * solely on the RLS write rejecting and surfacing as a generic 500.
 */
async function requirePmoManagerRole(workspaceId: string): Promise<NextResponse | null> {
  try {
    await requireWorkspaceMinimumRole(workspaceId, "pm");
    return null;
  } catch {
    return denyResponse({ status: 403, routeId: ROUTE_ID, message: "Forbidden", reason: "insufficient_role", eventType: "workspace_scope_violation" });
  }
}

/**
 * Lists the caller's PMOs, with their projects, for the sidebar navigation tree.
 *
 * `?workspaceId=` scopes the answer to the workspace the caller is VIEWING, which
 * is not always the one their preferred-workspace cookie names. On a canonical
 * Project route `/workspaces/B/projects/P` the protected layout establishes B and
 * the shell renders B — but this handler answered from the cookie, so the tree
 * came back holding workspace A's PMOs and A's projects. Two things broke as a
 * result: the routed project was not in the list, so the tree could not light the
 * row the viewer was standing on, and every link it rendered pointed back into A.
 * EXPLICIT ROUTE CONTEXT MUST BEAT COOKIE CONTEXT, and this parameter is how the
 * caller says which one it holds.
 *
 * It is the same seam `GET /api/projects` already opened for the project
 * switcher, deliberately — one precedent, not two shapes — and it widens nothing:
 *
 *   - `requireWorkspaceMember` is APPLICATION-LAYER DEFENCE IN DEPTH, routing
 *     through the enterprise runtime's capability evaluation. It is the same gate
 *     the cookie-resolved path already passed, and it runs on the REQUESTED id.
 *   - The ENFORCING DATA-ISOLATION BOUNDARY is the user-scoped Supabase client
 *     plus RLS: `listPmosWithProjects` reads through `createSupabaseServerClient()`,
 *     and the `pmos` / `projects` select policies
 *     (20260512160000_workspace_authorization_rewrite.sql) admit a row only when a
 *     `workspace_memberships` row exists for `auth.uid()`. A non-member who
 *     supplies another tenant's id therefore reads NO ROWS.
 *
 * No new authorization model, no service-role read. Omitting the parameter
 * preserves the previous behaviour exactly, which is what the `/pmos` chooser
 * (`PmoAdminClient`) still legitimately depends on.
 */
export async function GET(request: Request) {
  try {
    const { user } = await requireAuthenticatedUser();
    const params = new URL(request.url).searchParams;
    const requestedWorkspaceId = params.get("workspaceId");
    const resolution = requestedWorkspaceId ? null : await resolvePreferredWorkspace(user.id);
    const workspaceId = requestedWorkspaceId ?? resolution?.workspaceId ?? null;
    if (!workspaceId) {
      return denyResponse({ status: 403, routeId: ROUTE_ID, message: "Workspace context required.", reason: "workspace_missing", actorUserId: user.id, eventType: "workspace_scope_violation" });
    }
    await requireWorkspaceMember(workspaceId);

    const includeArchived = params.get("includeArchived") === "true";
    const pmos = await listPmosWithProjects(workspaceId, { includeArchived });
    return NextResponse.json({ workspaceId, pmos });
  } catch (error) {
    const denied = handleAccessError(error);
    if (denied) return denied;
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireAuthenticatedUser();
    const resolution = await resolvePreferredWorkspace(user.id);
    if (!resolution.workspaceId) {
      return denyResponse({ status: 403, routeId: ROUTE_ID, message: "Workspace context required.", reason: "workspace_missing", actorUserId: user.id, eventType: "workspace_scope_violation" });
    }
    await requireWorkspaceMember(resolution.workspaceId);
    const roleDenied = await requirePmoManagerRole(resolution.workspaceId);
    if (roleDenied) return roleDenied;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "PMO name is required." }, { status: 400 });
    }

    const pmo = await createPmo({
      workspaceId: resolution.workspaceId,
      name,
      description: typeof body.description === "string" && body.description.trim() ? body.description.trim() : null,
      pmoType: normalizePmoType(body.pmoType) ?? "company_pmo",
      icon: typeof body.icon === "string" && body.icon.trim() ? body.icon.trim() : null,
      color: typeof body.color === "string" && body.color.trim() ? body.color.trim() : null,
      createdByUserId: user.id,
    });

    return NextResponse.json({ pmo }, { status: 201 });
  } catch (error) {
    const denied = handleAccessError(error);
    if (denied) return denied;
    return safeLegacyErrorResponse(ROUTE_ID, error, "Unable to create PMO.");
  }
}
