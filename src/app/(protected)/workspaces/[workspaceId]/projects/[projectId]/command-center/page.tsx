import Link from "next/link";
import { requireAuthUser } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { evaluateCapabilityAccess } from "@/lib/security/capability-flow";
import { resolveRoutedProject } from "@/lib/projects/routed-project";
import { ProjectArchivedNotice, ProjectNotAvailable } from "@/components/pmfreak/projects/project-route-states";
import { ProjectTabNav } from "@/components/pmfreak/projects/project-tab-nav";
import { projectHomePath } from "@/lib/projects/project-paths";
import {
  projectCommandCenterBreadcrumb,
  projectCommandCenterPath,
  resolveProjectPmoAncestry,
  type ProjectBreadcrumbPmo,
} from "@/lib/projects/project-command-center-paths";
import {
  countRaidByCategory,
  PROJECT_COMMAND_CENTER_ZONES,
  projectPendingDecisionsQuery,
  projectRaidQuery,
  projectRecommendationsQuery,
  resolveVisibleTotal,
  runProjectScopedQuery,
  selectProjectGovernanceFacts,
  selectProjectRaid,
  selectProjectRecommendations,
  selectRecommendationDisclosure,
  ZONE_ROW_LIMIT,
  type ProjectGovernanceFacts,
  type ProjectRaidRow,
  type ProjectRecommendationRow,
  type ProjectScopedQueryResult,
} from "@/lib/projects/project-command-center-projection";
import type { ProjectStatus } from "@/lib/db/database-contract";

export const dynamic = "force-dynamic";

/**
 * Project Command Center — the canonical, entity-qualified route.
 *
 * `07-route-layout-and-navigation-architecture.md` §2 names this path:
 * `/workspaces/[workspaceId]/projects/[projectId]/command-center`, layout chain
 * "Authenticated Shell → Workspace → Project". It is the Project's primary
 * operational experience — "the single screen that answers 'what do I need to
 * know and do right now' for this Project" (`03-canonical-information-architecture.md`
 * §5.7, §11) — and it is a PROJECTION: it composes reads and owns no durable
 * state of its own (ADR-PMF-065, PR4 §9.5).
 *
 * WHAT THIS SCREEN IS NOT
 * -----------------------
 * - It is NOT Project Home. Home is the Project's identity screen and owns
 *   execution CRUD, PM assignment, the analysis form and prior analyses; none of
 *   that is duplicated here. IA Principle 5 (One Entity One Home) is only worth
 *   anything if the two stay different screens, and IA §15 rule 6 makes them
 *   SIBLINGS reachable from each other directly, never nested.
 * - It is NOT the Workspace Command Center. That screen resolves an ACTIVE
 *   PROJECT from a workspace's project list with a `?projectId=` picker and
 *   renders a cross-PMO portfolio strip beside it. Nothing of the sort appears
 *   here: a Project route has already been TOLD its project, and ADR-PMF-020
 *   forbids a Command Center widget from reading outside its own entity's
 *   descendant scope. A Project is a leaf, so its scope is its own records.
 * - It is NOT the PMO Command Center, which rolls up the projects a PMO governs.
 * - It is NOT `/command-center`, which remains the Workspace Command Center's
 *   compatibility resolver, and NOT `/pmo-command-center`, which remains PM
 *   Operations' redirect (ADR-PMF-014 Rule 6). Neither is repurposed here.
 * - It has NOTHING to do with the `operational_command_centers` table. That is a
 *   dormant per-snapshot focus store whose `project_id` carries no foreign key,
 *   which no product code reads or writes, and which ADR-PMF-014 Rule 5 keeps out
 *   of user-facing vocabulary. The routed `projectId` is this screen's only
 *   identity.
 *
 * WHY THE PROJECT ID IS AUTHORIZED AND THE WORKSPACE ID IS ONLY A CLAIM
 * --------------------------------------------------------------------
 * Both segments are untrusted input and they are not equal in authority. The
 * routed `projectId` says WHICH project is requested; `projects.workspace_id` —
 * read from the project row itself — says which workspace owns it. The routed
 * `workspaceId` is neither: it is an assertion about that ancestry, and
 * `resolveRoutedProject` refuses when it disagrees rather than correcting the
 * URL. Correcting would render a project under a workspace id that does not own
 * it, and would let a caller learn a project's real workspace by watching the
 * address change.
 *
 * The resolver has no fallback of any kind — no preferred workspace, no first
 * workspace, no first project, no selected-project state, no `?projectId=`, and
 * neither `resolveActiveProject` nor `resolveCanonicalProject` is anywhere in
 * this path. Its three outcomes are load-bearing:
 *
 *   granted  — authorized, project and workspace both active (or `completed`,
 *              which is a normal mutable state, not archival).
 *   archived — authorized, but the project and/or its workspace is archived. NOT
 *              an access failure: §7 requires last-known data to stay visible
 *              with the state explained.
 *   denied   — absent, deleted, unauthorized, or an ancestry mismatch. One
 *              indistinguishable reply, so the route cannot be used to probe
 *              which project ids exist (§7).
 *
 * SLICE 1 IS READ-ONLY
 * --------------------
 * There is no server action, no form, no mutating fetch and no write of any kind
 * on this screen. That is what makes "withhold mutations when archived"
 * structural rather than a control disabled in name only — and it is why the
 * archived branch below hides nothing: every zone keeps showing last-known data,
 * because there is nothing here that could change it.
 *
 * Zone 2 and Zone 3 therefore render Recommendations WITHOUT Accept/Reject/Defer
 * and without Record Decision. Those are the screen's ratified Actions (IA §5.7)
 * and they arrive in a later slice, because the two populations write different
 * tables through different permission models and that deserves its own
 * authorization review rather than a corner of a route migration.
 */

