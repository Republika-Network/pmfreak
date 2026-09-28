// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — grounding (PB-EXEC-01, §9.3, §9.5)
//
//   parsed model output (aliases S*/R*, narrative)
//     ↓ per item, in every renderer-bound field:
//         bounds             over-long / surplus items dropped whole, never clipped
//         credential guard   boundary 1 — the item is removed whole (credential-guard.ts)
//         fake precision     any execution-shaped reference nothing supplied → removed whole
//         dangerous command  a command that would change shared state → removed whole
//         aliases            resolved against THIS request's maps, then translated to
//                            stable ids (evidenceId / context_messages.id) and discarded
//         origin             project_record needs a RECORD source, reported needs a
//                            report; otherwise demoted (instructions) or moved (context)
//     ↓ GroundedBrief: stable ids only, plus an honest `unknowns` entry for every
//       removal — naming the KIND of missing detail, never echoing the token
//
// Reuses PB-REASON-01/02 machinery instead of forking it: extractTypedReferences,
// suppliedReferences / suppliedReferenceText (the same notion of "supplied": records,
// today's date, the question, USER turns — never assistant turns, never the selected
// prior recommendation) and normalizeCitationAlias. Adds only the brief-specific
// reference kinds (path, commit SHA, URL, command).
//
// There is deliberately no "keep the prose, drop the token" path: deleting
// "src/billing/" from "Do not modify src/billing/" would invert the instruction.
// Pure: no I/O, no model call.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProjectBrainContext, ProjectBrainContextReport, ProjectBrainContextSource } from "../conversation/context-types";
import { extractTypedReferences, normalizeCitationAlias, suppliedReferences, suppliedReferenceText, type ReferenceKind } from "../conversation/output";
import { narrativeCredentialCategories } from "./credential-guard";
import { EXECUTION_BRIEF_OUTPUT_LIMITS as L, type ExecutionBriefModelOutput } from "./schema";
import type { BriefCitationReport, CapabilityFit, CommandBasis, ExecutionBriefV1, ResolvedExecutionBriefTargetRef, UnknownResolveBy, VerificationKind } from "./types";

// ─── Execution-shaped references ─────────────────────────────────────────────

