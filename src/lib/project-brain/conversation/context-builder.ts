// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — the ONE canonical context builder (PB-CHAT-01)
//
//   workspaceId + projectId (server-derived, authorized)
//           ↓
//   getOperationalSummary(...)            canonical operational read model
//   + projects row                        identity + onboarding answers
//   + project_milestones (bounded)        schedule
//   + execution_tasks   (bounded)         non-governed project tasks
//   + raid_items        (bounded, open)   DISCOVERY data, labelled as such
//           ↓
//   assembleProjectBrainContext(...)      pure: scope-guard, label, trust, bound
//           ↓
//   ProjectBrainContext                   source-addressable, budgeted
//
// It never reads another project, company-scoped legacy project memory, vault
// nutrients, operational/intervention memory, or any model-output store. Every
// read is filtered by BOTH workspace_id and project_id, and every row is
// re-checked against the scope in memory before it can become a source.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { getOperationalSummary } from "@/lib/operational-flow/operational-flow-service";
import type { OperationalSummary } from "@/lib/operational-flow/types";
import { toProjectBrainOnboardingSnapshot } from "@/lib/projects/onboarding-snapshot";
import { sourceReferenceFromEvidenceItem, sourceReferenceFromProjectConfiguration, type EvidenceItemSourceType } from "../source-reference";
import type { ProjectBrainSourceReference, ProjectBrainSourceSystem, ProjectContextScope, SourceAuthorityLevel } from "../types";
import {
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_SOURCES,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_SOURCE_CONTENT_CHARS,
  SOURCE_FAMILY_BUDGET,
  SUPPLEMENTAL_READ_LIMIT,
} from "./context-budget";
import type {
  ProjectBrainContext,
  ProjectBrainContextSource,
  ProjectBrainHistoryMessage,
  ProjectBrainSourceFamily,
  ProjectBrainTrust,
} from "./context-types";

type Row = Record<string, unknown>;

/** Everything the builder reads, before any shaping. `null` = that read failed. */
export type ProjectBrainRawContext = {
  scope: ProjectContextScope;
  project: Row | null;
  summary: OperationalSummary | null;
  milestones: Row[] | null;
  tasks: Row[] | null;
  raidItems: Row[] | null;
  history: ProjectBrainHistoryMessage[];
};

const TRUST_AUTHORITY: Record<ProjectBrainTrust, SourceAuthorityLevel> = {
  RECORD: "primary",
  SELF_REPORTED: "secondary",
  DERIVED: "secondary",
  UNVERIFIED: "unverified",
};

const CLOSED_STATUSES = new Set(["closed", "resolved", "completed", "cancelled", "canceled", "done", "archived", "superseded", "dismissed", "rejected"]);

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function joinParts(parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
}

function dateOnly(value: unknown): string | null {
  const text = str(value);
  return text ? text.slice(0, 10) : null;
}

function inScope(row: Row, scope: ProjectContextScope): boolean {
  return row.workspace_id === scope.workspaceId && row.project_id === scope.projectId;
}

function isOpen(row: Row): boolean {
  const status = str(row.status)?.toLowerCase();
  return !status || !CLOSED_STATUSES.has(status);
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
function severityRank(row: Row): number {
  return SEVERITY_RANK[str(row.severity)?.toLowerCase() ?? str(row.priority)?.toLowerCase() ?? ""] ?? 4;
}

/** Open first, then most severe, then input order (the reads are already newest-first). */
function prioritize(rows: Row[]): Row[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => Number(isOpen(b.row)) - Number(isOpen(a.row)) || severityRank(a.row) - severityRank(b.row) || a.index - b.index)
    .map((entry) => entry.row);
}

type Candidate = Omit<ProjectBrainContextSource, "alias">;

