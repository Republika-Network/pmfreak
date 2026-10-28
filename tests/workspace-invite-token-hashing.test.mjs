// Perilla 11 — workspace invite token hashing (beta release closure gate).
//
// Contract: workspace_invitations stores only sha256(token) in `token_hash`;
// the plaintext token exists exactly once, in the accept URL returned by
// inviteWorkspaceMember, and is never persisted or logged. Legacy plaintext
// invitations were revoked and the `token` column dropped by
// supabase/migrations/20260820000000_workspace_invite_token_hashing.sql.
//
// Rejection/replay/role-boundary behavior for the accept path is covered by
// tests/invite-workspace-role-boundary.test.mjs (Perilla 3), which now runs
// against hashed fixtures. This file covers what is specific to hashing:
// hash-only storage, legacy-token invalidation, migration shape, no token
// in logs, and the TTL env contract.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkspaceInviteToken,
  hashWorkspaceInviteToken,
  resolveInviteTtlHours,
} from "../src/lib/security/invite-tokens.ts";
import { acceptWorkspaceInvite, WorkspaceInviteError } from "../src/lib/workspace-team.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readRepoFile = (relPath) => readFileSync(path.join(repoRoot, relPath), "utf8");

const MIGRATION_PATH = "supabase/migrations/20260820000000_workspace_invite_token_hashing.sql";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

// ─────────────────────────────────────────────────────────────────────────────
// Token primitives
// ─────────────────────────────────────────────────────────────────────────────

test("createWorkspaceInviteToken produces high-entropy, unique, URL-safe tokens", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const token = createWorkspaceInviteToken();
    // 24 random bytes → 32 base64url chars; anything shorter would weaken the
    // "plain sha256 is enough" premise of hash-only storage.
    assert.equal(token.length, 32);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(!seen.has(token), "tokens must never repeat");
    seen.add(token);
  }
});

test("hashWorkspaceInviteToken is sha256 hex of the token", () => {
  const token = "example-token";
  assert.equal(hashWorkspaceInviteToken(token), sha256(token));
  assert.match(hashWorkspaceInviteToken(createWorkspaceInviteToken()), /^[0-9a-f]{64}$/);
});

