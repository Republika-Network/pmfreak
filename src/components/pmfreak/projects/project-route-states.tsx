import Link from "next/link";
import { PROJECTS_NAV_HREF } from "@/lib/projects/project-paths";

/**
 * The two non-happy-path states every Project route shares, as ONE
 * implementation.
 *
 * Two route files reach these states today — canonical Project Home and the
 * legacy compatibility resolver — and the Project Command Center plus the
 * Execution Layer children will reach them next. Copies of a refusal are chances
 * for one of them to say something the others do not, and a refusal that differs
 * between surfaces is a probe: a caller who sees "not available" on one path and
 * a subtly different message on another has learned something about the project
 * from the difference. Sharing the component is what makes "indistinguishable"
 * structural rather than a matter of keeping copy in sync.
 */

/**
 * The refusal. Identical for an absent project, a deleted one, one the caller has
 * no workspace membership for, and one whose routed workspace disagreed with
 * `projects.workspace_id` — `resolveRoutedProject` collapses all four into
 * `denied` precisely so this component cannot tell them apart either.
 *
 * Deliberately free of anything that would confirm a project exists: no name, no
 * status, no workspace id, no PMO, and not the requested id echoed back. Wording
 * follows the PMO and Workspace refusals.
 */
export function ProjectNotAvailable() {
  return (
    <main className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white/80 p-6">
        <p className="text-sm font-semibold text-slate-900">This project isn&apos;t available to you</p>
        <p className="mt-1 text-xs text-slate-600">
          The project in this link either does not exist or is not one you have access to. Nothing has been
          changed. If you followed an old link, choose a project below.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href={PROJECTS_NAV_HREF}
            className="inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Choose a project
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
 * subtly wrong. Saying which of the two is archived — the project, its workspace,
 * or both — is the difference between a true sentence and a generic one.
 *
 * This slice adds the EXPLANATION and changes no control. Which actions a screen
 * offers on an archived project is existing product behaviour — `POST
 * /api/execution-tasks` already refuses task creation on an archived project, and
 * that refusal is unchanged — and inventing new archive restrictions here would
 * be inventing domain semantics under cover of a route migration.
 *
 * A `completed` project is NOT archived and never reaches this component: it is a
 * normal, mutable state the screen reports in its own status line.
 */
export function ProjectArchivedNotice({ archived }: { archived: { project: boolean; workspace: boolean } }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-6">
      <p className="text-sm font-semibold text-amber-900">
        {archived.project && archived.workspace
          ? "This project and its workspace are archived"
          : archived.project
            ? "This project is archived"
            : "This project's workspace is archived"}
      </p>
      <p className="mt-1 text-xs text-amber-700/80">
        You still have access to it, and everything below is its last-known state. Nothing here has been
        deleted.
      </p>
    </div>
  );
}
