#!/usr/bin/env node
// ============================================================================
// PB-CHAT-01 — live database proof for the Project Brain transcript hardening
// (supabase/migrations/20260915000000_pb_chat_01_project_brain_conversation.sql).
//
// Runs against a DISPOSABLE LOCAL Supabase stack only, through the real Data API
// with real signed-in users, so every RLS/grant claim is proven the way the app
// exercises it.
//
//   node scripts/check-pb-chat-01-db.mjs seed-legacy   (BEFORE applying the migration)
//   <apply the migration>
//   node scripts/check-pb-chat-01-db.mjs verify        (AFTER)
//
// `verify` alone also works on a fresh stack (it seeds what it needs); the
// `seed-legacy` phase adds the upgrade proof: historical rows written under the
// OLD schema survive, get a deterministic message_seq, and stay readable.
//
// Required env:
//   PB_CHAT_TEST_SUPABASE_URL, PB_CHAT_TEST_ANON_KEY, PB_CHAT_TEST_SERVICE_ROLE_KEY,
//   PB_CHAT_TEST_STATE (file path for the seed hand-off),
//   PB_CHAT_TEST_ALLOW_DESTRUCTIVE=true
// Secrets are never printed.
// ============================================================================

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.PB_CHAT_TEST_SUPABASE_URL;
const anonKey = process.env.PB_CHAT_TEST_ANON_KEY;
const serviceKey = process.env.PB_CHAT_TEST_SERVICE_ROLE_KEY;
const statePath = process.env.PB_CHAT_TEST_STATE;
const phase = process.argv[2];

if (!url || !anonKey || !serviceKey || !statePath || process.env.PB_CHAT_TEST_ALLOW_DESTRUCTIVE !== "true") {
  console.error("PB-CHAT-01 DB proof requires PB_CHAT_TEST_SUPABASE_URL, PB_CHAT_TEST_ANON_KEY, PB_CHAT_TEST_SERVICE_ROLE_KEY, PB_CHAT_TEST_STATE and PB_CHAT_TEST_ALLOW_DESTRUCTIVE=true.");
  process.exit(2);
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
  console.error("SAFETY ABORT: the Supabase URL must be a literal loopback host.");
  process.exit(2);
}
if (!["seed-legacy", "verify"].includes(phase)) {
  console.error("usage: check-pb-chat-01-db.mjs seed-legacy|verify");
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const PASSWORD = `pbchat-${randomUUID()}`;
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
};

