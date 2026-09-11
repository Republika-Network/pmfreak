import Link from "next/link";
import { PMOS_NAV_HREF } from "@/lib/pmos/pmo-paths";

/**
 * The two non-happy-path states every PMO route shares, as ONE implementation.
 *
 * Nine route files reach these states: the five canonical PMO surfaces and the
 * four legacy compatibility resolvers. Nine copies of a refusal is nine chances
 * for one of them to say something the others do not, and a refusal that differs
 * between surfaces is a probe: a caller who sees "not available" on one path and
 * a subtly different message on another has learned something about the PMO from
 * the difference. Sharing the component is what makes "indistinguishable"
 * structural rather than a matter of keeping copy in sync.
 */

/**
 * The refusal. Identical for an absent PMO, a deleted one, one the caller has no
 * membership for, and one whose routed workspace disagreed with
 * `pmos.workspace_id` — `resolveRoutedPmo` collapses all four into `denied`
 * precisely so this component cannot tell them apart either.
 *
 * Deliberately free of anything that would confirm a PMO exists: no name, no
 * status, no workspace id, and not the requested id echoed back. Wording follows
 * the Workspace Command Center's own refusal.
 */
export function PmoNotAvailable() {
  return (
    <main className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white/80 p-6">
        <p className="text-sm font-semibold text-slate-900">This PMO isn&apos;t available to you</p>
        <p className="mt-1 text-xs text-slate-600">
          The PMO in this link either does not exist or is not one you have access to. Nothing has been
          changed. If you followed an old link, choose a PMO below.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href={PMOS_NAV_HREF}
            className="inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Choose a PMO
          </Link>
        </div>
      </div>
    </main>
  );
}

/**
 * The archived notice.
 *
 * `07-route-layout-and-navigation-architecture.md` §7 makes archival a READ-ONLY
 * STATE, not an access failure: the viewer keeps seeing last-known data, and the
 * state is explained rather than left to be inferred from a screen that looks
 * subtly wrong. Saying which of the two is archived — the PMO, its workspace, or
 * both — is the difference between a true sentence and a generic one.
 *
 * This slice adds the explanation and changes no control: which actions a screen
 * offers on an archived PMO is existing product behaviour, and inventing new
 * archive restrictions here would be inventing domain semantics under cover of a
 * route migration.
 */
export function PmoArchivedNotice({ archived }: { archived: { pmo: boolean; workspace: boolean } }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-6">
      <p className="text-sm font-semibold text-amber-900">
        {archived.pmo && archived.workspace
          ? "This PMO and its workspace are archived"
          : archived.pmo
            ? "This PMO is archived"
            : "This PMO's workspace is archived"}
      </p>
      <p className="mt-1 text-xs text-amber-700/80">
        You still have access to it, and everything below is its last-known state. Nothing here has been
        deleted.
      </p>
    </div>
  );
}
