import { notFound } from "next/navigation";
import { isFounderOrInternalUser, requireAuthUser } from "@/lib/auth";
import { MaterialActionPanel } from "@/components/pmfreak/intelligence-inbox/material-action-panel";
import { FixtureIntakePanel } from "@/components/internal/governance-lab/fixture-intake-panel";

/**
 * Governance Lab — internal certification surface (UX-P0-02).
 *
 * The P2-06 / AOC-E Material Action demonstration used to render inside the Project
 * Intelligence Inbox, which is the FIRST screen a new customer saw after creating a
 * project. It offers `authorized` / `denied` / `degraded` governance profiles under fixed
 * certification idempotency keys and prints canonical ids — a certification instrument, not
 * a product feature. It lives here now, together with the DEMO / FIXTURE capture path that
 * UX-P0-01 removed from ordinary context capture.
 *
 * "Internal" is enforced, not implied: `isFounderOrInternalUser` resolves founder/internal
 * identity server-side from the authenticated user's email only — never from `user.role`,
 * which is sourced from client-writable metadata. Ordinary authenticated customers get
 * `notFound()`, so the surface is indistinguishable from a route that does not exist. This
 * page is registered as `founder-internal` in `src/lib/security/route-guard-registry.ts`,
 * which is what makes `tests/route-guard-consistency.test.mjs` fail if the guard is ever
 * removed.
 */
export default async function GovernanceLabPage({
  searchParams,
}: {
  searchParams: Promise<{ workspaceId?: string; projectId?: string }>;
}) {
  const user = await requireAuthUser();
  if (!isFounderOrInternalUser(user)) {
    notFound();
  }

  const { workspaceId = "", projectId = "" } = await searchParams;

  return (
    <main className="space-y-6">
      <header>
        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-amber-700">Internal · certification surface</p>
        <h1 className="mt-2 text-xl font-semibold text-zinc-900">Governance Lab</h1>
        <p className="mt-2 max-w-3xl text-sm text-zinc-600">
          P2-06 / AOC-E in-process governance demonstration and DEMO / FIXTURE capture. Not part
          of the customer product surface. Writes here are real canonical writes against the
          workspace and project you name below.
        </p>
      </header>

      {workspaceId && projectId ? (
        <div className="space-y-6">
          <MaterialActionPanel workspaceId={workspaceId} projectId={projectId} />
          <FixtureIntakePanel workspaceId={workspaceId} projectId={projectId} />
        </div>
      ) : (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
          A workspace and project are required. Append <code>?workspaceId=…&amp;projectId=…</code> to this URL.
        </p>
      )}
    </main>
  );
}