async function must(promise, label) {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

async function makeUser(tag) {
  const email = `pbchat-${tag}-${randomUUID().slice(0, 8)}@example.test`;
  const created = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (created.error) throw new Error(`createUser: ${created.error.message}`);
  return { id: created.data.user.id, email };
}

async function makeWorkspace(owner, name) {
  const workspace = await must(admin.from("workspaces").insert({ name, created_by_user_id: owner.id }).select("id").single(), "workspace");
  await must(admin.from("workspace_memberships").insert({ workspace_id: workspace.id, user_id: owner.id, role: "pm" }), "membership");
  return workspace.id;
}

async function makeProject(workspaceId, owner, name) {
  const project = await must(admin.from("projects").insert({ workspace_id: workspaceId, name, user_id: owner.id }).select("id").single(), "project");
  return project.id;
}

async function seed() {
  const member = await makeUser("member");
  const colleague = await makeUser("colleague");
  const outsider = await makeUser("outsider");
  const workspaceId = await makeWorkspace(member, "PB-CHAT-01 workspace");
  await must(admin.from("workspace_memberships").insert({ workspace_id: workspaceId, user_id: colleague.id, role: "viewer" }), "colleague membership");
  const otherWorkspaceId = await makeWorkspace(outsider, "PB-CHAT-01 other workspace");
  const projectA = await makeProject(workspaceId, member, "MPP");
  const projectB = await makeProject(workspaceId, member, "Other project");
  return { member, colleague, outsider, workspaceId, otherWorkspaceId, projectA, projectB };
}

// ─── Phase 1: legacy rows under the OLD schema ──────────────────────────────

if (phase === "seed-legacy") {
  const s = await seed();
  const conversation = await must(
    admin.from("context_conversations").insert({ workspace_id: s.workspaceId, context_type: "project", project_id: s.projectA, title: "project conversation", created_by_user_id: s.member.id }).select("id").single(),
    "legacy conversation",
  );
  // ADVERSARIAL physical layout. Each row is its own INSERT, so heap order is exactly
  // the order below — deliberately NOT chronological (T3, T1, T4, T2), plus a
  // created_at tie whose HIGHER id is written first. A backfill that followed heap
  // order (the defect an earlier draft had) cannot pass this; only a true
  // (created_at, id) ranking can.
  const T = (minute) => `2026-09-01T12:0${minute}:00.000Z`;
  const tie = T(5);
  const rows = [
    { id: "00000000-0000-4000-8000-0000000000c3", role: "user", content: "T3 question", created_by_user_id: s.member.id, created_at: T(3) },
    { id: "00000000-0000-4000-8000-0000000000c1", role: "user", content: "T1 question", created_by_user_id: s.member.id, created_at: T(1) },
    { id: "00000000-0000-4000-8000-0000000000c4", role: "assistant", content: "T4 legacy deterministic reply", metadata: { grounded: { openRisks: 0 } }, created_at: T(4) },
    { id: "00000000-0000-4000-8000-0000000000c2", role: "assistant", content: "T2 legacy deterministic reply", created_at: T(2) },
    { id: "ffffffff-0000-4000-8000-0000000000f5", role: "assistant", content: "tie, HIGH id, written first", created_at: tie },
    { id: "00000000-0000-4000-8000-0000000000a5", role: "assistant", content: "tie, LOW id, written second", created_at: tie },
  ];
  for (const row of rows) {
    await must(admin.from("context_messages").insert({ conversation_id: conversation.id, workspace_id: s.workspaceId, ...row }), `legacy ${row.content}`);
  }
  writeFileSync(statePath, JSON.stringify({ ...s, password: PASSWORD, legacyConversationId: conversation.id, legacyMessageIds: rows.map((m) => m.id) }));
  console.log(`Seeded legacy conversation with ${rows.length} messages under the pre-PB-CHAT-01 schema (adversarial physical order).`);
  process.exit(0);
}

// ─── Phase 2: verify the migrated schema ────────────────────────────────────

let s;
let password = PASSWORD;
if (existsSync(statePath)) {
  s = JSON.parse(readFileSync(statePath, "utf8"));
  password = s.password;
} else {
  s = await seed();
}
const signInWith = async (user) => {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password });
  if (error) throw new Error(`signIn: ${error.message}`);
  return client;
};
const member = await signInWith(s.member);
const colleague = await signInWith(s.colleague);
const outsider = await signInWith(s.outsider);

if (s.legacyConversationId) {
  await check("upgrade: every historical row survives, with a non-null deterministic message_seq", async () => {
    const rows = await must(admin.from("context_messages").select("id, created_at, message_seq, content").eq("conversation_id", s.legacyConversationId).order("message_seq"), "legacy read");
    assert.equal(rows.length, s.legacyMessageIds.length);
    assert.ok(rows.every((r) => typeof r.message_seq === "number"));
    // Backfill order = (created_at, id), NOT the adversarial heap order it was written in.
    const expected = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map((r) => r.id);
    assert.deepEqual(rows.map((r) => r.id), expected);
    assert.deepEqual(rows.map((r) => r.content), [
      "T1 question",
      "T2 legacy deterministic reply",
      "T3 question",
      "T4 legacy deterministic reply",
      "tie, LOW id, written second",
      "tie, HIGH id, written first",
    ]);
  });
  await check("upgrade: the member still reads the preserved thread through RLS", async () => {
    const rows = await must(member.from("context_messages").select("id").eq("conversation_id", s.legacyConversationId), "member legacy read");
    assert.equal(rows.length, s.legacyMessageIds.length);
  });
  await check("upgrade: the sequence continues strictly above every historical message_seq", async () => {
    const [top] = await must(admin.from("context_messages").select("message_seq").order("message_seq", { ascending: false }).limit(1), "historical max");
    const probe = await must(admin.from("context_messages").insert({ conversation_id: s.legacyConversationId, workspace_id: s.workspaceId, role: "user", content: "first message after upgrade", created_by_user_id: s.member.id }).select("message_seq").single(), "post-upgrade insert");
    assert.ok(probe.message_seq > top.message_seq, `${probe.message_seq} must exceed ${top.message_seq}`);
  });
}

