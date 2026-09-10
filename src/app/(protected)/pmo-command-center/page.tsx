import { redirect } from "next/navigation";
import { PM_OPERATIONS_PATH } from "@/lib/pm-operations/pm-operations-paths";

/**
 * Legacy internal-dashboard entry point — now a redirect, not a screen.
 *
 * The screen moved to `/pm-operations` because ADR-PMF-014 Rule 6 forbids an
 * internal ops surface from carrying the same unqualified phrase as the
 * user-facing PMO Command Center, which is a different screen over a different
 * entity (see `@/lib/pm-operations/pm-operations-paths` for why the two are not
 * the same thing, and for the evidence that this route never was the PMO
 * Command Center).
 *
 * This path stays because operator bookmarks and in-flight internal links
 * predate the rename. It holds no copy of the screen — one redirect, one
 * destination, so the two cannot drift (ADR-PMF-068 rule 2).
 *
 * No auth call here on purpose. `(protected)/layout.tsx` is what protects both
 * this path and `/pm-operations`, so an unauthenticated request is bounced to
 * login whichever of the two it lands on, and this page has nothing to resolve
 * that would need a user id. Session-continuation behaviour is unchanged by the
 * rename: neither the old path nor the new one is in `ALLOWED_PREFIXES`
 * (`validate-continuation-route.ts`), so an expired session on either returns to
 * the default landing route exactly as it did before. Making the internal `pm-*`
 * family continuation-safe is a real improvement, but it is a behaviour change
 * affecting all four sibling routes, not part of this rename.
 */
export default function PmoCommandCenterLegacyEntryPage() {
  redirect(PM_OPERATIONS_PATH);
}