function recordReference(input: {
  scope: ProjectContextScope;
  system: ProjectBrainSourceSystem;
  row: Row;
  family: ProjectBrainSourceFamily;
  trust: ProjectBrainTrust;
  title: string;
  content: string;
  recordedAtKeys?: string[];
}): ProjectBrainSourceReference {
  const authorityLevel = TRUST_AUTHORITY[input.trust];
  const recordedAt =
    (input.recordedAtKeys ?? ["updated_at", "recorded_at", "created_at"]).map((key) => str(input.row[key])).find(Boolean) ?? "";
  return {
    evidenceId: `${input.system}:${String(input.row.id)}`,
    sourceSystem: input.system,
    title: input.title,
    evidenceType: input.family,
    recordedAt,
    excerpt: input.content ? clip(input.content, 240) : null,
    author: null,
    authorityLevel,
    isPrimary: authorityLevel === "primary",
    href: null,
    workspaceId: input.scope.workspaceId,
    projectId: input.scope.projectId,
  };
}

function candidate(
  scope: ProjectContextScope,
  family: ProjectBrainSourceFamily,
  trust: ProjectBrainTrust,
  system: ProjectBrainSourceSystem,
  row: Row,
  label: string,
  content: string,
  recordedAtKeys?: string[],
): Candidate {
  const boundedLabel = clip(label, 120);
  const boundedContent = clip(content, MAX_SOURCE_CONTENT_CHARS);
  return {
    family,
    trust,
    label: boundedLabel,
    content: boundedContent,
    reference: recordReference({ scope, system, row, family, trust, title: boundedLabel, content: boundedContent, recordedAtKeys }),
  };
}

// ─── Per-family shaping ─────────────────────────────────────────────────────

function projectCandidates(scope: ProjectContextScope, project: Row | null): Candidate[] {
  if (!project || project.id !== scope.projectId || project.workspace_id !== scope.workspaceId) return [];
  const name = str(project.name) ?? "Untitled project";
  const content = joinParts([
    `Project "${name}"`,
    `status ${str(project.status) ?? "unknown"}`,
    dateOnly(project.created_at) ? `created ${dateOnly(project.created_at)}` : null,
    str(project.description) ? `description: ${str(project.description)}` : null,
  ]);
  return [candidate(scope, "PROJECT", "RECORD", "projects", project, `Project record — ${name}`, content, ["updated_at", "created_at"])];
}

const ONBOARDING_FIELDS: Array<{ key: string; label: string; read: (s: NonNullable<ReturnType<typeof toProjectBrainOnboardingSnapshot>>) => string }> = [
  { key: "deliveryContext.problemStatement", label: "Problem statement", read: (s) => s.deliveryContext.problemStatement },
  { key: "deliveryContext.mainDeliverable", label: "Main deliverable", read: (s) => s.deliveryContext.mainDeliverable },
  { key: "identity.targetDeliveryDate", label: "Target delivery date", read: (s) => s.identity.targetDeliveryDate },
  { key: "identity.pmAssigned", label: "Assigned PM", read: (s) => s.identity.pmAssigned },
  { key: "identity.technicalLead", label: "Technical lead", read: (s) => s.identity.technicalLead },
  { key: "deliveryContext.contractualMilestones", label: "Contractual milestones", read: (s) => s.deliveryContext.contractualMilestones },
  { key: "deliveryContext.externalDependencies", label: "External dependencies", read: (s) => s.deliveryContext.externalDependencies },
  { key: "discovery.unknowns", label: "Known unknowns", read: (s) => s.discovery.unknowns },
  { key: "discovery.pendingClientDependencies", label: "Pending client dependencies", read: (s) => s.discovery.pendingClientDependencies },
  { key: "discovery.vendorDependencies", label: "Vendor dependencies", read: (s) => s.discovery.vendorDependencies },
  { key: "discovery.financialBlockers", label: "Financial blockers", read: (s) => s.discovery.financialBlockers },
];