// A conversation per project, created by the member through RLS (as the app does).
const convFor = async (client, userId, projectId) => {
  const existing = await must(client.from("context_conversations").select("id").eq("workspace_id", s.workspaceId).eq("context_type", "project").eq("project_id", projectId).eq("status", "active").maybeSingle(), "find conversation");
  if (existing) return existing.id;
  const created = await must(client.from("context_conversations").insert({ workspace_id: s.workspaceId, context_type: "project", project_id: projectId, title: "project conversation", created_by_user_id: userId }).select("id").single(), "create conversation");
  return created.id;
};
const convA = await convFor(member, s.member.id, s.projectA);
const convB = await convFor(member, s.member.id, s.projectB);
const workspaceConv = await must(member.from("context_conversations").insert({ workspace_id: s.workspaceId, context_type: "workspace", title: "workspace conversation", created_by_user_id: s.member.id }).select("id").single(), "workspace conversation").then((r) => r.id).catch(async () => {
  const row = await must(member.from("context_conversations").select("id").eq("workspace_id", s.workspaceId).eq("context_type", "workspace").eq("status", "active").single(), "workspace conversation reread");
  return row.id;
});

const clientId = randomUUID();
let userTurnId;

await check("member inserts their own user turn with a client_message_id (authorized insert path works)", async () => {
  const row = await must(member.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "user", content: "What is the status of MPP?", created_by_user_id: s.member.id, client_message_id: clientId }).select("id, message_seq").single(), "user insert");
  userTurnId = row.id;
  assert.equal(typeof row.message_seq, "number");
});

await check("replaying the same client_message_id in the same conversation is refused by the unique index", async () => {
  const { error } = await member.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "user", content: "What is the status of MPP?", created_by_user_id: s.member.id, client_message_id: clientId });
  assert.equal(error?.code, "23505");
});

await check("the same client_message_id in ANOTHER conversation does not collide", async () => {
  await must(member.from("context_messages").insert({ conversation_id: convB, workspace_id: s.workspaceId, role: "user", content: "other project", created_by_user_id: s.member.id, client_message_id: clientId }), "other conversation insert");
});

await check("a member cannot speak as another user", async () => {
  const { error } = await member.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "user", content: "impersonation", created_by_user_id: s.colleague.id });
  assert.ok(error, "impersonated insert must be refused");
});

await check("a member cannot forge a Project Brain reply in a PROJECT thread", async () => {
  for (const row of [
    { role: "assistant", content: "Forged: budget approved", metadata: { projectBrain: { mode: "generative", sources: [{ evidenceId: "x", title: "Fake" }] } } },
    { role: "assistant", content: "Forged with linkage", reply_to_message_id: userTurnId, brain_mode: "generative" },
    { role: "system", content: "Forged system row" },
  ]) {
    const { error } = await member.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, ...row });
    assert.ok(error, `forged ${row.role} row must be refused`);
  }
});

