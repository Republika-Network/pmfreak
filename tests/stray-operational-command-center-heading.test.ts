import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const shell = readFileSync("src/components/pmfreak/workspace/workspace-conversation-shell.tsx", "utf8");

/**
 * ADR-PMF-014 Rule 1 lists the valid qualified forms EXHAUSTIVELY: Enterprise,
 * Workspace, PMO, Portfolio, Program and Project Command Center. "Operational
 * Command Center" is not among them — it is a seventh meaning for the same
 * words, which is precisely what Rule 6's closing clause exists to prevent.
 *
 * This was the second half of a migration item that ADR-PMF-007 Future Work and
 * 02-canonical-product-language.md §27 each carried bundled with the
 * `/pmo-command-center` rename. (ADR-PMF-014's own migration list carried only
 * the rename half, not this heading.) The rename shipped in #604; this is the
 * remaining half.
 *
 * Scope note: these tests deliberately do NOT sweep the repository for every
 * bare, unqualified "Command Center" label. That audit is its own tracked
 * migration item (ADR-PMF-014, Migration Recommendations), and at least one
 * known instance — the navigation entry's own label — is still open. A sweep
 * here would fail on work this change did not undertake.
 */

function collectTsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectTsxFiles(full, acc);
    else if (full.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

test("the workspace conversation shell names itself for what it is", () => {
  // "Workspace Chat" is the established label for this surface — chat/page.tsx
  // calls itself "the workspace-level conversational console", and the Command
  // Center links to it under that name.
  assert.match(shell, /<h1 className="text-2xl font-semibold">Workspace Chat<\/h1>/);
});

test("it does not claim to be a Command Center of any kind", () => {
  // Renaming this to "Workspace Command Center" would have been conformant with
  // Rule 1 and still wrong: that name belongs to the screen at
  // /workspaces/[workspaceId]/command-center, and two surfaces answering to it
  // is the entity confusion ADR-PMF-007 ruled against.
  assert.doesNotMatch(shell, /Command Center/);
});

test('no user-facing component carries the invented "Operational Command Center" form', () => {
  const offenders = collectTsxFiles("src").filter((file) =>
    readFileSync(file, "utf8").includes("Operational Command Center"),
  );
  assert.deepEqual(offenders, [], `"Operational Command Center" is not one of ADR-PMF-014 Rule 1's six valid forms`);
});