function onboardingCandidates(scope: ProjectContextScope, project: Row | null): Candidate[] {
  if (!project || project.id !== scope.projectId || project.workspace_id !== scope.workspaceId) return [];
  const snapshot = toProjectBrainOnboardingSnapshot(project.onboarding_payload);
  if (!snapshot) return [];
  const recordedAt = str(project.created_at) ?? "";
  const out: Candidate[] = [];
  for (const field of ONBOARDING_FIELDS) {
    const value = field.read(snapshot)?.trim();
    if (!value) continue;
    const label = `Project setup — ${field.label}`;
    const content = clip(value, MAX_SOURCE_CONTENT_CHARS);
    // The setup form is the system of record for what was TYPED, not for the
    // world: every field is SELF_REPORTED (secondary), per derive-initial-response.ts.
    const reference = {
      ...sourceReferenceFromProjectConfiguration(
        { projectId: scope.projectId, workspaceId: scope.workspaceId, fieldKey: field.key, fieldLabel: label, recordedAt },
        { authorityLevel: "secondary" },
      ),
      evidenceType: "ONBOARDING",
      excerpt: clip(content, 240),
    };
    out.push({ family: "ONBOARDING", trust: "SELF_REPORTED", label, content, reference });
  }
  return out;
}

const EVIDENCE_SOURCE_TYPES = new Set<EvidenceItemSourceType>(["manual_note", "email", "meeting_minutes", "ticket", "conversation", "document_reference"]);

function evidenceCandidates(scope: ProjectContextScope, summary: OperationalSummary): Candidate[] {
  return summary.evidence.filter((row) => inScope(row, scope)).map((row) => {
    const sample = str(row.fixture_state) !== null && str(row.fixture_state) !== "LIVE";
    const title = str(row.title) ?? "Untitled evidence";
    const sourceType = str(row.source_type) as EvidenceItemSourceType | null;
    const label = `Evidence — ${title}${sample ? " (sample data)" : ""}`;
    const content = joinParts([
      sourceType ? sourceType.replaceAll("_", " ") : null,
      str(row.freshness_state) ? `freshness ${String(row.freshness_state).toLowerCase()}` : null,
      str(row.content),
    ]);
    const trust: ProjectBrainTrust = sample ? "UNVERIFIED" : "RECORD";
    const base = candidate(scope, "EVIDENCE", trust, "evidence_items", row, label, content);
    if (!sample && sourceType && EVIDENCE_SOURCE_TYPES.has(sourceType)) {
      // Reuse the Sprint 0 adapter so evidence authority stays centrally defined
      // (a manual note is secondary, meeting minutes are primary, …).
      const reference = sourceReferenceFromEvidenceItem(
        {
          id: String(row.id),
          workspace_id: scope.workspaceId,
          project_id: scope.projectId,
          source_type: sourceType,
          title: base.label,
          content: base.content,
          created_at: str(row.created_at) ?? "",
        },
        { excerptLength: 240 },
      );
      return {
        ...base,
        trust: reference.isPrimary ? "RECORD" : "SELF_REPORTED",
        reference: { ...reference, evidenceId: `evidence_items:${String(row.id)}`, evidenceType: "EVIDENCE" },
      };
    }
    return base;
  });
}

function signalCandidates(scope: ProjectContextScope, summary: OperationalSummary): Candidate[] {
  return summary.signals.filter((row) => inScope(row, scope)).map((row) => {
    const type = str(row.signal_type)?.replaceAll("_", " ") ?? "signal";
    return candidate(scope, "SIGNAL", "DERIVED", "operational_signals", row, `Signal — ${type}`, joinParts([
      str(row.severity) ? `severity ${row.severity}` : null,
      str(row.status) ? `status ${row.status}` : null,
      str(row.summary),
    ]));
  });
}

/** risk_issue_records.type → the label a PM reads. Every canonical type is covered. */
const RISK_ISSUE_TYPE_LABEL: Record<string, string> = {
  risk: "Risk",
  issue: "Issue",
  impediment: "Impediment",
  change: "Change",
  decision_needed: "Decision needed",
};