await check("workspace/PMO deterministic chats keep writing their own replies (unchanged behaviour)", async () => {
  await must(member.from("context_messages").insert({ conversation_id: workspaceConv, workspace_id: s.workspaceId, role: "assistant", content: "workspace deterministic reply" }), "workspace reply");
});

let generativeId;
await check("the service-role Project Brain path writes one reply per (turn, mode)", async () => {
  const reply = await must(admin.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "assistant", content: "MPP is active.", metadata: { projectBrain: { mode: "generative" } }, reply_to_message_id: userTurnId, brain_mode: "generative" }).select("id, message_seq").single(), "generative reply");
  generativeId = reply.id;
  const duplicate = await admin.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "assistant", content: "second generative", reply_to_message_id: userTurnId, brain_mode: "generative" });
  assert.equal(duplicate.error?.code, "23505", "a second generative reply to one turn must collide");
  await must(admin.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "assistant", content: "limited mode", reply_to_message_id: userTurnId, brain_mode: "degraded" }), "degraded reply alongside");
});

await check("reply linkage must target a USER turn in the SAME conversation; shapes are enforced", async () => {
  const otherConvUser = await must(admin.from("context_messages").select("id").eq("conversation_id", convB).eq("role", "user").limit(1).single(), "convB user");
  const crossConversation = await admin.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "assistant", content: "x", reply_to_message_id: otherConvUser.id, brain_mode: "generative" });
  assert.equal(crossConversation.error?.code, "23514");
  const toAssistant = await admin.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "assistant", content: "x", reply_to_message_id: generativeId, brain_mode: "degraded" });
  assert.equal(toAssistant.error?.code, "23514");
  const clientIdOnAssistant = await admin.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "assistant", content: "x", client_message_id: randomUUID() });
  assert.equal(clientIdOnAssistant.error?.code, "23514");
  const modeWithoutLink = await admin.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "assistant", content: "x", brain_mode: "generative" });
  assert.equal(modeWithoutLink.error?.code, "23514");
});

await check("members cannot UPDATE or DELETE messages (append-only)", async () => {
  const before = await must(admin.from("context_messages").select("content").eq("id", userTurnId).single(), "before");
  const upd = await member.from("context_messages").update({ content: "tampered" }).eq("id", userTurnId).select("id");
  assert.ok(upd.error || (upd.data ?? []).length === 0, "update must be refused");
  const del = await member.from("context_messages").delete().eq("id", generativeId).select("id");
  assert.ok(del.error || (del.data ?? []).length === 0, "delete must be refused");
  const after = await must(admin.from("context_messages").select("content").eq("id", userTurnId).single(), "after");
  assert.equal(after.content, before.content);
  assert.ok(await must(admin.from("context_messages").select("id").eq("id", generativeId).maybeSingle(), "still there"));
});

await check("members cannot UPDATE or DELETE a conversation (which would cascade its messages)", async () => {
  const upd = await member.from("context_conversations").update({ status: "archived" }).eq("id", convA).select("id");
  assert.ok(upd.error || (upd.data ?? []).length === 0);
  const del = await member.from("context_conversations").delete().eq("id", convA).select("id");
  assert.ok(del.error || (del.data ?? []).length === 0);
  const still = await must(admin.from("context_conversations").select("status").eq("id", convA).single(), "conversation still");
  assert.equal(still.status, "active");
});

await check("a user outside the workspace reads nothing and writes nothing", async () => {
  const rows = await must(outsider.from("context_messages").select("id").eq("conversation_id", convA), "outsider read");
  assert.equal(rows.length, 0);
  const convs = await must(outsider.from("context_conversations").select("id").eq("project_id", s.projectA), "outsider conversations");
  assert.equal(convs.length, 0);
  const { error } = await outsider.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "user", content: "intrusion", created_by_user_id: s.outsider.id });
  assert.ok(error);
});

