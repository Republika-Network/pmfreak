import type { WorkspaceRole } from "@/lib/workspace-access";
import type {
  WorkspaceActivationEvidence,
  WorkspaceActivationMode,
  WorkspaceActivationPhase,
  WorkspaceActivationResult,
  WorkspaceActivationStage,
  WorkspaceActivationStep,
  WorkspaceActivationStepId,
  WorkspaceActivationStepTier,
} from "./types";

/**
 * Pure activation rules. Everything in this file derives from
 * WorkspaceActivationEvidence — no I/O, no clocks, no randomness — so the
 * whole rule set is unit-testable and can never invent progress.
 */

const ROLE_RANK: Record<WorkspaceRole, number> = { owner: 4, admin: 3, pm: 2, viewer: 1 };

const roleAtLeast = (role: WorkspaceRole, minimum: WorkspaceRole): boolean =>
  ROLE_RANK[role] >= ROLE_RANK[minimum];

/**
 * Individual vs team is derived from existing concepts only: an explicit
 * `workspaces.owner_type = 'personal'`, real memberships, and real pending
 * invitations. Inviting someone (or being more than one member) always means
 * team, regardless of owner_type.
 */
export function deriveWorkspaceActivationMode(
  evidence: Pick<WorkspaceActivationEvidence, "ownerType" | "memberCount" | "pendingInviteExists">,
): WorkspaceActivationMode {
  if (evidence.memberCount > 1 || evidence.pendingInviteExists) return "team";
  if (evidence.ownerType && evidence.ownerType !== "personal") return "team";
  return "individual";
}

type StepDefinition = {
  id: WorkspaceActivationStepId;
  phase: WorkspaceActivationPhase;
  /** Minimum real workspace role able to perform the CTA; null = no direct action. */
  minimumActionRole: WorkspaceRole | null;
  route: string | null;
  blockedBy: WorkspaceActivationStepId[];
  requiredIn: (mode: WorkspaceActivationMode) => boolean;
  tierIn: (mode: WorkspaceActivationMode) => WorkspaceActivationStepTier;
  applicable: (evidence: WorkspaceActivationEvidence, mode: WorkspaceActivationMode) => boolean;
  completed: (evidence: WorkspaceActivationEvidence) => boolean;
  note: (evidence: WorkspaceActivationEvidence) => WorkspaceActivationStep["note"];
};

const always = () => true;
const noNote = () => null;

/**
 * The step catalog. Evidence mapping (see docs/architecture/workspace-activation.md):
 * every `completed` predicate reads a fact about real rows, never a stored flag.
 */
const STEP_DEFINITIONS: StepDefinition[] = [
  {
    id: "workspace_created",
    phase: "foundation",
    minimumActionRole: null,
    route: null,
    blockedBy: [],
    requiredIn: () => true,
    tierIn: () => "essential",
    applicable: always,
    // Evaluation only happens for an authenticated member of a real
    // workspace, so the evidence itself is the proof.
    completed: (e) => Boolean(e.workspaceId && e.userId),
    note: noNote,
  },
  {
    id: "pmo_created",
    phase: "foundation",
    // PMO activation (savePmoTenant) rewrites workspace governance and renames the
    // workspace — owner/admin only (PR-3, F5).
    minimumActionRole: "admin",
    route: "/create-command-center",
    blockedBy: [],
    requiredIn: (mode) => mode === "team",
    tierIn: (mode) => (mode === "team" ? "essential" : "optional"),
    applicable: always,
    completed: (e) => e.pmoExists,
    note: noNote,
  },
  {
    id: "member_invited",
    phase: "foundation",
    minimumActionRole: "admin",
    route: "/team",
    blockedBy: [],
    requiredIn: () => false,
    tierIn: (mode) => (mode === "team" ? "recommended" : "optional"),
    // A personal workspace with nobody invited genuinely has no team step.
    applicable: (e, mode) =>
      !(mode === "individual" && e.ownerType === "personal" && e.memberCount <= 1 && !e.pendingInviteExists),
    completed: (e) => e.memberCount > 1 || e.pendingInviteExists,
    note: (e) => (e.memberCount <= 1 && e.pendingInviteExists ? "invite_pending" : null),
  },
  {
    id: "project_created",
    phase: "execution",
    minimumActionRole: "pm",
    route: "/projects/new",
    blockedBy: [],
    requiredIn: () => true,
    tierIn: () => "essential",
    applicable: always,
    completed: (e) => e.projectExists,
    note: noNote,
  },
  {
    id: "task_created",
    phase: "execution",
    minimumActionRole: "pm",
    route: "/command-center",
    blockedBy: ["project_created"],
    requiredIn: () => true,
    tierIn: () => "essential",
    applicable: always,
    completed: (e) => e.taskExists,
    note: noNote,
  },
  {
    id: "milestone_created",
    phase: "execution",
    minimumActionRole: "pm",
    route: "/command-center",
    blockedBy: ["project_created"],
    requiredIn: () => false,
    tierIn: () => "optional",
    applicable: always,
    completed: (e) => e.milestoneExists,
    note: noNote,
  },
  {
    id: "raid_registered",
    phase: "execution",
    minimumActionRole: "pm",
    route: "/command-center",
    blockedBy: ["project_created"],
    requiredIn: () => false,
    tierIn: () => "optional",
    applicable: always,
    completed: (e) => e.raidItemExists,
    note: noNote,
  },
  {
    id: "conversation_started",
    phase: "execution",
    // All real member roles can write in context chat (RLS allows members).
    minimumActionRole: "viewer",
    route: "/chat",
    blockedBy: [],
    requiredIn: () => false,
    tierIn: () => "recommended",
    applicable: always,
    completed: (e) => e.userMessageExists,
    note: noNote,
  },
  {
    id: "execution_signal_generated",
    phase: "operational_value",
    // Signals are generated by the system from real activity; the CTA leads
    // to capturing more real context, which pm+ can do.
    minimumActionRole: "pm",
    route: "/input-hub",
    blockedBy: ["project_created"],
    requiredIn: () => false,
    tierIn: () => "recommended",
    applicable: always,
    completed: (e) => e.raidItemExists || e.governanceSignalExists || e.recommendedActionExists,
    note: noNote,
  },
  {
    id: "insights_reviewed",
    phase: "operational_value",
    minimumActionRole: "viewer",
    route: "/executive",
    blockedBy: ["execution_signal_generated"],
    requiredIn: () => false,
    tierIn: () => "optional",
    applicable: always,
    // Requires both a real reviewable insight (a persisted recommendation)
    // and the persisted first-view interaction event.
    completed: (e) => e.recommendedActionExists && Boolean(e.insightsFirstViewedAt),
    note: noNote,
  },
];