export type BriefReferenceKind = ReferenceKind | "path" | "sha" | "url" | "command";
type BriefReference = { kind: BriefReferenceKind; token: string };

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]]+/gi;
const PATH_CANDIDATE = /(?:^|[\s(\["'`])((?:[A-Za-z]:\\|\.{1,2}\/|~\/|\/)?[\w@.+-]+(?:[\\/][\w@.+-]*)+)/g;
const CODE_EXTENSIONS = "ts|tsx|js|jsx|mjs|cjs|json|md|mdx|sql|py|rb|go|rs|java|kt|kts|cs|php|yml|yaml|toml|ini|cfg|css|scss|sass|less|html|vue|svelte|sh|bash|ps1|swift|scala|c|h|cc|cpp|hpp|lock|gradle|xml|proto|graphql|tf|dockerfile";
const FILE_NAME = new RegExp(`(?<![\\w/.-])[\\w.-]+\\.(?:${CODE_EXTENSIONS})\\b`, "gi");
const CONVENTIONAL_ROOTS = new Set(["src", "lib", "app", "apps", "packages", "tests", "test", "spec", "docs", "scripts", "supabase", "components", "pages", "api", "config", "public", "bin", "cmd", "internal", "pkg", "migrations", "db", "server", "client", "web", "frontend", "backend", "infra", "deploy", ".github"]);
const SHA_PATTERN = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/gi;
const COMMAND_PATTERNS: RegExp[] = [
  /`([^`\n]{2,200})`/g, // inline code spans that look like commands (filtered below)
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+[\w:.-]+|test|t|install|i|ci|build|start|exec|publish|audit|dlx|add|remove|lint)\b/gi,
  /\bnpx\s+[\w@/.-]+/gi,
  /\b(?:pytest|jest|vitest|mocha|rspec|phpunit)\b/gi,
  /\b(?:cargo|go)\s+(?:test|build|run|check|clippy|fmt|vet|mod)\b/gi,
  /\bgit\s+(?:clone|checkout|switch|commit|push|pull|merge|rebase|reset|fetch|status|diff|log|branch|tag|stash|cherry-pick|revert|apply|clean|worktree|rev-parse|add|rm)\b/gi,
  /\bdocker(?:-compose|\s+compose)?\s+(?:run|build|exec|up|down|push|pull)\b/gi,
  /\b(?:kubectl|helm|terraform|flyway|liquibase)\s+[a-z][\w-]*/gi,
  /\b(?:supabase|prisma|alembic|sequelize|knex)\s+(?:db|migrate|migration|functions|start|stop|link|gen|generate|upgrade|downgrade|revision|seed)\b/gi,
  /\bvercel\s+(?:deploy|--prod|env|pull|build|promote)\b/gi,
  /\b(?:psql|mysql)\s+-/gi,
  /\b(?:curl|wget)\s+\S+/gi,
  /\b(?:pip3?|poetry)\s+(?:install|uninstall|run|add)\b/gi,
  /\b(?:mvn|gradle|\.\/gradlew|dotnet)\s+[a-z][\w:-]*/gi,
  /\b(?:tsc|eslint|prettier)\s+(?:-|\.)/gi,
  /\bplaywright\s+test\b/gi,
  /\bpython3?\s+(?:-m\s+\w+|[\w/.-]+\.py)\b/gi,
  /\bnode\s+[\w/.-]+\.(?:m?js|cjs|ts)\b/gi,
  /\bmake\s+(?:test|build|lint|check|install|all|clean|deploy|release|migrate)\b/gi,
  /\b(?:bash|sh|zsh)\s+[\w/.-]+\.sh\b/gi,
  /\b(?:rails\s+(?:db:\w+|test|generate)|rake\s+[\w:]+|bundle\s+exec)\b/gi,
  /\b(?:rm\s+-\w+|sudo\s+\S+|chmod\s+\S+)/gi,
];
const CLI_START = /^(?:npm|npx|pnpm|yarn|bun|pytest|jest|vitest|cargo|go|git|docker|kubectl|helm|terraform|supabase|vercel|psql|mysql|curl|wget|pip3?|poetry|mvn|gradle|dotnet|tsc|eslint|prettier|playwright|deno|python3?|node|make|bash|sh|zsh|rails|rake|bundle|composer|prisma|alembic|flyway|rm|sudo|chmod)\b/i;

/**
 * Standard identifiers shaped like project codes ("SHA-256", "UTF-8", "ISO-8601",
 * "RFC-3339"). Not project references — unless the project's own records use that
 * code family, in which case the ordinary rule applies.
 */
const STANDARD_CODE_FAMILIES = new Set(["utf", "sha", "iso", "rfc", "http", "tls", "aes", "rsa", "base", "ipv", "es", "ecma", "md", "crc", "oauth", "soc"]);

const collapse = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
const trimToken = (value: string) => value.replace(/[.,;:!?)\]}>'"`]+$/g, "").replace(/\/+$/g, "");

function isPathLike(token: string): boolean {
  if (/^[A-Za-z]:\\/.test(token) || /^(?:\.{1,2}\/|~\/|\/)/.test(token)) return true;
  const segments = token.split(/[\\/]/);
  if (segments.every((s) => /^\d*$/.test(s))) return false; // 10/15/2026
  if (token.endsWith("/") || token.endsWith("\\")) return true;
  if (segments.filter((s) => s.length > 0).length >= 3) return true;
  if (new RegExp(`\\.(?:${CODE_EXTENSIONS})$`, "i").test(segments[segments.length - 1] ?? "")) return true;
  return CONVENTIONAL_ROOTS.has((segments[0] ?? "").toLowerCase());
}

function briefOnlyReferences(text: string): BriefReference[] {
  const found = new Map<string, BriefReference>();
  const add = (kind: BriefReferenceKind, raw: string) => {
    const token = collapse(trimToken(raw));
    if (token && !found.has(`${kind}:${token}`)) found.set(`${kind}:${token}`, { kind, token });
  };
  const urls = [...text.matchAll(URL_PATTERN)].map((m) => m[0]);
  urls.forEach((u) => add("url", u));
  const withoutUrls = urls.reduce((acc, u) => acc.split(u).join(" "), text);
  for (const m of withoutUrls.matchAll(PATH_CANDIDATE)) if (isPathLike(m[1])) add("path", m[1]);
  for (const m of withoutUrls.matchAll(FILE_NAME)) if (!/^[A-Z][A-Za-z0-9]*\.js$/.test(m[0])) add("path", m[0]); // "Node.js" names a tool, not a file
  for (const m of withoutUrls.matchAll(SHA_PATTERN)) add("sha", m[0]);
  for (const [index, pattern] of COMMAND_PATTERNS.entries()) {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      if (index === 0) {
        const span = m[1].trim();
        if (/\s/.test(span) || CLI_START.test(span)) add("command", span);
      } else add("command", m[0]);
    }
  }
  return [...found.values()];
}

