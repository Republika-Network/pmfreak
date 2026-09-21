import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAuthenticatedUser } from "@/lib/security/server-authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { logger, safeErrorMessage } from "@/lib/observability/logger";
import { resolveRoutedPmo } from "@/lib/pmos/routed-pmo";
import { pmoProjectsQuery, runPmoScopedQuery, selectPmoProjects, type PmoProjectRow } from "@/lib/pmos/pmo-command-center-rollup";
import { loadPmoPortfolioAttention } from "@/lib/pmos/pmo-portfolio-attention-loader";

const ROUTE_ID = "/api/pmos/[id]/attention";

type Params = { params: Promise<{ id: string }> };

export type PmoAttentionRouteDeps = {
  authenticate: () => Promise<{ userId: string } | null>;
  resolvePmo: typeof resolveRoutedPmo;
  createClient: () => Promise<SupabaseClient>;
  loadProjects: (client: SupabaseClient, workspaceId: string, pmoId: string) => Promise<{ data: PmoProjectRow[] | null; error: { message: string } | null }>;
  loadAttention: typeof loadPmoPortfolioAttention;
};

const defaultDeps: PmoAttentionRouteDeps = {
  authenticate: async () => {
    try {
      const { user } = await requireAuthenticatedUser();
      return { userId: user.id };
    } catch {
      return null;
    }
  },
  resolvePmo: resolveRoutedPmo,
  createClient: async () => (await createSupabaseServerClient()) as unknown as SupabaseClient,
  loadProjects: (client, workspaceId, pmoId) => runPmoScopedQuery<PmoProjectRow>(client as never, pmoProjectsQuery(workspaceId, pmoId)),
  loadAttention: loadPmoPortfolioAttention,
};

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET the PMO attention projection.
 *
 * The request contributes IDENTIFIERS ONLY: the PMO id (path) and the workspace id (query) —
 * the latter is a claim about the PMO's ancestry that `resolveRoutedPmo` checks against
 * `pmos.workspace_id` and refuses on mismatch, never corrects. Every other query parameter is
 * ignored, and there is no body: attention levels, confidence, coverage and freshness are
 * rebuilt from persisted rows on every request, so a caller cannot submit a riskScore,
 * healthScore, priority or attentionScore and have it treated as truth.
 *
 * A missing PMO, a PMO in a workspace the caller is not a member of, and a workspace claim that
 * disagrees with the PMO's real parent all return the SAME 404, so the route cannot be used to
 * probe which PMO ids exist or learn a PMO's workspace.
 */
export async function handleGetPmoAttention(request: NextRequest, pmoIdParam: string, depsOverride: Partial<PmoAttentionRouteDeps> = {}): Promise<NextResponse> {
  const deps: PmoAttentionRouteDeps = { ...defaultDeps, ...depsOverride };
  const auth = await deps.authenticate();
  if (!auth) return NextResponse.json({ ok: false, error: "Unauthenticated." }, { status: 401, headers: NO_STORE });

  const pmoId = pmoIdParam.trim();
  const requestedWorkspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim() ?? "";
  if (!pmoId || !requestedWorkspaceId) {
    return NextResponse.json({ ok: false, error: "workspaceId is required." }, { status: 400, headers: NO_STORE });
  }

  const access = await deps.resolvePmo(auth.userId, requestedWorkspaceId, pmoId);
  if (access.access === "denied") {
    return NextResponse.json({ ok: false, error: "This PMO isn't available." }, { status: 404, headers: NO_STORE });
  }

  // From here only the AUTHORITATIVE workspace derived from the PMO row is used.
  const { workspaceId } = access;
  try {
    const client = await deps.createClient();
    const projects = await deps.loadProjects(client, workspaceId, access.pmoId);
    if (projects.error) {
      logger.error("route_dependency_unavailable", { route: ROUTE_ID, error_detail: projects.error.message });
      return NextResponse.json({ ok: false, error: "PMO projects could not be loaded. Please retry." }, { status: 503, headers: NO_STORE });
    }
    const attention = await deps.loadAttention(client, {
      workspaceId,
      pmoId: access.pmoId,
      projects: selectPmoProjects(projects.data ?? [], access.pmoId),
    });
    return NextResponse.json({ ok: true, readOnly: access.readOnly, attention }, { headers: NO_STORE });
  } catch (error) {
    logger.error("route_internal_error", { route: ROUTE_ID, error_detail: safeErrorMessage(error) });
    return NextResponse.json({ ok: false, error: "PMO attention could not be evaluated. Please retry." }, { status: 500, headers: NO_STORE });
  }
}

export async function GET(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  return handleGetPmoAttention(request, id);
}
