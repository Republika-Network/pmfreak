/**
 * Keeps known-vulnerabilities.json and the test files in lockstep, so the expected-failure
 * inventory a reviewer reads is exactly the set of expected failures that runs. Static:
 * needs no database.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("./", import.meta.url);
const registry = JSON.parse(readFileSync(new URL("known-vulnerabilities.json", dir), "utf8"));
const testFiles = readdirSync(dir).filter((name) => name.endsWith(".test.mjs") && name !== "registry.test.mjs");
const sources = new Map(testFiles.map((name) => [name, readFileSync(new URL(name, dir), "utf8")]));

test("every registered case id is unique", () => {
  const ids = registry.cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every registered case names its finding, severity, file and planned fix", () => {
  for (const entry of registry.cases) {
    assert.match(entry.id, /^F\d+-[a-z0-9-]+$/, `malformed id ${entry.id}`);
    assert.ok(entry.id.startsWith(`${entry.finding}-`), `${entry.id} does not match finding ${entry.finding}`);
    assert.ok(["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(entry.severity), `${entry.id}: bad severity`);
    assert.ok(entry.plannedFix, `${entry.id}: missing plannedFix`);
    assert.ok(sources.has(entry.file), `${entry.id}: file ${entry.file} does not exist`);
  }
});

test("every registered case is exercised exactly once in its declared file", () => {
  for (const entry of registry.cases) {
    const occurrences = sources.get(entry.file).split(`"${entry.id}"`).length - 1;
    assert.equal(occurrences, 1, `${entry.id} appears ${occurrences} time(s) in ${entry.file}`);
  }
});

test("no test file references an unregistered case id", () => {
  const registered = new Set(registry.cases.map((entry) => entry.id));
  for (const [name, source] of sources) {
    for (const [, id] of source.matchAll(/"(F\d+-[a-z0-9-]+)"/g)) {
      assert.ok(registered.has(id), `${name} references unregistered case ${id}`);
    }
  }
});
