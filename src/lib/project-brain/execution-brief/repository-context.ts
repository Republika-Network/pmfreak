// ─────────────────────────────────────────────────────────────────────────────
// Execution Brief — repository context (PB-EXEC-01, §11.3)
//
// PB-EXEC-01 has NO repository access: no SCM API, no filesystem, no git. The
// canonical value is therefore `not_established`, unless an AUTHENTICATED USER wrote
// repository facts in this conversation, in which case they are `reported` — never
// verified — and cite the turns they came from.
//
// Narrow, deterministic extraction of facts LITERALLY present in user text:
//   repository  an explicit github.com / gitlab.com / bitbucket.org URL (or its
//               `git@host:owner/repo` form) → provider implied by the host
//   baseRef     "base branch is X", "base ref: X", or a QUOTED branch name
//   baseSha     "commit|sha|base commit <7–40 hex>"
// Never from assistant text, never from the project name, never from vague prose.
// Two different values for one field across turns → that field is null (ambiguous).
// A reported repository grants nothing: the brief stays manual and unauthorized.
// Pure.
// ─────────────────────────────────────────────────────────────────────────────

import { NOT_ESTABLISHED_REPOSITORY_NOTE } from "./policy";
import type { RepositoryContext } from "./types";

const HOSTS: Record<string, string> = { "github.com": "github", "gitlab.com": "gitlab", "bitbucket.org": "bitbucket" };
const REPO_URL = /\bhttps?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=$|[\s/#?)\]'"`,;])/gi;
const REPO_SSH = /\bgit@(github\.com|gitlab\.com|bitbucket\.org):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=$|[\s)\]'"`,;])/gi;
const BASE_REF = /\bbase (?:branch|ref)(?: is|:| =)\s+[`'"]?([A-Za-z0-9][A-Za-z0-9._/-]{0,99})[`'"]?/gi;
const QUOTED_BRANCH = /\bbranch\s+[`'"]([A-Za-z0-9][A-Za-z0-9._/-]{0,99})[`'"]/gi;
const BASE_SHA = /\b(?:base commit|base sha|commit|sha)(?: is|:| =)?\s+[`'"]?((?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40})\b/gi;

export type ReportedTurnText = { turnId: string; text: string };

type Found = { value: string; turnId: string };

function collect(turns: ReportedTurnText[], pattern: RegExp, pick: (m: RegExpMatchArray) => string | null): Found[] {
  const out: Found[] = [];
  for (const turn of turns) {
    for (const m of turn.text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const value = pick(m);
      if (value) out.push({ value, turnId: turn.turnId });
    }
  }
  return out;
}

/** One distinct value → it; none or conflicting values → null. */
function single(found: Found[]): Found[] | null {
  const distinct = new Set(found.map((f) => f.value));
  return distinct.size === 1 ? found : null;
}

export function extractReportedRepositoryContext(turns: ReportedTurnText[]): RepositoryContext {
  const repos = collect(turns, REPO_URL, (m) => `${HOSTS[m[1].toLowerCase()]}|${m[2]}/${m[3].replace(/\.git$/i, "")}`)
    .concat(collect(turns, REPO_SSH, (m) => `${HOSTS[m[1].toLowerCase()]}|${m[2]}/${m[3].replace(/\.git$/i, "")}`));
  const refs = collect(turns, BASE_REF, (m) => m[1].replace(/[.,;:]+$/, "")).concat(collect(turns, QUOTED_BRANCH, (m) => m[1]));
  const shas = collect(turns, BASE_SHA, (m) => m[1].toLowerCase());

  const repo = single(repos);
  const ref = single(refs);
  const sha = single(shas);
  if (!repo && !ref && !sha) return { status: "not_established", note: NOT_ESTABLISHED_REPOSITORY_NOTE };

  const [provider, repository] = repo ? repo[0].value.split("|") : [null, null];
  const reportedTurnIds = [...new Set([...(repo ?? []), ...(ref ?? []), ...(sha ?? [])].map((f) => f.turnId))];
  return {
    status: "reported",
    provider: provider ?? null,
    repository: repository ?? null,
    baseRef: ref ? ref[0].value : null,
    baseSha: sha ? sha[0].value : null,
    reportedTurnIds,
  };
}
