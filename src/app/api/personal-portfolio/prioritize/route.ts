import { NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/security/server-authorization";
import { callerMetricsRetiredResponse } from "@/lib/personal-portfolio/caller-metrics-retired";

/**
 * Retired in P2-17: this endpoint computed on caller-supplied `projectMetrics` (healthScore,
 * riskScore, status, counts) and treated them as truth. It authenticates, then refuses before
 * reading the body. See `@/lib/personal-portfolio/caller-metrics-retired`.
 */
export async function POST(): Promise<NextResponse> {
  try {
    await requireAuthenticatedUser();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthenticated." }, { status: 401 });
  }
  return callerMetricsRetiredResponse();
}
