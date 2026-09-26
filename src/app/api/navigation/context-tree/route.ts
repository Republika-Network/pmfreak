import { NextResponse, type NextRequest } from "next/server";
import { AccessDeniedError } from "@/aoc/runtime-consumer";
import { denyFromAccessError, denyResponse } from "@/lib/security/deny-response";
import { requireAuthenticatedUser, requireWorkspaceMember } from "@/lib/security/server-authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import type { TreePmo, TreeProject, TreeWorkspace } from "@/lib/navigation/conversation-shell-scope";

const ROUTE_ID = "/api/navigation/context-tree";

/**
 * CHAT-SHELL-01 — the conversation shell's navigation tree, and nothing else.
 *
 * Deliberately NARROW. The shell this replaces fetched discovery, recommended
 * actions, execution tasks, the task graph, the schedule, the critical path and
 * the whole portfolio at boot, on every protected page, to draw navigation. The
 * tree needs names, statuses and parent ids — so that is all this returns:
 *
 *   GET                     → the caller's workspaces (level 1)
 *   GET ?workspaceId=<id>   → that workspace's PMOs and projects (levels 2-3),
 *                             fetched lazily when the workspace is expanded
 *
 * AUTHORIZATION — the same two layers `GET /api/pmos` and `GET /api/projects`
 * rely on, and no new model:
 *
 *   - `requireWorkspaceMember` is application-layer defence in depth, routed
 *     through the runtime's `workspace.read` evaluation (SIT-024), and it runs on
 *     the REQUESTED id.
 *   - The ENFORCING boundary is the caller's own Supabase session plus RLS: the
 *     `workspace_memberships`, `pmos` and `projects` select policies admit a row
 *     only when the caller is a member of its workspace. A non-member who sends
 *     another tenant's id is refused by the first layer and would read no rows
 *     from the second.
 *
 * This route must never use the service-role client for the rows it returns.
 * `workspaceId` is a scope, not a grant: it can narrow the answer, never widen it.
 *
 * `sessionActive` comes from `resolvePreferredWorkspace` — the exact resolver
 * `/chat` uses to decide which workspace Workspace Chat answers for — so the
 * tree offers that conversation under the workspace it will actually open. It
 * is a display flag over rows this caller's own session already returned, not
 * an authorization input.
 */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser();
    const supabase = await createSupabaseServerClient();
    const requestedWorkspaceId = request.nextUrl.searchParams.get("workspaceId");

    if (!requestedWorkspaceId) {
      const [memberships, preferred] = await Promise.all([
        supabase.from("workspace_memberships").select("workspace_id").eq("user_id", user.id),
        resolvePreferredWorkspace(user.id),
      ]);
      if (memberships.error) {
        console.error(JSON.stringify({ event: "context_tree.workspaces_unavailable", userId: user.id, reason: memberships.error.message }));
        return NextResponse.json({ error: "Workspaces are temporarily unavailable." }, { status: 503 });
      }
      const ids = [...new Set(((memberships.data ?? []) as Array<{ workspace_id: string }>).map((row) => row.workspace_id))];
      if (ids.length === 0) return NextResponse.json({ workspaces: [] });
      // Only the caller's own membership ids, read again through RLS.
      const { data, error } = await supabase.from("workspaces").select("id, name, status").in("id", ids);
      if (error) {
        console.error(JSON.stringify({ event: "context_tree.workspaces_unavailable", userId: user.id, reason: error.message }));
        return NextResponse.json({ error: "Workspaces are temporarily unavailable." }, { status: 503 });
      }
      const workspaces: TreeWorkspace[] = ((data ?? []) as Array<{ id: string; name: string; status: string | null }>)
        .map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          status: workspace.status ?? "active",
          sessionActive: workspace.id === preferred.workspaceId,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ workspaces });
    }

    await requireWorkspaceMember(requestedWorkspaceId);

    const [pmosRead, projectsRead] = await Promise.all([
      supabase
        .from("pmos")
        .select("id, name, icon, status")
        .eq("workspace_id", requestedWorkspaceId)
        .order("created_at", { ascending: true }),
      supabase
        .from("projects")
        .select("id, name, status, pmo_id")
        .eq("workspace_id", requestedWorkspaceId)
        .order("created_at", { ascending: true }),
    ]);
    if (pmosRead.error || projectsRead.error) {
      console.error(
        JSON.stringify({
          event: "context_tree.workspace_branch_unavailable",
          workspaceId: requestedWorkspaceId,
          reason: pmosRead.error?.message ?? projectsRead.error?.message,
        }),
      );
      return NextResponse.json({ error: "This workspace's projects are temporarily unavailable." }, { status: 503 });
    }

    const pmos: TreePmo[] = ((pmosRead.data ?? []) as Array<{ id: string; name: string; icon: string | null; status: string | null }>).map(
      (pmo) => ({ id: pmo.id, name: pmo.name, icon: pmo.icon, status: pmo.status ?? "active" }),
    );
    const projects: TreeProject[] = ((projectsRead.data ?? []) as Array<{ id: string; name: string; status: string | null; pmo_id: string | null }>).map(
      (project) => ({ id: project.id, name: project.name, status: project.status ?? "active", pmoId: project.pmo_id }),
    );
    return NextResponse.json({ workspaceId: requestedWorkspaceId, pmos, projects });
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (String(error.metadata.reason) === "unauthorized") {
        return denyResponse({ status: 401, routeId: ROUTE_ID, message: "Unauthorized", reason: "unauthorized" });
      }
      return denyFromAccessError(error, { status: 403, routeId: ROUTE_ID, message: "Forbidden" });
    }
    throw error;
  }
}
