import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/security/server-authorization";
import {
  createPersonalPortfolio,
  listPortfolios,
  getLatestPortfolioSnapshot,
} from "@/lib/personal-portfolio";
import { LEGACY_SNAPSHOT_PROVENANCE } from "@/lib/personal-portfolio/caller-metrics-retired";

export async function GET(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    const ctx = await requireAuthenticatedUser();
    user = ctx.user;
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthenticated." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspaceId") ?? user.companyId;
  const portfolioId = searchParams.get("portfolioId");

  if (portfolioId) {
    const snapshotResult = await getLatestPortfolioSnapshot({ workspaceId, portfolioId });
    if (!snapshotResult.ok) {
      const status = snapshotResult.failureClass === "not_found" ? 404 : 500;
      return NextResponse.json({ ok: false, error: snapshotResult.error }, { status });
    }
    // Every persisted snapshot was computed from caller-supplied metrics (P2-17 retired that
    // path), so it is served labelled rather than as server-verified portfolio state.
    return NextResponse.json({ ok: true, snapshot: snapshotResult.data, ...LEGACY_SNAPSHOT_PROVENANCE });
  }

  const listResult = await listPortfolios({ workspaceId, ownerId: user.id });
  if (!listResult.ok) {
    return NextResponse.json({ ok: false, error: listResult.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, portfolios: listResult.data });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let user;
  try {
    const ctx = await requireAuthenticatedUser();
    user = ctx.user;
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthenticated." }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const workspaceId = (body.workspaceId as string | undefined) ?? user.companyId;
  const name = body.name as string | undefined;
  const description = body.description as string | undefined;

  if (!name?.trim()) {
    return NextResponse.json({ ok: false, error: "Portfolio name is required." }, { status: 400 });
  }

  const result = await createPersonalPortfolio({
    workspaceId,
    ownerId: user.id,
    name,
    description,
    actorId: user.id,
  });

  if (!result.ok) {
    const status = result.failureClass === "validation_failed" ? 400 : 500;
    return NextResponse.json({ ok: false, error: result.error }, { status });
  }

  return NextResponse.json({ ok: true, portfolio: result.data }, { status: 201 });
}