function riskIssueCandidates(scope: ProjectContextScope, summary: OperationalSummary, family: "RISK" | "ISSUE"): Candidate[] {
  // `risk` is the RISK family; every other governed type (issue, impediment, change,
  // decision_needed) is an ISSUE-family record. None is dropped for having a type
  // other than the two family names.
  const belongs = (row: Row) => (str(row.type)?.toLowerCase() === "risk") === (family === "RISK");
  return prioritize(summary.risksIssues.filter((row) => inScope(row, scope) && belongs(row))).map((row) => {
    const type = str(row.type)?.toLowerCase() ?? "";
    const kind = RISK_ISSUE_TYPE_LABEL[type] ?? (family === "RISK" ? "Risk" : "Issue");
    return candidate(scope, family, "RECORD", "risk_issue_records", row, `${kind} — ${str(row.title) ?? "Untitled"}`, joinParts([
      str(row.status) ? `status ${row.status}` : null,
      str(row.severity) ? `severity ${row.severity}` : null,
      dateOnly(row.due_date) ? `due ${dateOnly(row.due_date)}` : null,
      str(row.description),
    ]));
  });
}

function recommendationCandidates(scope: ProjectContextScope, summary: OperationalSummary): Candidate[] {
  return prioritize(summary.recommendations.filter((row) => inScope(row, scope))).map((row) =>
    candidate(scope, "RECOMMENDATION", "RECORD", "recommended_actions", row, `Recommendation — ${str(row.title) ?? "Untitled"}`, joinParts([
      str(row.status) ? `status ${row.status}` : null,
      str(row.impact_level) ? `impact ${row.impact_level}` : null,
      str(row.description),
    ])),
  );
}

function decisionCandidates(scope: ProjectContextScope, summary: OperationalSummary): Candidate[] {
  return summary.decisions.filter((row) => inScope(row, scope)).map((row) =>
    candidate(scope, "DECISION", "RECORD", "operational_decision_records", row, `Decision — ${clip(str(row.decision) ?? "Recorded decision", 80)}`, joinParts([
      str(row.decision_status) ? `status ${String(row.decision_status).replaceAll("_", " ")}` : null,
      dateOnly(row.created_at) ? `recorded ${dateOnly(row.created_at)}` : null,
      str(row.rationale) ? `rationale: ${row.rationale}` : null,
    ]), ["created_at"]),
  );
}

function actionCandidates(scope: ProjectContextScope, summary: OperationalSummary): Candidate[] {
  return summary.materialActions.filter((row) => inScope(row, scope)).map((row) => {
    const proposal = (row.proposal ?? {}) as Row;
    const kind = str(proposal.actionType) ?? str(row.action_class) ?? "governed action";
    return candidate(scope, "ACTION", "RECORD", "material_action_proposals", row, `Governed action — ${kind.replaceAll("_", " ")}`, joinParts([
      str(row.materiality) ? `materiality ${row.materiality}` : null,
      dateOnly(row.expires_at) ? `expires ${dateOnly(row.expires_at)}` : null,
      str(proposal.title) ?? str(proposal.summary) ?? str(proposal.description),
    ]), ["persisted_at", "created_at"]);
  });
}

function taskCandidates(scope: ProjectContextScope, summary: OperationalSummary | null, extra: Row[] | null): Candidate[] {
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const row of [...(summary?.tasks ?? []), ...(extra ?? [])]) {
    const id = String(row.id);
    if (!inScope(row, scope) || seen.has(id)) continue;
    seen.add(id);
    rows.push(row);
  }
  return prioritize(rows).map((row) =>
    candidate(scope, "TASK", "RECORD", "execution_tasks", row, `Task — ${str(row.title) ?? "Untitled"}`, joinParts([
      str(row.status) ? `status ${String(row.status).replaceAll("_", " ")}` : null,
      str(row.priority) ? `priority ${row.priority}` : null,
      dateOnly(row.due_date) ? `due ${dateOnly(row.due_date)}` : null,
      str(row.owner_name) ? `owner ${row.owner_name}` : null,
      typeof row.progress_percent === "number" ? `${row.progress_percent}% complete` : null,
    ])),
  );
}

