/**
 * CHAT-SHELL-01 — the project's right-hand tools, as a table.
 *
 * Derived from what the Command Center, Project Home and the project tab strip
 * actually offered, with the duplicates folded together:
 *
 *   Needs you     governed Recommendations awaiting a Decision + RAID-derived
 *                 suggested actions (risks, issues, dependencies) — one queue,
 *                 because it was one queue on the Command Center
 *   What changed  the project's recent operational signals
 *   In progress   governed work continuing past a recorded Decision
 *   Tasks         the project's execution tasks (Project Home's CRUD)
 *   Schedule      schedule exposure / milestones (P2-16)
 *   Monitoring    what PMFreak watches, and its specialist agents
 *   Evidence      the project repository, memory and notes intake
 *   Project       details, operational overview, documents, settings
 *
 * Operational tools render through ONE shared operational read
 * (`ProjectOperationsInspector`); `tasks` and `project` read nothing of it.
 */

import type { OperationalToolKey } from "@/modules/workspace";

export type ProjectToolKey = OperationalToolKey | "tasks" | "project";

export type ProjectToolDefinition = {
  key: ProjectToolKey;
  label: string;
  /** The rail's compact caption; the full label names the button and the inspector. */
  short: string;
  description: string;
  operational: boolean;
};

export const PROJECT_TOOLS: ProjectToolDefinition[] = [
  { key: "attention", label: "Needs you", short: "Needs you", description: "Decisions and suggested actions waiting on you", operational: true },
  { key: "activity", label: "What changed", short: "Changes", description: "Recent signals from this project's evidence", operational: true },
  { key: "execution", label: "In progress", short: "Progress", description: "Governed work continuing after a decision", operational: true },
  { key: "tasks", label: "Tasks", short: "Tasks", description: "This project's execution tasks", operational: false },
  { key: "schedule", label: "Schedule", short: "Schedule", description: "Schedule exposure and milestones", operational: true },
  { key: "monitoring", label: "Monitoring", short: "Monitor", description: "What PMFreak is watching, and its agents", operational: true },
  { key: "repository", label: "Evidence", short: "Evidence", description: "Project repository, memory and notes", operational: true },
  { key: "project", label: "Project", short: "Project", description: "Details, operational overview, documents, settings", operational: false },
];

const TOOL_KEYS = new Set<string>(PROJECT_TOOLS.map((tool) => tool.key));

/** A `?tool=` value from a URL — untrusted, so anything unknown opens nothing. */
export function parseProjectTool(value: string | string[] | undefined): ProjectToolKey | null {
  const single = Array.isArray(value) ? value[0] : value;
  return single && TOOL_KEYS.has(single) ? (single as ProjectToolKey) : null;
}

export function projectToolDefinition(key: ProjectToolKey): ProjectToolDefinition {
  return PROJECT_TOOLS.find((tool) => tool.key === key) ?? PROJECT_TOOLS[0];
}
