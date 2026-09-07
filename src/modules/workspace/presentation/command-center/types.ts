import type { ExecutionOperation, GovernedExecutionChain } from "./execution-read-model";

export type StatusTone = "danger" | "task" | "approval" | "insight" | "success" | "info";

export type ToneBadge = {
  tone: StatusTone;
  label: string;
};

export type ProjectListItem = {
  id: string;
  code: string;
  name: string;
  fullName: string;
  badges: ToneBadge[];
  /** True only once real project intelligence (a governance brief) has been evaluated and found no issues. */
  healthy?: boolean;
  /** Whether a governance brief has been evaluated for this project yet. False means "unknown", not "healthy". */
  hasIntelligence?: boolean;
};

export type RepositoryItem = {
  id: string;
  label: string;
  icon: "document" | "mail" | "notes" | "chat" | "attachment" | "decision" | "commitment" | "evidence";
  count?: number;
};

export type MemoryItem = {
  id: string;
  label: string;
};

export type DrawerAction = {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
};

/** One labelled key/value row of real persisted provenance. Values are already redacted and
 *  truncated by the read model — no raw payloads, secrets or provider errors reach this type. */
export type DetailRow = {
  label: string;
  value: string;
};

/** A collapsible technical disclosure section beneath the plain-language summary. */
export type DetailSection = {
  id: string;
  title: string;
  rows: DetailRow[];
};

/** A single canonical Decision status the actor may or may not record. `allowed` comes from the
 *  server-evaluated `actor_authority` map for that exact status — never from a client role check. */
export type DecisionControl = {
  /** The canonical status posted to `record_decision`, e.g. "accepted" / "escalated". */
  status: string;
  label: string;
  /** What recording this status actually does to the Recommendation. */
  effect: string;
  terminal: boolean;
  allowed: boolean;
  /** Why this specific status is unavailable. Null when allowed. */
  deniedExplanation: string | null;
};

/** A Decision already persisted against this Recommendation. */
export type RecordedDecision = {
  decisionId: string;
  decisionStatus: string;
  terminal: boolean;
  rationale: string | null;
  decidedBy: string | null;
  recordedAt: string | null;
  authorityBasis: string | null;
  evidenceSnapshot: string | null;
};

/**
 * The decision experience attached to an attention item. `kind` keeps the canonical governed
 * path and the RAID-derived bounded path visibly and semantically distinct — they are different
 * business objects with different write paths and different authority language.
 */
export type DecisionPanel = {
  kind: "governed_recommendation" | "raid_suggestion";
  /** Canonical Recommendation id (governed) or RAID recommended-action id (bounded). */
  subjectId: string;
  /** Short label for the write path, shown so a PM can tell what a decision here records. */
  writePathLabel: string;
  controls: DecisionControl[];
  /** True when the actor may record at least one status. */
  anyAllowed: boolean;
  /** Shown when the actor may inspect but not decide. */
  readOnlyNote: string | null;
  /** Set when the item cannot be safely evaluated at all (e.g. supporting evidence missing). */
  blockedReason: string | null;
  /** Records the decision. Rejects on failure so the drawer can stay open and show the error. */
  onDecide: (status: string, rationale: string) => Promise<void>;
  /** Whether a free-text rationale is required before submitting. */
  requiresRationale: boolean;
  decisions: RecordedDecision[];
};

