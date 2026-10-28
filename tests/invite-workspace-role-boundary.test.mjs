// Perilla 3 — Invite Acceptance / Workspace Role Assignment Hardening.
//
// Behavioral tests for the trust boundary around workspace_memberships.role:
// who may create an invite, what role an invite may carry, and how acceptance
// validates the token/email/role before ever writing a membership row.
//
// - normalizeWorkspaceRole / canAssignWorkspaceRole / requireWorkspaceInviteActor
//   (src/lib/workspace-access.ts) are pure or DB-injectable — exercised directly,
//   the same pattern as tests/billing-authorization-workspace-membership.test.mjs.
// - acceptWorkspaceInvite (src/lib/workspace-team.ts) is exercised against a fake
//   in-memory Supabase client injected via its getSupabaseClient parameter — the
//   real validation/claim/upsert logic runs unmodified, no live database needed.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  WORKSPACE_ROLES,
  INVITABLE_WORKSPACE_ROLES,
  normalizeWorkspaceRole,
  canAssignWorkspaceRole,
  canInviteMembers,
  requireWorkspaceInviteActor,
  WorkspaceMembershipError,
} from "../src/lib/workspace-access.ts";
import { acceptWorkspaceInvite, WorkspaceInviteError } from "../src/lib/workspace-team.ts";

// ─────────────────────────────────────────────────────────────────────────────
// normalizeWorkspaceRole / canAssignWorkspaceRole (pure)
// ─────────────────────────────────────────────────────────────────────────────

test("normalizeWorkspaceRole: valid roles pass through unchanged", () => {
  for (const role of WORKSPACE_ROLES) assert.equal(normalizeWorkspaceRole(role), role);
});

test("normalizeWorkspaceRole: casing is normalized safely (test #13)", () => {
  assert.equal(normalizeWorkspaceRole("ADMIN"), "admin");
  assert.equal(normalizeWorkspaceRole("Viewer"), "viewer");
  assert.equal(normalizeWorkspaceRole("  owner  "), "owner");
});

test("normalizeWorkspaceRole: unknown/garbage/prototype-pollution-shaped values are rejected, never coerced (test #13)", () => {
  assert.equal(normalizeWorkspaceRole("superadmin"), null);
  assert.equal(normalizeWorkspaceRole("__proto__"), null);
  assert.equal(normalizeWorkspaceRole("constructor"), null);
  assert.equal(normalizeWorkspaceRole(""), null);
  assert.equal(normalizeWorkspaceRole(null), null);
  assert.equal(normalizeWorkspaceRole(undefined), null);
  assert.equal(normalizeWorkspaceRole(123), null);
  assert.equal(normalizeWorkspaceRole(true), null);
  assert.equal(normalizeWorkspaceRole({ toString: () => "owner" }), null);
  assert.equal(normalizeWorkspaceRole(["owner"]), null);
});

test("INVITABLE_WORKSPACE_ROLES excludes owner", () => {
  assert.deepEqual([...INVITABLE_WORKSPACE_ROLES].sort(), ["admin", "pm", "viewer"]);
});

test("canAssignWorkspaceRole: owner assignment is blocked in the normal invite flow regardless of actor (test #12)", () => {
  assert.equal(canAssignWorkspaceRole({ actorRole: "owner", targetRole: "owner" }), false);
  assert.equal(canAssignWorkspaceRole({ actorRole: "admin", targetRole: "owner" }), false);
});

test("canAssignWorkspaceRole: owner/admin actors can assign admin/pm/viewer (test #11)", () => {
  for (const actorRole of ["owner", "admin"]) {
    for (const targetRole of ["admin", "pm", "viewer"]) {
      assert.equal(canAssignWorkspaceRole({ actorRole, targetRole }), true, `${actorRole} -> ${targetRole}`);
    }
  }
});

test("canAssignWorkspaceRole: pm/viewer actors cannot assign any role, including to themselves (test #10)", () => {
  for (const actorRole of ["pm", "viewer"]) {
    for (const targetRole of WORKSPACE_ROLES) {
      assert.equal(canAssignWorkspaceRole({ actorRole, targetRole }), false, `${actorRole} -> ${targetRole}`);
    }
  }
});

