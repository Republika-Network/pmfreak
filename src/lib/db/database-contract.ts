/**
 * Canonical database contract for PMFreak.
 *
 * This file is the single source of truth for every column the runtime
 * is permitted to read or write.  Any column referenced in application
 * code MUST be declared here.  The companion script
 * scripts/check-db-schema-contract.mjs enforces this at build time by
 * cross-checking declarations against actual migration files.
 *
 * DO NOT add columns here without a corresponding migration.
 */

// ─────────────────────────────────────────────────────────────────────────────
// workspaces
// Source: 20260512160000_workspace_authorization_rewrite.sql
//         20260601000000_schema_contract_hardening.sql (status column)
//         20260702000000_command_center_governance_foundation.sql (Command Center governance columns)
//
// A workspace row IS a Command Center: `command_center_type` NULL means the
// workspace was auto-bootstrapped on first login but the user has not yet
// configured a real Command Center (see ensureUserWorkspace / resolve-onboarding-state).
// ─────────────────────────────────────────────────────────────────────────────

export type WorkspaceStatus = "active" | "archived" | "deleted";

export type CommandCenterType =
  | "company_pmo"
  | "team_portfolio"
  | "independent"
  | "client_portfolio"
  | "improvement_program";

export type OwnerType = "personal" | "company" | "team" | "client" | "program";
export type VisibilityScope = "user" | "command_center" | "organization" | "client" | "public";
export type ConfidentialityLevel = "public" | "internal" | "confidential" | "restricted";

export type WorkspaceRow = {
  id: string;              // uuid
  name: string;            // text not null default 'Workspace'
  created_by_user_id: string | null; // uuid references auth.users
  status: WorkspaceStatus; // text not null default 'active' (added 20260601)
  created_at: string;      // timestamptz
  command_center_type: CommandCenterType | null; // text, nullable (added 20260702)
  owner_type: OwnerType | null;                  // text, nullable (added 20260702)
  data_owner: string | null;                     // uuid references auth.users (added 20260702)
  visibility_scope: VisibilityScope;              // text not null default 'command_center' (added 20260702)
  confidentiality_level: ConfidentialityLevel;    // text not null default 'internal' (added 20260702)
  governance_policy_id: string | null;            // uuid, nullable (added 20260702)
  source_context: string | null;                  // text, nullable (added 20260702)
};

export const WORKSPACE_SELECTABLE_COLUMNS = [
  "id",
  "name",
  "created_by_user_id",
  "status",
  "created_at",
  "command_center_type",
  "owner_type",
  "data_owner",
  "visibility_scope",
  "confidentiality_level",
  "governance_policy_id",
  "source_context",
] as const satisfies ReadonlyArray<keyof WorkspaceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// workspace_memberships
// Source: 20260512160000_workspace_authorization_rewrite.sql
// ─────────────────────────────────────────────────────────────────────────────

export type WorkspaceMemberRole = "owner" | "admin" | "pm" | "viewer";

export type WorkspaceMembershipRow = {
  workspace_id: string;    // uuid (PK part 1)
  user_id: string;         // uuid (PK part 2)
  role: WorkspaceMemberRole;
  created_at: string;      // timestamptz
};

export const WORKSPACE_MEMBERSHIP_SELECTABLE_COLUMNS = [
  "workspace_id",
  "user_id",
  "role",
  "created_at",
] as const satisfies ReadonlyArray<keyof WorkspaceMembershipRow>;

// ─────────────────────────────────────────────────────────────────────────────
// projects
// Source: 20260504100000_projects_system.sql
//         20260512160000_workspace_authorization_rewrite.sql (workspace_id)
//         20260601000000_schema_contract_hardening.sql (onboarding_payload)
//         20260828000001_workspace_pmo_project_hierarchy.sql (pmo_id)
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectStatus = "active" | "archived" | "completed";

export type ProjectMethodology = "predictive" | "agile" | "hybrid" | "kanban" | "other";

export type ProjectRow = {
  id: string;                  // uuid
  user_id: string;             // uuid references auth.users
  workspace_id: string;        // uuid references workspaces (not null after migration)
  pmo_id: string | null;       // uuid references pmos (nullable for legacy rows; added 20260828)
  name: string;                // text not null
  description: string | null;  // text
  status: ProjectStatus;       // text not null default 'active'
  methodology: ProjectMethodology | null; // text, nullable (added 20260828)
  icon: string | null;         // text, nullable (added 20260828)
  color: string | null;        // text, nullable (added 20260828)
  onboarding_payload: Record<string, unknown> | null; // jsonb (added 20260601)
  created_at: string;          // timestamptz
  updated_at: string;          // timestamptz
};

export const PROJECT_SELECTABLE_COLUMNS = [
  "id",
  "user_id",
  "workspace_id",
  "pmo_id",
  "name",
  "description",
  "status",
  "methodology",
  "icon",
  "color",
  "onboarding_payload",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ProjectRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pmos
// Source: 20260828000001_workspace_pmo_project_hierarchy.sql
//
// First-class PMO container: Workspace → PMO → Project. A workspace can hold
// many PMOs; every project belongs to exactly one PMO (pmo_id, backfilled).
// ─────────────────────────────────────────────────────────────────────────────

export type PmoStatus = "active" | "archived";

export type PmoType =
  | "company_pmo"
  | "team_portfolio"
  | "independent"
  | "client_portfolio"
  | "improvement_program"
  | "personal";

export type PmoRow = {
  id: string;                       // uuid
  workspace_id: string;             // uuid references workspaces
  name: string;                     // text not null
  description: string | null;       // text
  pmo_type: PmoType;                // text not null default 'company_pmo'
  icon: string | null;              // text
  color: string | null;             // text
  status: PmoStatus;                // text not null default 'active'
  created_by_user_id: string | null; // uuid references auth.users
  created_at: string;               // timestamptz
  updated_at: string;               // timestamptz
};

export const PMO_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "name",
  "description",
  "pmo_type",
  "icon",
  "color",
  "status",
  "created_by_user_id",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof PmoRow>;

// ─────────────────────────────────────────────────────────────────────────────
// context_conversations / context_messages
// Source: 20260828000001_workspace_pmo_project_hierarchy.sql
//
// One isolated chat thread per context scope (workspace | pmo | project).
// Scope shape is enforced by a CHECK constraint; the AI layer must never mix
// history across scopes.
// ─────────────────────────────────────────────────────────────────────────────

export type ContextConversationType = "workspace" | "pmo" | "project";
export type ContextConversationStatus = "active" | "archived";

export type ContextConversationRow = {
  id: string;                        // uuid
  workspace_id: string;              // uuid references workspaces
  context_type: ContextConversationType; // text not null
  pmo_id: string | null;             // uuid references pmos (required for pmo scope)
  project_id: string | null;         // uuid references projects (required for project scope)
  title: string;                     // text not null default 'Conversation'
  status: ContextConversationStatus; // text not null default 'active'
  created_by_user_id: string | null; // uuid references auth.users
  created_at: string;                // timestamptz
  updated_at: string;                // timestamptz
};

export const CONTEXT_CONVERSATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "context_type",
  "pmo_id",
  "project_id",
  "title",
  "status",
  "created_by_user_id",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ContextConversationRow>;

export type ContextMessageRole = "user" | "assistant" | "system";

export type ContextMessageRow = {
  id: string;                        // uuid
  conversation_id: string;           // uuid references context_conversations
  workspace_id: string;              // uuid references workspaces
  role: ContextMessageRole;          // text not null
  content: string;                   // text not null
  metadata: Record<string, unknown> | null; // jsonb
  created_by_user_id: string | null; // uuid references auth.users
  created_at: string;                // timestamptz
};

export const CONTEXT_MESSAGE_SELECTABLE_COLUMNS = [
  "id",
  "conversation_id",
  "workspace_id",
  "role",
  "content",
  "metadata",
  "created_by_user_id",
  "created_at",
] as const satisfies ReadonlyArray<keyof ContextMessageRow>;

// ─────────────────────────────────────────────────────────────────────────────
// workspace_governance
// Source: 20260527091000_workspace_governance.sql
//
// workspace_id is stored as text (matches uuid values from workspaces.id).
// RLS policy casts workspace_id::uuid for membership join.
//
// schema_version semantics (intentional two-phase design):
//   1 = PMOGovernanceSkeleton (governance wizard output)
//   2 = PmoTenant (full PMO tenant activation; loadPmoTenant requires this)
// ─────────────────────────────────────────────────────────────────────────────

export type WorkspaceGovernanceStatus = "active" | "archived";

export type WorkspaceGovernanceRow = {
  workspace_id: string;              // text (contains uuid value; PK)
  schema_version: number;            // integer: 1 = skeleton, 2 = tenant
  governance_jsonb: Record<string, unknown>; // jsonb
  status: WorkspaceGovernanceStatus; // text not null default 'active'
  created_at: string;                // timestamptz
  updated_at: string;                // timestamptz
};

export const GOVERNANCE_SCHEMA_VERSION_SKELETON = 1 as const;
export const GOVERNANCE_SCHEMA_VERSION_TENANT   = 2 as const;

export const WORKSPACE_GOVERNANCE_SELECTABLE_COLUMNS = [
  "workspace_id",
  "schema_version",
  "governance_jsonb",
  "status",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof WorkspaceGovernanceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// workspace_runtime_state
// Source: 20260527090000_workspace_runtime_state.sql
//
// company_id / workspace_id / user_id are ALL text by design: they carry
// values from external authority contexts that are not always Supabase UUIDs.
// RLS enforces auth.uid()::text = user_id.
// ─────────────────────────────────────────────────────────────────────────────

export type WorkspaceRuntimeStateRow = {
  company_id: string;             // text (PK part 1)
  workspace_id: string;           // text (PK part 2) — NOT a FK to workspaces
  user_id: string;                // text (PK part 3) — RLS: auth.uid()::text
  awakening_state: Record<string, unknown>;
  imprint_state: Record<string, unknown>;
  validation_state: Record<string, unknown>;
  flags: Record<string, unknown>;
  updated_at: string;             // timestamptz
};

export const WORKSPACE_RUNTIME_STATE_SELECTABLE_COLUMNS = [
  "company_id",
  "workspace_id",
  "user_id",
  "awakening_state",
  "imprint_state",
  "validation_state",
  "flags",
  "updated_at",
] as const satisfies ReadonlyArray<keyof WorkspaceRuntimeStateRow>;


// ─────────────────────────────────────────────────────────────────────────────
// operational_governance_briefs
// Source: 20260602000000_operational_governance_briefs.sql
// Stores the deterministic First Insight Engine brief generated immediately
// after project creation.
// ─────────────────────────────────────────────────────────────────────────────

export type OperationalGovernanceBriefRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  brief_payload: Record<string, unknown>;
  confidence_score: number;
  generated_at: string;
  created_by: string | null;
};

export const OPERATIONAL_GOVERNANCE_BRIEF_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "brief_payload",
  "confidence_score",
  "generated_at",
  "created_by",
] as const satisfies ReadonlyArray<keyof OperationalGovernanceBriefRow>;



// ─────────────────────────────────────────────────────────────────────────────
// project_discovery
// Source: 20260605020000_project_discovery.sql
// Versioned operational discovery generated from canonical project evidence.
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectDiscoveryRow = {
  id: string;
  project_id: string;
  workspace_id: string;
  version: number;
  stakeholders_json: Record<string, unknown>[];
  dependencies_json: Record<string, unknown>[];
  risks_json: Record<string, unknown>[];
  milestones_json: Record<string, unknown>[];
  deliverables_json: Record<string, unknown>[];
  assumptions_json: Record<string, unknown>[];
  unknowns_json: Record<string, unknown>[];
  confidence_score: number;
  discovery_payload_hash: string | null;
  evidence_count: number;
  generated_at: string;
  created_at: string;
  updated_at: string;
};

export const PROJECT_DISCOVERY_SELECTABLE_COLUMNS = [
  "id",
  "project_id",
  "workspace_id",
  "version",
  "stakeholders_json",
  "dependencies_json",
  "risks_json",
  "milestones_json",
  "deliverables_json",
  "assumptions_json",
  "unknowns_json",
  "confidence_score",
  "discovery_payload_hash",
  "evidence_count",
  "generated_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ProjectDiscoveryRow>;

// ─────────────────────────────────────────────────────────────────────────────
// raid_items
// Source: 20260602020000_raid_auto_extraction.sql
// Canonical PMO RAID entities generated from deterministic vault intake.
// ─────────────────────────────────────────────────────────────────────────────

export type RaidItemCategory = "risk" | "assumption" | "issue" | "dependency";
export type RaidItemStatus = "open" | "monitoring" | "mitigated" | "closed";

export type RaidItemRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  source_document_id: string;
  source_signal_id: string | null;
  category: RaidItemCategory;
  title: string;
  description: string;
  status: RaidItemStatus;
  confidence_score: number;
  detected_at: string;
  last_detected_at: string;
  detected_by: string | null;
  owner: string | null;
  due_date: string | null;
  auto_generated: boolean;
  fingerprint: string;
  occurrence_count: number;
};

export const RAID_ITEM_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "source_document_id",
  "source_signal_id",
  "category",
  "title",
  "description",
  "status",
  "confidence_score",
  "detected_at",
  "last_detected_at",
  "detected_by",
  "owner",
  "due_date",
  "auto_generated",
  "fingerprint",
  "occurrence_count",
] as const satisfies ReadonlyArray<keyof RaidItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// trial_licenses
// Source: 20260512198000_early_access_trials.sql
// ─────────────────────────────────────────────────────────────────────────────

export type TrialStatus = "pending" | "active" | "expired" | "revoked";

export type TrialLicenseRow = {
  id: string;                    // uuid
  invite_id: string;             // uuid unique references early_access_invites
  workspace_id: string | null;   // uuid references workspaces (nullable)
  trial_start_at: string | null; // timestamptz
  trial_end_at: string | null;   // timestamptz
  trial_status: TrialStatus;     // enum
  revoked_at: string | null;     // timestamptz
  created_at: string;            // timestamptz
  updated_at: string;            // timestamptz
};

export const TRIAL_LICENSE_SELECTABLE_COLUMNS = [
  "id",
  "invite_id",
  "workspace_id",
  "trial_start_at",
  "trial_end_at",
  "trial_status",
  "revoked_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof TrialLicenseRow>;

// ─────────────────────────────────────────────────────────────────────────────
// early_access_invites
// Source: 20260512198000_early_access_trials.sql
// ─────────────────────────────────────────────────────────────────────────────

export type EarlyAccessInviteRow = {
  id: string;                       // uuid
  invite_email: string;             // text not null
  invite_token_hash: string;        // text not null unique
  invite_note: string | null;       // text
  inviter_user_id: string;          // uuid references auth.users
  expires_at: string;               // timestamptz
  accepted_at: string | null;       // timestamptz
  revoked_at: string | null;        // timestamptz
  requires_approval: boolean;       // boolean default false
  approved_at: string | null;       // timestamptz
  approved_by_user_id: string | null; // uuid references auth.users
  workspace_id: string | null;      // uuid references workspaces
  created_at: string;               // timestamptz
  updated_at: string;               // timestamptz
};

export const EARLY_ACCESS_INVITE_SELECTABLE_COLUMNS = [
  "id",
  "invite_email",
  "invite_token_hash",
  "invite_note",
  "inviter_user_id",
  "expires_at",
  "accepted_at",
  "revoked_at",
  "requires_approval",
  "approved_at",
  "approved_by_user_id",
  "workspace_id",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof EarlyAccessInviteRow>;

// ─────────────────────────────────────────────────────────────────────────────
// workspace_activations
// Source: 20260512198000_early_access_trials.sql
// ─────────────────────────────────────────────────────────────────────────────

export type WorkspaceActivationRow = {
  id: string;                              // uuid
  invite_id: string;                       // uuid unique references early_access_invites
  trial_license_id: string;               // uuid unique references trial_licenses
  workspace_id: string;                   // uuid references workspaces
  activated_by_user_id: string;           // uuid references auth.users
  runtime_authority_linkage: Record<string, unknown>; // jsonb
  governance_profile: Record<string, unknown>;        // jsonb
  explainability_defaults: Record<string, unknown>;   // jsonb
  machine_governance_defaults: Record<string, unknown>; // jsonb
  starter_cognition_state: Record<string, unknown>;   // jsonb
  operational_memory_namespace: string;   // text not null
  activated_at: string;                   // timestamptz
  initialization_status: string;          // text default 'succeeded'
  initialization_error: string | null;    // text
  created_at: string;                     // timestamptz
};

// ─────────────────────────────────────────────────────────────────────────────
// onboarding_analyses
// Source: 20260430170000_onboarding_analyses.sql
//         20260512183000_enterprise_auth_integrity.sql (workspace_id)
//         20260504100000_projects_system.sql (project_id)
// ─────────────────────────────────────────────────────────────────────────────

export type OnboardingAnalysisRow = {
  id: string;                   // uuid
  company_id: string;           // text
  user_id: string;              // uuid references auth.users
  workspace_id: string;         // uuid references workspaces
  project_id: string | null;    // uuid references projects (nullable)
  workspace: string;            // text (legacy field, freeform)
  role: string;                 // text
  project_type: string;         // text
  problem: string;              // text
  analysis: string;             // text
  source: string;               // text default 'onboarding'
  created_at: string;           // timestamptz
};

// ─────────────────────────────────────────────────────────────────────────────
// pmo_team_invites
// Source: 20260528000000_pmo_team_invites.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PmoTeamInviteStatus = "pending" | "accepted" | "revoked";

export type PmoTeamInviteRow = {
  id: string;                  // uuid
  workspace_id: string;        // uuid references workspaces
  invited_by_user_id: string;  // uuid
  email: string;               // text
  role: string;                // text
  domain_focus: string[];      // text[]
  status: PmoTeamInviteStatus; // text default 'pending'
  created_at: string;          // timestamptz
  updated_at: string;          // timestamptz
};

// ─────────────────────────────────────────────────────────────────────────────
// recommended_actions
// Source: 20260605040000_recommended_actions.sql
//         20260605050000_recommended_actions_decision_workflow.sql
//         20260611000000_operational_evidence_decision_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type RecommendedActionStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "deferred"
  | "converted_to_task"
  | "modified"
  | "executed";

export type RecommendedActionRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  raid_item_id: string | null;
  governance_event_id: string | null;
  risk_issue_id: string | null;
  title: string;
  description: string;
  recommendation: string | null;
  recommended_action_type: string;
  status: RecommendedActionStatus;
  confidence_score: number | null;
  impact_level: string | null;
  rationale: Record<string, unknown> | null;
  recommended_owner: string | null;
  recommended_due_window: string | null;
  urgency: "low" | "medium" | "high" | "immediate" | null;
  suggested_owner_user_id: string | null;
  evidence_summary: Record<string, unknown> | null;
  source_signal_id: string | null;
  fingerprint: string;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  deferred_until: string | null;
  converted_task_id: string | null;
  decision_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const RECOMMENDED_ACTION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "raid_item_id",
  "governance_event_id",
  "risk_issue_id",
  "title",
  "description",
  "recommendation",
  "recommended_action_type",
  "status",
  "confidence_score",
  "impact_level",
  "rationale",
  "recommended_owner",
  "recommended_due_window",
  "urgency",
  "suggested_owner_user_id",
  "evidence_summary",
  "source_signal_id",
  "fingerprint",
  "decision_reason",
  "decided_by",
  "decided_at",
  "deferred_until",
  "converted_task_id",
  "decision_metadata",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof RecommendedActionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// task_drafts
// Source: 20260605060000_task_drafts.sql
// Traceable Task Draft created when a PM converts a Recommended Action.
// The system drafts. The PM confirms. No automatic task execution.
// ─────────────────────────────────────────────────────────────────────────────

export type TaskDraftStatus =
  | "draft"
  | "reviewed"
  | "approved"
  | "discarded"
  | "converted_to_task";

export type TaskDraftPriority = "low" | "medium" | "high" | "critical";

export type TaskDraftRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  recommended_action_id: string;
  raid_item_id: string | null;
  title: string;
  description: string;
  draft_status: TaskDraftStatus;
  suggested_owner: string | null;
  suggested_due_date: string | null;
  suggested_due_window: string | null;
  priority: TaskDraftPriority;
  source_type: string;
  source_payload: Record<string, unknown>;
  acceptance_criteria: string[];
  checklist: string[];
  confidence_score: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const TASK_DRAFT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "recommended_action_id",
  "raid_item_id",
  "title",
  "description",
  "draft_status",
  "suggested_owner",
  "suggested_due_date",
  "suggested_due_window",
  "priority",
  "source_type",
  "source_payload",
  "acceptance_criteria",
  "checklist",
  "confidence_score",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof TaskDraftRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_tasks
// Source: 20260605070000_execution_tasks.sql
//         20260830000000_execution_tasks_optional_draft.sql (task_draft_id nullable)
// Canonical operational work unit. Either drafted (Task Draft → Execution
// Task, machine drafts / human approves / system executes governance) or
// created directly by a workspace member ("Quick Add Task" — task_draft_id
// is null, source_payload.source === "manual").
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionTaskStatus =
  | "not_started"
  | "in_progress"
  | "blocked"
  | "completed"
  | "cancelled";

export type ExecutionTaskPriority = "low" | "medium" | "high" | "critical";

export type TaskScheduleStatus =
  | "unscheduled"
  | "scheduled"
  | "at_risk"
  | "delayed"
  | "completed"
  | "cancelled";

export type ExecutionTaskRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  task_draft_id: string | null;
  recommended_action_id: string | null;
  raid_item_id: string | null;
  title: string;
  description: string;
  status: ExecutionTaskStatus;
  priority: ExecutionTaskPriority;
  owner_user_id: string | null;
  owner_name: string | null;
  start_date: string | null;
  due_date: string | null;
  completed_at: string | null;
  progress_percent: number;
  acceptance_criteria: string[];
  checklist: string[];
  confidence_score: number | null;
  source_payload: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Schedule fields (added H8)
  planned_start_date: string | null;
  planned_finish_date: string | null;
  baseline_start_date: string | null;
  baseline_finish_date: string | null;
  forecast_start_date: string | null;
  forecast_finish_date: string | null;
  milestone_id: string | null;
  schedule_status: TaskScheduleStatus;
  schedule_confidence: number | null;
  // Critical path fields (added H9)
  is_critical: boolean;
  early_start: number | null;
  early_finish: number | null;
  late_start: number | null;
  late_finish: number | null;
  total_float: number | null;
  free_float: number | null;
  variance_days: number | null;
  criticality_score: number | null;
};

export const EXECUTION_TASK_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "task_draft_id",
  "recommended_action_id",
  "raid_item_id",
  "title",
  "description",
  "status",
  "priority",
  "owner_user_id",
  "owner_name",
  "start_date",
  "due_date",
  "completed_at",
  "progress_percent",
  "acceptance_criteria",
  "checklist",
  "confidence_score",
  "source_payload",
  "created_by",
  "created_at",
  "updated_at",
  "planned_start_date",
  "planned_finish_date",
  "baseline_start_date",
  "baseline_finish_date",
  "forecast_start_date",
  "forecast_finish_date",
  "milestone_id",
  "schedule_status",
  "schedule_confidence",
  "is_critical",
  "early_start",
  "early_finish",
  "late_start",
  "late_finish",
  "total_float",
  "free_float",
  "variance_days",
  "criticality_score",
] as const satisfies ReadonlyArray<keyof ExecutionTaskRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_task_events
// Source: 20260605070000_execution_tasks.sql
// Immutable audit trail for every lifecycle action on an execution task.
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionTaskEventRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  task_id: string;
  event_type: string;
  event_payload: Record<string, unknown>;
  actor_user_id: string | null;
  created_at: string;
};

export const EXECUTION_TASK_EVENT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "task_id",
  "event_type",
  "event_payload",
  "actor_user_id",
  "created_at",
] as const satisfies ReadonlyArray<keyof ExecutionTaskEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// internal_task_executions
// Source: 20260905000000_p2_08_internal_dispatch_execution.sql
// Bounded execution state for one governed canonical Task. Not a Task model and
// not an Outcome/Observation.
// ─────────────────────────────────────────────────────────────────────────────

export type InternalTaskExecutionStatus =
  | "queued"
  | "running"
  | "blocked"
  | "failed"
  | "completed";

export type InternalTaskExecutionRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  task_id: string;
  source_action_id: string;
  governance_evaluation_id: string;
  provider_key: "pmfreak/internal-state-machine:v1";
  status: InternalTaskExecutionStatus;
  attempt_count: number;
  idempotency_key: string;
  correlation_id: string;
  causation_id: string | null;
  failure_class: string | null;
  failure_message: string | null;
  queued_at: string;
  started_at: string | null;
  blocked_at: string | null;
  failed_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  dispatched_by: string;
  created_at: string;
  updated_at: string;
};

export const INTERNAL_TASK_EXECUTION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "task_id",
  "source_action_id",
  "governance_evaluation_id",
  "provider_key",
  "status",
  "attempt_count",
  "idempotency_key",
  "correlation_id",
  "causation_id",
  "failure_class",
  "failure_message",
  "queued_at",
  "started_at",
  "blocked_at",
  "failed_at",
  "completed_at",
  "last_transition_at",
  "dispatched_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof InternalTaskExecutionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// canonical_task_outcomes
// Source: 20260906000000_p2_09_outcome_observation_contract.sql
// Canonical expected Outcome for an execution Task. Task completion never implies Outcome achievement.
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalTaskOutcomeState =
  | "expected"
  | "observing"
  | "achieved"
  | "partially_achieved"
  | "not_achieved"
  | "disputed"
  | "inconclusive"
  | "superseded";

export type CanonicalTaskOutcomeRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  task_id: string;
  source_action_id: string | null;
  internal_execution_id: string | null;
  state: CanonicalTaskOutcomeState;
  expected_result: string;
  success_criteria: unknown[];
  correlation_id: string;
  causation_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  fixture_label: string | null;
};

export const CANONICAL_TASK_OUTCOME_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "task_id",
  "source_action_id",
  "internal_execution_id",
  "state",
  "expected_result",
  "success_criteria",
  "correlation_id",
  "causation_id",
  "created_by",
  "created_at",
  "updated_at",
  "fixture_label",
] as const satisfies ReadonlyArray<keyof CanonicalTaskOutcomeRow>;

// ─────────────────────────────────────────────────────────────────────────────
// canonical_outcome_observations
// Source: 20260906000000_p2_09_outcome_observation_contract.sql
// Evidence-backed observation of a canonical expected Task Outcome.
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalOutcomeObservationState =
  | "achieved"
  | "partial"
  | "failed"
  | "disputed"
  | "inconclusive";

export type CanonicalOutcomeObservationMissingDataState =
  | "COMPLETE"
  | "PARTIAL"
  | "UNKNOWN";

export type CanonicalOutcomeObservationRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  outcome_id: string;
  task_id: string;
  observation_state: CanonicalOutcomeObservationState;
  summary: string;
  evidence_reference_ids: string[];
  confidence_score: number;
  missing_data_state: CanonicalOutcomeObservationMissingDataState;
  observed_by: string;
  observed_at: string;
  evaluated_at: string;
  stale_at: string | null;
  recorded_at: string;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string;
  fixture_label: string | null;
};

export const CANONICAL_OUTCOME_OBSERVATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "outcome_id",
  "task_id",
  "observation_state",
  "summary",
  "evidence_reference_ids",
  "confidence_score",
  "missing_data_state",
  "observed_by",
  "observed_at",
  "evaluated_at",
  "stale_at",
  "recorded_at",
  "correlation_id",
  "causation_id",
  "idempotency_key",
  "fixture_label",
] as const satisfies ReadonlyArray<keyof CanonicalOutcomeObservationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// canonical_learning_candidates
// Source: 20260914000000_p2_18_learning_candidate_lineage.sql
// Non-authoritative, project-local Learning Candidate (pattern hypothesis). Status is only
// ever "proposed"; review/ratification is P2-19. Bounded summary fields only.
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalLearningCandidateEvidenceTier =
  | "single_lineage"
  | "multiple_consistent_lineages"
  | "conflicting_lineages";

export type CanonicalLearningCandidateObservedResult = "achieved" | "partial" | "failed";

export type CanonicalLearningCandidateRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  candidate_kind: "canonical_outcome_pattern";
  pattern_key: string;
  pattern_signature: { signalType: string; recommendedActionType: string; actionClass: string };
  status: "proposed";
  evidence_tier: CanonicalLearningCandidateEvidenceTier;
  lineage_count: number;
  independent_lineage_count: number;
  result_counts: Partial<Record<CanonicalLearningCandidateObservedResult, number>>;
  confidence_score: number | string;
  confidence_method: "weakest_linked_observation:v1";
  causality_claim: string;
  limitations: string[];
  version: number;
  evidence_digest: string;
  evaluator: string;
  fixture_label: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_evaluated_at: string;
  last_evaluated_by: string;
};

export const CANONICAL_LEARNING_CANDIDATE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "candidate_kind",
  "pattern_key",
  "pattern_signature",
  "status",
  "evidence_tier",
  "lineage_count",
  "independent_lineage_count",
  "result_counts",
  "confidence_score",
  "confidence_method",
  "causality_claim",
  "limitations",
  "version",
  "evidence_digest",
  "evaluator",
  "fixture_label",
  "created_by",
  "created_at",
  "updated_at",
  "last_evaluated_at",
  "last_evaluated_by",
] as const satisfies ReadonlyArray<keyof CanonicalLearningCandidateRow>;

// ─────────────────────────────────────────────────────────────────────────────
// canonical_learning_candidate_sources
// Source: 20260914000000_p2_18_learning_candidate_lineage.sql
// Evidence membership of a Learning Candidate: one row per qualifying canonical Observation,
// with relational lineage references. Append-only except the one-time supersession mark.
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalLearningCandidateSourceRow = {
  id: string;
  candidate_id: string;
  workspace_id: string;
  project_id: string;
  outcome_id: string;
  observation_id: string;
  task_id: string;
  internal_execution_id: string;
  action_id: string;
  governance_evaluation_id: string;
  decision_id: string;
  recommendation_id: string;
  finding_id: string;
  finding_evidence_item_id: string;
  observation_evidence_ids: string[];
  observed_result: CanonicalLearningCandidateObservedResult;
  observation_confidence: number | string;
  valid_until: string | null;
  correlation_id: string;
  causation_id: string | null;
  evaluated_at: string;
  linked_by: string;
  recorded_at: string;
  superseded_at: string | null;
  superseded_by_source_id: string | null;
};

export const CANONICAL_LEARNING_CANDIDATE_SOURCE_SELECTABLE_COLUMNS = [
  "id",
  "candidate_id",
  "workspace_id",
  "project_id",
  "outcome_id",
  "observation_id",
  "task_id",
  "internal_execution_id",
  "action_id",
  "governance_evaluation_id",
  "decision_id",
  "recommendation_id",
  "finding_id",
  "finding_evidence_item_id",
  "observation_evidence_ids",
  "observed_result",
  "observation_confidence",
  "valid_until",
  "correlation_id",
  "causation_id",
  "evaluated_at",
  "linked_by",
  "recorded_at",
  "superseded_at",
  "superseded_by_source_id",
] as const satisfies ReadonlyArray<keyof CanonicalLearningCandidateSourceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// canonical_learning_candidate_reviews
// Source: 20260915000000_p2_19_governed_project_knowledge.sql
// One TERMINAL review (ratified | rejected) per exact Learning Candidate state
// (candidate_id, candidate_version, candidate_evidence_digest). Never updated or deleted.
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalLearningCandidateReviewRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  candidate_id: string;
  candidate_version: number;
  candidate_evidence_digest: string;
  review_outcome: "ratified" | "rejected";
  reviewed_by: string;
  reviewer_role: "owner" | "admin";
  reviewed_at: string;
  candidate_created_by: string;
  candidate_last_evaluated_by: string;
  reviewer_is_candidate_creator: boolean;
  reviewed_summary: Record<string, unknown>;
  causality_claim: string;
  limitations: string[];
  rationale: string;
  governance_action: "knowledge.ratify" | "knowledge.reject";
  governance_decision_id: string;
  governance_decision_state: "allow";
  governance_contract: string;
  governance_evaluated_at: string;
  fixture_label: string | null;
  recorded_at: string;
};

export const CANONICAL_LEARNING_CANDIDATE_REVIEW_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "candidate_id",
  "candidate_version",
  "candidate_evidence_digest",
  "review_outcome",
  "reviewed_by",
  "reviewer_role",
  "reviewed_at",
  "candidate_created_by",
  "candidate_last_evaluated_by",
  "reviewer_is_candidate_creator",
  "reviewed_summary",
  "causality_claim",
  "limitations",
  "rationale",
  "governance_action",
  "governance_decision_id",
  "governance_decision_state",
  "governance_contract",
  "governance_evaluated_at",
  "fixture_label",
  "recorded_at",
] as const satisfies ReadonlyArray<keyof CanonicalLearningCandidateReviewRow>;

// ─────────────────────────────────────────────────────────────────────────────
// canonical_project_knowledge_records
// Source: 20260915000000_p2_19_governed_project_knowledge.sql
// Ratified, Project-scoped knowledge (applicability source_project). Content/provenance are
// immutable; the only change is a one-way revocation. Expiry is derived at read time.
// ─────────────────────────────────────────────────────────────────────────────

export type CanonicalProjectKnowledgeRecordRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  candidate_id: string;
  candidate_version: number;
  candidate_evidence_digest: string;
  review_id: string;
  review_outcome: "ratified";
  knowledge_kind: "canonical_outcome_pattern";
  pattern_key: string;
  pattern_signature: { signalType: string; recommendedActionType: string; actionClass: string };
  statement: string;
  evidence_tier: CanonicalLearningCandidateEvidenceTier;
  lineage_count: number;
  independent_lineage_count: number;
  result_counts: Partial<Record<CanonicalLearningCandidateObservedResult, number>>;
  confidence_score: number | string;
  confidence_method: "weakest_linked_observation:v1";
  causality_claim: string;
  limitations: string[];
  source_ids: string[];
  applicability_scope: "source_project";
  status: "active" | "revoked";
  validity_mode: "until_revoked" | "until_date";
  effective_from: string;
  effective_until: string | null;
  ratified_at: string;
  ratified_by: string;
  ratification_governance_decision_id: string;
  version: number;
  revoked_at: string | null;
  revoked_by: string | null;
  revocation_reason: string | null;
  revocation_governance_decision_id: string | null;
  revocation_governance_evaluated_at: string | null;
  fixture_label: string | null;
  created_at: string;
  updated_at: string;
};

export const CANONICAL_PROJECT_KNOWLEDGE_RECORD_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "candidate_id",
  "candidate_version",
  "candidate_evidence_digest",
  "review_id",
  "review_outcome",
  "knowledge_kind",
  "pattern_key",
  "pattern_signature",
  "statement",
  "evidence_tier",
  "lineage_count",
  "independent_lineage_count",
  "result_counts",
  "confidence_score",
  "confidence_method",
  "causality_claim",
  "limitations",
  "source_ids",
  "applicability_scope",
  "status",
  "validity_mode",
  "effective_from",
  "effective_until",
  "ratified_at",
  "ratified_by",
  "ratification_governance_decision_id",
  "version",
  "revoked_at",
  "revoked_by",
  "revocation_reason",
  "revocation_governance_decision_id",
  "revocation_governance_evaluated_at",
  "fixture_label",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof CanonicalProjectKnowledgeRecordRow>;
// project_milestones
// Source: 20260605090000_milestones_schedule_foundation.sql
// Project milestones with planned, baseline, and forecast dates.
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectMilestoneType =
  | "kickoff"
  | "discovery"
  | "design"
  | "approval"
  | "delivery"
  | "deployment"
  | "training"
  | "acceptance"
  | "go_live"
  | "handover"
  | "other";

