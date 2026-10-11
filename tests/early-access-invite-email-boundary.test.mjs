// Perilla 3 — Invite Acceptance / Workspace Role Assignment Hardening.
//
// acceptEarlyAccessInvite (src/lib/early-access.ts) creates a brand-new workspace
// and assigns the accepting user "owner" (hardcoded, never client-supplied — that
// part was already correct). What it was missing: any authenticated user holding a
// valid, pending invite token — regardless of which email the invite was addressed
// to — could activate it under their own account, since invite_email was fetched
// but never compared to the accepting user's email.
//
// acceptEarlyAccessInvite has no dependency-injection seam (it calls
// createSupabaseServiceRoleClient / logFirstUserTelemetryEvent directly, both of
// which need live Supabase env/config), so a full behavioral test isn't practical
// without a live database or a broader refactor outside this perilla's scope. This
// is a source-level regression test confirming the email-match guard exists and
// runs before any workspace/membership mutation — the primary, fully
// behaviorally-tested fix for this perilla is the workspace_invitations path
// covered by tests/invite-workspace-role-boundary.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("acceptEarlyAccessInvite: requires userEmail and validates it against invite_email before any workspace/membership mutation", async () => {
  const source = await fs.readFile(new URL("../src/lib/early-access.ts", import.meta.url), "utf8");

  const signatureMatch = source.match(/export async function acceptEarlyAccessInvite\(input: \{([^}]*)\}\)/);
  assert.ok(signatureMatch, "acceptEarlyAccessInvite signature not found");
  assert.match(signatureMatch[1], /userEmail:\s*string/, "acceptEarlyAccessInvite must require userEmail");

  const bodyStart = source.indexOf("export async function acceptEarlyAccessInvite");
  const bodyEnd = source.indexOf("export async function", bodyStart + 1);
  const body = source.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
  const emailCheckIndex = body.indexOf("email_mismatch::");
  // Workspace + owner membership creation now happen only inside the atomic
  // accept_early_access_invite RPC (migration 20261011000000), which also
  // re-checks the email binding under a row lock.
  const activationRpcIndex = body.indexOf('rpc("accept_early_access_invite"');

  assert.ok(emailCheckIndex > -1, "email_mismatch check not found in acceptEarlyAccessInvite");
  assert.ok(activationRpcIndex > emailCheckIndex, "email match must be validated before the activation RPC creates the workspace and membership");
  assert.doesNotMatch(body, /\.from\("workspaces"\)/, "the workspace must not be created outside the atomic activation RPC");
  assert.doesNotMatch(body, /\.from\("workspace_memberships"\)/, "the membership must not be written outside the atomic activation RPC");
  assert.match(body, /p_user_email:\s*normalizedUserEmail/, "the RPC must receive the same authenticated email that was checked");
});

test("acceptEarlyAccessInvite: accept route passes the authenticated user's real email, not a client-supplied field", async () => {
  const source = await fs.readFile(new URL("../src/app/api/early-access/accept/route.ts", import.meta.url), "utf8");
  assert.match(source, /userEmail:\s*user\.email/, "the route must pass the authenticated user's email, never a value read from the request body");
  assert.doesNotMatch(source, /userEmail:\s*body\./, "userEmail must not be sourced from the request body");
});
