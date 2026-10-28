import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { draftOwnerTag, draftStorageKey } from "../src/lib/drafts/draft-scope";
import { DRAFT_KEY_PREFIX, LEGACY_DRAFT_KEYS, clearDraftsOwnedBy, clearScopedDraft, loadScopedDraft, saveScopedDraft } from "../src/lib/drafts/draft-storage";

// PD-21 (five-persona QA, Wave 2): unsaved wizard drafts were kept under one global
// localStorage key per wizard, so the next person signing in on the same browser got the
// previous user's draft pre-filled. Live coverage is the QA browser harness; these exercise
// the storage module itself and pin the wiring.

/** An in-memory Storage whose reads are recorded, installed as window.localStorage. */
class MemoryStorage {
  private map = new Map<string, string>();
  reads: string[] = [];
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { this.reads.push(k); return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  keys() { return [...this.map.keys()].sort(); }
}
let store: MemoryStorage;
const g = globalThis as unknown as { window?: { localStorage: MemoryStorage } };
beforeEach(() => {
  store = new MemoryStorage();
  // Object.keys(localStorage) must list the stored keys, as it does in a browser.
  g.window = { localStorage: new Proxy(store, { ownKeys: () => store.keys(), getOwnPropertyDescriptor: (t, k) => (typeof k === "string" && store.keys().includes(k) ? { enumerable: true, configurable: true, value: store.getItem(k) } : undefined) }) };
});


const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const WS_1 = "33333333-3333-4333-8333-333333333333";
const WS_2 = "44444444-4444-4444-8444-444444444444";

test("PD-21: a draft key belongs to one user in one workspace, and names neither", () => {
  const a1 = draftStorageKey("project", USER_A, WS_1)!;
  assert.ok(a1.startsWith(`${DRAFT_KEY_PREFIX}project.${draftOwnerTag(USER_A)}.`));
  assert.equal(draftStorageKey("project", USER_A, WS_1), a1, "stable for the same user and workspace");
  assert.notEqual(draftStorageKey("project", USER_B, WS_1), a1, "another user never shares the key");
  assert.notEqual(draftStorageKey("project", USER_A, WS_2), a1, "another workspace never shares the key");
  assert.notEqual(draftStorageKey("command-center", USER_A, WS_1), a1, "wizards do not share drafts");
  for (const id of [USER_A, WS_1]) assert.ok(!a1.includes(id) && !a1.includes(id.slice(0, 8)), "no raw ids in key names");
  assert.equal(draftStorageKey("project", USER_A, null), null, "no workspace, no draft");
});

test("PD-21: another user (or another workspace) recovers nothing; the same user recovers their draft", () => {
  saveScopedDraft(draftStorageKey("project", USER_A, WS_1), { identity: { projectName: "A secret" } });
  assert.equal(loadScopedDraft(draftStorageKey("project", USER_B, WS_1)), null);
  assert.equal(loadScopedDraft(draftStorageKey("project", USER_A, WS_2)), null);
  assert.deepEqual(loadScopedDraft(draftStorageKey("project", USER_A, WS_1)), { identity: { projectName: "A secret" } });
});

test("PD-21: legacy global keys are deleted unread, and cannot be addressed through the scoped API", () => {
  for (const key of LEGACY_DRAFT_KEYS) store.setItem(key, JSON.stringify({ identity: { projectName: "someone else's" } }));
  store.setItem("pmfreak.contextTree.toggles", "{}");
  assert.equal(loadScopedDraft(draftStorageKey("project", USER_B, WS_1)), null);
  assert.deepEqual(store.keys(), ["pmfreak.contextTree.toggles"], "legacy drafts removed, preferences kept");
  assert.ok(LEGACY_DRAFT_KEYS.every((key) => !store.reads.includes(key)), "legacy contents are never read");
  store.setItem("pmfreak.project.draft", '{"x":1}');
  assert.equal(loadScopedDraft("pmfreak.project.draft"), null, "an unscoped key is refused");
  saveScopedDraft("pmfreak.project.draft", { y: 2 });
  assert.equal(store.keys().includes("pmfreak.project.draft"), false);
});

test("PD-21: sign-out clears only the leaving user's drafts, in every workspace and wizard", () => {
  const mine = [draftStorageKey("project", USER_A, WS_1)!, draftStorageKey("project", USER_A, WS_2)!, draftStorageKey("command-center", USER_A, WS_1)!];
  const theirs = draftStorageKey("project", USER_B, WS_1)!;
  for (const key of [...mine, theirs]) saveScopedDraft(key, { v: key });
  store.setItem("pmfreak.contextTree.toggles", "{}");
  store.setItem("pmfreak.project.draft", "{}");
  clearDraftsOwnedBy(draftOwnerTag(USER_A));
  assert.deepEqual(store.keys(), ["pmfreak.contextTree.toggles", theirs].sort());
  clearDraftsOwnedBy(undefined);
  assert.deepEqual(store.keys(), ["pmfreak.contextTree.toggles", theirs].sort(), "no owner, nothing removed");
});

test("PD-21: completing the wizard clears that draft only", () => {
  const done = draftStorageKey("project", USER_A, WS_1)!;
  const other = draftStorageKey("project", USER_A, WS_2)!;
  saveScopedDraft(done, { a: 1 });
  saveScopedDraft(other, { b: 2 });
  clearScopedDraft(done);
  assert.deepEqual(store.keys(), [other]);
});

test("PD-21: no storage (SSR or blocked) is never fatal", () => {
  delete g.window;
  assert.equal(loadScopedDraft(draftStorageKey("project", USER_A, WS_1)), null);
  assert.doesNotThrow(() => saveScopedDraft(draftStorageKey("project", USER_A, WS_1), {}));
  assert.doesNotThrow(() => clearDraftsOwnedBy(draftOwnerTag(USER_A)));
});

// ─── Wiring ───────────────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(p, "utf8");
const projectWizard = read("src/components/pmfreak/projects/create-project-wizard.tsx");
const pmoWizard = read("src/components/pmfreak/pmo/create-pmo-wizard.tsx");
const projectPage = read("src/app/(protected)/projects/new/page.tsx");
const pmoPage = read("src/app/(protected)/create-command-center/page.tsx");
const layout = read("src/app/(protected)/layout.tsx");

test("PD-21: both wizards keep drafts only through the scoped module, under a server-issued key", () => {
  for (const wizard of [projectWizard, pmoWizard]) {
    assert.doesNotMatch(wizard, /localStorage\./, "no direct localStorage access");
    assert.doesNotMatch(wizard, /"pmfreak\.(project\.draft|pmo\.tenant(\.draft)?)"/, "no global keys");
    assert.match(wizard, /from "@\/lib\/drafts\/draft-storage"/);
    assert.match(wizard, /draftKey = null/);
  }
  assert.match(projectPage, /const draftKey = draftStorageKey\("project", user\.id, displayedWorkspaceId\);/);
  assert.match(projectPage, /<CreateProjectWizard key=\{draftKey \?\? "no-draft"\}[^>]*draftKey=\{draftKey\}/);
  assert.match(pmoPage, /const user = await requireAuthUser\(\);/);
  assert.match(pmoPage, /draftStorageKey\("command-center", user\.id, \(await resolvePreferredWorkspace\(user\.id\)\)\.workspaceId\)/);
  assert.match(pmoPage, /<CreatePmoWizard key=\{draftKey \?\? "no-draft"\} draftKey=\{draftKey\} \/>/);
});

test("PD-21: every sign-out form clears the leaving user's drafts before posting", () => {
  assert.match(layout, /draftOwnerTag: draftOwnerTag\(user\.id\)/);
  for (const shell of ["src/components/pmfreak/operational-shell.tsx", "src/components/pmfreak/conversation-shell/conversation-shell.tsx"]) {
    const forms = read(shell).match(/<form action="\/logout"[^\n]*/g) ?? []; // the handler itself contains "=>"
    assert.ok(forms.length >= 1, `${shell} has a sign-out form`);
    for (const form of forms) assert.match(form, /onSubmit=\{\(\) => clearDraftsOwnedBy\(user\.draftOwnerTag\)\}/);
  }
});

test("PD-21: node:crypto stays on the server — client modules import only the storage half", () => {
  for (const client of [projectWizard, pmoWizard, read("src/components/pmfreak/operational-shell.tsx"), read("src/components/pmfreak/conversation-shell/conversation-shell.tsx"), read("src/lib/drafts/draft-storage.ts")]) {
    assert.doesNotMatch(client, /from "[^"]*draft-scope"|from "node:crypto"/);
  }
});