/** Every execution-shaped reference in a text: the PB-REASON-01 kinds plus the brief-only kinds. */
export function extractExecutionReferences(text: string): BriefReference[] {
  return [...extractTypedReferences(text).map((r) => ({ kind: r.kind as BriefReferenceKind, token: r.token })), ...briefOnlyReferences(text)];
}

export const REFERENCE_KIND_LABEL: Readonly<Record<BriefReferenceKind, string>> = {
  code: "a milestone or task code",
  pr: "a PR or issue number",
  branch: "a branch name",
  percent: "a percentage",
  date: "a date",
  path: "a file path or directory",
  sha: "a commit SHA",
  url: "a URL",
  command: "a command",
};

// ─── Dangerous (shared-state) commands ───────────────────────────────────────

/**
 * A small, fixed, conservative token screen — deliberately not a shell parser.
 * Anything naming a merge, push, deploy, release/publish, migration, database
 * reset/drop/truncate, recursive delete, remote fetch-and-execute, or a
 * production/shared environment does not belong in a PB-EXEC-01 brief.
 */
const DANGEROUS_COMMAND: RegExp[] = [
  /\bmerge\b/i,
  /\bpush\b/i,
  /--force\b|\s-f\b.*\bpush\b|\bpush\b.*\s-f\b/i,
  /\bdeploy\w*\b/i,
  /\b(?:release|publish|promote)\b/i,
  /\bmigrat\w*\b/i,
  /\bdb\s+(?:push|reset|seed)\b/i,
  /\bdb:(?:migrate|reset|drop|seed|rollback)\b/i,
  /\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdropdb\b/i,
  /\breset\s+--hard\b|\bgit\s+(?:reset|rebase|clean)\b/i,
  /\brm\s+-[a-z]*r[a-z]*\b|\brm\s+-[a-z]*f[a-z]*\b|\brmdir\b/i,
  /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
  /\b(?:prod|production|staging|shared)\b/i,
  /\b(?:kubectl\s+(?:apply|delete|rollout|scale|patch)|helm\s+(?:install|upgrade|uninstall|rollback)|terraform\s+(?:apply|destroy))\b/i,
  /--prod\b/i,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND.some((pattern) => pattern.test(command));
}

// ─── Execution-sensitive reports ─────────────────────────────────────────────

/** Deterministic escalation only: the server may mark a report sensitive, never unmark it. */
const EXECUTION_SENSITIVE = /\b(?:merged|merge[sd]?|clean|safe|deploy(?:ed|s|ment)?|succeed(?:ed|s)?|succeeded|passed|passing|green|migrat\w*|approved|released|pushed|rebased|rolled back|shipped|live|done|complete[d]?|finished|fixed)\b/i;

/**
 * KNOWN context must be what the cited RECORD says — never a report folded in beside a
 * valid citation ("P13 is in progress and reported merged"). Deterministic, two rules:
 *   * report language ("reported", "you said", "according to the user", …) is never known;
 *   * an execution-sensitive claim (merged, deployed, clean, passed, …) is known only if the
 *     cited record's own label/content contains that word.
 * An item failing either is moved to assumptions — not dropped, not kept as known.
 */
const REPORT_LANGUAGE = /\b(?:reported(?:ly)?|you (?:said|say|mentioned|told|reported|noted|confirmed)|according to (?:you|the user|a user)|(?:the )?user (?:says|said|reported|mentioned)|in (?:this|the) conversation|in chat)\b/i;
const SENSITIVE_TERM = new RegExp(EXECUTION_SENSITIVE.source, "gi");