export type ProjectMilestoneStatus =
  | "planned"
  | "at_risk"
  | "blocked"
  | "completed"
  | "cancelled";

export type ProjectMilestoneRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  description: string | null;
  milestone_type: ProjectMilestoneType;
  status: ProjectMilestoneStatus;
  target_date: string | null;
  baseline_date: string | null;
  forecast_date: string | null;
  completed_at: string | null;
  confidence_score: number | null;
  source_type: string;
  source_payload: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const PROJECT_MILESTONE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "title",
  "description",
  "milestone_type",
  "status",
  "target_date",
  "baseline_date",
  "forecast_date",
  "completed_at",
  "confidence_score",
  "source_type",
  "source_payload",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ProjectMilestoneRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_task_dependencies
// Source: 20260605080000_execution_task_dependencies.sql
// Models dependencies between execution tasks: sequencing, blockers, gates.
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionTaskDependencyType =
  | "finish_to_start"
  | "start_to_start"
  | "finish_to_finish"
  | "start_to_finish"
  | "blocks"
  | "gated_by"
  | "approval_required"
  | "external_dependency";

export type ExecutionTaskDependencyStatus =
  | "proposed"
  | "active"
  | "resolved"
  | "invalidated";

export type ExecutionTaskDependencyRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  predecessor_task_id: string;
  successor_task_id: string;
  dependency_type: ExecutionTaskDependencyType;
  status: ExecutionTaskDependencyStatus;
  lag_days: number;
  reason: string | null;
  source_type: string;
  source_payload: Record<string, unknown>;
  confidence_score: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const EXECUTION_TASK_DEPENDENCY_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "predecessor_task_id",
  "successor_task_id",
  "dependency_type",
  "status",
  "lag_days",
  "reason",
  "source_type",
  "source_payload",
  "confidence_score",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ExecutionTaskDependencyRow>;

// ─────────────────────────────────────────────────────────────────────────────
// platform_events — Governance Event Layer
// Migration: 20260616000000_platform_events_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PlatformEventRow = {
  id: string;                        // uuid PK
  workspace_id: string;              // uuid references workspaces
  project_id: string | null;         // uuid references projects (nullable)
  actor_id: string | null;           // uuid (nullable — system events have no actor)
  actor_type: string;                // 'user' | 'ai_agent' | 'system' | 'integration'
  event_type: string;                // e.g. 'RISK_CREATED', 'HUMAN_DECISION_RECORDED'
  event_category: string;            // e.g. 'risk', 'decision', 'recommendation'
  event_payload: Record<string, unknown>;  // structured facts — no raw content
  source: string;                    // 'user_action' | 'ai_agent' | 'system' | ...
  correlation_id: string | null;     // groups related events in a logical flow
  causation_id: string | null;       // platform_events.id that caused this event
  visibility: string;                // 'personal' | 'project' | 'workspace' | ...
  sensitivity_level: string;         // 'public' | 'internal' | 'confidential' | 'restricted'
  learning_eligible: boolean;        // may feed future learning pipelines when true
  raw_reference_table: string | null;  // source table name (no content copied)
  raw_reference_id: string | null;     // source record id (no content copied)
  metadata: Record<string, unknown>;   // request_id, trace_id, session_id, etc.
  occurred_at: string;               // timestamptz — when the event happened
  created_at: string;                // timestamptz — when the row was inserted
};

export const PLATFORM_EVENT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "actor_id",
  "actor_type",
  "event_type",
  "event_category",
  "event_payload",
  "source",
  "correlation_id",
  "causation_id",
  "visibility",
  "sensitivity_level",
  "learning_eligible",
  "raw_reference_table",
  "raw_reference_id",
  "metadata",
  "occurred_at",
  "created_at",
] as const satisfies ReadonlyArray<keyof PlatformEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// decision_effectiveness — Decision Effectiveness Foundation
// Migration: 20260617030000_decision_effectiveness_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type DecisionEffectivenessStatusRow = "candidate" | "validated" | "archived";
export type DecisionOutcomeClassificationRow = "success" | "partial_success" | "failure" | "unknown";

export type DecisionEffectivenessRow = {
  id: string;                                         // uuid PK
  workspace_id: string;                               // uuid references workspaces
  decision_id: string;                                // uuid references project_decisions
  project_id: string;                                 // uuid references projects
  effectiveness_status: DecisionEffectivenessStatusRow;
  outcome_classification: DecisionOutcomeClassificationRow;
  approval_duration_seconds: number | null;           // bigint null
  implementation_duration_seconds: number | null;     // bigint null
  time_to_outcome_seconds: number | null;             // bigint null
  evidence_count: number;                             // integer not null
  outcome_count: number;                              // integer not null
  pattern_count: number;                              // integer not null
  created_at: string;                                 // timestamptz
  updated_at: string;                                 // timestamptz
  created_by: string | null;                          // uuid null references auth.users
  metadata: Record<string, unknown>;                  // jsonb
};

export const DECISION_EFFECTIVENESS_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "decision_id",
  "project_id",
  "effectiveness_status",
  "outcome_classification",
  "approval_duration_seconds",
  "implementation_duration_seconds",
  "time_to_outcome_seconds",
  "evidence_count",
  "outcome_count",
  "pattern_count",
  "created_at",
  "updated_at",
  "created_by",
  "metadata",
] as const satisfies ReadonlyArray<keyof DecisionEffectivenessRow>;

export type DecisionEffectivenessObservationRow = {
  id: string;               // uuid PK
  effectiveness_id: string; // uuid references decision_effectiveness
  observation_type: string; // text not null
  summary: string;          // text not null
  source_type: string;      // text not null
  source_id: string;        // uuid not null
  recorded_at: string;      // timestamptz
};

export const DECISION_EFFECTIVENESS_OBSERVATION_SELECTABLE_COLUMNS = [
  "id",
  "effectiveness_id",
  "observation_type",
  "summary",
  "source_type",
  "source_id",
  "recorded_at",
] as const satisfies ReadonlyArray<keyof DecisionEffectivenessObservationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// organizational_pattern_candidates — Pattern Extraction Foundation
// Migration: 20260618000000_pattern_extraction_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PatternCandidateStatusRow = "candidate" | "promoted" | "rejected" | "archived";

export type OrganizationalPatternCandidateRow = {
  id: string;                                // uuid PK
  workspace_id: string;                      // uuid references workspaces
  pattern_category: string;                  // text not null (enum-like)
  candidate_title: string;                   // text not null
  candidate_summary: string;                 // text not null
  observation_count: number;                 // integer not null
  confidence: string;                        // text not null (enum-like)
  status: PatternCandidateStatusRow;         // text not null
  rule_id: string;                           // text not null
  promoted_pattern_id: string | null;        // uuid null references organizational_patterns
  created_at: string;                        // timestamptz
  updated_at: string;                        // timestamptz
  metadata: Record<string, unknown>;         // jsonb
};

export const ORGANIZATIONAL_PATTERN_CANDIDATE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pattern_category",
  "candidate_title",
  "candidate_summary",
  "observation_count",
  "confidence",
  "status",
  "rule_id",
  "promoted_pattern_id",
  "created_at",
  "updated_at",
  "metadata",
] as const satisfies ReadonlyArray<keyof OrganizationalPatternCandidateRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pattern_candidate_sources — Pattern Extraction Foundation
// Migration: 20260618000000_pattern_extraction_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PatternCandidateSourceRow = {
  id: string;              // uuid PK
  candidate_id: string;    // uuid references organizational_pattern_candidates
  source_type: string;     // text not null (enum-like)
  source_id: string;       // uuid not null
  source_label: string;    // text not null
  created_at: string;      // timestamptz
};

export const PATTERN_CANDIDATE_SOURCE_SELECTABLE_COLUMNS = [
  "id",
  "candidate_id",
  "source_type",
  "source_id",
  "source_label",
  "created_at",
] as const satisfies ReadonlyArray<keyof PatternCandidateSourceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pattern_extraction_runs — Pattern Extraction Foundation
// Migration: 20260618000000_pattern_extraction_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PatternExtractionRunRow = {
  id: string;                        // uuid PK
  workspace_id: string;              // uuid references workspaces
  started_at: string;                // timestamptz
  completed_at: string | null;       // timestamptz null
  candidate_count: number;           // integer not null
  rule_count: number;                // integer not null
  metadata: Record<string, unknown>; // jsonb
};

export const PATTERN_EXTRACTION_RUN_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "started_at",
  "completed_at",
  "candidate_count",
  "rule_count",
  "metadata",
] as const satisfies ReadonlyArray<keyof PatternExtractionRunRow>;

// ─────────────────────────────────────────────────────────────────────────────
// personal_pm_patterns — Personal PM Pattern Formation Foundation
// Migration: 20260619000000_personal_pm_patterns_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalPmPatternRow = {
  id: string;                        // uuid PK
  workspace_id: string;              // uuid references workspaces
  pm_user_id: string;                // uuid references auth.users
  pattern_category: string;          // text check (allowed categories)
  title: string;                     // text not null
  summary: string;                   // text not null
  confidence: string;                // text check ('low','medium','high','very_high')
  status: string;                    // text check ('active','archived','frozen','deprecated')
  created_at: string;                // timestamptz
  updated_at: string;                // timestamptz
  created_by: string | null;         // uuid references auth.users null
  metadata: Record<string, unknown>; // jsonb
};

export const PERSONAL_PM_PATTERN_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pm_user_id",
  "pattern_category",
  "title",
  "summary",
  "confidence",
  "status",
  "created_at",
  "updated_at",
  "created_by",
  "metadata",
] as const satisfies ReadonlyArray<keyof PersonalPmPatternRow>;

// ─────────────────────────────────────────────────────────────────────────────
// personal_pm_pattern_sources — Personal PM Pattern Formation Foundation
// Migration: 20260619000000_personal_pm_patterns_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalPmPatternSourceRow = {
  id: string;                // uuid PK
  pattern_id: string;        // uuid references personal_pm_patterns
  source_type: string;       // text check (allowed source types)
  source_id: string;         // uuid not null
  relationship_type: string; // text check (allowed relationship types)
  created_at: string;        // timestamptz
};

export const PERSONAL_PM_PATTERN_SOURCE_SELECTABLE_COLUMNS = [
  "id",
  "pattern_id",
  "source_type",
  "source_id",
  "relationship_type",
  "created_at",
] as const satisfies ReadonlyArray<keyof PersonalPmPatternSourceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// personal_pm_pattern_observations — Personal PM Pattern Formation Foundation
// Migration: 20260619000000_personal_pm_patterns_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalPmPatternObservationRow = {
  id: string;                        // uuid PK
  pattern_id: string;                // uuid references personal_pm_patterns
  observation_summary: string;       // text not null
  recorded_at: string;               // timestamptz
  recorded_by: string | null;        // uuid references auth.users null
  metadata: Record<string, unknown>; // jsonb
};

export const PERSONAL_PM_PATTERN_OBSERVATION_SELECTABLE_COLUMNS = [
  "id",
  "pattern_id",
  "observation_summary",
  "recorded_at",
  "recorded_by",
  "metadata",
] as const satisfies ReadonlyArray<keyof PersonalPmPatternObservationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// personal_pm_effectiveness — Personal PM Effectiveness Foundation
// Migration: 20260620000000_personal_pm_effectiveness_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalPmEffectivenessRow = {
  id: string;                                    // uuid PK
  workspace_id: string;                          // uuid references workspaces
  pm_user_id: string;                            // uuid references auth.users
  personal_pattern_id: string | null;            // uuid references personal_pm_patterns null
  personal_memory_id: string | null;             // uuid references personal_pm_memory null
  decision_id: string | null;                    // uuid references project_decisions null
  decision_effectiveness_id: string | null;      // uuid references decision_effectiveness null
  outcome_classification: string;                // text check ('success','partial_success','failure','unknown')
  effectiveness_status: string;                  // text check ('candidate','validated','archived','deprecated')
  summary: string;                               // text not null
  created_at: string;                            // timestamptz
  updated_at: string;                            // timestamptz
  created_by: string | null;                     // uuid references auth.users null
  metadata: Record<string, unknown>;             // jsonb
};

export const PERSONAL_PM_EFFECTIVENESS_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pm_user_id",
  "personal_pattern_id",
  "personal_memory_id",
  "decision_id",
  "decision_effectiveness_id",
  "outcome_classification",
  "effectiveness_status",
  "summary",
  "created_at",
  "updated_at",
  "created_by",
  "metadata",
] as const satisfies ReadonlyArray<keyof PersonalPmEffectivenessRow>;

// ─────────────────────────────────────────────────────────────────────────────
// personal_pm_effectiveness_sources — Personal PM Effectiveness Foundation
// Migration: 20260620000000_personal_pm_effectiveness_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalPmEffectivenessSourceRow = {
  id: string;                // uuid PK
  effectiveness_id: string;  // uuid references personal_pm_effectiveness
  source_type: string;       // text check (allowed source types)
  source_id: string;         // uuid not null
  relationship_type: string; // text check (allowed relationship types)
  created_at: string;        // timestamptz
};

export const PERSONAL_PM_EFFECTIVENESS_SOURCE_SELECTABLE_COLUMNS = [
  "id",
  "effectiveness_id",
  "source_type",
  "source_id",
  "relationship_type",
  "created_at",
] as const satisfies ReadonlyArray<keyof PersonalPmEffectivenessSourceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// personal_pm_effectiveness_observations — Personal PM Effectiveness Foundation
// Migration: 20260620000000_personal_pm_effectiveness_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalPmEffectivenessObservationRow = {
  id: string;                        // uuid PK
  effectiveness_id: string;          // uuid references personal_pm_effectiveness
  observation_summary: string;       // text not null
  recorded_at: string;               // timestamptz
  recorded_by: string | null;        // uuid references auth.users null
  metadata: Record<string, unknown>; // jsonb
};

export const PERSONAL_PM_EFFECTIVENESS_OBSERVATION_SELECTABLE_COLUMNS = [
  "id",
  "effectiveness_id",
  "observation_summary",
  "recorded_at",
  "recorded_by",
  "metadata",
] as const satisfies ReadonlyArray<keyof PersonalPmEffectivenessObservationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// personal_pm_pattern_candidates — Personal Pattern Extraction Foundation
// Migration: 20260621000000_personal_pattern_extraction_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalPatternCandidateStatusRow = "candidate" | "promoted" | "rejected" | "archived";

export type PersonalPmPatternCandidateRow = {
  id: string;                                // uuid PK
  workspace_id: string;                      // uuid references workspaces
  pm_user_id: string;                        // uuid references auth.users — RLS: pm_user_id = auth.uid()
  candidate_category: string;                // text not null (enum-like)
  candidate_title: string;                   // text not null
  candidate_summary: string;                 // text not null
  confidence: string;                        // text not null ('low','medium','high','very_high')
  status: PersonalPatternCandidateStatusRow; // text not null default 'candidate'
  observation_count: number;                 // integer not null
  created_at: string;                        // timestamptz
  updated_at: string;                        // timestamptz
  metadata: Record<string, unknown>;         // jsonb — includes ruleId, groupKey, runId
};

export const PERSONAL_PM_PATTERN_CANDIDATE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pm_user_id",
  "candidate_category",
  "candidate_title",
  "candidate_summary",
  "confidence",
  "status",
  "observation_count",
  "created_at",
  "updated_at",
  "metadata",
] as const satisfies ReadonlyArray<keyof PersonalPmPatternCandidateRow>;

// ─────────────────────────────────────────────────────────────────────────────
// personal_pm_pattern_candidate_sources — Personal Pattern Extraction Foundation
// Migration: 20260621000000_personal_pattern_extraction_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalPmPatternCandidateSourceRow = {
  id: string;                // uuid PK
  candidate_id: string;      // uuid references personal_pm_pattern_candidates
  source_type: string;       // text not null (enum-like)
  source_id: string;         // uuid not null
  relationship_type: string; // text not null (enum-like)
  created_at: string;        // timestamptz
};

export const PERSONAL_PM_PATTERN_CANDIDATE_SOURCE_SELECTABLE_COLUMNS = [
  "id",
  "candidate_id",
  "source_type",
  "source_id",
  "relationship_type",
  "created_at",
] as const satisfies ReadonlyArray<keyof PersonalPmPatternCandidateSourceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// personal_pm_pattern_extraction_runs — Personal Pattern Extraction Foundation
// Migration: 20260621000000_personal_pattern_extraction_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalPmPatternExtractionRunRow = {
  id: string;                        // uuid PK
  workspace_id: string;              // uuid references workspaces
  pm_user_id: string;                // uuid references auth.users — RLS: pm_user_id = auth.uid()
  started_at: string;                // timestamptz
  completed_at: string | null;       // timestamptz null
  candidate_count: number;           // integer not null
  rule_count: number;                // integer not null
  metadata: Record<string, unknown>; // jsonb
};

export const PERSONAL_PM_PATTERN_EXTRACTION_RUN_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pm_user_id",
  "started_at",
  "completed_at",
  "candidate_count",
  "rule_count",
  "metadata",
] as const satisfies ReadonlyArray<keyof PersonalPmPatternExtractionRunRow>;

// ─────────────────────────────────────────────────────────────────────────────
// intelligence_bridge_links — Intelligence Bridge Foundation
// Migration: 20260622000000_intelligence_bridge_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type IntelligenceBridgeLinkRow = {
  id: string;                        // uuid PK
  workspace_id: string;              // uuid references workspaces
  pm_user_id: string;                // uuid references auth.users — RLS: pm_user_id = auth.uid()
  relationship_type: string;         // text not null (enum-constrained)
  status: string;                    // text not null default 'active'
  personal_source_type: string;      // text not null (enum-constrained)
  personal_source_id: string;        // uuid not null
  organizational_source_type: string; // text not null (enum-constrained)
  organizational_source_id: string;  // uuid not null
  summary: string;                   // text not null (non-empty)
  created_at: string;                // timestamptz
  updated_at: string;                // timestamptz
  created_by: string | null;         // uuid references auth.users
  metadata: Record<string, unknown>; // jsonb
};

export const INTELLIGENCE_BRIDGE_LINK_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pm_user_id",
  "relationship_type",
  "status",
  "personal_source_type",
  "personal_source_id",
  "organizational_source_type",
  "organizational_source_id",
  "summary",
  "created_at",
  "updated_at",
  "created_by",
  "metadata",
] as const satisfies ReadonlyArray<keyof IntelligenceBridgeLinkRow>;

// ─────────────────────────────────────────────────────────────────────────────
// intelligence_bridge_sources — Intelligence Bridge Foundation
// Migration: 20260622000000_intelligence_bridge_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type IntelligenceBridgeSourceRow = {
  id: string;                // uuid PK
  bridge_id: string;         // uuid references intelligence_bridge_links
  source_type: string;       // text not null (enum-constrained)
  source_id: string;         // uuid not null
  relationship_type: string; // text not null (enum-constrained)
  created_at: string;        // timestamptz
};

export const INTELLIGENCE_BRIDGE_SOURCE_SELECTABLE_COLUMNS = [
  "id",
  "bridge_id",
  "source_type",
  "source_id",
  "relationship_type",
  "created_at",
] as const satisfies ReadonlyArray<keyof IntelligenceBridgeSourceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// intelligence_bridge_observations — Intelligence Bridge Foundation
// Migration: 20260622000000_intelligence_bridge_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type IntelligenceBridgeObservationRow = {
  id: string;                        // uuid PK
  bridge_id: string;                 // uuid references intelligence_bridge_links
  observation_summary: string;       // text not null (non-empty)
  recorded_at: string;               // timestamptz
  recorded_by: string | null;        // uuid references auth.users
  metadata: Record<string, unknown>; // jsonb
};

export const INTELLIGENCE_BRIDGE_OBSERVATION_SELECTABLE_COLUMNS = [
  "id",
  "bridge_id",
  "observation_summary",
  "recorded_at",
  "recorded_by",
  "metadata",
] as const satisfies ReadonlyArray<keyof IntelligenceBridgeObservationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// Contract version — bump when any row type changes.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// project_constitutions — Project Constitution Lifecycle
// Migration: 20260623000002_project_constitution_lifecycle.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionStatus =
  | "draft"
  | "proposed"
  | "approved"
  | "active"
  | "suspended"
  | "closed"
  | "archived";

export type ProjectConstitutionRow = {
  id: string;                    // uuid PK
  workspace_id: string;          // uuid references workspaces
  project_id: string;            // uuid references projects
  title: string;                 // text not null
  description: string | null;    // text
  current_status: ConstitutionStatus; // text not null default 'draft'
  status_changed_at: string;     // timestamptz
  status_changed_by: string;     // uuid references auth.users
  lifecycle_version: number;     // integer >= 1, increments on each transition
  created_by: string;            // uuid references auth.users
  created_at: string;            // timestamptz
  updated_at: string;            // timestamptz
  metadata: Record<string, unknown>; // jsonb
};

export const PROJECT_CONSTITUTION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "title",
  "description",
  "current_status",
  "status_changed_at",
  "status_changed_by",
  "lifecycle_version",
  "created_by",
  "created_at",
  "updated_at",
  "metadata",
] as const satisfies ReadonlyArray<keyof ProjectConstitutionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitution_lifecycle_history — Project Constitution Lifecycle
// Migration: 20260623000002_project_constitution_lifecycle.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionLifecycleHistoryRow = {
  id: string;                           // uuid PK
  workspace_id: string;                 // uuid references workspaces
  constitution_id: string;              // uuid references project_constitutions
  from_status: ConstitutionStatus;      // text not null
  to_status: ConstitutionStatus;        // text not null
  changed_by: string;                   // uuid references auth.users
  changed_at: string;                   // timestamptz
  reason: string | null;                // text
  lifecycle_version_after: number;      // integer >= 1
  metadata: Record<string, unknown>;    // jsonb
};

export const CONSTITUTION_LIFECYCLE_HISTORY_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "constitution_id",
  "from_status",
  "to_status",
  "changed_by",
  "changed_at",
  "reason",
  "lifecycle_version_after",
  "metadata",
] as const satisfies ReadonlyArray<keyof ConstitutionLifecycleHistoryRow>;

// ─────────────────────────────────────────────────────────────────────────────
// project_constitutions — constitution_version column (Amendment Governance)
// Migration: 20260624000000_project_constitution_amendment_governance.sql
// ─────────────────────────────────────────────────────────────────────────────
// constitution_version is declared as an augmentation of ProjectConstitutionRow.
// The column is added via ALTER TABLE in the amendment governance migration.
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectConstitutionWithVersionRow = ProjectConstitutionRow & {
  constitution_version: number; // integer >= 1, increments per applied amendment
};

// ─────────────────────────────────────────────────────────────────────────────
// constitution_amendments — Amendment Governance
// Migration: 20260624000000_project_constitution_amendment_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AmendmentStatus =
  | "draft"
  | "proposed"
  | "approved"
  | "rejected"
  | "withdrawn"
  | "applied";

export type ConstitutionAmendmentRow = {
  id: string;                         // uuid PK
  workspace_id: string;               // uuid references workspaces
  constitution_id: string;            // uuid references project_constitutions

  title: string;                      // text not null
  description: string | null;         // text
  justification: string | null;       // text

  status: AmendmentStatus;            // text not null default 'draft'

  created_by: string;                 // uuid references auth.users
  created_at: string;                 // timestamptz
  updated_at: string;                 // timestamptz

  approved_by: string | null;         // uuid references auth.users
  approved_at: string | null;         // timestamptz

  rejected_by: string | null;         // uuid references auth.users
  rejected_at: string | null;         // timestamptz
  rejection_reason: string | null;    // text

  withdrawn_by: string | null;        // uuid references auth.users
  withdrawn_at: string | null;        // timestamptz

  applied_by: string | null;          // uuid references auth.users
  applied_at: string | null;          // timestamptz

  deleted_at: string | null;          // timestamptz
};

export const CONSTITUTION_AMENDMENT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "constitution_id",
  "title",
  "description",
  "justification",
  "status",
  "created_by",
  "created_at",
  "updated_at",
  "approved_by",
  "approved_at",
  "rejected_by",
  "rejected_at",
  "rejection_reason",
  "withdrawn_by",
  "withdrawn_at",
  "applied_by",
  "applied_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ConstitutionAmendmentRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitution_amendment_changes — Amendment Change Records
// Migration: 20260624000000_project_constitution_amendment_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AmendmentChangeType = "add" | "update" | "remove";

export type ConstitutionAmendmentChangeRow = {
  id: string;                       // uuid PK
  workspace_id: string;             // uuid references workspaces
  amendment_id: string;             // uuid references constitution_amendments

  change_type: AmendmentChangeType; // 'add' | 'update' | 'remove'
  field_name: string;               // text not null

  old_value: string | null;         // text
  new_value: string | null;         // text

  created_at: string;               // timestamptz
};

export const CONSTITUTION_AMENDMENT_CHANGE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "amendment_id",
  "change_type",
  "field_name",
  "old_value",
  "new_value",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionAmendmentChangeRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitution_snapshots — Constitutional Snapshots
// Migration: 20260624000000_project_constitution_amendment_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionSnapshotRow = {
  id: string;                         // uuid PK
  workspace_id: string;               // uuid references workspaces
  constitution_id: string;            // uuid references project_constitutions

  version: number;                    // integer >= 1 (matches constitution_version)

  snapshot_data: Record<string, unknown>; // jsonb — full constitution state

  created_by: string;                 // uuid references auth.users
  created_at: string;                 // timestamptz
};

export const CONSTITUTION_SNAPSHOT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "constitution_id",
  "version",
  "snapshot_data",
  "created_by",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionSnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_decisions — Constitutional Decision Governance
// Migration: 20260625000000_project_constitutional_decision_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionalDecisionStatus =
  | "draft"
  | "proposed"
  | "approved"
  | "rejected"
  | "executed"
  | "cancelled";

export type ConstitutionalDecisionType =
  | "scope"
  | "schedule"
  | "cost"
  | "quality"
  | "risk"
  | "resource"
  | "architecture"
  | "governance"
  | "constitutional"
  | "technical"
  | "vendor"
  | "operational";

export type ConstitutionalDecisionAuthority =
  | "sponsor"
  | "project_manager"
  | "steering_committee"
  | "governance_board"
  | "product_owner"
  | "client"
  | "architect"
  | "technical_lead";

export type ConstitutionalDecisionRow = {
  id: string;                                     // uuid PK
  workspace_id: string;                           // uuid references workspaces
  constitution_id: string;                        // uuid references project_constitutions

  title: string;                                  // text not null
  description: string | null;                     // text

  decision_type: ConstitutionalDecisionType;      // text not null (enum-constrained)

  context: string | null;                         // text
  problem_statement: string | null;               // text

  recommended_option: string | null;              // text
  selected_option: string | null;                 // text

  decision_authority: ConstitutionalDecisionAuthority; // text not null (enum-constrained)

  status: ConstitutionalDecisionStatus;           // text not null default 'draft'

  created_by: string;                             // uuid references auth.users
  created_at: string;                             // timestamptz
  updated_at: string;                             // timestamptz

  approved_by: string | null;                     // uuid references auth.users
  approved_at: string | null;                     // timestamptz

  executed_by: string | null;                     // uuid references auth.users
  executed_at: string | null;                     // timestamptz

  cancelled_by: string | null;                    // uuid references auth.users
  cancelled_at: string | null;                    // timestamptz

  deleted_at: string | null;                      // timestamptz
};

export const CONSTITUTIONAL_DECISION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "constitution_id",
  "title",
  "description",
  "decision_type",
  "context",
  "problem_statement",
  "recommended_option",
  "selected_option",
  "decision_authority",
  "status",
  "created_by",
  "created_at",
  "updated_at",
  "approved_by",
  "approved_at",
  "executed_by",
  "executed_at",
  "cancelled_by",
  "cancelled_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_decision_options — Decision Options
// Migration: 20260625000000_project_constitutional_decision_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionalDecisionOptionRow = {
  id: string;                   // uuid PK
  workspace_id: string;         // uuid references workspaces
  decision_id: string;          // uuid references constitutional_decisions

  name: string;                 // text not null
  description: string | null;   // text

  advantages: string | null;    // text
  disadvantages: string | null; // text

  estimated_cost: string | null;   // text
  estimated_effort: string | null; // text

  selected: boolean;            // boolean not null default false

  created_at: string;           // timestamptz
};

export const CONSTITUTIONAL_DECISION_OPTION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "decision_id",
  "name",
  "description",
  "advantages",
  "disadvantages",
  "estimated_cost",
  "estimated_effort",
  "selected",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalDecisionOptionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_decision_evidence — Evidence Registry
// Migration: 20260625000000_project_constitutional_decision_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionalDecisionEvidenceType =
  | "document"
  | "email"
  | "meeting"
  | "risk"
  | "issue"
  | "change_request"
  | "file"
  | "link"
  | "chat"
  | "approval";

export type ConstitutionalDecisionEvidenceRow = {
  id: string;                                          // uuid PK
  workspace_id: string;                                // uuid references workspaces
  decision_id: string;                                 // uuid references constitutional_decisions

  evidence_type: ConstitutionalDecisionEvidenceType;   // text not null (enum-constrained)

  reference_id: string | null;                         // text — external ref

  description: string;                                 // text not null

  created_by: string;                                  // uuid references auth.users
  created_at: string;                                  // timestamptz
};

export const CONSTITUTIONAL_DECISION_EVIDENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "decision_id",
  "evidence_type",
  "reference_id",
  "description",
  "created_by",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalDecisionEvidenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_decision_links — Constitutional Linkage
// Migration: 20260625000000_project_constitutional_decision_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionalDecisionLinkType =
  | "objective"
  | "constraint"
  | "amendment"
  | "risk"
  | "issue"
  | "milestone"
  | "deliverable"
  | "constitution_version";

export type ConstitutionalDecisionLinkRow = {
  id: string;                                       // uuid PK
  workspace_id: string;                             // uuid references workspaces
  decision_id: string;                              // uuid references constitutional_decisions

  link_type: ConstitutionalDecisionLinkType;        // text not null (enum-constrained)

  linked_entity_id: string;                         // uuid not null

  created_at: string;                               // timestamptz
};

export const CONSTITUTIONAL_DECISION_LINK_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "decision_id",
  "link_type",
  "linked_entity_id",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalDecisionLinkRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_signatures
// Source: 20260626000000_constitutional_ratification_framework.sql
// ─────────────────────────────────────────────────────────────────────────────

export type SignatureStatus = "pending" | "signed" | "rejected" | "expired" | "withdrawn";
export type SignatureAuthorityType =
  | "sponsor"
  | "project_manager"
  | "client"
  | "steering_committee"
  | "governance_board"
  | "product_owner"
  | "architect"
  | "technical_lead"
  | "external_approver";
export type RatifiableEntityType = "constitution" | "amendment" | "decision";

export type ConstitutionalSignatureRow = {
  id: string;              // uuid
  workspace_id: string;    // uuid
  entity_type: RatifiableEntityType;
  entity_id: string;       // uuid
  entity_version: number;  // integer
  authority_type: SignatureAuthorityType;
  authority_id: string;    // uuid references auth.users
  status: SignatureStatus;
  signature_hash: string | null;
  comments: string | null;
  requested_at: string;    // timestamptz
  signed_at: string | null;
  rejected_at: string | null;
  expired_at: string | null;
  withdrawn_at: string | null;
  created_by: string;      // uuid
  created_at: string;
  updated_at: string;
};

export const CONSTITUTIONAL_SIGNATURE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "entity_type",
  "entity_id",
  "entity_version",
  "authority_type",
  "authority_id",
  "status",
  "signature_hash",
  "comments",
  "requested_at",
  "signed_at",
  "rejected_at",
  "expired_at",
  "withdrawn_at",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalSignatureRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_signature_requests
// Source: 20260626000000_constitutional_ratification_framework.sql
// ─────────────────────────────────────────────────────────────────────────────

export type SignatureRequestStatus = "pending" | "fulfilled" | "declined" | "expired";

export type ConstitutionalSignatureRequestRow = {
  id: string;
  workspace_id: string;
  entity_type: RatifiableEntityType;
  entity_id: string;
  requested_authority: SignatureAuthorityType;
  requested_by: string;
  status: SignatureRequestStatus;
  deadline: string | null;
  created_at: string;
  updated_at: string;
};

export const CONSTITUTIONAL_SIGNATURE_REQUEST_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "entity_type",
  "entity_id",
  "requested_authority",
  "requested_by",
  "status",
  "deadline",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalSignatureRequestRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_ratification_policies
// Source: 20260626000000_constitutional_ratification_framework.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionalRatificationPolicyRow = {
  id: string;
  workspace_id: string;
  entity_type: RatifiableEntityType;
  minimum_signatures: number;
  required_authorities: SignatureAuthorityType[];
  allow_unanimous_override: boolean;
  created_at: string;
};

export const CONSTITUTIONAL_RATIFICATION_POLICY_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "entity_type",
  "minimum_signatures",
  "required_authorities",
  "allow_unanimous_override",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalRatificationPolicyRow>;

// ─────────────────────────────────────────────────────────────────────────────
// authority_registrations
// Source: 20260627000000_authority_registry_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AuthorityType =
  | "sponsor"
  | "project_manager"
  | "technical_lead"
  | "steering_committee"
  | "governance_board"
  | "product_owner"
  | "architect"
  | "client"
  | "external_approver";

export type AuthorityScope = "workspace" | "project";

export type AuthorityStatus = "active" | "revoked" | "expired";

export type AuthorityRegistrationRow = {
  id: string;                      // uuid PK
  workspace_id: string;            // uuid references workspaces
  actor_id: string;                // uuid references auth.users
  authority_type: AuthorityType;   // text not null (enum-constrained)
  authority_scope: AuthorityScope; // text not null default 'project'
  project_id: string | null;       // uuid nullable
  valid_from: string;              // timestamptz
  valid_until: string | null;      // timestamptz nullable
  status: AuthorityStatus;         // text not null default 'active'
  revoked_at: string | null;       // timestamptz nullable
  revoked_by: string | null;       // uuid nullable
  revocation_reason: string | null;// text nullable
  granted_by: string;              // uuid references auth.users
  created_at: string;              // timestamptz
  updated_at: string;              // timestamptz
};

export const AUTHORITY_REGISTRATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "actor_id",
  "authority_type",
  "authority_scope",
  "project_id",
  "valid_from",
  "valid_until",
  "status",
  "revoked_at",
  "revoked_by",
  "revocation_reason",
  "granted_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AuthorityRegistrationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// authority_delegations
// Source: 20260627000000_authority_registry_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type DelegationStatus = "active" | "revoked" | "expired";

export type AuthorityDelegationRow = {
  id: string;                         // uuid PK
  workspace_id: string;               // uuid references workspaces
  delegator_id: string;               // uuid references auth.users
  delegator_authority: AuthorityType; // text not null (enum-constrained)
  delegate_id: string;                // uuid references auth.users
  delegate_authority: AuthorityType;  // text not null (enum-constrained)
  project_id: string | null;          // uuid nullable
  valid_from: string;                 // timestamptz
  valid_until: string | null;         // timestamptz nullable
  status: DelegationStatus;           // text not null default 'active'
  revoked_at: string | null;          // timestamptz nullable
  revoked_by: string | null;          // uuid nullable
  revocation_reason: string | null;   // text nullable
  delegation_depth: number;           // integer default 1 (1–3)
  parent_delegation_id: string | null;// uuid nullable self-ref
  created_by: string;                 // uuid references auth.users
  created_at: string;                 // timestamptz
  updated_at: string;                 // timestamptz
};

export const AUTHORITY_DELEGATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "delegator_id",
  "delegator_authority",
  "delegate_id",
  "delegate_authority",
  "project_id",
  "valid_from",
  "valid_until",
  "status",
  "revoked_at",
  "revoked_by",
  "revocation_reason",
  "delegation_depth",
  "parent_delegation_id",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AuthorityDelegationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_violations
