/**
 * PB-CHAT-01 RC-1 — the FIRST request a fresh process serves is Project Brain GET.
 *
 * Real-provider certification found that `/api/projects/[id]/brain/turns` answered 500
 * ("In-process runtime authority dependencies are not registered") on a fresh server until
 * some OTHER route happened to bootstrap the runtime authority. This file is its own
 * `node --test` process, so nothing has bootstrapped anything: the route must establish the
 * runtime authority itself — and still enforce authentication and project access.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { installTransportFakes, routeContext, turnsUrl, USER_ID, world } from "./pb-chat-01-cold-runtime-fake.mjs";

delete process.env.OPENAI_API_KEY;

/** GET is read-only: the only rows it may add are security-audit telemetry — never a transcript row. */
function assertAuditOnly(label) {
  const tables = [...new Set(world.writes.map((w) => w.table))];
  assert.deepEqual(tables.filter((table) => table !== "security_events"), [], `${label} wrote outside security audit: ${tables}`);
}
delete process.env.PMFREAK_OPERATING_PROFILE;

test("cold process: the first Project Brain GET does not depend on another route bootstrapping the runtime", async (t) => {
  installTransportFakes(t);
  const { getRuntimeAuthorityPort } = await import("../../src/lib/governance/authority/runtime/authority-provider.ts");
  const { GET } = await import("../../src/app/api/projects/[id]/brain/turns/route.ts");

  // Precondition: the runtime really is cold after loading the route module.
  assert.throws(() => getRuntimeAuthorityPort(), /not registered/, "route module load must not be what bootstraps the runtime");

  const response = await GET(new Request(turnsUrl), routeContext);
  const body = await response.json();
  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(body.conversationId, null, "GET never creates a conversation");
  assert.deepEqual(body.messages, []);
  assert.equal(body.generativeAvailable, false, "no provider configured in this process");
  assertAuditOnly("GET");

  // The runtime authority is now registered — by the Project Brain route itself.
  assert.doesNotThrow(() => getRuntimeAuthorityPort());
});

test("bootstrapped route still fails closed: unauthenticated → 401, non-member → 403", async (t) => {
  installTransportFakes(t);
  const { GET } = await import("../../src/app/api/projects/[id]/brain/turns/route.ts");

  world.user = null;
  const anonymous = await GET(new Request(turnsUrl), routeContext);
  assert.equal(anonymous.status, 401);

  world.user = { id: USER_ID, email: "pm@example.test", user_metadata: {} };
  world.role = null;
  const outsider = await GET(new Request(turnsUrl), routeContext);
  assert.equal(outsider.status, 403);
  world.role = "owner";
  assertAuditOnly("denied GET");
});
