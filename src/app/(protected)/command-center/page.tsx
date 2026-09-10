import { redirect } from "next/navigation";
import { requireAuthUser } from "@/lib/auth";
import { ensureUserWorkspace } from "@/lib/workspaces";
import { resolvePreferredWorkspace } from "@/lib/workspaces/preferred-workspace";
import {
  COMMAND_CENTER_FORWARDED_QUERY_KEYS,
  firstQueryValue,
  workspaceCommandCenterPath,
} from "@/lib/workspace/command-center-paths";

/**
 * Legacy Command Center entry point — now a workspace RESOLVER, not a screen.
 *
 * The screen itself moved to the canonical, entity-qualified route
 * `/workspaces/[workspaceId]/command-center`
 * (`07-route-layout-and-navigation-architecture.md` §1). This path stays
 * because a large class of callers genuinely cannot know a workspace id at the
 * moment they are constructed, and must not be asked to:
 *
 *   - Pre-auth surfaces: the marketing navbar and landing hero link here for
 *     visitors who have no session at all, let alone a workspace.
 *   - Session plumbing: `src/proxy.ts`, `(protected)/layout.tsx` and
 *     `src/lib/auth.ts` use this as the post-authentication destination, which
 *     is decided before any workspace lookup has happened.
 *   - Bookmarks and shared links that predate the canonical route.
 *
 * Each of those keeps working unchanged: this page performs exactly the
 * workspace resolution the screen used to perform inline, then redirects. That
 * is the strangler seam (ADR-PMF-068 rule 2) — one resolution point, one
 * canonical destination, and no duplicate screen implementation.
 *
 * Query parameters are forwarded rather than dropped. `projectId`,
 * `from=onboarding` and `brainActivated` are the hand-off channel for project
 * creation and the guided first experience; losing them here would silently
 * downgrade a founder's first Command Center to the generic one, and the
 * redirect would be the last place anyone thought to look.
 */
export default async function CommandCenterLegacyEntryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireAuthUser();
  // Identical resolution to the one this screen used to do inline: honour the
  // user's active-workspace selection, and bootstrap a workspace for accounts
  // that have never had one. Behaviour is unchanged; only the destination is.
  const preferred = await resolvePreferredWorkspace(user.id);
  const workspace = preferred.workspaceId
    ? { workspaceId: preferred.workspaceId }
    : await ensureUserWorkspace(user.id);

  const params = await searchParams;
  const forwarded: Record<string, string> = {};
  for (const key of COMMAND_CENTER_FORWARDED_QUERY_KEYS) {
    // Shared with the canonical route on purpose. A repeated query key arrives
    // as an array; forwarding the first occurrence rather than serialising
    // "a,b" is what keeps a merely-duplicated link from producing an id the
    // screen cannot resolve. This used to be an inline copy of the same three
    // lines — identical in behaviour, but nothing held the two in step.
    const single = firstQueryValue(params[key]);
    if (single !== undefined) forwarded[key] = single;
  }

  redirect(workspaceCommandCenterPath(workspace.workspaceId, forwarded));
}