function knownClaimIsRecordOnly(text: string, cited: ProjectBrainContextSource[]): boolean {
  if (REPORT_LANGUAGE.test(text)) return false;
  const recordText = cited.map((s) => `${s.label} ${s.content}`).join(" ").toLowerCase();
  return [...text.matchAll(SENSITIVE_TERM)].every((m) => recordText.includes(m[0].toLowerCase()));
}

// ─── Grounded result ─────────────────────────────────────────────────────────

export type GroundedBrief = {
  capabilityFit: CapabilityFit;
  target: ExecutionBriefV1["target"];
  objective: ExecutionBriefV1["objective"];
  whyNow: ExecutionBriefV1["whyNow"];
  knownContext: ExecutionBriefV1["knownContext"];
  reportedContext: ExecutionBriefV1["reportedContext"];
  assumptions: ExecutionBriefV1["assumptions"];
  unknowns: ExecutionBriefV1["unknowns"];
  scope: ExecutionBriefV1["scope"];
  areasToInspect: ExecutionBriefV1["areasToInspect"];
  /** Model constraints only; policy constraints are added at assembly. */
  constraints: ExecutionBriefV1["constraints"];
  acceptanceCriteria: ExecutionBriefV1["acceptanceCriteria"];
  verificationPlan: ExecutionBriefV1["verificationPlan"];
  /** Every cited source, first-cited order (the brief's provenance.sources). */
  sources: ProjectBrainContextSource[];
  /** Every cited report, first-cited order (the brief's provenance.reports). */
  reports: ProjectBrainContextReport[];
  citations: BriefCitationReport;
  groundingAdjusted: boolean;
  /** Blocking gaps the server itself identified (readiness input). */
  targetRemoved: boolean;
  objectiveRemoved: boolean;
};

export type GroundBriefInput = {
  output: ExecutionBriefModelOutput;
  /** The turn context WITH its report map (buildReportedContext). */
  context: ProjectBrainContext;
  /** The current user message — supplied, like every user turn. */
  question: string;
  generatedAt: string;
  targetRef: ResolvedExecutionBriefTargetRef;
  /** Boundary-1 scanner; injectable only so tests can prove a throwing guard fails closed. */
  scanNarrative?: (text: string) => string[];
};

type Field =
  | "target" | "objective" | "whyNow" | "knownContext" | "reportedContext" | "assumptions" | "unknowns"
  | "scope.inScope" | "scope.outOfScope" | "areasToInspect" | "constraints" | "acceptanceCriteria" | "verificationPlan";

const FIELD_LABEL: Record<Field, string> = {
  target: "the target",
  objective: "the objective",
  whyNow: "why now",
  knownContext: "current state",
  reportedContext: "reported context",
  assumptions: "assumptions",
  unknowns: "open inputs",
  "scope.inScope": "scope",
  "scope.outOfScope": "out of scope",
  areasToInspect: "areas to inspect",
  constraints: "constraints",
  acceptanceCriteria: "acceptance criteria",
  verificationPlan: "verification plan",
};

type Unknown = ExecutionBriefV1["unknowns"][number];
type Screen = { ok: true } | { ok: false; reason: "credential" } | { ok: false; reason: "reference"; kind: BriefReferenceKind } | { ok: false; reason: "dangerous" };

