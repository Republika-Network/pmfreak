import Link from "next/link";
import { WORKSPACES_NAV_HREF } from "@/lib/workspaces/workspace-paths";

/**
 * The two non-happy-path states the canonical Workspace routes share, as ONE
 * implementation.
 *
 * A refusal that differs between surfaces is a probe: a caller who sees one
 * message on Workspace Home and a subtly different one on Workspace Settings has
 * learned something about the workspace from the difference. Sharing the
 * component is what makes "indistinguishable" structural rather than a matter of
 * keeping copy in sync — the same argument `pmo-route-states.tsx` makes for the
 * PMO family.
 *
 * The Workspace Command Center renders its own copy of the refusal inline. It is
 * NOT folded into this component: that screen is PR #604's and its refusal is
 * pinned by `workspace-scoped-command-center-route.test.ts`, so rewriting it here
 * would be redesigning a shipped surface to satisfy a shared abstraction. The
 * wording below is deliberately its wording.
 */

/**
 * The refusal. Identical for a workspace that does not exist, one that was
 * deleted, and one the caller has no membership in — `resolveRoutedWorkspace`
 * collapses all three into `denied` (§7's leakage rule) precisely so this
 * component cannot tell them apart either.
 *
 * Deliberately free of anything that would confirm the workspace exists: no
 * name, no status, no role, and not the requested id echoed back.
 */
export function WorkspaceNotAvailable() {
  return (
    <main className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white/80 p-6">
        <p className="text-sm font-semibold text-slate-900">This workspace isn&apos;t available to you</p>
        <p className="mt-1 text-xs text-slate-600">
          The workspace in this link either does not exist or is not one you have access to. Nothing
          has been changed. If you followed an old link, choose a workspace below.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href={WORKSPACES_NAV_HREF}
            className="inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Choose a workspace
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
 * subtly wrong. Archived is never collapsed into missing.
 *
 * This slice adds the explanation and invents no archival semantics. There is no
 * archive or restore mutation at workspace scope anywhere in the product today,
 * so this notice promises no route back out of archival — saying "restore it
 * from settings" would name a control that does not exist.
 */
export function WorkspaceArchivedNotice() {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-6">
      <p className="text-sm font-semibold text-amber-900">This workspace is archived</p>
      <p className="mt-1 text-xs text-amber-700/80">
        You still have access to it, and everything below is its last-known state. Creating and
        changing are turned off while it stays archived — nothing here has been deleted.
      </p>
    </div>
  );
}
