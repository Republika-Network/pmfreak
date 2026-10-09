/**
 * Pilot Gate Sprint 01 — Task 9 (pilot agreement technical readiness).
 * Technical plumbing only — asserts versioning, placeholder honesty, and
 * the acceptance flow's structural guarantees. No legal content is tested
 * because none may exist until counsel review.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import {
  PILOT_AGREEMENT_VERSION,
  PILOT_AGREEMENT_IS_PLACEHOLDER,
  PILOT_AGREEMENT_SECTIONS,
  PILOT_LEGAL_DEPENDENCIES,
  isAcceptanceCurrent,
} from "../src/lib/pilot/pilot-agreement";

test("agreement version follows the documented format", () => {
  assert.match(PILOT_AGREEMENT_VERSION, /^\d+\.\d+(-draft)?$/);
});

test("while placeholder, every section is explicitly marked for legal review", () => {
  if (!PILOT_AGREEMENT_IS_PLACEHOLDER) return;
  assert.ok(PILOT_AGREEMENT_SECTIONS.length >= 5, "agreement must cover the core sections");
  for (const section of PILOT_AGREEMENT_SECTIONS) {
    assert.ok(section.placeholder.includes("[LEGAL REVIEW REQUIRED]"), `section not marked for review: ${section.id}`);
  }
});

test("placeholder agreement must carry a draft version", () => {
  if (PILOT_AGREEMENT_IS_PLACEHOLDER) {
    assert.ok(PILOT_AGREEMENT_VERSION.includes("draft"), "placeholder content must never carry a final version number");
  }
});

test("core sections exist: data handling, AI disclosure, data return", () => {
  const ids = PILOT_AGREEMENT_SECTIONS.map((s) => s.id);
  for (const required of ["data-handling", "ai-disclosure", "data-return", "termination", "liability"]) {
    assert.ok(ids.includes(required), `missing agreement section: ${required}`);
  }
});

test("legal dependencies are documented", () => {
  assert.ok(PILOT_LEGAL_DEPENDENCIES.length >= 3);
  assert.ok(PILOT_LEGAL_DEPENDENCIES.some((d) => /Terms of Service/.test(d)));
});

test("acceptance currency is version-exact", () => {
  assert.equal(isAcceptanceCurrent({ agreementVersion: PILOT_AGREEMENT_VERSION }), true);
  assert.equal(isAcceptanceCurrent({ agreementVersion: "0.0-draft" }), false);
});

test("the agreement page shows the placeholder banner while placeholder", () => {
  const src = readFileSync("src/app/(protected)/pilot-agreement/page.tsx", "utf8");
  assert.ok(src.includes("PILOT_AGREEMENT_IS_PLACEHOLDER"), "page must gate the banner on the placeholder flag");
  assert.ok(src.includes("not a legal document"), "page must disclaim legal validity while placeholder");
});

test("the accept API pins the exact agreement version", () => {
  const src = readFileSync("src/app/api/pilot-agreement/accept/route.ts", "utf8");
  assert.ok(src.includes("agreement_version_mismatch"), "accept route must reject stale versions");
  assert.ok(src.includes("requireWorkspaceMember"), "accept route must verify workspace membership");
});

test("acceptance storage migration exists with RLS", () => {
  const path = "supabase/migrations/20260827000000_pilot_agreement_acceptances.sql";
  assert.ok(existsSync(path));
  const sql = readFileSync(path, "utf8");
  assert.ok(sql.includes("enable row level security"));
  assert.ok(sql.includes("revoke update, delete"), "acceptance history must be immutable from clients");
  assert.ok(sql.includes("unique (workspace_id, user_id, agreement_version)"));
});

test("landing footer legal links stay disabled until real documents exist", () => {
  // The landing and pricing share one footer; guard its source, and that the landing uses it.
  assert.match(readFileSync("src/app/page.tsx", "utf8"), /<MarketingFooter onHomepage \/>/);
  const src = readFileSync("src/components/marketing/marketing-footer.tsx", "utf8");
  const privacyBlock = src.match(/\{ label: "Privacy Policy"[^}]*\}/)?.[0] ?? "";
  const tosBlock = src.match(/\{ label: "Terms of Service"[^}]*\}/)?.[0] ?? "";
  assert.ok(privacyBlock.includes("disabled: true"), "Privacy Policy link must stay disabled until published");
  assert.ok(tosBlock.includes("disabled: true"), "Terms of Service link must stay disabled until published");
});