// Source: 20260627000000_authority_registry_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceViolationType =
  | "unauthorized_approval"
  | "unauthorized_amendment"
  | "unauthorized_ratification"
  | "expired_authority"
  | "revoked_authority"
  | "missing_authority_registration"
  | "delegation_depth_exceeded";

export type GovernanceViolationSeverity = "low" | "medium" | "high" | "critical";
export type GovernanceViolationStatus = "open" | "acknowledged" | "resolved" | "escalated";

export type GovernanceViolationRow = {
  id: string;                                   // uuid PK
  workspace_id: string;                         // uuid references workspaces
  violation_type: GovernanceViolationType;      // text not null (enum-constrained)
  action_type: string;                          // text not null
  action_entity_type: string;                   // text not null
  action_entity_id: string;                     // uuid not null
  actor_id: string;                             // uuid references auth.users
  actor_authority: string | null;               // text nullable
  required_authority: string | null;            // text nullable
  authority_id: string | null;                  // uuid nullable
  severity: GovernanceViolationSeverity;        // text not null default 'high'
  status: GovernanceViolationStatus;            // text not null default 'open'
  resolved_at: string | null;                   // timestamptz nullable
  resolved_by: string | null;                   // uuid nullable
  resolution_notes: string | null;              // text nullable
  detected_at: string;                          // timestamptz
  created_at: string;                           // timestamptz
  updated_at: string;                           // timestamptz
};

export const GOVERNANCE_VIOLATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "violation_type",
  "action_type",
  "action_entity_type",
  "action_entity_id",
  "actor_id",
  "actor_authority",
  "required_authority",
  "authority_id",
  "severity",
  "status",
  "resolved_at",
  "resolved_by",
  "resolution_notes",
  "detected_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof GovernanceViolationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// authority_escalations
// Source: 20260627000000_authority_registry_governance.sql
// ─────────────────────────────────────────────────────────────────────────────

export type EscalationTriggerType =
  | "no_authority_holder"
  | "governance_violation"
  | "authority_gap"
  | "delegation_chain_broken"
  | "manual";

export type EscalationTarget = "governance_board" | "steering_committee" | "sponsor" | "external_approver";
export type EscalationStatus = "pending" | "acknowledged" | "resolved" | "closed";

export type AuthorityEscalationRow = {
  id: string;                             // uuid PK
  workspace_id: string;                   // uuid references workspaces
  trigger_type: EscalationTriggerType;    // text not null (enum-constrained)
  action_entity_type: string;             // text not null
  action_entity_id: string;              // uuid not null
  action_type: string;                    // text not null
  required_authority: string;             // text not null
  escalated_to: EscalationTarget;         // text not null default 'governance_board'
  escalated_by: string;                   // uuid references auth.users
  status: EscalationStatus;              // text not null default 'pending'
  resolution: string | null;              // text nullable
  resolved_by: string | null;             // uuid nullable
  resolved_at: string | null;             // timestamptz nullable
  violation_id: string | null;            // uuid nullable references governance_violations
  created_at: string;                     // timestamptz
  updated_at: string;                     // timestamptz
};

export const AUTHORITY_ESCALATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "trigger_type",
  "action_entity_type",
  "action_entity_id",
  "action_type",
  "required_authority",
  "escalated_to",
  "escalated_by",
  "status",
  "resolution",
  "resolved_by",
  "resolved_at",
  "violation_id",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AuthorityEscalationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// Constitutional Vault — EPIC 2 Sprint 1
// ─────────────────────────────────────────────────────────────────────────────

export type ArtifactType =
  | "document"
  | "email"
  | "meeting"
  | "transcript"
  | "spreadsheet"
  | "image"
  | "video"
  | "link"
  | "chat"
  | "other";

export type StorageProvider =
  | "local"
  | "supabase"
  | "s3"
  | "azure_blob"
  | "google_drive"
  | "sharepoint"
  | "dropbox"
  | "custom";

export type MemoryType =
  | "decision"
  | "objective"
  | "constraint"
  | "risk"
  | "issue"
  | "amendment"
  | "ratification"
  | "authority"
  | "evidence"
  | "other";

export type MemoryLinkEntityType =
  | "constitution"
  | "decision"
  | "amendment"
  | "ratification"
  | "authority"
  | "violation"
  | "escalation";

export type ConstitutionalArtifactRow = {
  id: string;                        // uuid primary key
  workspace_id: string;              // uuid references workspaces
  artifact_type: ArtifactType;       // text not null (enum-constrained)
  title: string;                     // text not null
  description: string | null;        // text nullable
  storage_provider: StorageProvider; // text not null (enum-constrained)
  storage_reference: string;         // text not null
  storage_path: string | null;       // text nullable
  checksum: string;                  // text not null
  uploaded_by: string;               // uuid references auth.users
  created_at: string;                // timestamptz
  deleted_at: string | null;         // timestamptz nullable (soft delete)
};

export const CONSTITUTIONAL_ARTIFACT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "artifact_type",
  "title",
  "description",
  "storage_provider",
  "storage_reference",
  "storage_path",
  "checksum",
  "uploaded_by",
  "created_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalArtifactRow>;

export type ConstitutionalMemoryRecordRow = {
  id: string;              // uuid primary key
  workspace_id: string;    // uuid references workspaces
  artifact_id: string;     // uuid references constitutional_artifacts
  memory_type: MemoryType; // text not null (enum-constrained)
  title: string;           // text not null
  canonical_text: string;  // text not null
  summary: string | null;  // text nullable
  created_at: string;      // timestamptz
  created_by: string;      // uuid references auth.users
};

export const CONSTITUTIONAL_MEMORY_RECORD_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "artifact_id",
  "memory_type",
  "title",
  "canonical_text",
  "summary",
  "created_at",
  "created_by",
] as const satisfies ReadonlyArray<keyof ConstitutionalMemoryRecordRow>;

export type ConstitutionalMemoryLinkRow = {
  id: string;                        // uuid primary key
  workspace_id: string;              // uuid references workspaces
  memory_record_id: string;          // uuid references constitutional_memory_records
  entity_type: MemoryLinkEntityType; // text not null (enum-constrained)
  entity_id: string;                 // uuid not null
  created_at: string;                // timestamptz
};

export const CONSTITUTIONAL_MEMORY_LINK_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "memory_record_id",
  "entity_type",
  "entity_id",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalMemoryLinkRow>;

// ─────────────────────────────────────────────────────────────────────────────
// Contract version — bump when any row type changes.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_digests
// Source: 20260619000002_constitutional_digest_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type DigestStatus =
  | "draft"
  | "generated"
  | "validated"
  | "published"
  | "archived";

export type DigestPayload = {
  project_type?: string;
  industry?: string;
  decision_patterns?: string[];
  risk_patterns?: string[];
  governance_patterns?: string[];
  outcome_patterns?: string[];
};

export type ConstitutionalDigestRow = {
  id: string;                     // uuid primary key
  workspace_id: string;           // uuid references workspaces
  memory_record_id: string;       // uuid references constitutional_memory_records
  digest_version: number;         // integer >= 1
  digest_status: DigestStatus;    // text enum-constrained
  source_memory_version: number;  // integer >= 1
  digest_payload: DigestPayload;  // jsonb
  confidence_score: number | null; // numeric(4,3) nullable
  created_at: string;             // timestamptz
  created_by: string;             // uuid references auth.users
  deleted_at: string | null;      // timestamptz nullable (soft delete)
};

export const CONSTITUTIONAL_DIGEST_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "memory_record_id",
  "digest_version",
  "digest_status",
  "source_memory_version",
  "digest_payload",
  "confidence_score",
  "created_at",
  "created_by",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalDigestRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_digest_classifications
// Source: 20260619000002_constitutional_digest_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type DigestClassificationType =
  | "industry"
  | "project_type"
  | "risk"
  | "decision"
  | "outcome"
  | "governance"
  | "delivery"
  | "authority";

export type ConstitutionalDigestClassificationRow = {
  id: string;                              // uuid primary key
  workspace_id: string;                    // uuid references workspaces
  digest_id: string;                       // uuid references constitutional_digests
  classification_type: DigestClassificationType;  // text enum-constrained
  classification_value: string;            // text not null
  confidence_score: number;               // numeric(4,3) 0.0–1.0
  created_at: string;                     // timestamptz
};

export const CONSTITUTIONAL_DIGEST_CLASSIFICATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "digest_id",
  "classification_type",
  "classification_value",
  "confidence_score",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalDigestClassificationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// programs
// Source: 20260628000000_programs.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ProgramType =
  | "SOFTWARE_DEVELOPMENT"
  | "INFRASTRUCTURE_PROJECT"
  | "CUSTOMER_ONBOARDING"
  | "AOC_PROTOCOL_ADOPTION"
  | "ORGANIZATIONAL_CHANGE"
  | "STRATEGIC_INITIATIVE"
  | "INTERNAL_PROGRAM"
  | "CUSTOM";

export type ProgramStatus =
  | "DRAFT"
  | "ACTIVE"
  | "PAUSED"
  | "COMPLETED"
  | "ARCHIVED";

export type ProgramRow = {
  id: string;                   // uuid
  workspace_id: string;         // uuid references workspaces
  name: string;                 // text 1–200
  description: string | null;   // text 0–5000
  type: ProgramType;            // text enum-constrained
  status: ProgramStatus;        // text enum-constrained default 'DRAFT'
  owner_id: string | null;      // uuid references auth.users
  start_date: string | null;    // timestamptz
  target_date: string | null;   // timestamptz
  created_at: string;           // timestamptz
  updated_at: string;           // timestamptz
  deleted_at: string | null;    // timestamptz (soft delete)
};

export const PROGRAM_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "name",
  "description",
  "type",
  "status",
  "owner_id",
  "start_date",
  "target_date",
  "created_at",
  "updated_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ProgramRow>;

// ─────────────────────────────────────────────────────────────────────────────
// program_epics
// Source: 20260629000000_program_hierarchy.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ProgramItemStatus =
  | "DRAFT"
  | "BACKLOG"
  | "READY"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "DONE"
  | "ARCHIVED";

export type ProgramEpicRow = {
  id: string;                 // uuid
  workspace_id: string;       // uuid references workspaces
  program_id: string;         // uuid references programs
  number: number;             // integer unique per program
  title: string;              // text 1–200
  description: string | null; // text
  status: ProgramItemStatus;  // text enum-constrained default 'DRAFT'
  order_index: number;        // integer
  created_at: string;         // timestamptz
  updated_at: string;         // timestamptz
  deleted_at: string | null;  // timestamptz (soft delete)
};

export const PROGRAM_EPIC_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "program_id",
  "number",
  "title",
  "description",
  "status",
  "order_index",
  "created_at",
  "updated_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ProgramEpicRow>;

// ─────────────────────────────────────────────────────────────────────────────
// program_sprints
// Source: 20260629000000_program_hierarchy.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ProgramSprintRow = {
  id: string;                 // uuid
  workspace_id: string;       // uuid references workspaces
  program_id: string;         // uuid references programs
  epic_id: string;            // uuid references program_epics
  number: number;             // integer unique per program
  title: string;              // text 1–200
  description: string | null; // text
  objective: string | null;   // text
  status: ProgramItemStatus;  // text enum-constrained default 'DRAFT'
  order_index: number;        // integer
  created_at: string;         // timestamptz
  updated_at: string;         // timestamptz
  deleted_at: string | null;  // timestamptz (soft delete)
};

export const PROGRAM_SPRINT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "program_id",
  "epic_id",
  "number",
  "title",
  "description",
  "objective",
  "status",
  "order_index",
  "created_at",
  "updated_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ProgramSprintRow>;

// ─────────────────────────────────────────────────────────────────────────────
// program_cards
// Source: 20260629000000_program_hierarchy.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ProgramCardType =
  | "EPIC"
  | "SPRINT"
  | "TASK"
  | "PROMPT"
  | "MILESTONE"
  | "DELIVERABLE"
  | "CUSTOM";

export type ProgramCardMaterializationType = "CAPABILITY" | "DELIVERABLE";

export type ProgramBoardColumn =
  | "BACKLOG"
  | "READY"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "DONE";

export type ProgramCardRow = {
  id: string;                 // uuid
  workspace_id: string;       // uuid references workspaces
  program_id: string;         // uuid references programs
  epic_id: string | null;     // uuid references program_epics (nullable)
  sprint_id: string | null;   // uuid references program_sprints (nullable)
  title: string;              // text 1–200
  description: string | null; // text
  prompt_body: string | null; // text (preserve formatting, never modify)
  type: ProgramCardType;      // text enum-constrained
  status: ProgramItemStatus;  // text enum-constrained default 'DRAFT'
  order_index: number;        // integer
  // Materialization tracing (added 20260701000000_program_materializations.sql)
  materialization_source: string | null;           // text — materialization id that created this card
  materialization_type: ProgramCardMaterializationType | null; // text enum-constrained
  source_line_number: number | null;               // integer — line in source roadmap
  // Context projection (added 20260703000000_program_card_context_projection.sql)
  materialization_id: string | null;               // uuid references program_materializations
  // Execution board (added 20260702000001_program_execution_board.sql)
  board_column: ProgramBoardColumn;                // text enum-constrained default 'BACKLOG'
  created_at: string;         // timestamptz
  updated_at: string;         // timestamptz
  deleted_at: string | null;  // timestamptz (soft delete)
};

export const PROGRAM_CARD_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "program_id",
  "epic_id",
  "sprint_id",
  "title",
  "description",
  "prompt_body",
  "type",
  "status",
  "order_index",
  "materialization_source",
  "materialization_type",
  "source_line_number",
  "materialization_id",
  "board_column",
  "created_at",
  "updated_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ProgramCardRow>;

// ─────────────────────────────────────────────────────────────────────────────
// program_roadmap_sources
// Source: 20260628050000_program_roadmap_sources.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ProgramRoadmapSourceType =
  | "TEXT"
  | "MARKDOWN"
  | "CLAUDE_PLAN"
  | "AOC_PLAN"
  | "INFRASTRUCTURE_PLAN"
  | "CUSTOM";

export type ProgramRoadmapSourceStatus =
  | "DRAFT"
  | "ACTIVE"
  | "SUPERSEDED"
  | "ARCHIVED";

export type ProgramRoadmapSourceRow = {
  id: string;                          // uuid
  workspace_id: string;                // uuid references workspaces
  program_id: string;                  // uuid references programs
  raw_text: string;                    // text 1–500000 (preserved exactly)
  source_type: ProgramRoadmapSourceType; // text enum-constrained
  title: string | null;                // text 1–200
  version: number;                     // integer positive, incremental per program
  status: ProgramRoadmapSourceStatus;  // text enum-constrained default 'DRAFT'
  metadata: Record<string, unknown> | null; // jsonb
  created_by: string | null;           // uuid references auth.users
  created_at: string;                  // timestamptz
  updated_at: string;                  // timestamptz
  deleted_at: string | null;           // timestamptz (soft delete)
};

export const PROGRAM_ROADMAP_SOURCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "program_id",
  "raw_text",
  "source_type",
  "title",
  "version",
  "status",
  "metadata",
  "created_by",
  "created_at",
  "updated_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ProgramRoadmapSourceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// program_roadmap_parse_results
// Source: 20260630000000_program_roadmap_parse_results.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ProgramRoadmapParseStatus =
  | "VALID"
  | "VALID_WITH_WARNINGS"
  | "INVALID";

export type ProgramRoadmapParseResultRow = {
  id: string;               // uuid
  workspace_id: string;     // uuid references workspaces
  program_id: string;       // uuid references programs
  source_id: string;        // uuid references program_roadmap_sources
  status: ProgramRoadmapParseStatus; // text enum-constrained
  result_json: Record<string, unknown>; // jsonb — full parse result
  error_count: number;      // integer >= 0
  warning_count: number;    // integer >= 0
  epic_count: number;       // integer >= 0
  sprint_count: number;     // integer >= 0
  parsed_at: string;        // timestamptz
  created_at: string;       // timestamptz
  updated_at: string;       // timestamptz
  deleted_at: string | null; // timestamptz (soft delete)
};

export const PROGRAM_ROADMAP_PARSE_RESULT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "program_id",
  "source_id",
  "status",
  "result_json",
  "error_count",
  "warning_count",
  "epic_count",
  "sprint_count",
  "parsed_at",
  "created_at",
  "updated_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ProgramRoadmapParseResultRow>;

// ─────────────────────────────────────────────────────────────────────────────
// program_materializations
// Source: 20260701000000_program_materializations.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ProgramMaterializationStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "COMPLETED"
  | "ARCHIVED";

export type ProgramMaterializationRow = {
  id: string;              // uuid
  workspace_id: string;    // uuid references workspaces
  program_id: string;      // uuid references programs
  source_id: string;       // uuid references program_roadmap_sources
  parse_result_id: string; // uuid references program_roadmap_parse_results
  status: ProgramMaterializationStatus; // text enum-constrained
  epics_created: number;   // integer >= 0
  sprints_created: number; // integer >= 0
  cards_created: number;   // integer >= 0
  started_at: string | null;   // timestamptz
  completed_at: string | null; // timestamptz
  created_at: string;      // timestamptz
  updated_at: string;      // timestamptz
  deleted_at: string | null; // timestamptz (soft delete)
};

export const PROGRAM_MATERIALIZATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "program_id",
  "source_id",
  "parse_result_id",
  "status",
  "epics_created",
  "sprints_created",
  "cards_created",
  "started_at",
  "completed_at",
  "created_at",
  "updated_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ProgramMaterializationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_learning_patterns
// Source: 20260622000001_constitutional_learning_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type LearningPatternType =
  | "decision_pattern"
  | "risk_pattern"
  | "governance_pattern"
  | "authority_pattern"
  | "amendment_pattern"
  | "delivery_pattern"
  | "outcome_pattern";

export type ConstitutionalLearningPatternRow = {
  id: string;                       // uuid primary key
  workspace_id: string;             // uuid references workspaces
  pattern_type: LearningPatternType; // text enum-constrained
  pattern_key: string;              // text not null
  description: string;              // text not null
  confidence_score: number;         // numeric(4,3) 0.0–1.0
  occurrence_count: number;         // integer >= 1
  first_seen_at: string;            // timestamptz
  last_seen_at: string;             // timestamptz
  created_at: string;               // timestamptz
  updated_at: string;               // timestamptz
};

export const CONSTITUTIONAL_LEARNING_PATTERN_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pattern_type",
  "pattern_key",
  "description",
  "confidence_score",
  "occurrence_count",
  "first_seen_at",
  "last_seen_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalLearningPatternRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_learning_evidence
// Source: 20260622000001_constitutional_learning_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionalLearningEvidenceRow = {
  id: string;                   // uuid primary key
  workspace_id: string;         // uuid references workspaces
  learning_pattern_id: string;  // uuid references constitutional_learning_patterns
  digest_id: string;            // uuid references constitutional_digests
  contribution_weight: number;  // numeric(4,3) 0.0–1.0
  created_at: string;           // timestamptz
};

export const CONSTITUTIONAL_LEARNING_EVIDENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "learning_pattern_id",
  "digest_id",
  "contribution_weight",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalLearningEvidenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_learning_recommendations
// Source: 20260622000001_constitutional_learning_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionalLearningRecommendationRow = {
  id: string;                   // uuid primary key
  workspace_id: string;         // uuid references workspaces
  learning_pattern_id: string;  // uuid references constitutional_learning_patterns
  recommendation: string;       // text not null
  confidence_score: number;     // numeric(4,3) 0.0–1.0
  created_at: string;           // timestamptz
};

export const CONSTITUTIONAL_LEARNING_RECOMMENDATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "learning_pattern_id",
  "recommendation",
  "confidence_score",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalLearningRecommendationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_recommendations
// Source: 20260622000002_sovereign_recommendation_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type RecommendationType =
  | "risk_mitigation"
  | "governance_control"
  | "decision_guidance"
  | "authority_control"
  | "delivery_improvement"
  | "ratification_control"
  | "amendment_guidance"
  | "portfolio_guidance";

export type RecommendationScope =
  | "project"
  | "decision"
  | "risk"
  | "governance"
  | "amendment"
  | "authority"
  | "ratification"
  | "delivery"
  | "portfolio";

export type RecommendationStatus =
  | "draft"
  | "generated"
  | "validated"
  | "published"
  | "retired"
  | "deprecated";

export type RecommendationApplicationEntityType =
  | "constitution"
  | "decision"
  | "amendment"
  | "risk"
  | "authority"
  | "project";

export type RecommendationApplicationStatus =
  | "applied"
  | "dismissed"
  | "superseded";

export type ConstitutionalRecommendationRow = {
  id: string;                       // uuid primary key
  workspace_id: string;             // uuid references workspaces
  recommendation_key: string;       // text not null
  recommendation_type: RecommendationType; // text enum-constrained
  recommendation_scope: RecommendationScope; // text enum-constrained
  title: string;                    // text not null
  description: string;              // text not null
  recommendation_text: string;      // text not null
  confidence_score: number;         // numeric(4,3) 0.0–1.0
  supporting_pattern_count: number; // integer >= 0
  status: RecommendationStatus;     // text enum-constrained
  created_at: string;               // timestamptz
  updated_at: string;               // timestamptz
  deleted_at: string | null;        // timestamptz nullable
};

export const CONSTITUTIONAL_RECOMMENDATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "recommendation_key",
  "recommendation_type",
  "recommendation_scope",
  "title",
  "description",
  "recommendation_text",
  "confidence_score",
  "supporting_pattern_count",
  "status",
  "created_at",
  "updated_at",
  "deleted_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalRecommendationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_recommendation_evidence
// Source: 20260622000002_sovereign_recommendation_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionalRecommendationEvidenceRow = {
  id: string;                   // uuid primary key
  workspace_id: string;         // uuid references workspaces
  recommendation_id: string;    // uuid references constitutional_recommendations
  learning_pattern_id: string;  // uuid references constitutional_learning_patterns
  contribution_weight: number;  // numeric(4,3) 0.0–1.0
  created_at: string;           // timestamptz
};

export const CONSTITUTIONAL_RECOMMENDATION_EVIDENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "recommendation_id",
  "learning_pattern_id",
  "contribution_weight",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalRecommendationEvidenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_recommendation_applications
// Source: 20260622000002_sovereign_recommendation_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionalRecommendationApplicationRow = {
  id: string;                // uuid primary key
  workspace_id: string;      // uuid references workspaces
  recommendation_id: string; // uuid references constitutional_recommendations
  entity_type: RecommendationApplicationEntityType; // text enum-constrained
  entity_id: string;         // uuid
  application_status: RecommendationApplicationStatus; // text enum-constrained
  applied_at: string;        // timestamptz
  created_at: string;        // timestamptz
};

export const CONSTITUTIONAL_RECOMMENDATION_APPLICATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "recommendation_id",
  "entity_type",
  "entity_id",
  "application_status",
  "applied_at",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalRecommendationApplicationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_recommendation_outcomes
// Source: 20260622000003_recommendation_effectiveness_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type RecommendationOutcomeType =
  | "risk_reduction"
  | "schedule_improvement"
  | "cost_reduction"
  | "quality_improvement"
  | "governance_improvement"
  | "delivery_improvement"
  | "authority_improvement"
  | "ratification_improvement";

export type RecommendationOutcomeStatus =
  | "successful"
  | "neutral"
  | "failed"
  | "unknown";

export type ConstitutionalRecommendationOutcomeRow = {
  id: string;                  // uuid primary key
  workspace_id: string;        // uuid references workspaces
  recommendation_id: string;   // uuid references constitutional_recommendations
  application_id: string;      // uuid references constitutional_recommendation_applications
  outcome_type: RecommendationOutcomeType;
  outcome_status: RecommendationOutcomeStatus;
  observed_value: number | null; // numeric(6,3)
  expected_value: number | null; // numeric(6,3)
  effectiveness_score: number;   // numeric(4,3) 0.0–1.0
  observed_at: string;           // timestamptz
  created_at: string;            // timestamptz
};

export const CONSTITUTIONAL_RECOMMENDATION_OUTCOME_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "recommendation_id",
  "application_id",
  "outcome_type",
  "outcome_status",
  "observed_value",
  "expected_value",
  "effectiveness_score",
  "observed_at",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalRecommendationOutcomeRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_recommendation_feedback
// Source: 20260622000003_recommendation_effectiveness_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type RecommendationFeedbackType = "positive" | "neutral" | "negative";

export type ConstitutionalRecommendationFeedbackRow = {
  id: string;                // uuid primary key
  workspace_id: string;      // uuid references workspaces
  recommendation_id: string; // uuid references constitutional_recommendations
  application_id: string;    // uuid references constitutional_recommendation_applications
  feedback_type: RecommendationFeedbackType;
  rating: number;            // integer 1–5
  comments: string | null;   // text
  submitted_by: string;      // uuid references auth.users
  created_at: string;        // timestamptz
};

export const CONSTITUTIONAL_RECOMMENDATION_FEEDBACK_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "recommendation_id",
  "application_id",
  "feedback_type",
  "rating",
  "comments",
  "submitted_by",
  "created_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalRecommendationFeedbackRow>;

// ─────────────────────────────────────────────────────────────────────────────
// constitutional_recommendation_effectiveness
// Source: 20260622000003_recommendation_effectiveness_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConstitutionalRecommendationEffectivenessRow = {
  id: string;                   // uuid primary key
  workspace_id: string;         // uuid references workspaces
  recommendation_id: string;    // uuid references constitutional_recommendations
  applications_count: number;   // integer
  successful_count: number;     // integer
  failed_count: number;         // integer
  neutral_count: number;        // integer
  average_effectiveness: number; // numeric(4,3) 0.0–1.0
  confidence_adjustment: number; // numeric(4,3) -1.0–1.0
  last_calculated_at: string;   // timestamptz
};

export const CONSTITUTIONAL_RECOMMENDATION_EFFECTIVENESS_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "recommendation_id",
  "applications_count",
  "successful_count",
  "failed_count",
  "neutral_count",
  "average_effectiveness",
  "confidence_adjustment",
  "last_calculated_at",
] as const satisfies ReadonlyArray<keyof ConstitutionalRecommendationEffectivenessRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_signals
// Source: 20260704000000_governance_signal_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceSignalType =
  | "approval_delay"
  | "authority_gap"
  | "escalation_gap"
  | "decision_bottleneck"
  | "amendment_backlog"
  | "ratification_stall"
  | "risk_accumulation"
  | "recommendation_ignored"
  | "governance_violation"
  | "delivery_drift";

export type GovernanceSignalSeverity = "low" | "medium" | "high" | "critical";
export type GovernanceSignalStatus = "active" | "acknowledged" | "resolved" | "dismissed";

export type GovernanceSignalSource =
  | "constitution"
  | "decision"
  | "amendment"
  | "ratification"
  | "authority"
  | "delegation"
  | "recommendation"
  | "risk"
  | "project";

export type GovernanceSignalRow = {
  id: string;                     // uuid PK
  workspace_id: string;           // uuid references workspaces
  signal_type: GovernanceSignalType;     // text not null
  signal_source: GovernanceSignalSource; // text not null
  source_entity_type: string;     // text not null
  source_entity_id: string;       // uuid not null
  title: string;                  // text not null
  description: string;            // text not null
  severity: GovernanceSignalSeverity;    // text not null
  confidence_score: number;       // numeric(4,3) 0.0–1.0
  status: GovernanceSignalStatus; // text not null default 'active'
  detected_at: string;            // timestamptz
  acknowledged_at: string | null; // timestamptz
  acknowledged_by: string | null; // uuid
  resolved_at: string | null;     // timestamptz
  resolved_by: string | null;     // uuid
  dismissed_at: string | null;    // timestamptz
  dismissed_by: string | null;    // uuid
  dismissed_reason: string | null;// text
  created_at: string;             // timestamptz
  updated_at: string;             // timestamptz
};

export const GOVERNANCE_SIGNAL_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "signal_type",
  "signal_source",
  "source_entity_type",
  "source_entity_id",
  "title",
  "description",
  "severity",
  "confidence_score",
  "status",
  "detected_at",
  "acknowledged_at",
  "acknowledged_by",
  "resolved_at",
  "resolved_by",
  "dismissed_at",
  "dismissed_by",
  "dismissed_reason",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof GovernanceSignalRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_signal_evidence
// Source: 20260704000000_governance_signal_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceSignalEvidenceType =
  | "decision_observation"
  | "amendment_observation"
  | "authority_observation"
  | "ratification_observation"
  | "recommendation_observation"
  | "violation_observation"
  | "pattern_match"
  | "historical_data";

export type GovernanceSignalEvidenceRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  signal_id: string;                       // uuid references governance_signals
  evidence_type: GovernanceSignalEvidenceType; // text not null
  reference_entity_type: string;           // text not null
  reference_entity_id: string;             // uuid not null
  contribution_weight: number;             // numeric(4,3) 0.0–1.0
  created_at: string;                      // timestamptz
};

export const GOVERNANCE_SIGNAL_EVIDENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "signal_id",
  "evidence_type",
  "reference_entity_type",
  "reference_entity_id",
  "contribution_weight",
  "created_at",
] as const satisfies ReadonlyArray<keyof GovernanceSignalEvidenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_signal_recommendations
// Source: 20260704000000_governance_signal_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceSignalRecommendationRow = {
  id: string;               // uuid PK
  workspace_id: string;     // uuid references workspaces
  signal_id: string;        // uuid references governance_signals
  recommendation_id: string;// uuid references constitutional_recommendations
  confidence_score: number; // numeric(4,3) 0.0–1.0
  created_at: string;       // timestamptz
};

export const GOVERNANCE_SIGNAL_RECOMMENDATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "signal_id",
  "recommendation_id",
  "confidence_score",
  "created_at",
] as const satisfies ReadonlyArray<keyof GovernanceSignalRecommendationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_actions
// Source: 20260705000000_governance_action_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceActionType =
  | "create_escalation"
  | "request_ratification"
  | "request_approval"
  | "create_delegation"
  | "assign_authority"
  | "review_amendment"
  | "review_decision"
  | "review_risk"
  | "initiate_governance_review"
  | "close_signal"
  | "reassess_recommendation"
  | "other";

export type GovernanceActionPriority = "low" | "medium" | "high" | "critical";

export type GovernanceActionStatus =
  | "generated"
  | "reviewed"
  | "approved"
  | "rejected"
  | "expired"
  | "completed";

export type GovernanceActionRow = {
  id: string;                        // uuid PK
  workspace_id: string;              // uuid references workspaces
  signal_id: string;                 // uuid references governance_signals
  action_type: GovernanceActionType; // text not null
  action_priority: GovernanceActionPriority; // text not null
  action_status: GovernanceActionStatus;     // text not null default 'generated'
  title: string;                     // text not null
  description: string;               // text not null
  recommended_owner_type: string;    // text not null
  recommended_owner_id: string | null; // uuid
  recommended_due_date: string;      // timestamptz not null
  justification: string;             // text not null
  confidence_score: number;          // numeric(4,3) 0.0–1.0
  created_at: string;                // timestamptz
  updated_at: string;                // timestamptz
  completed_at: string | null;       // timestamptz
  expired_at: string | null;         // timestamptz
};

export const GOVERNANCE_ACTION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "signal_id",
  "action_type",
  "action_priority",
  "action_status",
  "title",
  "description",
  "recommended_owner_type",
  "recommended_owner_id",
  "recommended_due_date",
  "justification",
  "confidence_score",
  "created_at",
  "updated_at",
  "completed_at",
  "expired_at",
] as const satisfies ReadonlyArray<keyof GovernanceActionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_action_evidence
// Source: 20260705000000_governance_action_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceActionEvidenceRow = {
  id: string;                     // uuid PK
  workspace_id: string;           // uuid references workspaces
  action_id: string;              // uuid references governance_actions
  signal_id: string | null;       // uuid references governance_signals
  recommendation_id: string | null; // uuid
  learning_pattern_id: string | null; // uuid
  contribution_weight: number;    // numeric(4,3) 0.0–1.0
  created_at: string;             // timestamptz
};

export const GOVERNANCE_ACTION_EVIDENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "action_id",
  "signal_id",
  "recommendation_id",
  "learning_pattern_id",
  "contribution_weight",
  "created_at",
] as const satisfies ReadonlyArray<keyof GovernanceActionEvidenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_action_assignments
// Source: 20260705000000_governance_action_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceActionAssignmentStatus =
  | "assigned"
  | "accepted"
  | "completed"
  | "declined";

export type GovernanceActionAssignmentRow = {
  id: string;              // uuid PK
  workspace_id: string;    // uuid references workspaces
  action_id: string;       // uuid references governance_actions
  assigned_to: string;     // uuid
  assignment_status: GovernanceActionAssignmentStatus; // text not null
  assigned_at: string;     // timestamptz
  accepted_at: string | null; // timestamptz
  completed_at: string | null; // timestamptz
};

export const GOVERNANCE_ACTION_ASSIGNMENT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "action_id",
  "assigned_to",
  "assignment_status",
  "assigned_at",
  "accepted_at",
  "completed_at",
] as const satisfies ReadonlyArray<keyof GovernanceActionAssignmentRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_commitments
// Source: 20260706000000_governance_commitment_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceCommitmentStatus =
  | "pending_acceptance"
  | "accepted"
  | "rejected"
  | "active"
  | "completed"
  | "breached"
  | "cancelled"
  | "delegated"
  | "expired";

export type GovernanceCommitmentPriority = "low" | "medium" | "high" | "critical";

export type GovernanceCommitmentOutcome = "successful" | "partial" | "failed" | "unknown";

export type GovernanceCommitmentRow = {
  id: string;                                      // uuid PK
  workspace_id: string;                            // uuid references workspaces
  action_id: string;                               // uuid references governance_actions
  commitment_title: string;                        // text not null
  commitment_description: string;                  // text not null
  owner_id: string;                                // uuid not null
  owner_type: string;                              // text not null
  priority: GovernanceCommitmentPriority;          // text not null
  status: GovernanceCommitmentStatus;              // text not null default 'pending_acceptance'
  due_date: string;                                // timestamptz not null
  accepted_at: string | null;                      // timestamptz
  started_at: string | null;                       // timestamptz
  completed_at: string | null;                     // timestamptz
  cancelled_at: string | null;                     // timestamptz
  breached_at: string | null;                      // timestamptz
  expired_at: string | null;                       // timestamptz
  outcome: GovernanceCommitmentOutcome | null;     // text
  created_at: string;                              // timestamptz
  updated_at: string;                              // timestamptz
};

export const GOVERNANCE_COMMITMENT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "action_id",
  "commitment_title",
  "commitment_description",
  "owner_id",
  "owner_type",
  "priority",
  "status",
  "due_date",
  "accepted_at",
  "started_at",
  "completed_at",
  "cancelled_at",
  "breached_at",
  "expired_at",
  "outcome",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof GovernanceCommitmentRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_commitment_history
// Source: 20260706000000_governance_commitment_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceCommitmentHistoryRow = {
  id: string;              // uuid PK
  workspace_id: string;    // uuid references workspaces
  commitment_id: string;   // uuid references governance_commitments
  previous_status: string; // text not null
  new_status: string;      // text not null
  changed_by: string;      // uuid not null
  reason: string | null;   // text
  created_at: string;      // timestamptz
};

export const GOVERNANCE_COMMITMENT_HISTORY_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "commitment_id",
  "previous_status",
  "new_status",
  "changed_by",
  "reason",
  "created_at",
] as const satisfies ReadonlyArray<keyof GovernanceCommitmentHistoryRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_commitment_delegations
// Source: 20260706000000_governance_commitment_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceCommitmentDelegationStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "cancelled";