export type DrawerContent = {
  title: string;
  why: string;
  evidence: string[];
  /** What PMFreak proposes the PM do, in the source's own words. For a governed item this
   *  is the canonical Recommendation text. Absent when the source has no separate
   *  recommendation, and `nextStep` then carries it. */
  recommendation?: string;
  /** Procedural caveat that qualifies the recommendation — what recording a decision does
   *  and does not do, what authority it needs. Rendered beneath the recommendation, never
   *  as the recommendation. */
  nextStep: string;
  /** Real actions (e.g. on an agent card). No buttons are shown when omitted. */
  actions?: DrawerAction[];
  /** e.g. "Requires an authorized decision-maker for: ..." shown below the actions. */
  note?: string;
  /** Type badge (e.g. "Governed · decision required" vs "Suggestion · extracted intelligence"). */
  badge?: ToneBadge;
  /** One-line statement of what kind of business object this is. */
  kindSummary?: string;
  /** The Evidence -> Finding -> Governance -> Recommendation chain, in plain language. */
  chain?: DetailRow[];
  /** Collapsible technical provenance / evidence-quality disclosure. */
  sections?: DetailSection[];
  /** Present only for items backed by a real recommendation or suggested action. */
  decisionPanel?: DecisionPanel;
  /** P2-12: the governed continuation after a Decision — action, task, execution,
   *  outcome, observation and lineage. Present only for a decided canonical chain. */
  executionPanel?: ExecutionPanel;
};

/** P2-12 continuation surface inputs. `onRun` must reject on failure so the panel can
 *  show the real error rather than reporting optimistic success. */
export type ExecutionPanel = {
  chain: GovernedExecutionChain;
  evidenceOptions: Array<{ id: string; title: string }>;
  onRun: (operation: ExecutionOperation) => Promise<void>;
  /** A governed write was accepted but the follow-up summary read failed, so what is shown
   *  below may be stale. This is a READ condition — it never means the write failed. */
  refreshFailedAfterWrite?: boolean;
  /** Retry just the read. */
  onRetryRefresh?: () => void;
};

export type NeedsYouItem = {
  id: string;
  title: string;
  badge: ToneBadge;
  drawer: DrawerContent;
  /** Distinguishes the canonical governed path from the RAID-derived bounded path. */
  kind?: "governed_recommendation" | "raid_suggestion";
  /** Present when this item is backed by a real operational-flow recommendation awaiting a decision. */
  recommendationId?: string;

  /* ── Card presentation (UX-W3) ───────────────────────────────────────────────
   * Every field below is projected from data the source already carries. None is
   * generated, inferred from sentiment, or defaulted to a plausible-sounding value:
   * where the source has nothing to say, the field is absent and the card omits that
   * line rather than filling it in. `title` keeps its existing meaning for the drawer
   * and every existing consumer. */

  /** Card headline: what happened, in the PM's words. Falls back to `title` when the
   *  source carries no separate subject. */
  subject?: string;
  /** Canonical severity of the underlying finding, e.g. "high". Absent when the source
   *  records none — a card then shows no severity rather than an invented one. */
  severity?: string | null;
  /** One short PM-facing reason this needs judgment. */
  whyItMatters?: string;
  /** One compact line of supporting evidence. Never a hash, id or lineage internal. */
  evidenceSummary?: string | null;
  /** What PMFreak proposes the PM do. Absent when the source's recommendation is the
   *  headline itself, so the card does not print the same sentence twice. */
  recommendation?: string | null;
};

export type AgentActivity = "pulsing" | "shimmer" | "progress" | "idle";

export type Agent = {
  id: string;
  name: string;
  statusText: string;
  badge: ToneBadge;
  activity: AgentActivity;
  drawer: DrawerContent;
};

/** Sprint 8 Conversational Brain Gateway diagnostics carried alongside an assistant message.
 * Kept loosely typed (plain strings) rather than importing the Playbook Engine's own unions so
 * this UI-facing type doesn't couple tightly to the domain layer's vocabulary. Only rendered in
 * a dev-only debug panel today — see `command-feed.tsx`. */
export type ChatGatewayMeta = {
  intent: string;
  route: string;
  mode: string;
  confidence: number;
  requiresApproval: boolean;
  auditRelevant: boolean;
  missingContext: string[];
  recommendedNextSteps: string[];
};

export type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  structuredList?: string[];
  sources?: string[];
  suggestedActions?: string[];
  /** Present only on assistant messages produced by the Conversational Brain Gateway. */
  gatewayMeta?: ChatGatewayMeta;
};

export type TopBarStat = {
  label: string;
  tone: StatusTone;
};
