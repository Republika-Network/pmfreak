/**
 * Pilot Gate Sprint 01 — Task 4 (F-13 vault/intake authorization).
 *
 * Verifies the app-layer workspace-membership check on /api/vault/intake,
 * independent of RLS state: a non-member-supplied workspaceId is denied
 * with 403 BEFORE any database client is created or any ingestion runs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { handleVaultIntake } from "../src/app/api/vault/intake/route";
import { AccessDeniedError } from "../src/lib/security/access-guards";

const USER = { id: "user-1", companyId: "company-1", email: "u@example.com", role: "pm" } as never;

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/vault/intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function trackingDeps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      getAuthUser: async () => { calls.push("getAuthUser"); return USER; },
      requireWorkspaceMember: async () => {
        calls.push("requireWorkspaceMember");
        throw new AccessDeniedError("Capability denied by enterprise runtime.", { reason: "workspace_membership_required" });
      },
      createSupabaseServerClient: async () => { calls.push("createSupabaseServerClient"); throw new Error("must not be reached"); },
      ingestVaultDocument: async () => { calls.push("ingestVaultDocument"); throw new Error("must not be reached"); },
      ...overrides,
    } as never,
  };
}

test("non-member workspaceId is denied with 403 before any DB access", async () => {
  const { calls, deps } = trackingDeps();
  const response = await handleVaultIntake(makeRequest({ workspaceId: "ws-foreign", rawContent: "notes" }), deps);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "workspace_access_denied");
  assert.ok(!calls.includes("createSupabaseServerClient"), "DB client was created before authorization");
  assert.ok(!calls.includes("ingestVaultDocument"), "ingestion ran despite denial");
  assert.ok(!JSON.stringify(body).includes("workspace_membership_required"), "internal denial reason leaked");
});

test("membership check runs against the client-supplied workspaceId", async () => {
  let checkedWorkspaceId: string | null = null;
  const { deps } = trackingDeps({
    requireWorkspaceMember: async (workspaceId: string) => {
      checkedWorkspaceId = workspaceId;
      throw new AccessDeniedError("denied", { reason: "workspace_membership_required" });
    },
  });
  await handleVaultIntake(makeRequest({ workspaceId: "ws-target", rawContent: "notes" }), deps);
  assert.equal(checkedWorkspaceId, "ws-target");
});

test("unauthenticated caller is denied with 401 before the membership check", async () => {
  const { calls, deps } = trackingDeps({ getAuthUser: async () => null });
  const response = await handleVaultIntake(makeRequest({ workspaceId: "ws-1", rawContent: "notes" }), deps);
  assert.equal(response.status, 401);
  assert.ok(!calls.includes("requireWorkspaceMember"));
});

test("missing workspaceId or content is rejected with 400 before authorization", async () => {
  const { calls, deps } = trackingDeps();
  const response = await handleVaultIntake(makeRequest({ rawContent: "   " }), deps);
  assert.equal(response.status, 400);
  assert.ok(!calls.includes("requireWorkspaceMember"));
});

test("member passes authorization and reaches ingestion", async () => {
  const calls: string[] = [];
  const deps = {
    getAuthUser: async () => USER,
    requireWorkspaceMember: async () => { calls.push("requireWorkspaceMember"); return { allowed: true } as never; },
    resolveWorkspaceRole: async () => { calls.push("resolveWorkspaceRole"); return "pm"; },
    createSupabaseServerClient: async () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) as never,
    ingestVaultDocument: async () => { calls.push("ingestVaultDocument"); return { ingestionStatus: "completed" } as never; },
  } as never;
  const response = await handleVaultIntake(makeRequest({ workspaceId: "ws-1", rawContent: "meeting notes" }), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["requireWorkspaceMember", "resolveWorkspaceRole", "ingestVaultDocument"]);
});

test("F22-B: a member without upload rights (viewer) is refused with 403 before any ingestion", async () => {
  for (const role of ["viewer", null]) {
    const calls: string[] = [];
    const deps = {
      getAuthUser: async () => USER,
      requireWorkspaceMember: async () => { calls.push("requireWorkspaceMember"); return { allowed: true } as never; },
      resolveWorkspaceRole: async (workspaceId: string, userId: string) => {
        calls.push(`resolveWorkspaceRole:${workspaceId}:${userId}`);
        return role;
      },
      createSupabaseServerClient: async () => { calls.push("createSupabaseServerClient"); throw new Error("must not be reached"); },
      ingestVaultDocument: async () => { calls.push("ingestVaultDocument"); throw new Error("must not be reached"); },
    } as never;
    const response = await handleVaultIntake(makeRequest({ workspaceId: "ws-1", rawContent: "meeting notes" }), deps);
    assert.equal(response.status, 403, String(role));
    assert.equal((await response.json()).error, "insufficient_role");
    assert.deepEqual(calls, ["requireWorkspaceMember", "resolveWorkspaceRole:ws-1:user-1"], "role resolved for the caller, nothing ingested");
  }
});

test("F22-B: owner, admin and pm reach ingestion", async () => {
  for (const role of ["owner", "admin", "pm"]) {
    let ingested = false;
    const deps = {
      getAuthUser: async () => USER,
      requireWorkspaceMember: async () => ({ allowed: true }) as never,
      resolveWorkspaceRole: async () => role,
      createSupabaseServerClient: async () => ({}) as never,
      ingestVaultDocument: async () => { ingested = true; return { ingestionStatus: "completed" } as never; },
    } as never;
    const response = await handleVaultIntake(makeRequest({ workspaceId: "ws-1", rawContent: "meeting notes" }), deps);
    assert.equal(response.status, 200, role);
    assert.ok(ingested, role);
  }
});