export type GovernanceCommitmentDelegationRow = {
  id: string;              // uuid PK
  workspace_id: string;    // uuid references workspaces
  commitment_id: string;   // uuid references governance_commitments
  delegated_by: string;    // uuid not null
  delegated_to: string;    // uuid not null
  reason: string;          // text not null
  delegated_at: string;    // timestamptz
  accepted_at: string | null; // timestamptz
  status: GovernanceCommitmentDelegationStatus; // text not null
  created_at: string;      // timestamptz
};

export const GOVERNANCE_COMMITMENT_DELEGATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "commitment_id",
  "delegated_by",
  "delegated_to",
  "reason",
  "delegated_at",
  "accepted_at",
  "status",
  "created_at",
] as const satisfies ReadonlyArray<keyof GovernanceCommitmentDelegationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_commitment_evidence
// Source: 20260706000000_governance_commitment_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceCommitmentEvidenceRow = {
  id: string;                       // uuid PK
  workspace_id: string;             // uuid references workspaces
  commitment_id: string;            // uuid references governance_commitments
  artifact_id: string | null;       // uuid
  memory_record_id: string | null;  // uuid
  description: string;              // text not null
  created_at: string;               // timestamptz
};

export const GOVERNANCE_COMMITMENT_EVIDENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "commitment_id",
  "artifact_id",
  "memory_record_id",
  "description",
  "created_at",
] as const satisfies ReadonlyArray<keyof GovernanceCommitmentEvidenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_projections
// Source: 20260707000000_execution_projection_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionProjectionStatus =
  | "generated"
  | "validated"
  | "approved"
  | "rejected"
  | "archived";

export type ExecutionProjectionRisk = "low" | "medium" | "high" | "critical";

export type ExecutionProjectionRow = {
  id: string;                                   // uuid PK
  workspace_id: string;                         // uuid references workspaces
  commitment_id: string;                        // uuid references governance_commitments
  projection_title: string;                     // text not null
  projection_description: string;               // text not null
  status: ExecutionProjectionStatus;            // text not null default 'generated'
  estimated_effort_hours: number;               // integer not null default 0
  estimated_duration_days: number;              // integer not null default 0
  projected_risk: ExecutionProjectionRisk;      // text not null default 'low'
  confidence_score: number;                     // numeric(4,3) not null default 0.0
  generated_at: string;                         // timestamptz not null
  validated_at: string | null;                  // timestamptz
  approved_at: string | null;                   // timestamptz
  archived_at: string | null;                   // timestamptz
  created_at: string;                           // timestamptz
  updated_at: string;                           // timestamptz
};

export const EXECUTION_PROJECTION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "commitment_id",
  "projection_title",
  "projection_description",
  "status",
  "estimated_effort_hours",
  "estimated_duration_days",
  "projected_risk",
  "confidence_score",
  "generated_at",
  "validated_at",
  "approved_at",
  "archived_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ExecutionProjectionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_projection_tasks
// Source: 20260707000000_execution_projection_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionProjectionTaskRow = {
  id: string;              // uuid PK
  workspace_id: string;    // uuid references workspaces
  projection_id: string;   // uuid references execution_projections
  task_name: string;       // text not null
  task_description: string; // text not null
  estimated_hours: number; // integer not null default 0
  sequence_order: number;  // integer not null default 0
  owner_type: string;      // text not null
  created_at: string;      // timestamptz
};

export const EXECUTION_PROJECTION_TASK_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "projection_id",
  "task_name",
  "task_description",
  "estimated_hours",
  "sequence_order",
  "owner_type",
  "created_at",
] as const satisfies ReadonlyArray<keyof ExecutionProjectionTaskRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_projection_dependencies
// Source: 20260707000000_execution_projection_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionProjectionDependencyType =
  | "decision"
  | "authority"
  | "ratification"
  | "amendment"
  | "resource";

export type ExecutionProjectionDependencyCriticality = "low" | "medium" | "high" | "critical";

export type ExecutionProjectionDependencyRow = {
  id: string;                                                   // uuid PK
  workspace_id: string;                                         // uuid references workspaces
  projection_id: string;                                        // uuid references execution_projections
  dependency_type: ExecutionProjectionDependencyType;           // text not null
  dependency_reference: string;                                 // text not null
  criticality: ExecutionProjectionDependencyCriticality;        // text not null default 'medium'
  created_at: string;                                           // timestamptz
};

export const EXECUTION_PROJECTION_DEPENDENCY_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "projection_id",
  "dependency_type",
  "dependency_reference",
  "criticality",
  "created_at",
] as const satisfies ReadonlyArray<keyof ExecutionProjectionDependencyRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_projection_participants
// Source: 20260707000000_execution_projection_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionProjectionParticipantRow = {
  id: string;                    // uuid PK
  workspace_id: string;          // uuid references workspaces
  projection_id: string;         // uuid references execution_projections
  participant_type: string;      // text not null
  participant_reference: string; // text not null
  responsibility: string;        // text not null
  created_at: string;            // timestamptz
};

export const EXECUTION_PROJECTION_PARTICIPANT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "projection_id",
  "participant_type",
  "participant_reference",
  "responsibility",
  "created_at",
] as const satisfies ReadonlyArray<keyof ExecutionProjectionParticipantRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_realities
// Source: 20260708000000_execution_reality_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionRealityStatus =
  | "observed"
  | "validated"
  | "completed"
  | "archived";

export type ExecutionRealityRisk = "low" | "medium" | "high" | "critical";

export type ExecutionRealityRow = {
  id: string;                        // uuid PK
  workspace_id: string;              // uuid references workspaces
  projection_id: string;             // uuid references execution_projections
  reality_title: string;             // text not null
  reality_description: string;       // text not null
  status: ExecutionRealityStatus;    // text not null default 'observed'
  actual_effort_hours: number;       // integer not null default 0
  actual_duration_days: number;      // integer not null default 0
  actual_risk: ExecutionRealityRisk; // text not null default 'low'
  actual_task_count: number;         // integer not null default 0
  actual_participant_count: number;  // integer not null default 0
  confidence_score: number;          // numeric(4,3) not null default 0.0
  observed_at: string;               // timestamptz not null
  validated_at: string | null;       // timestamptz
  completed_at: string | null;       // timestamptz
  archived_at: string | null;        // timestamptz
  created_at: string;                // timestamptz not null
  updated_at: string;                // timestamptz not null
};

export const EXECUTION_REALITY_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "projection_id",
  "reality_title",
  "reality_description",
  "status",
  "actual_effort_hours",
  "actual_duration_days",
  "actual_risk",
  "actual_task_count",
  "actual_participant_count",
  "confidence_score",
  "observed_at",
  "validated_at",
  "completed_at",
  "archived_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ExecutionRealityRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_variances
// Source: 20260708000000_execution_reality_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionVarianceType =
  | "effort"
  | "duration"
  | "risk"
  | "tasks"
  | "participants";

export type ExecutionVarianceSeverity = "low" | "medium" | "high" | "critical";

export type ExecutionVarianceRow = {
  id: string;                           // uuid PK
  workspace_id: string;                 // uuid references workspaces
  reality_id: string;                   // uuid references execution_realities
  variance_type: ExecutionVarianceType; // text not null
  projected_value: number;              // numeric not null
  actual_value: number;                 // numeric not null
  variance_percentage: number;          // numeric(8,2) not null
  severity: ExecutionVarianceSeverity;  // text not null
  created_at: string;                   // timestamptz not null
};

export const EXECUTION_VARIANCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "reality_id",
  "variance_type",
  "projected_value",
  "actual_value",
  "variance_percentage",
  "severity",
  "created_at",
] as const satisfies ReadonlyArray<keyof ExecutionVarianceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_observations
// Source: 20260708000000_execution_reality_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionObservationRow = {
  id: string;                 // uuid PK
  workspace_id: string;       // uuid references workspaces
  reality_id: string;         // uuid references execution_realities
  observation_type: string;   // text not null
  observation_value: string;  // text not null
  observation_source: string; // text not null
  observed_by: string | null; // uuid
  observed_at: string;        // timestamptz not null
  created_at: string;         // timestamptz not null
};

export const EXECUTION_OBSERVATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "reality_id",
  "observation_type",
  "observation_value",
  "observation_source",
  "observed_by",
  "observed_at",
  "created_at",
] as const satisfies ReadonlyArray<keyof ExecutionObservationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// execution_drifts
// Source: 20260708000000_execution_reality_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ExecutionDriftType = "schedule" | "effort" | "resource" | "risk";

export type ExecutionDriftSeverity = "none" | "emerging" | "persistent" | "critical";

export type ExecutionDriftRow = {
  id: string;                         // uuid PK
  workspace_id: string;               // uuid references workspaces
  reality_id: string;                 // uuid references execution_realities
  drift_type: ExecutionDriftType;     // text not null
  severity: ExecutionDriftSeverity;   // text not null
  description: string;                // text not null
  detected_at: string;                // timestamptz not null
  resolved_at: string | null;         // timestamptz
  created_at: string;                 // timestamptz not null
};

export const EXECUTION_DRIFT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "reality_id",
  "drift_type",
  "severity",
  "description",
  "detected_at",
  "resolved_at",
  "created_at",
] as const satisfies ReadonlyArray<keyof ExecutionDriftRow>;

// ─────────────────────────────────────────────────────────────────────────────
// project_os_snapshots
// Source: 20260709000000_project_operating_system.sql
// Central orchestration snapshot composing governance, memory, execution,
// and intelligence data into a unified project operating view.
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectOSSnapshotStatus = "generated" | "validated" | "archived";

export type ProjectOSSnapshotRow = {
  id: string;                                   // uuid PK
  workspace_id: string;                         // uuid references workspaces
  project_id: string;                           // uuid references projects
  snapshot_status: ProjectOSSnapshotStatus;     // text not null
  operating_health_score: number;               // numeric(5,2)
  governance_health_score: number;              // numeric(5,2)
  execution_health_score: number;               // numeric(5,2)
  memory_health_score: number;                  // numeric(5,2)
  recommendation_health_score: number;          // numeric(5,2)
  snapshot_payload: Record<string, unknown>;    // jsonb
  generated_at: string;                         // timestamptz
  created_at: string;                           // timestamptz
};

export const PROJECT_OS_SNAPSHOT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "snapshot_status",
  "operating_health_score",
  "governance_health_score",
  "execution_health_score",
  "memory_health_score",
  "recommendation_health_score",
  "snapshot_payload",
  "generated_at",
  "created_at",
] as const satisfies ReadonlyArray<keyof ProjectOSSnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// project_os_attention_items
// Source: 20260709000000_project_operating_system.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectOSAttentionType =
  | "critical_signal"
  | "overdue_commitment"
  | "execution_drift"
  | "governance_violation"
  | "ratification_stall"
  | "authority_gap"
  | "low_health_score"
  | "ignored_recommendation"
  | "projection_variance";

export type ProjectOSAttentionSeverity = "low" | "medium" | "high" | "critical";

export type ProjectOSAttentionItemRow = {
  id: string;                                       // uuid PK
  workspace_id: string;                             // uuid references workspaces
  snapshot_id: string;                              // uuid references project_os_snapshots
  attention_type: ProjectOSAttentionType;           // text not null
  attention_severity: ProjectOSAttentionSeverity;   // text not null
  source_entity_type: string;                       // text not null
  source_entity_id: string;                         // uuid not null
  title: string;                                    // text not null
  description: string;                              // text not null
  recommended_action: string | null;                // text
  created_at: string;                               // timestamptz
};

export const PROJECT_OS_ATTENTION_ITEM_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "snapshot_id",
  "attention_type",
  "attention_severity",
  "source_entity_type",
  "source_entity_id",
  "title",
  "description",
  "recommended_action",
  "created_at",
] as const satisfies ReadonlyArray<keyof ProjectOSAttentionItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// project_os_context_links
// Source: 20260709000000_project_operating_system.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectOSContextLinkRow = {
  id: string;               // uuid PK
  workspace_id: string;     // uuid references workspaces
  snapshot_id: string;      // uuid references project_os_snapshots
  entity_type: string;      // text not null
  entity_id: string;        // uuid not null
  relationship_type: string; // text not null
  created_at: string;       // timestamptz
};

export const PROJECT_OS_CONTEXT_LINK_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "snapshot_id",
  "entity_type",
  "entity_id",
  "relationship_type",
  "created_at",
] as const satisfies ReadonlyArray<keyof ProjectOSContextLinkRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_command_centers
// Source: 20260710000000_operational_command_center.sql
// EPIC 4 Sprint 2 — Operational Command Center
// Transforms Project OS Snapshots into a prioritized operational focus layer.
// ─────────────────────────────────────────────────────────────────────────────

export type OperationalCommandStatus = "generated" | "validated" | "archived";
export type OperationalPriority = "low" | "medium" | "high" | "critical";

export type OperationalCommandCenterRow = {
  id: string;                               // uuid PK
  workspace_id: string;                     // uuid references workspaces
  project_id: string;                       // uuid
  snapshot_id: string;                      // uuid references project_os_snapshots
  command_status: OperationalCommandStatus; // text not null
  overall_priority: OperationalPriority;    // text not null
  focus_score: number;                      // numeric(5,2)
  generated_at: string;                     // timestamptz
  created_at: string;                       // timestamptz
  updated_at: string;                       // timestamptz
};

export const OPERATIONAL_COMMAND_CENTER_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "snapshot_id",
  "command_status",
  "overall_priority",
  "focus_score",
  "generated_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof OperationalCommandCenterRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_focus_items
// Source: 20260710000000_operational_command_center.sql
// ─────────────────────────────────────────────────────────────────────────────

export type OperationalFocusType =
  | "governance"
  | "execution"
  | "authority"
  | "ratification"
  | "recommendation"
  | "commitment"
  | "projection"
  | "reality"
  | "risk"
  | "health";

export type OperationalFocusStatus =
  | "open"
  | "acknowledged"
  | "in_progress"
  | "resolved"
  | "dismissed";

export type OperationalFocusItemRow = {
  id: string;                                 // uuid PK
  workspace_id: string;                       // uuid references workspaces
  command_center_id: string;                  // uuid references operational_command_centers
  attention_item_id: string | null;           // uuid references project_os_attention_items
  focus_type: OperationalFocusType;           // text not null
  priority: OperationalPriority;              // text not null
  focus_score: number;                        // numeric(5,2)
  title: string;                              // text not null
  description: string;                        // text not null
  rationale: string;                          // text not null
  recommended_action_type: string | null;     // text
  recommended_owner_type: string | null;      // text
  recommended_due_date: string | null;        // timestamptz
  status: OperationalFocusStatus;             // text not null
  created_at: string;                         // timestamptz
  updated_at: string;                         // timestamptz
  resolved_at: string | null;                 // timestamptz
  dismissed_at: string | null;                // timestamptz
};

export const OPERATIONAL_FOCUS_ITEM_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "command_center_id",
  "attention_item_id",
  "focus_type",
  "priority",
  "focus_score",
  "title",
  "description",
  "rationale",
  "recommended_action_type",
  "recommended_owner_type",
  "recommended_due_date",
  "status",
  "created_at",
  "updated_at",
  "resolved_at",
  "dismissed_at",
] as const satisfies ReadonlyArray<keyof OperationalFocusItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_focus_links
// Source: 20260710000000_operational_command_center.sql
// ─────────────────────────────────────────────────────────────────────────────

export type OperationalFocusLinkRow = {
  id: string;               // uuid PK
  workspace_id: string;     // uuid references workspaces
  focus_item_id: string;    // uuid references operational_focus_items
  entity_type: string;      // text not null
  entity_id: string;        // uuid not null
  relationship_type: string; // text not null
  created_at: string;       // timestamptz
};

export const OPERATIONAL_FOCUS_LINK_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "focus_item_id",
  "entity_type",
  "entity_id",
  "relationship_type",
  "created_at",
] as const satisfies ReadonlyArray<keyof OperationalFocusLinkRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_consequences
// Source: 20260711000000_operational_consequence_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConsequenceSeverity =
  | "low"
  | "medium"
  | "high"
  | "critical"
  | "systemic";

export type ConsequenceImpactHorizon =
  | "24h"
  | "48h"
  | "7d"
  | "14d"
  | "30d"
  | "90d";

export type ConsequenceAnalysisStatus =
  | "generated"
  | "validated"
  | "archived";

export type OperationalConsequenceRow = {
  id: string;                               // uuid PK
  workspace_id: string;                     // uuid references workspaces
  focus_item_id: string;                    // uuid references operational_focus_items
  severity: ConsequenceSeverity;            // text not null
  impact_horizon: ConsequenceImpactHorizon; // text not null
  escalation_probability: number;           // numeric(4,3)
  impact_score: number;                     // numeric(5,2)
  analysis_status: ConsequenceAnalysisStatus; // text not null
  generated_at: string;                     // timestamptz
  created_at: string;                       // timestamptz
  updated_at: string;                       // timestamptz
};

export const OPERATIONAL_CONSEQUENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "focus_item_id",
  "severity",
  "impact_horizon",
  "escalation_probability",
  "impact_score",
  "analysis_status",
  "generated_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof OperationalConsequenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_consequence_impacts
// Source: 20260711000000_operational_consequence_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConsequenceImpactType =
  | "governance"
  | "execution"
  | "authority"
  | "ratification"
  | "commitment"
  | "projection"
  | "reality"
  | "recommendation"
  | "risk"
  | "health";

export type OperationalConsequenceImpactRow = {
  id: string;                           // uuid PK
  workspace_id: string;                 // uuid references workspaces
  consequence_id: string;               // uuid references operational_consequences
  impact_type: ConsequenceImpactType;   // text not null
  affected_entity_type: string;         // text not null
  affected_entity_count: number;        // integer
  impact_score: number;                 // numeric(5,2)
  description: string;                  // text not null
  created_at: string;                   // timestamptz
};

export const OPERATIONAL_CONSEQUENCE_IMPACT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "consequence_id",
  "impact_type",
  "affected_entity_type",
  "affected_entity_count",
  "impact_score",
  "description",
  "created_at",
] as const satisfies ReadonlyArray<keyof OperationalConsequenceImpactRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_consequence_paths
// Source: 20260711000000_operational_consequence_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type OperationalConsequencePathRow = {
  id: string;                       // uuid PK
  workspace_id: string;             // uuid references workspaces
  consequence_id: string;           // uuid references operational_consequences
  source_entity_type: string;       // text not null
  source_entity_id: string;         // uuid not null
  target_entity_type: string;       // text not null
  target_entity_id: string;         // uuid not null
  relationship_type: string;        // text not null
  cascade_depth: number;            // integer
  created_at: string;               // timestamptz
};

export const OPERATIONAL_CONSEQUENCE_PATH_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "consequence_id",
  "source_entity_type",
  "source_entity_id",
  "target_entity_type",
  "target_entity_id",
  "relationship_type",
  "cascade_depth",
  "created_at",
] as const satisfies ReadonlyArray<keyof OperationalConsequencePathRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_consequence_scenarios
// Source: 20260711000000_operational_consequence_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ConsequenceScenarioName =
  | "best_case"
  | "expected_case"
  | "worst_case";

export type OperationalConsequenceScenarioRow = {
  id: string;                           // uuid PK
  workspace_id: string;                 // uuid references workspaces
  consequence_id: string;               // uuid references operational_consequences
  scenario_name: ConsequenceScenarioName; // text not null
  scenario_description: string;         // text not null
  probability: number;                  // numeric(4,3)
  created_at: string;                   // timestamptz
};

export const OPERATIONAL_CONSEQUENCE_SCENARIO_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "consequence_id",
  "scenario_name",
  "scenario_description",
  "probability",
  "created_at",
] as const satisfies ReadonlyArray<keyof OperationalConsequenceScenarioRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_decisions
// Source: 20260712000000_operational_decision_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type DecisionCategory =
  | "governance"
  | "authority"
  | "ratification"
  | "execution"
  | "commitment"
  | "risk"
  | "resource"
  | "escalation"
  | "projection"
  | "portfolio";

export type DecisionStatus =
  | "generated"
  | "evaluated"
  | "recommended"
  | "accepted"
  | "rejected"
  | "archived";

export type OperationalDecisionRow = {
  id: string;                             // uuid PK
  workspace_id: string;                   // uuid references workspaces
  consequence_id: string;                 // uuid references operational_consequences
  decision_category: DecisionCategory;    // text not null
  decision_status: DecisionStatus;        // text not null
  recommended_option_id: string | null;   // uuid references operational_decision_options
  decision_score: number;                 // numeric(5,2)
  decision_confidence: number;            // numeric(4,3)
  generated_at: string;                   // timestamptz
  created_at: string;                     // timestamptz
  updated_at: string;                     // timestamptz
};

export const OPERATIONAL_DECISION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "consequence_id",
  "decision_category",
  "decision_status",
  "recommended_option_id",
  "decision_score",
  "decision_confidence",
  "generated_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof OperationalDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_decision_options
// Source: 20260712000000_operational_decision_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type DecisionOptionType =
  | "governance"
  | "authority"
  | "execution"
  | "commitment"
  | "escalation"
  | "resource"
  | "risk"
  | "structural";

export type DecisionEffortLevel = "low" | "medium" | "high";
export type DecisionRiskLevel   = "low" | "medium" | "high" | "critical";

export type OperationalDecisionOptionRow = {
  id: string;                           // uuid PK
  workspace_id: string;                 // uuid references workspaces
  decision_id: string;                  // uuid references operational_decisions
  option_name: string;                  // text not null
  option_description: string;           // text not null
  option_type: DecisionOptionType;      // text not null
  pros: string;                         // text (JSON array serialised)
  cons: string;                         // text (JSON array serialised)
  estimated_effort: DecisionEffortLevel;// text not null
  estimated_risk: DecisionRiskLevel;    // text not null
  created_at: string;                   // timestamptz
};

export const OPERATIONAL_DECISION_OPTION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "decision_id",
  "option_name",
  "option_description",
  "option_type",
  "pros",
  "cons",
  "estimated_effort",
  "estimated_risk",
  "created_at",
] as const satisfies ReadonlyArray<keyof OperationalDecisionOptionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_decision_evaluations
// Source: 20260712000000_operational_decision_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type OperationalDecisionEvaluationRow = {
  id: string;               // uuid PK
  workspace_id: string;     // uuid references workspaces
  decision_id: string;      // uuid references operational_decisions
  option_id: string;        // uuid references operational_decision_options
  governance_score: number; // numeric(5,2)
  execution_score: number;  // numeric(5,2)
  risk_score: number;       // numeric(5,2)
  health_score: number;     // numeric(5,2)
  overall_score: number;    // numeric(5,2)
  created_at: string;       // timestamptz
};

export const OPERATIONAL_DECISION_EVALUATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "decision_id",
  "option_id",
  "governance_score",
  "execution_score",
  "risk_score",
  "health_score",
  "overall_score",
  "created_at",
] as const satisfies ReadonlyArray<keyof OperationalDecisionEvaluationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_decision_tradeoffs
// Source: 20260712000000_operational_decision_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type DecisionTradeoffType = "pro" | "con";

export type OperationalDecisionTradeoffRow = {
  id: string;                         // uuid PK
  workspace_id: string;               // uuid references workspaces
  decision_id: string;                // uuid references operational_decisions
  option_id: string;                  // uuid references operational_decision_options
  tradeoff_type: DecisionTradeoffType;// text not null
  description: string;                // text not null
  impact_score: number;               // numeric(5,2)
  created_at: string;                 // timestamptz
};

export const OPERATIONAL_DECISION_TRADEOFF_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "decision_id",
  "option_id",
  "tradeoff_type",
  "description",
  "impact_score",
  "created_at",
] as const satisfies ReadonlyArray<keyof OperationalDecisionTradeoffRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_decision_outcomes
// Source: 20260713000000_operational_decision_outcome_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type OutcomeStatus =
  | "pending"
  | "observed"
  | "evaluated"
  | "successful"
  | "partially_successful"
  | "unsuccessful"
  | "archived";

export type RecommendationQuality =
  | "poor"
  | "fair"
  | "good"
  | "very_good"
  | "excellent";

export type OperationalDecisionOutcomeRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  decision_id: string;                     // uuid references operational_decisions
  outcome_status: OutcomeStatus;           // text not null
  expected_impact_score: number;           // numeric(5,2)
  actual_impact_score: number;             // numeric(5,2)
  effectiveness_score: number;             // numeric(5,2)
  recommendation_quality: RecommendationQuality; // text not null
  outcome_variance: number;                // numeric(7,4)
  observed_at: string | null;              // timestamptz
  evaluated_at: string | null;             // timestamptz
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const OPERATIONAL_DECISION_OUTCOME_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "decision_id",
  "outcome_status",
  "expected_impact_score",
  "actual_impact_score",
  "effectiveness_score",
  "recommendation_quality",
  "outcome_variance",
  "observed_at",
  "evaluated_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof OperationalDecisionOutcomeRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_outcome_observations
// Source: 20260713000000_operational_decision_outcome_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type OutcomeObservationType =
  | "governance_health"
  | "execution_health"
  | "risk_reduction"
  | "authority_recovery"
  | "ratification_speed"
  | "commitment_completion"
  | "projection_accuracy"
  | "recommendation_effectiveness";

export type OperationalOutcomeObservationRow = {
  id: string;                                  // uuid PK
  workspace_id: string;                        // uuid references workspaces
  outcome_id: string;                          // uuid references operational_decision_outcomes
  observation_type: OutcomeObservationType;    // text not null
  observation_value: number;                   // numeric(7,4)
  observation_source: string;                  // text not null
  observed_by: string;                         // uuid not null
  observed_at: string;                         // timestamptz
  created_at: string;                          // timestamptz
};

export const OPERATIONAL_OUTCOME_OBSERVATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "outcome_id",
  "observation_type",
  "observation_value",
  "observation_source",
  "observed_by",
  "observed_at",
  "created_at",
] as const satisfies ReadonlyArray<keyof OperationalOutcomeObservationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_outcome_effects
// Source: 20260713000000_operational_decision_outcome_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type OutcomeEffectType =
  | "governance_health"
  | "execution_health"
  | "risk_reduction"
  | "authority_recovery"
  | "ratification_speed"
  | "commitment_completion"
  | "projection_accuracy"
  | "recommendation_effectiveness";

export type OperationalOutcomeEffectRow = {
  id: string;                          // uuid PK
  workspace_id: string;                // uuid references workspaces
  outcome_id: string;                  // uuid references operational_decision_outcomes
  effect_type: OutcomeEffectType;      // text not null
  before_value: number;                // numeric(7,4)
  after_value: number;                 // numeric(7,4)
  improvement_percentage: number;      // numeric(7,4)
  created_at: string;                  // timestamptz
};

export const OPERATIONAL_OUTCOME_EFFECT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "outcome_id",
  "effect_type",
  "before_value",
  "after_value",
  "improvement_percentage",
  "created_at",
] as const satisfies ReadonlyArray<keyof OperationalOutcomeEffectRow>;

// ─────────────────────────────────────────────────────────────────────────────
// operational_learning_feedback
// Source: 20260713000000_operational_decision_outcome_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type LearningFeedbackType =
  | "decision_pattern"
  | "effectiveness_signal"
  | "quality_signal"
  | "risk_insight"
  | "governance_insight"
  | "recommendation_calibration";

export type OperationalLearningFeedbackRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  outcome_id: string;                      // uuid references operational_decision_outcomes
  learning_type: LearningFeedbackType;     // text not null
  learning_summary: string;                // text not null
  confidence_score: number;                // numeric(4,3)
  should_recommend_again: boolean;         // boolean not null
  created_at: string;                      // timestamptz
};

export const OPERATIONAL_LEARNING_FEEDBACK_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "outcome_id",
  "learning_type",
  "learning_summary",
  "confidence_score",
  "should_recommend_again",
  "created_at",
] as const satisfies ReadonlyArray<keyof OperationalLearningFeedbackRow>;

// ─────────────────────────────────────────────────────────────────────────────
// project_managers
// Source: 20260623000000_pm_registry_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type ProjectManagerStatus = "active" | "inactive" | "suspended";

export type ProjectManagerRow = {
  id: string;           // uuid
  workspace_id: string; // uuid references workspaces
  user_id: string | null; // uuid references auth.users (nullable)
  display_name: string; // text not null
  email: string;        // text not null
  status: ProjectManagerStatus; // text not null default 'active'
  joined_at: string;    // timestamptz
  created_at: string;   // timestamptz
  updated_at: string;   // timestamptz
};

export const PROJECT_MANAGER_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "user_id",
  "display_name",
  "email",
  "status",
  "joined_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof ProjectManagerRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pm_assignments
// Source: 20260623000000_pm_registry_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMAssignmentType = "primary" | "secondary" | "program" | "observer";

export type PMAssignmentRow = {
  id: string;             // uuid
  workspace_id: string;   // uuid references workspaces
  pm_id: string;          // uuid references project_managers
  project_id: string;     // uuid references projects
  assignment_type: PMAssignmentType; // text not null
  assigned_at: string;    // timestamptz
  removed_at: string | null; // timestamptz (null = active)
};

export const PM_ASSIGNMENT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pm_id",
  "project_id",
  "assignment_type",
  "assigned_at",
  "removed_at",
] as const satisfies ReadonlyArray<keyof PMAssignmentRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pm_profiles
// Source: 20260623000000_pm_registry_foundation.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMRole =
  | "project_manager"
  | "senior_pm"
  | "program_manager"
  | "portfolio_manager";

export type PMExperienceLevel = "junior" | "mid" | "senior" | "principal";

export type PMProfileRow = {
  id: string;                   // uuid
  workspace_id: string;         // uuid references workspaces
  pm_id: string;                // uuid references project_managers
  role: PMRole;                 // text not null default 'project_manager'
  experience_level: PMExperienceLevel; // text not null default 'mid'
  capacity_limit: number;       // integer not null default 100 (0-100)
  active_projects_limit: number; // integer not null default 5
  created_at: string;           // timestamptz
  updated_at: string;           // timestamptz
};

export const PM_PROFILE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pm_id",
  "role",
  "experience_level",
  "capacity_limit",
  "active_projects_limit",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof PMProfileRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pm_performance_snapshots
// Source: 20260715000000_pm_performance_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMPerformanceStatus = "excellent" | "strong" | "stable" | "warning" | "critical";

export type PMPerformanceSnapshotRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  pm_id: string;                           // uuid references project_managers
  governance_score: number;                // numeric(5,2) 0-100
  execution_score: number;                 // numeric(5,2) 0-100
  prediction_accuracy_score: number;       // numeric(5,2) 0-100
  decision_effectiveness_score: number;    // numeric(5,2) 0-100
  portfolio_health_score: number;          // numeric(5,2) 0-100
  overall_score: number;                   // numeric(5,2) 0-100
  performance_status: PMPerformanceStatus; // text not null
  snapshot_payload: Record<string, unknown>; // jsonb
  generated_at: string;                    // timestamptz
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const PM_PERFORMANCE_SNAPSHOT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pm_id",
  "governance_score",
  "execution_score",
  "prediction_accuracy_score",
  "decision_effectiveness_score",
  "portfolio_health_score",
  "overall_score",
  "performance_status",
  "snapshot_payload",
  "generated_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof PMPerformanceSnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pm_performance_metrics
// Source: 20260715000000_pm_performance_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMPerformanceDomain = "governance" | "execution" | "prediction" | "decision" | "portfolio" | "overall";
export type PMPerformanceMetricStatus = "excellent" | "strong" | "stable" | "warning" | "critical";

export type PMPerformanceMetricRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  performance_snapshot_id: string;         // uuid references pm_performance_snapshots
  metric_domain: PMPerformanceDomain;      // text not null
  metric_name: string;                     // text not null
  metric_value: number;                    // numeric(7,4)
  metric_weight: number;                   // numeric(5,4) 0-1
  metric_status: PMPerformanceMetricStatus; // text not null
  created_at: string;                      // timestamptz
};

export const PM_PERFORMANCE_METRIC_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "performance_snapshot_id",
  "metric_domain",
  "metric_name",
  "metric_value",
  "metric_weight",
  "metric_status",
  "created_at",
] as const satisfies ReadonlyArray<keyof PMPerformanceMetricRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pm_performance_evidence
// Source: 20260715000000_pm_performance_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMPerformanceEvidenceRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  performance_snapshot_id: string;         // uuid references pm_performance_snapshots
  source_entity_type: string;              // text not null
  source_entity_id: string;               // uuid not null
  evidence_type: string;                   // text not null
  contribution_weight: number;             // numeric(5,4) 0-1
  created_at: string;                      // timestamptz
};

export const PM_PERFORMANCE_EVIDENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "performance_snapshot_id",
  "source_entity_type",
  "source_entity_id",
  "evidence_type",
  "contribution_weight",
  "created_at",
] as const satisfies ReadonlyArray<keyof PMPerformanceEvidenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pm_capacity_snapshots
// Source: 20260716000000_pm_capacity_load_intelligence.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMCapacityStatus = "underutilized" | "healthy" | "busy" | "overloaded" | "critical";
export type PMBurnRisk = "none" | "low" | "medium" | "high" | "critical";

export type PMCapacitySnapshotRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  pm_id: string;                           // uuid references project_managers
  capacity_score: number;                  // numeric(7,2) >= 0
  load_score: number;                      // numeric(7,2) >= 0
  utilization_percentage: number;          // numeric(7,2) >= 0
  burn_risk: PMBurnRisk;                   // text not null
  capacity_status: PMCapacityStatus;       // text not null
  recommended_action: string;              // text not null
  snapshot_payload: Record<string, unknown>; // jsonb
  generated_at: string;                    // timestamptz
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const PM_CAPACITY_SNAPSHOT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pm_id",
  "capacity_score",
  "load_score",
  "utilization_percentage",
  "burn_risk",
  "capacity_status",
  "recommended_action",
  "snapshot_payload",
  "generated_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof PMCapacitySnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pm_capacity_metrics
// Source: 20260716000000_pm_capacity_load_intelligence.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMCapacityMetricRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  capacity_snapshot_id: string;            // uuid references pm_capacity_snapshots
  metric_name: string;                     // text not null
  metric_value: number;                    // numeric(7,4)
  metric_weight: number;                   // numeric(5,4) 0-1
  metric_status: PMCapacityStatus;         // text not null
  created_at: string;                      // timestamptz
};

export const PM_CAPACITY_METRIC_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "capacity_snapshot_id",
  "metric_name",
  "metric_value",
  "metric_weight",
  "metric_status",
  "created_at",
] as const satisfies ReadonlyArray<keyof PMCapacityMetricRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pm_capacity_evidence
// Source: 20260716000000_pm_capacity_load_intelligence.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMCapacityEvidenceRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  capacity_snapshot_id: string;            // uuid references pm_capacity_snapshots
  source_entity_type: string;              // text not null
  source_entity_id: string;               // uuid not null
  evidence_type: string;                   // text not null
  contribution_weight: number;             // numeric(5,4) 0-1
  created_at: string;                      // timestamptz
};

export const PM_CAPACITY_EVIDENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "capacity_snapshot_id",
  "source_entity_type",
  "source_entity_id",
  "evidence_type",
  "contribution_weight",
  "created_at",
] as const satisfies ReadonlyArray<keyof PMCapacityEvidenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// Governance Compliance Types
// Source: 20260717000000_pmo_governance_compliance_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceComplianceStatus = "compliant" | "warning" | "critical";
export type GovernanceComplianceDomain = "constitution" | "authority" | "ratification" | "decision" | "execution" | "learning";
export type GovernanceGapSeverity = "low" | "medium" | "high" | "critical";

