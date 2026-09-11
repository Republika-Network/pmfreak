import type { OnboardingState } from "@/lib/auth/resolve-onboarding-state";

export type OnboardingGateInput = {
  /** The derived onboarding state of the workspace the request is rendering. */
  state: OnboardingState;
  /**
   * True when the rendered workspace came from a canonical route segment AND is
   * archived. False for active workspaces and for every non-routed render.
   */
  routedWorkspaceArchived: boolean;
  /**
   * True when the request is on a canonical Project route
   * `/workspaces/<w>/projects/<p>` AND `resolveRoutedProject` AUTHORIZED that
   * exact project and returned `archived`.
   *
   * It is deliberately not "the URL contains a project id". The flag is derived
   * from the same resolver Project Home itself uses, which reads
   * `projects.workspace_id` as the authority, refuses an ancestry claim that
   * disagrees with it, and refuses a project the caller has no membership for —
   * all as one indistinguishable `denied`. An arbitrary or someone else's project
   * id therefore sets this to false and the gate behaves exactly as before.
   *
   * Optional so every existing caller keeps its current behaviour verbatim.
   */
  routedProjectArchived?: boolean;
};

/**
 * Should the protected layout redirect this request to an onboarding step?
 *
 * Extracted from `(protected)/layout.tsx` as a pure function because the rule it
 * encodes is an INTERACTION between two independently-correct behaviours, and an
 * interaction is not something source-text assertions can check:
 *
 *   - the layout derives workspace context from the canonical route, so the
 *     onboarding gate now evaluates the workspace named in the URL; and
 *   - an archived workspace is authorized-but-read-only
 *     (`07-route-layout-and-navigation-architecture.md` §7).
 *
 * Composed, those produced a real defect: an archived workspace with no
 * non-archived projects derives `needs_project`, which redirected to
 * `/projects/new` — so the archived read-only Command Center never rendered, and
 * §7's "never a redirect that hides the archival happened" was violated by the
 * very change that set out to honour it. Instructing someone to create a project
 * in a workspace that cannot accept one is also simply a false instruction.
 *
 * The SAME composition bites one level down, and PR #609's review found it: an
 * ACTIVE workspace whose only projects are archived also derives `needs_project`,
 * because the evidence probe behind it is
 * `projects … .neq("status", "archived")`. So a canonical Project deep link
 * `/workspaces/W/projects/P` to an archived project was redirected to
 * `/projects/new` before `resolveRoutedProject` ever got to return its
 * archived/read-only verdict — `ProjectArchivedNotice` and the project's
 * last-known data were unreachable by construction. `routedWorkspaceArchived` did
 * not cover it: the WORKSPACE is active; it is the PROJECT that is archived.
 *
 * That is why the second flag exists rather than a widened first one. Both mean
 * "the entity this URL names is authorized and archived", established by the
 * resolver that owns that entity's identity — never by the URL itself.
 *
 * The exemption is deliberately NARROW: it suppresses `needs_project` only.
 *
 *   - `trial_blocked` still redirects. That is an ENTITLEMENT decision and has
 *     nothing to do with archival; letting an archived URL bypass it would turn
 *     a read-only viewing affordance into a billing bypass.
 *   - `no_workspace` still redirects. It cannot co-occur with a routed workspace
 *     in practice, and treating it as an exemption would be inventing a state.
 *   - An UNAUTHORIZED or non-existent project id still redirects, because it
 *     never produces an `archived` verdict in the first place. The URL is not the
 *     input; the resolver's answer about the URL is.
 *   - An ACTIVE routed project still redirects — and cannot occur anyway, since a
 *     non-archived project in the workspace makes `projectExists` true and the
 *     state is not `needs_project` at all. The archived case is the only way the
 *     two can co-occur, which is why it is the only case exempted.
 *
 * Nothing is UNLOCKED by the exemption. The states that already pass the gate
 * (`needs_task`, `execution_started`, `active`) render exactly the same shell for
 * an archived workspace today, so an archived workspace WITH projects already
 * reached this surface before the exemption existed; the exemption only stops
 * the zero-project case from being redirected away from its own read-only page.
 * The read-only page itself withholds every mutation affordance independently of
 * this decision, and every write API authorizes on its own.
 */
export function shouldRedirectForOnboarding({
  state,
  routedWorkspaceArchived,
  routedProjectArchived = false,
}: OnboardingGateInput): boolean {
  if (state === "trial_blocked") return true;
  if (state === "no_workspace") return true;
  if (state === "needs_project") return !routedWorkspaceArchived && !routedProjectArchived;
  return false;
}
