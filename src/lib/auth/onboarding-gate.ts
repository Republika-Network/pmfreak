import type { OnboardingState } from "@/lib/auth/resolve-onboarding-state";

export type OnboardingGateInput = {
  /** The derived onboarding state of the workspace the request is rendering. */
  state: OnboardingState;
  /**
   * True when the rendered workspace came from a canonical route segment AND is
   * archived. False for active workspaces and for every non-routed render.
   */
  routedWorkspaceArchived: boolean;
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
 * The exemption is deliberately NARROW: it suppresses `needs_project` only.
 *
 *   - `trial_blocked` still redirects. That is an ENTITLEMENT decision and has
 *     nothing to do with archival; letting an archived URL bypass it would turn
 *     a read-only viewing affordance into a billing bypass.
 *   - `no_workspace` still redirects. It cannot co-occur with a routed workspace
 *     in practice, and treating it as an exemption would be inventing a state.
 *
 * Nothing is UNLOCKED by the exemption. The states that already pass the gate
 * (`needs_task`, `execution_started`, `active`) render exactly the same shell for
 * an archived workspace today, so an archived workspace WITH projects already
 * reached this surface before the exemption existed; the exemption only stops
 * the zero-project case from being redirected away from its own read-only page.
 * The read-only page itself withholds every mutation affordance independently of
 * this decision, and every write API authorizes on its own.
 */
export function shouldRedirectForOnboarding({ state, routedWorkspaceArchived }: OnboardingGateInput): boolean {
  if (state === "trial_blocked") return true;
  if (state === "no_workspace") return true;
  if (state === "needs_project") return !routedWorkspaceArchived;
  return false;
}
