/**
 * F3 / F20 — upload quota manipulation (remediated by C1 and PR-2).
 *
 * F3:  `company_usage` / `quota_reservations` carried a FOR ALL policy for `authenticated`
 *      (20260428120000_p0_state_tables.sql, 20260518000000_quota_atomicity.sql), so a user
 *      could reset their own usage counter or drop their own reservations through PostgREST.
 * F20: `reserve_upload_quota` / `commit_upload_quota` / `cancel_upload_quota` are SECURITY
 *      DEFINER and were executable by `authenticated`.
 *        - Cross-tenant use (a caller-chosen foreign p_company_id) — REMEDIATED by C1
 *          (20261019000000_quota_rpc_caller_binding.sql).
 *        - A caller-supplied p_upload_limit (NULL = unlimited) — REMEDIATED by PR-2.
 *
 * PR-2 (20261022000000_quota_server_only_authority.sql): EXECUTE on the three RPCs is
 * service_role only, both tables are read-own for `authenticated`, and the application
 * reaches the RPCs exclusively through src/lib/quota/upload-quota.ts — which runs only for
 * the authenticated actor's own company and derives the limit from the company's
 * server-written subscription. The legitimate lifecycle is exercised through that REAL
 * engine below, so these tests prove uploads keep working, not only that clients are denied.
 *
 * Every denial is asserted precisely (42501 / no row affected) and followed by a check that
 * no quota row changed, so an unrelated error can never pass as a denial.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { bindAppEnvToHarness, createTenantFixtures, requireHarnessEnv, spoofCompanyId } from "./support/harness.mjs";
import { installAppRouteMocks } from "./support/app-route-mocks.mjs";

const env = requireHarnessEnv();
bindAppEnvToHarness(env);
installAppRouteMocks();

const { reserveUploadQuota, commitUploadQuota, cancelUploadQuota } = await import("../../src/lib/quota/upload-quota.ts");

let fx;
let attacker;
let attackerId;
let victimId;
let victimReservationId;
const MONTH = "2026-10";
const INSUFFICIENT_PRIVILEGE = "42501";
const FREE_UPLOAD_LIMIT = 5;

before(async () => {
  fx = await createTenantFixtures(env, { label: "f20" });
  attackerId = fx.users.bOwner.id;
  victimId = fx.users.aOwner.id;
  await fx.admin
    .from("company_usage")
    .insert([
      { company_id: attackerId, current_month: MONTH, upload_count: 2 },
      { company_id: victimId, current_month: MONTH, upload_count: 2 },
    ])
    .throwOnError();
  const { data } = await fx.admin
    .from("quota_reservations")
    .insert({ company_id: victimId, amount: 1, month_key: MONTH, request_id: `victim-${randomUUID()}` })
    .select("id")
    .single()
    .throwOnError();
  victimReservationId = data.id;
  attacker = await fx.signIn(fx.users.bOwner);
});

after(async () => {
  if (fx) await fx.teardown();
});

const reserveAs = (client, companyId, { amount = 1, limit = 5 } = {}) =>
  client.rpc("reserve_upload_quota", {
    p_company_id: companyId,
    p_upload_amount: amount,
    p_upload_limit: limit,
    p_month_key: MONTH,
    p_request_id: `harness-${randomUUID()}`,
  });

const assertRefused = ({ error }, what) => {
  assert.equal(
    error?.code,
    INSUFFICIENT_PRIVILEGE,
    `${what}: expected 42501, got ${error ? `${error.code} (${error.message.split("\n")[0]})` : "success"}`,
  );
};

// Snapshot of everything a call could have changed for one company.
const quotaState = async (companyId) => {
  const { data: usage } = await fx.admin.from("company_usage").select("current_month, upload_count").eq("company_id", companyId).maybeSingle().throwOnError();
  const { data: reservations } = await fx.admin
    .from("quota_reservations")
    .select("id, amount, status, month_key")
    .eq("company_id", companyId)
    .order("id")
    .throwOnError();
  return { usage, reservations };
};
const victimQuotaState = () => quotaState(victimId);

const actorFor = (user) => ({ userId: user.id, companyId: user.id });

test("control: a user can read their own usage counter", async () => {
  const { data, error } = await attacker.from("company_usage").select("upload_count").eq("company_id", attackerId);
  assert.equal(error, null);
  assert.deepEqual(data, [{ upload_count: 2 }]);
});

test("control: a user cannot read another company's usage counter", async () => {
  const { data, error } = await attacker.from("company_usage").select("upload_count").eq("company_id", victimId);
  assert.equal(error, null);
  assert.deepEqual(data, []);
});

test("control: the server quota engine reserves, commits and cancels the signed-in user's own quota", async () => {
  const actor = actorFor(fx.users.bAdmin);
  const reserved = await reserveUploadQuota({ actor, uploadAmount: 1, requestId: `engine-${randomUUID()}` });
  assert.equal(reserved.allowed, true, "own reservation through the engine was rejected");
  assert.equal(reserved.limit, FREE_UPLOAD_LIMIT, "engine did not apply the Free plan limit");
  await commitUploadQuota({ reservationId: reserved.reservationId, actor, requestId: "commit", uploadAmount: 1 });
  const second = await reserveUploadQuota({ actor, uploadAmount: 1, requestId: `engine-${randomUUID()}` });
  assert.equal(second.allowed, true);
  await cancelUploadQuota({ reservationId: second.reservationId, actor, requestId: "cancel", uploadAmount: 1 });
  const state = await quotaState(actor.companyId);
  assert.equal(state.usage.upload_count, 1, "commit did not record exactly one upload");
  assert.deepEqual(state.reservations, [], "a committed or cancelled reservation was left behind");
});

test("control: the trusted server path (service_role) can operate on any company", async () => {
  const reserved = await reserveAs(fx.admin, victimId, { amount: 1, limit: 5 });
  assert.equal(reserved.error, null, `service_role reserve failed: ${reserved.error?.message}`);
  assert.equal(reserved.data.allowed, true);
  const cancelled = await fx.admin.rpc("cancel_upload_quota", { p_reservation_id: reserved.data.reservation_id, p_company_id: victimId });
  assert.equal(cancelled.data.cancelled, true);
});

test("PR-2: a signed-in user cannot call the quota RPCs directly, even for their own company", async () => {
  const { data: own } = await fx.admin
    .from("quota_reservations")
    .insert({ company_id: attackerId, amount: 1, month_key: MONTH, request_id: `own-${randomUUID()}` })
    .select("id")
    .single()
    .throwOnError();
  const snapshot = await quotaState(attackerId);
  assertRefused(await reserveAs(attacker, attackerId, { amount: 1, limit: 5 }), "reserve_upload_quota(own company)");
  assertRefused(await attacker.rpc("commit_upload_quota", { p_reservation_id: own.id, p_company_id: attackerId }), "commit_upload_quota(own)");
  assertRefused(await attacker.rpc("cancel_upload_quota", { p_reservation_id: own.id, p_company_id: attackerId }), "cancel_upload_quota(own)");
  assert.deepEqual(await quotaState(attackerId), snapshot, "a refused direct RPC changed the caller's own quota state");
  await fx.admin.from("quota_reservations").delete().eq("id", own.id).throwOnError();
});

test("C1: an authenticated user cannot reserve quota against another company", async () => {
  const snapshot = await victimQuotaState();
  assertRefused(await reserveAs(attacker, victimId, { amount: 1000, limit: null }), "reserve_upload_quota(foreign company)");
  assert.deepEqual(await victimQuotaState(), snapshot, "a refused reserve changed tenant A's quota state");
});

test("C1: an authenticated user cannot commit another company's reservation", async () => {
  const snapshot = await victimQuotaState();
  assertRefused(
    await attacker.rpc("commit_upload_quota", { p_reservation_id: victimReservationId, p_company_id: victimId }),
    "commit_upload_quota(foreign reservation)",
  );
  assert.deepEqual(await victimQuotaState(), snapshot, "a refused commit changed tenant A's quota state");
});

test("C1: an authenticated user cannot cancel another company's pending reservation", async () => {
  const snapshot = await victimQuotaState();
  assertRefused(
    await attacker.rpc("cancel_upload_quota", { p_reservation_id: victimReservationId, p_company_id: victimId }),
    "cancel_upload_quota(foreign reservation)",
  );
  assert.deepEqual(await victimQuotaState(), snapshot, "a refused cancel changed tenant A's quota state");
});

test("C1: an anonymous caller cannot use any quota function", async () => {
  const anon = createClient(env.url, env.anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const snapshot = await victimQuotaState();
  assertRefused(await reserveAs(anon, victimId), "anon reserve_upload_quota");
  assertRefused(await anon.rpc("commit_upload_quota", { p_reservation_id: victimReservationId, p_company_id: victimId }), "anon commit_upload_quota");
  assertRefused(await anon.rpc("cancel_upload_quota", { p_reservation_id: victimReservationId, p_company_id: victimId }), "anon cancel_upload_quota");
  assert.deepEqual(await victimQuotaState(), snapshot, "an anonymous call changed tenant A's quota state");
});

test("F3: a user cannot reset their own upload counter via PostgREST", async () => {
  const { data, error } = await attacker.from("company_usage").update({ upload_count: 0 }).eq("company_id", attackerId).select("upload_count");
  const updated = error ? 0 : data.length;
  assert.equal(updated, 0, "authenticated caller rewrote company_usage.upload_count");
});

test("F3: a user cannot recreate, delete or rewrite their own quota rows via PostgREST", async () => {
  const { data: own } = await fx.admin
    .from("quota_reservations")
    .insert({ company_id: attackerId, amount: 3, month_key: MONTH, request_id: `own-${randomUUID()}` })
    .select("id")
    .single()
    .throwOnError();
  const snapshot = await quotaState(attackerId);

  const usageUpsert = await attacker
    .from("company_usage")
    .upsert({ company_id: attackerId, current_month: MONTH, upload_count: 0 }, { onConflict: "company_id" })
    .select("upload_count");
  assert.notEqual(usageUpsert.error, null, "authenticated caller upserted its own company_usage row");
  const usageDelete = await attacker.from("company_usage").delete().eq("company_id", attackerId).select("company_id");
  assert.equal(usageDelete.error ? 0 : usageDelete.data.length, 0, "authenticated caller deleted its own company_usage row");

  const reservationInsert = await attacker
    .from("quota_reservations")
    .insert({ company_id: attackerId, amount: 1, month_key: MONTH, request_id: `forged-${randomUUID()}` });
  assert.notEqual(reservationInsert.error, null, "authenticated caller inserted its own quota reservation");
  const reservationUpdate = await attacker.from("quota_reservations").update({ amount: 0 }).eq("id", own.id).select("id");
  assert.equal(reservationUpdate.error ? 0 : reservationUpdate.data.length, 0, "authenticated caller rewrote its own reservation");
  const reservationDelete = await attacker.from("quota_reservations").delete().eq("id", own.id).select("id");
  assert.equal(reservationDelete.error ? 0 : reservationDelete.data.length, 0, "authenticated caller deleted its own pending reservation");

  assert.deepEqual(await quotaState(attackerId), snapshot, "a direct write changed the caller's own quota state");
  await fx.admin.from("quota_reservations").delete().eq("id", own.id).throwOnError();
});

test("F20: an authenticated user cannot supply their own limit (NULL = unlimited) to reserve_upload_quota", async () => {
  assertRefused(await reserveAs(attacker, attackerId, { amount: 1000, limit: null }), "reserve_upload_quota(p_upload_limit = NULL)");
});

test("PR-2: the quota engine refuses a company that is not the authenticated actor's own", async () => {
  const snapshot = await victimQuotaState();
  await assert.rejects(
    () => reserveUploadQuota({ actor: { userId: attackerId, companyId: victimId }, uploadAmount: 1, requestId: `foreign-${randomUUID()}` }),
    /not the authenticated user's own/,
  );
  assert.deepEqual(await victimQuotaState(), snapshot, "a refused engine call changed tenant A's quota state");
});

test("PR-2: concurrent reservations through the engine cannot exceed the Free plan limit", async () => {
  const actor = actorFor(fx.users.bPm);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => reserveUploadQuota({ actor, uploadAmount: 1, requestId: `burst-${randomUUID()}` })),
  );
  const approved = results.filter((result) => result.allowed);
  assert.equal(approved.length, FREE_UPLOAD_LIMIT, `expected exactly ${FREE_UPLOAD_LIMIT} approvals, got ${approved.length}`);
  for (const rejected of results.filter((result) => !result.allowed)) {
    assert.equal(rejected.reason, "quota_exceeded");
    assert.equal(rejected.limit, FREE_UPLOAD_LIMIT);
  }
  const state = await quotaState(actor.companyId);
  assert.equal(state.reservations.filter((row) => row.status === "pending").length, FREE_UPLOAD_LIMIT);
  for (const reservation of approved) {
    await cancelUploadQuota({ reservationId: reservation.reservationId, actor, requestId: "cleanup", uploadAmount: 1 });
  }
});

test("PR-2: the limit comes from the company's server-written subscription", async () => {
  const actor = actorFor(fx.users.bViewer);
  await fx.admin.from("company_subscriptions").insert({ company_id: actor.companyId, plan: "pmo", subscription_status: "active" }).throwOnError();
  const reserved = await reserveUploadQuota({ actor, uploadAmount: 50, requestId: `pmo-${randomUUID()}` });
  assert.equal(reserved.allowed, true, "an unlimited (pmo) subscription was capped");
  assert.equal(reserved.limit, null);
  await cancelUploadQuota({ reservationId: reserved.reservationId, actor, requestId: "cleanup", uploadAmount: 50 });
});

test("PR-2: every engine call is a recorded privileged access bound to the authenticated actor", async () => {
  const actor = actorFor(fx.users.bAdmin);
  let events = [];
  for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) {
    const { data } = await fx.admin
      .from("security_events")
      .select("event_type, actor_user_id, route_id")
      .eq("route_id", "lib.quota.upload-quota")
      .eq("actor_user_id", actor.userId)
      .throwOnError();
    events = data;
    if (events.length === 0) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(events.length > 0, "no privileged_client_used event recorded for the quota engine");
  assert.ok(events.every((event) => event.event_type === "privileged_client_used"));
});

// Last: rewrites the attacker's session metadata. C1 must authorize on auth.uid(), never
// on the user-editable company id that current_company_id() / user.companyId trusted (F1).
test("C1: an F1-spoofed caller still cannot reserve against the spoofed company", async () => {
  await spoofCompanyId(attacker, victimId);
  const snapshot = await victimQuotaState();
  assertRefused(await reserveAs(attacker, victimId), "reserve_upload_quota(spoofed company)");
  assert.deepEqual(await victimQuotaState(), snapshot, "a spoofed reserve changed tenant A's quota state");
});