export function groundExecutionBrief(input: GroundBriefInput): GroundedBrief {
  const { output, context, generatedAt } = input;
  const citations: BriefCitationReport = { rejectedCitations: 0, rejectedReports: 0, unsupportedReferences: 0, credentialFindings: 0, droppedItems: 0, demotedItems: 0, blockedCommands: 0 };
  const serverUnknowns: Unknown[] = [];
  const addUnknown = (u: Unknown) => {
    if (!serverUnknowns.some((x) => x.fact === u.fact && x.why === u.why)) serverUnknowns.push(u);
  };

  // What this request supplied (records, today, the question, USER turns). The
  // selected prior recommendation is NOT here — earlier AI output never vouches.
  const supplied = suppliedReferences(context, input.question, generatedAt);
  const corpus = collapse(suppliedReferenceText(context, input.question, generatedAt));
  const exactCorpus = suppliedReferenceText(context, input.question, generatedAt).replace(/\s+/g, " ");
  const unsupportedKind = (text: string): BriefReferenceKind | null => {
    for (const ref of extractTypedReferences(text)) {
      if (supplied.tokens.has(ref.token)) continue;
      const family = ref.token.replace(/-\d+$/, "");
      if (ref.kind === "code" && STANDARD_CODE_FAMILIES.has(family) && !supplied.codeFamilies.has(family)) continue;
      return ref.kind;
    }
    for (const ref of briefOnlyReferences(text)) {
      if (!corpus.includes(ref.token)) return ref.kind;
    }
    return null;
  };
  const scan = input.scanNarrative ?? narrativeCredentialCategories;
  // Fail closed: a guard error counts as a hit, so the item is removed whole.
  const credentialHit = (text: string): boolean => {
    try {
      return scan(text).length > 0;
    } catch {
      return true;
    }
  };
  const dangerousIn = (text: string) => briefOnlyReferences(text).some((r) => r.kind === "command" && isDangerousCommand(r.token));

  const screen = (texts: Array<string | null>): Screen => {
    const present = texts.filter((t): t is string => typeof t === "string" && t.length > 0);
    if (present.some(credentialHit)) return { ok: false, reason: "credential" };
    for (const t of present) {
      const kind = unsupportedKind(t);
      if (kind) return { ok: false, reason: "reference", kind };
    }
    if (present.some(dangerousIn)) return { ok: false, reason: "dangerous" };
    return { ok: true };
  };

  const onRemoved = (field: Field, result: Exclude<Screen, { ok: true }>, blocking: boolean) => {
    if (result.reason === "credential") {
      citations.credentialFindings += 1;
      addUnknown({ fact: "A credential-like value appeared in the draft", why: `It was removed from ${FIELD_LABEL[field]}. Give credentials to the executor through its own secret mechanism, never in the brief.`, resolveBy: "user", blocking });
    } else if (result.reason === "reference") {
      citations.unsupportedReferences += 1;
      const label = REFERENCE_KIND_LABEL[result.kind];
      addUnknown({ fact: `${label[0].toUpperCase()}${label.slice(1)} that the project records and this conversation do not establish`, why: `An item in ${FIELD_LABEL[field]} named it, so the whole item was removed rather than guessed.`, resolveBy: "user", blocking });
    } else {
      citations.blockedCommands += 1;
      addUnknown({ fact: "A command that would change shared state was mentioned", why: `It was removed from ${FIELD_LABEL[field]}: merging, pushing, deploying, releasing, migrating or deleting is outside this brief's scope.`, resolveBy: "user", blocking });
    }
  };

  // ── aliases → stable ids ──
  const byAlias = new Map(context.sources.map((s) => [s.alias, s]));
  const byReport = new Map((context.reports ?? []).map((r) => [r.alias, r]));
  const citedSources: ProjectBrainContextSource[] = [];
  const citedReports: ProjectBrainContextReport[] = [];
  const noteSource = (s: ProjectBrainContextSource) => { if (!citedSources.includes(s)) citedSources.push(s); };
  const noteReport = (r: ProjectBrainContextReport) => { if (!citedReports.includes(r)) citedReports.push(r); };
  const resolve = (sourceAliases: string[], reportAliases: string[]) => {
    const sources: ProjectBrainContextSource[] = [];
    const reports: ProjectBrainContextReport[] = [];
    const cappedS = sourceAliases.slice(0, L.sourceAliasesPerItem);
    const cappedR = reportAliases.slice(0, L.reportAliasesPerItem);
    citations.rejectedCitations += sourceAliases.length - cappedS.length;
    citations.rejectedReports += reportAliases.length - cappedR.length;
    for (const alias of cappedS) {
      const s = byAlias.get(normalizeCitationAlias(alias));
      if (!s) citations.rejectedCitations += 1;
      else if (!sources.includes(s)) sources.push(s);
    }
    for (const alias of cappedR) {
      const r = byReport.get(normalizeCitationAlias(alias));
      if (!r) citations.rejectedReports += 1;
      else if (!reports.includes(r)) reports.push(r);
    }
    return { sources, reports };
  };
  const ids = (sources: ProjectBrainContextSource[]) => sources.map((s) => s.reference.evidenceId);
  const turnIds = (reports: ProjectBrainContextReport[]) => reports.map((r) => r.reference.turnId);
  const keep = (sources: ProjectBrainContextSource[], reports: ProjectBrainContextReport[]) => {
    sources.forEach(noteSource);
    reports.forEach(noteReport);
  };
  const isRecord = (s: ProjectBrainContextSource) => s.trust === "RECORD";

  /** Origin check for instruction items: unsupported claimed support → suggested (ids cleared). */
  const origin = <O extends "project_record" | "reported" | "suggested">(claimed: O, sources: ProjectBrainContextSource[], reports: ProjectBrainContextReport[]) => {
    const valid = claimed === "project_record" ? sources.some(isRecord) : claimed === "reported" ? reports.length > 0 : true;
    if (claimed !== "suggested" && !valid) citations.demotedItems += 1;
    const finalOrigin = (valid ? claimed : "suggested") as O | "suggested";
    if (finalOrigin === "suggested") return { origin: finalOrigin, sourceIds: [] as string[], reportedTurnIds: [] as string[] };
    keep(sources, reports);
    return { origin: finalOrigin, sourceIds: ids(sources), reportedTurnIds: turnIds(reports) };
  };

  const tooLong = (text: string, max: number) => text.trim().length > max;
  const bounded = <T>(items: T[], max: number): T[] => {
    citations.droppedItems += Math.max(0, items.length - max);
    return items.slice(0, max);
  };

  // ── target ──
  let target: GroundedBrief["target"] = null;
  let targetRemoved = false;
  {
    const t = output.target;
    const r = screen([t.title, t.statement]);
    if (!t.title.trim() || !t.statement.trim() || tooLong(t.title, L.titleChars) || tooLong(t.statement, L.statementChars)) {
      citations.droppedItems += 1;
      targetRemoved = true;
      addUnknown({ fact: "Which work this brief is for", why: "The drafted target could not be kept; describe the work or pick a recommendation again.", resolveBy: "user", blocking: true });
    } else if (!r.ok) {
      targetRemoved = true;
      onRemoved("target", r, true);
    } else {
      const { sources, reports } = resolve(t.sourceAliases, t.reportAliases);
      // current_user_request: the human described the work in THIS turn — the
      // current authenticated report is, by construction, where the target comes from.
      const current = context.reports?.find((x) => x.current);
      if (input.targetRef.kind === "current_user_request" && current && !reports.includes(current)) reports.unshift(current);
      keep(sources, reports);
      target = { title: t.title.trim(), statement: t.statement.trim(), sourceIds: ids(sources), reportedTurnIds: turnIds(reports) };
      if (target.sourceIds.length === 0 && target.reportedTurnIds.length === 0) {
        addUnknown({ fact: "Whether the selected work is still supported by the current project records", why: "No current record or report was cited for the target.", resolveBy: "project_record", blocking: true });
      }
    }
  }

  // ── objective ──
  let objective: GroundedBrief["objective"] = null;
  let objectiveRemoved = false;
  {
    const o = output.objective;
    const r = screen([o.text]);
    if (!o.text.trim() || tooLong(o.text, L.objectiveChars)) {
      citations.droppedItems += 1;
      objectiveRemoved = true;
      addUnknown({ fact: "The objective of this work", why: "The drafted objective could not be kept; state the outcome you want.", resolveBy: "user", blocking: true });
    } else if (!r.ok) {
      objectiveRemoved = true;
      onRemoved("objective", r, true);
    } else {
      const { sources, reports } = resolve(o.sourceAliases, o.reportAliases);
      objective = { text: o.text.trim(), ...origin(o.origin, sources, reports) };
    }
  }

  // ── whyNow (narrative; keeps whatever valid support it cites) ──
  let whyNow: GroundedBrief["whyNow"] = null;
  {
    const w = output.whyNow;
    const r = screen([w.text]);
    if (!w.text.trim()) {
      // nothing to say — not an adjustment
    } else if (tooLong(w.text, L.whyNowChars)) {
      citations.droppedItems += 1;
    } else if (!r.ok) {
      onRemoved("whyNow", r, false);
    } else {
      const { sources, reports } = resolve(w.sourceAliases, w.reportAliases);
      keep(sources, reports);
      whyNow = { text: w.text.trim(), sourceIds: ids(sources), reportedTurnIds: turnIds(reports) };
    }
  }

  const assumptions: GroundedBrief["assumptions"] = [];
  const moveToAssumption = (text: string) => {
    citations.demotedItems += 1;
    if (assumptions.length < L.assumptions + L.knownContext + L.reportedContext) assumptions.push({ text });
  };

  // ── knownContext: RECORD sources only ──
  const knownContext: GroundedBrief["knownContext"] = [];
  for (const item of bounded(output.knownContext, L.knownContext)) {
    const text = item.text.trim();
    if (!text || tooLong(text, L.itemChars)) { citations.droppedItems += 1; continue; }
    const r = screen([text]);
    if (!r.ok) { onRemoved("knownContext", r, false); continue; }
    const { sources } = resolve(item.sourceAliases, []);
    if (!sources.some(isRecord) || !knownClaimIsRecordOnly(text, sources)) { moveToAssumption(text); continue; }
    keep(sources, []);
    knownContext.push({ text, sourceIds: ids(sources) });
  }

  // ── reportedContext: valid reports only; sensitivity escalated deterministically ──
  const reportedContext: GroundedBrief["reportedContext"] = [];
  for (const item of bounded(output.reportedContext, L.reportedContext)) {
    const text = item.text.trim();
    if (!text || tooLong(text, L.itemChars)) { citations.droppedItems += 1; continue; }
    const r = screen([text]);
    if (!r.ok) { onRemoved("reportedContext", r, false); continue; }
    const { reports } = resolve([], item.reportAliases);
    if (reports.length === 0) { moveToAssumption(text); continue; }
    keep([], reports);
    reportedContext.push({ text, reportedTurnIds: turnIds(reports), executionSensitive: item.executionSensitive || EXECUTION_SENSITIVE.test(text) });
  }

  // ── assumptions ──
  for (const item of bounded(output.assumptions, L.assumptions)) {
    const text = item.text.trim();
    if (!text || tooLong(text, L.itemChars)) { citations.droppedItems += 1; continue; }
    const r = screen([text]);
    if (!r.ok) { onRemoved("assumptions", r, false); continue; }
    assumptions.push({ text });
  }

  // ── model unknowns ──
  const modelUnknowns: Unknown[] = [];
  for (const item of bounded(output.unknowns, L.unknowns)) {
    const fact = item.fact.trim();
    const why = item.why.trim();
    if (!fact || tooLong(fact, L.unknownFactChars) || tooLong(why, L.unknownWhyChars)) { citations.droppedItems += 1; continue; }
    const r = screen([fact, why]);
    if (!r.ok) { onRemoved("unknowns", r, item.blocking); continue; }
    modelUnknowns.push({ fact, why, resolveBy: item.resolveBy as UnknownResolveBy, blocking: item.blocking });
  }

  // ── scope ──
  const scopeList = (items: string[], max: number, field: Field) => {
    const out: string[] = [];
    for (const raw of bounded(items, max)) {
      const text = raw.trim();
      if (!text || tooLong(text, L.itemChars)) { citations.droppedItems += 1; continue; }
      const r = screen([text]);
      if (!r.ok) { onRemoved(field, r, false); continue; }
      out.push(text);
    }
    return out;
  };
  const scope = { inScope: scopeList(output.scope.inScope, L.inScope, "scope.inScope"), outOfScope: scopeList(output.scope.outOfScope, L.outOfScope, "scope.outOfScope") };

  // ── areasToInspect: never suggested ──
  const areasToInspect: GroundedBrief["areasToInspect"] = [];
  for (const item of bounded(output.areasToInspect, L.areasToInspect)) {
    const text = item.text.trim();
    if (!text || tooLong(text, L.itemChars)) { citations.droppedItems += 1; continue; }
    const r = screen([text]);
    if (!r.ok) { onRemoved("areasToInspect", r, false); continue; }
    const { sources, reports } = resolve(item.sourceAliases, item.reportAliases);
    const valid = item.origin === "project_record" ? sources.some(isRecord) : reports.length > 0;
    if (!valid) {
      citations.demotedItems += 1;
      addUnknown({ fact: "Which files or areas to inspect", why: "Neither the project records nor this conversation name them; locate them in the repository instead of assuming.", resolveBy: "repository_binding", blocking: false });
      continue;
    }
    keep(sources, reports);
    areasToInspect.push({ text, origin: item.origin, sourceIds: ids(sources), reportedTurnIds: turnIds(reports) });
  }

  // ── constraints / acceptance criteria ──
  const originList = (items: ExecutionBriefModelOutput["constraints"], max: number, field: Field) => {
    const out: Array<{ text: string; origin: "project_record" | "reported" | "suggested"; sourceIds: string[]; reportedTurnIds: string[] }> = [];
    for (const item of bounded(items, max)) {
      const text = item.text.trim();
      if (!text || tooLong(text, L.itemChars)) { citations.droppedItems += 1; continue; }
      const r = screen([text]);
      if (!r.ok) { onRemoved(field, r, false); continue; }
      const { sources, reports } = resolve(item.sourceAliases, item.reportAliases);
      out.push({ text, ...origin(item.origin, sources, reports) });
    }
    return out;
  };
  const constraints = originList(output.constraints, L.constraints, "constraints");
  const acceptanceCriteria = originList(output.acceptanceCriteria, L.acceptanceCriteria, "acceptanceCriteria");

  // ── verification plan: commands only when supplied verbatim, never shared-state ──
  const verificationPlan: GroundedBrief["verificationPlan"] = [];
  for (const item of bounded(output.verificationPlan, L.verificationPlan)) {
    const step = item.step.trim();
    const command = item.command === null ? null : item.command.trim() || null;
    if (!step || tooLong(step, L.stepChars) || (command !== null && tooLong(command, L.commandChars))) { citations.droppedItems += 1; continue; }
    if (command !== null && credentialHit(command)) { onRemoved("verificationPlan", { ok: false, reason: "credential" }, false); continue; }
    if (command !== null && isDangerousCommand(command)) { onRemoved("verificationPlan", { ok: false, reason: "dangerous" }, false); continue; }
    const r = screen([step]);
    if (!r.ok) { onRemoved("verificationPlan", r, false); continue; }
    const { sources, reports } = resolve(item.sourceAliases, item.reportAliases);
    let finalCommand: string | null = null;
    let basis: CommandBasis | null = null;
    if (command !== null) {
      const needle = command.replace(/\s+/g, " ");
      const fromSource = context.sources.find((s) => `${s.label} ${s.content}`.replace(/\s+/g, " ").includes(needle));
      const fromReport = fromSource ? null : reportTextsOf(context, input.question).find((x) => x.text.replace(/\s+/g, " ").includes(needle));
      if (fromSource) {
        finalCommand = command;
        basis = "project_record";
        if (!sources.includes(fromSource)) sources.push(fromSource);
      } else if (fromReport && exactCorpus.includes(needle)) {
        finalCommand = command;
        basis = "reported";
        if (!reports.includes(fromReport.report)) reports.push(fromReport.report);
      } else {
        citations.demotedItems += 1; // a model-authored command: dropped, the step stays
      }
    }
    keep(sources, reports);
    verificationPlan.push({ step, kind: item.kind as VerificationKind, command: finalCommand, commandBasis: basis, sourceIds: ids(sources), reportedTurnIds: turnIds(reports) });
  }

  const unknowns = [...modelUnknowns];
  for (const u of serverUnknowns) if (!unknowns.some((x) => x.fact === u.fact && x.why === u.why)) unknowns.push(u);

  const groundingAdjusted =
    citations.rejectedCitations + citations.rejectedReports + citations.unsupportedReferences + citations.credentialFindings + citations.droppedItems + citations.demotedItems + citations.blockedCommands > 0;

  return {
    capabilityFit: output.capabilityFit,
    target,
    objective,
    whyNow,
    knownContext,
    reportedContext,
    assumptions,
    unknowns,
    scope,
    areasToInspect,
    constraints,
    acceptanceCriteria,
    verificationPlan,
    sources: citedSources,
    reports: citedReports,
    citations,
    groundingAdjusted,
    targetRemoved,
    objectiveRemoved,
  };
}

/**
 * The authenticated user turns of this request's report map, with their text.
 * Only history rows that ARE reports (an authenticated user row in the window) and
 * the current question — never an assistant turn.
 */
export function reportTextsOf(context: ProjectBrainContext, question: string): Array<{ report: ProjectBrainContextReport; text: string }> {
  const out: Array<{ report: ProjectBrainContextReport; text: string }> = [];
  for (const report of context.reports ?? []) {
    if (report.current) {
      out.push({ report, text: question });
      continue;
    }
    const message = context.history.find((m) => m.role === "user" && m.id === report.reference.turnId);
    if (message) out.push({ report, text: message.content });
  }
  return out;
}
