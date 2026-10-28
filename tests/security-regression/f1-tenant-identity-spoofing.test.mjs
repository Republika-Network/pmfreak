/**
 * F1 — tenant identity taken from user-editable `user_metadata.company_id` (remediated, PR-1).
 *
 * `public.current_company_id()` used to return `coalesce(jwt.user_metadata.company_id,
 * auth.uid())` and src/lib/auth.ts built `companyId` from the same field. Since
 * 20261021000000_current_company_id_from_auth_uid.sql both resolve to the authenticated user
 * id. The attack is still reproduced end to end — the attacker calls GoTrue's own
 * `updateUser({ data: { company_id } })` with their own session, refreshes, then queries
 * PostgREST exactly as a browser could — and every case below must keep refusing it.
 *
 * Positive controls run first and MUST pass: before spoofing, the attacker cannot see
 * the victim's rows, and the victim's own owner can, so the regression tests below can only
 * pass because the spoof is ignored, not because the rows are missing or unreadable.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTenantFixtures, requireHarnessEnv, spoofCompanyId } from "./support/harness.mjs";

const env = requireHarnessEnv();

let fx;
let attacker;
let victimId;

before(async () => {
  fx = await createTenantFixtures(env, { label: "f1" });
  victimId = fx.users.aOwner.id;
  await fx.admin.from("company_usage").insert({ company_id: victimId, current_month: "2026-10", upload_count: 7 }).throwOnError();
  await fx.admin
    .from("operational_memory_records")
    .insert({ company_id: victimId, domain: "operational_memory", title: `victim memory ${fx.tag}` })
    .throwOnError();
  await fx.admin
    .from("governance_audit_events")
    .insert({
      company_id: victimId,
      namespace_key: "harness",
      namespace_scope: "organization",
      event_type: "harness_victim_event",
      actor_ref: victimId,
      actor_type: "human",
      actor_role: "owner",
    })
    .throwOnError();
  attacker = await fx.signIn(fx.users.bOwner);
});

after(async () => {
  if (fx) await fx.teardown();
});

const victimRows = async (table) => {
  const { data, error } = await attacker.from(table).select("company_id").eq("company_id", victimId);
  assert.equal(error, null, `${table} read errored: ${error?.message}`);
  return data;
};

test("control: unspoofed tenant B owner cannot read tenant A's company-scoped rows", async () => {
  for (const table of ["company_subscriptions", "company_usage", "operational_memory_records", "governance_audit_events"]) {
    assert.deepEqual(await victimRows(table), [], `${table} leaked without a spoof — isolation baseline broken`);
  }
});

test("control: tenant A's own owner reads its own company-scoped rows", async () => {
  const owner = await fx.signIn(fx.users.aOwner);
  for (const table of ["company_usage", "operational_memory_records", "governance_audit_events"]) {
    const { data, error } = await owner.from(table).select("company_id").eq("company_id", victimId);
    assert.equal(error, null, `${table} read errored: ${error?.message}`);
    assert.ok(data.length > 0, `tenant A's owner cannot read its own ${table}`);
  }
});

test("control: unspoofed current_company_id() resolves to the caller", async () => {
  const { data, error } = await attacker.rpc("current_company_id");
  assert.equal(error, null);
  assert.equal(data, fx.users.bOwner.id);
});

test("attack setup: attacker rewrites own user_metadata.company_id to the victim's id via GoTrue", async () => {
  await spoofCompanyId(attacker, victimId);
  const { data } = await attacker.auth.getUser();
  assert.equal(data.user.user_metadata.company_id, victimId, "spoof did not apply — later results would be meaningless");
});

test("F1: current_company_id() ignores user-editable metadata", async () => {
  const { data, error } = await attacker.rpc("current_company_id");
  assert.equal(error, null);
  assert.equal(data, fx.users.bOwner.id, "current_company_id() returned the spoofed tenant");
});

for (const table of ["company_subscriptions", "company_usage", "operational_memory_records", "governance_audit_events"]) {
  test(`F1: spoofed caller cannot read tenant A's ${table}`, async () => {
    assert.deepEqual(await victimRows(table), [], `spoofed caller read tenant A's ${table}`);
  });
}

test("F1: spoofed caller cannot insert rows into tenant A's operational memory", async () => {
  const { error } = await attacker
    .from("operational_memory_records")
    .insert({ company_id: victimId, domain: "operational_memory", title: `attacker-injected ${fx.tag}` });
  assert.notEqual(error, null, "insert into tenant A's operational memory was accepted");
});

test("F1: spoofed caller cannot delete tenant A's governance audit events", async () => {
  const { data, error } = await attacker.from("governance_audit_events").delete().eq("company_id", victimId).select("id");
  const deleted = error ? 0 : data.length;
  assert.equal(deleted, 0, `spoofed caller deleted ${deleted} of tenant A's audit event(s)`);
});

// The two cases below became reachable when B1 made company_usage rows creatable: the
// FOR ALL policies on company_usage / quota_reservations key on current_company_id(), so a
// spoofed caller could write another tenant's quota state directly through PostgREST,
// without going through the C1-guarded RPCs at all.
test("F1: spoofed caller cannot rewrite tenant A's upload counter", async () => {
  const { data, error } = await attacker.from("company_usage").update({ upload_count: 999 }).eq("company_id", victimId).select("company_id");
  const updated = error ? 0 : data.length;
  assert.equal(updated, 0, "spoofed caller rewrote tenant A's company_usage.upload_count");
});

test("F1: spoofed caller cannot insert reservations against tenant A's quota", async () => {
  const { error } = await attacker
    .from("quota_reservations")
    .insert({ company_id: victimId, amount: 1000, month_key: "2026-10", request_id: `attacker-${randomUUID()}` });
  assert.notEqual(error, null, "spoofed caller inserted a pending reservation against tenant A's quota");
});

test("F1: buildAuthUserContext derives companyId from the authenticated user id", async () => {
  bindForPureImport();
  const { buildAuthUserContext } = await import("../../src/lib/auth.ts");
  const context = buildAuthUserContext({ id: fx.users.bOwner.id, email: fx.users.bOwner.email, user_metadata: { company_id: victimId } });
  assert.equal(context.companyId, fx.users.bOwner.id, "app-layer companyId taken from user_metadata");
});

// src/lib/auth.ts transitively loads src/lib/supabase/env.ts; point it at the harness so
// importing the pure builder can never read an ambient hosted configuration.
function bindForPureImport() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.anonKey;
}