test("canInviteMembers / canAssignWorkspaceRole agree on who may invite at all", () => {
  for (const role of WORKSPACE_ROLES) {
    assert.equal(canAssignWorkspaceRole({ actorRole: role, targetRole: "viewer" }), canInviteMembers(role));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// requireWorkspaceInviteActor (DB-injectable, mirrors requireBillingManageMembership)
// ─────────────────────────────────────────────────────────────────────────────

function fakeMembershipClient(row) {
  return {
    from(table) {
      assert.equal(table, "workspace_memberships", "actor gate must query workspace_memberships directly");
      return {
        select(columns) {
          assert.equal(columns, "role");
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: row }),
      };
    },
  };
}

const requireActor = (input, row) => requireWorkspaceInviteActor(input, async () => fakeMembershipClient(row));

test("requireWorkspaceInviteActor: owner/admin membership resolves and returns the validated role (test #11)", async () => {
  assert.deepEqual(await requireActor({ userId: "u-owner", workspaceId: "w-1" }, { role: "owner" }), { userId: "u-owner", workspaceId: "w-1", role: "owner" });
  assert.deepEqual(await requireActor({ userId: "u-admin", workspaceId: "w-1" }, { role: "admin" }), { userId: "u-admin", workspaceId: "w-1", role: "admin" });
});

test("requireWorkspaceInviteActor: pm/viewer membership is denied — normal user cannot create invite (test #10)", async () => {
  for (const role of ["pm", "viewer"]) {
    await assert.rejects(
      () => requireActor({ userId: "u-1", workspaceId: "w-1" }, { role }),
      (error) => {
        assert.ok(error instanceof WorkspaceMembershipError);
        assert.equal(error.reason, "insufficient_role");
        return true;
      },
    );
  }
});

test("requireWorkspaceInviteActor: missing membership fails closed", async () => {
  await assert.rejects(
    () => requireActor({ userId: "u-nobody", workspaceId: "w-does-not-exist" }, undefined),
    (error) => {
      assert.ok(error instanceof WorkspaceMembershipError);
      assert.equal(error.reason, "workspace_missing");
      return true;
    },
  );
});

test("requireWorkspaceInviteActor: unrecognized/garbage role value fails closed, never silently trusted", async () => {
  await assert.rejects(() => requireActor({ userId: "u-1", workspaceId: "w-1" }, { role: "superadmin" }), WorkspaceMembershipError);
});

test("requireWorkspaceInviteActor: user_metadata.role / display role cannot influence this decision — only workspace_memberships is read (tests #14, #15)", async () => {
  // The function signature only accepts userId/workspaceId; even if a caller tries to
  // smuggle a spoofed role/displayRole/metadata field in, nothing reads it — the real
  // workspace_memberships row (here: viewer) is the only thing that decides the outcome.
  await assert.rejects(
    () =>
      requireActor(
        { userId: "u-1", workspaceId: "w-1", role: "owner", actorRole: "owner", displayRole: "admin", userMetadataRole: "admin" },
        { role: "viewer" },
      ),
    (error) => {
      assert.ok(error instanceof WorkspaceMembershipError);
      assert.equal(error.reason, "insufficient_role");
      return true;
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// acceptWorkspaceInvite — fake in-memory Supabase client
// ─────────────────────────────────────────────────────────────────────────────

// Perilla 11: the table stores sha256(token) in `token_hash`, never the
// plaintext — fixtures carry the hash of the token the test presents.
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function baseInvite(overrides = {}) {
  return {
    id: "invite-1",
    workspace_id: "workspace.demo",
    email: "user@example.com",
    role: "viewer",
    status: "pending",
    token_hash: sha256("valid-token"),
    expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
    invited_by_user_id: "u-inviter",
    ...overrides,
  };
}

// `memberships` holds rows written by acceptance; `existingMemberships` seeds the workspace
// (by default the inviter, as owner) and is what the F22-A acceptance checks read.
// `authUsers` models GoTrue (auth.admin.getUserById); by default every user holds the
// invitation's email as a confirmed address (F22-B).
function makeFakeSupabase(invite, { existingMemberships = [{ workspace_id: invite?.workspace_id, user_id: "u-inviter", role: "owner" }], authUsers = {} } = {}) {
  const state = { invite: invite ? { ...invite } : null, memberships: [], existingMemberships: [...existingMemberships], auditEvents: [] };
  const membershipRows = () => [...state.existingMemberships, ...state.memberships];

  function invitationsBuilder() {
    const builder = {
      _filters: {},
      _patch: null,
      select() {
        return this;
      },
      update(patch) {
        this._patch = patch;
        return this;
      },
      eq(column, value) {
        this._filters[column] = value;
        return this;
      },
      gt() {
        return this;
      },
      _matches() {
        if (!state.invite) return false;
        return Object.entries(this._filters).every(([key, value]) => String(state.invite[key]) === String(value));
      },
      _execute() {
        if (!this._matches()) return { data: null, error: null };
        if (this._patch) {
          Object.assign(state.invite, this._patch);
          return { data: { id: state.invite.id }, error: null };
        }
        return { data: { ...state.invite }, error: null };
      },
      async maybeSingle() {
        return this._execute();
      },
      then(resolve, reject) {
        try {
          resolve(this._execute());
        } catch (error) {
          reject(error);
        }
      },
    };
    return builder;
  }

  return {
    state,
    auth: {
      admin: {
        async getUserById(id) {
          const user = id in authUsers ? authUsers[id] : { id, email: state.invite?.email ?? null, email_confirmed_at: "2026-01-01T00:00:00Z" };
          return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "User not found" } };
        },
      },
    },
    from(table) {
      if (table === "workspace_invitations") return invitationsBuilder();
      if (table === "workspace_memberships") {
        const filters = {};
        return {
          select() {
            return this;
          },
          eq(column, value) {
            filters[column] = value;
            return this;
          },
          async maybeSingle() {
            const row = membershipRows().find((m) => Object.entries(filters).every(([key, value]) => String(m[key]) === String(value)));
            return { data: row ? { role: row.role } : null, error: null };
          },
          async insert(row) {
            if (membershipRows().some((m) => m.workspace_id === row.workspace_id && m.user_id === row.user_id)) {
              return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            }
            state.memberships.push(row);
            return { error: null };
          },
          async upsert() {
            throw new Error("acceptance must never upsert a membership (F22-A)");
          },
        };
      }
      if (table === "workspace_audit_events") {
        return {
          async insert(row) {
            state.auditEvents.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

async function callAccept(input, invite) {
  const client = makeFakeSupabase(invite);
  try {
    const result = await acceptWorkspaceInvite(input, async () => client);
    return { ok: true, result, client };
  } catch (error) {
    return { ok: false, error, client };
  }
}

test("acceptWorkspaceInvite: client-supplied role/isOwner/workspaceRole fields are ignored — membership role always comes from the invite record (tests #1, #2, #16)", async () => {
  const invite = baseInvite({ role: "viewer" });
  const outcome = await callAccept(
    { token: "valid-token", userId: "u-1", userEmail: "user@example.com", role: "owner", workspaceRole: "admin", isOwner: true, isAdmin: true },
    invite,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.role, "viewer");
  assert.equal(outcome.client.state.memberships.length, 1);
  assert.equal(outcome.client.state.memberships[0].role, "viewer");
});

test("acceptWorkspaceInvite: invalid/unknown token fails closed — no membership created (test #3)", async () => {
  const outcome = await callAccept({ token: "does-not-exist", userId: "u-1", userEmail: "user@example.com" }, null);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof WorkspaceInviteError);
  assert.equal(outcome.error.reason, "invalid_token");
  assert.equal(outcome.client.state.memberships.length, 0);
});

test("acceptWorkspaceInvite: empty token fails closed", async () => {
  const outcome = await callAccept({ token: "   ", userId: "u-1", userEmail: "user@example.com" }, baseInvite());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.reason, "invalid_token");
});

test("acceptWorkspaceInvite: expired invite fails closed and marks status expired server-side — no membership created (test #4)", async () => {
  const invite = baseInvite({ expires_at: new Date(Date.now() - 1000).toISOString() });
  const outcome = await callAccept({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, invite);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.reason, "expired");
  assert.equal(outcome.client.state.memberships.length, 0);
  assert.equal(outcome.client.state.invite.status, "expired");
});

test("acceptWorkspaceInvite: revoked invite fails closed — no membership created (test #5)", async () => {
  const invite = baseInvite({ status: "revoked" });
  const outcome = await callAccept({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, invite);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.reason, "revoked");
  assert.equal(outcome.client.state.memberships.length, 0);
});

test("acceptWorkspaceInvite: already-accepted invite fails closed — no replay, no membership created (test #6)", async () => {
  const invite = baseInvite({ status: "accepted", role: "admin" });
  const outcome = await callAccept({ token: "valid-token", userId: "attacker", userEmail: "user@example.com" }, invite);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.reason, "already_used");
  assert.equal(outcome.client.state.memberships.length, 0);
});

test("acceptWorkspaceInvite: a used token cannot replay elevation against an existing membership (test #17)", async () => {
  const invite = baseInvite({ status: "accepted", role: "admin" });
  const client = makeFakeSupabase(invite);
  client.state.memberships.push({ workspace_id: invite.workspace_id, user_id: "u-1", role: "viewer" });

  const outcome = await acceptWorkspaceInvite({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, async () => client).then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error }),
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.reason, "already_used");
  assert.equal(client.state.memberships.length, 1, "no new membership row written");
  assert.equal(client.state.memberships[0].role, "viewer", "existing membership role must not be escalated");
});

test("acceptWorkspaceInvite: replaying the same token after a successful accept is rejected, not re-accepted (single-use)", async () => {
  const invite = baseInvite();
  const client = makeFakeSupabase(invite);
  const first = await acceptWorkspaceInvite({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, async () => client);
  assert.equal(first.role, "viewer");
  assert.equal(client.state.memberships.length, 1);

  await assert.rejects(
    () => acceptWorkspaceInvite({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, async () => client),
    (error) => {
      assert.ok(error instanceof WorkspaceInviteError);
      assert.equal(error.reason, "already_used");
      return true;
    },
  );
  assert.equal(client.state.memberships.length, 1, "replay must not create a second membership row");
});

test("acceptWorkspaceInvite: email mismatch fails closed and does not consume the invite (test #7)", async () => {
  const invite = baseInvite({ email: "invited@example.com" });
  const outcome = await callAccept({ token: "valid-token", userId: "attacker", userEmail: "attacker@example.com" }, invite);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.reason, "email_mismatch");
  assert.equal(outcome.client.state.memberships.length, 0);
  assert.equal(outcome.client.state.invite.status, "pending", "a wrong-email attempt must not burn the invite for the real invitee");
});

test("acceptWorkspaceInvite: email match is case-insensitive but still required", async () => {
  const invite = baseInvite({ email: "User@Example.com" });
  const outcome = await callAccept({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, invite);
  assert.equal(outcome.ok, true);
});

test("acceptWorkspaceInvite: client-supplied workspaceId is ignored — membership always uses the invite's own workspace (test #8)", async () => {
  const invite = baseInvite({ workspace_id: "workspace.safe" });
  const outcome = await callAccept({ token: "valid-token", userId: "u-1", userEmail: "user@example.com", workspaceId: "workspace.attacker" }, invite);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.workspaceId, "workspace.safe");
  assert.equal(outcome.client.state.memberships[0].workspace_id, "workspace.safe");
});

test("acceptWorkspaceInvite: normal valid acceptance succeeds with the invite's role (test #9)", async () => {
  for (const role of ["admin", "pm", "viewer"]) {
    const invite = baseInvite({ id: `invite-${role}`, role, token_hash: sha256(`token-${role}`) });
    const outcome = await callAccept({ token: `token-${role}`, userId: `u-${role}`, userEmail: "user@example.com" }, invite);
    assert.equal(outcome.ok, true, role);
    assert.equal(outcome.result.role, role);
    assert.equal(outcome.client.state.invite.status, "accepted");
    assert.equal(outcome.client.state.invite.accepted_by_user_id, `u-${role}`);
    assert.ok(outcome.client.state.auditEvents.some((event) => event.event_type === "invitation_accepted"));
  }
});

test("acceptWorkspaceInvite: an invite record with an invalid/garbage stored role fails closed (test #13)", async () => {
  const invite = baseInvite({ role: "superadmin" });
  const outcome = await callAccept({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, invite);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.reason, "invalid_role");
  assert.equal(outcome.client.state.memberships.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// F22-A — acceptance re-validates the stored role, the inviter and the target membership
// ─────────────────────────────────────────────────────────────────────────────

test("acceptWorkspaceInvite (F22-B): the accepting account must hold the invite email as a CONFIRMED address in GoTrue", async () => {
  const cases = [
    { name: "unconfirmed email", user: { id: "u-1", email: "user@example.com", email_confirmed_at: null }, reason: "email_unverified" },
    { name: "GoTrue email differs from the claimed one", user: { id: "u-1", email: "someone-else@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" }, reason: "email_mismatch" },
    { name: "no such auth user", user: null, reason: "email_unverified" },
  ];
  for (const c of cases) {
    const client = makeFakeSupabase(baseInvite({ role: "pm" }), { authUsers: { "u-1": c.user } });
    await assert.rejects(
      () => acceptWorkspaceInvite({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, async () => client),
      (error) => error instanceof WorkspaceInviteError && error.reason === c.reason,
      c.name,
    );
    assert.equal(client.state.memberships.length, 0, c.name);
    assert.equal(client.state.invite.status, "pending", `${c.name}: invite is not consumed`);
  }
});

test("acceptWorkspaceInvite (F22-A): a stored owner invitation is refused, whoever wrote it", async () => {
  const outcome = await callAccept({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, baseInvite({ role: "owner" }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.reason, "invalid_role");
  assert.equal(outcome.client.state.memberships.length, 0);
  assert.equal(outcome.client.state.invite.status, "pending");
});

test("acceptWorkspaceInvite (F22-A): an inviter who left, was demoted, or is unknown voids the invitation", async () => {
  const cases = [
    { name: "inviter removed", invite: baseInvite({ role: "admin" }), existingMemberships: [] },
    { name: "inviter demoted to pm", invite: baseInvite({ role: "viewer" }), existingMemberships: [{ workspace_id: "workspace.demo", user_id: "u-inviter", role: "pm" }] },
    { name: "inviter unknown", invite: baseInvite({ invited_by_user_id: null }), existingMemberships: [] },
    { name: "inviter only a member of another workspace", invite: baseInvite(), existingMemberships: [{ workspace_id: "workspace.other", user_id: "u-inviter", role: "owner" }] },
  ];
  for (const c of cases) {
    const client = makeFakeSupabase(c.invite, { existingMemberships: c.existingMemberships });
    await assert.rejects(
      () => acceptWorkspaceInvite({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, async () => client),
      (error) => error instanceof WorkspaceInviteError && error.reason === "inviter_not_authorized",
      c.name,
    );
    assert.equal(client.state.memberships.length, 0, c.name);
    assert.equal(client.state.invite.status, "pending", `${c.name}: invite is not consumed`);
  }
});

test("acceptWorkspaceInvite (F22-A): an invitation never changes an existing membership — including the inviter's own", async () => {
  for (const [userId, existingRole, inviteRole] of [["u-1", "viewer", "admin"], ["u-inviter", "admin", "admin"], ["u-2", "pm", "viewer"]]) {
    const invite = baseInvite({ role: inviteRole });
    const client = makeFakeSupabase(invite, {
      existingMemberships: [
        { workspace_id: invite.workspace_id, user_id: "u-inviter", role: userId === "u-inviter" ? existingRole : "owner" },
        ...(userId === "u-inviter" ? [] : [{ workspace_id: invite.workspace_id, user_id: userId, role: existingRole }]),
      ],
    });
    await assert.rejects(
      () => acceptWorkspaceInvite({ token: "valid-token", userId, userEmail: "user@example.com" }, async () => client),
      (error) => error instanceof WorkspaceInviteError && error.reason === "already_member",
    );
    assert.equal(client.state.memberships.length, 0, "no membership written");
    assert.equal(client.state.existingMemberships.find((m) => m.user_id === userId).role, existingRole, "existing role untouched");
    assert.equal(client.state.invite.status, "pending", "invite not consumed");
  }
});

test("acceptWorkspaceInvite (F22-A): a membership that appears after the check is not overwritten and the claim is released", async () => {
  const invite = baseInvite({ role: "admin" });
  const client = makeFakeSupabase(invite);
  const originalFrom = client.from.bind(client);
  let membershipReads = 0;
  client.from = (table) => {
    const builder = originalFrom(table);
    if (table !== "workspace_memberships") return builder;
    const originalMaybeSingle = builder.maybeSingle.bind(builder);
    builder.maybeSingle = async () => {
      const result = await originalMaybeSingle();
      membershipReads += 1;
      // Second read is the accepting user's own membership check: a concurrent accept lands right after it.
      if (membershipReads === 2) client.state.existingMemberships.push({ workspace_id: invite.workspace_id, user_id: "u-1", role: "viewer" });
      return result;
    };
    return builder;
  };
  await assert.rejects(
    () => acceptWorkspaceInvite({ token: "valid-token", userId: "u-1", userEmail: "user@example.com" }, async () => client),
    (error) => error instanceof WorkspaceInviteError && error.reason === "already_member",
  );
  assert.equal(client.state.memberships.length, 0);
  assert.equal(client.state.existingMemberships.find((m) => m.user_id === "u-1").role, "viewer");
  assert.equal(client.state.invite.status, "pending", "claim released");
  assert.equal(client.state.invite.accepted_by_user_id, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Workspace creator owner flow is separate from invite acceptance (test #18)
// ─────────────────────────────────────────────────────────────────────────────

test("workspace creator owner assignment is a hardcoded server-side literal, not client-derived (source scan)", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../src/lib/workspaces.ts", import.meta.url), "utf8");
  // createWorkspace (the explicit "New Workspace" flow) still assigns owner
  // via the same ensureWorkspaceMembership helper with a literal string.
  assert.match(
    source,
    /ensureWorkspaceMembership\(userId, created\.id, "owner"\)/,
    "createWorkspace must assign owner via a literal string, never a variable derived from client input",
  );
  // PMF-004: first-login bootstrap (ensureUserWorkspace) now creates its
  // workspace+membership atomically via the ensure_user_workspace RPC
  // (20260831000000_pmo_command_center_activation_idempotency.sql) instead
  // of a raw check-then-insert, closing a concurrent-duplicate-workspace
  // race. The owner-role assignment moved into that SQL function, still as
  // a hardcoded literal, never a parameter.
  assert.match(
    source,
    /supabase\.rpc\("ensure_user_workspace"/,
    "first-login bootstrap must call the advisory-lock-guarded RPC, not a raw insert",
  );
  const migration = await fs.readFile(
    new URL("../supabase/migrations/20260831000000_pmo_command_center_activation_idempotency.sql", import.meta.url),
    "utf8",
  );
  const fn = migration.slice(migration.indexOf("create function ensure_user_workspace"));
  assert.match(
    fn,
    /values \(v_workspace\.id, p_user_id, 'owner'\)/,
    "ensure_user_workspace must assign owner via a literal string, never a parameter derived from client input",
  );
  assert.doesNotMatch(fn, /p_role/, "ensure_user_workspace must not accept a caller-supplied role parameter");
});