type ProjectIdentityRow = {
  id: string;
  workspace_id: string;
  pmo_id: string | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  icon: string | null;
  color: string | null;
};

const PROJECT_IDENTITY_COLUMNS = "id, workspace_id, pmo_id, name, description, status, icon, color";

const [ZONE_ATTENTION, ZONE_RECOMMENDATIONS, ZONE_DECISIONS, ZONE_HEALTH] = PROJECT_COMMAND_CENTER_ZONES;

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="space-y-5">{children}</main>;
}

/**
 * One zone. Rendered four times, unconditionally.
 *
 * `children` is the zone's Populated, Empty or Degraded body — the zone's FRAME
 * never depends on which, because ADR-PMF-070 Frontend Rule 2 makes presence
 * structural and population data-dependent.
 */
function Zone({
  zone,
  note,
  children,
}: {
  zone: (typeof PROJECT_COMMAND_CENTER_ZONES)[number];
  note?: string | null;
  children: React.ReactNode;
}) {
  return (
    <section data-zone={zone.key} aria-labelledby={`zone-${zone.key}`} className="rounded-3xl border border-slate-200 bg-white p-5">
      <h2 id={`zone-${zone.key}`} className="text-lg font-semibold text-slate-900">
        {zone.title}
      </h2>
      {note ? <p className="mt-1 text-xs text-slate-500">{note}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * A zone's source failed.
 *
 * Deliberately distinct in wording from every Empty state on this screen: an
 * empty zone is a statement about the project, a degraded zone is a statement
 * about this read. Collapsing the two would tell a PM they have no open risks
 * when what actually happened is that we could not find out — the single most
 * consequential lie a screen like this can tell. A failed query is never
 * rendered as a zero; a successful zero is a real zero.
 */
function ZoneDegraded({ what }: { what: string }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4">
      <p className="text-sm font-semibold text-amber-900">We couldn&apos;t load {what}</p>
      <p className="mt-1 text-xs text-amber-700/80">
        This is a temporary problem reading this project, not a permissions issue. Nothing has been changed
        or lost. The rest of this Project Command Center is unaffected — reload the page to try again.
      </p>
    </div>
  );
}

function ZoneEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4">
      <p className="text-sm text-slate-600">{children}</p>
    </div>
  );
}

