// PMFreak governance actor and authority vocabulary.
// OWNERSHIP: PMFreak. Not Soberania Protocol, not Frontera.
// These roles, permissions, actions and decision states are PMFreak's own product
// vocabulary. No canonical Protocol or Frontera contract defines them, publicly or
// privately, and none was widened to accommodate them.
// Concrete infrastructure is injected through the PMFreak-owned ports in ./ports.

export type GovernanceActorKind = "user" | "ai_agent" | "system" | "service";

export type GovernanceActorContext = {
  actorId: string;
  actorType: GovernanceActorKind;
  workspaceId?: string;
  projectId?: string;
  roles?: string[];
  permissions?: string[];
};

// PMFreak workspace permission vocabulary. Checked against ROLE_PERMISSION_MAP
// by the access-verification adapter.
// PMFreak projects its workspace permission model onto these identifiers.
export type GovernancePermission =
  | "read"
  | "write"
  | "delete"
  | "write_memory"
  | "delete_memory"
  | "manage_members"
  | "manage_projects"
  | "manage_workspace"
  | "manage_ai"
  | "manage_billing"
  | "execute_ai_action"
  | "view_executive"
  | "upload_documents";

// PMFreak route-level governance actions. Every value is a key of
// GOVERNANCE_POLICY_REGISTRY.
export type GovernanceAction =
  | "project.read"
  | "project.write"
  | "memory.read"
  | "memory.write"
  | "document.upload"
  | "billing.manage"
  | "members.manage"
  | "ai.execute"
  | "ai.manage"
  | "workspace.manage"
  | "executive.view"
  | "privileged.use"
  // P2-19 governed Project-knowledge transitions (owner/admin via manage_workspace; users only).
  | "knowledge.ratify"
  | "knowledge.reject"
  | "knowledge.revoke";

// PMFreak governance decision outcomes. "require_*_approval" values route into
// governance_approval_requests; these strings are persisted.
export type GovernanceDecisionState =
  | "allow"
  | "deny"
  | "require_human_approval"
  | "require_admin_approval"
  | "require_additional_scope";

export type GovernanceRiskLevel = "low" | "medium" | "high" | "critical";

// GovernanceActorRole is intentionally a string alias — PMFreak's concrete role names
// (e.g. "owner", "admin", "PM" in PMFreak) and inject them via the adapter layer.
// Governance logic inspects roles for approval routing only, never for permission evaluation.
export type GovernanceActorRole = string;

export type GovernanceCapabilityScope = {
  workspaceId?: string | null;
  projectId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
};
