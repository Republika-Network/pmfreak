// ─────────────────────────────────────────────────────────────────────────────
// Project Brain conversation — uploaded-document excerpts (PD-24)
//
//   project_brain_document_texts(workspace, project)   SECURITY INVOKER RPC:
//           ↓  content ⋈ evidence (processed), caller RLS, bounded rows and heads
//   selectDocumentSources(scope, rows, question)
//           ↓  pure: scope re-check, bounded scan, lexical window ranking
//   DOCUMENT sources (UNVERIFIED, ≤ DOCUMENT_SOURCE_LIMIT, ≤ MAX_SOURCE_CONTENT_CHARS)
//
// No embeddings and no new infrastructure: the processed text is split into
// sentences, and every run of whole sentences that fits one source is scored by the
// question's distinct content words it contains (then by total hits, then earliest).
// A document qualifies only through an excerpt that actually matches; identical
// uploads (same content hash) and identical excerpts are cited once. Uploads stay
// unverified assertions about the world — never instructions, never confirmed status.
// Failed / processing / deleted evidence cannot qualify: the join requires a
// processed parent row, and content rows cascade away with their evidence.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { sourceReferenceFromProjectEvidence, type ProjectEvidenceSourceRow } from "../source-reference";
import type { ProjectContextScope } from "../types";
import type { ProjectBrainContextSource } from "./context-types";
import { MAX_SOURCE_CONTENT_CHARS } from "./context-budget";

export const DOCUMENT_READ_LIMIT = 24;
export const DOCUMENT_SCAN_CHARS = 64_000;
export const DOCUMENT_SOURCE_LIMIT = 3;
const MAX_QUESTION_TERMS = 32;

const STOP = new Set(
  ("a an and any are as at be been but by can could did do does for from had has have how i if in into is it its me my " +
    "not of on or our please should tell than that the their them then there these they this those to us was we were " +
    "what when where which who why will with would you your about document documents file files project uploaded").split(" "),
);

/** Light, deterministic normalisation: fold a plural "s" so "risks" matches "risk". */
function stem(word: string): string {
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** Distinct, accent-folded, lower-cased content words (stop words removed). */
export function contentWords(text: string): string[] {
  const raw = text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(raw.map(stem).filter((word) => !STOP.has(word)))];
}

export type DocumentContextRow = {
  evidence_id: string;
  workspace_id: string;
  project_id: string;
  extracted_text: string;
  content_hash: string;
  project_evidence: ProjectEvidenceSourceRow | null;
};

type Excerpt = { score: number; hits: number; offset: number; excerpt: string };

/** Sentences (or, for an over-long sentence, word-aligned pieces) that each fit one source. */
function segments(text: string): Array<{ offset: number; text: string }> {
  const out: Array<{ offset: number; text: string }> = [];
  for (const match of text.matchAll(/[^.!?]+(?:[.!?]+|$)/g)) {
    let piece = match[0].trim();
    let offset = match.index + match[0].indexOf(piece);
    while (piece.length > MAX_SOURCE_CONTENT_CHARS) {
      const cut = piece.lastIndexOf(" ", MAX_SOURCE_CONTENT_CHARS);
      const head = piece.slice(0, cut > 0 ? cut : MAX_SOURCE_CONTENT_CHARS);
      out.push({ offset, text: head });
      const rest = piece.slice(head.length).trimStart();
      offset += piece.length - rest.length;
      piece = rest;
    }
    if (piece) out.push({ offset, text: piece });
  }
  return out;
}

/** Best run of whole sentences within one source's size: most distinct terms, then most hits, then earliest. */
function bestExcerpt(text: string, terms: string[]): Excerpt {
  const termSet = new Set(terms);
  const parts = segments(text).map((part) => {
    const words = (part.text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]{3,}/gu) ?? []).map(stem);
    return { ...part, words: words.filter((word) => termSet.has(word)) };
  });
  let best: Excerpt = { score: 0, hits: 0, offset: 0, excerpt: "" };
  for (let i = 0; i < parts.length; i += 1) {
    const found = new Set<string>();
    let hits = 0;
    let end = parts[i].offset + parts[i].text.length;
    for (let j = i; j < parts.length; j += 1) {
      end = parts[j].offset + parts[j].text.length;
      if (end - parts[i].offset > MAX_SOURCE_CONTENT_CHARS) break;
      for (const word of parts[j].words) found.add(word);
      hits += parts[j].words.length;
      if (found.size > best.score || (found.size === best.score && found.size > 0 && hits > best.hits)) {
        best = { score: found.size, hits, offset: parts[i].offset, excerpt: text.slice(parts[i].offset, end) };
      }
    }
  }
  return best;
}