/** "+N more", shown only when the total is a fact we actually hold. */
function MoreThanShown({ shown, total }: { shown: number; total: number | null }) {
  if (total === null || total <= shown) return null;
  return (
    <p className="mt-3 text-xs text-slate-500">
      Showing the {shown} most recent of {total}.
    </p>
  );
}

/**
 * Provenance for an auto-extracted record.
 *
 * `raid_items.auto_generated` defaults to true and these rows arrive from
 * document extraction, not from a person asserting a fact. Rendering the
 * confidence and the number of times the item was detected is how the zone
 * avoids presenting extracted material as human-certified governance.
 */
function ExtractionProvenance({ autoGenerated, confidence, occurrences }: { autoGenerated: boolean; confidence: number; occurrences: number }) {
  if (!autoGenerated) return null;
  return (
    <span className="text-[11px] text-zinc-500">
      Detected automatically · confidence {Math.round(confidence)}% · seen {occurrences}×
    </span>
  );
}

/**
 * One stored disclosure line — the `Why` or the `Evidence` behind a Recommendation.
 *
 * `08-ai-interaction-patterns.md` §2 requires every rendered Recommendation to
 * carry Why → Evidence → Confidence, in that order, and calls a bare directive
 * ("AI says: do X") a defect rather than a simplification, because an
 * unexplained directive cannot be evaluated. Zone 2 rendered the directive and
 * the confidence and dropped the stored basis, which is what this restores.
 *
 * `selectRecommendationDisclosure` has already read the stored jsonb out; this
 * only lays it out. An empty list renders NOTHING — no line, no placeholder and
 * no stand-in sentence — because the honest treatment of a column that holds no
 * readable value is to omit the claim, never to compose one. Nothing here is
 * derived from the recommendation's own title or description.
 */
function RecommendationDisclosure({ label, entries }: { label: string; entries: { label: string; value: string }[] }) {
  if (entries.length === 0) return null;
  return (
    <p className="mt-1 text-[11px] text-zinc-600">
      <span className="font-semibold text-zinc-700">{label}:</span>{" "}
      {entries.map((entry, index) => (
        <span key={`${entry.label}-${index}`}>
          {index > 0 ? <span className="text-zinc-400"> · </span> : null}
          <span className="text-zinc-500">{entry.label}</span> {entry.value}
        </span>
      ))}
    </p>
  );
}