export function deriveActivationSteps(evidence: WorkspaceActivationEvidence): WorkspaceActivationStep[] {
  const mode = deriveWorkspaceActivationMode(evidence);
  const completedById = new Map<WorkspaceActivationStepId, boolean>();
  for (const def of STEP_DEFINITIONS) completedById.set(def.id, def.completed(evidence));

  return STEP_DEFINITIONS.map((def) => {
    const applicable = def.applicable(evidence, mode);
    const completed = completedById.get(def.id) ?? false;
    const blocked = def.blockedBy.some((dep) => !(completedById.get(dep) ?? false));

    const status: WorkspaceActivationStep["status"] = !applicable
      ? "not_applicable"
      : completed
        ? "completed"
        : blocked
          ? "blocked"
          : "available";

    return {
      id: def.id,
      phase: def.phase,
      status,
      required: applicable && def.requiredIn(mode),
      tier: def.tierIn(mode),
      route: def.route,
      blockedBy: def.blockedBy,
      actionAllowed:
        def.minimumActionRole !== null && roleAtLeast(evidence.role, def.minimumActionRole),
      note: def.note(evidence),
    };
  });
}

export function deriveActivationStage(evidence: WorkspaceActivationEvidence): WorkspaceActivationStage {
  const signalExists =
    evidence.raidItemExists || evidence.governanceSignalExists || evidence.recommendedActionExists;

  if (!evidence.projectExists) return "workspace_created";
  if (!evidence.taskExists) return "project_created";
  if (!signalExists) return "execution_started";
  if (!evidence.recommendedActionExists) return "signals_available";
  return "insights_available";
}

export function evaluateActivationRules(evidence: WorkspaceActivationEvidence): WorkspaceActivationResult {
  const mode = deriveWorkspaceActivationMode(evidence);
  const steps = deriveActivationSteps(evidence);
  const stage = deriveActivationStage(evidence);

  const applicable = steps.filter((step) => step.status !== "not_applicable");
  const essential = applicable.filter((step) => step.required);
  const recommended = applicable.filter((step) => !step.required);

  const completedEssentialSteps = essential.filter((step) => step.status === "completed").length;
  const completedRecommendedSteps = recommended.filter((step) => step.status === "completed").length;

  return {
    stage,
    mode,
    operationallyStarted: evidence.projectExists && evidence.taskExists,
    workspaceReady: essential.length > 0 && completedEssentialSteps === essential.length,
    completedEssentialSteps,
    totalEssentialSteps: essential.length,
    completedRecommendedSteps,
    totalRecommendedSteps: recommended.length,
    steps,
  };
}
