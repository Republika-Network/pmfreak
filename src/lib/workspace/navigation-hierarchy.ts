/**
 * PMFreak navigation contract.
 *
 * PRIMARY is the product. Exactly four destinations, in this order, and the order is part
 * of the contract — it is the mental model a PM builds on their first day:
 *
 *   Command Center → Projects → Execution → Portfolio
 *
 * This replaced a 27-node module inventory whose first level advertised the architecture
 * rather than the product (Workspace Chat / Daily Execution / Create Center / New Project
 * as primary; Summary / Execution / Executive / Portfolio as "lenses"; seven more as
 * utilities). Two of those entries were the same word for different things — `/execution`
 * was labelled "Daily Execution" while `/command-center` was labelled "Execution" — so the
 * navigation could not be read without already knowing the system.
 *
 * Nothing was deleted. Every route still exists and still resolves; the surfaces that left
 * the first level were reclassified by what they mean to a PM, not removed. A few genuinely
 * duplicate product entries (`/chat`, `/dashboard`) are route-reachable but
 * navigation-hidden: see the note above SECONDARY below.
 *
 * TIERS
 *   primary   — the four product destinations. Always visible.
 *   utility   — supporting workspace surfaces, presented behind "More".
 *   advanced  — capability-gated runtime surfaces, hidden until their domain unlocks.
 *               Their capability requirements are unchanged by this hierarchy.
 */
export type NavigationTier = "primary" | "utility" | "advanced";

export type NavigationNode = {
  label: string;
  href: string;
  tier: NavigationTier;
  visibleByDefault: boolean;
  requiresCapability?: string;
};

export const NAVIGATION_HIERARCHY: NavigationNode[] = [
  // ── Primary: the product. Order is the contract; do not reorder. ──────────
  //
  // One concept, one name. `/command-center` is "Command Center" and nothing else
  // is; `/execution` is "Execution" and nothing else is.
  { label: "Command Center", href: "/command-center", tier: "primary", visibleByDefault: true },
  { label: "Projects", href: "/projects", tier: "primary", visibleByDefault: true },
  { label: "Execution", href: "/execution", tier: "primary", visibleByDefault: true },
  { label: "Portfolio", href: "/portfolio", tier: "primary", visibleByDefault: true },

  // ── Secondary ("More"): real surfaces that are not the daily loop ─────────
  //
  // Deliberately NOT here, and route-reachable but navigation-hidden instead:
  //   /chat      — workspace chat. Chat is the copilot layer, not a destination
  //                a PM navigates to; the Command Center already hosts it.
  //   /dashboard — "Summary". A second home competing with Command Center.
  //   /projects/new — project creation is discoverable from Projects itself,
  //                where it already has a Create Project form and an empty-state CTA.
  // Each keeps working by direct URL. Carrying them in "More" purely for
  // discoverability would preserve the duplication this change exists to remove.
  { label: "Workspaces", href: "/workspaces", tier: "utility", visibleByDefault: true },
  { label: "Workspace Setup", href: "/workspace-setup", tier: "utility", visibleByDefault: true },
  { label: "PMOs", href: "/pmos", tier: "utility", visibleByDefault: true },
  { label: "Programs", href: "/programs", tier: "utility", visibleByDefault: true },
  { label: "Team", href: "/team", tier: "utility", visibleByDefault: true },
  { label: "Upload", href: "/upload", tier: "utility", visibleByDefault: true },
  { label: "Executive", href: "/executive", tier: "utility", visibleByDefault: true },
  // Creates a Command Center (the PMO container) — the preferred route; the legacy
  // /create-pmo route must never be a navigation target.
  { label: "New Command Center", href: "/create-command-center", tier: "utility", visibleByDefault: true },

  // ── Advanced: capability-gated. Requirements unchanged. ──────────────────
  { label: "Operational Memory", href: "/operational-memory", tier: "advanced", visibleByDefault: false, requiresCapability: "memory" },
  { label: "Stakeholders", href: "/stakeholder-intel", tier: "advanced", visibleByDefault: false, requiresCapability: "stakeholders" },
  { label: "Change Detection", href: "/change-detection", tier: "advanced", visibleByDefault: false, requiresCapability: "risks" },
  { label: "Meetings", href: "/meetings", tier: "advanced", visibleByDefault: false, requiresCapability: "coordination" },
  { label: "Follow-up", href: "/follow-up-dashboard", tier: "advanced", visibleByDefault: false, requiresCapability: "delivery" },
  { label: "Governance", href: "/governance", tier: "advanced", visibleByDefault: false, requiresCapability: "governance" },
  { label: "Policies", href: "/policies", tier: "advanced", visibleByDefault: false, requiresCapability: "governance" },
  { label: "Trust Agents", href: "/trust/agents", tier: "advanced", visibleByDefault: false, requiresCapability: "interventions" },
  { label: "Audit", href: "/audit", tier: "advanced", visibleByDefault: false, requiresCapability: "governance" },
  { label: "Capabilities", href: "/capabilities", tier: "advanced", visibleByDefault: false, requiresCapability: "interventions" },
  { label: "Intelligence", href: "/intelligence", tier: "advanced", visibleByDefault: false, requiresCapability: "executive" },
  { label: "Trials", href: "/trials", tier: "advanced", visibleByDefault: false, requiresCapability: "interventions" },
];

export const getNavigationByTier = (tier: NavigationTier) => NAVIGATION_HIERARCHY.filter((node) => node.tier === tier);

/**
 * The four product destinations, in product order. Exported so navigation surfaces and
 * their tests read one source of truth rather than each re-deriving the order.
 */
export const getPrimaryNavigation = () => getNavigationByTier("primary");