export default async function ProjectCommandCenterPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const user = await requireAuthUser();
  const { workspaceId: requestedWorkspaceId, projectId: requestedProjectId } = await params;

  const access = await resolveRoutedProject(user.id, requestedWorkspaceId, requestedProjectId);
  if (access.access === "denied") {
    // Only what the caller already supplied. A refusal must not emit derived
    // facts — the project's real workspace, its PMO, its name or its status —
    // even to a server log, because a log line is one copy-paste away from a
    // support reply that turns this route into an existence oracle.
    console.error(
      JSON.stringify({
        event: "project_command_center.project_not_accessible",
        userId: user.id,
        requestedWorkspaceId,
        requestedProjectId,
      }),
    );
    return <ProjectNotAvailable />;
  }

  // From here the workspace is the AUTHORITATIVE one derived from
  // `projects.workspace_id`, never the routed segment — which by now has been
  // proven equal to it anyway. Every read below is scoped by it AND by the exact
  // project id.
  const { workspaceId, projectId } = access;
  const isArchived = access.access === "archived";

  // The capability layer still runs, unchanged, on the authorized pair. The
  // routed resolver decides ROUTE IDENTITY; this decides policy, and both must
  // hold. Passing the verdict's ids rather than the segments is what keeps the
  // two asking about the same tenant and the same project.
  await evaluateCapabilityAccess({ workspaceId, projectId, permission: "read" });

  const supabase = await createSupabaseServerClient();

  // Identity, with the caller's own client so RLS applies, scoped by BOTH ids so
  // it can never return another workspace's row. Deliberately distinguishing a
  // query error from an absent row: this screen has to tell "we could not load
  // it" apart from "it is not yours", and a helper that collapses both to `null`
  // cannot support that distinction.
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select(PROJECT_IDENTITY_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", projectId)
    .maybeSingle<ProjectIdentityRow>();

  if (projectError) {
    console.error(
      JSON.stringify({
        event: "project_command_center.project_unavailable",
        workspaceId,
        projectId,
        reason: projectError.message,
      }),
    );
    return (
      <Shell>
        <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-6">
          <p className="text-sm font-semibold text-amber-900">We couldn&apos;t load this project</p>
          <p className="mt-1 text-xs text-amber-700/80">
            This is a temporary problem reading your workspace, not a permissions issue. Nothing has been
            changed or lost. Please try again in a moment.
          </p>
          <a
            href={projectCommandCenterPath(workspaceId, projectId)}
            className="mt-3 inline-block rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Try again
          </a>
        </div>
      </Shell>
    );
  }

  // Authorized a moment ago but unreadable now: deleted in between, or hidden by
  // RLS. Same refusal, same wording — there is nothing safe to say beyond it.
  if (!project) return <ProjectNotAvailable />;

  // PMO ancestry, when there is any. `projects.pmo_id` is NULLABLE, so a direct
  // project has no PMO node and none is fabricated for it. Scoped by the
  // AUTHORIZED workspace as well as the id: the FK constrains `pmo_id` to a real
  // PMO but not to a PMO in this project's workspace, and a breadcrumb is not the
  // place to discover cross-tenant data.
  //
  // The error is CARRIED, not discarded. A failed read tells us nothing about
  // this project's ancestry, and rendering it as an absent PMO would state a fact
  // we never established — the same lie `ZoneDegraded` exists to prevent one zone
  // down. `resolveProjectPmoAncestry` keeps the outcomes apart; only `resolved`
  // carries a `pmo`, so no failure path can reach the breadcrumb.
  const pmoLookup = project.pmo_id
    ? await supabase
        .from("pmos")
        .select("id, name")
        .eq("id", project.pmo_id)
        .eq("workspace_id", workspaceId)
        .maybeSingle<{ id: string; name: string }>()
    : { data: null, error: null };

  const ancestry = resolveProjectPmoAncestry({
    pmoId: project.pmo_id,
    row: pmoLookup.data,
    error: pmoLookup.error ? { message: pmoLookup.error.message } : null,
  });

  if (ancestry.state === "unavailable") {
    // Scoped identifiers only, and exactly the ones every other event on this
    // route already carries. The unresolved `pmo_id` is deliberately NOT logged:
    // it is the one identifier here whose ancestry we failed to verify, and a log
    // line is one copy-paste away from a support reply.
    console.error(
      JSON.stringify({
        event: "project_command_center.pmo_ancestry_unavailable",
        workspaceId,
        projectId,
        reason: pmoLookup.error?.message,
      }),
    );
  }

  // Only resolved ancestry reaches the trail. `null` in all three other states.
  const pmo: ProjectBreadcrumbPmo = ancestry.pmo;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name")
    .eq("id", workspaceId)
    .maybeSingle<{ id: string; name: string }>();

  // ── The four zone reads ────────────────────────────────────────────────────
  //
  // `allSettled`, not `all`. ADR-PMF-070 Frontend Rule 4: one composed source
  // failing degrades only its own zone; a Command Center never blanks entirely
  // because one read failed. `Promise.all` would reject the whole set on a single
  // rejection and take the header and three healthy zones down with it — which is
  // the all-or-nothing rendering that ADR explicitly rejected.
  //
  // Every one of these is scoped by the AUTHORIZED workspace AND the exact
  // project. No workspace-wide read exists on this screen.
  const [raidSettled, recommendationsSettled, decisionsSettled, assuranceSettled] = await Promise.allSettled([
    runProjectScopedQuery<ProjectRaidRow>(supabase, projectRaidQuery(workspaceId, projectId)),
    runProjectScopedQuery<ProjectRecommendationRow>(supabase, projectRecommendationsQuery(workspaceId, projectId)),
    runProjectScopedQuery<ProjectRecommendationRow>(supabase, projectPendingDecisionsQuery(workspaceId, projectId)),
    supabase.rpc("get_operational_assurance_summary", { p_workspace_id: workspaceId, p_project_id: projectId }),
  ]);

  function readZone<T>(
    settled: PromiseSettledResult<ProjectScopedQueryResult<T>>,
    event: string,
  ): { rows: T[]; total: number | null } | null {
    if (settled.status === "rejected" || settled.value.error) {
      console.error(
        JSON.stringify({
          event,
          workspaceId,
          projectId,
          reason:
            settled.status === "rejected"
              ? settled.reason instanceof Error
                ? settled.reason.message
                : "unknown"
              : settled.value.error?.message,
        }),
      );
      return null;
    }
    return { rows: settled.value.data ?? [], total: settled.value.total };
  }

  const raidRead = readZone<ProjectRaidRow>(raidSettled, "project_command_center.raid_unavailable");
  const recommendationsRead = readZone<ProjectRecommendationRow>(
    recommendationsSettled,
    "project_command_center.recommendations_unavailable",
  );
  const decisionsRead = readZone<ProjectRecommendationRow>(
    decisionsSettled,
    "project_command_center.pending_decisions_unavailable",
  );

  // The in-memory scope guards. With the descriptors above these can only drop a
  // row if the query stopped matching the guard, so a drop means a regression —
  // and `resolveVisibleTotal` then withholds the total rather than printing a
  // number that disagrees with the list beneath it.
  const raidItems = raidRead ? selectProjectRaid(raidRead.rows, workspaceId, projectId) : [];
  const raidTotal = raidRead ? resolveVisibleTotal(raidRead.rows.length, raidItems.length, raidRead.total) : null;
  const raidCategories = countRaidByCategory(raidItems);

  const recommendations = recommendationsRead
    ? selectProjectRecommendations(recommendationsRead.rows, workspaceId, projectId, false)
    : [];
  const recommendationsTotal = recommendationsRead
    ? resolveVisibleTotal(recommendationsRead.rows.length, recommendations.length, recommendationsRead.total)
    : null;

  const pendingDecisions = decisionsRead
    ? selectProjectRecommendations(decisionsRead.rows, workspaceId, projectId, true)
    : [];
  // The Pending Decisions headline count and the rows beneath it come from ONE
  // statement — `count: "exact"` rides along with the same request — and from one
  // predicate, because they ARE the same query. The assurance RPC's
  // `openRecommendations` was checked against this predicate and matches it
  // exactly (`workspace_id`, `project_id`, `governance_event_id is not null`,
  // `status = 'proposed'`), but it is deliberately not used here: it is a
  // different statement at a different snapshot, and sourcing it from the RPC
  // would also make an RPC failure degrade TWO zones instead of one.
  const pendingDecisionsTotal = decisionsRead
    ? resolveVisibleTotal(decisionsRead.rows.length, pendingDecisions.length, decisionsRead.total)
    : null;

  let governance: ProjectGovernanceFacts | null = null;
  if (assuranceSettled.status === "rejected" || assuranceSettled.value.error) {
    console.error(
      JSON.stringify({
        event: "project_command_center.assurance_unavailable",
        workspaceId,
        projectId,
        reason:
          assuranceSettled.status === "rejected"
            ? assuranceSettled.reason instanceof Error
              ? assuranceSettled.reason.message
              : "unknown"
            : assuranceSettled.value.error?.message,
      }),
    );
  } else {
    governance = selectProjectGovernanceFacts(assuranceSettled.value.data, workspaceId, projectId);
  }

  const breadcrumb = projectCommandCenterBreadcrumb({
    workspaceLabel: workspace?.name ?? "Workspace",
    workspaceId,
    pmo,
    projectName: project.name,
    projectId: project.id,
  });

  return (
    <Shell>
      <header
        className="rounded-3xl border border-slate-200 bg-white p-6"
        style={{ borderTopColor: project.color ?? undefined, borderTopWidth: project.color ? 3 : undefined }}
      >
        <nav aria-label="Breadcrumb" className="text-xs uppercase tracking-[0.24em] text-cyan-800">
          {breadcrumb.map((node, index) => (
            <span key={`${node.label}-${index}`}>
              {index > 0 ? <span className="text-slate-400"> / </span> : null}
              {node.href === null ? (
                // Terminal node. `03-navigation-contracts.md` §2.3 rule 4: an
                // entity-qualified Command Center is where a trail ends, so it is
                // never a link to somewhere else.
                <span aria-current="page" className="text-slate-700">
                  {node.label}
                </span>
              ) : (
                <Link href={node.href} className="hover:text-cyan-900">
                  {node.label}
                </Link>
              )}
            </span>
          ))}
        </nav>
        {/*
          Ancestry degraded, and said so. Non-blocking on purpose: the breadcrumb
          above it is complete for the ancestry that DID resolve, every zone below
          renders untouched, and nothing here names, guesses at or substitutes a
          PMO. It replaces no crumb — it explains a crumb's absence, which is the
          one thing a silently shortened trail cannot do.
        */}
        {ancestry.state === "unavailable" ? (
          <p className="mt-2 text-[11px] text-amber-800">PMO ancestry is temporarily unavailable.</p>
        ) : null}
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          {project.icon ? <span className="mr-2">{project.icon}</span> : null}
          {project.name} — Project Command Center
        </h1>
        {project.description ? <p className="mt-2 max-w-3xl text-sm text-slate-700">{project.description}</p> : null}
        <p className="mt-3 text-[11px] uppercase tracking-[0.14em] text-zinc-500">Project status: {project.status}</p>
        <div className="mt-4">
          <ProjectTabNav workspaceId={workspaceId} projectId={project.id} active="command-center" />
        </div>
      </header>

      {isArchived ? <ProjectArchivedNotice archived={access.archived} /> : null}

      {/* ── Zone 1 ─────────────────────────────────────────────────────────── */}
      <Zone
        zone={ZONE_ATTENTION}
        note="Open risks, issues, dependencies and assumptions recorded for this project, most recently detected first."
      >
        {raidRead === null ? (
          <ZoneDegraded what="this project's open risks and issues" />
        ) : raidItems.length === 0 ? (
          <ZoneEmpty>No open risks, issues, assumptions or dependencies are recorded for this project.</ZoneEmpty>
        ) : (
          <>
            <p className="text-xs text-slate-600">
              Showing {raidCategories.risk} risk{raidCategories.risk === 1 ? "" : "s"} ·{" "}
              {raidCategories.issue} issue{raidCategories.issue === 1 ? "" : "s"} ·{" "}
              {raidCategories.dependency} dependenc{raidCategories.dependency === 1 ? "y" : "ies"} ·{" "}
              {raidCategories.assumption} assumption{raidCategories.assumption === 1 ? "" : "s"}
            </p>
            <ul className="mt-3 space-y-2">
              {raidItems.map((item) => (
                // Not a link. `03-canonical-information-architecture.md` §5.8's
                // Risks/Issues/Dependencies screens are ratified but not built,
                // so there is no canonical record home to point at — and a link
                // to a route with no page is a 404 wearing a product's clothes.
                // Routing these into an unrelated workspace-wide surface just to
                // make the row clickable would be worse: it would claim a
                // per-project scope that surface does not have.
                <li key={item.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-medium text-slate-900">{item.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-600">{item.description}</p>
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                      {item.category} · {item.status}
                    </span>
                    <ExtractionProvenance
                      autoGenerated={item.auto_generated}
                      confidence={item.confidence_score}
                      occurrences={item.occurrence_count}
                    />
                  </p>
                </li>
              ))}
            </ul>
            <MoreThanShown shown={raidItems.length} total={raidTotal} />
          </>
        )}
      </Zone>

      {/* ── Zone 2 ─────────────────────────────────────────────────────────── */}
      <Zone
        zone={ZONE_RECOMMENDATIONS}
        note="Suggestions PMFreak derived from this project's recorded risks and issues. Nothing here has been approved."
      >
        {recommendationsRead === null ? (
          <ZoneDegraded what="this project's recommendations" />
        ) : recommendations.length === 0 ? (
          <ZoneEmpty>No unreviewed recommendation has been produced for this project.</ZoneEmpty>
        ) : (
          <>
            <ul className="space-y-2">
              {recommendations.map((item) => (
                // Directive, then Why, then Evidence, then Confidence — the order
                // `08-ai-interaction-patterns.md` §2 fixes. Read-only: no Accept,
                // no Reject, no Defer on this screen in this slice.
                <li key={item.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-medium text-slate-900">{item.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-600">{item.description}</p>
                  <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                    {item.recommended_action_type.replaceAll("_", " ")}
                    {item.impact_level ? ` · impact ${item.impact_level}` : ""}
                    {item.recommended_owner ? ` · suggested owner ${item.recommended_owner}` : ""}
                    {item.recommended_due_window ? ` · ${item.recommended_due_window}` : ""}
                  </p>
                  <RecommendationDisclosure label="Why" entries={selectRecommendationDisclosure(item.rationale)} />
                  <RecommendationDisclosure label="Evidence" entries={selectRecommendationDisclosure(item.evidence_summary)} />
                  {item.confidence_score !== null ? (
                    <p className="mt-1 text-[11px] text-zinc-500">
                      Generated by PMFreak · Confidence {Math.round(item.confidence_score)}%
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] text-zinc-500">Generated by PMFreak · Confidence not recorded</p>
                  )}
                </li>
              ))}
            </ul>
            <MoreThanShown shown={recommendations.length} total={recommendationsTotal} />
          </>
        )}
      </Zone>

      {/* ── Zone 3 ─────────────────────────────────────────────────────────── */}
      <Zone
        zone={ZONE_DECISIONS}
        note="Governed recommendations that cannot proceed until a person records a decision."
      >
        {decisionsRead === null ? (
          <ZoneDegraded what="this project's pending decisions" />
        ) : pendingDecisions.length === 0 ? (
          <ZoneEmpty>No governed recommendation is waiting on a decision for this project.</ZoneEmpty>
        ) : (
          <>
            {pendingDecisionsTotal !== null ? (
              <p className="text-sm font-semibold text-slate-900">
                {pendingDecisionsTotal} awaiting a decision
              </p>
            ) : null}
            <ul className="mt-3 space-y-2">
              {pendingDecisions.map((item) => (
                <li key={item.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-medium text-slate-900">{item.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-600">{item.description}</p>
                  <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-zinc-500">
                    {item.recommended_action_type.replaceAll("_", " ")} · awaiting decision
                  </p>
                </li>
              ))}
            </ul>
            <MoreThanShown shown={pendingDecisions.length} total={pendingDecisionsTotal} />
          </>
        )}
      </Zone>

      {/* ── Zone 4 ─────────────────────────────────────────────────────────── */}
      <Zone
        zone={ZONE_HEALTH}
        note="Counted facts about this project. No score, no rating — each number is exactly the records it names."
      >
        {governance === null ? (
          <ZoneDegraded what="this project's governance totals" />
        ) : (
          // Each tile is a stored count under the label naming exactly the rows it
          // counted. `decisionRequiredCount` is deliberately absent: it counts the
          // classification governance events were RAISED under, which
          // `record_operational_decision` never rewrites, so it does not fall when
          // a PM decides — and the live queue is Zone 3, counted from Zone 3's own
          // statement. See `selectProjectGovernanceFacts`.
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { label: "Project status", value: project.status, tone: "text-slate-900" },
              { label: "Governance events recorded", value: governance.totalGovernanceEvents, tone: "text-slate-900" },
              { label: "Governance violations recorded", value: governance.violationsCount, tone: "text-red-800" },
            ].map((fact) => (
              <div key={fact.label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">{fact.label}</p>
                <p className={`mt-1 text-lg font-semibold ${fact.tone}`}>{fact.value}</p>
              </div>
            ))}
          </div>
        )}
      </Zone>

      <p className="px-1 text-xs text-slate-500">
        This Project Command Center reads this project only. Tasks, documents and project settings live on{" "}
        <Link href={projectHomePath(workspaceId, project.id)} className="text-cyan-800 hover:text-cyan-900">
          Project Home
        </Link>
        . Showing at most {ZONE_ROW_LIMIT} items per section.
      </p>
    </Shell>
  );
}