// ─────────────────────────────────────────────────────────────────────────────
// governance_compliance_snapshots
// Source: 20260717000000_pmo_governance_compliance_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceComplianceSnapshotRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  pm_id: string;                           // uuid references project_managers
  constitution_score: number;              // numeric(7,2) 0-100
  authority_score: number;                 // numeric(7,2) 0-100
  ratification_score: number;              // numeric(7,2) 0-100
  decision_score: number;                  // numeric(7,2) 0-100
  execution_score: number;                 // numeric(7,2) 0-100
  learning_score: number;                  // numeric(7,2) 0-100
  overall_score: number;                   // numeric(7,2) 0-100
  compliance_status: GovernanceComplianceStatus; // text not null
  snapshot_payload: Record<string, unknown>; // jsonb
  generated_at: string;                    // timestamptz
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const GOVERNANCE_COMPLIANCE_SNAPSHOT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "pm_id",
  "constitution_score",
  "authority_score",
  "ratification_score",
  "decision_score",
  "execution_score",
  "learning_score",
  "overall_score",
  "compliance_status",
  "snapshot_payload",
  "generated_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof GovernanceComplianceSnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_compliance_gaps
// Source: 20260717000000_pmo_governance_compliance_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceComplianceGapRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  snapshot_id: string;                     // uuid references governance_compliance_snapshots
  domain: GovernanceComplianceDomain;      // text not null
  gap_type: string;                        // text not null
  severity: GovernanceGapSeverity;         // text not null
  description: string;                     // text not null
  evidence_count: number;                  // integer >= 0
  detected_at: string;                     // timestamptz
  created_at: string;                      // timestamptz
};

export const GOVERNANCE_COMPLIANCE_GAP_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "snapshot_id",
  "domain",
  "gap_type",
  "severity",
  "description",
  "evidence_count",
  "detected_at",
  "created_at",
] as const satisfies ReadonlyArray<keyof GovernanceComplianceGapRow>;

// ─────────────────────────────────────────────────────────────────────────────
// governance_compliance_evidence
// Source: 20260717000000_pmo_governance_compliance_engine.sql
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceComplianceEvidenceRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  snapshot_id: string;                     // uuid references governance_compliance_snapshots
  source_entity_type: string;              // text not null
  source_entity_id: string;               // uuid not null
  evidence_type: string;                   // text not null
  contribution_weight: number;             // numeric(5,4) 0-1
  created_at: string;                      // timestamptz
};

export const GOVERNANCE_COMPLIANCE_EVIDENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "snapshot_id",
  "source_entity_type",
  "source_entity_id",
  "evidence_type",
  "contribution_weight",
  "created_at",
] as const satisfies ReadonlyArray<keyof GovernanceComplianceEvidenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pmo_command_center_snapshots
// Source: 20260718000000_pmo_command_center.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMOStatus = "excellent" | "healthy" | "stable" | "warning" | "critical";

export type PMOCommandCenterSnapshotRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  overall_health_score: number;            // numeric(7,2) 0-100
  capacity_score: number;                  // numeric(7,2) 0-100
  governance_score: number;                // numeric(7,2) 0-100
  execution_score: number;                 // numeric(7,2) 0-100
  risk_score: number;                      // numeric(7,2) 0-100
  project_count: number;                   // integer >= 0
  portfolio_count: number;                 // integer >= 0
  pm_count: number;                        // integer >= 0
  critical_projects: number;               // integer >= 0
  warning_projects: number;                // integer >= 0
  healthy_projects: number;                // integer >= 0
  snapshot_payload: Record<string, unknown>; // jsonb
  generated_at: string;                    // timestamptz
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const PMO_COMMAND_CENTER_SNAPSHOT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "overall_health_score",
  "capacity_score",
  "governance_score",
  "execution_score",
  "risk_score",
  "project_count",
  "portfolio_count",
  "pm_count",
  "critical_projects",
  "warning_projects",
  "healthy_projects",
  "snapshot_payload",
  "generated_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof PMOCommandCenterSnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pmo_attention_items
// Source: 20260718000000_pmo_command_center.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMOAttentionPriority = "low" | "medium" | "high" | "critical";
export type PMOAttentionEntityType = "pm" | "project" | "portfolio" | "governance";

export type PMOAttentionItemRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  snapshot_id: string;                     // uuid references pmo_command_center_snapshots
  entity_type: PMOAttentionEntityType;     // text not null
  entity_id: string;                       // uuid not null
  priority: PMOAttentionPriority;          // text not null
  title: string;                           // text not null
  description: string;                     // text not null
  recommended_action: string;              // text not null
  created_at: string;                      // timestamptz
};

export const PMO_ATTENTION_ITEM_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "snapshot_id",
  "entity_type",
  "entity_id",
  "priority",
  "title",
  "description",
  "recommended_action",
  "created_at",
] as const satisfies ReadonlyArray<keyof PMOAttentionItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pmo_recommendations
// Source: 20260718000000_pmo_command_center.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMORecommendationType = "capacity" | "governance" | "execution" | "portfolio" | "staffing" | "risk";
export type PMOImpactScore = "low" | "medium" | "high" | "critical";

export type PMORecommendationRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  snapshot_id: string;                     // uuid references pmo_command_center_snapshots
  recommendation_type: PMORecommendationType; // text not null
  recommendation: string;                  // text not null
  confidence_score: number;                // numeric(5,4) 0-1
  impact_score: PMOImpactScore;            // text not null
  created_at: string;                      // timestamptz
};

export const PMO_RECOMMENDATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "snapshot_id",
  "recommendation_type",
  "recommendation",
  "confidence_score",
  "impact_score",
  "created_at",
] as const satisfies ReadonlyArray<keyof PMORecommendationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pmo_intervention_actions
// Source: 20260719000000_pmo_intervention_actions.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMOInterventionActionRow = {
  id: string;                              // uuid PK
  workspace_id: string;                    // uuid references workspaces
  source_type: string;                     // text not null
  source_id: string | null;               // text
  source_snapshot_id: string | null;      // text
  source_violation_id: string | null;     // text
  source_recommendation_id: string | null; // text
  action_type: string;                     // text not null
  action_title: string;                    // text not null
  action_description: string;             // text not null
  priority: string;                        // text not null
  status: string;                          // text not null default 'proposed'
  target_type: string | null;             // text
  target_id: string | null;               // text
  target_name: string | null;             // text
  pm_id: string | null;                   // text
  project_id: string | null;              // text
  evidence: Record<string, unknown> | null; // jsonb
  recommendation: Record<string, unknown> | null; // jsonb
  requires_approval: boolean;              // boolean not null default true
  approval_status: string;                 // text not null default 'pending'
  approved_by: string | null;             // text
  approved_at: string | null;             // timestamptz
  rejected_by: string | null;             // text
  rejected_at: string | null;             // timestamptz
  rejection_reason: string | null;        // text
  completed_by: string | null;            // text
  completed_at: string | null;            // timestamptz
  completion_notes: string | null;        // text
  dismissed_by: string | null;            // text
  dismissed_at: string | null;            // timestamptz
  dismissal_reason: string | null;        // text
  decision_reason: string | null;         // text
  created_by: string | null;              // text
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const PMO_INTERVENTION_ACTION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "source_type",
  "source_id",
  "source_snapshot_id",
  "source_violation_id",
  "source_recommendation_id",
  "action_type",
  "action_title",
  "action_description",
  "priority",
  "status",
  "target_type",
  "target_id",
  "target_name",
  "pm_id",
  "project_id",
  "evidence",
  "recommendation",
  "requires_approval",
  "approval_status",
  "approved_by",
  "approved_at",
  "rejected_by",
  "rejected_at",
  "rejection_reason",
  "completed_by",
  "completed_at",
  "completion_notes",
  "dismissed_by",
  "dismissed_at",
  "dismissal_reason",
  "decision_reason",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof PMOInterventionActionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pmo_executive_reports
// Source: 20260725000000_pmo_executive_reporting.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMOExecutiveReportRow = {
  id: string;                                  // uuid PK
  workspace_id: string;                        // uuid references workspaces
  report_type: string;                         // text not null
  report_period_start: string | null;          // timestamptz
  report_period_end: string | null;            // timestamptz
  generated_at: string;                        // timestamptz not null default now()
  generated_by: string | null;                // text
  executive_status: string;                    // text not null
  executive_risk: string;                      // text not null
  report_title: string | null;                // text
  executive_summary: Record<string, unknown> | null;  // jsonb
  key_metrics: Record<string, unknown> | null;        // jsonb
  sections: unknown[] | null;                  // jsonb
  source_refs: Record<string, unknown> | null; // jsonb
  report_payload: Record<string, unknown> | null;     // jsonb
  archived_at: string | null;                 // timestamptz
  created_at: string;                          // timestamptz
  updated_at: string;                          // timestamptz
};

export const PMO_EXECUTIVE_REPORT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "report_type",
  "report_period_start",
  "report_period_end",
  "generated_at",
  "generated_by",
  "executive_status",
  "executive_risk",
  "report_title",
  "executive_summary",
  "key_metrics",
  "sections",
  "source_refs",
  "report_payload",
  "archived_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof PMOExecutiveReportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// pmo_alert_payloads
// Source: 20260725000000_pmo_executive_reporting.sql
// ─────────────────────────────────────────────────────────────────────────────

export type PMOAlertPayloadRow = {
  id: string;                                  // uuid PK
  workspace_id: string;                        // uuid references workspaces
  alert_type: string;                          // text not null
  severity: string;                            // text not null
  status: string;                              // text not null default 'new'
  title: string;                               // text not null
  message: string;                             // text not null
  target_type: string | null;                 // text
  target_id: string | null;                   // text
  pm_id: string | null;                       // text
  project_id: string | null;                  // text
  source_type: string | null;                 // text
  source_id: string | null;                   // text
  source_ref: Record<string, unknown> | null; // jsonb
  payload: Record<string, unknown> | null;    // jsonb
  recommended_action: string | null;          // text
  created_by: string | null;                  // text
  created_at: string;                          // timestamptz
  reviewed_by: string | null;                 // text
  reviewed_at: string | null;                 // timestamptz
  archived_at: string | null;                 // timestamptz
  updated_at: string;                          // timestamptz
};

export const PMO_ALERT_PAYLOAD_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "alert_type",
  "severity",
  "status",
  "title",
  "message",
  "target_type",
  "target_id",
  "pm_id",
  "project_id",
  "source_type",
  "source_id",
  "source_ref",
  "payload",
  "recommended_action",
  "created_by",
  "created_at",
  "reviewed_by",
  "reviewed_at",
  "archived_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof PMOAlertPayloadRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_tools
// Source: 20260726000000_agent_tool_registry.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentToolCategoryDb =
  | "project_read" | "portfolio_read" | "pm_read" | "analysis" | "drafting"
  | "recommendation" | "task_generation" | "communication" | "governance"
  | "reporting" | "administration";

export type AgentToolRiskLevelDb = "low" | "medium" | "high" | "critical";
export type AgentToolStatusDb = "active" | "disabled" | "deprecated";
export type AgentToolExecutionModeDb = "read_only" | "draft_only" | "requires_approval" | "automatic";

export type AgentToolRow = {
  id: string;                              // uuid
  workspace_id: string;                    // uuid references workspaces
  tool_key: string;                        // text not null
  display_name: string;                    // text not null
  description: string;                     // text not null
  category: AgentToolCategoryDb;           // text not null
  risk_level: AgentToolRiskLevelDb;        // text not null
  execution_mode: AgentToolExecutionModeDb; // text not null
  status: AgentToolStatusDb;               // text not null default 'active'
  input_schema_json: string | null;        // text
  output_schema_json: string | null;       // text
  required_permissions_json: string;       // text not null default '[]'
  compatible_agent_types_json: string;     // text not null default '[]'
  creates_evidence: boolean;               // boolean not null default false
  mutates_state: boolean;                  // boolean not null default false
  requires_human_approval: boolean;        // boolean not null default false
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const AGENT_TOOL_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "tool_key",
  "display_name",
  "description",
  "category",
  "risk_level",
  "execution_mode",
  "status",
  "input_schema_json",
  "output_schema_json",
  "required_permissions_json",
  "compatible_agent_types_json",
  "creates_evidence",
  "mutates_state",
  "requires_human_approval",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AgentToolRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_tool_assignments
// Source: 20260726000000_agent_tool_registry.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentToolAssignmentStatusDb = "active" | "removed";

export type AgentToolAssignmentRow = {
  id: string;                                    // uuid
  workspace_id: string;                          // uuid references workspaces
  agent_id: string;                              // uuid references ai_agents
  tool_id: string;                               // uuid references agent_tools
  status: AgentToolAssignmentStatusDb;           // text not null default 'active'
  assigned_at: string;                           // timestamptz
  assigned_by: string | null;                    // text
  removed_at: string | null;                     // timestamptz
};

export const AGENT_TOOL_ASSIGNMENT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "agent_id",
  "tool_id",
  "status",
  "assigned_at",
  "assigned_by",
  "removed_at",
] as const satisfies ReadonlyArray<keyof AgentToolAssignmentRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_tool_requests
// Source: 20260727000000_agent_permission_approval_layer.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentToolRequestStatusDb =
  | "pending" | "approved" | "rejected" | "cancelled" | "expired";

export type AgentToolRequestRow = {
  id: string;                          // uuid
  workspace_id: string;                // uuid references workspaces
  agent_id: string;                    // text not null
  agent_type: string;                  // text not null
  tool_id: string;                     // uuid references agent_tools
  tool_key: string;                    // text not null
  status: AgentToolRequestStatusDb;    // text not null default 'pending'
  request_reason: string | null;       // text
  request_context_json: string;        // text not null default '{}'
  requested_by: string | null;         // text
  requested_at: string;                // timestamptz
  expires_at: string | null;           // timestamptz
  resolved_at: string | null;          // timestamptz
  created_at: string;                  // timestamptz
  updated_at: string;                  // timestamptz
};

export const AGENT_TOOL_REQUEST_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "agent_id",
  "agent_type",
  "tool_id",
  "tool_key",
  "status",
  "request_reason",
  "request_context_json",
  "requested_by",
  "requested_at",
  "expires_at",
  "resolved_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AgentToolRequestRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_tool_approvals
// Source: 20260727000000_agent_permission_approval_layer.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentToolApprovalDecisionDb = "approved" | "rejected";

export type AgentToolApprovalRow = {
  id: string;                                // uuid
  request_id: string;                        // uuid references agent_tool_requests
  workspace_id: string;                      // uuid references workspaces
  decision: AgentToolApprovalDecisionDb;     // text not null
  decided_by: string;                        // text not null
  decision_note: string | null;              // text
  decided_at: string;                        // timestamptz
  revoked_at: string | null;                 // timestamptz
  revoked_by: string | null;                 // text
  revocation_note: string | null;            // text
  created_at: string;                        // timestamptz
  updated_at: string;                        // timestamptz
};

