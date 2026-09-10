import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync('src/app/(protected)/dashboard/page.tsx', 'utf8');
const commandCenter = readFileSync('src/app/(protected)/workspaces/[workspaceId]/command-center/page.tsx', 'utf8');
const executive = readFileSync('src/app/(protected)/executive/page.tsx', 'utf8');
const portfolio = readFileSync('src/app/(protected)/portfolio/page.tsx', 'utf8');
const nav = readFileSync('src/features/runtime/capability-reveal/capability-reveal-selectors.ts', 'utf8');
const authResolver = readFileSync('src/lib/auth/resolve-post-auth-destination.ts', 'utf8');

for (const [name, file] of Object.entries({ dashboard, commandCenter, executive, portfolio })) {
  test(`${name} avoids home-authority wording`, () => {
    assert.doesNotMatch(file, /Operational Home|Dashboard Home|Main Dashboard|Primary Operations Center|Executive Center|Executive Home/);
  });

  test(`${name} includes workspace context banner`, () => {
    assert.match(file, /WorkspaceContextBanner/);
    assert.match(file, /Return to Workspace|returnHref="\/workspace"|lens="/);
  });
}

test('navigation labels use lens semantics', () => {
  assert.match(nav, /Execution Lens/);
  assert.match(nav, /Executive Lens/);
  assert.doesNotMatch(nav, /Command Center", href: "\/command-center"/);
});

test('post-auth default is command-center, not the legacy workspace shell', () => {
  assert.ok(authResolver.includes('return { destination: "/command-center", reason: "command-center-default" };'));
});

test('explicitly requested legacy route remains allowed continuation', () => {
  assert.ok(authResolver.includes("if (context.requestedRoute && context.isRequestedRouteSafe)"));
  assert.ok(authResolver.includes('destination: context.requestedRoute, reason: "requested-route"'));
});
