/**
 * PB-EXEC-01 — the Execution Brief card in a REAL browser, without a server.
 *
 * The briefs are produced on the Node side by the real turn service (tests/pb-exec-01-harness.tsx
 * → real grounding, assembly, validation and transcript view). The REAL `ProjectBrainAnswer` /
 * `ExecutionBriefCard` are bundled with esbuild, styled with Tailwind compiled from the real
 * component sources, and mounted in Chromium on a secure (https) harness origin so the Clipboard
 * API behaves as in the product. The page makes no request but its own document.
 *
 *   npx playwright test tests/e2e/pb-exec-01-brief-card.spec.ts
 */
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const ORIGIN = "https://pb-exec-01.harness.test";
const SHOTS = process.env.PB_SHOTS_DIR ?? "artifacts/pb-exec-01/screenshots";

type Harness = { views: Record<string, unknown>; rendered: Record<string, Record<string, string>> };
let harness: Harness;
let html = "";

test.beforeAll(async () => {
  harness = JSON.parse(execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/pb-exec-01-harness.tsx"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const views = { ...harness.views, codexPreferred: harness.views.ready };
  const { build } = await import("esbuild");
  const bundle = await build({
    entryPoints: ["tests/pb-exec-01-browser-entry.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    tsconfig: "tsconfig.json",
    logLevel: "silent",
  });
  const postcss = (await import("postcss")).default;
  const tailwind = (await import("@tailwindcss/postcss")).default;
  const css = await postcss([tailwind({ base: process.cwd() })]).process(
    '@import "tailwindcss" source(none);\n@source "../src/components/pmfreak/project-brain";\n',
    { from: path.join(process.cwd(), "tests/pb-exec-01.css") },
  );
  const safeJson = JSON.stringify(views).replace(/</g, "\\u003c");
  html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css.css}</style></head><body class="bg-white"><div id="root"></div><script>window.__PB_EXEC_CASES__=${safeJson};</script><script>${bundle.outputFiles[0].text}</script></body></html>`;
});

async function open(page: Page) {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  await page.goto(`${ORIGIN}/`);
  await expect(page.locator('[data-case="ready"] [data-testid="execution-brief-card"]')).toBeVisible();
  return requests;
}

const card = (page: Page, name: string) => page.locator(`[data-case="${name}"] [data-testid="execution-brief-card"]`);

test("renderer switch and copy: exact renderer text on the clipboard, no request, brief unchanged", async ({ page }) => {
  const requests = await open(page);
  const ready = card(page, "ready");
  const briefId = await ready.getAttribute("data-brief-id");
  await expect(ready.getByText("AI-generated", { exact: true })).toBeVisible();
  await expect(ready.getByTestId("execution-brief-readiness")).toHaveText("Handoff ready");

  for (const [key, label] of [["claude_code", "Claude Code"], ["codex", "Codex"], ["generic", "Generic"]] as const) {
    await ready.getByText(label, { exact: true }).click();
    await expect(ready.getByTestId(`execution-brief-renderer-${key}`)).toBeChecked();
    await ready.getByTestId("execution-brief-copy").click();
    await expect(ready.getByTestId("execution-brief-copy-status")).toContainText(`Copied — formatted for ${label}`);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(harness.rendered.ready[key]);
    expect(clip.split("\n").slice(0, 2).join("\n")).toMatch(/AI-generated[\s\S]*manual handoff[\s\S]*not an authorization to execute, merge or deploy/i);
  }
  await expect(ready).toHaveAttribute("data-brief-id", briefId!);
  expect(requests).toEqual([`${ORIGIN}/`]);
});

test("a credential-like brief is never displayed, previewed or copied; the value never reaches the DOM or clipboard", async ({ page }) => {
  await open(page);
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  const poisoned = card(page, "poisoned");
  await expect(poisoned).toHaveAttribute("data-blocked", "true");
  await expect(poisoned.getByTestId("execution-brief-credential-block")).toContainText("credential-like content");
  await expect(poisoned.getByTestId("execution-brief-copy")).toHaveCount(0);
  await expect(poisoned.getByTestId("execution-brief-preview")).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("sentinel");
  // The rendered UI (not the harness's own inline test data) never contains the value.
  expect(await page.locator("#root").innerHTML()).not.toContain("ghp_");
});

test("a withheld selected target: needs input, copy still offered, the unsupported path never reaches the DOM or clipboard", async ({ page }) => {
  await open(page);
  const withheld = card(page, "withheld");
  await expect(withheld.getByTestId("execution-brief-readiness")).toHaveText("Needs input");
  await expect(withheld.getByTestId("execution-brief-target")).toHaveCount(0);
  await expect(withheld).toContainText("Reconfirm the target without the unsupported execution detail");
  for (const [key, label] of [["claude_code", "Claude Code"], ["codex", "Codex"], ["generic", "Generic"]] as const) {
    await withheld.getByText(label, { exact: true }).click();
    await withheld.getByTestId("execution-brief-copy").click();
    await expect(withheld.getByTestId("execution-brief-copy-status")).toContainText(`Copied — formatted for ${label}`);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(harness.rendered.withheld[key]);
    expect(clip).not.toContain("src/not-established");
  }
  expect(await page.locator("#root").innerHTML()).not.toContain("src/not-established");
});

test("keyboard: renderer radios move with arrows, Copy works from the keyboard, focus is not stolen, no auto-scroll", async ({ page }) => {
  await open(page);
  const ready = card(page, "ready");
  await ready.getByTestId("execution-brief-renderer-generic").focus();
  await page.keyboard.press("ArrowRight");
  await expect(ready.getByTestId("execution-brief-renderer-claude_code")).toBeChecked();
  await expect(ready.getByTestId("execution-brief-renderer-claude_code")).toBeFocused();
  const copy = ready.getByTestId("execution-brief-copy");
  await copy.focus();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.keyboard.press("Enter");
  await expect(ready.getByTestId("execution-brief-copy-status")).toContainText("Claude Code");
  await expect(copy).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expect(copy).toHaveAccessibleName("Copy brief formatted for Claude Code");
});

test("a phrase-preselected renderer is local only (Codex preselected; same brief)", async ({ page }) => {
  await open(page);
  const codex = card(page, "codexPreferred");
  await expect(codex.getByTestId("execution-brief-renderer-codex")).toBeChecked();
  await expect(codex).toHaveAttribute("data-brief-id", (await card(page, "ready").getAttribute("data-brief-id"))!);
});

test("each recommendation's control carries its exact statement id", async ({ page }) => {
  await open(page);
  const actions = page.locator('[data-case="threeRecommendations"] [data-testid="project-brain-prepare-brief"]');
  await expect(actions).toHaveCount(3);
  await actions.nth(1).click();
  const prepared = await page.evaluate(() => window.__PB_EXEC_PREPARED__);
  expect(prepared).toEqual([await actions.nth(1).getAttribute("data-statement-id")]);
});

test("Sources & verification opens natively: no request, renderer unchanged", async ({ page }) => {
  const requests = await open(page);
  const ready = page.locator('[data-case="ready"]');
  await ready.getByTestId("execution-brief-renderer-codex").check({ force: true });
  await ready.getByTestId("project-brain-answer-details-summary").click();
  await expect(ready.getByTestId("project-brain-answer-details-panel")).toBeVisible();
  await expect(ready.getByTestId("execution-brief-renderer-codex")).toBeChecked();
  expect(requests).toEqual([`${ORIGIN}/`]);
});

for (const width of [360, 1280]) {
  test(`layout at ${width}px: no horizontal overflow, long content wraps, controls reachable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    for (const name of ["ready", "long", "reported", "needsInput"]) {
      await card(page, name).getByTestId("execution-brief-preview").locator("summary").click();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const long = card(page, "long");
    const box = await long.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width);
    await expect(long.getByTestId("execution-brief-copy")).toBeVisible();
    mkdirSync(SHOTS, { recursive: true });
    await card(page, "ready").screenshot({ path: `${SHOTS}/brief-card-${width}.png` });
  });
}