function outcomeCandidates(scope: ProjectContextScope, summary: OperationalSummary): Candidate[] {
  const outcomes = (summary.outcomes ?? []).filter((row) => inScope(row, scope)).map((row) =>
    candidate(scope, "OUTCOME", "RECORD", "canonical_task_outcomes", row, "Expected outcome", joinParts([
      str(row.state) ? `state ${String(row.state).replaceAll("_", " ")}` : null,
      str(row.expected_result),
    ])),
  );
  const observations = (summary.observations ?? []).filter((row) => inScope(row, scope)).map((row) =>
    candidate(scope, "OUTCOME", "RECORD", "canonical_outcome_observations", row, "Outcome observation", joinParts([
      str(row.observation_state) ? `observed ${row.observation_state}` : null,
      str(row.summary),
    ]), ["recorded_at", "observed_at"]),
  );
  return [...observations, ...outcomes];
}

function milestoneCandidates(scope: ProjectContextScope, milestones: Row[]): Candidate[] {
  return prioritize(milestones.filter((row) => inScope(row, scope))).map((row) =>
    candidate(scope, "MILESTONE", "RECORD", "project_milestones", row, `Milestone — ${str(row.title) ?? "Untitled"}`, joinParts([
      str(row.status) ? `status ${String(row.status).replaceAll("_", " ")}` : null,
      dateOnly(row.target_date) ? `target ${dateOnly(row.target_date)}` : null,
      dateOnly(row.forecast_date) ? `forecast ${dateOnly(row.forecast_date)}` : null,
      dateOnly(row.completed_at) ? `completed ${dateOnly(row.completed_at)}` : null,
      str(row.description),
    ])),
  );
}

function raidDiscoveryCandidates(scope: ProjectContextScope, raidItems: Row[]): Candidate[] {
  // Discovery/legacy RAID is auto-extracted suggestion data. It is NEVER merged
  // with governed risk_issue_records: it carries its own family and UNVERIFIED trust.
  return raidItems.filter((row) => inScope(row, scope) && isOpen(row)).map((row) =>
    candidate(scope, "RAID_DISCOVERY", "UNVERIFIED", "raid_items", row, `Discovery ${str(row.category) ?? "item"} — ${str(row.title) ?? "Untitled"}`, joinParts([
      str(row.status) ? `status ${row.status}` : null,
      str(row.owner) ? `owner ${row.owner}` : null,
      dateOnly(row.due_date) ? `due ${dateOnly(row.due_date)}` : null,
      str(row.description),
    ]), ["last_detected_at", "detected_at"]),
  );
}

function boundHistory(history: ProjectBrainHistoryMessage[]): ProjectBrainHistoryMessage[] {
  return history.slice(-MAX_HISTORY_MESSAGES).map((message) => ({
    role: message.role,
    createdAt: message.createdAt,
    content: clip(message.content, MAX_HISTORY_MESSAGE_CHARS),
  }));
}

/** Rough serialized size of one source, matching prompt.ts's layout closely enough to budget on. */
export function estimateSourceChars(source: Candidate): number {
  return source.label.length + source.content.length + 96;
}

/**
 * Pure: raw reads → budgeted, source-addressable context. Deterministic for a
 * given input, so the same project state always yields the same aliases.
 */
