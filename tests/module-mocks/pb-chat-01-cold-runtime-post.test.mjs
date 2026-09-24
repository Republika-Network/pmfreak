/**
 * PB-CHAT-01 RC-1 — the FIRST request a fresh process serves is Project Brain POST.
 *
 * Own `node --test` process: no route has bootstrapped the runtime authority. The turn must
 * pass project access and `project_brain.converse` governance and reach normal Project
 * Brain execution. No provider key and no beta profile, so the turn is answered in limited
 * mode without any provider call — this proves the request path, not the model.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { installTransportFakes, routeContext, turnsUrl, world } from "./pb-chat-01-cold-runtime-fake.mjs";

delete process.env.OPENAI_API_KEY;
delete process.env.PMFREAK_OPERATING_PROFILE;

test("cold process: the first Project Brain POST reaches normal turn execution", async (t) => {
  installTransportFakes(t);
  const { getRuntimeAuthorityPort } = await import("../../src/lib/governance/authority/runtime/authority-provider.ts");
  const { POST } = await import("../../src/app/api/projects/[id]/brain/turns/route.ts");
  assert.throws(() => getRuntimeAuthorityPort(), /not registered/, "route module load must not be what bootstraps the runtime");

  const clientMessageId = "3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b";
  const response = await POST(
    new Request(turnsUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientMessageId, text: "What is the current status of this project?" }) }),
    routeContext,
  );
  const body = await response.json();
  assert.notEqual(response.status, 500, `bootstrap-order 500: ${JSON.stringify(body)}`);
  assert.equal(response.status, 200, `expected a completed turn, got ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(body.status, "completed");
  assert.equal(body.messages[0].clientMessageId, clientMessageId);
  assert.equal(body.messages[1].brain.mode, "degraded", "no provider in this process: limited mode, never a model call");

  // The user turn was persisted through the normal Project Brain store.
  const userTurn = world.writes.find((w) => w.table === "context_messages" && w.rows[0].client_message_id === clientMessageId);
  assert.ok(userTurn, "the user turn reached the transcript store");
  assert.doesNotThrow(() => getRuntimeAuthorityPort());
});
