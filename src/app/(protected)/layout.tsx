import { isFounderOrInternalUser, buildAuthUserContext } from "@/lib/auth";
import { assertRuntimeAuthContinuity } from "@/lib/auth/runtime-auth-continuity";
import { resolveWriteWorkspace } from "@/lib/workspaces/resolve-write-workspace";
import { OperationalShell } from "@/components/pmfreak/operational-shell";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { resolvePostAuthDestination } from "@/lib/auth/resolve-post-auth-destination";
import { isSafeContinuationRoute } from "@/lib/auth/validate-continuation-route";
import { headers } from "next/headers";
import { resolveOnboardingState } from "@/lib/auth/resolve-onboarding-state";
import { getOnboardingRedirect } from "@/lib/auth/onboarding-route-map";
import { shouldRedirectForOnboarding } from "@/lib/auth/onboarding-gate";
import { resolveCapabilityProfile } from "@/lib/workspace/pilot-capability-set";
import { parseWorkspaceIdFromPath } from "@/lib/workspace/command-center-paths";
import { parseCanonicalPmoRoute } from "@/lib/pmos/pmo-paths";
import { parseCanonicalProjectRoute } from "@/lib/projects/project-paths";
import { parseCanonicalWorkspaceRoute } from "@/lib/workspaces/workspace-paths";
import { resolveRoutedWorkspace } from "@/lib/workspaces/routed-workspace";
import { resolveRoutedProject } from "@/lib/projects/routed-project";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const continuity = await assertRuntimeAuthContinuity();
  if (!continuity.ok) {
    const headersList = await headers();
    const currentPath = headersList.get("x-pathname") ?? "/command-center";
    const nextParam = isSafeContinuationRoute(currentPath) ? currentPath : "/command-center";
    const decision = resolvePostAuthDestination({ isAuthenticated: false, onboardingCompleted: false });
    console.log("[protected-layout] continuity check failed, redirecting to login. path:", currentPath, "issues:", continuity.issues);
    redirect(`${decision.destination}?next=${encodeURIComponent(nextParam)}`);
  }

  // Build the AuthUserContext directly from the user assertRuntimeAuthContinuity
  // already resolved above — deliberately NOT a second requireAuthUser()/
  // getAuthUser() call. A second, independent getUser() call in the same
  // request can itself trigger a Supabase token refresh; this app's
  // Server-Component Supabase client (src/lib/supabase/server.ts) cannot
  // persist a refreshed session, so calling getUser() twice risked silently
  // consuming/rotating the refresh token on the second call while the first
  // call's replacement was never written back to cookies — poisoning the
  // session for every subsequent request. See
  // docs/audits/remediation/release-gate-01-auth-session-persistence.md.
  const user = continuity.user ? buildAuthUserContext(continuity.user) : null;
  if (!user) {
    const headersList = await headers();
    const currentPath = headersList.get("x-pathname") ?? "/command-center";
    const nextParam = encodeURIComponent(currentPath || "/command-center");
    redirect(`/login?next=${nextParam}`);
  }
  /**
   * Workspace context for the shell AND for the onboarding gate below.
   *
   * A canonical Command Center URL names its own workspace, and this layout runs
   * BEFORE the page that authorizes it. Resolving from the preferred-workspace
   * cookie regardless produced two distinct defects on a shared deep link to
   * workspace B while the cookie still named A:
   *
   *   1. the shell loaded A's projects and rewrote its own Command Center
   *      navigation back to A, so the chrome disagreed with the page; and
   *   2. the onboarding gate evaluated A's state, so an incomplete A could
   *      redirect the user away from a B they were entitled to see.
   *
   * The path is only a HINT — `resolveRoutedWorkspace` authorizes it against
   * real membership and has no fallback, so a URL can never widen access. When
   * it is not authorized we keep the preferred workspace and let the page render
   * its own refusal, which is the surface that owns that message.
   *
   * Every canonical PMO surface carries its workspace in the same position —
   * `/workspaces/<id>/pmos/<id>` and its `chat`, `reports`, `settings` and
   * `command-center` children — so all five are read here, for exactly the two
   * defects above. Those do not care which PMO surface is being opened: a shared
   * link to a PMO in workspace B is just as capable of loading A's chrome and
   * being bounced by A's onboarding state on Chat as on the Command Center. The
   * family parser is what makes that one rule rather than five.
   *
   * The same is now true one level up. The canonical WORKSPACE family is three
   * surfaces, not one — Workspace Home `/workspaces/<id>`, the Command Center,
   * and Workspace Settings — and a deep link to any of them names its workspace
   * just as explicitly. `parseWorkspaceIdFromPath` is the Command Center's own
   * narrowing of `parseCanonicalWorkspaceRoute`, kept first because it is the
   * reading that surface owns; the family parser answers for Home and Settings.
   * Both read the one pattern in `workspace-paths.ts`, so the two lines cannot
   * disagree about which id a path names.
   *
   * And the same, again, for the canonical PROJECT family
   * (`/workspaces/<id>/projects/<id>`). A shared link to a project in workspace B
   * is exactly as capable of loading A's chrome and being bounced by A's
   * onboarding state, and this is the level where it bites hardest: a project is
   * the entity people actually paste links to. One more parser, one more line, the
   * same rule.
   *
   * The page's own resolver additionally checks this segment against
   * `pmos.workspace_id` / `projects.workspace_id` and refuses a mismatch; the
   * layout only needs enough context to stop answering from the cookie, and
   * cannot widen access on its own because `resolveRoutedWorkspace` authorizes
   * the hint before it is used.
   */
  const routedHeaders = await headers();
  const routedWorkspaceId =
    parseWorkspaceIdFromPath(routedHeaders.get("x-pathname") ?? "") ??
    parseCanonicalWorkspaceRoute(routedHeaders.get("x-pathname") ?? "")?.workspaceId ??
    parseCanonicalPmoRoute(routedHeaders.get("x-pathname") ?? "")?.workspaceId ??
    parseCanonicalProjectRoute(routedHeaders.get("x-pathname") ?? "")?.workspaceId ??
    null;
  const routedAccess = routedWorkspaceId ? await resolveRoutedWorkspace(user.id, routedWorkspaceId) : null;
  const routedWorkspaceArchived = routedAccess?.access === "archived";
  // Both ids of a canonical Project deep link, kept for the onboarding gate
  // below. Parsing is free; the AUTHORIZATION this feeds is deliberately not
  // performed here — see `routedProjectArchived`.
  const routedProjectRoute = parseCanonicalProjectRoute(routedHeaders.get("x-pathname") ?? "");
  const resolvedWorkspace =
    routedAccess && routedAccess.access !== "denied"
      ? { workspaceId: routedAccess.workspaceId, role: routedAccess.role, bootstrapped: false }
      : await resolveWriteWorkspace(user.id);
  console.log("[protected-layout] workspace resolution: workspaceId:", resolvedWorkspace.workspaceId, "bootstrapped:", resolvedWorkspace.bootstrapped, "fromRoute:", Boolean(routedAccess && routedAccess.access !== "denied"));

  // Canonical onboarding state — single source of truth for ALL routing
  // decisions in this app, including onboarding/activation redirects. Edge
  // middleware (src/proxy.ts) intentionally makes no onboarding-state
  // decisions of its own (it cannot run this async DB-derived resolver) —
  // this layout is the one place that redirects on state, so there is never
  // more than one routing authority to keep in sync.
  //
  // isRecovered is scoped to resolvedWorkspace.bootstrapped ONLY — a
  // workspace freshly bootstrapped in this request has no trial history yet.
  // It must never be driven by "the preferred-workspace cookie didn't match
  // a real membership, so we fell back to another one" — a client fully
  // controls that cookie and could hold it stale/tampered forever to skip
  // the trial gate indefinitely.
  const onboardingState = await resolveOnboardingState(user, resolvedWorkspace.workspaceId, { isRecovered: resolvedWorkspace.bootstrapped });
  console.log("[protected-layout] onboarding state:", onboardingState);

  if (onboardingState === "trial_blocked") {
    const supabase = createSupabaseServiceRoleClient({ routeId: "(protected)/layout", operation: "service_role_query", reason: "access_blocked_event_log", systemActor: "system" });
    const { data: memberships } = await supabase.from("workspace_memberships").select("workspace_id").eq("user_id", user.id).limit(20);
    const workspaceIds = (memberships ?? []).map((m: { workspace_id: string }) => m.workspace_id);
    const { data: trial } = await supabase.from("trial_licenses").select("id, invite_id, workspace_id").in("workspace_id", workspaceIds.length ? workspaceIds : ["00000000-0000-0000-0000-000000000000"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    await supabase.from("early_access_events").insert({ invite_id: trial?.invite_id ?? null, trial_license_id: trial?.id ?? null, workspace_id: trial?.workspace_id ?? null, event_type: "access_blocked_trial_inactive", event_payload: { userId: user.id } });
  }

  /**
   * Is this request standing on a canonical Project route whose project is
   * AUTHORIZED and ARCHIVED?
   *
   * The archived-workspace exemption above does not cover the case PR #609's
   * review found: an ACTIVE workspace whose only projects are archived still
   * derives `needs_project`, because the evidence probe behind it is
   * `projects … .neq("status", "archived")`. A deep link to
   * `/workspaces/W/projects/P` was therefore redirected to `/projects/new` before
   * `resolveRoutedProject` on Project Home ever ran, so the archived read-only
   * render — `ProjectArchivedNotice` and the project's last-known data — could
   * never be reached. §7 requires archival to be SHOWN, not hidden behind a
   * redirect telling the viewer to create something else.
   *
   * Two properties make this safe, and both are why it is written exactly this
   * way:
   *
   *   1. The URL is not the input. `resolveRoutedProject` is the same resolver
   *      Project Home uses: it reads `projects.workspace_id` as the authority,
   *      refuses an ancestry claim that disagrees with it, and refuses a project
   *      the caller has no membership in — all as one indistinguishable `denied`.
   *      An arbitrary project id in the URL yields `denied`, the flag stays
   *      false, and the gate behaves exactly as it did before. A URL can never
   *      bypass onboarding here; only an authorized archived project can.
   *   2. It is only asked when the answer can change the decision — the
   *      `needs_project` state. Every other state either redirects regardless
   *      (`trial_blocked`, `no_workspace`) or already passes, so no other render
   *      pays for this resolution and no other state can be affected by it.
   */
  const routedProjectArchived =
    onboardingState === "needs_project" && routedProjectRoute
      ? (await resolveRoutedProject(user.id, routedProjectRoute.workspaceId, routedProjectRoute.projectId)).access ===
        "archived"
      : false;

  // hasWorkspaceAccess (not isOnboardingComplete) gates general navigation:
  // a Project may exist — and a user may freely browse the rest of the app —
  // before Command Center is activated (ADR-PMF-006). Only no_workspace,
  // needs_project and trial_blocked force a redirect here. needs_task and
  // execution_started render the full app normally; /command-center itself
  // (already reachable like any other route) is what shows the correct next
  // action (add first task / activate Command Center) via the unchanged
  // evidence-derived WorkspaceOnboardingPanel/CommandCenterEmptyState.
  //
  // `shouldRedirectForOnboarding` replaces the bare `!hasWorkspaceAccess(...)`
  // test so that TWO cases can be exempted, both of them "the entity this URL
  // names is authorized and archived" deriving "needs_project": an archived
  // routed workspace, and an archived routed project inside an active one.
  // Instructing someone to create a project in a workspace that cannot accept
  // one is a false instruction, and redirecting there hides the archival that §7
  // requires be shown. `trial_blocked` and `no_workspace` still redirect — see
  // the function for why the exemption stops there.
  if (shouldRedirectForOnboarding({ state: onboardingState, routedWorkspaceArchived, routedProjectArchived })) {
    const headersList = await headers();
    const currentPath = headersList.get("x-pathname") ?? "";
    const dest = getOnboardingRedirect(onboardingState);
    // Loop guard: only redirect away from a path that isn't already the
    // derived destination itself (e.g. rendering /projects/new while
    // "needs_project" must not redirect to /projects/new again).
    if (currentPath !== dest) {
      redirect(dest);
    }
    return <div className="min-h-screen bg-[#FCFBF9] text-slate-900"><main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">{children}</main></div>;
  }

  const capabilityProfile = resolveCapabilityProfile({ isFounderOrInternal: isFounderOrInternalUser(user) });
  return <OperationalShell user={{ fullName: user.fullName, role: user.role, companyName: user.companyName }} capabilityProfile={capabilityProfile} workspaceId={resolvedWorkspace.workspaceId}>{children}</OperationalShell>;
}
