/**
 * B1 — company_usage.current_month / quota_reservations.month_key regression tests.
 *
 * Runs against a disposable local Supabase built from supabase/migrations. Covers:
 *   - the month-key constraint on both tables (valid, malformed, boundaries);
 *   - the upload quota lifecycle exactly as src/lib/quota/upload-quota.ts drives it: the
 *     server (service role — the only role with EXECUTE since PR-2,
 *     20261022000000_quota_server_only_authority.sql) calling reserve/commit/cancel for a
 *     signed-in user's OWN company (company id = user id), with a UTC "YYYY-MM" key built the
 *     same way the application builds it;
 *   - usage initialization: the first server-path reservation creates the current-month row,
 *     and the signed-in user can no longer write company_usage directly (PR-2, F3).
 *
 * Before 20261020000000_fix_company_usage_current_month_check.sql every valid-key case
 * and every lifecycle case here fails with a company_usage_current_month_check violation.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { adminClient, requireDbEnv, signedInClient } from "./support/db-env.mjs";

const env = requireDbEnv();
const admin = adminClient(env);
const tag = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const CHECK_VIOLATION = "23514";

// Same construction as getCurrentMonthKey() in upload-quota.ts and usage-limits.ts.
const appMonthKey = (date = new Date()) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;

const companies = new Set();
const constraintCompany = () => {
  const id = `b1-constraint-${tag}-${companies.size}`;
  companies.add(id);
  return id;
};

let user;
let client;

before(async () => {
  const password = randomBytes(18).toString("base64url");
  const email = `b1-quota-${tag}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`[db-regression] fixture user: ${error.message}`);
  user = { id: data.user.id };
  companies.add(user.id);
  client = await signedInClient(env, email, password);
});

after(async () => {
  const ids = [...companies];
  const failures = [];
  for (const table of ["quota_reservations", "company_usage"]) {
    const { error } = await admin.from(table).delete().in("company_id", ids);
    if (error) failures.push(`${table}: ${error.message}`);
  }
  if (user) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) failures.push(`user: ${error.message}`);
  }
  if (failures.length) throw new Error(`[db-regression] teardown incomplete: ${failures.join("; ")}`);
});

const insertUsage = (companyId, currentMonth, uploadCount = 0) =>
  admin.from("company_usage").insert({ company_id: companyId, current_month: currentMonth, upload_count: uploadCount });

const insertReservation = (companyId, monthKey) =>
  admin.from("quota_reservations").insert({ company_id: companyId, amount: 1, month_key: monthKey, request_id: `b1-${randomUUID()}` });

// ── Constraint ───────────────────────────────────────────────────────────────

const VALID_KEYS = ["2026-01", "2026-09", "2026-10", "2026-12", "1999-12", "2100-01", appMonthKey()];
const MALFORMED_KEYS = [
  "2026-00", // month below range
  "2026-13", // month above range
  "2026-1", // unpadded month
  "26-01", // two-digit year
  "2026/01", // wrong separator
  "202601", // no separator
  "2026-010", // extra digit
  "2026-1a", // non-digit
  " 2026-01", // leading space
  "2026-01 ", // trailing space
  "2026-01-01", // full date
  "\\dddd-\\dd", // the only shape the defective constraint accepted
  "２０２６-01", // non-ASCII (full-width) digits
  "",
];

for (const key of VALID_KEYS) {
  test(`company_usage and quota_reservations accept valid month key '${key}'`, async () => {
    const companyId = constraintCompany();
    const usage = await insertUsage(companyId, key);
    assert.equal(usage.error, null, `company_usage rejected '${key}': ${usage.error?.message}`);
    const reservation = await insertReservation(companyId, key);
    assert.equal(reservation.error, null, `quota_reservations rejected '${key}': ${reservation.error?.message}`);
  });
}

for (const key of MALFORMED_KEYS) {
  test(`company_usage and quota_reservations reject malformed month key ${JSON.stringify(key)}`, async () => {
    const companyId = constraintCompany();
    const usage = await insertUsage(companyId, key);
    assert.equal(usage.error?.code, CHECK_VIOLATION, `company_usage accepted ${JSON.stringify(key)}`);
    // quota_reservations needs its parent usage row; give it a valid one.
    assert.equal((await insertUsage(companyId, "2026-10")).error, null);
    const reservation = await insertReservation(companyId, key);
    assert.equal(reservation.error?.code, CHECK_VIOLATION, `quota_reservations accepted ${JSON.stringify(key)}`);
  });
}

test("updating an existing usage row to a malformed month is rejected", async () => {
  const companyId = constraintCompany();
  assert.equal((await insertUsage(companyId, "2026-10")).error, null);
  const { error } = await admin.from("company_usage").update({ current_month: "2026-13" }).eq("company_id", companyId);
  assert.equal(error?.code, CHECK_VIOLATION);
});

// ── Upload quota lifecycle (application path) ────────────────────────────────

// The application reaches the quota RPCs only through the service role (upload-quota.ts).
const server = admin;

const reserve = (requestId, { amount = 1, limit = 5, monthKey = appMonthKey() } = {}) =>
  server.rpc("reserve_upload_quota", {
    p_company_id: user.id,
    p_upload_amount: amount,
    p_upload_limit: limit,
    p_month_key: monthKey,
    p_request_id: requestId,
  });

const usageRow = async () => {
  const { data, error } = await admin.from("company_usage").select("current_month, upload_count").eq("company_id", user.id).maybeSingle();
  assert.equal(error, null);
  return data;
};

const pendingCount = async () => {
  const { data, error } = await admin.from("quota_reservations").select("id").eq("company_id", user.id).eq("status", "pending");
  assert.equal(error, null);
  return data.length;
};

test("lifecycle: first reservation for a company with no usage row creates the row and is approved", async () => {
  assert.equal(await usageRow(), null, "fixture company unexpectedly has a usage row");
  const { data, error } = await reserve(`first-${tag}`, { amount: 2 });
  assert.equal(error, null, `reserve failed: ${error?.message}`);
  assert.equal(data.allowed, true);
  assert.equal(data.reason, "quota_approved");
  assert.equal(data.new_usage, 2);
  assert.deepEqual(await usageRow(), { current_month: appMonthKey(), upload_count: 0 });
  assert.equal(await pendingCount(), 1);
});

test("lifecycle: replaying the same request id is idempotent", async () => {
  const first = await reserve(`idem-${tag}`);
  const replay = await reserve(`idem-${tag}`);
  assert.equal(first.error, null);
  assert.equal(replay.error, null);
  assert.equal(replay.data.reason, "idempotent_replay");
  assert.equal(replay.data.reservation_id, first.data.reservation_id);
  const { data } = await admin.from("quota_reservations").select("id").eq("request_id", `idem-${tag}`);
  assert.equal(data.length, 1, "replay created a duplicate reservation");
});

test("lifecycle: commit promotes a reservation to committed usage", async () => {
  const reserved = await reserve(`commit-${tag}`);
  const before = (await usageRow()).upload_count;
  const { data, error } = await server.rpc("commit_upload_quota", { p_reservation_id: reserved.data.reservation_id, p_company_id: user.id });
  assert.equal(error, null);
  assert.equal(data.committed, true);
  assert.equal(data.reason, "quota_committed");
  assert.equal((await usageRow()).upload_count, before + 1);
  const { data: rows } = await admin.from("quota_reservations").select("id").eq("id", reserved.data.reservation_id);
  assert.equal(rows.length, 0, "committed reservation was not removed");
});

test("lifecycle: cancel releases a pending reservation without touching committed usage", async () => {
  const reserved = await reserve(`cancel-${tag}`);
  const before = (await usageRow()).upload_count;
  const { data, error } = await server.rpc("cancel_upload_quota", { p_reservation_id: reserved.data.reservation_id, p_company_id: user.id });
  assert.equal(error, null);
  assert.equal(data.cancelled, true);
  assert.equal((await usageRow()).upload_count, before);
  const again = await server.rpc("cancel_upload_quota", { p_reservation_id: reserved.data.reservation_id, p_company_id: user.id });
  assert.equal(again.data.cancelled, false, "a cancelled reservation was cancelled twice");
});

test("lifecycle: the plan limit counts committed usage plus pending reservations", async () => {
  // Clean slate for this company: committed = 0, no pending.
  await admin.from("quota_reservations").delete().eq("company_id", user.id);
  await admin.from("company_usage").update({ upload_count: 0 }).eq("company_id", user.id);

  const pending = await reserve(`limit-pending-${tag}`, { amount: 3, limit: 5 });
  assert.equal(pending.data.allowed, true);
  const over = await reserve(`limit-over-${tag}`, { amount: 3, limit: 5 });
  assert.equal(over.error, null);
  assert.equal(over.data.allowed, false, "reservation exceeding the limit was approved");
  assert.equal(over.data.reason, "quota_exceeded");
  const exact = await reserve(`limit-exact-${tag}`, { amount: 2, limit: 5 });
  assert.equal(exact.data.allowed, true, "reservation reaching exactly the limit was rejected");
  assert.equal(exact.data.new_usage, 5);
});

test("lifecycle: crossing a month (Dec → Jan) resets the counter and purges stale pending reservations", async () => {
  await admin.from("quota_reservations").delete().eq("company_id", user.id);
  await admin.from("company_usage").update({ current_month: "2026-12", upload_count: 4 }).eq("company_id", user.id);
  await admin.from("quota_reservations").insert({ company_id: user.id, amount: 1, month_key: "2026-12", request_id: `stale-${tag}` }).throwOnError();

  const { data, error } = await reserve(`newyear-${tag}`, { amount: 1, limit: 5, monthKey: "2027-01" });
  assert.equal(error, null, `reserve across the year boundary failed: ${error?.message}`);
  assert.equal(data.allowed, true);
  assert.equal(data.previous_usage, 0);
  assert.deepEqual(await usageRow(), { current_month: "2027-01", upload_count: 0 });
  const { data: stale } = await admin.from("quota_reservations").select("id").eq("request_id", `stale-${tag}`);
  assert.equal(stale.length, 0, "previous-month pending reservation was not purged");
});

test("lifecycle: committing a reservation from a previous month is refused as month_boundary_crossed", async () => {
  const old = await reserve(`boundary-${tag}`, { monthKey: "2027-01" });
  await admin.from("company_usage").update({ current_month: "2027-02" }).eq("company_id", user.id);
  const { data, error } = await server.rpc("commit_upload_quota", { p_reservation_id: old.data.reservation_id, p_company_id: user.id });
  assert.equal(error, null);
  assert.equal(data.committed, false);
  assert.equal(data.reason, "month_boundary_crossed");
});

test("lifecycle: concurrent reservations cannot exceed the plan limit", async () => {
  await admin.from("quota_reservations").delete().eq("company_id", user.id);
  await admin.from("company_usage").update({ current_month: appMonthKey(), upload_count: 1 }).eq("company_id", user.id);
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => reserve(`burst-${index}-${tag}`, { amount: 1, limit: 5 })));
  for (const { error } of results) assert.equal(error, null, `concurrent reserve errored: ${error?.message}`);
  const approved = results.filter(({ data }) => data.allowed).length;
  assert.equal(approved, 4, `committed 1 + limit 5 must leave exactly 4 approvals, got ${approved}`);
  assert.equal(await pendingCount(), 4);
});

test("usage initialization: the server path creates the current-month row; the user client cannot write it", async () => {
  await admin.from("quota_reservations").delete().eq("company_id", user.id);
  await admin.from("company_usage").delete().eq("company_id", user.id);
  const denied = await client
    .from("company_usage")
    .upsert({ company_id: user.id, current_month: appMonthKey(), upload_count: 0, updated_at: new Date().toISOString() }, { onConflict: "company_id" });
  assert.equal(denied.error?.code, "42501", `user-client usage write was not refused: ${denied.error?.message ?? "success"}`);
  assert.equal(await usageRow(), null, "a refused user-client write created a usage row");
  const { data, error } = await reserve(`init-${tag}`);
  assert.equal(error, null, `usage initialization failed: ${error?.message}`);
  assert.equal(data.allowed, true);
  assert.deepEqual(await usageRow(), { current_month: appMonthKey(), upload_count: 0 });
});