/**
 * Pure: rows → at most DOCUMENT_SOURCE_LIMIT ranked excerpts, one per document.
 * Deterministic regardless of row order (distinct terms, then hits, then evidence id).
 */
export function selectDocumentSources(
  scope: ProjectContextScope,
  rows: DocumentContextRow[],
  question: string,
): Omit<ProjectBrainContextSource, "alias">[] {
  const terms = contentWords(question).slice(0, MAX_QUESTION_TERMS);
  if (!terms.length) return [];
  // One shared word is noise when the question has several; require two then.
  const minScore = Math.min(2, terms.length);
  const seen = new Set<string>();
  return rows
    .flatMap((row) => {
      const upload = row.project_evidence;
      if (
        !upload || upload.id !== row.evidence_id || upload.status !== "processed" ||
        row.workspace_id !== scope.workspaceId || row.project_id !== scope.projectId ||
        upload.workspace_id !== scope.workspaceId || upload.project_id !== scope.projectId ||
        typeof row.extracted_text !== "string"
      ) return [];
      const text = row.extracted_text.slice(0, DOCUMENT_SCAN_CHARS).replace(/\s+/g, " ").trim();
      const best = bestExcerpt(text, terms);
      if (best.score < minScore) return [];
      const reference = sourceReferenceFromProjectEvidence(upload, {
        excerpt: best.excerpt,
        href: `/evidence?projectId=${encodeURIComponent(scope.projectId)}`,
      });
      return [{
        score: best.score,
        hits: best.hits,
        hash: row.content_hash,
        id: upload.id,
        source: {
          family: "DOCUMENT" as const,
          trust: "UNVERIFIED" as const,
          label: `Uploaded document — ${upload.file_name.slice(0, 90)}`,
          content: best.excerpt,
          // The upload is the record of what the file says, not of what is true:
          // its excerpt is cited as unverified, never as primary evidence.
          reference: { ...reference, evidenceType: "DOCUMENT", authorityLevel: "unverified" as const, isPrimary: false },
          revisionMarker: { contentHash: row.content_hash, offset: best.offset },
        },
      }];
    })
    .sort((a, b) => b.score - a.score || b.hits - a.hits || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((entry) => {
      const key = `excerpt:${entry.source.content}`;
      if (seen.has(entry.hash) || seen.has(key)) return false;
      seen.add(entry.hash).add(key);
      return true;
    })
    .slice(0, DOCUMENT_SOURCE_LIMIT)
    .map(({ source }) => source);
}

type DocumentTextRow = {
  evidence_id: string; workspace_id: string; project_id: string; text_head: string; content_hash: string;
  file_name: string; file_type: string; uploaded_by: string | null; uploaded_at: string; status: ProjectEvidenceSourceRow["status"];
};

/**
 * Reads with the CALLER'S request-scoped client — never the service role. The RPC is
 * SECURITY INVOKER (migration 20261102000000), so RLS on both evidence tables applies,
 * and it returns at most DOCUMENT_READ_LIMIT processed heads of DOCUMENT_SCAN_CHARS.
 */
export async function loadDocumentSources(client: SupabaseClient, scope: ProjectContextScope, question: string) {
  if (!contentWords(question).length) return [];
  const { data, error } = await client.rpc("project_brain_document_texts", {
    p_workspace_id: scope.workspaceId,
    p_project_id: scope.projectId,
    p_limit: DOCUMENT_READ_LIMIT,
  });
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as DocumentTextRow[]).slice(0, DOCUMENT_READ_LIMIT).map((row): DocumentContextRow => ({
    evidence_id: row.evidence_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    extracted_text: row.text_head,
    content_hash: row.content_hash,
    project_evidence: {
      id: row.evidence_id,
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      file_name: row.file_name,
      file_type: row.file_type,
      uploaded_by: row.uploaded_by,
      uploaded_at: row.uploaded_at,
      status: row.status,
    },
  }));
  return selectDocumentSources(scope, rows, question);
}
