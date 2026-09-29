// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — persisted-artifact verification (PB-EXEC-01 review P2-1, P2-2). SERVER ONLY.
//
// Before a persisted brief is exposed by the transcript API, two independent checks:
//
//   integrity  the strict parse succeeds AND briefContentHash, recomputed over the stored
//              content, equals the stored hash — a shape-valid brief whose content changed
//              under its old hash is not the artifact that hash names;
//   binding    the brief belongs to the row and the route scope that contain it:
//                identity.conversationId = row.conversation_id
//                identity.requestTurnId  = row.reply_to_message_id
//                identity.workspaceId    = row.workspace_id = route workspace
//                identity.projectId      = route project
//                every provenance source's workspaceId/projectId = the brief's own
//              — a valid, correctly hashed brief transplanted onto another row, conversation
//              or project is not shown.
//
// hash integrity ≠ container/scope binding; both are required. On any failure the caller
// shows nothing of the brief (briefUnavailable) and never rewrites the stored row.
// Imports hash.ts (node:crypto): never reachable from browser code.
// ─────────────────────────────────────────────────────────────────────────────

import type { ContextMessageRow } from "@/lib/db/database-contract";
import { computeBriefContentHash } from "./assemble";
import type { ExecutionBriefV1 } from "./types";
import { parseExecutionBriefV1 } from "./validate";

export type BriefVerificationFailure =
  | "malformed"
  | "hash_mismatch"
  | "conversation_mismatch"
  | "request_turn_mismatch"
  | "workspace_mismatch"
  | "project_mismatch"
  | "source_scope_mismatch";

export type ExpectedBriefScope = { workspaceId: string; projectId: string };

export function verifyPersistedExecutionBrief(
  value: unknown,
  row: Pick<ContextMessageRow, "conversation_id" | "reply_to_message_id" | "workspace_id">,
  expected: ExpectedBriefScope,
): { ok: true; brief: ExecutionBriefV1 } | { ok: false; reason: BriefVerificationFailure } {
  const brief = parseExecutionBriefV1(value);
  if (!brief) return { ok: false, reason: "malformed" };
  let hash: string;
  try {
    hash = computeBriefContentHash(brief);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (hash !== brief.identity.briefContentHash) return { ok: false, reason: "hash_mismatch" };
  const id = brief.identity;
  if (id.conversationId !== row.conversation_id) return { ok: false, reason: "conversation_mismatch" };
  if (!row.reply_to_message_id || id.requestTurnId !== row.reply_to_message_id) return { ok: false, reason: "request_turn_mismatch" };
  if (id.workspaceId !== row.workspace_id || id.workspaceId !== expected.workspaceId) return { ok: false, reason: "workspace_mismatch" };
  if (id.projectId !== expected.projectId) return { ok: false, reason: "project_mismatch" };
  if (brief.provenance.sources.some((s) => s.workspaceId !== id.workspaceId || s.projectId !== id.projectId)) return { ok: false, reason: "source_scope_mismatch" };
  return { ok: true, brief };
}

/**
 * The verifier the transcript API hands to toProjectBrainMessageView, bound to the ROUTE's
 * server-derived scope. Logs only the failure class and row id — never brief content.
 */
export function persistedBriefVerifier(expected: ExpectedBriefScope) {
  return (value: unknown, row: ContextMessageRow): ExecutionBriefV1 | null => {
    const result = verifyPersistedExecutionBrief(value, row, expected);
    if (result.ok) return result.brief;
    console.warn(JSON.stringify({ event: "project_brain.execution_brief.unverified", projectId: expected.projectId, rowId: row.id, reason: result.reason }));
    return null;
  };
}