export const AGENT_TOOL_APPROVAL_SELECTABLE_COLUMNS = [
  "id",
  "request_id",
  "workspace_id",
  "decision",
  "decided_by",
  "decision_note",
  "decided_at",
  "revoked_at",
  "revoked_by",
  "revocation_note",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AgentToolApprovalRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_tool_approval_events
// Source: 20260727000000_agent_permission_approval_layer.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentToolApprovalEventTypeDb =
  | "request_created" | "request_approved" | "request_rejected"
  | "request_cancelled" | "request_expired" | "approval_revoked";

export type AgentToolApprovalEventRow = {
  id: string;                                    // uuid
  request_id: string;                            // uuid references agent_tool_requests
  workspace_id: string;                          // uuid references workspaces
  event_type: AgentToolApprovalEventTypeDb;      // text not null
  actor: string | null;                          // text
  note: string | null;                           // text
  metadata_json: string;                         // text not null default '{}'
  created_at: string;                            // timestamptz
};

export const AGENT_TOOL_APPROVAL_EVENT_SELECTABLE_COLUMNS = [
  "id",
  "request_id",
  "workspace_id",
  "event_type",
  "actor",
  "note",
  "metadata_json",
  "created_at",
] as const satisfies ReadonlyArray<keyof AgentToolApprovalEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_context_policies
// Source: 20260728000000_agent_memory_context_layer.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentContextPolicyRow = {
  id: string;                              // uuid
  workspace_id: string;                    // uuid references workspaces
  policy_key: string;                      // text not null
  display_name: string;                    // text not null
  description: string | null;             // text
  allowed_scope_types_json: unknown;       // jsonb
  allowed_memory_kinds_json: unknown;      // jsonb
  max_sensitivity: string;                 // text not null
  default_retention_policy: string;        // text not null
  default_retention_days: number | null;  // integer
  allow_cross_project_memory: boolean;    // boolean not null
  allow_cross_pm_memory: boolean;         // boolean not null
  allow_portfolio_memory: boolean;        // boolean not null
  allow_restricted_memory: boolean;       // boolean not null
  require_approval_for_confidential: boolean; // boolean not null
  require_approval_for_restricted: boolean;   // boolean not null
  hide_expired_memory: boolean;           // boolean not null
  status: string;                          // text not null
  created_by: string | null;              // uuid references auth.users
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const AGENT_CONTEXT_POLICY_COLUMNS = [
  "id",
  "workspace_id",
  "policy_key",
  "display_name",
  "description",
  "allowed_scope_types_json",
  "allowed_memory_kinds_json",
  "max_sensitivity",
  "default_retention_policy",
  "default_retention_days",
  "allow_cross_project_memory",
  "allow_cross_pm_memory",
  "allow_portfolio_memory",
  "allow_restricted_memory",
  "require_approval_for_confidential",
  "require_approval_for_restricted",
  "hide_expired_memory",
  "status",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AgentContextPolicyRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_memory_records
// Source: 20260728000000_agent_memory_context_layer.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentMemoryRecordRow = {
  id: string;                              // uuid
  workspace_id: string;                    // uuid references workspaces
  agent_id: string | null;                // uuid
  agent_type: string | null;              // text
  scope_type: string;                      // text not null
  scope_id: string | null;               // uuid
  memory_kind: string;                     // text not null
  title: string;                           // text not null
  content: string | null;                 // text
  summary: string | null;                 // text
  source_type: string;                     // text not null
  source_id: string | null;              // text
  source_uri: string | null;             // text
  provenance_json: unknown;               // jsonb
  sensitivity: string;                     // text not null
  retention_policy: string;               // text not null
  retention_days: number | null;         // integer
  status: string;                          // text not null
  expires_at: string | null;             // timestamptz
  stale_at: string | null;              // timestamptz
  last_accessed_at: string | null;       // timestamptz
  last_refreshed_at: string | null;      // timestamptz
  access_count: number;                    // integer not null
  created_by: string | null;             // uuid references auth.users
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const AGENT_MEMORY_RECORD_COLUMNS = [
  "id",
  "workspace_id",
  "agent_id",
  "agent_type",
  "scope_type",
  "scope_id",
  "memory_kind",
  "title",
  "content",
  "summary",
  "source_type",
  "source_id",
  "source_uri",
  "provenance_json",
  "sensitivity",
  "retention_policy",
  "retention_days",
  "status",
  "expires_at",
  "stale_at",
  "last_accessed_at",
  "last_refreshed_at",
  "access_count",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AgentMemoryRecordRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_memory_events
// Source: 20260728000000_agent_memory_context_layer.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentMemoryEventRow = {
  id: string;                              // uuid
  workspace_id: string;                    // uuid references workspaces
  memory_id: string | null;              // uuid references agent_memory_records
  event_type: string;                      // text not null
  actor_id: string | null;               // uuid references auth.users
  event_payload_json: unknown;            // jsonb
  created_at: string;                      // timestamptz
};

export const AGENT_MEMORY_EVENT_COLUMNS = [
  "id",
  "workspace_id",
  "memory_id",
  "event_type",
  "actor_id",
  "event_payload_json",
  "created_at",
] as const satisfies ReadonlyArray<keyof AgentMemoryEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_context_windows
// Source: 20260728000000_agent_memory_context_layer.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentContextWindowRow = {
  id: string;                              // uuid
  workspace_id: string;                    // uuid references workspaces
  agent_id: string | null;               // uuid
  agent_type: string | null;             // text
  scope_type: string;                      // text not null
  scope_id: string | null;              // uuid
  window_key: string;                      // text not null
  display_name: string;                    // text not null
  description: string | null;            // text
  allowed_memory_kinds_json: unknown;     // jsonb
  max_sensitivity: string;                // text not null
  retention_policy: string;               // text not null
  status: string;                          // text not null
  created_by: string | null;            // uuid references auth.users
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const AGENT_CONTEXT_WINDOW_COLUMNS = [
  "id",
  "workspace_id",
  "agent_id",
  "agent_type",
  "scope_type",
  "scope_id",
  "window_key",
  "display_name",
  "description",
  "allowed_memory_kinds_json",
  "max_sensitivity",
  "retention_policy",
  "status",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AgentContextWindowRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_audit_events
// Source: 20260729000000_agent_observability_audit_trail.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentAuditEventRow = {
  id: string;                              // uuid
  workspace_id: string;                    // uuid references workspaces
  correlation_id: string | null;          // text
  category: string;                        // text not null
  event_type: string;                      // text not null
  severity: string;                        // text not null
  outcome: string;                         // text not null
  source_type: string;                     // text not null
  scope_type: string;                      // text not null
  scope_id: string | null;               // uuid
  agent_id: string | null;               // uuid
  agent_type: string | null;             // text
  actor_id: string | null;               // uuid references auth.users
  project_id: string | null;             // uuid
  pm_id: string | null;                  // uuid
  portfolio_id: string | null;           // uuid
  tool_key: string | null;               // text
  tool_request_id: string | null;        // uuid
  approval_request_id: string | null;    // uuid
  memory_id: string | null;              // uuid
  context_policy_id: string | null;      // uuid
  report_id: string | null;              // uuid
  title: string;                           // text not null
  message: string | null;                // text
  reason_code: string | null;            // text
  payload_json: unknown;                  // jsonb
  redacted_payload_json: unknown;         // jsonb
  evidence_refs_json: unknown;            // jsonb
  occurred_at: string;                     // timestamptz
  created_at: string;                      // timestamptz
};

export const AGENT_AUDIT_EVENT_COLUMNS = [
  "id",
  "workspace_id",
  "correlation_id",
  "category",
  "event_type",
  "severity",
  "outcome",
  "source_type",
  "scope_type",
  "scope_id",
  "agent_id",
  "agent_type",
  "actor_id",
  "project_id",
  "pm_id",
  "portfolio_id",
  "tool_key",
  "tool_request_id",
  "approval_request_id",
  "memory_id",
  "context_policy_id",
  "report_id",
  "title",
  "message",
  "reason_code",
  "payload_json",
  "redacted_payload_json",
  "evidence_refs_json",
  "occurred_at",
  "created_at",
] as const satisfies ReadonlyArray<keyof AgentAuditEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_decision_events
// Source: 20260729000000_agent_observability_audit_trail.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentDecisionEventRow = {
  id: string;                              // uuid
  workspace_id: string;                    // uuid references workspaces
  audit_event_id: string | null;         // uuid references agent_audit_events
  correlation_id: string | null;          // text
  agent_id: string | null;               // uuid
  agent_type: string | null;             // text
  decision_type: string;                   // text not null
  status: string;                          // text not null
  scope_type: string;                      // text not null
  scope_id: string | null;               // uuid
  project_id: string | null;             // uuid
  pm_id: string | null;                  // uuid
  portfolio_id: string | null;           // uuid
  title: string;                           // text not null
  summary: string | null;                // text
  rationale: string | null;              // text
  confidence_score: number | null;       // numeric
  risk_level: string | null;             // text
  evidence_refs_json: unknown;            // jsonb
  decision_payload_json: unknown;         // jsonb
  created_by: string | null;             // uuid references auth.users
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const AGENT_DECISION_EVENT_COLUMNS = [
  "id",
  "workspace_id",
  "audit_event_id",
  "correlation_id",
  "agent_id",
  "agent_type",
  "decision_type",
  "status",
  "scope_type",
  "scope_id",
  "project_id",
  "pm_id",
  "portfolio_id",
  "title",
  "summary",
  "rationale",
  "confidence_score",
  "risk_level",
  "evidence_refs_json",
  "decision_payload_json",
  "created_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AgentDecisionEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_audit_exports
// Source: 20260729000000_agent_observability_audit_trail.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentAuditExportRow = {
  id: string;                              // uuid
  workspace_id: string;                    // uuid references workspaces
  export_format: string;                   // text not null
  filter_payload_json: unknown;           // jsonb
  artifact_title: string;                  // text not null
  artifact_content: string;               // text not null
  artifact_metadata_json: unknown;        // jsonb
  created_by: string | null;             // uuid references auth.users
  created_at: string;                      // timestamptz
};

export const AGENT_AUDIT_EXPORT_COLUMNS = [
  "id",
  "workspace_id",
  "export_format",
  "filter_payload_json",
  "artifact_title",
  "artifact_content",
  "artifact_metadata_json",
  "created_by",
  "created_at",
] as const satisfies ReadonlyArray<keyof AgentAuditExportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_requests
// Source: 20260730000000_agent_execution_request_runtime.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionRequestRow = {
  id: string;                              // uuid
  workspace_id: string;                    // uuid references workspaces
  correlation_id: string | null;           // text
  agent_id: string | null;                 // uuid
  agent_type: string | null;               // text
  tool_key: string;                        // text not null
  execution_mode: string;                  // text not null
  execution_state: string;                 // text not null default 'draft'
  risk_level: string;                      // text not null default 'medium'
  scope_type: string;                      // text not null
  scope_id: string | null;                 // uuid
  source_type: string;                     // text not null
  source_id: string | null;                // uuid
  title: string;                           // text not null
  description: string | null;              // text
  input_payload_json: unknown;             // jsonb
  safe_input_payload_json: unknown;        // jsonb
  preflight_status: string;                // text not null default 'not_started'
  preflight_result_json: unknown;          // jsonb
  requires_approval: boolean;              // boolean not null default false
  approval_request_id: string | null;      // uuid
  memory_ids_json: unknown;                // jsonb not null default '[]'
  evidence_refs_json: unknown;             // jsonb not null default '[]'
  result_payload_json: unknown;            // jsonb
  error_code: string | null;              // text
  error_message: string | null;           // text
  requested_by: string | null;            // uuid references auth.users
  approved_by: string | null;             // uuid references auth.users
  approved_at: string | null;             // timestamptz
  expires_at: string | null;              // timestamptz
  created_at: string;                      // timestamptz
  updated_at: string;                      // timestamptz
};

export const AGENT_EXECUTION_REQUEST_COLUMNS = [
  "id",
  "workspace_id",
  "correlation_id",
  "agent_id",
  "agent_type",
  "tool_key",
  "execution_mode",
  "execution_state",
  "risk_level",
  "scope_type",
  "scope_id",
  "source_type",
  "source_id",
  "title",
  "description",
  "input_payload_json",
  "safe_input_payload_json",
  "preflight_status",
  "preflight_result_json",
  "requires_approval",
  "approval_request_id",
  "memory_ids_json",
  "evidence_refs_json",
  "result_payload_json",
  "error_code",
  "error_message",
  "requested_by",
  "approved_by",
  "approved_at",
  "expires_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionRequestRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_events
// Source: 20260730000000_agent_execution_request_runtime.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionEventRow = {
  id: string;                              // uuid
  workspace_id: string;                    // uuid references workspaces
  execution_request_id: string;            // uuid references agent_execution_requests
  event_type: string;                      // text not null
  from_state: string | null;               // text
  to_state: string | null;                 // text
  actor_id: string | null;                 // uuid references auth.users
  message: string | null;                  // text
  event_payload_json: unknown;             // jsonb
  created_at: string;                      // timestamptz
};

export const AGENT_EXECUTION_EVENT_COLUMNS = [
  "id",
  "workspace_id",
  "execution_request_id",
  "event_type",
  "from_state",
  "to_state",
  "actor_id",
  "message",
  "event_payload_json",
  "created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionEventRow>;

// agent_tool_adapter_executions
// Source: 20260731000000_agent_tool_execution_adapter_layer.sql

export type AgentToolAdapterExecutionRow = {
  id: string;
  workspace_id: string;
  execution_request_id: string;
  adapter_key: string;
  tool_key: string;
  execution_mode: string;
  execution_status: string;
  output_type: string;
  input_snapshot_json: Record<string, unknown> | null;
  safe_input_snapshot_json: Record<string, unknown> | null;
  output_payload_json: Record<string, unknown> | null;
  evidence_refs_json: unknown[];
  warnings_json: unknown[];
  refusal_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  actor_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_TOOL_ADAPTER_EXECUTION_COLUMNS = [
  "id", "workspace_id", "execution_request_id", "adapter_key", "tool_key",
  "execution_mode", "execution_status", "output_type", "input_snapshot_json",
  "safe_input_snapshot_json", "output_payload_json", "evidence_refs_json",
  "warnings_json", "refusal_reason", "error_code", "error_message", "actor_id",
  "started_at", "completed_at", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentToolAdapterExecutionRow>;

// agent_tool_adapter_execution_events
// Source: 20260731000000_agent_tool_execution_adapter_layer.sql

export type AgentToolAdapterExecutionEventRow = {
  id: string;
  workspace_id: string;
  adapter_execution_id: string;
  execution_request_id: string;
  event_type: string;
  message: string | null;
  event_payload_json: Record<string, unknown> | null;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_TOOL_ADAPTER_EXECUTION_EVENT_COLUMNS = [
  "id", "workspace_id", "adapter_execution_id", "execution_request_id",
  "event_type", "message", "event_payload_json", "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentToolAdapterExecutionEventRow>;

// agent_execution_results
// Source: 20260801000000_agent_execution_results_evidence_layer.sql

export type AgentExecutionResultRow = {
  id: string;
  workspace_id: string;
  execution_request_id: string;
  adapter_execution_id: string | null;
  agent_id: string | null;
  agent_type: string | null;
  tool_key: string;
  adapter_key: string | null;
  execution_mode: string;
  scope_type: string;
  scope_id: string | null;
  result_type: string;
  result_status: string;
  review_state: string;
  title: string;
  summary: string | null;
  result_payload_json: Record<string, unknown> | null;
  safe_result_payload_json: Record<string, unknown> | null;
  artifact_type: string;
  artifact_metadata_json: Record<string, unknown> | null;
  confidence_score: number;
  confidence_level: string;
  confidence_reasons_json: unknown[];
  evidence_ids_json: unknown[];
  lineage_refs_json: unknown[];
  retention_policy: string;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_RESULT_COLUMNS = [
  "id", "workspace_id", "execution_request_id", "adapter_execution_id",
  "agent_id", "agent_type", "tool_key", "adapter_key", "execution_mode",
  "scope_type", "scope_id", "result_type", "result_status", "review_state",
  "title", "summary", "result_payload_json", "safe_result_payload_json",
  "artifact_type", "artifact_metadata_json", "confidence_score", "confidence_level",
  "confidence_reasons_json", "evidence_ids_json", "lineage_refs_json",
  "retention_policy", "expires_at", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionResultRow>;

// agent_execution_evidence_items
// Source: 20260801000000_agent_execution_results_evidence_layer.sql

export type AgentExecutionEvidenceItemRow = {
  id: string;
  workspace_id: string;
  result_id: string | null;
  execution_request_id: string | null;
  adapter_execution_id: string | null;
  evidence_type: string;
  evidence_source: string;
  scope_type: string | null;
  scope_id: string | null;
  title: string;
  summary: string | null;
  evidence_payload_json: Record<string, unknown> | null;
  safe_evidence_payload_json: Record<string, unknown> | null;
  evidence_ref: string | null;
  evidence_hash: string | null;
  confidence_weight: number;
  retention_policy: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_EVIDENCE_ITEM_COLUMNS = [
  "id", "workspace_id", "result_id", "execution_request_id", "adapter_execution_id",
  "evidence_type", "evidence_source", "scope_type", "scope_id", "title", "summary",
  "evidence_payload_json", "safe_evidence_payload_json", "evidence_ref", "evidence_hash",
  "confidence_weight", "retention_policy", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionEvidenceItemRow>;

// agent_execution_result_lineage
// Source: 20260801000000_agent_execution_results_evidence_layer.sql

export type AgentExecutionResultLineageRow = {
  id: string;
  workspace_id: string;
  result_id: string;
  lineage_type: string;
  lineage_ref: string;
  lineage_payload_json: Record<string, unknown> | null;
  created_at: string;
};

export const AGENT_EXECUTION_RESULT_LINEAGE_COLUMNS = [
  "id", "workspace_id", "result_id", "lineage_type", "lineage_ref",
  "lineage_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionResultLineageRow>;

// agent_execution_result_events
// Source: 20260801000000_agent_execution_results_evidence_layer.sql

export type AgentExecutionResultEventRow = {
  id: string;
  workspace_id: string;
  result_id: string | null;
  evidence_id: string | null;
  event_type: string;
  message: string | null;
  event_payload_json: Record<string, unknown> | null;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_EXECUTION_RESULT_EVENT_COLUMNS = [
  "id", "workspace_id", "result_id", "evidence_id", "event_type",
  "message", "event_payload_json", "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionResultEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_review_queues
// Source: 20260802000000_agent_human_review_action_inbox.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentReviewQueueRow = {
  id: string;
  workspace_id: string;
  queue_key: string;
  queue_type: string;
  queue_status: string;
  name: string;
  description: string | null;
  default_assignee_id: string | null;
  visibility: string;
  metadata_json: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_REVIEW_QUEUE_COLUMNS = [
  "id", "workspace_id", "queue_key", "queue_type", "queue_status", "name",
  "description", "default_assignee_id", "visibility", "metadata_json",
  "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentReviewQueueRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_review_items
// Source: 20260802000000_agent_human_review_action_inbox.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentReviewItemRow = {
  id: string;
  workspace_id: string;
  queue_id: string;
  source_type: string;
  source_id: string | null;
  item_status: string;
  priority: string;
  risk_level: string;
  title: string;
  summary: string | null;
  confidence_score: number;
  assigned_to: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  due_at: string | null;
  tags: string[];
  payload_json: Record<string, unknown> | null;
  safe_payload_json: Record<string, unknown> | null;
  visibility: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_REVIEW_ITEM_COLUMNS = [
  "id", "workspace_id", "queue_id", "source_type", "source_id", "item_status",
  "priority", "risk_level", "title", "summary", "confidence_score", "assigned_to",
  "reviewed_by", "reviewed_at", "due_at", "tags", "payload_json", "safe_payload_json",
  "visibility", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentReviewItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_review_assignments
// Source: 20260802000000_agent_human_review_action_inbox.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentReviewAssignmentRow = {
  id: string;
  workspace_id: string;
  review_item_id: string;
  assigned_to: string;
  assigned_by: string | null;
  assignment_status: string;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_REVIEW_ASSIGNMENT_COLUMNS = [
  "id", "workspace_id", "review_item_id", "assigned_to", "assigned_by",
  "assignment_status", "note", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentReviewAssignmentRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_review_decisions
// Source: 20260802000000_agent_human_review_action_inbox.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentReviewDecisionRow = {
  id: string;
  workspace_id: string;
  review_item_id: string;
  decision_type: string;
  decided_by: string | null;
  rationale: string | null;
  payload_json: Record<string, unknown> | null;
  created_at: string;
};

export const AGENT_REVIEW_DECISION_COLUMNS = [
  "id", "workspace_id", "review_item_id", "decision_type", "decided_by",
  "rationale", "payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentReviewDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_review_action_drafts
// Source: 20260802000000_agent_human_review_action_inbox.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentReviewActionDraftRow = {
  id: string;
  workspace_id: string;
  review_item_id: string | null;
  draft_type: string;
  draft_status: string;
  title: string;
  summary: string | null;
  draft_payload_json: Record<string, unknown> | null;
  safe_draft_payload_json: Record<string, unknown> | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_REVIEW_ACTION_DRAFT_COLUMNS = [
  "id", "workspace_id", "review_item_id", "draft_type", "draft_status", "title",
  "summary", "draft_payload_json", "safe_draft_payload_json", "created_by",
  "approved_by", "approved_at", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentReviewActionDraftRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_review_events
// Source: 20260802000000_agent_human_review_action_inbox.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentReviewEventRow = {
  id: string;
  workspace_id: string;
  review_item_id: string | null;
  queue_id: string | null;
  action_draft_id: string | null;
  event_type: string;
  actor_id: string | null;
  payload_json: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
};

export const AGENT_REVIEW_EVENT_COLUMNS = [
  "id", "workspace_id", "review_item_id", "queue_id", "action_draft_id",
  "event_type", "actor_id", "payload_json", "occurred_at", "created_at",
] as const satisfies ReadonlyArray<keyof AgentReviewEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_action_conversions
// Source: 20260803000000_agent_controlled_action_conversion_approval_bridge.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentActionConversionRow = {
  id: string;
  workspace_id: string;
  action_draft_id: string;
  review_item_id: string | null;
  review_decision_id: string | null;
  source_result_id: string | null;
  source_evidence_id: string | null;
  execution_request_id: string | null;
  approval_bridge_id: string | null;
  action_type: string;
  status: string;
  readiness: string;
  risk_level: string;
  target_scope_type: string | null;
  target_scope_id: string | null;
  owner_id: string | null;
  owner_role: string | null;
  approval_requirement: string;
  execution_request_creation_status: string;
  blocking_reasons_json: string[];
  warnings_json: string[];
  conversion_payload_json: Record<string, unknown> | null;
  safe_conversion_payload_json: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_ACTION_CONVERSION_COLUMNS = [
  "id", "workspace_id", "action_draft_id", "review_item_id", "review_decision_id",
  "source_result_id", "source_evidence_id", "execution_request_id", "approval_bridge_id",
  "action_type", "status", "readiness", "risk_level", "target_scope_type", "target_scope_id",
  "owner_id", "owner_role", "approval_requirement", "execution_request_creation_status",
  "blocking_reasons_json", "warnings_json", "conversion_payload_json", "safe_conversion_payload_json",
  "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentActionConversionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_action_conversion_preflights
// Source: 20260803000000_agent_controlled_action_conversion_approval_bridge.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentActionConversionPreflightRow = {
  id: string;
  workspace_id: string;
  conversion_id: string;
  status: string;
  readiness_score: number;
  checks_json: Record<string, unknown>[];
  blocking_reasons_json: string[];
  warnings_json: string[];
  approval_required: boolean;
  approval_requirement: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_ACTION_CONVERSION_PREFLIGHT_COLUMNS = [
  "id", "workspace_id", "conversion_id", "status", "readiness_score",
  "checks_json", "blocking_reasons_json", "warnings_json", "approval_required",
  "approval_requirement", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentActionConversionPreflightRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_action_approval_bridges
// Source: 20260803000000_agent_controlled_action_conversion_approval_bridge.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentActionApprovalBridgeRow = {
  id: string;
  workspace_id: string;
  conversion_id: string;
  action_draft_id: string;
  approval_requirement: string;
  status: string;
  approval_policy_key: string | null;
  required_approver_role: string | null;
  required_approver_user_id: string | null;
  approval_request_id: string | null;
  approval_reason: string;
  risk_justification: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_ACTION_APPROVAL_BRIDGE_COLUMNS = [
  "id", "workspace_id", "conversion_id", "action_draft_id", "approval_requirement",
  "status", "approval_policy_key", "required_approver_role", "required_approver_user_id",
  "approval_request_id", "approval_reason", "risk_justification",
  "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentActionApprovalBridgeRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_action_conversion_events
// Source: 20260803000000_agent_controlled_action_conversion_approval_bridge.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentActionConversionEventRow = {
  id: string;
  workspace_id: string;
  conversion_id: string | null;
  action_draft_id: string | null;
  approval_bridge_id: string | null;
  execution_request_id: string | null;
  event_type: string;
  message: string | null;
  event_payload_json: Record<string, unknown> | null;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_ACTION_CONVERSION_EVENT_COLUMNS = [
  "id", "workspace_id", "conversion_id", "action_draft_id", "approval_bridge_id",
  "execution_request_id", "event_type", "message", "event_payload_json",
  "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentActionConversionEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_finalizations
// Source: 20260804000000_agent_controlled_execution_finalization_adapter_dispatch_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionFinalizationRow = {
  id: string;
  workspace_id: string;
  execution_request_id: string;
  action_conversion_id: string | null;
  action_draft_id: string | null;
  review_item_id: string | null;
  source_result_id: string | null;
  source_evidence_id: string | null;
  status: string;
  readiness: string;
  execution_mode: string;
  risk_level: string;
  selected_tool_key: string | null;
  selected_adapter_key: string | null;
  side_effect_mode: string;
  confirmation_requirement: string;
  confirmation_status: string;
  approval_verified: boolean;
  lock_status: string;
  idempotency_status: string;
  dispatch_gate_id: string | null;
  latest_dispatch_attempt_id: string | null;
  adapter_execution_id: string | null;
  result_id: string | null;
  evidence_ids_json: unknown[];
  blocking_reasons_json: string[];
  warnings_json: string[];
  finalization_payload_json: Record<string, unknown> | null;
  safe_finalization_payload_json: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_FINALIZATION_COLUMNS = [
  "id", "workspace_id", "execution_request_id", "action_conversion_id", "action_draft_id",
  "review_item_id", "source_result_id", "source_evidence_id", "status", "readiness",
  "execution_mode", "risk_level", "selected_tool_key", "selected_adapter_key", "side_effect_mode",
  "confirmation_requirement", "confirmation_status", "approval_verified", "lock_status",
  "idempotency_status", "dispatch_gate_id", "latest_dispatch_attempt_id", "adapter_execution_id",
  "result_id", "evidence_ids_json", "blocking_reasons_json", "warnings_json",
  "finalization_payload_json", "safe_finalization_payload_json",
  "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionFinalizationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_dispatch_gates
// Source: 20260804000000_agent_controlled_execution_finalization_adapter_dispatch_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionDispatchGateRow = {
  id: string;
  workspace_id: string;
  finalization_id: string;
  execution_request_id: string;
  status: string;
  selected_tool_key: string | null;
  selected_adapter_key: string | null;
  execution_mode: string;
  side_effect_mode: string;
  dispatch_allowed: boolean;
  requires_final_confirmation: boolean;
  confirmation_status: string;
  lock_id: string | null;
  idempotency_id: string | null;
  blocking_reasons_json: string[];
  warnings_json: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_DISPATCH_GATE_COLUMNS = [
  "id", "workspace_id", "finalization_id", "execution_request_id", "status",
  "selected_tool_key", "selected_adapter_key", "execution_mode", "side_effect_mode",
  "dispatch_allowed", "requires_final_confirmation", "confirmation_status",
  "lock_id", "idempotency_id", "blocking_reasons_json", "warnings_json",
  "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionDispatchGateRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_dispatch_locks
// Source: 20260804000000_agent_controlled_execution_finalization_adapter_dispatch_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionDispatchLockRow = {
  id: string;
  workspace_id: string;
  execution_request_id: string;
  finalization_id: string | null;
  lock_key: string;
  status: string;
  acquired_by: string | null;
  acquired_at: string | null;
  expires_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_DISPATCH_LOCK_COLUMNS = [
  "id", "workspace_id", "execution_request_id", "finalization_id", "lock_key",
  "status", "acquired_by", "acquired_at", "expires_at", "released_at", "release_reason",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionDispatchLockRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_dispatch_idempotency
// Source: 20260804000000_agent_controlled_execution_finalization_adapter_dispatch_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionDispatchIdempotencyRow = {
  id: string;
  workspace_id: string;
  execution_request_id: string;
  finalization_id: string | null;
  idempotency_key: string;
  idempotency_fingerprint: string;
  status: string;
  first_dispatch_attempt_id: string | null;
  latest_dispatch_attempt_id: string | null;
  result_id: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_DISPATCH_IDEMPOTENCY_COLUMNS = [
  "id", "workspace_id", "execution_request_id", "finalization_id",
  "idempotency_key", "idempotency_fingerprint", "status",
  "first_dispatch_attempt_id", "latest_dispatch_attempt_id", "result_id",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionDispatchIdempotencyRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_dispatch_attempts
// Source: 20260804000000_agent_controlled_execution_finalization_adapter_dispatch_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionDispatchAttemptRow = {
  id: string;
  workspace_id: string;
  finalization_id: string;
  dispatch_gate_id: string | null;
  execution_request_id: string;
  adapter_key: string | null;
  tool_key: string | null;
  execution_mode: string;
  status: string;
  attempt_number: number;
  started_at: string | null;
  completed_at: string | null;
  adapter_execution_id: string | null;
  result_id: string | null;
  evidence_ids_json: unknown[];
  error_message: string | null;
  blocking_reasons_json: string[];
  warnings_json: string[];
  actor_id: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_DISPATCH_ATTEMPT_COLUMNS = [
  "id", "workspace_id", "finalization_id", "dispatch_gate_id", "execution_request_id",
  "adapter_key", "tool_key", "execution_mode", "status", "attempt_number",
  "started_at", "completed_at", "adapter_execution_id", "result_id",
  "evidence_ids_json", "error_message", "blocking_reasons_json", "warnings_json",
  "actor_id", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionDispatchAttemptRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_final_confirmations
// Source: 20260804000000_agent_controlled_execution_finalization_adapter_dispatch_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionFinalConfirmationRow = {
  id: string;
  workspace_id: string;
  finalization_id: string;
  execution_request_id: string;
  requirement: string;
  status: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  rationale: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_FINAL_CONFIRMATION_COLUMNS = [
  "id", "workspace_id", "finalization_id", "execution_request_id",
  "requirement", "status", "confirmed_by", "confirmed_at", "rationale",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionFinalConfirmationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_dispatch_events
// Source: 20260804000000_agent_controlled_execution_finalization_adapter_dispatch_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionDispatchEventRow = {
  id: string;
  workspace_id: string;
  finalization_id: string | null;
  dispatch_gate_id: string | null;
  dispatch_attempt_id: string | null;
  execution_request_id: string | null;
  adapter_execution_id: string | null;
  result_id: string | null;
  event_type: string;
  message: string | null;
  event_payload_json: Record<string, unknown> | null;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_EXECUTION_DISPATCH_EVENT_COLUMNS = [
  "id", "workspace_id", "finalization_id", "dispatch_gate_id", "dispatch_attempt_id",
  "execution_request_id", "adapter_execution_id", "result_id", "event_type",
  "message", "event_payload_json", "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionDispatchEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_outcomes
// Source: 20260805000000_agent_controlled_execution_result_reconciliation_human_outcome_review.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionOutcomeRow = {
  id: string;
  workspace_id: string;
  execution_request_id: string;
  finalization_id: string | null;
  dispatch_attempt_id: string | null;
  dispatch_gate_id: string | null;
  adapter_execution_id: string | null;
  result_id: string | null;
  status: string;
  outcome_type: string;
  match_status: string;
  evidence_completeness_level: string;
  confidence_score: number;
  confidence_level: string;
  review_requirement: string;
  review_status: string;
  intended_outcome_summary: string | null;
  actual_outcome_summary: string | null;
  mismatch_reasons_json: unknown[];
  blocking_reasons_json: unknown[];
  warnings_json: unknown[];
  outcome_payload_json: Record<string, unknown> | null;
  safe_outcome_payload_json: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_OUTCOME_COLUMNS = [
  "id", "workspace_id", "execution_request_id", "finalization_id", "dispatch_attempt_id",
  "dispatch_gate_id", "adapter_execution_id", "result_id", "status", "outcome_type",
  "match_status", "evidence_completeness_level", "confidence_score", "confidence_level",
  "review_requirement", "review_status", "intended_outcome_summary", "actual_outcome_summary",
  "mismatch_reasons_json", "blocking_reasons_json", "warnings_json",
  "outcome_payload_json", "safe_outcome_payload_json", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionOutcomeRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_outcome_reconciliations
// Source: 20260805000000_agent_controlled_execution_result_reconciliation_human_outcome_review.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionOutcomeReconciliationRow = {
  id: string;
  workspace_id: string;
  outcome_id: string;
  execution_request_id: string;
  finalization_id: string | null;
  dispatch_attempt_id: string | null;
  dispatch_succeeded: boolean;
  adapter_execution_exists: boolean;
  result_exists: boolean;
  evidence_count: number;
  lineage_complete: boolean;
  reconciliation_notes_json: unknown[];
  reconciliation_payload_json: Record<string, unknown> | null;
  reconciled_at: string;
  created_at: string;
};

export const AGENT_EXECUTION_OUTCOME_RECONCILIATION_COLUMNS = [
  "id", "workspace_id", "outcome_id", "execution_request_id", "finalization_id",
  "dispatch_attempt_id", "dispatch_succeeded", "adapter_execution_exists", "result_exists",
  "evidence_count", "lineage_complete", "reconciliation_notes_json",
  "reconciliation_payload_json", "reconciled_at", "created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionOutcomeReconciliationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_outcome_comparisons
// Source: 20260805000000_agent_controlled_execution_result_reconciliation_human_outcome_review.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionOutcomeComparisonRow = {
  id: string;
  workspace_id: string;
  outcome_id: string;
  execution_request_id: string;
  match_status: string;
  intended_outcome_summary: string | null;
  actual_outcome_summary: string | null;
  mismatch_reasons_json: unknown[];
  confidence_impact: number;
  requires_correction: boolean;
  compared_at: string;
  created_at: string;
};

export const AGENT_EXECUTION_OUTCOME_COMPARISON_COLUMNS = [
  "id", "workspace_id", "outcome_id", "execution_request_id", "match_status",
  "intended_outcome_summary", "actual_outcome_summary", "mismatch_reasons_json",
  "confidence_impact", "requires_correction", "compared_at", "created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionOutcomeComparisonRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_evidence_completeness
// Source: 20260805000000_agent_controlled_execution_result_reconciliation_human_outcome_review.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionEvidenceCompletenessRow = {
  id: string;
  workspace_id: string;
  outcome_id: string;
  execution_request_id: string;
  completeness_score: number;
  level: string;
  present_types_json: unknown[];
  missing_types_json: unknown[];
  blocking_gaps_json: unknown[];
  warnings_json: unknown[];
  scored_at: string;
  created_at: string;
};

export const AGENT_EXECUTION_EVIDENCE_COMPLETENESS_COLUMNS = [
  "id", "workspace_id", "outcome_id", "execution_request_id", "completeness_score",
  "level", "present_types_json", "missing_types_json", "blocking_gaps_json",
  "warnings_json", "scored_at", "created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionEvidenceCompletenessRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_outcome_confidence
// Source: 20260805000000_agent_controlled_execution_result_reconciliation_human_outcome_review.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionOutcomeConfidenceRow = {
  id: string;
  workspace_id: string;
  outcome_id: string;
  execution_request_id: string;
  confidence_score: number;
  confidence_level: string;
  confidence_reasons_json: unknown[];
  scored_at: string;
  created_at: string;
};

export const AGENT_EXECUTION_OUTCOME_CONFIDENCE_COLUMNS = [
  "id", "workspace_id", "outcome_id", "execution_request_id", "confidence_score",
  "confidence_level", "confidence_reasons_json", "scored_at", "created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionOutcomeConfidenceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_human_outcome_reviews
// Source: 20260805000000_agent_controlled_execution_result_reconciliation_human_outcome_review.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionHumanOutcomeReviewRow = {
  id: string;
  workspace_id: string;
  outcome_id: string;
  execution_request_id: string;
  review_requirement: string;
  review_status: string;
  priority: string;
  title: string;
  summary: string | null;
  decided_by: string | null;
  decision_type: string | null;
  decision_rationale: string | null;
  decided_at: string | null;
  due_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_HUMAN_OUTCOME_REVIEW_COLUMNS = [
  "id", "workspace_id", "outcome_id", "execution_request_id", "review_requirement",
  "review_status", "priority", "title", "summary", "decided_by", "decision_type",
  "decision_rationale", "decided_at", "due_at", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionHumanOutcomeReviewRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_failed_dispatch_triage
// Source: 20260805000000_agent_controlled_execution_result_reconciliation_human_outcome_review.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionFailedDispatchTriageRow = {
  id: string;
  workspace_id: string;
  outcome_id: string;
  execution_request_id: string;
  finalization_id: string | null;
  dispatch_attempt_id: string | null;
  failure_category: string;
  failure_message: string | null;
  blocking_reasons_json: unknown[];
  triage_notes_json: unknown[];
  recommended_correction_type: string | null;
  triage_payload_json: Record<string, unknown> | null;
  triaged_at: string;
  created_at: string;
};

export const AGENT_EXECUTION_FAILED_DISPATCH_TRIAGE_COLUMNS = [
  "id", "workspace_id", "outcome_id", "execution_request_id", "finalization_id",
  "dispatch_attempt_id", "failure_category", "failure_message", "blocking_reasons_json",
  "triage_notes_json", "recommended_correction_type", "triage_payload_json",
  "triaged_at", "created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionFailedDispatchTriageRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_correction_loops
// Source: 20260805000000_agent_controlled_execution_result_reconciliation_human_outcome_review.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionCorrectionLoopRow = {
  id: string;
  workspace_id: string;
  outcome_id: string;
  execution_request_id: string;
  correction_type: string;
  correction_status: string;
  correction_rationale: string | null;
  applied_by: string | null;
  applied_at: string | null;
  correction_payload_json: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_CORRECTION_LOOP_COLUMNS = [
  "id", "workspace_id", "outcome_id", "execution_request_id", "correction_type",
  "correction_status", "correction_rationale", "applied_by", "applied_at",
  "correction_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionCorrectionLoopRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_outcome_events
// Source: 20260805000000_agent_controlled_execution_result_reconciliation_human_outcome_review.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionOutcomeEventRow = {
  id: string;
  workspace_id: string;
  outcome_id: string | null;
  execution_request_id: string | null;
  reconciliation_id: string | null;
  comparison_id: string | null;
  human_review_id: string | null;
  correction_loop_id: string | null;
  event_type: string;
  message: string | null;
  event_payload_json: Record<string, unknown> | null;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_EXECUTION_OUTCOME_EVENT_COLUMNS = [
  "id", "workspace_id", "outcome_id", "execution_request_id", "reconciliation_id",
  "comparison_id", "human_review_id", "correction_loop_id", "event_type",
  "message", "event_payload_json", "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionOutcomeEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_learning_signals
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionLearningSignalRow = {
  id: string;
  workspace_id: string;
  source_type: string;
  source_id: string;
  outcome_id: string | null;
  review_id: string | null;
  decision_id: string | null;
  dispatch_attempt_id: string | null;
  adapter_key: string | null;
  tool_key: string | null;
  action_type: string | null;
  signal_type: string;
  signal_category: string;
  signal_value: string;
  signal_weight: number;
  confidence_score: number;
  privacy_classification: string;
  retention_class: string;
  status: string;
  signal_payload_json: Record<string, unknown> | null;
  safe_signal_payload_json: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_LEARNING_SIGNAL_COLUMNS = [
  "id","workspace_id","source_type","source_id","outcome_id","review_id",
  "decision_id","dispatch_attempt_id","adapter_key","tool_key","action_type",
  "signal_type","signal_category","signal_value","signal_weight","confidence_score",
  "privacy_classification","retention_class","status","signal_payload_json",
  "safe_signal_payload_json","created_by","created_at","updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionLearningSignalRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_learning_extractions
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionLearningExtractionRow = {
  id: string;
  workspace_id: string;
  source_type: string;
  source_id: string;
  status: string;
  signals_extracted: number;
  signals_skipped: number;
  privacy_passed: number;
  privacy_blocked: number;
  blocking_reasons_json: string[];
  warnings_json: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_LEARNING_EXTRACTION_COLUMNS = [
  "id","workspace_id","source_type","source_id","status","signals_extracted",
  "signals_skipped","privacy_passed","privacy_blocked","blocking_reasons_json",
  "warnings_json","created_by","created_at","updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionLearningExtractionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_learning_privacy_filters
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionLearningPrivacyFilterRow = {
  id: string;
  workspace_id: string;
  source_type: string;
  source_id: string;
  candidate_signal_type: string;
  contains_raw_payload: boolean;
  contains_free_text: boolean;
  contains_sensitive_key: boolean;
  contains_customer_identifier: boolean;
  contains_project_identifier: boolean;
  safe_to_store: boolean;
  redaction_applied: boolean;
  privacy_classification: string;
  retention_class: string;
  filter_reasons_json: string[];
  created_at: string;
};

export const AGENT_EXECUTION_LEARNING_PRIVACY_FILTER_COLUMNS = [
  "id","workspace_id","source_type","source_id","candidate_signal_type",
  "contains_raw_payload","contains_free_text","contains_sensitive_key",
  "contains_customer_identifier","contains_project_identifier","safe_to_store",
  "redaction_applied","privacy_classification","retention_class",
  "filter_reasons_json","created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionLearningPrivacyFilterRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_governance_feedback
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionGovernanceFeedbackRow = {
  id: string;
  workspace_id: string;
  feedback_type: string;
  feedback_category: string;
  severity: string;
  status: string;
  recommendation: string;
  confidence_score: number;
  source_signal_ids_json: string[];
  owner_role: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_rationale: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_EXECUTION_GOVERNANCE_FEEDBACK_COLUMNS = [
  "id","workspace_id","feedback_type","feedback_category","severity","status",
  "recommendation","confidence_score","source_signal_ids_json","owner_role",
  "reviewed_by","reviewed_at","review_rationale","created_at","updated_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionGovernanceFeedbackRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_risk_calibration_signals
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionRiskCalibrationSignalRow = {
  id: string;
  workspace_id: string;
  source_signal_id: string | null;
  outcome_id: string | null;
  action_type: string | null;
  adapter_key: string | null;
  original_risk_level: string | null;
  observed_risk_level: string | null;
  human_decision_type: string | null;
  calibration_direction: string;
  confidence_score: number;
  created_at: string;
};

export const AGENT_EXECUTION_RISK_CALIBRATION_SIGNAL_COLUMNS = [
  "id","workspace_id","source_signal_id","outcome_id","action_type","adapter_key",
  "original_risk_level","observed_risk_level","human_decision_type",
  "calibration_direction","confidence_score","created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionRiskCalibrationSignalRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_evidence_quality_signals
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionEvidenceQualitySignalRow = {
  id: string;
  workspace_id: string;
  source_signal_id: string | null;
  action_type: string | null;
  adapter_key: string | null;
  required_evidence_type: string | null;
  available_evidence_type: string | null;
  missing_evidence_type: string | null;
  evidence_completeness_level: string | null;
  frequency: number;
  trend_direction: string;
  created_at: string;
};

export const AGENT_EXECUTION_EVIDENCE_QUALITY_SIGNAL_COLUMNS = [
  "id","workspace_id","source_signal_id","action_type","adapter_key",
  "required_evidence_type","available_evidence_type","missing_evidence_type",
  "evidence_completeness_level","frequency","trend_direction","created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionEvidenceQualitySignalRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_adapter_performance_signals
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionAdapterPerformanceSignalRow = {
  id: string;
  workspace_id: string;
  adapter_key: string;
  tool_key: string | null;
  success_count: number;
  failure_count: number;
  missing_evidence_count: number;
  correction_count: number;
  retry_recommendation_count: number;
  human_acceptance_count: number;
  human_rejection_count: number;
  low_confidence_count: number;
  medium_confidence_count: number;
  high_confidence_count: number;
  trend_direction: string;
  created_at: string;
};

export const AGENT_EXECUTION_ADAPTER_PERFORMANCE_SIGNAL_COLUMNS = [
  "id","workspace_id","adapter_key","tool_key","success_count","failure_count",
  "missing_evidence_count","correction_count","retry_recommendation_count",
  "human_acceptance_count","human_rejection_count","low_confidence_count",
  "medium_confidence_count","high_confidence_count","trend_direction","created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionAdapterPerformanceSignalRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_review_decision_patterns
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionReviewDecisionPatternRow = {
  id: string;
  workspace_id: string;
  decision_type: string;
  review_requirement: string | null;
  risk_level: string | null;
  action_type: string | null;
  adapter_key: string | null;
  confidence_level: string | null;
  evidence_completeness_level: string | null;
  count: number;
  trend_direction: string;
  created_at: string;
};

export const AGENT_EXECUTION_REVIEW_DECISION_PATTERN_COLUMNS = [
  "id","workspace_id","decision_type","review_requirement","risk_level",
  "action_type","adapter_key","confidence_level","evidence_completeness_level",
  "count","trend_direction","created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionReviewDecisionPatternRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_review_routing_feedback
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionReviewRoutingFeedbackRow = {
  id: string;
  workspace_id: string;
  assigned_role: string | null;
  assigned_to: string | null;
  review_priority: string | null;
  decision_type: string | null;
  route_effectiveness: string;
  suggested_route_adjustment: string | null;
  created_at: string;
};

export const AGENT_EXECUTION_REVIEW_ROUTING_FEEDBACK_COLUMNS = [
  "id","workspace_id","assigned_role","assigned_to","review_priority",
  "decision_type","route_effectiveness","suggested_route_adjustment","created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionReviewRoutingFeedbackRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_workspace_learning_summaries
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionWorkspaceLearningSummaryRow = {
  id: string;
  workspace_id: string;
  period_start: string;
  period_end: string;
  total_signals: number;
  governance_feedback_count: number;
  risk_calibration_count: number;
  evidence_quality_count: number;
  adapter_performance_count: number;
  review_pattern_count: number;
  top_signals_json: Record<string, unknown>;
  recommendations_json: Record<string, unknown>;
  confidence_score: number;
  created_at: string;
};

export const AGENT_EXECUTION_WORKSPACE_LEARNING_SUMMARY_COLUMNS = [
  "id","workspace_id","period_start","period_end","total_signals",
  "governance_feedback_count","risk_calibration_count","evidence_quality_count",
  "adapter_performance_count","review_pattern_count","top_signals_json",
  "recommendations_json","confidence_score","created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionWorkspaceLearningSummaryRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_aggregate_learning_signals
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionAggregateLearningSignalRow = {
  id: string;
  aggregate_scope: string;
  workspace_id: string | null;
  signal_type: string;
  signal_category: string;
  count: number;
  threshold_met: boolean;
  privacy_safe: boolean;
  created_at: string;
};

export const AGENT_EXECUTION_AGGREGATE_LEARNING_SIGNAL_COLUMNS = [
  "id","aggregate_scope","workspace_id","signal_type","signal_category",
  "count","threshold_met","privacy_safe","created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionAggregateLearningSignalRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_execution_learning_events
// Source: 20260806000000_agent_controlled_execution_learning_signals_governance_feedback_loop.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentExecutionLearningEventRow = {
  id: string;
  workspace_id: string | null;
  signal_id: string | null;
  extraction_id: string | null;
  feedback_id: string | null;
  source_type: string | null;
  source_id: string | null;
  event_type: string;
  message: string | null;
  event_payload_json: Record<string, unknown> | null;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_EXECUTION_LEARNING_EVENT_COLUMNS = [
  "id","workspace_id","signal_id","extraction_id","feedback_id",
  "source_type","source_id","event_type","message","event_payload_json",
  "actor_id","created_at",
] as const satisfies ReadonlyArray<keyof AgentExecutionLearningEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_governance_dashboard_snapshots
// Source: 20260807000000_agent_controlled_pmo_governance_intelligence_dashboard.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoGovernanceDashboardSnapshotRow = {
  id: string;
  workspace_id: string;
  status: string;
  total_signals: number;
  active_signals: number;
  governance_feedback_count: number;
  risk_calibration_count: number;
  evidence_quality_count: number;
  adapter_performance_count: number;
  review_routing_count: number;
  feedback_queue_pending_count: number;
  policy_proposal_draft_count: number;
  policy_proposal_under_review_count: number;
  report_export_count: number;
  snapshot_meta_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_GOVERNANCE_DASHBOARD_SNAPSHOT_COLUMNS = [
  "id","workspace_id","status","total_signals","active_signals",
  "governance_feedback_count","risk_calibration_count","evidence_quality_count",
  "adapter_performance_count","review_routing_count","feedback_queue_pending_count",
  "policy_proposal_draft_count","policy_proposal_under_review_count",
  "report_export_count","snapshot_meta_json","created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoGovernanceDashboardSnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_governance_insight_cards
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoGovernanceInsightCardRow = {
  id: string;
  workspace_id: string;
  snapshot_id: string | null;
  card_type: string;
  severity: string;
  status: string;
  actionability: string;
  trend_direction: string;
  title: string;
  metrics_json: Record<string, unknown>;
  source_ids_json: string[];
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_GOVERNANCE_INSIGHT_CARD_COLUMNS = [
  "id","workspace_id","snapshot_id","card_type","severity","status",
  "actionability","trend_direction","title","metrics_json","source_ids_json",
  "created_at","updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoGovernanceInsightCardRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_risk_calibration_insights
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRiskCalibrationInsightRow = {
  id: string;
  workspace_id: string;
  snapshot_id: string | null;
  total_risk_signals: number;
  underestimated_count: number;
  overestimated_count: number;
  aligned_count: number;
  unknown_count: number;
  trend_direction: string;
  severity: string;
  created_at: string;
};

export const AGENT_PMO_RISK_CALIBRATION_INSIGHT_COLUMNS = [
  "id","workspace_id","snapshot_id","total_risk_signals","underestimated_count",
  "overestimated_count","aligned_count","unknown_count","trend_direction","severity","created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRiskCalibrationInsightRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_evidence_quality_insights
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoEvidenceQualityInsightRow = {
  id: string;
  workspace_id: string;
  snapshot_id: string | null;
  total_evidence_signals: number;
  missing_count: number;
  complete_count: number;
  trend_direction: string;
  severity: string;
  created_at: string;
};

export const AGENT_PMO_EVIDENCE_QUALITY_INSIGHT_COLUMNS = [
  "id","workspace_id","snapshot_id","total_evidence_signals","missing_count",
  "complete_count","trend_direction","severity","created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoEvidenceQualityInsightRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_adapter_performance_insights
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoAdapterPerformanceInsightRow = {
  id: string;
  workspace_id: string;
  snapshot_id: string | null;
  adapter_key: string;
  success_count: number;
  failure_count: number;
  correction_count: number;
  trend_direction: string;
  severity: string;
  created_at: string;
};

export const AGENT_PMO_ADAPTER_PERFORMANCE_INSIGHT_COLUMNS = [
  "id","workspace_id","snapshot_id","adapter_key","success_count",
  "failure_count","correction_count","trend_direction","severity","created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoAdapterPerformanceInsightRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_review_routing_insights
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoReviewRoutingInsightRow = {
  id: string;
  workspace_id: string;
  snapshot_id: string | null;
  total_routing_signals: number;
  effective_count: number;
  ineffective_count: number;
  trend_direction: string;
  severity: string;
  created_at: string;
};

export const AGENT_PMO_REVIEW_ROUTING_INSIGHT_COLUMNS = [
  "id","workspace_id","snapshot_id","total_routing_signals","effective_count",
  "ineffective_count","trend_direction","severity","created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoReviewRoutingInsightRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_governance_feedback_queue
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoGovernanceFeedbackQueueRow = {
  id: string;
  workspace_id: string;
  feedback_id: string;
  feedback_type: string;
  feedback_category: string;
  feedback_severity: string;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_GOVERNANCE_FEEDBACK_QUEUE_COLUMNS = [
  "id","workspace_id","feedback_id","feedback_type","feedback_category",
  "feedback_severity","status","reviewed_by","reviewed_at","review_note",
  "created_at","updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoGovernanceFeedbackQueueRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_proposals
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyProposalRow = {
  id: string;
  workspace_id: string;
  proposal_type: string;
  status: string;
  title: string;
  rationale: string;
  source_type: string;
  source_ids_json: string[];
  proposed_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  decision: string | null;
  decision_note: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_PROPOSAL_COLUMNS = [
  "id","workspace_id","proposal_type","status","title","rationale",
  "source_type","source_ids_json","proposed_by","reviewed_by","reviewed_at",
  "decision","decision_note","created_at","updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyProposalRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_governance_report_exports
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoGovernanceReportExportRow = {
  id: string;
  workspace_id: string;
  snapshot_id: string | null;
  format: string;
  status: string;
  safe_report_json: Record<string, unknown> | null;
  blocked_reasons_json: string[];
  download_count: number;
  requested_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_GOVERNANCE_REPORT_EXPORT_COLUMNS = [
  "id","workspace_id","snapshot_id","format","status","safe_report_json",
  "blocked_reasons_json","download_count","requested_by","created_at","updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoGovernanceReportExportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_governance_dashboard_events
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoGovernanceDashboardEventRow = {
  id: string;
  workspace_id: string | null;
  snapshot_id: string | null;
  card_id: string | null;
  proposal_id: string | null;
  export_id: string | null;
  event_type: string;
  message: string | null;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_PMO_GOVERNANCE_DASHBOARD_EVENT_COLUMNS = [
  "id","workspace_id","snapshot_id","card_id","proposal_id","export_id",
  "event_type","message","actor_id","created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoGovernanceDashboardEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_backlog_items
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyBacklogItemRow = {
  id: string;
  workspace_id: string;
  source_proposal_id: string | null;
  item_type: string;
  item_category: string;
  priority: string;
  status: string;
  title: string;
  description: string;
  source_signal_count: number;
  source_feedback_ids_json: string[];
  source_signal_ids_json: string[];
  related_adapter_keys_json: string[];
  estimated_impact_level: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_BACKLOG_ITEM_COLUMNS = [
  "id", "workspace_id", "source_proposal_id", "item_type", "item_category",
  "priority", "status", "title", "description", "source_signal_count",
  "source_feedback_ids_json", "source_signal_ids_json", "related_adapter_keys_json",
  "estimated_impact_level", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyBacklogItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_change_requests
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyChangeRequestRow = {
  id: string;
  workspace_id: string;
  backlog_item_id: string;
  status: string;
  policy_area: string;
  change_summary: string;
  change_rationale: string;
  estimated_impact_level: string;
  simulation_count: number;
  approval_workflow_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_CHANGE_REQUEST_COLUMNS = [
  "id", "workspace_id", "backlog_item_id", "status", "policy_area",
  "change_summary", "change_rationale", "estimated_impact_level",
  "simulation_count", "approval_workflow_id", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyChangeRequestRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_change_scopes
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyChangeScopeRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  scope_type: string;
  scope_description: string;
  affected_policy_keys_json: string[];
  affected_adapter_keys_json: string[];
  estimated_records_affected: number;
  created_at: string;
};

export const AGENT_PMO_POLICY_CHANGE_SCOPE_COLUMNS = [
  "id", "workspace_id", "change_request_id", "scope_type", "scope_description",
  "affected_policy_keys_json", "affected_adapter_keys_json", "estimated_records_affected",
  "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyChangeScopeRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_simulations
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicySimulationRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  status: string;
  simulation_label: string;
  signal_count_used: number;
  estimated_affected_count: number;
  estimated_approval_rate_change: number;
  estimated_rejection_rate_change: number;
  estimated_review_volume_change: number;
  impact_level: string;
  safe_simulation_summary: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_SIMULATION_COLUMNS = [
  "id", "workspace_id", "change_request_id", "status", "simulation_label",
  "signal_count_used", "estimated_affected_count", "estimated_approval_rate_change",
  "estimated_rejection_rate_change", "estimated_review_volume_change", "impact_level",
  "safe_simulation_summary", "completed_at", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicySimulationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_impact_previews
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyImpactPreviewRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  simulation_id: string | null;
  impact_level: string;
  affected_area_count: number;
  estimated_signal_count: number;
  deterministic_summary: string;
  safe_impact_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_POLICY_IMPACT_PREVIEW_COLUMNS = [
  "id", "workspace_id", "change_request_id", "simulation_id", "impact_level",
  "affected_area_count", "estimated_signal_count", "deterministic_summary",
  "safe_impact_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyImpactPreviewRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_governance_policy_drafts
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoGovernancePolicyDraftRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  draft_type: string;
  draft_status: string;
  draft_version: number;
  draft_title: string;
  draft_summary: string;
  is_live_policy: boolean;
  approval_workflow_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_GOVERNANCE_POLICY_DRAFT_COLUMNS = [
  "id", "workspace_id", "change_request_id", "draft_type", "draft_status",
  "draft_version", "draft_title", "draft_summary", "is_live_policy",
  "approval_workflow_id", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoGovernancePolicyDraftRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_approval_workflows
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyApprovalWorkflowRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  current_stage: string;
  overall_status: string;
  required_stages_json: string[];
  completed_stages_json: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_APPROVAL_WORKFLOW_COLUMNS = [
  "id", "workspace_id", "change_request_id", "current_stage", "overall_status",
  "required_stages_json", "completed_stages_json", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyApprovalWorkflowRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_approval_decisions
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyApprovalDecisionRow = {
  id: string;
  workspace_id: string;
  workflow_id: string;
  stage: string;
  decision_type: string;
  status: string;
  decided_by: string | null;
  decision_note: string | null;
  created_at: string;
};

export const AGENT_PMO_POLICY_APPROVAL_DECISION_COLUMNS = [
  "id", "workspace_id", "workflow_id", "stage", "decision_type", "status",
  "decided_by", "decision_note", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyApprovalDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_implementation_readiness
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyImplementationReadinessRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  readiness_status: string;
  simulation_completed: boolean;
  approval_completed: boolean;
  rollback_plan_present: boolean;
  blocked_reasons_json: string[];
  evaluated_at: string;
  created_at: string;
};

export const AGENT_PMO_POLICY_IMPLEMENTATION_READINESS_COLUMNS = [
  "id", "workspace_id", "change_request_id", "readiness_status",
  "simulation_completed", "approval_completed", "rollback_plan_present",
  "blocked_reasons_json", "evaluated_at", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyImplementationReadinessRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_rollback_plans
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyRollbackPlanRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  plan_type: string;
  plan_status: string;
  plan_description: string;
  affected_policy_keys_json: string[];
  estimated_rollback_minutes: number;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_ROLLBACK_PLAN_COLUMNS = [
  "id", "workspace_id", "change_request_id", "plan_type", "plan_status",
  "plan_description", "affected_policy_keys_json", "estimated_rollback_minutes",
  "reviewed_by", "reviewed_at", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyRollbackPlanRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_backlog_events
// Source: 20260808000000_agent_pmo_governance_proposal_review_controlled_policy_change_backlog.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyBacklogEventRow = {
  id: string;
  workspace_id: string | null;
  backlog_item_id: string | null;
  change_request_id: string | null;
  simulation_id: string | null;
  draft_id: string | null;
  workflow_id: string | null;
  event_type: string;
  message: string | null;
  event_payload_json: Record<string, unknown> | null;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_PMO_POLICY_BACKLOG_EVENT_COLUMNS = [
  "id", "workspace_id", "backlog_item_id", "change_request_id", "simulation_id",
  "draft_id", "workflow_id", "event_type", "message", "event_payload_json",
  "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyBacklogEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_simulation_reports
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoSimulationReportRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  backlog_item_id: string | null;
  simulation_id: string | null;
  impact_preview_id: string | null;
  policy_draft_id: string | null;
  approval_workflow_id: string | null;
  rollback_plan_id: string | null;
  implementation_readiness_id: string | null;
  status: string;
  report_version: number;
  title: string;
  executive_summary: string;
  safe_report_payload_json: Record<string, unknown>;
  section_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_SIMULATION_REPORT_COLUMNS = [
  "id", "workspace_id", "change_request_id", "backlog_item_id", "simulation_id",
  "impact_preview_id", "policy_draft_id", "approval_workflow_id", "rollback_plan_id",
  "implementation_readiness_id", "status", "report_version", "title", "executive_summary",
  "safe_report_payload_json", "section_count", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoSimulationReportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_simulation_report_sections
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoSimulationReportSectionRow = {
  id: string;
  workspace_id: string;
  report_id: string;
  section_type: string;
  section_title: string;
  section_order: number;
  safe_markdown: string;
  safe_payload_json: Record<string, unknown>;
  source_record_ids_json: string[];
  created_at: string;
};

export const AGENT_PMO_SIMULATION_REPORT_SECTION_COLUMNS = [
  "id", "workspace_id", "report_id", "section_type", "section_title", "section_order",
  "safe_markdown", "safe_payload_json", "source_record_ids_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoSimulationReportSectionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_impact_summaries
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyImpactSummaryRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  simulation_id: string | null;
  impact_preview_id: string | null;
  impact_level: string;
  affected_domains_json: string[];
  affected_action_types_json: string[];
  affected_adapters_json: string[];
  estimated_review_load_change: number;
  estimated_evidence_burden_change: number;
  risk_posture_estimate: string;
  implementation_complexity: string;
  confidence_score: number;
  summary: string;
  safe_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_POLICY_IMPACT_SUMMARY_COLUMNS = [
  "id", "workspace_id", "change_request_id", "simulation_id", "impact_preview_id",
  "impact_level", "affected_domains_json", "affected_action_types_json", "affected_adapters_json",
  "estimated_review_load_change", "estimated_evidence_burden_change", "risk_posture_estimate",
  "implementation_complexity", "confidence_score", "summary", "safe_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyImpactSummaryRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_draft_diffs
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyDraftDiffRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  policy_draft_id: string | null;
  unknown_baseline: boolean;
  baseline_label: string;
  draft_label: string;
  added_rules_json: string[];
  removed_rules_json: string[];
  changed_rules_json: string[];
  unchanged_rules_json: string[];
  total_rule_count: number;
  safe_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_POLICY_DRAFT_DIFF_COLUMNS = [
  "id", "workspace_id", "change_request_id", "policy_draft_id", "unknown_baseline",
  "baseline_label", "draft_label", "added_rules_json", "removed_rules_json",
  "changed_rules_json", "unchanged_rules_json", "total_rule_count", "safe_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyDraftDiffRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_approval_checklists
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoApprovalChecklistRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  approval_pack_id: string | null;
  overall_status: string;
  item_count: number;
  passed_count: number;
  failed_count: number;
  pending_count: number;
  safe_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_APPROVAL_CHECKLIST_COLUMNS = [
  "id", "workspace_id", "change_request_id", "approval_pack_id", "overall_status",
  "item_count", "passed_count", "failed_count", "pending_count", "safe_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoApprovalChecklistRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_approval_checklist_items
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoApprovalChecklistItemRow = {
  id: string;
  workspace_id: string;
  checklist_id: string;
  item_key: string;
  item_label: string;
  item_order: number;
  status: string;
  notes: string;
  created_at: string;
};

export const AGENT_PMO_APPROVAL_CHECKLIST_ITEM_COLUMNS = [
  "id", "workspace_id", "checklist_id", "item_key", "item_label", "item_order",
  "status", "notes", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoApprovalChecklistItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_rollback_readiness_checklists
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRollbackReadinessChecklistRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  rollback_plan_id: string | null;
  approval_pack_id: string | null;
  overall_status: string;
  item_count: number;
  passed_count: number;
  failed_count: number;
  pending_count: number;
  safe_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_ROLLBACK_READINESS_CHECKLIST_COLUMNS = [
  "id", "workspace_id", "change_request_id", "rollback_plan_id", "approval_pack_id",
  "overall_status", "item_count", "passed_count", "failed_count", "pending_count",
  "safe_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRollbackReadinessChecklistRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_rollback_readiness_checklist_items
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRollbackReadinessChecklistItemRow = {
  id: string;
  workspace_id: string;
  checklist_id: string;
  item_key: string;
  item_label: string;
  item_order: number;
  status: string;
  notes: string;
  created_at: string;
};

export const AGENT_PMO_ROLLBACK_READINESS_CHECKLIST_ITEM_COLUMNS = [
  "id", "workspace_id", "checklist_id", "item_key", "item_label", "item_order",
  "status", "notes", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRollbackReadinessChecklistItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_signoff_packets
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoSignOffPacketRow = {
  id: string;
  workspace_id: string;
  approval_pack_id: string | null;
  change_request_id: string;
  simulation_report_id: string | null;
  impact_summary_id: string | null;
  draft_diff_id: string | null;
  approval_checklist_id: string | null;
  rollback_checklist_id: string | null;
  status: string;
  packet_version: number;
  sign_off_summary: string;
  safe_payload_json: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_SIGNOFF_PACKET_COLUMNS = [
  "id", "workspace_id", "approval_pack_id", "change_request_id", "simulation_report_id",
  "impact_summary_id", "draft_diff_id", "approval_checklist_id", "rollback_checklist_id",
  "status", "packet_version", "sign_off_summary", "safe_payload_json",
  "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoSignOffPacketRow>;

export type AgentPmoSignoffPacketRow = AgentPmoSignOffPacketRow;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_signoff_decisions
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoSignOffDecisionRow = {
  id: string;
  workspace_id: string;
  sign_off_packet_id: string;
  approval_pack_id: string | null;
  decision_type: string;
  rationale: string;
  decided_by: string | null;
  created_at: string;
};

export const AGENT_PMO_SIGNOFF_DECISION_COLUMNS = [
  "id", "workspace_id", "sign_off_packet_id", "approval_pack_id", "decision_type",
  "rationale", "decided_by", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoSignOffDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_approval_packs
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoApprovalPackRow = {
  id: string;
  workspace_id: string;
  change_request_id: string;
  backlog_item_id: string | null;
  simulation_report_id: string | null;
  impact_summary_id: string | null;
  draft_diff_id: string | null;
  approval_checklist_id: string | null;
  rollback_checklist_id: string | null;
  sign_off_packet_id: string | null;
  implementation_ticket_draft_id: string | null;
  pack_status: string;
  pack_version: number;
  title: string;
  safe_pack_payload_json: Record<string, unknown>;
  artifact_count: number;
  export_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_APPROVAL_PACK_COLUMNS = [
  "id", "workspace_id", "change_request_id", "backlog_item_id", "simulation_report_id",
  "impact_summary_id", "draft_diff_id", "approval_checklist_id", "rollback_checklist_id",
  "sign_off_packet_id", "implementation_ticket_draft_id", "pack_status", "pack_version",
  "title", "safe_pack_payload_json", "artifact_count", "export_count",
  "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoApprovalPackRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_approval_pack_artifacts
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoApprovalPackArtifactRow = {
  id: string;
  workspace_id: string;
  approval_pack_id: string;
  artifact_type: string;
  artifact_ref_id: string | null;
  artifact_label: string;
  created_at: string;
};

export const AGENT_PMO_APPROVAL_PACK_ARTIFACT_COLUMNS = [
  "id", "workspace_id", "approval_pack_id", "artifact_type", "artifact_ref_id",
  "artifact_label", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoApprovalPackArtifactRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_implementation_ticket_drafts
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoImplementationTicketDraftRow = {
  id: string;
  workspace_id: string;
  approval_pack_id: string | null;
  change_request_id: string;
  ticket_title: string;
  ticket_body: string;
  ticket_type: string;
  target_future_sprint: string;
  acceptance_criteria_json: string[];
  blocked_until_sign_off: boolean;
  status: string;
  safe_ticket_payload_json: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_IMPLEMENTATION_TICKET_DRAFT_COLUMNS = [
  "id", "workspace_id", "approval_pack_id", "change_request_id", "ticket_title",
  "ticket_body", "ticket_type", "target_future_sprint", "acceptance_criteria_json",
  "blocked_until_sign_off", "status", "safe_ticket_payload_json",
  "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoImplementationTicketDraftRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_implementation_planning_workspaces
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoImplementationPlanningWorkspaceRow = {
  id: string;
  workspace_id: string;
  approval_pack_id: string | null;
  change_request_id: string | null;
  signoff_packet_id: string | null;
  implementation_ticket_draft_id: string | null;
  planning_owner_role: string | null;
  planning_version: number;
  status: string;
  title: string;
  summary: string;
  safe_planning_payload_json: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_IMPLEMENTATION_PLANNING_WORKSPACE_COLUMNS = [
  "id", "workspace_id", "approval_pack_id", "change_request_id", "signoff_packet_id",
  "implementation_ticket_draft_id", "planning_owner_role", "planning_version", "status",
  "title", "summary", "safe_planning_payload_json", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoImplementationPlanningWorkspaceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_implementation_plan_drafts
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoImplementationPlanDraftRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  approval_pack_id: string | null;
  change_request_id: string | null;
  plan_version: number;
  status: string;
  implementation_objective: string;
  implementation_scope: string;
  non_goals: string;
  assumptions: string;
  constraints: string;
  safe_plan_payload_json: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_IMPLEMENTATION_PLAN_DRAFT_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "approval_pack_id", "change_request_id",
  "plan_version", "status", "implementation_objective", "implementation_scope", "non_goals",
  "assumptions", "constraints", "safe_plan_payload_json", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoImplementationPlanDraftRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_implementation_task_breakdowns
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoImplementationTaskBreakdownRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  plan_draft_id: string | null;
  task_type: string;
  status: string;
  task_order: number;
  title: string;
  description: string;
  owner_role: string | null;
  blocking_reason: string | null;
  safe_task_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_IMPLEMENTATION_TASK_BREAKDOWN_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "plan_draft_id", "task_type",
  "status", "task_order", "title", "description", "owner_role", "blocking_reason",
  "safe_task_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoImplementationTaskBreakdownRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_pre_implementation_checklists
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPreImplementationChecklistRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  approval_pack_id: string | null;
  status: string;
  total_items: number;
  passed_items: number;
  failed_items: number;
  blocked_items: number;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_PRE_IMPLEMENTATION_CHECKLIST_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "approval_pack_id", "status",
  "total_items", "passed_items", "failed_items", "blocked_items", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPreImplementationChecklistRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_pre_implementation_checklist_items
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPreImplementationChecklistItemRow = {
  id: string;
  workspace_id: string;
  checklist_id: string;
  item_key: string;
  item_label: string;
  status: string;
  source_record_id: string | null;
  blocking_reason: string | null;
  created_at: string;
};

export const AGENT_PMO_PRE_IMPLEMENTATION_CHECKLIST_ITEM_COLUMNS = [
  "id", "workspace_id", "checklist_id", "item_key", "item_label", "status",
  "source_record_id", "blocking_reason", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPreImplementationChecklistItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_stakeholder_readiness_records
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoStakeholderReadinessRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  stakeholder_role: string;
  status: string;
  rationale: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_STAKEHOLDER_READINESS_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "stakeholder_role", "status",
  "rationale", "acknowledged_by", "acknowledged_at", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoStakeholderReadinessRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_change_window_plans
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoChangeWindowPlanRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  change_request_id: string | null;
  window_type: string;
  status: string;
  proposed_start_at: string | null;
  proposed_end_at: string | null;
  timezone: string | null;
  business_impact_estimate: string | null;
  operational_constraints: string | null;
  approval_required: boolean;
  safe_window_payload_json: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_CHANGE_WINDOW_PLAN_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "change_request_id", "window_type",
  "status", "proposed_start_at", "proposed_end_at", "timezone", "business_impact_estimate",
  "operational_constraints", "approval_required", "safe_window_payload_json",
  "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoChangeWindowPlanRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_implementation_risks
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoImplementationRiskRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  risk_type: string;
  severity: string;
  status: string;
  risk_summary: string;
  mitigation_summary: string | null;
  owner_role: string | null;
  safe_risk_payload_json: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_IMPLEMENTATION_RISK_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "risk_type", "severity", "status",
  "risk_summary", "mitigation_summary", "owner_role", "safe_risk_payload_json",
  "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoImplementationRiskRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_rollback_rehearsal_plans
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRollbackRehearsalPlanRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  rollback_plan_id: string | null;
  rehearsal_type: string;
  status: string;
  rehearsal_summary: string;
  verification_steps_json: string[];
  expected_evidence_json: string[];
  blocking_reasons_json: string[];
  safe_rehearsal_payload_json: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_ROLLBACK_REHEARSAL_PLAN_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "rollback_plan_id", "rehearsal_type",
  "status", "rehearsal_summary", "verification_steps_json", "expected_evidence_json",
  "blocking_reasons_json", "safe_rehearsal_payload_json", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRollbackRehearsalPlanRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_implementation_gate_prerequisites
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoImplementationGatePrerequisiteRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  prerequisite_type: string;
  status: string;
  rationale: string | null;
  source_record_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_IMPLEMENTATION_GATE_PREREQUISITE_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "prerequisite_type", "status",
  "rationale", "source_record_id", "created_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoImplementationGatePrerequisiteRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_implementation_planning_decisions
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoImplementationPlanningDecisionRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  decision: string;
  rationale: string;
  decided_by: string | null;
  decided_at: string;
  created_at: string;
};

export const AGENT_PMO_IMPLEMENTATION_PLANNING_DECISION_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "decision", "rationale",
  "decided_by", "decided_at", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoImplementationPlanningDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_implementation_planning_exports
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoImplementationPlanningExportRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  export_format: string;
  status: string;
  file_name: string;
  content_type: string;
  content_text: string | null;
  content_json_safe: Record<string, unknown> | null;
  safe_export_payload_json: Record<string, unknown>;
  generated_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_IMPLEMENTATION_PLANNING_EXPORT_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "export_format", "status",
  "file_name", "content_type", "content_text", "content_json_safe",
  "safe_export_payload_json", "generated_by", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoImplementationPlanningExportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_implementation_planning_events
// Source: 20260810000000_agent_controlled_policy_implementation_planning_workspace.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoImplementationPlanningEventRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string | null;
  plan_draft_id: string | null;
  checklist_id: string | null;
  export_id: string | null;
  event_type: string;
  message: string | null;
  event_payload_json: Record<string, unknown> | null;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_PMO_IMPLEMENTATION_PLANNING_EVENT_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "plan_draft_id", "checklist_id",
  "export_id", "event_type", "message", "event_payload_json", "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoImplementationPlanningEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_approval_pack_exports
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoApprovalPackExportRow = {
  id: string;
  workspace_id: string;
  approval_pack_id: string;
  export_format: string;
  export_status: string;
  safe_export_content: string;
  export_size_bytes: number;
  safety_validation_passed: boolean;
  created_by: string | null;
  created_at: string;
};

export const AGENT_PMO_APPROVAL_PACK_EXPORT_COLUMNS = [
  "id", "workspace_id", "approval_pack_id", "export_format", "export_status",
  "safe_export_content", "export_size_bytes", "safety_validation_passed",
  "created_by", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoApprovalPackExportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_approval_pack_events
// Source: 20260809000000_agent_controlled_governance_policy_simulation_report_pmo_approval_pack.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoApprovalPackEventRow = {
  id: string;
  workspace_id: string | null;
  approval_pack_id: string | null;
  change_request_id: string | null;
  simulation_report_id: string | null;
  sign_off_packet_id: string | null;
  event_type: string;
  message: string | null;
  safe_event_payload_json: Record<string, unknown>;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_PMO_APPROVAL_PACK_EVENT_COLUMNS = [
  "id", "workspace_id", "approval_pack_id", "change_request_id", "simulation_report_id",
  "sign_off_packet_id", "event_type", "message", "safe_event_payload_json",
  "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoApprovalPackEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_execution_requests
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunExecutionRequestRow = {
  id: string;
  workspace_id: string;
  planning_workspace_id: string;
  approval_pack_id: string | null;
  change_request_id: string | null;
  requested_by: string | null;
  request_reason: string;
  request_status: string;
  request_version: number;
  safe_request_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_DRY_RUN_EXECUTION_REQUEST_COLUMNS = [
  "id", "workspace_id", "planning_workspace_id", "approval_pack_id", "change_request_id",
  "requested_by", "request_reason", "request_status", "request_version",
  "safe_request_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunExecutionRequestRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_preflight_validations
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunPreflightValidationRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string;
  preflight_status: string;
  checks_total: number;
  checks_passed: number;
  checks_failed: number;
  checks_blocked: number;
  safe_preflight_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_DRY_RUN_PREFLIGHT_VALIDATION_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "preflight_status",
  "checks_total", "checks_passed", "checks_failed", "checks_blocked",
  "safe_preflight_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunPreflightValidationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_gate_approvals
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunGateApprovalRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string;
  gate_approval_status: string;
  reviewed_by: string | null;
  safe_approval_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_DRY_RUN_GATE_APPROVAL_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "gate_approval_status",
  "reviewed_by", "safe_approval_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunGateApprovalRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_gate_decisions
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunGateDecisionRow = {
  id: string;
  workspace_id: string;
  gate_approval_id: string;
  dry_run_request_id: string;
  decision_type: string;
  rationale: string;
  decided_by: string | null;
  created_at: string;
};

export const AGENT_PMO_DRY_RUN_GATE_DECISION_COLUMNS = [
  "id", "workspace_id", "gate_approval_id", "dry_run_request_id",
  "decision_type", "rationale", "decided_by", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunGateDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_change_sets
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunChangeSetRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string;
  planning_workspace_id: string;
  approval_pack_id: string | null;
  change_request_id: string | null;
  simulated_change_count: number;
  policy_area: string | null;
  safe_change_summary: string;
  safe_change_set_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_DRY_RUN_CHANGE_SET_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "planning_workspace_id",
  "approval_pack_id", "change_request_id", "simulated_change_count", "policy_area",
  "safe_change_summary", "safe_change_set_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunChangeSetRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_change_set_items
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunChangeSetItemRow = {
  id: string;
  workspace_id: string;
  change_set_id: string;
  dry_run_request_id: string;
  change_type: string;
  safe_change_summary: string;
  safe_change_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_DRY_RUN_CHANGE_SET_ITEM_COLUMNS = [
  "id", "workspace_id", "change_set_id", "dry_run_request_id",
  "change_type", "safe_change_summary", "safe_change_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunChangeSetItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_simulated_policy_versions
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoSimulatedPolicyVersionRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string;
  change_set_id: string | null;
  simulated_version_label: string;
  baseline_label: string;
  target_label: string;
  unknown_baseline: boolean;
  simulated_policy_payload_json: Record<string, unknown>;
  safe_diff_payload_json: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_SIMULATED_POLICY_VERSION_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "change_set_id",
  "simulated_version_label", "baseline_label", "target_label", "unknown_baseline",
  "simulated_policy_payload_json", "safe_diff_payload_json", "status",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoSimulatedPolicyVersionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_simulation_executions
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunSimulationExecutionRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string;
  preflight_validation_id: string | null;
  gate_approval_id: string | null;
  change_set_id: string | null;
  simulated_policy_version_id: string | null;
  execution_status: string;
  started_at: string | null;
  completed_at: string | null;
  safe_execution_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_DRY_RUN_SIMULATION_EXECUTION_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "preflight_validation_id",
  "gate_approval_id", "change_set_id", "simulated_policy_version_id",
  "execution_status", "started_at", "completed_at",
  "safe_execution_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunSimulationExecutionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_simulated_impacts
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunSimulatedImpactRow = {
  id: string;
  workspace_id: string;
  dry_run_execution_id: string;
  dry_run_request_id: string;
  impact_domain: string;
  impact_level: string;
  impact_summary: string;
  affected_count: number;
  safe_impact_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_DRY_RUN_SIMULATED_IMPACT_COLUMNS = [
  "id", "workspace_id", "dry_run_execution_id", "dry_run_request_id",
  "impact_domain", "impact_level", "impact_summary", "affected_count",
  "safe_impact_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunSimulatedImpactRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_evidence_packages
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunEvidencePackageRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string;
  package_status: string;
  safe_package_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_DRY_RUN_EVIDENCE_PACKAGE_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "package_status",
  "safe_package_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunEvidencePackageRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_evidence_sections
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunEvidenceSectionRow = {
  id: string;
  workspace_id: string;
  evidence_package_id: string;
  dry_run_request_id: string;
  section_type: string;
  safe_section_content: string;
  safe_markdown: string;
  created_at: string;
};

export const AGENT_PMO_DRY_RUN_EVIDENCE_SECTION_COLUMNS = [
  "id", "workspace_id", "evidence_package_id", "dry_run_request_id",
  "section_type", "safe_section_content", "safe_markdown", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunEvidenceSectionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_blockers
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunBlockerRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string;
  blocker_type: string;
  blocker_status: string;
  severity: string;
  summary: string;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_DRY_RUN_BLOCKER_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "blocker_type",
  "blocker_status", "severity", "summary", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunBlockerRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_operator_reviews
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunOperatorReviewRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string;
  evidence_package_id: string | null;
  review_status: string;
  review_decision: string | null;
  review_rationale: string | null;
  reviewed_by: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_DRY_RUN_OPERATOR_REVIEW_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "evidence_package_id",
  "review_status", "review_decision", "review_rationale", "reviewed_by",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunOperatorReviewRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_decisions
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunDecisionRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string;
  decision_type: string;
  decision_status: string;
  rationale: string;
  decided_by: string | null;
  created_at: string;
};

export const AGENT_PMO_DRY_RUN_DECISION_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "decision_type",
  "decision_status", "rationale", "decided_by", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_exports
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunExportRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string;
  export_format: string;
  export_status: string;
  safe_export_content: string;
  export_size_bytes: number;
  safety_validation_passed: boolean;
  created_by: string | null;
  created_at: string;
};

export const AGENT_PMO_DRY_RUN_EXPORT_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "export_format", "export_status",
  "safe_export_content", "export_size_bytes", "safety_validation_passed",
  "created_by", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunExportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_dry_run_events
// Source: 20260811000000_agent_controlled_policy_implementation_gate_dry_run_change_executor.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDryRunEventRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string | null;
  event_type: string;
  message: string | null;
  safe_event_payload_json: Record<string, unknown>;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_PMO_DRY_RUN_EVENT_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "event_type",
  "message", "safe_event_payload_json", "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDryRunEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_activation_requests
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyActivationRequestRow = {
  id: string;
  workspace_id: string;
  dry_run_request_id: string | null;
  dry_run_decision_id: string | null;
  evidence_package_id: string | null;
  simulated_policy_version_id: string | null;
  planning_workspace_id: string | null;
  approval_pack_id: string | null;
  change_request_id: string | null;
  requested_by: string | null;
  request_reason: string;
  activation_status: string;
  request_version: number;
  safe_request_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_ACTIVATION_REQUEST_COLUMNS = [
  "id", "workspace_id", "dry_run_request_id", "dry_run_decision_id",
  "evidence_package_id", "simulated_policy_version_id", "planning_workspace_id",
  "approval_pack_id", "change_request_id", "requested_by", "request_reason",
  "activation_status", "request_version", "safe_request_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyActivationRequestRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_activation_preconditions
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyActivationPreconditionRow = {
  id: string;
  workspace_id: string;
  activation_request_id: string;
  precondition_key: string;
  precondition_status: string;
  summary: string;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_ACTIVATION_PRECONDITION_COLUMNS = [
  "id", "workspace_id", "activation_request_id", "precondition_key",
  "precondition_status", "summary", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyActivationPreconditionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_activation_gates
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyActivationGateRow = {
  id: string;
  workspace_id: string;
  activation_request_id: string;
  gate_status: string;
  reviewed_by: string | null;
  safe_gate_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_ACTIVATION_GATE_COLUMNS = [
  "id", "workspace_id", "activation_request_id", "gate_status",
  "reviewed_by", "safe_gate_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyActivationGateRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_activation_gate_decisions
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyActivationGateDecisionRow = {
  id: string;
  workspace_id: string;
  activation_gate_id: string;
  activation_request_id: string;
  decision_type: string;
  rationale: string;
  decided_by: string | null;
  created_at: string;
};

export const AGENT_PMO_POLICY_ACTIVATION_GATE_DECISION_COLUMNS = [
  "id", "workspace_id", "activation_gate_id", "activation_request_id",
  "decision_type", "rationale", "decided_by", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyActivationGateDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_controlled_policy_versions
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoControlledPolicyVersionRow = {
  id: string;
  workspace_id: string;
  activation_request_id: string;
  dry_run_request_id: string | null;
  simulated_policy_version_id: string | null;
  version_label: string;
  version_number: number;
  policy_area: string;
  version_status: string;
  safe_policy_payload_json: Record<string, unknown>;
  safe_diff_payload_json: Record<string, unknown>;
  created_at: string;
  activated_at: string | null;
  updated_at: string;
};

export const AGENT_PMO_CONTROLLED_POLICY_VERSION_COLUMNS = [
  "id", "workspace_id", "activation_request_id", "dry_run_request_id",
  "simulated_policy_version_id", "version_label", "version_number", "policy_area",
  "version_status", "safe_policy_payload_json", "safe_diff_payload_json",
  "created_at", "activated_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoControlledPolicyVersionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_active_policy_pointers
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoActivePolicyPointerRow = {
  id: string;
  workspace_id: string;
  policy_area: string;
  active_policy_version_id: string | null;
  previous_policy_version_id: string | null;
  activation_request_id: string | null;
  activated_by: string | null;
  activated_at: string | null;
  rollback_available: boolean;
  safe_pointer_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_ACTIVE_POLICY_POINTER_COLUMNS = [
  "id", "workspace_id", "policy_area", "active_policy_version_id",
  "previous_policy_version_id", "activation_request_id", "activated_by",
  "activated_at", "rollback_available", "safe_pointer_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoActivePolicyPointerRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_activation_executions
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyActivationExecutionRow = {
  id: string;
  workspace_id: string;
  activation_request_id: string;
  activation_gate_id: string | null;
  controlled_policy_version_id: string | null;
  active_policy_pointer_id: string | null;
  execution_status: string;
  started_at: string | null;
  completed_at: string | null;
  safe_execution_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_ACTIVATION_EXECUTION_COLUMNS = [
  "id", "workspace_id", "activation_request_id", "activation_gate_id",
  "controlled_policy_version_id", "active_policy_pointer_id", "execution_status",
  "started_at", "completed_at", "safe_execution_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyActivationExecutionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_rollback_requests
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyRollbackRequestRow = {
  id: string;
  workspace_id: string;
  activation_request_id: string;
  controlled_policy_version_id: string | null;
  active_policy_pointer_id: string | null;
  requested_by: string | null;
  request_reason: string;
  rollback_status: string;
  safe_rollback_request_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_ROLLBACK_REQUEST_COLUMNS = [
  "id", "workspace_id", "activation_request_id", "controlled_policy_version_id",
  "active_policy_pointer_id", "requested_by", "request_reason", "rollback_status",
  "safe_rollback_request_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyRollbackRequestRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_rollback_gates
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyRollbackGateRow = {
  id: string;
  workspace_id: string;
  rollback_request_id: string;
  gate_status: string;
  reviewed_by: string | null;
  safe_gate_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_ROLLBACK_GATE_COLUMNS = [
  "id", "workspace_id", "rollback_request_id", "gate_status",
  "reviewed_by", "safe_gate_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyRollbackGateRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_rollback_gate_decisions
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyRollbackGateDecisionRow = {
  id: string;
  workspace_id: string;
  rollback_gate_id: string;
  rollback_request_id: string;
  decision_type: string;
  rationale: string;
  decided_by: string | null;
  created_at: string;
};

export const AGENT_PMO_POLICY_ROLLBACK_GATE_DECISION_COLUMNS = [
  "id", "workspace_id", "rollback_gate_id", "rollback_request_id",
  "decision_type", "rationale", "decided_by", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyRollbackGateDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_rollback_executions
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyRollbackExecutionRow = {
  id: string;
  workspace_id: string;
  rollback_request_id: string;
  rollback_gate_id: string | null;
  activation_request_id: string | null;
  controlled_policy_version_id: string | null;
  previous_policy_version_id: string | null;
  active_policy_pointer_id: string | null;
  execution_status: string;
  started_at: string | null;
  completed_at: string | null;
  safe_rollback_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_ROLLBACK_EXECUTION_COLUMNS = [
  "id", "workspace_id", "rollback_request_id", "rollback_gate_id",
  "activation_request_id", "controlled_policy_version_id", "previous_policy_version_id",
  "active_policy_pointer_id", "execution_status", "started_at", "completed_at",
  "safe_rollback_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyRollbackExecutionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_rollback_verifications
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyRollbackVerificationRow = {
  id: string;
  workspace_id: string;
  rollback_execution_id: string;
  rollback_request_id: string | null;
  verification_status: string;
  checks_total: number;
  checks_passed: number;
  checks_failed: number;
  safe_verification_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POLICY_ROLLBACK_VERIFICATION_COLUMNS = [
  "id", "workspace_id", "rollback_execution_id", "rollback_request_id",
  "verification_status", "checks_total", "checks_passed", "checks_failed",
  "safe_verification_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyRollbackVerificationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_activation_audit_entries
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyActivationAuditEntryRow = {
  id: string;
  workspace_id: string;
  activation_request_id: string | null;
  entry_type: string;
  summary: string;
  actor_id: string | null;
  safe_audit_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_POLICY_ACTIVATION_AUDIT_ENTRY_COLUMNS = [
  "id", "workspace_id", "activation_request_id", "entry_type",
  "summary", "actor_id", "safe_audit_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyActivationAuditEntryRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_post_activation_monitoring_hooks
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPostActivationMonitoringHookRow = {
  id: string;
  workspace_id: string;
  activation_request_id: string;
  hook_type: string;
  hook_status: string;
  summary: string;
  safe_hook_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_POST_ACTIVATION_MONITORING_HOOK_COLUMNS = [
  "id", "workspace_id", "activation_request_id", "hook_type", "hook_status",
  "summary", "safe_hook_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPostActivationMonitoringHookRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_activation_exports
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyActivationExportRow = {
  id: string;
  workspace_id: string;
  activation_request_id: string;
  export_format: string;
  export_status: string;
  safe_export_content: string;
  export_size_bytes: number;
  safety_validation_passed: boolean;
  created_by: string | null;
  created_at: string;
};

export const AGENT_PMO_POLICY_ACTIVATION_EXPORT_COLUMNS = [
  "id", "workspace_id", "activation_request_id", "export_format", "export_status",
  "safe_export_content", "export_size_bytes", "safety_validation_passed",
  "created_by", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyActivationExportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_policy_activation_events
// Source: 20260812000000_agent_controlled_policy_version_activation_rollback_gate.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoPolicyActivationEventRow = {
  id: string;
  workspace_id: string;
  activation_request_id: string | null;
  event_type: string;
  message: string | null;
  safe_event_payload_json: Record<string, unknown>;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_PMO_POLICY_ACTIVATION_EVENT_COLUMNS = [
  "id", "workspace_id", "activation_request_id", "event_type",
  "message", "safe_event_payload_json", "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoPolicyActivationEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_handoff_requests
// Source: 20260813000000_agent_controlled_project_intelligence_handoff.sql
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectHandoffRequestRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  current_pm_id: string | null;
  incoming_pm_id: string;
  requested_by_id: string | null;
  handoff_reason: string;
  handoff_urgency: string;
  request_reason: string;
  status: string;
  effective_date: string | null;
  request_version: number;
  safe_request_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_PROJECT_HANDOFF_REQUEST_COLUMNS = [
  "id", "workspace_id", "project_id", "current_pm_id", "incoming_pm_id",
  "requested_by_id", "handoff_reason", "handoff_urgency", "request_reason",
  "status", "effective_date", "request_version", "safe_request_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectHandoffRequestRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_context_validations
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectContextValidationRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  check_key: string;
  check_label: string;
  status: string;
  finding: string;
  limitation: string | null;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_PROJECT_CONTEXT_VALIDATION_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "check_key", "check_label",
  "status", "finding", "limitation", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectContextValidationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_handoff_gates
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectHandoffGateRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  gate_status: string;
  reviewed_by_id: string | null;
  safe_gate_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_PROJECT_HANDOFF_GATE_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "gate_status",
  "reviewed_by_id", "safe_gate_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectHandoffGateRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_handoff_gate_decisions
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectHandoffGateDecisionRow = {
  id: string;
  workspace_id: string;
  handoff_gate_id: string;
  handoff_request_id: string;
  decision: string;
  rationale: string;
  decided_by_id: string | null;
  decided_at: string;
  created_at: string;
};

export const AGENT_PMO_PROJECT_HANDOFF_GATE_DECISION_COLUMNS = [
  "id", "workspace_id", "handoff_gate_id", "handoff_request_id",
  "decision", "rationale", "decided_by_id", "decided_at", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectHandoffGateDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_handoff_packs
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectHandoffPackRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  current_pm_id: string | null;
  incoming_pm_id: string;
  handoff_reason: string;
  pack_status: string;
  executive_summary: string;
  current_project_state: string;
  health_summary: string;
  schedule_summary: string;
  delivery_summary: string;
  financial_summary: string | null;
  risk_summary: string;
  blocker_summary: string;
  open_decision_summary: string;
  dependency_summary: string;
  stakeholder_summary: string;
  commitment_summary: string;
  milestone_summary: string;
  recommended_first_actions: string;
  limitations: string;
  safe_pack_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_PROJECT_HANDOFF_PACK_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "current_pm_id", "incoming_pm_id",
  "handoff_reason", "pack_status", "executive_summary", "current_project_state",
  "health_summary", "schedule_summary", "delivery_summary", "financial_summary",
  "risk_summary", "blocker_summary", "open_decision_summary", "dependency_summary",
  "stakeholder_summary", "commitment_summary", "milestone_summary",
  "recommended_first_actions", "limitations", "safe_pack_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectHandoffPackRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_memory_snapshots
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectMemorySnapshotRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  category: string;
  snapshot_status: string;
  summary: string;
  limitation: string | null;
  item_count: number;
  safe_snapshot_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_PROJECT_MEMORY_SNAPSHOT_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "category", "snapshot_status",
  "summary", "limitation", "item_count", "safe_snapshot_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectMemorySnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_status_snapshots
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectStatusSnapshotRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  project_health: string;
  schedule_health: string;
  scope_health: string;
  budget_health: string;
  delivery_phase: string | null;
  completion_estimate: string | null;
  upcoming_milestone_count: number;
  active_risk_count: number;
  active_blocker_count: number;
  open_decision_count: number;
  pending_action_count: number;
  safe_status_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_PROJECT_STATUS_SNAPSHOT_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "project_health", "schedule_health",
  "scope_health", "budget_health", "delivery_phase", "completion_estimate",
  "upcoming_milestone_count", "active_risk_count", "active_blocker_count",
  "open_decision_count", "pending_action_count", "safe_status_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectStatusSnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_handoff_snapshot_items
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectHandoffSnapshotItemRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  item_type: string;
  title: string;
  description: string;
  item_status: string;
  severity: string;
  due_date: string | null;
  source_ref: string | null;
  safe_item_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_PROJECT_HANDOFF_SNAPSHOT_ITEM_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "item_type", "title",
  "description", "item_status", "severity", "due_date", "source_ref",
  "safe_item_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectHandoffSnapshotItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_stakeholder_context_snapshots
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoStakeholderContextSnapshotRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  stakeholder_type: string;
  role_label: string;
  context_summary: string;
  stakeholder_status: string;
  safe_context_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_STAKEHOLDER_CONTEXT_SNAPSHOT_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "stakeholder_type", "role_label",
  "context_summary", "stakeholder_status", "safe_context_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoStakeholderContextSnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_outgoing_pm_notes
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoOutgoingPmNoteRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  note_type: string;
  note_text: string;
  note_status: string;
  author_id: string | null;
  safe_note_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_OUTGOING_PM_NOTE_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "note_type", "note_text",
  "note_status", "author_id", "safe_note_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoOutgoingPmNoteRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_incoming_pm_acceptances
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoIncomingPmAcceptanceRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  handoff_pack_id: string | null;
  incoming_pm_id: string;
  decision: string;
  rationale: string;
  acceptance_status: string;
  safe_acceptance_payload_json: Record<string, unknown>;
  decided_at: string;
  created_at: string;
};

export const AGENT_PMO_INCOMING_PM_ACCEPTANCE_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "handoff_pack_id", "incoming_pm_id",
  "decision", "rationale", "acceptance_status", "safe_acceptance_payload_json",
  "decided_at", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoIncomingPmAcceptanceRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_controlled_project_assignment_pointers
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoControlledProjectAssignmentPointerRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  active_pm_id: string;
  previous_pm_id: string | null;
  handoff_request_id: string | null;
  handoff_completed_by_id: string | null;
  handoff_completed_at: string | null;
  assignment_version: number;
  handoff_reason: string | null;
  safe_assignment_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_CONTROLLED_PROJECT_ASSIGNMENT_POINTER_COLUMNS = [
  "id", "workspace_id", "project_id", "active_pm_id", "previous_pm_id",
  "handoff_request_id", "handoff_completed_by_id", "handoff_completed_at",
  "assignment_version", "handoff_reason", "safe_assignment_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoControlledProjectAssignmentPointerRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_assignment_history
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectAssignmentHistoryRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  handoff_request_id: string | null;
  previous_pm_id: string | null;
  new_pm_id: string;
  assignment_reason: string;
  assignment_source: string;
  effective_date: string | null;
  completed_by_id: string | null;
  completed_at: string;
  safe_history_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_PROJECT_ASSIGNMENT_HISTORY_COLUMNS = [
  "id", "workspace_id", "project_id", "handoff_request_id", "previous_pm_id",
  "new_pm_id", "assignment_reason", "assignment_source", "effective_date",
  "completed_by_id", "completed_at", "safe_history_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectAssignmentHistoryRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_handoff_continuity_checks
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoHandoffContinuityCheckRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  check_type: string;
  check_status: string;
  rationale: string | null;
  completed_at: string | null;
  safe_check_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_HANDOFF_CONTINUITY_CHECK_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "check_type", "check_status",
  "rationale", "completed_at", "safe_check_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoHandoffContinuityCheckRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_handoff_exports
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectHandoffExportRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string;
  export_format: string;
  export_status: string;
  safe_export_content: string;
  export_size_bytes: number;
  safety_validation_passed: boolean;
  created_by_id: string | null;
  created_at: string;
};

export const AGENT_PMO_PROJECT_HANDOFF_EXPORT_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "export_format", "export_status",
  "safe_export_content", "export_size_bytes", "safety_validation_passed",
  "created_by_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectHandoffExportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_project_handoff_audit_events
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProjectHandoffAuditEventRow = {
  id: string;
  workspace_id: string;
  handoff_request_id: string | null;
  event_type: string;
  message: string | null;
  safe_event_payload_json: Record<string, unknown>;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_PMO_PROJECT_HANDOFF_AUDIT_EVENT_COLUMNS = [
  "id", "workspace_id", "handoff_request_id", "event_type", "message",
  "safe_event_payload_json", "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProjectHandoffAuditEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_runtime_hardening_runs
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRuntimeHardeningRunRow = {
  id: string;
  workspace_id: string;
  scope: string;
  status: string;
  triggered_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  layers_audited: string[];
  blocker_count: number;
  warning_count: number;
  passed_check_count: number;
  failed_check_count: number;
  safe_run_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_RUNTIME_HARDENING_RUN_COLUMNS = [
  "id", "workspace_id", "scope", "status", "triggered_by", "started_at",
  "completed_at", "layers_audited", "blocker_count", "warning_count",
  "passed_check_count", "failed_check_count", "safe_run_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRuntimeHardeningRunRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_layer_integration_audits
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoLayerIntegrationAuditRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  layer: string;
  type_file_exists: boolean;
  validation_file_exists: boolean | null;
  registry_file_exists: boolean | null;
  service_file_exists: boolean | null;
  docs_exist: boolean;
  tests_exist: boolean;
  migration_exists: boolean | null;
  api_routes_exist: boolean | null;
  exports_exist: boolean;
  passed: boolean;
  warnings: string[];
  findings: string[];
  safe_audit_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_LAYER_INTEGRATION_AUDIT_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "layer", "type_file_exists",
  "validation_file_exists", "registry_file_exists", "service_file_exists",
  "docs_exist", "tests_exist", "migration_exists", "api_routes_exist",
  "exports_exist", "passed", "warnings", "findings", "safe_audit_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoLayerIntegrationAuditRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_route_contract_audits
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRouteContractAuditRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  route_path: string;
  route_exists: boolean;
  exported_methods: string[];
  dynamic_params_follow_convention: boolean;
  request_parsing_is_safe: boolean;
  responses_are_deterministic: boolean;
  errors_are_sanitized: boolean;
  passed: boolean;
  warnings: string[];
  findings: string[];
  safe_audit_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_ROUTE_CONTRACT_AUDIT_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "route_path", "route_exists",
  "exported_methods", "dynamic_params_follow_convention", "request_parsing_is_safe",
  "responses_are_deterministic", "errors_are_sanitized", "passed", "warnings",
  "findings", "safe_audit_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRouteContractAuditRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_database_contract_audits
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoDatabaseContractAuditRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  table_name: string;
  migration_exists: boolean;
  row_type_exists: boolean;
  column_constants_exist: boolean;
  contract_version_includes: boolean;
  indexes_exist: boolean;
  created_at_convention: boolean;
  updated_at_convention: boolean;
  passed: boolean;
  warnings: string[];
  findings: string[];
  safe_audit_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_DATABASE_CONTRACT_AUDIT_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "table_name", "migration_exists",
  "row_type_exists", "column_constants_exist", "contract_version_includes",
  "indexes_exist", "created_at_convention", "updated_at_convention", "passed",
  "warnings", "findings", "safe_audit_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoDatabaseContractAuditRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_rls_policy_audits
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRlsPolicyAuditRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  table_name: string;
  rls_enabled: boolean;
  workspace_scoped_read_exists: boolean;
  write_policies_exist: boolean;
  no_public_access: boolean;
  no_broad_using_true: boolean;
  passed: boolean;
  warnings: string[];
  findings: string[];
  safe_audit_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_RLS_POLICY_AUDIT_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "table_name", "rls_enabled",
  "workspace_scoped_read_exists", "write_policies_exist", "no_public_access",
  "no_broad_using_true", "passed", "warnings", "findings", "safe_audit_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRlsPolicyAuditRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_workspace_isolation_checks
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoWorkspaceIsolationCheckRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  check_target: string;
  workspace_id_required: boolean;
  list_functions_filter_by_workspace: boolean;
  get_functions_verify_workspace: boolean;
  api_routes_require_workspace_id: boolean;
  no_cross_workspace_leakage: boolean;
  passed: boolean;
  warnings: string[];
  findings: string[];
  safe_check_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_WORKSPACE_ISOLATION_CHECK_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "check_target", "workspace_id_required",
  "list_functions_filter_by_workspace", "get_functions_verify_workspace",
  "api_routes_require_workspace_id", "no_cross_workspace_leakage", "passed",
  "warnings", "findings", "safe_check_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoWorkspaceIsolationCheckRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_observability_coverage_checks
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoObservabilityCoverageCheckRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  source_types_exist: boolean;
  event_types_exist: boolean;
  category_is_governance: boolean;
  no_circular_imports: boolean;
  no_unsafe_payload: boolean;
  passed: boolean;
  warnings: string[];
  findings: string[];
  safe_check_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_OBSERVABILITY_COVERAGE_CHECK_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "source_types_exist", "event_types_exist",
  "category_is_governance", "no_circular_imports", "no_unsafe_payload", "passed",
  "warnings", "findings", "safe_check_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoObservabilityCoverageCheckRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_export_safety_checks
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoExportSafetyCheckRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  export_target: string;
  raw_payloads_excluded: boolean;
  secrets_excluded: boolean;
  tokens_excluded: boolean;
  credentials_excluded: boolean;
  stack_traces_excluded: boolean;
  unnecessary_personal_data_excluded: boolean;
  non_goals_included: boolean;
  passed: boolean;
  warnings: string[];
  findings: string[];
  safe_check_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_EXPORT_SAFETY_CHECK_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "export_target", "raw_payloads_excluded",
  "secrets_excluded", "tokens_excluded", "credentials_excluded", "stack_traces_excluded",
  "unnecessary_personal_data_excluded", "non_goals_included", "passed", "warnings",
  "findings", "safe_check_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoExportSafetyCheckRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_idempotency_checks
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoIdempotencyCheckRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  check_target: string;
  append_only_decisions_preserved: boolean;
  pointer_updates_preserve_previous: boolean;
  completion_requires_correct_status: boolean;
  activation_requires_approved_gate: boolean;
  rollback_requires_approved_gate: boolean;
  exports_regeneratable: boolean;
  archive_does_not_hard_delete: boolean;
  passed: boolean;
  warnings: string[];
  findings: string[];
  safe_check_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_IDEMPOTENCY_CHECK_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "check_target", "append_only_decisions_preserved",
  "pointer_updates_preserve_previous", "completion_requires_correct_status",
  "activation_requires_approved_gate", "rollback_requires_approved_gate",
  "exports_regeneratable", "archive_does_not_hard_delete", "passed", "warnings",
  "findings", "safe_check_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoIdempotencyCheckRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_error_handling_checks
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoErrorHandlingCheckRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  check_target: string;
  route_errors_sanitized: boolean;
  service_errors_do_not_leak_payloads: boolean;
  validation_errors_are_clear: boolean;
  missing_records_return_safe_messages: boolean;
  stack_traces_not_returned_from_api: boolean;
  passed: boolean;
  warnings: string[];
  findings: string[];
  safe_check_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_ERROR_HANDLING_CHECK_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "check_target", "route_errors_sanitized",
  "service_errors_do_not_leak_payloads", "validation_errors_are_clear",
  "missing_records_return_safe_messages", "stack_traces_not_returned_from_api",
  "passed", "warnings", "findings", "safe_check_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoErrorHandlingCheckRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_ui_dashboard_integration_checks
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoUiDashboardIntegrationCheckRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  dashboard_routes_exist: boolean;
  command_center_page_builds: boolean;
  no_uncontrolled_action_buttons: boolean;
  no_prohibited_labels: boolean;
  passed: boolean;
  warnings: string[];
  findings: string[];
  safe_check_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_UI_DASHBOARD_INTEGRATION_CHECK_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "dashboard_routes_exist",
  "command_center_page_builds", "no_uncontrolled_action_buttons", "no_prohibited_labels",
  "passed", "warnings", "findings", "safe_check_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoUiDashboardIntegrationCheckRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_ci_smoke_checks
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoCiSmokeCheckRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  typecheck_result: string;
  test_result: string;
  build_result: string;
  hardening_test_result: string;
  terminology_result: string;
  prohibited_behavior_result: string;
  safe_smoke_summary: string;
  passed: boolean;
  safe_check_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_CI_SMOKE_CHECK_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "typecheck_result", "test_result",
  "build_result", "hardening_test_result", "terminology_result", "prohibited_behavior_result",
  "safe_smoke_summary", "passed", "safe_check_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoCiSmokeCheckRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_production_readiness_gates
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProductionReadinessGateRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  status: string;
  open_blocker_count: number;
  critical_blocker_count: number;
  safe_gate_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_PRODUCTION_READINESS_GATE_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "status", "open_blocker_count",
  "critical_blocker_count", "safe_gate_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProductionReadinessGateRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_production_readiness_decisions
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoProductionReadinessDecisionRow = {
  id: string;
  workspace_id: string;
  gate_id: string;
  decision_type: string;
  rationale: string;
  decided_by_id: string | null;
  safe_decision_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_PMO_PRODUCTION_READINESS_DECISION_COLUMNS = [
  "id", "workspace_id", "gate_id", "decision_type", "rationale", "decided_by_id",
  "safe_decision_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoProductionReadinessDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_runtime_hardening_blockers
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRuntimeHardeningBlockerRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  blocker_type: string;
  severity: string;
  status: string;
  title: string;
  description: string;
  affected_layer: string | null;
  affected_file: string | null;
  resolved_at: string | null;
  safe_blocker_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_RUNTIME_HARDENING_BLOCKER_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "blocker_type", "severity", "status",
  "title", "description", "affected_layer", "affected_file", "resolved_at",
  "safe_blocker_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRuntimeHardeningBlockerRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_runtime_remediation_items
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRuntimeRemediationItemRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  blocker_id: string | null;
  remediation_type: string;
  status: string;
  title: string;
  description: string;
  safe_remediation_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_PMO_RUNTIME_REMEDIATION_ITEM_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "blocker_id", "remediation_type",
  "status", "title", "description", "safe_remediation_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRuntimeRemediationItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_runtime_hardening_exports
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRuntimeHardeningExportRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string;
  export_format: string;
  export_status: string;
  safe_export_content: string;
  export_size_bytes: number;
  safety_validation_passed: boolean;
  created_by_id: string | null;
  created_at: string;
};

export const AGENT_PMO_RUNTIME_HARDENING_EXPORT_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "export_format", "export_status",
  "safe_export_content", "export_size_bytes", "safety_validation_passed",
  "created_by_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRuntimeHardeningExportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_pmo_runtime_hardening_events
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPmoRuntimeHardeningEventRow = {
  id: string;
  workspace_id: string;
  hardening_run_id: string | null;
  event_type: string;
  message: string | null;
  safe_event_payload_json: Record<string, unknown>;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_PMO_RUNTIME_HARDENING_EVENT_COLUMNS = [
  "id", "workspace_id", "hardening_run_id", "event_type", "message",
  "safe_event_payload_json", "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentPmoRuntimeHardeningEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_readiness_plans
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaReadinessPlanRow = {
  id: string;
  workspace_id: string;
  scope: string;
  status: string;
  title: string;
  description: string | null;
  triggered_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  blocker_count: number;
  warning_count: number;
  safe_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_BETA_READINESS_PLAN_COLUMNS = [
  "id", "workspace_id", "scope", "status", "title", "description", "triggered_by",
  "started_at", "completed_at", "blocker_count", "warning_count", "safe_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentBetaReadinessPlanRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_workspace_readiness
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaWorkspaceReadinessRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  status: string;
  checklist_passed: boolean;
  demo_passed: boolean;
  validation_passed: boolean;
  safe_check_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_BETA_WORKSPACE_READINESS_COLUMNS = [
  "id", "workspace_id", "plan_id", "status", "checklist_passed", "demo_passed",
  "validation_passed", "safe_check_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentBetaWorkspaceReadinessRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_demo_data_bundles
// ─────────────────────────────────────────────────────────────────────────────

export type AgentDemoDataBundleRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  bundle_type: string;
  status: string;
  project_scenario_count: number;
  governance_scenario_count: number;
  handoff_scenario_count: number;
  safe_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_DEMO_DATA_BUNDLE_COLUMNS = [
  "id", "workspace_id", "plan_id", "bundle_type", "status", "project_scenario_count",
  "governance_scenario_count", "handoff_scenario_count", "safe_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentDemoDataBundleRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_demo_project_scenarios
// ─────────────────────────────────────────────────────────────────────────────

export type AgentDemoProjectScenarioRow = {
  id: string;
  workspace_id: string;
  bundle_id: string;
  scenario_type: string;
  status: string;
  fictional_project_name: string;
  fictional_pm_name: string;
  fictional_client_name: string;
  safe_scenario_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_DEMO_PROJECT_SCENARIO_COLUMNS = [
  "id", "workspace_id", "bundle_id", "scenario_type", "status", "fictional_project_name",
  "fictional_pm_name", "fictional_client_name", "safe_scenario_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentDemoProjectScenarioRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_demo_governance_scenarios
// ─────────────────────────────────────────────────────────────────────────────

export type AgentDemoGovernanceScenarioRow = {
  id: string;
  workspace_id: string;
  bundle_id: string;
  scenario_type: string;
  status: string;
  fictional_policy_title: string;
  fictional_requestor_name: string;
  safe_scenario_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_DEMO_GOVERNANCE_SCENARIO_COLUMNS = [
  "id", "workspace_id", "bundle_id", "scenario_type", "status", "fictional_policy_title",
  "fictional_requestor_name", "safe_scenario_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentDemoGovernanceScenarioRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_demo_handoff_scenarios
// ─────────────────────────────────────────────────────────────────────────────

export type AgentDemoHandoffScenarioRow = {
  id: string;
  workspace_id: string;
  bundle_id: string;
  scenario_type: string;
  status: string;
  fictional_from_pm_name: string;
  fictional_to_pm_name: string;
  fictional_project_name: string;
  safe_scenario_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_DEMO_HANDOFF_SCENARIO_COLUMNS = [
  "id", "workspace_id", "bundle_id", "scenario_type", "status", "fictional_from_pm_name",
  "fictional_to_pm_name", "fictional_project_name", "safe_scenario_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentDemoHandoffScenarioRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_onboarding_checklists
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaOnboardingChecklistRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  status: string;
  total_items: number;
  passed_items: number;
  failed_items: number;
  waived_items: number;
  safe_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_BETA_ONBOARDING_CHECKLIST_COLUMNS = [
  "id", "workspace_id", "plan_id", "status", "total_items", "passed_items",
  "failed_items", "waived_items", "safe_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentBetaOnboardingChecklistRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_onboarding_checklist_items
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaOnboardingChecklistItemRow = {
  id: string;
  workspace_id: string;
  checklist_id: string;
  item_type: string;
  status: string;
  title: string;
  notes: string | null;
  waived_reason: string | null;
  checked_at: string | null;
  safe_item_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_BETA_ONBOARDING_CHECKLIST_ITEM_COLUMNS = [
  "id", "workspace_id", "checklist_id", "item_type", "status", "title", "notes",
  "waived_reason", "checked_at", "safe_item_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentBetaOnboardingChecklistItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_user_readiness
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaUserReadinessRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  status: string;
  role: string;
  fictional_user_label: string;
  known_limitations: string[];
  safe_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_BETA_USER_READINESS_COLUMNS = [
  "id", "workspace_id", "plan_id", "status", "role", "fictional_user_label",
  "known_limitations", "safe_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentBetaUserReadinessRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_invitation_readiness
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaInvitationReadinessRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  status: string;
  invitation_count: number;
  safe_invitation_template_json: Record<string, unknown>;
  reviewed_at: string | null;
  safe_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_BETA_INVITATION_READINESS_COLUMNS = [
  "id", "workspace_id", "plan_id", "status", "invitation_count",
  "safe_invitation_template_json", "reviewed_at", "safe_payload_json",
  "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentBetaInvitationReadinessRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_admin_readiness
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaAdminReadinessRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  status: string;
  workspace_isolation_verified: boolean;
  rls_verified: boolean;
  export_safety_verified: boolean;
  docs_reviewed: boolean;
  support_path_defined: boolean;
  safe_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_BETA_ADMIN_READINESS_COLUMNS = [
  "id", "workspace_id", "plan_id", "status", "workspace_isolation_verified",
  "rls_verified", "export_safety_verified", "docs_reviewed", "support_path_defined",
  "safe_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentBetaAdminReadinessRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_tenant_readiness_validations
// ─────────────────────────────────────────────────────────────────────────────

export type AgentTenantReadinessValidationRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  status: string;
  check_name: string;
  passed: boolean;
  warnings: string[];
  findings: string[];
  waived_reason: string | null;
  safe_validation_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_TENANT_READINESS_VALIDATION_COLUMNS = [
  "id", "workspace_id", "plan_id", "status", "check_name", "passed", "warnings",
  "findings", "waived_reason", "safe_validation_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentTenantReadinessValidationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_readiness_gates
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaReadinessGateRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  status: string;
  open_blocker_count: number;
  critical_blocker_count: number;
  safe_gate_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_BETA_READINESS_GATE_COLUMNS = [
  "id", "workspace_id", "plan_id", "status", "open_blocker_count", "critical_blocker_count",
  "safe_gate_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentBetaReadinessGateRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_readiness_decisions
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaReadinessDecisionRow = {
  id: string;
  workspace_id: string;
  gate_id: string;
  decision_type: string;
  rationale: string;
  decided_by_id: string | null;
  safe_decision_payload_json: Record<string, unknown>;
  created_at: string;
};

export const AGENT_BETA_READINESS_DECISION_COLUMNS = [
  "id", "workspace_id", "gate_id", "decision_type", "rationale", "decided_by_id",
  "safe_decision_payload_json", "created_at",
] as const satisfies ReadonlyArray<keyof AgentBetaReadinessDecisionRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_readiness_blockers
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaReadinessBlockerRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  blocker_type: string;
  severity: string;
  status: string;
  title: string;
  description: string;
  resolved_at: string | null;
  safe_blocker_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_BETA_READINESS_BLOCKER_COLUMNS = [
  "id", "workspace_id", "plan_id", "blocker_type", "severity", "status", "title",
  "description", "resolved_at", "safe_blocker_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentBetaReadinessBlockerRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_readiness_remediation_items
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaReadinessRemediationItemRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  blocker_id: string | null;
  remediation_type: string;
  status: string;
  title: string;
  description: string;
  safe_remediation_payload_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export const AGENT_BETA_READINESS_REMEDIATION_ITEM_COLUMNS = [
  "id", "workspace_id", "plan_id", "blocker_id", "remediation_type", "status",
  "title", "description", "safe_remediation_payload_json", "created_at", "updated_at",
] as const satisfies ReadonlyArray<keyof AgentBetaReadinessRemediationItemRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_readiness_exports
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaReadinessExportRow = {
  id: string;
  workspace_id: string;
  plan_id: string;
  export_format: string;
  export_status: string;
  safe_export_content: string;
  export_size_bytes: number;
  safety_validation_passed: boolean;
  created_by_id: string | null;
  created_at: string;
};

export const AGENT_BETA_READINESS_EXPORT_COLUMNS = [
  "id", "workspace_id", "plan_id", "export_format", "export_status",
  "safe_export_content", "export_size_bytes", "safety_validation_passed",
  "created_by_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentBetaReadinessExportRow>;

// ─────────────────────────────────────────────────────────────────────────────
// agent_beta_readiness_events
// ─────────────────────────────────────────────────────────────────────────────

export type AgentBetaReadinessEventRow = {
  id: string;
  workspace_id: string;
  plan_id: string | null;
  event_type: string;
  message: string | null;
  safe_event_payload_json: Record<string, unknown>;
  actor_id: string | null;
  created_at: string;
};

export const AGENT_BETA_READINESS_EVENT_COLUMNS = [
  "id", "workspace_id", "plan_id", "event_type", "message",
  "safe_event_payload_json", "actor_id", "created_at",
] as const satisfies ReadonlyArray<keyof AgentBetaReadinessEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// playbook_snapshots
// Source: 20260816000000_playbook_engine_materialization_phase1.sql
// Header/provenance row for one run of generatePlaybookGovernanceSnapshot()
// (src/lib/playbook-engine/governance-snapshot-engine.ts). The engine itself
// stays pure/in-memory; this is the materialization layer's persisted anchor.
// ─────────────────────────────────────────────────────────────────────────────

export type PlaybookSnapshotStatus = "generated";

export type PlaybookSnapshotRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  fingerprint: string;
  playbook_id: string;
  playbook_version: string;
  status: PlaybookSnapshotStatus;
  generated_at: string;
  source_context_hash: string | null;
  rules_summary: Record<string, unknown>;
  missing_evidence_summary: unknown[];
  approval_required_summary: Record<string, unknown>;
  next_best_actions: unknown[];
  demo_summary: Record<string, unknown>;
  snapshot_payload: Record<string, unknown>;
  content_stale: boolean;
  created_at: string;
  updated_at: string;
};

export const PLAYBOOK_SNAPSHOT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "fingerprint",
  "playbook_id",
  "playbook_version",
  "status",
  "generated_at",
  "source_context_hash",
  "rules_summary",
  "missing_evidence_summary",
  "approval_required_summary",
  "next_best_actions",
  "demo_summary",
  "snapshot_payload",
  "content_stale",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof PlaybookSnapshotRow>;

// ─────────────────────────────────────────────────────────────────────────────
// playbook_recommendations
// Source: 20260816000000_playbook_engine_materialization_phase1.sql
// Mirrors PlaybookRecommendationStatus (recommendation-state.ts) exactly.
// Content is only regenerable while status='new' — see
// src/lib/playbook-engine/materialization-mappers.ts (shouldPreserveHumanState).
// ─────────────────────────────────────────────────────────────────────────────

export type PlaybookRecommendationRowStatus =
  | "new"
  | "viewed"
  | "accepted"
  | "dismissed"
  | "converted_to_task"
  | "converted_to_draft"
  | "requires_approval"
  | "approved"
  | "executed";

export type PlaybookRecommendationRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  snapshot_id: string | null;
  fingerprint: string;
  playbook_rule_id: string;
  title: string;
  status: PlaybookRecommendationRowStatus;
  severity: "low" | "medium" | "high" | "critical";
  phase: string | null;
  detected_situation: string | null;
  recommended_action: string | null;
  approval_required: boolean;
  evidence_used: unknown[];
  missing_evidence: unknown[];
  suggested_actions: unknown[];
  explanation: Record<string, unknown>;
  recommendation_payload: Record<string, unknown>;
  content_stale: boolean;
  viewed_at: string | null;
  accepted_at: string | null;
  dismissed_at: string | null;
  approved_at: string | null;
  executed_at: string | null;
  reviewed_by: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
};

export const PLAYBOOK_RECOMMENDATION_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "snapshot_id",
  "fingerprint",
  "playbook_rule_id",
  "title",
  "status",
  "severity",
  "phase",
  "detected_situation",
  "recommended_action",
  "approval_required",
  "evidence_used",
  "missing_evidence",
  "suggested_actions",
  "explanation",
  "recommendation_payload",
  "content_stale",
  "viewed_at",
  "accepted_at",
  "dismissed_at",
  "approved_at",
  "executed_at",
  "reviewed_by",
  "approved_by",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof PlaybookRecommendationRow>;

// ─────────────────────────────────────────────────────────────────────────────
// playbook_audit_events
// Source: 20260816000000_playbook_engine_materialization_phase1.sql
// Append-only trail of what the Playbook Engine evaluated/generated — never an
// executed action. Deduplicated by fingerprint, insert-only (no update/delete
// RLS policy exists for this table). NOT materialized to platform_events yet
// (see docs/playbook-engine-materialization-design.md §8 for the blocking
// event_payload/payload schema divergence).
// ─────────────────────────────────────────────────────────────────────────────

export type PlaybookAuditEventRelatedEntityType =
  | "rules_evaluation"
  | "project_constitution_draft"
  | "recommendation"
  | "communication_draft"
  | "operational_draft"
  | "closure_billing_assessment"
  | "closure_billing_blocker"
  | "closure_billing_next_action"
  | "governance_snapshot";

export type PlaybookAuditEventRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  snapshot_id: string | null;
  related_entity_type: PlaybookAuditEventRelatedEntityType;
  related_entity_id: string;
  fingerprint: string;
  event_type: string;
  actor_type: "system" | "ai" | "user";
  actor_id: string | null;
  severity: "info" | "low" | "medium" | "high" | "critical";
  summary: string;
  evidence_used: unknown[];
  missing_evidence: unknown[];
  approval_required: boolean;
  metadata: Record<string, unknown>;
  audit_payload: Record<string, unknown>;
  created_at: string;
};

export const PLAYBOOK_AUDIT_EVENT_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "snapshot_id",
  "related_entity_type",
  "related_entity_id",
  "fingerprint",
  "event_type",
  "actor_type",
  "actor_id",
  "severity",
  "summary",
  "evidence_used",
  "missing_evidence",
  "approval_required",
  "metadata",
  "audit_payload",
  "created_at",
] as const satisfies ReadonlyArray<keyof PlaybookAuditEventRow>;

// ─────────────────────────────────────────────────────────────────────────────
// workspace_onboarding_preferences
// Source: 20260829000000_workspace_onboarding_preferences.sql
//
// Per-user, per-workspace DISPLAY preferences for the guided onboarding
// panel (collapse / dismiss / skipped optional steps / version seen) plus
// the insights first-view interaction event. Never stores derived
// activation progress — progress is always computed from real rows.
// ─────────────────────────────────────────────────────────────────────────────

export type WorkspaceOnboardingPreferenceRow = {
  id: string;                        // uuid
  workspace_id: string;              // uuid references workspaces
  user_id: string;                   // uuid references auth.users
  onboarding_version: number;        // integer not null default 1
  collapsed: boolean;                // boolean not null default false
  dismissed_at: string | null;       // timestamptz
  skipped_step_ids: string[];        // text[] not null default '{}' (max 32)
  insights_first_viewed_at: string | null; // timestamptz
  created_at: string;                // timestamptz
  updated_at: string;                // timestamptz
};

export const WORKSPACE_ONBOARDING_PREFERENCE_SELECTABLE_COLUMNS = [
  "id",
  "workspace_id",
  "user_id",
  "onboarding_version",
  "collapsed",
  "dismissed_at",
  "skipped_step_ids",
  "insights_first_viewed_at",
  "created_at",
  "updated_at",
] as const satisfies ReadonlyArray<keyof WorkspaceOnboardingPreferenceRow>;

export const DATABASE_CONTRACT_VERSION ="2026-06-18-platform-events-execution-tasks-decision-effectiveness-pattern-extraction-foundation-personal-pm-patterns-personal-pm-effectiveness-personal-pattern-extraction-foundation-constitutional-brief-executive-brief-governance-brief-operational-brief-portfolio-brief-constitutional-dashboard-constitutional-workspace-execution-augmentation-constitutional-intelligence-context-engine-constitutional-intelligence-intelligence-bridge-constitutional-intelligence-intelligence-bridge-2026-06-24-project-constitution-amendment-governance-2026-06-25-project-constitutional-decision-governance-2026-06-26-constitutional-ratification-framework-2026-06-27-authority-registry-governance-2026-06-19-constitutional-digest-engine-2026-06-28-programs-2026-06-29-program-hierarchy-2026-06-21-program-roadmap-sources-2026-06-30-program-roadmap-parse-results-2026-07-02-program-execution-board-2026-07-03-program-card-context-projection-2026-06-22-constitutional-learning-engine-2026-06-22-sovereign-recommendation-engine-2026-06-22-recommendation-effectiveness-engine-2026-07-04-governance-signal-engine-2026-07-05-governance-action-engine-2026-07-06-governance-commitment-engine-2026-07-07-execution-projection-engine-2026-07-08-execution-reality-engine-2026-07-09-project-operating-system-2026-07-10-operational-command-center-2026-07-11-operational-consequence-engine-2026-07-12-operational-decision-engine-2026-07-13-operational-decision-outcome-engine-2026-07-15-pm-performance-engine-2026-07-17-pmo-governance-compliance-engine-2026-07-18-pmo-command-center-2026-07-19-pmo-intervention-action-loop-2026-07-25-pmo-executive-reporting-2026-07-26-agent-tool-registry-2026-07-27-agent-permission-approval-layer-2026-07-28-agent-memory-context-layer-2026-07-29-agent-observability-audit-trail-2026-07-30-agent-execution-request-runtime-agent-tool-execution-adapter-layer-agent-execution-results-evidence-layer-agent-human-review-action-inbox-controlled-action-conversion-approval-bridge-controlled-execution-finalization-adapter-dispatch-gate-controlled-execution-result-reconciliation-human-outcome-review-controlled-execution-learning-signals-governance-feedback-loop-controlled-pmo-governance-intelligence-dashboard-pmo-governance-proposal-review-controlled-policy-change-backlog-controlled-governance-policy-simulation-report-pmo-approval-pack-controlled-policy-implementation-planning-workspace-controlled-policy-implementation-gate-dry-run-change-executor-controlled-policy-version-activation-rollback-gate-controlled-project-intelligence-handoff-end-to-end-governance-runtime-integration-production-hardening-beta-onboarding-demo-data-tenant-readiness-2026-08-16-playbook-engine-materialization-phase1-2026-08-30-first-execution-experience-direct-task-creation" as const;