export function assembleProjectBrainContext(raw: ProjectBrainRawContext): ProjectBrainContext {
  const { scope } = raw;
  const unavailable: ProjectBrainSourceFamily[] = [];
  const byFamily = new Map<ProjectBrainSourceFamily, Candidate[]>();
  const put = (family: ProjectBrainSourceFamily, rows: Candidate[] | null) => {
    if (rows === null) unavailable.push(family);
    else byFamily.set(family, rows);
  };

  put("PROJECT", raw.project ? projectCandidates(scope, raw.project) : null);
  put("ONBOARDING", raw.project ? onboardingCandidates(scope, raw.project) : null);
  const summary = raw.summary;
  put("EVIDENCE", summary ? evidenceCandidates(scope, summary) : null);
  put("SIGNAL", summary ? signalCandidates(scope, summary) : null);
  put("RISK", summary ? riskIssueCandidates(scope, summary, "RISK") : null);
  put("ISSUE", summary ? riskIssueCandidates(scope, summary, "ISSUE") : null);
  put("RECOMMENDATION", summary ? recommendationCandidates(scope, summary) : null);
  put("DECISION", summary ? decisionCandidates(scope, summary) : null);
  put("ACTION", summary ? actionCandidates(scope, summary) : null);
  put("OUTCOME", summary ? outcomeCandidates(scope, summary) : null);
  put("TASK", summary === null && raw.tasks === null ? null : taskCandidates(scope, summary, raw.tasks));
  put("MILESTONE", raw.milestones ? milestoneCandidates(scope, raw.milestones) : null);
  put("RAID_DISCOVERY", raw.raidItems ? raidDiscoveryCandidates(scope, raw.raidItems) : null);

  let truncated = false;
  const selected: Candidate[] = [];
  let chars = 0;
  for (const { family, max } of SOURCE_FAMILY_BUDGET) {
    const rows = byFamily.get(family) ?? [];
    if (rows.length > max) truncated = true;
    for (const row of rows.slice(0, max)) {
      const size = estimateSourceChars(row);
      if (selected.length >= MAX_CONTEXT_SOURCES || chars + size > MAX_CONTEXT_CHARS) {
        truncated = true;
        continue;
      }
      selected.push(row);
      chars += size;
    }
  }

  const projectName = str(raw.project?.name) ?? "this project";
  return {
    scope,
    projectName,
    sources: selected.map((source, index) => ({ ...source, alias: `S${index + 1}` })),
    unavailable,
    truncated,
    history: boundHistory(raw.history),
  };
}

async function settle<T>(work: () => PromiseLike<T>, label: string, scope: ProjectContextScope): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    // Scoped identifiers and the failure class only — never row content.
    console.error(
      JSON.stringify({
        event: "project_brain.context_read_failed",
        family: label,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
    return null;
  }
}

async function rows(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

/**
 * Loads and assembles the context with the CALLER'S request-scoped client, so
 * RLS applies on top of the explicit scope filters. One failed read degrades its
 * own family (reported to the model as unavailable) — never the whole turn.
 */
export async function loadProjectBrainContext(input: {
  client: SupabaseClient;
  scope: ProjectContextScope;
  userId: string;
  history: ProjectBrainHistoryMessage[];
}): Promise<ProjectBrainContext> {
  const { client, scope, userId } = input;
  const { workspaceId, projectId } = scope;
  const [project, summary, milestones, tasks, raidItems] = await Promise.all([
    settle(async () => {
      const { data, error } = await client
        .from("projects")
        .select("id, workspace_id, name, description, status, created_at, updated_at, onboarding_payload")
        .eq("workspace_id", workspaceId)
        .eq("id", projectId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as Row | null;
    }, "PROJECT", scope),
    settle(() => getOperationalSummary(client, workspaceId, projectId, userId), "OPERATIONAL_SUMMARY", scope),
    settle(() => rows(client.from("project_milestones").select("id, workspace_id, project_id, title, description, status, target_date, forecast_date, completed_at, created_at, updated_at").eq("workspace_id", workspaceId).eq("project_id", projectId).order("target_date", { ascending: true, nullsFirst: false }).limit(SUPPLEMENTAL_READ_LIMIT)), "MILESTONE", scope),
    settle(() => rows(client.from("execution_tasks").select("id, workspace_id, project_id, title, status, priority, due_date, owner_name, progress_percent, created_at, updated_at").eq("workspace_id", workspaceId).eq("project_id", projectId).order("updated_at", { ascending: false }).limit(SUPPLEMENTAL_READ_LIMIT)), "TASK", scope),
    settle(() => rows(client.from("raid_items").select("id, workspace_id, project_id, category, title, description, status, owner, due_date, detected_at, last_detected_at").eq("workspace_id", workspaceId).eq("project_id", projectId).not("status", "in", "(closed,resolved)").order("last_detected_at", { ascending: false }).limit(SUPPLEMENTAL_READ_LIMIT)), "RAID_DISCOVERY", scope),
  ]);

  return assembleProjectBrainContext({ scope, project, summary, milestones, tasks, raidItems, history: input.history });
}
