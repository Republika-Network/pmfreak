/**
 * Pilot Gate Sprint 01 — Task 6 (M-02 / ERR-02, honest AI experience).
 *
 * Verified surface classification (per the independent review errata and
 * re-verified at HEAD in this sprint):
 *   - Command Center chat  → Project Brain (PB-CHAT-01): REAL LLM inference when the
 *                            provider is healthy, explicit "limited mode" otherwise.
 *                            The old deterministic gateway route remains, UI-less.
 *   - First Insight brief  → deterministic engine over onboarding answers
 *   - Onboarding transition → fixed-duration animation (no analysis at all)
 *   - Copilot (/api/copilot) → REAL LLM inference (may claim AI)
 *
 * These tests pin the honest-labeling decisions so copy regressions that
 * re-promise AI on deterministic surfaces fail CI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");

test("command-center chat route remains deterministic (no LLM imports)", () => {
  const routeSrc = read("src/app/api/command-center/chat/route.ts");
  assert.ok(!/runInference|openai-provider|OPENAI_API_KEY/.test(routeSrc),
    "chat route now touches LLM inference — update the chat disclosure copy and this test together");
});

test("the Command Center conversation is Project Brain, with honest generative/limited-mode copy (PB-CHAT-01)", () => {
  // The deterministic feed and its "not generative AI" disclosure were retired with the
  // feed itself; the surface that replaced it IS generative when the provider is healthy.
  assert.ok(!existsSync("src/modules/workspace/presentation/command-center/command-feed.tsx"), "the deterministic feed must stay retired");
  const src = read("src/components/pmfreak/project-brain/project-brain-conversation.tsx");
  assert.ok(src.includes("project-brain-disclosure"), "Project Brain must disclose what it answers from");
  assert.ok(/answers from this project/.test(src), "disclosure must say answers come from this project's records");
  assert.ok(/cannot change the project/.test(src), "disclosure must say the conversation cannot write project state");
  assert.ok(/limited mode/.test(src), "degraded behaviour must be named, never passed off as a full answer");
  assert.ok(!/deterministic rules/.test(src), "the retired deterministic disclosure must not be reused on a generative surface");
});

test("legacy AIActivationTransition component (fabricated 'analyzing' stages) is retired, not merely edited", () => {
  // PMF-001/PMF-002 canonical onboarding consolidation removed this
  // component along with the legacy wizard that was its only caller — see
  // docs/audits/remediation/pmf-001-002-canonical-onboarding-honest-activation.md.
  // If it ever reappears, its copy must be re-audited against the banned
  // fabricated-analysis strings below before this assertion is relaxed.
  const path = "src/components/pmfreak/onboarding/AIActivationTransition.tsx";
  if (!existsSync(path)) return;
  const src = read(path);
  for (const banned of [
    /Analyzing stakeholder structure/,
    /Activating PMFreak agents/,
    /Operational intelligence (?:layer|active)/,
    /Calibrating project intelligence/,
  ]) {
    assert.ok(!banned.test(src), `transition copy claims analysis that never runs: ${banned}`);
  }
});

test("legacy getting-started-flow.tsx (fabricated readiness score, AI-sensing copy) is retired, not merely edited", () => {
  // Same retirement as above — see PMF-001/PMF-002 remediation record.
  const path = "src/components/pmfreak/activation/getting-started-flow.tsx";
  if (!existsSync(path)) return;
  const src = read(path);
  for (const banned of [
    /sensing stakeholder confidence drift/,
    /detection accuracy/,
    /calibrate escalation sensitivity/,
    /Agents are sleeping/,
  ]) {
    assert.ok(!banned.test(src), `getting-started copy overstates AI capability: ${banned}`);
  }
});

test("first-insight brief engine remains deterministic (no LLM imports)", () => {
  const src = read("src/lib/projects/first-insight/operational-governance-brief-engine.ts");
  assert.ok(!/runInference|openai|OPENAI_API_KEY/i.test(src),
    "first-insight engine now uses inference — revisit brief labeling copy and this test together");
});