test("resolveInviteTtlHours: default 168h, accepts sane overrides, rejects unsafe values", () => {
  assert.equal(resolveInviteTtlHours(undefined), 168);
  assert.equal(resolveInviteTtlHours(""), 168);
  assert.equal(resolveInviteTtlHours("24"), 24);
  assert.equal(resolveInviteTtlHours("720"), 720);
  // Unparsable, non-integer, zero, negative, or unbounded values must fall
  // back to the conservative default, never to a zero/infinite TTL.
  for (const raw of ["abc", "1.5", "0", "-4", "9999", "Infinity", "NaN"]) {
    assert.equal(resolveInviteTtlHours(raw), 168, `TTL override ${JSON.stringify(raw)} must be rejected`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Hash-only storage (source contract on src/lib/workspace-team.ts)
// ─────────────────────────────────────────────────────────────────────────────

test("inviteWorkspaceMember persists token_hash, never a plaintext token column", () => {
  const source = readRepoFile("src/lib/workspace-team.ts");
  assert.match(source, /token_hash:\s*hashWorkspaceInviteToken\(token\)/, "insert must store the sha256 hash");
  // No database write (insert/update/upsert payload) may carry a plaintext
  // `token` field — only `token_hash` — and audit payloads must not carry
  // the token either.
  // A bare `token` field key (shorthand `token,` or `token:`) in any write
  // payload would persist the plaintext; `token_hash:` is the only allowed key.
  const tokenFieldKey = /[{,]\s*token\s*[:,]/;
  const writePayloads = source.match(/\.(?:insert|update|upsert)\(\{[\s\S]*?\}/g) ?? [];
  assert.ok(writePayloads.length >= 3, "expected the known write sites in workspace-team.ts");
  for (const payload of writePayloads) {
    assert.doesNotMatch(payload, tokenFieldKey, `plaintext token in write payload: ${payload.slice(0, 80)}`);
  }
  const auditPayloads = source.match(/payload:\s*\{[^}]*\}/g) ?? [];
  for (const payload of auditPayloads) {
    assert.doesNotMatch(payload, tokenFieldKey, `token in audit payload: ${payload}`);
  }
});

test("invite lookup is by token_hash — the plaintext token never reaches a query filter", () => {
  const source = readRepoFile("src/lib/workspace-team.ts");
  assert.match(source, /\.eq\("token_hash",\s*hashWorkspaceInviteToken\(trimmedToken\)\)/);
  assert.doesNotMatch(source, /\.eq\("token"/, "no query may filter on a plaintext token column");
});

test("workspace-team.ts never logs — tokens cannot leak through console output", () => {
  const source = readRepoFile("src/lib/workspace-team.ts");
  assert.doesNotMatch(source, /console\./, "workspace-team.ts must not contain console logging");
});

// ─────────────────────────────────────────────────────────────────────────────
// Accept path against hashed fixtures (fake in-memory Supabase client,
// same injection seam as tests/invite-workspace-role-boundary.test.mjs)
// ─────────────────────────────────────────────────────────────────────────────

// Every fixture invite was issued by "u-inviter", who is still an owner of the workspace —
// acceptance re-validates the inviter and the accepting user's membership (F22-A).
function makeFakeSupabase(invite) {
  const state = { invite: invite ? { invited_by_user_id: "u-inviter", ...invite } : null, memberships: [], auditEvents: [] };
  const existingMemberships = invite ? [{ workspace_id: invite.workspace_id, user_id: "u-inviter", role: "owner" }] : [];

  function invitationsBuilder() {
    return {
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
  }

  return {
    state,
    // GoTrue: the accepting user holds the invitation's email as a confirmed address (F22-B).
    auth: {
      admin: {
        async getUserById(id) {
          return { data: { user: { id, email: state.invite?.email ?? null, email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null };
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
            const row = [...existingMemberships, ...state.memberships].find((m) => Object.entries(filters).every(([key, value]) => String(m[key]) === String(value)));
            return { data: row ? { role: row.role } : null, error: null };
          },
          async insert(row) {
            state.memberships.push(row);
            return { error: null };
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

test("a token generated by createWorkspaceInviteToken is accepted via its stored hash", async () => {
  const token = createWorkspaceInviteToken();
  const client = makeFakeSupabase({
    id: "invite-hash-1",
    workspace_id: "workspace.demo",
    email: "user@example.com",
    role: "pm",
    status: "pending",
    token_hash: hashWorkspaceInviteToken(token),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const result = await acceptWorkspaceInvite({ token, userId: "u-1", userEmail: "user@example.com" }, async () => client);
  assert.equal(result.workspaceId, "workspace.demo");
  assert.equal(result.role, "pm");
  assert.equal(client.state.memberships.length, 1);
});

test("legacy plaintext tokens cannot be used: a row with only a plaintext token never matches", async () => {
  // Pre-migration rows carried `token` and no `token_hash`. After the
  // migration such rows are revoked, but even an un-revoked straggler must
  // be unreachable: the lookup filters on token_hash, which the row lacks.
  const client = makeFakeSupabase({
    id: "invite-legacy-1",
    workspace_id: "workspace.demo",
    email: "user@example.com",
    role: "admin",
    status: "pending",
    token: "legacy-plaintext-token",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  await assert.rejects(
    () => acceptWorkspaceInvite({ token: "legacy-plaintext-token", userId: "u-1", userEmail: "user@example.com" }, async () => client),
    (error) => error instanceof WorkspaceInviteError && error.reason === "invalid_token",
  );
  assert.equal(client.state.memberships.length, 0);
});

test("presenting the stored hash itself as a token is rejected (hash is not a bearer credential)", async () => {
  const token = createWorkspaceInviteToken();
  const tokenHash = hashWorkspaceInviteToken(token);
  const client = makeFakeSupabase({
    id: "invite-hash-2",
    workspace_id: "workspace.demo",
    email: "user@example.com",
    role: "viewer",
    status: "pending",
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  await assert.rejects(
    () => acceptWorkspaceInvite({ token: tokenHash, userId: "u-1", userEmail: "user@example.com" }, async () => client),
    (error) => error instanceof WorkspaceInviteError && error.reason === "invalid_token",
  );
});

test("accepting never logs the token (console stays silent through the accept path)", async (t) => {
  const calls = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    t.mock.method(console, level, (...args) => {
      calls.push(args.map((a) => String(a)).join(" "));
    });
  }

  const token = createWorkspaceInviteToken();
  const client = makeFakeSupabase({
    id: "invite-hash-3",
    workspace_id: "workspace.demo",
    email: "user@example.com",
    role: "viewer",
    status: "pending",
    token_hash: hashWorkspaceInviteToken(token),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  await acceptWorkspaceInvite({ token, userId: "u-1", userEmail: "user@example.com" }, async () => client);
  const leaked = calls.filter((line) => line.includes(token));
  assert.deepEqual(leaked, [], "the plaintext token must never be written to console");
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration shape (idempotent legacy invalidation + plaintext column removal)
// ─────────────────────────────────────────────────────────────────────────────

test("migration adds token_hash + revoked_at, unique-indexes the hash, and drops the plaintext column", () => {
  const sql = readRepoFile(MIGRATION_PATH).toLowerCase();
  assert.match(sql, /add column if not exists token_hash text/);
  assert.match(sql, /add column if not exists revoked_at timestamptz/);
  assert.match(sql, /create unique index if not exists workspace_invitations_token_hash_unique/);
  assert.match(sql, /drop column if exists token/);
});

test("migration revokes legacy pending plaintext invitations idempotently", () => {
  const sql = readRepoFile(MIGRATION_PATH).toLowerCase();
  const revocation = sql.match(/update public\.workspace_invitations[\s\S]*?where[\s\S]*?;/);
  assert.ok(revocation, "expected an UPDATE that invalidates legacy invitations");
  assert.match(revocation[0], /status = 'revoked'/);
  assert.match(revocation[0], /status = 'pending'/);
  // `token_hash is null` is what makes the statement idempotent: post-migration
  // inserts always carry a hash, so re-running can never revoke live invites.
  assert.match(revocation[0], /token_hash is null/);
});

test("migration re-issues the authenticated column grant without token_hash", () => {
  const sql = readRepoFile(MIGRATION_PATH).toLowerCase();
  assert.match(sql, /revoke select on public\.workspace_invitations from authenticated/);
  const grantMatch = sql.match(/grant select\s*\(([\s\S]*?)\)\s*on public\.workspace_invitations to authenticated/);
  assert.ok(grantMatch, "expected a column-scoped grant select on workspace_invitations");
  assert.doesNotMatch(grantMatch[1], /token/, "neither token nor token_hash may be granted to authenticated");
});
