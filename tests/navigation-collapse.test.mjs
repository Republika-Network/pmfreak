import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const hierarchy = readFileSync('src/lib/workspace/navigation-hierarchy.ts', 'utf8');
const selectors = readFileSync('src/features/runtime/capability-reveal/capability-reveal-selectors.ts', 'utf8');
const shell = readFileSync('src/components/pmfreak/operational-shell.tsx', 'utf8');
const drawer = readFileSync('src/components/pmfreak/navigation/advanced-drawer.tsx', 'utf8');

// W1 replaced the module-inventory hierarchy with a four-item product hierarchy. The
// assertions below used to lock in the inventory — "workspace chat appears as primary",
// a "lens group", a seven-item "utility group", and a ban on the string "Command Center".
// Each is rewritten to the invariant that superseded it rather than dropped; the exact
// membership and ordering contract lives in tests/ux-w1-navigation-ia.test.mjs.

test('workspace chat is NOT primary navigation', () => {
  // Was: "workspace chat appears as primary visible node". Chat is the copilot layer, not
  // a destination a PM navigates to, so it is navigation-hidden entirely — /workspaces
  // stays, in the secondary group.
  assert.doesNotMatch(hierarchy, /label: "Workspace Chat"/);
  assert.doesNotMatch(hierarchy, /href: "\/chat"/);
  assert.match(hierarchy, /label: "Workspaces"[\s\S]*tier: "utility"/);
});

test('the lens tier is gone, and its members were reclassified rather than dropped', () => {
  // Was: "lens group contains only required defaults" over Summary/Execution/Executive/
  // Portfolio. Command Center and Portfolio were promoted to primary, Executive moved to
  // the secondary group, and Summary (/dashboard) is navigation-hidden as a duplicate home.
  assert.doesNotMatch(hierarchy, /tier: "lens"/);
  assert.doesNotMatch(selectors, /NAV_STYLE\.lens/);
  assert.match(hierarchy, /label: "Command Center", href: "\/command-center", tier: "primary"/);
  assert.match(hierarchy, /label: "Portfolio", href: "\/portfolio", tier: "primary"/);
  assert.match(hierarchy, /label: "Executive"[\s\S]*tier: "utility"/);
  assert.doesNotMatch(hierarchy, /label: "Summary"/);
});

test('secondary group carries the supporting workspace surfaces', () => {
  // Was: "utility group contains only required defaults". Members changed (Members → Team,
  // Executive and Workspace Setup joined, Projects was promoted to primary); the tier's
  // role — real surfaces that are not the daily loop — did not.
  for (const util of ['Workspaces', 'PMOs', 'Programs', 'Team', 'Upload', 'Executive']) {
    assert.match(hierarchy, new RegExp(`label: "${util}"[\\s\\S]*tier: "utility"`));
  }
});

test('advanced surfaces are hidden by default', () => {
  assert.match(hierarchy, /tier: "advanced"[\s\S]*visibleByDefault: false/);
});

test('capability reveal adds to advanced group only', () => {
  assert.match(selectors, /if \(node\.tier !== "advanced"\) return node\.visibleByDefault/);
  assert.match(shell, /AdvancedDrawer items=\{advancedNav\}/);
});

test('no legacy top-level labels remain', () => {
  // Was a ban on the string "Command Center" itself, from an earlier naming era. Command
  // Center is now the canonical name of /command-center, so the ban moved to the labels
  // that actually competed with it.
  assert.doesNotMatch(hierarchy, /Risk Center|PMO Overview|label: "Copilot"/);
  assert.doesNotMatch(hierarchy, /label: "Daily Execution"|label: "Create Center"|label: "New Project"|label: "Summary"|label: "Members"/);
});

test('operational shell renders one secondary group, not a lens/utility split', () => {
  // Was: asserts a "Lenses" heading AND a "Utilities" heading. Two adjacent secondary
  // groupings were part of the inventory problem; there is one "More" now.
  assert.match(shell, /Workspace<\/p>/);
  assert.match(shell, /More<\/p>/);
  assert.doesNotMatch(shell, /Lenses<\/p>/);
  assert.doesNotMatch(shell, /Utilities<\/p>/);
  assert.match(drawer, /Advanced Runtime/);
});

test('workspace remains canonical active default', () => {
  assert.match(shell, /href="\/workspaces"/);
});