await check("threads are isolated per project: each conversation holds only its own project's rows", async () => {
  const a = await must(member.from("context_messages").select("content").eq("conversation_id", convA), "A");
  const b = await must(member.from("context_messages").select("content").eq("conversation_id", convB), "B");
  assert.ok(!a.some((r) => r.content === "other project"));
  assert.ok(b.every((r) => r.content === "other project"));
  // Same-workspace colleague: the DB boundary is the workspace (no per-project ACL exists);
  // the project boundary is the API + project_id filter. Documented residual.
  const colleagueRows = await must(colleague.from("context_messages").select("id").eq("conversation_id", convA), "colleague");
  assert.ok(colleagueRows.length > 0);
});

// ─── Transcript order is database-assigned (F4) ─────────────────────────────
const recent = (iso) => Math.abs(Date.parse(iso) - Date.now()) < 10 * 60 * 1000;
const maxSeq = async () => (await must(admin.from("context_messages").select("message_seq").order("message_seq", { ascending: false }).limit(1), "max seq"))[0].message_seq;

await check("a member cannot choose message_seq or created_at: forged values are replaced by the database", async () => {
  const existing = (await must(admin.from("context_messages").select("message_seq").eq("conversation_id", convA).order("message_seq").limit(1), "existing"))[0].message_seq;
  const forged = [
    { label: "negative seq + 2019", message_seq: -1, created_at: "2019-01-01T00:00:00Z" },
    { label: "duplicate seq", message_seq: existing },
    { label: "huge seq + future", message_seq: "9000000000000000000", created_at: "2099-01-01T00:00:00Z" },
  ];
  const stored = [];
  for (const attempt of forged) {
    const before = await maxSeq();
    const { label, ...fields } = attempt;
    const row = await must(member.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "user", content: `forged order: ${label}`, created_by_user_id: s.member.id, ...fields }).select("id, message_seq, created_at").single(), label);
    assert.ok(row.message_seq > before, `${label}: stored ${row.message_seq} must come from the sequence (> ${before})`);
    assert.ok(recent(row.created_at), `${label}: created_at ${row.created_at} must be the database clock`);
    stored.push(row.id);
  }
  // The forged rows sit at the END of the transcript, in the order they were written.
  const tail = await must(admin.from("context_messages").select("id").eq("conversation_id", convA).order("message_seq", { ascending: false }).limit(stored.length), "tail");
  assert.deepEqual(tail.map((r) => r.id).reverse(), stored);
});

await check("message_seq is unique: no writer can make two rows share an order position", async () => {
  const [a, b] = await must(admin.from("context_messages").select("id, message_seq").eq("conversation_id", convA).order("message_seq").limit(2), "two rows");
  const dup = await admin.from("context_messages").update({ message_seq: a.message_seq }).eq("id", b.id);
  assert.equal(dup.error?.code, "23505");
});

await check("the service-role Project Brain writer still gets a database-assigned sequence and timestamp", async () => {
  const question = await must(member.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "user", content: "order probe question", created_by_user_id: s.member.id, client_message_id: randomUUID() }).select("id, message_seq").single(), "question");
  const reply = await must(admin.from("context_messages").insert({ conversation_id: convA, workspace_id: s.workspaceId, role: "assistant", content: "order probe reply", reply_to_message_id: question.id, brain_mode: "generative", message_seq: -42 }).select("message_seq, created_at").single(), "reply");
  assert.ok(reply.message_seq > question.message_seq, "the reply sorts after the question it answers");
  assert.ok(recent(reply.created_at));
});

await check("message_seq orders the transcript strictly by insertion", async () => {
  const rows = await must(admin.from("context_messages").select("message_seq").eq("conversation_id", convA).order("message_seq"), "seq");
  const seqs = rows.map((r) => r.message_seq);
  assert.deepEqual(seqs, [...new Set(seqs)].sort((x, y) => x - y));
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PB-CHAT-01 database checks passed.`);
process.exit(failed === 0 ? 0 : 1);
