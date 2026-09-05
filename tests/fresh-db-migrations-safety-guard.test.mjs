// Behavioral safety-guard and hosted-mode coverage for
// scripts/check-fresh-db-migrations.mjs (Perilla 13B — RR-MIGRATE hosted
// prep). These tests exercise the real script logic (subprocess and direct
// import), not a re-implementation of it. None of them require network
// access or real Supabase credentials — every case here is designed to
// fail closed at the safety-guard step, before any network call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  determineMode,
  safetyGuard,
  parseHostedMigrationList,
  classifyHostedTarget,
  classifyObjectEmptiness,
  classifyObservedTriggers,
  STOCK_PLATFORM_TRIGGER_BASELINE,
  extractSupabaseProjectRefFromDbUrl,
  verifyHostedTargetBinding,
  applyHosted,
  recognizeMigrationListRows,
  classifyManagedSchemaObjects,
  probeHostedApplicationState,
  STOCK_MANAGED_OBJECT_BASELINE,
  STOCK_MANAGED_OBJECT_PROFILES,
  managedObjectProblemCount,
  STOCK_EXTENSION_BASELINE,
  STOCK_MANAGED_ROW_RULES,
  classifyInstalledExtensions,
  classifyManagedRowState,
  classifyManagedSchemaAcl,
  classifyDefaultAcl,
  STOCK_MANAGED_SCHEMA_ACL,
  STOCK_DEFAULT_ACL,
  isRealtimeDailyPartition,
  realtimePartitionDefinition,
  fingerprintDefinition,
  readHostedMigrationVersions,
  HOSTED_ALLOWED_VALIDATION_REFS,
  redact,
  loadMigrationFiles,
  main,
  runNpx,
  scrubSecrets,
  describeSpawnResult,
  formatFailure,
  KNOWN_PRODUCTION_HOST_FRAGMENTS,
  HOSTED_ALLOWED_MIGRATION_VALIDATION_REF,
  HOSTED_DENIED_ACTIVE_PMFREAK_REF,
} from "../scripts/check-fresh-db-migrations.mjs";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/check-fresh-db-migrations.mjs");

function run(env) {
  return spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", env });
}

// ─── Subprocess behavioral tests (no network reached in any case below) ───

test("verify-only mode (no DB vars) passes with exit 0", () => {
  const result = run({ PATH: process.env.PATH });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Mode: verify-only/);
});

test("refuses to run local mode without ALLOW_DESTRUCTIVE_FRESH_DB_TEST=true", () => {
  const result = run({ PATH: process.env.PATH, FRESH_DB_URL: "postgresql://user:pass@localhost:5432/scratch" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ALLOW_DESTRUCTIVE_FRESH_DB_TEST must be explicitly set/);
});

test("rejects a production-looking database host even with destructive confirmation set", () => {
  const result = run({
    PATH: process.env.PATH,
    FRESH_DB_URL: "postgresql://user:pass@my-production-db.example.com:5432/app",
    ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to run: database URL host looks production-like/);
});

test("hosted mode refuses to run without FRESH_DB_EXPECTED_PROJECT_REF", () => {
  const result = run({
    PATH: process.env.PATH,
    SUPABASE_DB_URL: "postgresql://user:pass@db.abcxyz.supabase.co:5432/postgres",
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_value",
    SUPABASE_PROJECT_REF: "abcxyz",
    ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FRESH_DB_EXPECTED_PROJECT_REF is required in hosted mode/);
});

test("hosted mode refuses to run when FRESH_DB_EXPECTED_PROJECT_REF does not match SUPABASE_PROJECT_REF", () => {
  const result = run({
    PATH: process.env.PATH,
    SUPABASE_DB_URL: "postgresql://user:pass@db.abcxyz.supabase.co:5432/postgres",
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_value",
    SUPABASE_PROJECT_REF: "abcxyz",
    FRESH_DB_EXPECTED_PROJECT_REF: "different-ref",
    ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match SUPABASE_PROJECT_REF/);
});

test("hosted mode never accepts an empty-string project ref as a match", () => {
  const result = run({
    PATH: process.env.PATH,
    SUPABASE_DB_URL: "postgresql://user:pass@db.abcxyz.supabase.co:5432/postgres",
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_value",
    SUPABASE_PROJECT_REF: "",
    FRESH_DB_EXPECTED_PROJECT_REF: "",
    ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
  });
  // Empty SUPABASE_PROJECT_REF means hasHosted is false (falsy check in
  // determineMode), so this falls through to verify-only — it must not be
  // silently treated as a "linked" hosted run.
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Mode: verify-only/);
});

test("rejected runs never print the raw access token or db URL credentials to stdout/stderr", () => {
  const secretToken = "sbp_super_secret_token_value_should_never_appear";
  const secretPassword = "SuperSecretDbPassword123";
  const result = run({
    PATH: process.env.PATH,
    SUPABASE_DB_URL: `postgresql://postgres:${secretPassword}@db.abcxyz.supabase.co:5432/postgres`,
    SUPABASE_ACCESS_TOKEN: secretToken,
    SUPABASE_PROJECT_REF: "abcxyz",
    FRESH_DB_EXPECTED_PROJECT_REF: "mismatched-ref",
    ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, new RegExp(secretToken));
  assert.doesNotMatch(result.stderr, new RegExp(secretToken));
  assert.doesNotMatch(result.stdout, new RegExp(secretPassword));
  assert.doesNotMatch(result.stderr, new RegExp(secretPassword));
});

// ─── Direct-import unit tests (pure functions, no subprocess needed) ──────

test("determineMode: no DB vars set at all falls to verify-only", () => {
  const saved = { ...process.env };
  delete process.env.SUPABASE_DB_URL;
  delete process.env.SUPABASE_ACCESS_TOKEN;
  delete process.env.SUPABASE_PROJECT_REF;
  delete process.env.FRESH_DB_URL;
  assert.equal(determineMode(), "verify-only");
  process.env = saved;
});

test("determineMode: hosted requires all three of SUPABASE_DB_URL/ACCESS_TOKEN/PROJECT_REF — two of three is not enough", () => {
  const saved = { ...process.env };
  delete process.env.FRESH_DB_URL;
  process.env.SUPABASE_DB_URL = "postgresql://x/y";
  process.env.SUPABASE_ACCESS_TOKEN = "tok";
  delete process.env.SUPABASE_PROJECT_REF;
  assert.equal(determineMode(), "verify-only");
  process.env = saved;
});

test("determineMode: recognizes local mode from FRESH_DB_URL alone", () => {
  const saved = { ...process.env };
  delete process.env.SUPABASE_DB_URL;
  delete process.env.SUPABASE_ACCESS_TOKEN;
  delete process.env.SUPABASE_PROJECT_REF;
  process.env.FRESH_DB_URL = "postgresql://localhost/scratch";
  assert.equal(determineMode(), "local");
  process.env = saved;
});

test("determineMode: recognizes hosted mode only when all three hosted vars are set", () => {
  const saved = { ...process.env };
  delete process.env.FRESH_DB_URL;
  process.env.SUPABASE_DB_URL = "postgresql://db.ref.supabase.co/postgres";
  process.env.SUPABASE_ACCESS_TOKEN = "tok";
  process.env.SUPABASE_PROJECT_REF = "ref";
  assert.equal(determineMode(), "hosted");
  process.env = saved;
});

test("safetyGuard: verify-only mode always passes without requiring any confirmation", () => {
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  const saved = { ...process.env };
  delete process.env.ALLOW_DESTRUCTIVE_FRESH_DB_TEST;
  assert.equal(safetyGuard("verify-only"), true);
  assert.equal(process.exitCode, undefined);
  process.env = saved;
  process.exitCode = savedExitCode;
});

test("safetyGuard: KNOWN_PRODUCTION_HOST_FRAGMENTS covers prod/production/pilot", () => {
  assert.deepEqual(KNOWN_PRODUCTION_HOST_FRAGMENTS, ["prod", "production", "pilot"]);
});

test("redact: never returns the raw value for a populated connection string", () => {
  const secret = "postgresql://postgres:hunter2@db.abcxyz.supabase.co:5432/postgres";
  const result = redact(secret);
  assert.notEqual(result, secret);
  assert.doesNotMatch(result, /hunter2/);
});

test("redact: passes through unset values as (unset), never null/undefined text leakage", () => {
  assert.equal(redact(undefined), "(unset)");
  assert.equal(redact(""), "(unset)");
});

// ─── parseHostedMigrationList: CLI-output row parsing controls ────────────
// The Supabase CLI emits migration timestamps either bare or wrapped in
// backticks depending on version. The original parser accepted only the bare
// form, so against real (backtick) CLI output it matched ZERO rows and
// falsely reported every local migration as remote-pending. These controls
// pin both renderings, both drift directions, and the non-row text that must
// never be mistaken for a migration row.

const CLEAN_TABLE = `
   Local          | Remote         | Time (UTC)
  ----------------|----------------|---------------------
   20260428120000 | 20260428120000 | 2026-04-28 12:00:00
   20260501000000 | 20260501000000 | 2026-05-01 00:00:00
`;

const PENDING_LOCAL_TABLE = `
   Local          | Remote         | Time (UTC)
  ----------------|----------------|---------------------
   20260428120000 | 20260428120000 | 2026-04-28 12:00:00
   20260501000000 |                | 2026-05-01 00:00:00
`;

const UNEXPECTED_REMOTE_TABLE = `
   Local          | Remote         | Time (UTC)
  ----------------|----------------|---------------------
   20260428120000 | 20260428120000 | 2026-04-28 12:00:00
                  | 20260601000000 | 2026-06-01 00:00:00
`;

// Current CLI shape: every populated cell is wrapped in backticks.
const BACKTICK_CLEAN_TABLE = [
  "Local | Remote | Time (UTC)",
  "----|----|----",
  "`20260428120000` | `20260428120000` | 2026-04-28 12:00:00",
  "`20260501000000` | `20260501000000` | 2026-05-01 00:00:00",
].join("\n");

const BACKTICK_PENDING_LOCAL_TABLE = [
  "Local | Remote | Time (UTC)",
  "----|----|----",
  "`20260428120000` | `20260428120000` | 2026-04-28 12:00:00",
  "`20260501000000` |  | 2026-05-01 00:00:00",
].join("\n");

const BACKTICK_UNEXPECTED_REMOTE_TABLE = [
  "Local | Remote | Time (UTC)",
  "----|----|----",
  "`20260428120000` | `20260428120000` | 2026-04-28 12:00:00",
  " | `20260601000000` | 2026-06-01 00:00:00",
].join("\n");

test("parseHostedMigrationList: clean match reports no pending/unexpected rows", () => {
  const parsed = parseHostedMigrationList(CLEAN_TABLE, ["20260428120000", "20260501000000"]);
  assert.equal(parsed.pendingLocal.length, 0);
  assert.equal(parsed.unexpectedRemote.length, 0);
  assert.equal(parsed.matchedCount, 2);
  assert.equal(parsed.matchedRows, 2);
});

test("parseHostedMigrationList: detects a local migration missing from remote (remote-pending)", () => {
  const parsed = parseHostedMigrationList(PENDING_LOCAL_TABLE, ["20260428120000", "20260501000000"]);
  assert.deepEqual(parsed.pendingLocal, ["20260501000000"]);
});

test("parseHostedMigrationList: detects a remote migration with no matching local file (remote-unexpected drift)", () => {
  const parsed = parseHostedMigrationList(UNEXPECTED_REMOTE_TABLE, ["20260428120000"]);
  assert.deepEqual(parsed.unexpectedRemote, ["20260601000000"]);
});

test("parseHostedMigrationList: migration count mismatch is detectable via matchedCount vs. local file count", () => {
  const parsed = parseHostedMigrationList(CLEAN_TABLE, ["20260428120000", "20260501000000", "20260601000000"]);
  // Third local timestamp has no row at all in this synthetic table, so it
  // surfaces as pendingLocal rather than a silently-accepted match.
  assert.deepEqual(parsed.pendingLocal, ["20260601000000"]);
});

// ── 1. backtick-wrapped matched rows (the regression that caused the false
//       negative: this used to parse to zero rows) ────────────────────────
test("parseHostedMigrationList: backtick-wrapped matched rows parse as local+remote matches", () => {
  const parsed = parseHostedMigrationList(BACKTICK_CLEAN_TABLE, ["20260428120000", "20260501000000"]);
  assert.equal(parsed.rows.length, 2, "backtick-wrapped rows must not be skipped");
  assert.deepEqual(parsed.rows, [
    { local: "20260428120000", remote: "20260428120000" },
    { local: "20260501000000", remote: "20260501000000" },
  ]);
  assert.deepEqual(parsed.pendingLocal, [], "backtick rows must not read as remote-pending");
  assert.deepEqual(parsed.unexpectedRemote, []);
  assert.equal(parsed.matchedCount, 2);
  assert.equal(parsed.matchedRows, 2);
});

// ── 2. plain matched rows still parse (no regression on the older CLI) ────
test("parseHostedMigrationList: plain (un-backticked) matched rows still parse after the backtick fix", () => {
  const parsed = parseHostedMigrationList(CLEAN_TABLE, ["20260428120000", "20260501000000"]);
  assert.deepEqual(parsed.rows, [
    { local: "20260428120000", remote: "20260428120000" },
    { local: "20260501000000", remote: "20260501000000" },
  ]);
  assert.equal(parsed.matchedRows, 2);
});

// ── 3. local-only row with backticks -> remote-pending ────────────────────
test("parseHostedMigrationList: backtick local-only row is still detected as remote-pending", () => {
  const parsed = parseHostedMigrationList(BACKTICK_PENDING_LOCAL_TABLE, [
    "20260428120000",
    "20260501000000",
  ]);
  assert.deepEqual(parsed.pendingLocal, ["20260501000000"]);
  assert.deepEqual(parsed.unexpectedRemote, []);
  assert.equal(parsed.matchedRows, 1);
});

// ── 4. remote-only row with backticks -> remote-unexpected drift ──────────
test("parseHostedMigrationList: backtick remote-only row is still detected as unexpected remote drift", () => {
  const parsed = parseHostedMigrationList(BACKTICK_UNEXPECTED_REMOTE_TABLE, ["20260428120000"]);
  assert.deepEqual(parsed.unexpectedRemote, ["20260601000000"]);
  assert.deepEqual(parsed.pendingLocal, []);
  assert.equal(parsed.matchedRows, 1);
});

// ── 5. mixed whitespace (tabs, wide padding, no padding, CRLF) ────────────
test("parseHostedMigrationList: mixed whitespace and CRLF around both cell forms parses identically", () => {
  const messy =
    "   Local   |   Remote   |  Time (UTC)\r\n" +
    "-----------|------------|------------\r\n" +
    "`20260428120000`|`20260428120000`| 2026-04-28 12:00:00\r\n" +
    "\t`20260501000000`   \t|\t   `20260501000000`\t| 2026-05-01 00:00:00\r\n" +
    "  20260601000000   |   20260601000000   | 2026-06-01 00:00:00\r\n";
  const parsed = parseHostedMigrationList(messy, ["20260428120000", "20260501000000", "20260601000000"]);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.pendingLocal, []);
  assert.deepEqual(parsed.unexpectedRemote, []);
  assert.equal(parsed.matchedRows, 3);
});

// ── 6. headers and separators are never counted as rows ───────────────────
test("parseHostedMigrationList: header and separator lines are ignored, not parsed as rows", () => {
  const headerOnly = ["Local | Remote | Time (UTC)", "----------------|----------------|-------------", "", "   |   |   "].join("\n");
  const parsed = parseHostedMigrationList(headerOnly, []);
  assert.deepEqual(parsed.rows, [], "no header/separator/blank line may become a migration row");
  assert.equal(parsed.matchedCount, 0);
  assert.equal(parsed.matchedRows, 0);
});

// ── 7. malformed text is ignored rather than half-parsed ──────────────────
test("parseHostedMigrationList: malformed and noisy lines are ignored, never coerced into rows", () => {
  const noisy = [
    "Connecting to remote database...",
    "WARN: something happened | with a pipe | in it",
    "2026042812 | 20260428120000 | too-few-digits-on-the-left",
    "202604281200001 | 20260428120000 | too-many-digits-on-the-left",
    "`20260428120000 | `20260428120000` | unbalanced-backtick",
    "20260428120000x | 20260428120000 | trailing-junk",
    "`20260501000000` | `20260501000000` | 2026-05-01 00:00:00",
  ].join("\n");
  const parsed = parseHostedMigrationList(noisy, ["20260501000000"]);
  assert.deepEqual(parsed.rows, [{ local: "20260501000000", remote: "20260501000000" }],
    "only the one well-formed row may be parsed out of the noise");
  assert.deepEqual(parsed.pendingLocal, []);
  assert.deepEqual(parsed.unexpectedRemote, []);
});

// ── 8. real current CLI-shaped multi-row fixture ──────────────────────────
// Shaped exactly like observed `supabase migration list --linked` stdout:
// a header, a separator, and backtick-wrapped matched rows, preceded by the
// CLI's "Connecting to remote database..." chatter.
test("parseHostedMigrationList: real current-CLI-shaped multi-row output parses every row as matched", () => {
  const timestamps = Array.from({ length: 12 }, (_, i) =>
    `2026${String(4 + i).padStart(2, "0")}01000000`);
  const body = timestamps
    .map((ts) => `   \`${ts}\` | \`${ts}\` | \`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} 00:00:00\` `)
    .join("\n");
  // Observed verbatim shape: leading blank lines, a padded header, a dashed
  // separator, and every cell — Time included — wrapped in backticks.
  const realShaped = [
    "",
    "  ",
    "   Local            | Remote           | Time (UTC)            ",
    "  ------------------|------------------|-----------------------",
    body,
    "",
  ].join("\n");

  const parsed = parseHostedMigrationList(realShaped, timestamps);
  assert.equal(parsed.rows.length, timestamps.length);
  assert.equal(parsed.matchedRows, timestamps.length);
  assert.equal(parsed.matchedCount, timestamps.length);
  assert.deepEqual(parsed.pendingLocal, []);
  assert.deepEqual(parsed.unexpectedRemote, []);
});

test("parseHostedMigrationList: the parser accepts backtick cells by shape, not by a hardcoded timestamp list", () => {
  const source = readFileSync(SCRIPT, "utf8");
  // Guard against a "fix" that pins the current 161 migration timestamps.
  // Only executable lines count — the doc comment legitimately shows sample
  // CLI rows, which are illustration, not parser input.
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const hardcoded = code.match(/\b20\d{12}\b/g) ?? [];
  assert.deepEqual(hardcoded, [], "no migration timestamp may be hardcoded into the parser script");
  // The cell grammar must admit both renderings.
  assert.match(source, /`\?\(\\d\{14\}\)`\?|`\(\\d\{14\}\)`/,
    "the cell pattern must explicitly accept backtick-wrapped timestamps");
});

test("hosted apply path invokes the official Supabase CLI via npx, not a hand-rolled HTTP client", () => {
  const source = readFileSync(SCRIPT, "utf8");
  // The three hosted commands now go through an injected `runner` seam so the
  // credential-free suite can exercise the path offline. The seam must DEFAULT to the
  // portable npx helper — the intent of this control is unchanged: the official Supabase
  // CLI, never a hand-rolled HTTP client and never a bare spawn.
  assert.match(source, /function applyHosted\(files = loadMigrationFiles\(\), runner = runNpx\)/,
    "the hosted apply seam does not default to the portable npx helper");
  assert.match(source, /function readHostedMigrationVersions\(localTimestamps, runner = runNpx\)/,
    "the migration-list seam does not default to the portable npx helper");
  assert.match(source, /runner\(\["-y", "supabase", "link", "--project-ref", projectRef\]/);
  assert.ok(source.includes('runner(["-y", "supabase", "db", "push", "--include-roles"]'));
  assert.match(source, /runner\(\["-y", "supabase", "migration", "list", "--linked"\]/);
  // The unportable direct form must not come back at any hosted call site.
  assert.doesNotMatch(source, /sh\("npx", \["-y"/);
  // No hand-rolled HTTP client on the hosted path.
  assert.doesNotMatch(source, /\bfetch\(|require\("https?"\)|from "node:https"/, "the hosted path must not speak HTTP directly");
});


// ─── Main-module detection (harness executability) ────────────────────────
//
// Regression control for a HARNESS DEFECT that produced a silent EXIT=0 with
// no output and no database contact: main-module detection was written as
//   import.meta.url === `file://${process.argv[1]}`
// which is false on Windows (argv[1] is `C:\...\x.mjs`, the URL is
// `file:///C:/.../x.mjs`), so main() was never invoked. The comparison must
// resolve both sides to filesystem paths. Both directions are pinned here:
// direct execution MUST run main(); importing the module MUST NOT.

const BANNER = "PMFreak Fresh Database Migration Proof";

test("direct execution invokes main(): banner, mode and discovered-file count are printed", () => {
  const result = run({ PATH: process.env.PATH });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(BANNER), `expected banner in stdout, got: ${JSON.stringify(result.stdout)}`);
  assert.match(result.stdout, /^Mode: (verify-only|local|hosted)$/m);

  const discovered = result.stdout.match(/^Migration files discovered: (\d+)$/m);
  assert.ok(discovered, "main() must print the discovered migration-file count");
  // Pinned to the real inventory rather than a literal, so the control keeps
  // proving execution as migrations are added.
  assert.equal(Number(discovered[1]), loadMigrationFiles().length);
  assert.ok(Number(discovered[1]) > 0, "a run that discovers zero migrations is not proof of execution");
});

test("main-module detection holds for the Windows argv/URL shapes that broke it", () => {
  // The real Windows values Node produces for the same file. Node resolves
  // argv[1] itself, so the defect cannot be reproduced on POSIX by passing an
  // odd path — it is specifically the backslash/file-URL mismatch below.
  const winArgv = "C:\\Users\\Founder\\pmfreak\\scripts\\check-fresh-db-migrations.mjs";
  const winUrl = "file:///C:/Users/Founder/pmfreak/scripts/check-fresh-db-migrations.mjs";

  // The old expression: `file://${process.argv[1]}` === import.meta.url.
  assert.notEqual(`file://${winArgv}`, winUrl, "the hand-built file:// string never matched on Windows");

  // The shipped expression, evaluated with Windows semantics.
  const fromUrl = fileURLToPath(winUrl, { windows: true });
  assert.equal(path.win32.resolve(winArgv), path.win32.resolve(fromUrl));

  // ...and it still holds for this platform's own values.
  assert.equal(path.resolve(SCRIPT), path.resolve(fileURLToPath(pathToFileURL(SCRIPT).href)));
});

test("module import does NOT invoke main(): importing the harness executes nothing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fresh-db-import-"));
  const runner = path.join(dir, "import-only-runner.mjs");
  try {
    // argv[1] is the runner, not the harness — the realistic shape for a test
    // runner or any consumer importing the exported helpers.
    writeFileSync(
      runner,
      `import * as harness from ${JSON.stringify(pathToFileURL(SCRIPT).href)};\n` +
        `console.log("IMPORT_COMPLETED:" + typeof harness.main + ":" + typeof harness.safetyGuard);\n`,
      "utf8",
    );
    const result = spawnSync(process.execPath, [runner], { encoding: "utf8", env: { PATH: process.env.PATH }, cwd: ROOT });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("IMPORT_COMPLETED:function:function"), "import must resolve and expose the helpers");
    assert.ok(!result.stdout.includes(BANNER), "importing the module must not execute main()");
    assert.doesNotMatch(result.stdout, /Migration files discovered:/);
    assert.doesNotMatch(result.stdout + result.stderr, /Fresh apply/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main-module detection resolves paths instead of building a file:// string", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.ok(source.includes('import { fileURLToPath } from "node:url"'), "must use Node's URL conversion");
  assert.match(source, /path\.resolve\(process\.argv\[1\]\)\s*===\s*path\.resolve\(fileURLToPath\(import\.meta\.url\)\)/);
  // The non-portable construction must not come back.
  assert.doesNotMatch(source, /import\.meta\.url\s*===\s*`file:\/\/\$\{/);
  // main() must stay conditional: importing the module must never be destructive.
  assert.match(source, /if \(isMainModule\) main\(\);/);
  assert.equal(typeof main, "function");
});

// ─── Hosted target identity: denylist + single-project allowlist ──────────

test("hosted mode refuses the ACTIVE PMFreak project ref even with matching refs and destructive confirmation", () => {
  const result = run({
    PATH: process.env.PATH,
    ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
    SUPABASE_DB_URL: `postgresql://postgres:pw@db.${HOSTED_DENIED_ACTIVE_PMFREAK_REF}.supabase.co:5432/postgres`,
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_not_real",
    SUPABASE_PROJECT_REF: HOSTED_DENIED_ACTIVE_PMFREAK_REF,
    FRESH_DB_EXPECTED_PROJECT_REF: HOSTED_DENIED_ACTIVE_PMFREAK_REF,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /ACTIVE PMFreak project/);
  assert.doesNotMatch(result.stdout + result.stderr, /sbp_test_token_not_real/);
});

test("hosted mode REFUSES a matching-but-unallowlisted ref, in-process and offline", () => {
  // Deliberately in-process. The previous version of this control supplied a complete
  // hosted environment that PASSED safetyGuard, so the child immediately ran
  // `npx -y supabase link` — a credential-free suite that could hang on an npx download
  // or make a real hosted request. safetyGuard is a pure exported function; call it.
  const saved = { ...process.env };
  const savedExit = process.exitCode;
  try {
    Object.assign(process.env, {
      ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
      SUPABASE_DB_URL: "postgresql://user:pass@db.someotherprojectref.supabase.co:5432/postgres",
      SUPABASE_ACCESS_TOKEN: "sbp_test_token_not_real",
      SUPABASE_PROJECT_REF: "someotherprojectref",
      FRESH_DB_EXPECTED_PROJECT_REF: "someotherprojectref",
    });
    assert.equal(safetyGuard("hosted"), false, "a matching handshake alone must not authorise a destructive target");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    process.exitCode = savedExit;
  }
});

test("the allowlist is version-controlled source, and the active project is never in it", () => {
  assert.ok(Array.isArray(HOSTED_ALLOWED_VALIDATION_REFS) && HOSTED_ALLOWED_VALIDATION_REFS.length > 0);
  assert.ok(HOSTED_ALLOWED_VALIDATION_REFS.includes(HOSTED_ALLOWED_MIGRATION_VALIDATION_REF));
  assert.ok(!HOSTED_ALLOWED_VALIDATION_REFS.includes(HOSTED_DENIED_ACTIVE_PMFREAK_REF), "the ACTIVE project must never be allowlisted");
});

// ─── Parser fail-closed: a regression must never read as "fresh" ──────────
test("recognizeMigrationListRows: zero recognized rows with local migrations FAILS CLOSED", () => {
  const r = recognizeMigrationListRows([], ["20260428120000", "20260501000000"]);
  assert.equal(r.ok, false, "an unrecognized table must never be treated as an empty remote");
  assert.match(r.reason, /UNRECOGNIZED_OUTPUT/);
});

test("recognizeMigrationListRows: rows that do not account for every local migration FAIL CLOSED", () => {
  const rows = [{ local: "20260428120000", remote: null }];
  const r = recognizeMigrationListRows(rows, ["20260428120000", "20260501000000"]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not account for 1 local migration/);
});

test("recognizeMigrationListRows: a legitimately EMPTY remote is recognized (local rows, empty Remote)", () => {
  const locals = ["20260428120000", "20260501000000"];
  const rows = locals.map((v) => ({ local: v, remote: null }));
  assert.equal(recognizeMigrationListRows(rows, locals).ok, true);
  // ...and only then may it classify as fresh.
  assert.equal(classifyHostedTarget(rows.map((r) => r.remote).filter(Boolean), locals).mode, "fresh");
});

test("readHostedMigrationVersions: an unparseable-but-successful CLI run cannot yield remoteVersions=[]", () => {
  // Injected runner seam: no npx, no network, no CLI.
  const stubbed = () => ({ status: 0, stdout: "Connecting to remote database...\n<unrecognised new format>\n", stderr: "" });
  const out = readHostedMigrationVersions(["20260428120000"], stubbed);
  assert.equal(out.ok, false, "a zero exit with unrecognized output must fail closed");
  assert.match(out.reason, /UNRECOGNIZED_OUTPUT/);
});

test("readHostedMigrationVersions: the real backtick format parses through the injected runner", () => {
  const stubbed = () => ({ status: 0, stdout: "  Local | Remote | Time\n----|----|----\n  `20260428120000` | `20260428120000` | x\n", stderr: "" });
  const out = readHostedMigrationVersions(["20260428120000"], stubbed);
  assert.equal(out.ok, true);
  assert.deepEqual(out.remoteVersions, ["20260428120000"]);
});

// ─── Object emptiness: an empty LEDGER is not an empty DATABASE ───────────
const EMPTY_COUNTS = { user_schemas: 0, user_relations: 0, public_rows: 0, user_functions: 0, user_types: 0, user_policies: 0, user_triggers: 0, user_event_triggers: 0, migration_rows: 0, auth_users: 0, storage_buckets: 0, storage_objects: 0 };

test("classifyObjectEmptiness: a genuinely new project is empty", () => {
  const v = classifyObjectEmptiness(EMPTY_COUNTS);
  assert.equal(v.empty, true);
  assert.deepEqual(v.nonEmpty, []);
});

test("classifyObjectEmptiness: an empty ledger with application state is NOT fresh, and names the category", () => {
  for (const key of ["user_relations", "public_rows", "user_functions", "user_types", "user_policies", "user_triggers", "user_event_triggers", "auth_users", "storage_buckets", "storage_objects", "user_schemas"]) {
    const v = classifyObjectEmptiness({ ...EMPTY_COUNTS, [key]: 3 });
    assert.equal(v.empty, false, `${key} must defeat a fresh-apply certification`);
    assert.equal(v.nonEmpty[0].category, key, "the refusal must name the non-empty category");
    assert.match(v.reason, /NOT application-empty/);
  }
});

test("classifyObjectEmptiness: normal Supabase platform state alone does not make a new project non-fresh", () => {
  // The probe counts only non-platform schemas, so a stock project reports all zeros.
  assert.equal(classifyObjectEmptiness(EMPTY_COUNTS).empty, true);
});

test("the emptiness probe SQL excludes platform schemas and never mutates", () => {
  const source = readFileSync(SCRIPT, "utf8");
  // Bounded on BOTH ends, and it slices the harness (a different file), so it cannot
  // match its own assertions. The predicate constant sits just above the probe function.
  const start = source.indexOf("const PLATFORM_SCHEMA_PREDICATE");
  const end = source.indexOf("// Reads the linked project's migration history");
  assert.ok(start > 0 && end > start, "the emptiness probe region could not be located");
  const fn = source.slice(start, end);
  for (const schema of ["auth", "storage", "realtime", "extensions", "graphql", "vault", "supabase_migrations"]) {
    assert.ok(fn.includes(`'${schema}'`), `the platform predicate does not exclude ${schema}`);
  }
  assert.doesNotMatch(fn, /\b(insert|update|delete|drop|truncate|alter)\b/i, "the emptiness probe is not read-only");
});

test("SUPERSEDED shape check: the rotated-ref control no longer spawns a child process", () => {
  const suite = readFileSync(new URL(import.meta.url), "utf8");
  const control = suite.slice(suite.indexOf('test("hosted mode REFUSES a matching-but-unallowlisted ref'));
  const body = control.slice(0, control.indexOf("\n});"));
  assert.doesNotMatch(body, /\brun\(/, "the offline control must not spawn the harness as a child process");
});



test("hosted mode precheck accepts the designated migration-validation ref (guard only, no apply)", () => {
  // Deliberately in-process: calling safetyGuard directly proves the precheck
  // verdict without ever reaching the destructive `supabase db push` path.
  const savedEnv = { ...process.env };
  const savedExitCode = process.exitCode;
  try {
    process.env.ALLOW_DESTRUCTIVE_FRESH_DB_TEST = "true";
    process.env.SUPABASE_DB_URL = `postgresql://postgres:pw@db.${HOSTED_ALLOWED_MIGRATION_VALIDATION_REF}.supabase.co:5432/postgres`;
    process.env.SUPABASE_ACCESS_TOKEN = "sbp_test_token_not_real";
    process.env.SUPABASE_PROJECT_REF = HOSTED_ALLOWED_MIGRATION_VALIDATION_REF;
    process.env.FRESH_DB_EXPECTED_PROJECT_REF = HOSTED_ALLOWED_MIGRATION_VALIDATION_REF;
    process.exitCode = undefined;
    assert.equal(determineMode(), "hosted");
    assert.equal(safetyGuard("hosted"), true);
    assert.equal(process.exitCode, undefined, "an accepted precheck must not set a failing exit code");
  } finally {
    process.env = savedEnv;
    process.exitCode = savedExitCode;
  }
});

test("the two hosted refs are distinct and neither is empty", () => {
  assert.equal(HOSTED_ALLOWED_MIGRATION_VALIDATION_REF, "ecwkldflddnmdwusatuh");
  assert.equal(HOSTED_DENIED_ACTIVE_PMFREAK_REF, "refvllnadfzjkxlpidrr");
  assert.notEqual(HOSTED_ALLOWED_MIGRATION_VALIDATION_REF, HOSTED_DENIED_ACTIVE_PMFREAK_REF);
});

// ─── Windows npx invocation (harness portability) ─────────────────────────
//
// Regression controls for a HARNESS DEFECT that killed the first real hosted
// attempt BEFORE `supabase link`, leaving the hosted database untouched:
//
//   spawnSync("npx", ["--version"])
//     -> status=null, error.code=ENOENT, error.message="spawnSync npx ENOENT"
//
// On Windows `npx` is `npx.cmd`, a batch script rather than an executable
// image, so CreateProcess cannot launch it. The fix must stay narrow: no
// global `shell: true`, and no change to how `psql` is executed.
//
// NOTE: none of the controls below execute a hosted Supabase command. The only
// npx invocation here is `npx --version`, which is purely local.

test("NPX_VERSION_CONTROL: the portable npx invocation launches and exits 0 on this host", () => {
  const result = runNpx(["--version"]);
  assert.equal(
    result.error,
    undefined,
    `npx failed to launch: code=${result.error?.code} message=${result.error?.message}`,
  );
  assert.equal(result.status, 0, `npx --version exited ${result.status}: ${result.stderr}`);
  assert.match((result.stdout ?? "").trim(), /^\d+\.\d+\.\d+/, "npx must report a version");
});

test("runNpx executes npx directly on POSIX and routes through ComSpec on Windows", () => {
  const source = readFileSync(SCRIPT, "utf8");
  // POSIX: unchanged, direct execution.
  assert.match(source, /if \(process\.platform !== "win32"\) return sh\("npx", args, opts\);/);
  // Windows: the interpreter, taken from ComSpec, with /d /s /c.
  assert.match(source, /process\.env\.ComSpec \|\| "cmd\.exe"/);
  assert.match(source, /\["\/d", "\/s", "\/c", "npx", \.\.\.args\]/);
});

test("the fix stays narrow: no global shell:true, and psql execution is untouched", () => {
  const source = readFileSync(SCRIPT, "utf8");
  // Comment lines are excluded: the harness documents *why* it refuses
  // `shell: true`, and that prose must not trip the control.
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  // `shell: true` would re-parse every argument of every command through a
  // shell — including the psql invocations that carry a DB URL.
  assert.doesNotMatch(code, /shell:\s*true/);
  // psql still goes through the shared helper, unchanged, as a direct exec.
  assert.ok(source.includes('sh("psql", ["-v", "ON_ERROR_STOP=1", dbUrl, "-f", full])'));
  assert.ok(source.includes('sh("psql", ["-v", "ON_ERROR_STOP=1", dbUrl, "-f", ROLES_FILE])'));
  assert.match(source, /sh\("psql", \["-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", ",", dbUrl, "-c", query\]\)/);
  // psql must never be routed through runNpx.
  assert.doesNotMatch(source, /runNpx\(\[\s*"psql"/);
});

test("runNpx refuses arguments carrying cmd.exe metacharacters", { skip: process.platform !== "win32" }, () => {
  const result = runNpx(["-y", "supabase", "link", "--project-ref", "abc & calc.exe"]);
  assert.equal(result.status, null);
  assert.equal(result.error?.code, "ERR_UNSAFE_NPX_ARGUMENT");
});

// ─── Child-process error visibility ───────────────────────────────────────
//
// The launch failure above surfaced as an empty line, because the harness
// printed `result.stderr` (undefined on a spawn failure) and nothing else.
// A failure must now always name its kind and can never render empty.

test("describeSpawnResult distinguishes PROCESS_SPAWN_FAILURE from COMMAND_EXIT_NONZERO", () => {
  const enoent = describeSpawnResult(
    {
      status: null,
      stdout: undefined,
      stderr: undefined,
      error: Object.assign(new Error("spawnSync npx ENOENT"), { code: "ENOENT" }),
    },
    "npx supabase link",
  );
  assert.equal(enoent.kind, "PROCESS_SPAWN_FAILURE");
  assert.equal(enoent.status, null);
  assert.equal(enoent.spawnErrorCode, "ENOENT");
  assert.match(enoent.spawnErrorMessage, /spawnSync npx ENOENT/);

  const nonzero = describeSpawnResult({ status: 1, stdout: "", stderr: "supabase: link failed" }, "npx supabase db push");
  assert.equal(nonzero.kind, "COMMAND_EXIT_NONZERO");
  assert.equal(nonzero.status, 1);
  assert.equal(nonzero.spawnErrorCode, null);
  assert.equal(nonzero.spawnErrorMessage, null);
  assert.equal(nonzero.stderr, "supabase: link failed");
});

test("a spawn failure can never render an empty diagnostic again", () => {
  const rendered = formatFailure(
    describeSpawnResult(
      { status: null, stderr: undefined, error: Object.assign(new Error("spawnSync npx ENOENT"), { code: "ENOENT" }) },
      "npx supabase link",
    ),
  );
  assert.match(rendered, /FAILURE_KIND=PROCESS_SPAWN_FAILURE/);
  assert.match(rendered, /COMMAND=npx supabase link/);
  assert.match(rendered, /EXIT_STATUS=null/);
  assert.match(rendered, /SPAWN_ERROR_CODE=ENOENT/);
  assert.match(rendered, /SPAWN_ERROR_MESSAGE=spawnSync npx ENOENT/);
  // The exact shape of the original silent failure: stderr was undefined.
  assert.match(rendered, /STDERR=\(empty\)/);
  assert.ok(rendered.trim().length > 0);

  // A non-zero exit must NOT be dressed up as a spawn failure.
  const exited = formatFailure(describeSpawnResult({ status: 2, stderr: "boom" }, "npx supabase db push"));
  assert.match(exited, /FAILURE_KIND=COMMAND_EXIT_NONZERO/);
  assert.doesNotMatch(exited, /SPAWN_ERROR_CODE=/);
  assert.doesNotMatch(exited, /SPAWN_ERROR_MESSAGE=/);
});

test("failure diagnostics never print the access token, DB URL or database password", () => {
  const token = "sbp_test_token_not_real_0123456789";
  const password = "sup3rs3cretpassword";
  const dbUrl = `postgresql://postgres:${password}@db.example.supabase.co:5432/postgres`;
  const saved = {
    token: process.env.SUPABASE_ACCESS_TOKEN,
    url: process.env.SUPABASE_DB_URL,
    pw: process.env.SUPABASE_DB_PASSWORD,
  };
  process.env.SUPABASE_ACCESS_TOKEN = token;
  process.env.SUPABASE_DB_URL = dbUrl;
  process.env.SUPABASE_DB_PASSWORD = password;
  try {
    const rendered = formatFailure(
      describeSpawnResult(
        { status: 1, stderr: `authentication failed using ${token} against ${dbUrl} (password ${password})` },
        "npx supabase link",
      ),
    );
    assert.doesNotMatch(rendered, new RegExp(token));
    assert.doesNotMatch(rendered, new RegExp(password));
    assert.doesNotMatch(rendered, /db\.example\.supabase\.co:5432/);
    assert.match(rendered, /\[redacted\]/);

    // The scrubber must also catch credentials it was never handed via env.
    const foreign = scrubSecrets("postgresql://someuser:someotherpw@db.other.supabase.co:5432/postgres");
    assert.doesNotMatch(foreign, /someotherpw/);
    assert.match(foreign, /postgresql:\/\/\[redacted\]@/);
  } finally {
    for (const [key, value] of [
      ["SUPABASE_ACCESS_TOKEN", saved.token],
      ["SUPABASE_DB_URL", saved.url],
      ["SUPABASE_DB_PASSWORD", saved.pw],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("main() reports failures through the structured formatter, not a bare stderr line", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /console\.error\(formatFailure\(applyResult\.failure\)\);/);
  assert.match(source, /console\.error\(formatFailure\(smoke\.failure\)\);/);
  assert.match(source, /if \(repeatability\.failure\) console\.error\(formatFailure\(repeatability\.failure\)\);/);
  // The old shape printed `result.stderr` directly, which is undefined on a
  // spawn failure and rendered as a blank line.
  assert.doesNotMatch(source, /console\.error\(`  \$\{\(applyResult\.stderr \?\? ""\)/);
});

test("these regression controls execute no hosted Supabase command", () => {
  // Assertion lines are excluded: the source-pinning controls above quote the
  // harness's own hosted command lines as string literals without running them.
  const rawTestSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const testSource = rawTestSource
    .split("\n")
    .filter((line) => !line.includes("assert."))
    .join("\n");
  const invocations = [...testSource.matchAll(/runNpx\(\[([^\]]*)\]/g)].map((m) => m[1].trim());
  const distinct = [...new Set(invocations)];
  assert.deepEqual(
    distinct,
    ['"--version"', '"-y", "supabase", "link", "--project-ref", "abc & calc.exe"'],
    `unexpected npx invocation in the regression controls: ${JSON.stringify(distinct)}`,
  );
  // The one supabase-shaped invocation above is the metacharacter refusal
  // control: it is rejected before launch and never reaches the network.
  assert.match(rawTestSource, /ERR_UNSAFE_NPX_ARGUMENT/);
});

// ─── Hosted target classification (fresh vs repeatability vs fail) ────────
// The originally designated validation project now holds the full chain. Re-running
// against it would apply a FUTURE migration as a delta and still report "fresh apply",
// so emptiness — not project identity — is what a fresh-apply certification rests on.
const LOCAL_CHAIN = ["20260428120000", "20260501000000", "20260601000000"];

test("classifyHostedTarget: 1. an EMPTY hosted history may enter fresh-apply mode", () => {
  const c = classifyHostedTarget([], LOCAL_CHAIN);
  assert.equal(c.mode, "fresh");
  assert.equal(c.preApplyRemoteMigrationCount, 0, "fresh apply requires PRE_APPLY_REMOTE_MIGRATION_COUNT=0");
  assert.deepEqual(c.unexpected, []);
});

test("classifyHostedTarget: 2. a COMPLETE existing history is repeatability, never fresh", () => {
  const c = classifyHostedTarget([...LOCAL_CHAIN], LOCAL_CHAIN);
  assert.equal(c.mode, "repeatability", "a fully-migrated target must not be classified as a fresh apply");
  assert.notEqual(c.mode, "fresh");
  assert.equal(c.preApplyRemoteMigrationCount, LOCAL_CHAIN.length);
  // Order must not matter: the CLI does not guarantee sorted output.
  assert.equal(classifyHostedTarget([...LOCAL_CHAIN].reverse(), LOCAL_CHAIN).mode, "repeatability");
});

test("classifyHostedTarget: 3. a PARTIAL existing history cannot be certified as fresh", () => {
  const c = classifyHostedTarget(LOCAL_CHAIN.slice(0, 2), LOCAL_CHAIN);
  assert.equal(c.mode, "fail", "applying only the delta must never be reported as a fresh apply");
  assert.deepEqual(c.missing, ["20260601000000"]);
  assert.match(c.reason, /would NOT be a fresh apply/i);
});

test("classifyHostedTarget: 4. UNEXPECTED remote migrations fail outright", () => {
  const c = classifyHostedTarget([...LOCAL_CHAIN, "20260701000000"], LOCAL_CHAIN);
  assert.equal(c.mode, "fail");
  assert.deepEqual(c.unexpected, ["20260701000000"]);
  // Drift must fail even when every local migration is also present.
  assert.equal(classifyHostedTarget(["20260428120000", "29990101000000"], LOCAL_CHAIN).mode, "fail");
});

test("classifyHostedTarget: the once-designated validation project is no longer fresh-appliable", () => {
  // 161/161 applied: exactly the state that made the old single-ref pin unsafe.
  const chain = Array.from({ length: 161 }, (_, i) => String(20260428120000 + i));
  const c = classifyHostedTarget(chain, chain);
  assert.equal(c.mode, "repeatability");
  assert.notEqual(c.mode, "fresh");
});

test("classifyHostedTarget: rotation — a brand-new empty project is fresh-appliable", () => {
  assert.equal(classifyHostedTarget([], LOCAL_CHAIN).mode, "fresh");
});

// ─── 5-8: the pre-existing safety properties must all survive rotation ────
test("5. expected-ref mismatch still fails after the rotation change", () => {
  const r = run({
    PATH: process.env.PATH,
    SUPABASE_DB_URL: "postgresql://user:pass@db.abcxyz.supabase.co:5432/postgres",
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_not_real",
    ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
    SUPABASE_PROJECT_REF: "aaaaaaaaaaaaaaaaaaaa",
    FRESH_DB_EXPECTED_PROJECT_REF: "bbbbbbbbbbbbbbbbbbbb",
  });
  assert.match(r.stdout + r.stderr, /does not match/i, "a ref-handshake mismatch must still refuse");
});

test("6. the ACTIVE PMFreak project is still rejected, even with a matching handshake", () => {
  const r = run({
    PATH: process.env.PATH,
    SUPABASE_DB_URL: "postgresql://user:pass@db.abcxyz.supabase.co:5432/postgres",
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_not_real",
    ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
    SUPABASE_PROJECT_REF: HOSTED_DENIED_ACTIVE_PMFREAK_REF,
    FRESH_DB_EXPECTED_PROJECT_REF: HOSTED_DENIED_ACTIVE_PMFREAK_REF,
  });
  assert.match(r.stdout + r.stderr, /ACTIVE PMFreak project/i, "rotation must not open a path to the live project");
});

test("7. destructive confirmation is still required after the rotation change", () => {
  const r = run({
    PATH: process.env.PATH,
    SUPABASE_DB_URL: "postgresql://user:pass@db.abcxyz.supabase.co:5432/postgres",
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_not_real",
    SUPABASE_PROJECT_REF: HOSTED_ALLOWED_MIGRATION_VALIDATION_REF,
    FRESH_DB_EXPECTED_PROJECT_REF: HOSTED_ALLOWED_MIGRATION_VALIDATION_REF,
    // ALLOW_DESTRUCTIVE_FRESH_DB_TEST deliberately unset
  });
  assert.match(r.stdout + r.stderr, /ALLOW_DESTRUCTIVE_FRESH_DB_TEST/, "the destructive confirmation gate must still apply");
});

test("8. secret redaction is preserved across the rotation change", () => {
  const r = run({
    PATH: process.env.PATH,
    SUPABASE_DB_URL: "postgresql://user:pass@db.abcxyz.supabase.co:5432/postgres",
    SUPABASE_ACCESS_TOKEN: "sbp_test_token_not_real",
    ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
    SUPABASE_PROJECT_REF: "cccccccccccccccccccc",
    FRESH_DB_EXPECTED_PROJECT_REF: "dddddddddddddddddddd",
  });
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /sbp_test_token_not_real/, "the access token leaked into harness output");
  assert.doesNotMatch(out, /user:pass@/, "the database URL credentials leaked into harness output");
});

test("a rotated (non-designated) ref is no longer hard-refused by identity alone", () => {
  // Rotation is the point of the change: identity is not the gate, emptiness is.
  const source = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(source, /is not the designated disposable/, "the single-ref pin still hard-refuses rotation");
  assert.match(source, /PRE_APPLY_REMOTE_MIGRATION_COUNT/, "the emptiness precondition is not reported");
  // The destructive push must be reachable only after classification.
  const applyHostedSrc = source.slice(source.indexOf("function applyHosted"));
  const classifyAt = applyHostedSrc.indexOf("classifyHostedTarget(");
  const pushAt = applyHostedSrc.indexOf('"db", "push"');
  assert.ok(classifyAt > 0 && pushAt > 0 && classifyAt < pushAt, "the destructive push is not gated behind classification");
});

// ─── DB_URL <-> PROJECT_REF binding (offline; no network) ─────────────────
const REF = HOSTED_ALLOWED_MIGRATION_VALIDATION_REF;

test("binding: a matching DIRECT db.<ref>.supabase.co URL is positively identified", () => {
  const r = verifyHostedTargetBinding(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`, REF);
  assert.equal(r.ok, true);
  assert.equal(r.identified, true);
  assert.equal(r.form, "direct");
});

test("binding: a MISMATCHED direct URL is refused even though both ref variables agree", () => {
  const r = verifyHostedTargetBinding("postgresql://postgres:pw@db.aaaaaaaaaaaaaaaaaaaa.supabase.co:5432/postgres", REF);
  assert.equal(r.ok, false);
  assert.equal(r.identified, true, "the ref was extractable; it simply names a different project");
  assert.match(r.reason, /does not match SUPABASE_PROJECT_REF/);
});

test("binding: a matching POOLER URL (postgres.<ref> username) is identified", () => {
  const r = verifyHostedTargetBinding(`postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`, REF);
  assert.equal(r.ok, true);
  assert.equal(r.form, "pooler");
});

test("binding: a MISMATCHED pooler URL is refused", () => {
  const r = verifyHostedTargetBinding("postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres", REF);
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not match/);
});

test("binding: an AMBIGUOUS/unrecognized Supabase URL fails closed rather than guessing", () => {
  for (const url of [
    `postgresql://postgres:pw@${REF}.supabase.co:5432/postgres`,          // ref present but not the direct db.<ref> form
    `postgresql://postgres:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`, // pooler without postgres.<ref>
    `postgresql://postgres:pw@my-${REF}-proxy.example.com:5432/postgres`, // ref as an arbitrary substring
    "postgresql://postgres:pw@db.internal:5432/postgres",
    "not-a-url",
  ]) {
    const r = verifyHostedTargetBinding(url, REF);
    assert.equal(r.ok, false, `refusing to guess: ${url}`);
    assert.equal(r.identified, false, "an unrecognized form must not report a positively identified ref");
  }
});

test("binding: ending in a Supabase domain is never sufficient on its own", () => {
  assert.equal(extractSupabaseProjectRefFromDbUrl("postgresql://postgres:pw@something.supabase.com:5432/postgres").ok, false);
  assert.equal(extractSupabaseProjectRefFromDbUrl("https://db.abc.supabase.co").ok, false, "a non-postgres protocol must be refused");
});

test("binding: the ACTIVE project is still denied by the guard regardless of a well-formed URL", () => {
  const saved = { ...process.env };
  const savedExit = process.exitCode;
  try {
    Object.assign(process.env, {
      ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
      SUPABASE_DB_URL: `postgresql://postgres:pw@db.${HOSTED_DENIED_ACTIVE_PMFREAK_REF}.supabase.co:5432/postgres`,
      SUPABASE_PROJECT_REF: HOSTED_DENIED_ACTIVE_PMFREAK_REF,
      FRESH_DB_EXPECTED_PROJECT_REF: HOSTED_DENIED_ACTIVE_PMFREAK_REF,
    });
    assert.equal(safetyGuard("hosted"), false, "a perfectly-bound URL must not unlock the ACTIVE project");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    process.exitCode = savedExit;
  }
});

test("binding: an allowlisted ref paired with an UNRELATED database URL is denied", () => {
  const r = verifyHostedTargetBinding("postgresql://postgres:pw@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres", REF);
  assert.equal(r.ok, false, "an allowlisted ref must not authorise a probe against a different database");
});

// ─── All user-defined object classes defeat FRESH ─────────────────────────
test("emptiness: view / materialised view / sequence / foreign table / function / type only are all NOT pristine", () => {
  // They arrive through the relation and proc/type counters respectively.
  for (const key of ["user_relations", "user_functions", "user_types"]) {
    const v = classifyObjectEmptiness({ ...EMPTY_COUNTS, [key]: 1 });
    assert.equal(v.empty, false, `${key} must defeat a fresh-apply certification`);
    assert.equal(v.nonEmpty[0].category, key);
  }
});

test("emptiness: the probe counts every material relkind and both proc and type objects", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const start = source.indexOf("const PLATFORM_SCHEMA_PREDICATE");
  const fn = source.slice(start, source.indexOf("// Reads the linked project's migration history"));
  // Indexes ('i','I') are counted too: a custom index on a stock managed relation is
  // operator-created DDL that no other counter sees.
  assert.match(fn, /relkind in \('r','p','v','m','S','f','i','I'\)/, "the probe omits a material relation kind");
  assert.match(fn, /pg_proc/, "the probe does not count user functions/procedures");
  assert.match(fn, /pg_type/, "the probe does not count user-defined types");
  // Range and multirange types are user-definable and were previously uncounted.
  assert.match(fn, /typtype in \('c','d','e','r','m'\)/, "the probe omits range/multirange types");
  // Managed schemas are inventoried rather than excluded wholesale.
  assert.match(fn, /managed-schema ownership probe|MANAGED/, "managed schemas are not inventoried");
  assert.match(fn, /pg_extension/, "installed extensions are not inventoried");
  assert.match(fn, /query_to_xml/, "rows in stock managed tables are not counted");
  // Extension-owned objects excluded via dependency metadata, not a hand-maintained list.
  assert.match(fn, /pg_depend/, "extension-owned objects are not excluded via pg_depend");
  assert.match(fn, /deptype = 'e'/, "the extension-ownership predicate is missing");
  assert.doesNotMatch(fn, /\b(insert|update|delete|drop|truncate|alter)\b/i, "the emptiness probe is not read-only");
});

test("emptiness: platform/extension-only state keeps a genuinely new project FRESH-eligible", () => {
  assert.equal(classifyObjectEmptiness(EMPTY_COUNTS).empty, true);
});

// ─── The unrecognized-output reason survives the whole result path ────────
test("the UNRECOGNIZED_OUTPUT reason survives from the parser out to the harness result", () => {
  const savedEnv = { ...process.env };
  const savedExit = process.exitCode;
  try {
    Object.assign(process.env, {
      SUPABASE_PROJECT_REF: REF,
      FRESH_DB_EXPECTED_PROJECT_REF: REF,
      SUPABASE_DB_URL: `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
      SUPABASE_ACCESS_TOKEN: "sbp_test_token_not_real",
    });
    // Injected runner: `link` succeeds, `migration list` returns unrecognizable output.
    const runner = (args) => args.includes("link")
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 0, stdout: "Connecting to remote database...\n<new unrecognised format>\n", stderr: "" };
    const result = applyHosted(["20260428120000_a.sql"], runner);
    assert.equal(result.ok, false, "unrecognized output must not be treated as an empty target");
    assert.match(String(result.reason), /HOSTED_MIGRATION_LIST_FAILURE=UNRECOGNIZED_OUTPUT/,
      "the actionable reason was lost between the parser and the harness result");
    assert.doesNotMatch(String(result.reason), /sbp_test_token_not_real/, "the reason leaked a secret");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    process.exitCode = savedExit;
  }
});

// ─── Policies and the STRICT stock trigger baseline (offline) ─────────────
// Measured on a genuinely stock isolated Supabase project: ZERO non-extension-owned
// policies, and exactly FOUR non-internal, non-extension-owned platform triggers.
const stock = () => STOCK_PLATFORM_TRIGGER_BASELINE.map((b) => ({ ...b, is_internal: false, extension_owned: false }));

test("policy: a custom policy anywhere — including on storage.objects — blocks FRESH", () => {
  for (const key of ["user_policies"]) {
    const v = classifyObjectEmptiness({ ...EMPTY_COUNTS, [key]: 1 });
    assert.equal(v.empty, false, "a custom RLS policy must defeat a fresh-apply certification");
    assert.equal(v.nonEmpty[0].category, "user_policies");
    // The category text must not pretend managed schemas are exempt.
    assert.match(v.nonEmpty[0].description, /storage\.objects/, "the policy category does not state that managed relations count");
  }
});

test("trigger baseline: the exact four measured stock fingerprints do NOT make a target non-fresh", () => {
  const r = classifyObservedTriggers(stock());
  assert.equal(r.nonStockCount, 0, "the certified stock baseline must not defeat fresh classification");
  assert.equal(classifyObjectEmptiness({ ...EMPTY_COUNTS, user_triggers: r.nonStockCount }).empty, true);
});

test("trigger baseline: an ARBITRARY extra trigger is NON_EMPTY", () => {
  const r = classifyObservedTriggers([...stock(), {
    relation_schema: "public", relation_name: "projects", trigger_name: "audit_projects",
    function_schema: "public", function_name: "audit_fn", function_owner: "postgres",
    definition: "CREATE TRIGGER audit_projects AFTER INSERT ON public.projects FOR EACH ROW EXECUTE FUNCTION public.audit_fn()",
    is_internal: false, extension_owned: false,
  }]);
  assert.equal(r.nonStockCount, 1);
  assert.equal(classifyObjectEmptiness({ ...EMPTY_COUNTS, user_triggers: r.nonStockCount }).empty, false);
});

test("trigger baseline: a custom trigger INVOKING A PLATFORM-OWNED FUNCTION is still NON_EMPTY", () => {
  // Function ownership alone must never launder provenance: a user can point their own
  // trigger at storage.protect_delete, owned by supabase_storage_admin.
  const r = classifyObservedTriggers([...stock(), {
    relation_schema: "storage", relation_name: "objects", trigger_name: "sneaky_user_trigger",
    function_schema: "storage", function_name: "protect_delete", function_owner: "supabase_storage_admin",
    definition: "CREATE TRIGGER sneaky_user_trigger BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete()",
    is_internal: false, extension_owned: false,
  }]);
  assert.equal(r.nonStockCount, 1, "a platform-owned trigger FUNCTION must not make a user trigger stock");
  assert.match(r.nonStock[0], /sneaky_user_trigger/);
});

test("trigger baseline: a stock NAME with a changed DEFINITION is NON_EMPTY", () => {
  const tampered = stock();
  tampered[3] = { ...tampered[3], definition: tampered[3].definition.replace("BEFORE UPDATE", "AFTER UPDATE") };
  assert.equal(classifyObservedTriggers(tampered).nonStockCount, 1, "a redefined stock trigger must not pass as stock");
});

test("trigger baseline: a stock NAME pointing at a DIFFERENT FUNCTION is NON_EMPTY", () => {
  const tampered = stock();
  tampered[2] = { ...tampered[2], function_name: "exfiltrate", function_schema: "public", function_owner: "postgres" };
  assert.equal(classifyObservedTriggers(tampered).nonStockCount, 1);
});

test("trigger baseline: a stock NAME on a DIFFERENT TARGET relation is NON_EMPTY", () => {
  const tampered = stock();
  tampered[1] = { ...tampered[1], relation_schema: "public", relation_name: "workspaces" };
  assert.equal(classifyObservedTriggers(tampered).nonStockCount, 1);
});

test("trigger baseline: a DUPLICATED stock fingerprint counts as an extra", () => {
  assert.equal(classifyObservedTriggers([...stock(), stock()[0]]).nonStockCount, 1, "each baseline entry is consumed once");
});

test("trigger baseline: internal and positively extension-owned triggers are ignored", () => {
  const r = classifyObservedTriggers([
    ...stock(),
    { relation_schema: "public", relation_name: "t", trigger_name: "RI_ConstraintTrigger", function_schema: "pg_catalog", function_name: "RI_FKey_check_ins", function_owner: "postgres", definition: "internal", is_internal: true, extension_owned: false },
    { relation_schema: "cron", relation_name: "job", trigger_name: "ext_trigger", function_schema: "cron", function_name: "fn", function_owner: "postgres", definition: "CREATE TRIGGER ext_trigger ...", is_internal: false, extension_owned: true },
  ]);
  assert.equal(r.nonStockCount, 0, "internal and extension-owned triggers are not application customizations");
});

test("trigger baseline: an UNKNOWN trigger under a managed schema fails closed", () => {
  const r = classifyObservedTriggers([...stock(), {
    relation_schema: "auth", relation_name: "users", trigger_name: "on_auth_user_created",
    function_schema: "public", function_name: "handle_new_user", function_owner: "postgres",
    definition: "CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user()",
    is_internal: false, extension_owned: false,
  }]);
  assert.equal(r.nonStockCount, 1, "a managed-schema attachment must not exempt a user trigger");
});

test("trigger baseline: it is versioned SOURCE, never learned from the target under test", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.equal(STOCK_PLATFORM_TRIGGER_BASELINE.length, 4, "the certified baseline is the four measured stock triggers");
  assert.ok(Object.isFrozen(STOCK_PLATFORM_TRIGGER_BASELINE), "the baseline must be immutable");
  for (const b of STOCK_PLATFORM_TRIGGER_BASELINE) {
    for (const field of ["relation_schema", "relation_name", "trigger_name", "function_schema", "function_name", "function_owner", "definition"]) {
      assert.ok(b[field], `baseline entry is missing the ${field} fingerprint field`);
    }
  }
  // Never derived from the inspected database: declared exactly once as a frozen const,
  // and never appended to or reassigned. (The const declaration itself is the one
  // legitimate assignment, so it is matched explicitly rather than banned.)
  const declarations = source.match(/const STOCK_PLATFORM_TRIGGER_BASELINE = Object\.freeze\(/g) ?? [];
  assert.equal(declarations.length, 1, "the baseline must be declared exactly once as a frozen constant");
  assert.doesNotMatch(source, /STOCK_PLATFORM_TRIGGER_BASELINE\s*\.\s*(push|splice|unshift|pop)/, "the baseline must not be mutated at runtime");
  // Count assignments rather than using a lookahead: `\s*` backtracks to zero-width and
  // makes a negative lookahead match the declaration itself.
  const assignments = source.match(/STOCK_PLATFORM_TRIGGER_BASELINE\s*=[^=]/g) ?? [];
  assert.equal(assignments.length, 1, "the baseline is assigned more than once, so it can be replaced at runtime");
});

test("the trigger-fingerprint probe fails closed on an unrecognized row", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /unrecognized row/, "the trigger probe does not fail closed on malformed output");
  assert.match(source, /trigger-fingerprint probe/, "the trigger probe failure is not attributable");
});

// ─── Baseline drift in BOTH directions ────────────────────────────────────
test("trigger baseline: ZERO observed triggers is DRIFT, not emptiness", () => {
  // The original classifier reported nonStockCount 0 here, so a wiped or partially
  // initialised project read as pristine and could reach the destructive push.
  const r = classifyObservedTriggers([]);
  assert.equal(r.missingStockCount, 4, "every certified stock trigger must be reported missing");
  assert.equal(r.baselineSatisfied, false);
  assert.equal(classifyObjectEmptiness({ ...EMPTY_COUNTS, user_triggers: r.nonStockCount + r.missingStockCount }).empty, false);
});

test("trigger baseline: THREE of four stock triggers is DRIFT", () => {
  const r = classifyObservedTriggers(stock().slice(0, 3));
  assert.equal(r.missingStockCount, 1);
  assert.equal(r.baselineSatisfied, false);
  assert.equal(classifyObjectEmptiness({ ...EMPTY_COUNTS, user_triggers: r.nonStockCount + r.missingStockCount }).empty, false);
});

test("trigger baseline: the exact four in ANY ORDER satisfy the baseline", () => {
  const shuffled = [stock()[2], stock()[0], stock()[3], stock()[1]];
  const r = classifyObservedTriggers(shuffled);
  assert.equal(r.baselineSatisfied, true, "ordering alone must not be treated as drift");
  assert.equal(r.nonStockCount + r.missingStockCount, 0);
});

test("trigger baseline: an ALTERED stock trigger is both an extra AND a missing entry", () => {
  const tampered = stock();
  tampered[0] = { ...tampered[0], definition: tampered[0].definition.replace("BEFORE INSERT", "AFTER INSERT") };
  const r = classifyObservedTriggers(tampered);
  assert.equal(r.nonStockCount, 1);
  assert.equal(r.missingStockCount, 1, "the certified entry it impersonates is still absent");
  assert.equal(r.baselineSatisfied, false);
});

// ─── Event triggers (pg_event_trigger) ────────────────────────────────────
test("event triggers: none observed raises no objection", () => {
  assert.equal(classifyObjectEmptiness({ ...EMPTY_COUNTS, user_event_triggers: 0 }).empty, true);
});

test("event triggers: a single user event trigger refuses FRESH", () => {
  const v = classifyObjectEmptiness({ ...EMPTY_COUNTS, user_event_triggers: 1 });
  assert.equal(v.empty, false);
  assert.equal(v.nonEmpty[0].category, "user_event_triggers");
  assert.match(v.nonEmpty[0].description, /event triggers/i);
});

test("event triggers: the probe is read-only, database-level, and exempts ONLY proven extension ownership", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const region = source.slice(source.indexOf("const PLATFORM_SCHEMA_PREDICATE"), source.indexOf("// Reads the linked project's migration history"));
  assert.match(region, /pg_event_trigger/, "event triggers are not probed at all");
  // No schema exemption may apply: event triggers are database-level, so a function in
  // storage/auth must NOT launder them, and a platform-owned FUNCTION is not provenance.
  const evtRegion = region.slice(region.indexOf("const eventQuery"));
  assert.doesNotMatch(evtRegion, /nspname NOT IN|PLATFORM_SCHEMA_PREDICATE/, "the event-trigger probe must not carry a schema exemption");
  assert.match(evtRegion, /classid = 'pg_event_trigger'::regclass[\s\S]{0,120}deptype = 'e'/, "extension ownership must be proven via pg_depend on the event trigger itself");
  assert.match(evtRegion, /unrecognized row/, "the event-trigger probe must fail closed on malformed output");
  assert.match(evtRegion, /event-trigger probe/, "an event-trigger probe failure must be attributable");
  assert.doesNotMatch(evtRegion, /\b(insert|update|delete|drop|truncate|alter)\b/i, "the event-trigger probe is not read-only");
});

test("fresh composition: every objection category independently refuses FRESH", () => {
  for (const key of Object.keys(EMPTY_COUNTS)) {
    assert.equal(classifyObjectEmptiness({ ...EMPTY_COUNTS, [key]: 1 }).empty, false, `${key} must be able to refuse a fresh apply`);
  }
});

// ─── F4: custom objects inside MANAGED schemas must not evade emptiness ────
//
// The defect: the inventory excluded every managed schema from the relation, function
// and type counters, so a project holding only a user-created `storage.*` or `auth.*`
// object reported zero and was certified application-empty before a destructive push.
// The replacement decides per object, on positive ownership evidence.

const stockObject = (schema, kind, name) => {
  const entry = STOCK_MANAGED_OBJECT_BASELINE.find((b) => b.schema === schema && b.kind === kind && b.name === name);
  assert.ok(entry, `${schema}.${name} (${kind}) is not in the certified baseline; the fixture is stale`);
  return { ...entry };
};
/** The whole certified baseline, which by definition must classify as fully stock. */
const wholeBaseline = () => STOCK_MANAGED_OBJECT_BASELINE.map((b) => ({ ...b }));

test("classifyManagedSchemaObjects: the certified baseline itself is exactly stock", () => {
  const verdict = classifyManagedSchemaObjects(wholeBaseline());
  assert.equal(verdict.nonStockCount, 0, `stock objects were flagged: ${verdict.nonStock.slice(0, 5).join(", ")}`);
  assert.equal(verdict.missingStockCount, 0, `baseline objects were reported missing: ${verdict.missingStock.slice(0, 5).join(", ")}`);
  assert.equal(verdict.baselineSatisfied, true, "the baseline does not satisfy itself");
});

test("classifyManagedSchemaObjects: a MISSING certified object is drift, not emptiness", () => {
  // Both directions, exactly as the trigger baseline: a target lacking platform objects
  // is not pristine either, and an extras-only check would have passed it.
  const short = wholeBaseline().slice(1);
  const verdict = classifyManagedSchemaObjects(short);
  assert.equal(verdict.missingStockCount, 1, "a missing certified platform object was not reported");
  assert.equal(verdict.baselineSatisfied, false, "a target missing platform objects satisfied the baseline");
});

test("classifyManagedSchemaObjects: OWNERSHIP ALONE no longer excuses anything", () => {
  // The correction Codex found: pg_class.relowner is the CURRENT owner, not the creator,
  // and an operator with an administrative connection can reassign it. A custom object
  // re-owned to the platform service role must still be counted.
  for (const [schema, owner] of [["storage", "supabase_storage_admin"], ["auth", "supabase_auth_admin"], ["realtime", "supabase_realtime_admin"]]) {
    const verdict = classifyManagedSchemaObjects([{ schema, kind: "relation", name: "custom_table", owner }]);
    assert.equal(verdict.nonStockCount, 1, `${schema}.custom_table re-owned to ${owner} was accepted as stock`);
  }
});

test("classifyManagedSchemaObjects: a CUSTOM object in a managed schema is counted, whoever owns it", () => {
  for (const owner of ["postgres", "supabase_storage_admin", "some_operator"]) {
    assert.equal(
      classifyManagedSchemaObjects([...wholeBaseline(), { schema: "storage", kind: "relation", name: "custom_table", owner, definition: "relkind=r|parent=|bound=|cols=id:uuid:NN:" }]).nonStockCount,
      1,
      `a custom storage table owned by ${owner} evaded the inventory`,
    );
  }
});

test("classifyManagedSchemaObjects: custom managed view, function, type, RANGE type and INDEX are all counted", () => {
  const injections = [
    { schema: "storage", kind: "relation", name: "custom_view", owner: "supabase_storage_admin" },
    { schema: "auth", kind: "function", name: "custom_function", owner: "supabase_auth_admin" },
    { schema: "cron", kind: "type", name: "custom_type", owner: "postgres" },
    { schema: "storage", kind: "type", name: "custom_range", owner: "supabase_storage_admin" },
    { schema: "storage", kind: "index", name: "custom_objects_idx", owner: "supabase_storage_admin" },
  ];
  for (const injected of injections) {
    const verdict = classifyManagedSchemaObjects([...wholeBaseline(), injected]);
    assert.equal(verdict.nonStockCount, 1, `${injected.schema}.${injected.name} (${injected.kind}) evaded the inventory`);
  }
});

test("classifyManagedSchemaObjects: a stock NAME under a different owner or kind is not that object", () => {
  const real = stockObject("storage", "relation", "objects");
  assert.equal(classifyManagedSchemaObjects([{ ...real, owner: "postgres" }]).nonStockCount, 1, "a re-owned stock name was excused");
  assert.equal(classifyManagedSchemaObjects([{ ...real, kind: "function" }]).nonStockCount, 1, "a stock name under a different kind was excused");
});

test("classifyManagedSchemaObjects: a DUPLICATED stock fingerprint is still an extra", () => {
  const real = stockObject("storage", "relation", "objects");
  const verdict = classifyManagedSchemaObjects([...wholeBaseline(), { ...real }]);
  assert.equal(verdict.nonStockCount, 1, "a duplicated stock object was consumed twice");
});

const partitionObject = (name, kind = "relation", overrides = {}) => {
  const base = { schema: "realtime", kind, name, owner: "supabase_realtime_admin" };
  return { ...base, definition: realtimePartitionDefinition(base), ...overrides };
};

test("realtime daily partition: a GENUINE certified partition is accepted", () => {
  assert.equal(isRealtimeDailyPartition(partitionObject("messages_2027_01_01")), true, "a genuine daily partition was refused");
  assert.equal(isRealtimeDailyPartition(partitionObject("messages_2027_01_01_pkey", "index")), true, "a genuine partition index was refused");
  // ...and it passes through the classifier without being flagged.
  assert.equal(
    classifyManagedSchemaObjects([...wholeBaseline(), partitionObject("messages_2027_01_01")]).nonStockCount,
    0,
    "a genuine daily partition was flagged as application state",
  );
});

test("realtime daily partition: a STANDALONE table with the same name and owner is REFUSED", () => {
  // The exact evasion: name plus owner used to be the whole test. This object is not a
  // partition of realtime.messages at all — no parent, no bound.
  const fake = partitionObject("messages_2027_01_01", "relation", {
    definition: "relkind=r|parent=|bound=|cols=id:uuid:NN:,payload:jsonb:NULL:",
  });
  assert.equal(isRealtimeDailyPartition(fake), false, "a standalone table posing as a daily partition was accepted");
  assert.equal(classifyManagedSchemaObjects([...wholeBaseline(), fake]).nonStockCount, 1, "the impostor partition was not counted");
});

test("realtime daily partition: ALTERED columns or bound are REFUSED", () => {
  const genuine = realtimePartitionDefinition({ schema: "realtime", kind: "relation", name: "messages_2027_01_01", owner: "supabase_realtime_admin" });
  const altered = partitionObject("messages_2027_01_01", "relation", { definition: `${genuine},injected_col:text:NULL:` });
  assert.equal(isRealtimeDailyPartition(altered), false, "a partition with an extra column was accepted");
  const rebound = partitionObject("messages_2027_01_01", "relation", {
    definition: genuine.replace("TO ('2027-01-02 00:00:00')", "TO ('2028-01-02 00:00:00')"),
  });
  assert.equal(isRealtimeDailyPartition(rebound), false, "a partition with a different bound was accepted");
});

test("realtime daily partition: an ALTERED index definition is REFUSED", () => {
  const genuine = realtimePartitionDefinition({ schema: "realtime", kind: "index", name: "messages_2027_01_01_pkey", owner: "supabase_realtime_admin" });
  const altered = partitionObject("messages_2027_01_01_pkey", "index", { definition: genuine.replace("(id, inserted_at)", "(id)") });
  assert.equal(isRealtimeDailyPartition(altered), false, "a rebuilt partition index was accepted");
});

test("realtime daily partition: owner, schema, kind and a REAL date are all load-bearing", () => {
  const genuine = realtimePartitionDefinition({ schema: "realtime", kind: "relation", name: "messages_2027_01_01", owner: "supabase_realtime_admin" });
  assert.equal(isRealtimeDailyPartition({ schema: "realtime", kind: "relation", name: "messages_2027_01_01", owner: "postgres", definition: genuine }), false, "a re-owned partition was accepted");
  assert.equal(isRealtimeDailyPartition({ schema: "storage", kind: "relation", name: "messages_2027_01_01", owner: "supabase_realtime_admin", definition: genuine }), false, "the schema was not checked");
  assert.equal(isRealtimeDailyPartition({ schema: "realtime", kind: "function", name: "messages_2027_01_01", owner: "supabase_realtime_admin", definition: genuine }), false, "the kind was not checked");
  // 2027-02-31 is digit-shaped but not a calendar date.
  assert.equal(realtimePartitionDefinition({ schema: "realtime", kind: "relation", name: "messages_2027_02_31", owner: "supabase_realtime_admin" }), null, "an impossible date was treated as a partition");
});

// ─── F1: structural fingerprints ──────────────────────────────────────────

test("classifyManagedSchemaObjects: a stock object REWRITTEN in place is refused", () => {
  // schema + kind + name + owner all still match; only the definition changed. This is
  // the case a four-field identity match could never see.
  for (const kind of ["relation", "index", "function", "type"]) {
    const entry = STOCK_MANAGED_OBJECT_BASELINE.find((b) => b.kind === kind);
    assert.ok(entry, `the baseline carries no ${kind} to mutate`);
    const rewritten = wholeBaseline().map((b) =>
      b === b && b.schema === entry.schema && b.kind === entry.kind && b.name === entry.name
        ? { ...b, fingerprint: undefined, definition: "TAMPERED DEFINITION" }
        : b);
    const verdict = classifyManagedSchemaObjects(rewritten);
    assert.equal(verdict.nonStockCount, 1, `a rewritten stock ${kind} was accepted as pristine`);
    assert.equal(verdict.missingStockCount, 1, `the original stock ${kind} was not reported missing`);
  }
});

// ─── Exact-byte fingerprints (semantic whitespace) ────────────────────────
//
// The defect: `fingerprintDefinition` collapsed every whitespace run to a single
// space before hashing, and the probe additionally flattened newlines to spaces in
// SQL. Whitespace is not decoration inside a definition — it is content. A string
// literal in a stock function body could be rewritten from `'Error 400: Bad Request'`
// to `'Error 400: Bad  Request'` (or with an embedded newline) and hash IDENTICALLY
// to the certified value, so the rewritten object was certified pristine and the
// project was declared application-empty ahead of a destructive push.
//
// The fixture below is the genuine certified `realtime.apply_rls` definition captured
// through the probe's own projection. Its first assertion is that it still hashes to
// the frozen baseline fingerprint — so if Supabase ships a new stock body, this fails
// loudly and attributably rather than silently testing a stale blob.

/** The certified `realtime.apply_rls` definition, exactly as the probe transports it. */
const applyRlsDefinition = () =>
  Buffer.from(
    readFileSync(new URL("./fixtures/realtime-apply-rls-definition.base64", import.meta.url), "utf8").replace(/\s+/g, ""),
    "base64",
  ).toString("utf8");

const APPLY_RLS_IDENTITY = Object.freeze({
  schema: "realtime",
  kind: "function",
  name: "apply_rls(wal jsonb, max_record_bytes integer)",
  owner: "supabase_realtime_admin",
});

/** The certified baseline entry for `realtime.apply_rls`, or a stale-fixture failure. */
const certifiedApplyRls = () => {
  const entry = STOCK_MANAGED_OBJECT_BASELINE.find(
    (b) => b.schema === APPLY_RLS_IDENTITY.schema && b.kind === APPLY_RLS_IDENTITY.kind && b.name === APPLY_RLS_IDENTITY.name,
  );
  assert.ok(entry, "realtime.apply_rls is no longer in the certified baseline; the fixture is stale");
  return entry;
};

test("fingerprintDefinition: the fingerprint is EXACT — whitespace is content, not formatting", () => {
  // The replaced policy asserted the opposite of each of these.
  assert.notEqual(fingerprintDefinition("a  b"), fingerprintDefinition("a b"), "a doubled space was normalised away");
  assert.notEqual(fingerprintDefinition("a\nb"), fingerprintDefinition("a b"), "a newline was normalised away");
  assert.notEqual(fingerprintDefinition("a\tb"), fingerprintDefinition("a b"), "a tab was normalised away");
  assert.notEqual(fingerprintDefinition(" a b"), fingerprintDefinition("a b"), "leading whitespace was trimmed away");
  assert.notEqual(fingerprintDefinition("a b "), fingerprintDefinition("a b"), "trailing whitespace was trimmed away");
  assert.notEqual(fingerprintDefinition("a b c"), fingerprintDefinition("a b d"), "a content change did not change the fingerprint");
  assert.equal(fingerprintDefinition("a b c"), fingerprintDefinition("a b c"), "the fingerprint is not deterministic");
  // Byte-exact, not merely whitespace-exact: the hash is over the UTF-8 bytes.
  assert.notEqual(fingerprintDefinition("é"), fingerprintDefinition("e"), "non-ASCII content was folded");
});

test("fingerprintDefinition: the fixture IS the certified apply_rls definition, losslessly", () => {
  const definition = applyRlsDefinition();
  assert.equal(
    fingerprintDefinition(definition),
    certifiedApplyRls().fingerprint,
    "the captured apply_rls definition no longer hashes to the certified baseline fingerprint; re-capture the fixture and regenerate the baseline together",
  );
  // Lossless transport: the definition still carries its real newlines. Under the old
  // wire format these were replaced with spaces in SQL, before JavaScript saw them.
  assert.ok(definition.split("\n").length > 100, "the fixture lost its newlines; the transport is not lossless");
  assert.ok(definition.includes("Error 400: Bad Request"), "the fixture no longer carries the literal these controls mutate");
});

test("fingerprintDefinition: semantically distinct whitespace mutations all diverge from stock", () => {
  const definition = applyRlsDefinition();
  const stockFingerprint = certifiedApplyRls().fingerprint;
  const LITERAL = "Error 400: Bad Request";
  const controls = [
    // A — a doubled space INSIDE a string literal. This is the reported collision: the
    //     emitted error text changes, but the old normaliser hashed it as stock.
    ["A: doubled space inside a string literal", definition.replace(LITERAL, "Error 400: Bad  Request")],
    // B — a newline and a tab inside the same literal. Under the old pipeline these were
    //     erased twice over: flattened to spaces in SQL, then collapsed in JavaScript.
    ["B: newline inside a string literal", definition.replace(LITERAL, "Error 400: Bad\nRequest")],
    ["B: tab inside a string literal", definition.replace(LITERAL, "Error 400: Bad\tRequest")],
    // C — whitespace OUTSIDE any literal. Re-indenting a certified body is drift too:
    //     the gate certifies the exact bytes of stock, not an equivalence class of them.
    ["C: re-indented body outside literals", definition.replace("\n", "\n  ")],
    // E — an ordinary content change, which the old policy did already catch. Kept so a
    //     regression that broke content detection cannot hide behind the new controls.
    ["E: a different body", definition.replace(LITERAL, "Error 401: Unauthorized")],
  ];
  for (const [label, mutated] of controls) {
    assert.notEqual(mutated, definition, `${label} did not actually mutate the fixture`);
    assert.notEqual(fingerprintDefinition(mutated), stockFingerprint, `${label} collided with the certified stock fingerprint`);
  }
  // D — the unmutated stock definition is still accepted. A fingerprint that refused
  //     everything would pass every control above and be worthless.
  assert.equal(fingerprintDefinition(definition), stockFingerprint, "D: the unmutated stock definition was refused");
});

test("classifyManagedSchemaObjects: a whitespace-only rewrite of stock apply_rls is refused", () => {
  // Drives the classifier, not the hash: a COMPLETE stock observation built from the
  // version-controlled baseline, with ONLY realtime.apply_rls replaced by the
  // semantically mutated definition. Before the fix this observation was fully stock.
  const certified = certifiedApplyRls();
  const mutated = applyRlsDefinition().replace("Error 400: Bad Request", "Error 400: Bad  Request");
  const observed = wholeBaseline().map((b) =>
    b.schema === certified.schema && b.kind === certified.kind && b.name === certified.name
      ? { ...APPLY_RLS_IDENTITY, fingerprint: undefined, definition: mutated }
      : b);
  assert.equal(observed.length, STOCK_MANAGED_OBJECT_BASELINE.length, "the observation is not a complete stock inventory");

  const verdict = classifyManagedSchemaObjects(observed);
  assert.equal(verdict.baselineSatisfied, false, "a whitespace-only rewrite of a stock function satisfied the baseline");
  assert.ok(
    verdict.nonStock.some((entry) => entry.includes("realtime.apply_rls")),
    `the rewritten apply_rls was not reported as non-stock: ${verdict.nonStock.join(", ")}`,
  );
  assert.ok(
    verdict.missingStock.some((entry) => entry.includes("realtime.apply_rls")),
    `the certified apply_rls was not reported missing: ${verdict.missingStock.join(", ")}`,
  );
  // Exactly one object moved, in both directions — the rest of stock is untouched.
  assert.equal(verdict.nonStockCount, 1, `unrelated objects were flagged: ${verdict.nonStock.join(", ")}`);
  assert.equal(verdict.missingStockCount, 1, `unrelated objects went missing: ${verdict.missingStock.join(", ")}`);

  // The same observation with the UNMUTATED definition is fully stock, which proves the
  // refusal above is caused by the mutation and not by rebuilding the entry by hand.
  const honest = wholeBaseline().map((b) =>
    b.schema === certified.schema && b.kind === certified.kind && b.name === certified.name
      ? { ...APPLY_RLS_IDENTITY, fingerprint: undefined, definition: applyRlsDefinition() }
      : b);
  assert.equal(classifyManagedSchemaObjects(honest).baselineSatisfied, true, "the unmutated stock observation was refused");
});

test("classifyManagedSchemaObjects: whitespace-only rewrites are refused for EVERY object kind", () => {
  // The generic surface, not just the one reported object: relations, indexes, functions
  // and types all carry definitions, and all four must be exact.
  for (const kind of ["relation", "index", "function", "type"]) {
    const entry = STOCK_MANAGED_OBJECT_BASELINE.find((b) => b.kind === kind);
    assert.ok(entry, `the baseline carries no ${kind}`);
    for (const [label, definition] of [["doubled space", "a  b"], ["newline", "a\nb"], ["tab", "a\tb"]]) {
      // `a b` is the normalised form of all three; under the old policy each of them
      // hashed to whatever `a b` hashed to, so none of them could be distinguished.
      assert.notEqual(
        fingerprintDefinition(definition),
        fingerprintDefinition("a b"),
        `a ${kind} ${label} was normalised away`,
      );
      const observed = wholeBaseline().map((b) =>
        b.schema === entry.schema && b.kind === entry.kind && b.name === entry.name
          ? { schema: b.schema, kind: b.kind, name: b.name, owner: b.owner, fingerprint: undefined, definition }
          : b);
      const verdict = classifyManagedSchemaObjects(observed);
      assert.equal(verdict.nonStockCount, 1, `a rewritten ${kind} (${label}) was accepted as pristine`);
      assert.equal(verdict.missingStockCount, 1, `the original stock ${kind} (${label}) was not reported missing`);
    }
  }
});

test("the managed-object probe transports definitions losslessly and normalises nothing", () => {
  const source = readFileSync(SCRIPT, "utf8");
  // The normaliser is gone outright, not merely unused.
  assert.doesNotMatch(source, /normalizeDefinition/, "the whitespace normaliser is still present in the script");
  // The hash is over the raw definition.
  assert.match(
    source,
    /function fingerprintDefinition\(definition\)\s*\{\s*return createHash\("sha256"\)\.update\(String\(definition \?\? ""\), "utf8"\)/,
    "fingerprintDefinition no longer hashes the raw definition",
  );
  const region = source.slice(source.indexOf("const managedQuery"), source.indexOf("const managedVerdict"));
  // No SQL-side whitespace flattening survives in the managed-object probe.
  assert.doesNotMatch(region, /replace\([^)]*chr\(10\)/, "the probe still flattens newlines in SQL");
  // All three branches (relation, function, type) transport base64, and the only
  // characters stripped are the base64 line breaks psql's encoder inserts.
  assert.equal(
    (region.match(/encode\(convert_to\(/g) ?? []).length, 3,
    "not every managed-object branch transports its definition losslessly",
  );
  assert.equal(
    (region.match(/'base64'\), chr\(10\) \|\| chr\(13\), ''\)/g) ?? []).length, 3,
    "a managed-object branch does not strip base64 line breaks exactly",
  );
  // A definition that will not decode is a refusal, never an assumption of emptiness.
  assert.match(region, /undecodable definition; refusing to infer emptiness/, "an undecodable definition does not fail closed");
});

// ─── R29: coherent COMPLETE managed-platform profiles ─────────────────────
//
// The defect: one monolithic baseline, combined with remediation 28's exact-byte
// fingerprints, could certify only ONE platform build. The hosted validation project
// ships a legitimately different stock `extensions.grant_pg_cron_access()`, so a
// pristine hosted target was refused — fail-closed, but not deployable.
//
// The fix is NOT a per-object list of allowed fingerprints. That would accept a
// Frankenstein platform: the local build of one object beside the hosted build of
// another, a combination no real platform ever shipped. A target must match one
// COMPLETE profile in full.

const profileById = (id) => {
  const profile = STOCK_MANAGED_OBJECT_PROFILES.find((p) => p.id === id);
  assert.ok(profile, `the certified profile ${id} is missing`);
  return profile;
};
/** A complete observation of one certified profile, as the probe would have seen it. */
const observationOf = (profile) => profile.objects.map((o) => ({ ...o }));
const findIn = (profile, schema, name) => {
  const entry = profile.objects.find((o) => o.schema === schema && o.name === name);
  assert.ok(entry, `${schema}.${name} is not in profile ${profile.id}`);
  return entry;
};
const withReplaced = (profile, schema, name, patch) =>
  observationOf(profile).map((o) => (o.schema === schema && o.name === name ? { ...o, ...patch } : o));

const LOCAL = () => profileById("local-cli-stock");
const HOSTED = () => profileById("hosted-platform-stock");

test("profiles: both certified profiles carry provenance and verify their own digest", () => {
  assert.equal(STOCK_MANAGED_OBJECT_PROFILES.length, 2, "the certified profile set changed");
  for (const profile of STOCK_MANAGED_OBJECT_PROFILES) {
    assert.ok(profile.source, `${profile.id} carries no provenance source`);
    assert.match(profile.capturedAt, /^\d{4}-\d{2}-\d{2}$/, `${profile.id} carries no capture date`);
    assert.ok(profile.server, `${profile.id} records no server version`);
    assert.equal(profile.objects.length, profile.objectCount, `${profile.id} miscounts its own objects`);
    // The digest the module verifies at load, recomputed here independently.
    const digest = createHash("sha256")
      .update(profile.objects.map((o) => `${o.schema}|${o.kind}|${o.name}|${o.owner}|${o.fingerprint}`).sort().join("\n"), "utf8")
      .digest("hex");
    assert.equal(digest, profile.digest, `${profile.id} does not match its certified digest`);
    // Order is not semantic: a profile listed in any order is the same profile.
    const shuffled = [...profile.objects].sort(() => (Math.random() < 0.5 ? -1 : 1));
    const shuffledDigest = createHash("sha256")
      .update(shuffled.map((o) => `${o.schema}|${o.kind}|${o.name}|${o.owner}|${o.fingerprint}`).sort().join("\n"), "utf8")
      .digest("hex");
    assert.equal(shuffledDigest, profile.digest, `${profile.id}'s digest depends on construction order`);
    // No identity may appear twice within one profile.
    const identities = new Set(profile.objects.map((o) => `${o.schema}|${o.kind}|${o.name}|${o.owner}`));
    assert.equal(identities.size, profile.objects.length, `${profile.id} carries a duplicate identity`);
  }
});

test("profiles: the two certified profiles are genuinely different platform shapes", () => {
  const local = LOCAL(), hosted = HOSTED();
  assert.notEqual(local.digest, hosted.digest, "the two profiles are the same set; one is not real evidence");
  assert.equal(local.objects.length, 236, "the local profile size changed");
  assert.equal(hosted.objects.length, 213, "the hosted profile size changed");
  // The authoritative independently-captured hosted digest.
  assert.equal(hosted.digest, "e86cca120de040a36926e394a8b169c5f4518686fb43a8bec40603f5b0510bd8",
    "the hosted profile no longer reconstructs to its independently captured digest");
});

// ── TEST A / TEST B: each COMPLETE profile is accepted, and only as itself ──

test("A+B: each complete certified profile is accepted, and matches only itself", () => {
  for (const profile of STOCK_MANAGED_OBJECT_PROFILES) {
    const verdict = classifyManagedSchemaObjects(observationOf(profile));
    assert.equal(verdict.baselineSatisfied, true, `the complete ${profile.id} profile was refused`);
    assert.equal(verdict.matchedProfile, profile.id, `${profile.id} matched as ${verdict.matchedProfile}`);
    assert.deepEqual(verdict.matchingProfiles, [profile.id], `${profile.id} also matched another profile`);
    assert.equal(managedObjectProblemCount(verdict), 0, `USER_MANAGED_SCHEMA_OBJECTS was not 0 for ${profile.id}`);
    // Every profile is evaluated, so a refusal is always attributable to a named profile.
    assert.deepEqual(verdict.profileResults.map((r) => r.profileId), STOCK_MANAGED_OBJECT_PROFILES.map((p) => p.id));
  }
});

test("A+B: a profile is matched on CONTENT, never on a caller-supplied label", () => {
  // The hosted observation is accepted while carrying no marker of its origin at all: the
  // objects decide. Nothing in the observation names a profile, and nothing may.
  const hosted = classifyManagedSchemaObjects(observationOf(HOSTED()));
  assert.equal(hosted.matchedProfile, "hosted-platform-stock");
  // The local set does NOT become hosted by being asserted to be.
  const mislabelled = observationOf(LOCAL()).map((o) => ({ ...o, profile: "hosted-platform-stock" }));
  const verdict = classifyManagedSchemaObjects(mislabelled);
  assert.equal(verdict.matchedProfile, "local-cli-stock", "a supplied label overrode the observed content");
});

// ── TEST C: the known divergent object ─────────────────────────────────────

test("C: extensions.grant_pg_cron_access() legitimately differs between the two profiles", () => {
  const local = findIn(LOCAL(), "extensions", "grant_pg_cron_access()");
  const hosted = findIn(HOSTED(), "extensions", "grant_pg_cron_access()");
  assert.equal(local.fingerprint, "76080dae01e3ec7e6c8d3a7c", "the local build's certified fingerprint changed");
  assert.equal(hosted.fingerprint, "d637c2f316deafce484f113e", "the hosted build's certified fingerprint changed");
  assert.notEqual(local.fingerprint, hosted.fingerprint, "the divergence this remediation exists for is gone");
  // Same identity in both profiles — this is one object with two legitimate builds, which
  // is exactly why a single exact-byte baseline could not certify both platforms.
  for (const field of ["schema", "kind", "name", "owner"]) {
    assert.equal(local[field], hosted[field], `the two builds are not the same identity (${field})`);
  }
  // Each build is stock in its own profile and foreign in the other.
  assert.equal(classifyManagedSchemaObjects(observationOf(LOCAL())).matchedProfile, "local-cli-stock");
  assert.equal(classifyManagedSchemaObjects(observationOf(HOSTED())).matchedProfile, "hosted-platform-stock");
});

// ── TEST D: the Frankenstein refusal — the load-bearing case ───────────────

test("D: a hybrid assembled from two certified profiles is REFUSED, both directions", () => {
  // Two independently divergent common identities. Each swapped object is certified
  // stock SOMEWHERE, so a per-object union rule would accept every one of these sets.
  const cases = [
    ["hosted base + the LOCAL build of extensions.grant_pg_cron_access()",
      withReplaced(HOSTED(), "extensions", "grant_pg_cron_access()", { fingerprint: findIn(LOCAL(), "extensions", "grant_pg_cron_access()").fingerprint }),
      "hosted-platform-stock"],
    ["local base + the HOSTED build of storage.buckets",
      withReplaced(LOCAL(), "storage", "buckets", { fingerprint: findIn(HOSTED(), "storage", "buckets").fingerprint }),
      "local-cli-stock"],
    ["hosted base + the LOCAL builds of BOTH divergent objects",
      withReplaced(HOSTED(), "storage", "buckets", { fingerprint: findIn(LOCAL(), "storage", "buckets").fingerprint })
        .map((o) => (o.schema === "extensions" && o.name === "grant_pg_cron_access()"
          ? { ...o, fingerprint: findIn(LOCAL(), "extensions", "grant_pg_cron_access()").fingerprint } : o)),
      "hosted-platform-stock"],
  ];
  for (const [label, observed, closest] of cases) {
    const verdict = classifyManagedSchemaObjects(observed);
    assert.equal(verdict.baselineSatisfied, false, `a Frankenstein platform was certified stock: ${label}`);
    assert.equal(verdict.matchedProfile, null, `${label} reported a matched profile`);
    assert.deepEqual(verdict.matchingProfiles, [], `${label} matched a profile`);
    assert.ok(managedObjectProblemCount(verdict) > 0, `${label} contributed 0 problems to emptiness`);
    // Refusal stays attributable: the closest profile is named, without softening it.
    assert.equal(verdict.closestProfile, closest, `${label} was diagnosed against the wrong profile`);
    assert.ok(verdict.nonStockCount > 0 && verdict.missingStockCount > 0, `${label} did not report drift in both directions`);
  }
});

test("D: EVERY object of a refused hybrid is certified stock in SOME profile", () => {
  // The proof that the refusal above comes from completeness, not from an unknown object:
  // a per-object union rule would have accepted this exact set.
  const observed = withReplaced(HOSTED(), "extensions", "grant_pg_cron_access()",
    { fingerprint: findIn(LOCAL(), "extensions", "grant_pg_cron_access()").fingerprint });
  const union = new Set(STOCK_MANAGED_OBJECT_PROFILES.flatMap((p) =>
    p.objects.map((o) => `${o.schema}|${o.kind}|${o.name}|${o.owner}|${o.fingerprint}`)));
  for (const o of observed) {
    assert.ok(union.has(`${o.schema}|${o.kind}|${o.name}|${o.owner}|${o.fingerprint}`),
      `${o.schema}.${o.name} is not certified in any profile; the hybrid is not a pure union case`);
  }
  assert.equal(classifyManagedSchemaObjects(observed).baselineSatisfied, false,
    "PER_OBJECT_UNION_ACCEPTANCE — the classifier accepted a set that no single profile certifies");
});

// ── TEST E: remediation 28 is not reopened by profile support ──────────────

test("E: a semantic whitespace rewrite of apply_rls is refused by EVERY profile", () => {
  const definition = applyRlsDefinition();
  const mutated = definition.replace("Error 400: Bad Request, no primary key", "Error 400: Bad  Request, no primary key");
  assert.notEqual(mutated, definition, "the fixture no longer carries the literal this control mutates");
  for (const profile of STOCK_MANAGED_OBJECT_PROFILES) {
    // Sanity: the honest definition satisfies this profile, so the refusal below is the
    // mutation's doing and not a broken fixture.
    const honest = withReplaced(profile, "realtime", APPLY_RLS_IDENTITY.name, { fingerprint: undefined, definition });
    assert.equal(classifyManagedSchemaObjects(honest).matchedProfile, profile.id,
      `the unmutated apply_rls definition did not satisfy ${profile.id}`);

    const observed = withReplaced(profile, "realtime", APPLY_RLS_IDENTITY.name, { fingerprint: undefined, definition: mutated });
    const verdict = classifyManagedSchemaObjects(observed);
    assert.equal(verdict.baselineSatisfied, false, `${profile.id} accepted a whitespace-rewritten apply_rls`);
    assert.deepEqual(verdict.matchingProfiles, [], `${profile.id} still matched after the mutation`);
    for (const result of verdict.profileResults) {
      assert.equal(result.baselineSatisfied, false, `profile ${result.profileId} accepted the mutation`);
    }
  }
});

// ── TESTS F–I: the refusal surface, now per complete profile ───────────────

test("F/G/H/I: unknown, missing, re-owned and duplicated objects are refused in every profile", () => {
  for (const profile of STOCK_MANAGED_OBJECT_PROFILES) {
    const stock = profile.objects[0];
    const cases = {
      // F — an object in no certified profile at all.
      "unknown object": [...observationOf(profile), {
        schema: "storage", kind: "relation", name: "definitely_not_stock", owner: "supabase_storage_admin",
        definition: "relkind=r|parent=|bound=|cols=id:uuid:NN:",
      }],
      // G — a certified object absent from the target.
      "missing object": observationOf(profile).slice(1),
      // H — right structure, wrong owner. Ownership is identity, not decoration.
      "wrong owner": withReplaced(profile, stock.schema, stock.name, { owner: "postgres" }),
      // I — a valid certified entry present twice.
      "duplicate object": [...observationOf(profile), { ...stock }],
      // A fingerprint that belongs to no profile at all.
      "wrong fingerprint": withReplaced(profile, stock.schema, stock.name, { fingerprint: "0".repeat(24) }),
    };
    for (const [label, observed] of Object.entries(cases)) {
      const verdict = classifyManagedSchemaObjects(observed);
      assert.equal(verdict.baselineSatisfied, false, `${profile.id} accepted a ${label}`);
      assert.equal(verdict.matchedProfile, null, `${profile.id} matched despite a ${label}`);
      assert.ok(managedObjectProblemCount(verdict) > 0, `a ${label} contributed 0 problems in ${profile.id}`);
    }
  }
});

// ── TEST J: the dynamic realtime surface, including the third shape ────────

test("J: all THREE realtime daily shapes are dynamic stock, and belong to no static profile", () => {
  const date = "2026_09_02", iso = "2026-09-02", next = "2026-09-03";
  const shapes = {
    relation: { kind: "relation", name: `messages_${date}` },
    pkey: { kind: "index", name: `messages_${date}_pkey` },
    topicIndex: { kind: "index", name: `messages_${date}_inserted_at_topic_idx` },
  };
  for (const [label, id] of Object.entries(shapes)) {
    const object = { schema: "realtime", owner: "supabase_realtime_admin", ...id };
    const definition = realtimePartitionDefinition(object);
    assert.ok(definition, `the ${label} shape is not recognised as a daily partition object`);
    assert.equal(isRealtimeDailyPartition({ ...object, definition }), true, `the ${label} shape was not accepted`);
    // Dynamic objects are date-derived, so freezing one into a static profile would refuse
    // every project on a different day.
    for (const profile of STOCK_MANAGED_OBJECT_PROFILES) {
      assert.equal(profile.objects.some((o) => o.schema === "realtime" && o.name === id.name), false,
        `${profile.id} statically carries the dynamic ${label} object ${id.name}`);
    }
    // A complete profile plus a valid daily object is still exactly that profile.
    const verdict = classifyManagedSchemaObjects([...observationOf(LOCAL()), { ...object, definition }]);
    assert.equal(verdict.matchedProfile, "local-cli-stock", `a valid ${label} defeated the profile match`);
  }
  // The third shape's definition is the attached broadcast index, not the primary key.
  assert.equal(
    realtimePartitionDefinition({ schema: "realtime", kind: "index", owner: "supabase_realtime_admin", name: `messages_${date}_inserted_at_topic_idx` }),
    `indexdef=CREATE INDEX messages_${date}_inserted_at_topic_idx ON realtime.messages_${date} USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE))|indexparent=realtime.messages_inserted_at_topic_index`,
    "the broadcast partition index definition drifted",
  );
  assert.match(realtimePartitionDefinition({ schema: "realtime", kind: "relation", owner: "supabase_realtime_admin", name: `messages_${date}` }),
    new RegExp(`FROM \\('${iso} 00:00:00'\\) TO \\('${next} 00:00:00'\\)`), "the daily bound drifted");
});

test("J: an impostor daily object is refused on owner, date, kind or definition", () => {
  const base = { schema: "realtime", kind: "index", owner: "supabase_realtime_admin", name: "messages_2026_09_02_inserted_at_topic_idx" };
  const genuine = realtimePartitionDefinition(base);
  assert.ok(genuine, "the fixture is not a recognised partition index");
  const impostors = {
    "wrong owner": { ...base, owner: "postgres" },
    "wrong kind": { ...base, kind: "relation" },
    "impossible calendar date": { ...base, name: "messages_2026_02_31_inserted_at_topic_idx" },
    "wrong schema": { ...base, schema: "public" },
  };
  for (const [label, object] of Object.entries(impostors)) {
    assert.equal(realtimePartitionDefinition(object), null, `an impostor with a ${label} was treated as dynamic stock`);
    assert.equal(isRealtimeDailyPartition({ ...object, definition: genuine }), false, `a ${label} impostor was accepted`);
  }
  // A REAL daily index whose definition was rewritten — including a whitespace-only
  // rewrite, which must not be normalised away here any more than in a fingerprint.
  for (const [label, definition] of [
    ["a changed bound", genuine.replace("messages_2026_09_02", "messages_2026_09_09")],
    ["a changed predicate", genuine.replace("'broadcast'::text", "'postgres_changes'::text")],
    ["a dropped predicate", genuine.replace(" WHERE ((extension = 'broadcast'::text) AND (private IS TRUE))", "")],
    ["a doubled space", genuine.replace("USING btree", "USING  btree")],
  ]) {
    assert.notEqual(definition, genuine, `the ${label} control did not mutate the definition`);
    assert.equal(isRealtimeDailyPartition({ ...base, definition }), false, `a daily index with ${label} was accepted as stock`);
    // And it is not laundered into the static profile either.
    const verdict = classifyManagedSchemaObjects([...observationOf(LOCAL()), { ...base, definition }]);
    assert.equal(verdict.baselineSatisfied, false, `a daily index with ${label} was certified stock`);
  }
});

test("J: the six dated broadcast indexes are no longer frozen into the local profile", () => {
  // They were static entries at 826fa53f. The structural audit proved they are partition
  // child indexes attached to realtime.messages_inserted_at_topic_index, created per day
  // by the service — so a profile carrying them would expire.
  const dated = LOCAL().objects.filter((o) => /^messages_20\d{2}_\d{2}_\d{2}_inserted_at_topic_idx$/.test(o.name));
  assert.deepEqual(dated, [], `the local profile still freezes dated broadcast indexes: ${dated.map((o) => o.name).join(", ")}`);
  // The PARENT index is not date-derived and remains certified static evidence.
  assert.ok(findIn(LOCAL(), "realtime", "messages_inserted_at_topic_index"), "the certified parent index was dropped");
});

// ─── R30: dynamic partition indexes must PROVE parent attachment ──────────
//
// The gap: a daily index was certified on schema, kind, name, owner and an exact
// pg_get_indexdef. That does not prove it is the service's index. PostgreSQL supports
//
//   CREATE INDEX look_alike ON realtime.messages_2026_09_02 USING btree (...);
//   ALTER INDEX realtime.messages_inserted_at_topic_index ATTACH PARTITION look_alike;
//
// and the ATTACH requires an EQUIVALENT definition — so an unattached standalone index
// on the right partition can carry a byte-identical definition and was accepted as
// dynamic stock. The probe now transports the pg_inherits parent, and both index shapes
// require their certified parent. The suffix is emitted only when a parent exists, so no
// unattached index's fingerprint moves and neither static profile changes.

const DAILY = "2026_09_02";
const dailyIndex = (suffix, parent) => ({
  schema: "realtime",
  kind: "index",
  owner: "supabase_realtime_admin",
  name: `messages_${DAILY}${suffix}`,
  parent,
});
/** The certified definition of a daily index shape, as the probe now transports it. */
const dailyIndexDefinition = (suffix) => {
  const definition = realtimePartitionDefinition(dailyIndex(suffix));
  assert.ok(definition, `the ${suffix} shape is not a recognised daily index`);
  return definition;
};

test("R30: the probe transports an index parent ONLY when one exists", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const region = source.slice(source.indexOf("const managedQuery"), source.indexOf("const managed = runner"));
  // Positive parent evidence, read from pg_inherits — never inferred from the child name.
  assert.match(region, /'\|indexparent=' \|\| pn\.nspname \|\| '\.' \|\| pc\.relname/, "the index parent is not transported");
  assert.match(region, /from pg_inherits ii[\s\S]{0,200}where ii\.inhrelid = c\.oid/, "the parent is not read from pg_inherits on the index itself");
  // Conditional: coalesce(..., '') keeps an unattached index's definition byte-identical,
  // which is why the certified static profiles do not move.
  const branch = region.slice(region.indexOf("then 'indexdef='"));
  assert.match(branch.slice(0, 400), /coalesce\(\(select '\|indexparent='/, "the parent suffix is not conditional");
  assert.doesNotMatch(region, /indexparent=' \|\| coalesce\(\(select pn\.nspname/, "the suffix is emitted unconditionally");
  // The parent is not derived from the child's name anywhere.
  assert.doesNotMatch(branch.slice(0, 400), /replace\(c\.relname|substring\(c\.relname/, "the parent is inferred from the child name");
});

test("R30: both certified parents are themselves certified STATIC objects in both profiles", () => {
  // The attachment chain must terminate in certified evidence, or it proves nothing.
  for (const parent of ["messages_pkey", "messages_inserted_at_topic_index"]) {
    for (const profile of STOCK_MANAGED_OBJECT_PROFILES) {
      const entry = profile.objects.find((o) => o.schema === "realtime" && o.name === parent && o.kind === "index");
      assert.ok(entry, `${profile.id} does not certify the parent index realtime.${parent}`);
      assert.equal(entry.owner, "supabase_realtime_admin", `realtime.${parent} is certified under the wrong owner`);
    }
  }
});

// ── REGRESSION A / B: the three-way attachment proof, for BOTH index shapes ──

test("A+B: each daily index shape requires its OWN certified parent attachment", () => {
  const shapes = [
    ["_inserted_at_topic_idx", "realtime.messages_inserted_at_topic_index", "realtime.messages_pkey"],
    ["_pkey", "realtime.messages_pkey", "realtime.messages_inserted_at_topic_index"],
  ];
  for (const [suffix, correctParent, otherParent] of shapes) {
    const object = dailyIndex(suffix);
    const certified = dailyIndexDefinition(suffix);
    assert.ok(certified.endsWith(`|indexparent=${correctParent}`), `the ${suffix} template does not require ${correctParent}`);
    const bare = certified.slice(0, certified.indexOf("|indexparent="));

    // CORRECT parent -> accepted as dynamic stock.
    assert.equal(isRealtimeDailyPartition({ ...object, definition: certified }), true,
      `a correctly attached ${suffix} index was refused`);

    // MISSING attachment -> refused. This is the exact object the pre-R30 matcher accepted:
    // right schema, kind, name, owner and a byte-identical pg_get_indexdef.
    assert.equal(isRealtimeDailyPartition({ ...object, definition: bare }), false,
      `an UNATTACHED ${suffix} index was accepted as dynamic stock`);

    // WRONG parent -> refused, including the other shape's genuine certified parent.
    for (const wrong of [otherParent, "realtime.some_other_index", "public.messages_pkey", "realtime.messages"]) {
      assert.equal(isRealtimeDailyPartition({ ...object, definition: `${bare}|indexparent=${wrong}` }), false,
        `a ${suffix} index attached to ${wrong} was accepted`);
    }

    // And at the classifier level: an unattached look-alike is not laundered into a
    // complete profile match either.
    const withBare = classifyManagedSchemaObjects([...observationOf(LOCAL()), { ...object, definition: bare }]);
    assert.equal(withBare.baselineSatisfied, false, `an unattached ${suffix} index still satisfied a complete profile`);
    const withCertified = classifyManagedSchemaObjects([...observationOf(LOCAL()), { ...object, definition: certified }]);
    assert.equal(withCertified.matchedProfile, "local-cli-stock", `an attached ${suffix} index defeated the profile match`);
  }
});

// ── REGRESSION C: parent evidence never substitutes for the exact definition ──

test("C: with the CORRECT parent, the exact index definition is still required", () => {
  for (const suffix of ["_inserted_at_topic_idx", "_pkey"]) {
    const object = dailyIndex(suffix);
    const certified = dailyIndexDefinition(suffix);
    const parent = `|indexparent=${certified.split("|indexparent=")[1]}`;
    const bare = certified.slice(0, certified.indexOf("|indexparent="));
    const mutations = {
      "a changed indexed column": bare.replace("inserted_at", "updated_at"),
      "a dropped DESC": bare.replace(" DESC", ""),
      "a reversed order": bare.replace("USING btree (inserted_at DESC, topic)", "USING btree (topic, inserted_at DESC)")
        .replace("USING btree (id, inserted_at)", "USING btree (inserted_at, id)"),
      "a changed predicate": bare.replace("'broadcast'::text", "'postgres_changes'::text"),
      "a dropped UNIQUE": bare.replace("CREATE UNIQUE INDEX", "CREATE INDEX"),
      "a doubled space": bare.replace("USING btree", "USING  btree"),
      "a wrong relation": bare.replace(`realtime.messages_${DAILY} `, "realtime.messages_2026_09_09 "),
    };
    for (const [label, mutated] of Object.entries(mutations)) {
      if (mutated === bare) continue; // not applicable to this shape
      assert.equal(isRealtimeDailyPartition({ ...object, definition: `${mutated}${parent}` }), false,
        `a ${suffix} index with ${label} was accepted because its parent was right`);
    }
  }
});

// ── REGRESSION D: the daily RELATION rule is unchanged and independent ──────

test("D: an attached daily index does not vouch for its partition", () => {
  const relation = { schema: "realtime", kind: "relation", owner: "supabase_realtime_admin", name: `messages_${DAILY}` };
  const relationDefinition = realtimePartitionDefinition(relation);
  assert.ok(relationDefinition, "the daily relation shape was lost");
  // The relation still proves its own structure: parent, exact bound, columns,
  // constraints, ACL, RLS and replica identity.
  for (const fragment of ["parent=realtime.messages", "bound=FOR VALUES FROM ('2026-09-02 00:00:00') TO ('2026-09-03 00:00:00')",
    "cols=", "cons=", "acl=", "rls=false/false", "replident=d"]) {
    assert.ok(relationDefinition.includes(fragment), `the daily relation rule no longer proves ${fragment}`);
  }
  // A partition whose structure drifted is refused even when both of its indexes are
  // perfectly attached — the index attachment says nothing about the table.
  const indexes = ["_pkey", "_inserted_at_topic_idx"].map((s) => ({ ...dailyIndex(s), definition: dailyIndexDefinition(s) }));
  for (const [label, broken] of [
    ["a changed bound", relationDefinition.replace("TO ('2026-09-03", "TO ('2026-09-04")],
    ["RLS forced on", relationDefinition.replace("rls=false/false", "rls=true/true")],
    ["a dropped column", relationDefinition.replace(",binary_payload:bytea:NULL:", "")],
    ["a changed replica identity", relationDefinition.replace("replident=d", "replident=f")],
  ]) {
    assert.notEqual(broken, relationDefinition, `the ${label} control did not mutate the relation`);
    assert.equal(isRealtimeDailyPartition({ ...relation, definition: broken }), false, `a daily partition with ${label} was accepted`);
    const verdict = classifyManagedSchemaObjects([...observationOf(LOCAL()), { ...relation, definition: broken }, ...indexes]);
    assert.equal(verdict.baselineSatisfied, false, `a daily partition with ${label} was certified stock alongside attached indexes`);
  }
  // A daily index for a date whose partition is absent is still just a dynamic object:
  // it is skipped, and the profile is unaffected. It cannot ADD certification.
  const orphan = classifyManagedSchemaObjects([...observationOf(LOCAL()), ...indexes]);
  assert.equal(orphan.matchedProfile, "local-cli-stock", "valid dynamic indexes disturbed the profile match");
});

// ─── R31: extension ownership must not exempt ROW STATE ───────────────────
//
// The defect: the managed-table ROW probe carried `notExtensionOwned(...)`. That
// exemption is right for the static OBJECT profiles — a stock project ships many
// extension objects — but ownership says nothing about what a table CONTAINS.
// vault.secrets is owned by supabase_vault, so a rotated allowlisted target could
// hold real operator secrets and still certify as application-empty ahead of
// `supabase db push --include-roles`.
//
// classifyManagedRowState ALREADY refused such a row; it simply never received one.
// The missing piece was the SQL observation, so these regressions drive the real
// probe-to-classifier handoff rather than the classifier alone.

/** The certified non-history row rules, rendered as the probe's own wire format. */
const certifiedRowLines = () =>
  Object.entries(STOCK_MANAGED_ROW_RULES)
    .filter(([, rule]) => rule.kind !== "history")
    .map(([qualified, rule]) => {
      const [schema, ...rest] = qualified.split(".");
      return `${schema}~|~${rest.join(".")}~|~${rule.count}~|~${rule.digest}`;
    });

/**
 * A stub psql that answers every probe query for an otherwise-pristine target.
 *
 * The row branch simulates PostgreSQL faithfully: `vault.secrets` is extension-owned,
 * so it is returned ONLY when the query does not filter extension-owned tables. That
 * is what makes this load-bearing — against the pre-R31 query the row is invisible
 * exactly as a real database would make it invisible.
 */
function stubbedStockRunner({ vaultSecretRows = 0, extensions, capture = {} } = {}) {
  const EXTENSION_FILTER = /deptype = 'e'/;
  return (_cmd, args) => {
    const sql = String(args[args.length - 1]);
    const ok = (stdout) => ({ status: 0, stdout, stderr: "" });
    if (sql.includes("as user_schemas")) return ok("0,0,0,0,0,0,0,0,0,0\n");
    if (sql.includes("pg_get_triggerdef")) {
      capture.triggerQuery = sql;
      return ok(STOCK_PLATFORM_TRIGGER_BASELINE.map((t) =>
        `${t.schema}~|~${t.table}~|~${t.trigger}~|~${t.functionSchema}~|~${t.functionName}~|~${t.functionOwner}~|~${t.definition}~|~${t.provenance}`).join("\n") + "\n");
    }
    if (sql.includes("pg_event_trigger")) return ok("");
    if (sql.includes("pg_get_functiondef")) return ok("");            // managed objects
    if (sql.includes("pg_extension e join pg_namespace")) {
      return ok((extensions ?? STOCK_EXTENSION_BASELINE.map((e) => `${e.name}~|~${e.version}~|~${e.schema}`)).join("\n") + "\n");
    }
    if (sql.includes("nspacl")) return ok(STOCK_MANAGED_SCHEMA_ACL.map((a) => `${a.schema}~|~${a.acl}`).join("\n") + "\n");
    if (sql.includes("pg_default_acl")) return ok(STOCK_DEFAULT_ACL.map((a) => `${a.schema}~|~${a.owner}~|~${a.objtype}~|~${a.acl}`).join("\n") + "\n");
    if (sql.includes("query_to_xml")) {
      capture.rowQuery = sql;
      const lines = certifiedRowLines();
      // vault.secrets is extension-owned; a query that excludes extension-owned
      // tables simply does not see it.
      if (!EXTENSION_FILTER.test(sql)) lines.push(`vault~|~secrets~|~${vaultSecretRows}~|~`);
      return ok(lines.join("\n") + "\n");
    }
    throw new Error(`the stub received an unexpected probe query: ${sql.slice(0, 120)}`);
  };
}

test("R31: the managed-table ROW probe no longer exempts extension-owned tables", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const region = source.slice(source.indexOf("const rowQuery"), source.indexOf("const observedRowState"));
  assert.match(region, /c\.relkind in \('r','p'\) and \(\$\{MANAGED\}\);/, "the row query no longer selects every managed table");
  assert.doesNotMatch(region, /notExtensionOwned/, "the ROW probe still exempts extension-owned tables");
  // The OBJECT inventory must keep the exemption: this remediation separates the two
  // questions, it does not delete the object-side rule.
  const objectRegion = source.slice(source.indexOf("const managedQuery"), source.indexOf("const managed = runner"));
  assert.equal((objectRegion.match(/notExtensionOwned\(/g) ?? []).length, 3,
    "the managed-object inventory lost its extension-ownership exemption");
});

// ── REGRESSION A / B: the real probe-to-classifier handoff ─────────────────

test("A+B: an extension-owned table's ROWS reach the emptiness verdict", () => {
  // B — pristine stock: vault.secrets exists, carries zero rows, and is not a problem.
  const capture = {};
  const empty = probeHostedApplicationState("postgresql://stub", stubbedStockRunner({ vaultSecretRows: 0, capture }));
  assert.equal(empty.ok, true, `the probe failed on a stock target: ${empty.reason ?? JSON.stringify(empty.failure)}`);
  assert.ok(
    empty.observedRowState.some((t) => t.schema === "vault" && t.name === "secrets"),
    "the extension-owned table was not OBSERVED at all; the probe still cannot see it",
  );
  assert.equal(empty.counts.user_managed_table_rows, 0, "a zero-row stock vault.secrets was reported as application state");

  // A — the load-bearing case: one row of real operator state.
  const populated = probeHostedApplicationState("postgresql://stub", stubbedStockRunner({ vaultSecretRows: 1 }));
  assert.equal(populated.ok, true, "the probe failed on the populated target");
  assert.ok(populated.counts.user_managed_table_rows > 0,
    "USER_MANAGED_TABLE_ROWS=0 — an extension-owned table holding operator data was invisible to the emptiness probe");
  assert.ok(
    (populated.populatedManagedTables ?? []).some((p) => p.includes("vault.secrets")),
    `vault.secrets was not named in the row-state problems: ${JSON.stringify(populated.populatedManagedTables)}`,
  );
  // APPLICATION_EMPTINESS=NOT_EMPTY, so no destructive push is reached. Asserted on an
  // otherwise-EMPTY count set so the refusal is attributable to the vault row ALONE and
  // cannot be borrowed from some unrelated objection the stub happens to produce.
  const attributable = { ...EMPTY_COUNTS, user_managed_table_rows: populated.counts.user_managed_table_rows };
  assert.equal(classifyObjectEmptiness(attributable).empty, false,
    "DB_PUSH_REACHED — the target certified as application-empty while holding operator secrets");
  assert.equal(classifyObjectEmptiness({ ...EMPTY_COUNTS, user_managed_table_rows: 0 }).empty, true,
    "the control set is not otherwise empty, so the refusal above proves nothing");
  assert.equal(classifyObjectEmptiness(populated.counts).empty, false, "the full observed target certified as empty");
  // And the difference is caused by the row count alone: everything else is identical.
  assert.equal(populated.counts.user_managed_schema_objects, empty.counts.user_managed_schema_objects);
  assert.equal(populated.counts.user_extensions, empty.counts.user_extensions);
});

// ── REGRESSION C: extension identity is unchanged by this remediation ──────

test("C: extension identity, version and schema are still enforced exactly", () => {
  const stock = STOCK_EXTENSION_BASELINE.map((e) => `${e.name}~|~${e.version}~|~${e.schema}`);
  const target = STOCK_EXTENSION_BASELINE.find((e) => e.name === "supabase_vault");
  assert.ok(target, "supabase_vault is no longer a certified stock extension");
  const cases = {
    "a changed version": stock.map((l) => l.startsWith("supabase_vault~|~") ? `supabase_vault~|~99.9.9~|~${target.schema}` : l),
    "a changed schema": stock.map((l) => l.startsWith("supabase_vault~|~") ? `supabase_vault~|~${target.version}~|~public` : l),
    "a missing extension": stock.filter((l) => !l.startsWith("supabase_vault~|~")),
    "an extra extension": [...stock, "pg_cron~|~1.6~|~pg_catalog"],
  };
  for (const [label, extensions] of Object.entries(cases)) {
    const out = probeHostedApplicationState("postgresql://stub", stubbedStockRunner({ extensions }));
    assert.equal(out.ok, true, `the probe failed outright on ${label}`);
    assert.ok(out.counts.user_extensions > 0, `${label} was accepted as stock`);
    assert.equal(classifyObjectEmptiness({ ...EMPTY_COUNTS, user_extensions: out.counts.user_extensions }).empty, false,
      `${label} still certified as empty`);
  }
  // The unmutated stock extension set is still accepted, so the controls above mean something.
  const clean = probeHostedApplicationState("postgresql://stub", stubbedStockRunner({}));
  assert.equal(clean.counts.user_extensions, 0, "the certified stock extension set was refused");
});

// ── REGRESSION D: the existing non-extension row rules are untouched ───────

test("D: every certified non-extension managed row rule still behaves exactly as before", () => {
  const rules = Object.entries(STOCK_MANAGED_ROW_RULES).filter(([, r]) => r.kind !== "history");
  assert.equal(rules.length, 8, "the certified non-history row rules changed");
  for (const [qualified, rule] of rules) {
    const [schema, ...rest] = qualified.split(".");
    const name = rest.join(".");
    const stock = rules.map(([q, r]) => {
      const [s, ...n] = q.split(".");
      return { schema: s, name: n.join("."), rows: r.count, digest: r.digest };
    });
    assert.equal(classifyManagedRowState(stock).problemCount, 0, `the certified row state was refused (${qualified})`);
    const mutate = (patch) => stock.map((t) => (t.schema === schema && t.name === name ? { ...t, ...patch } : t));
    assert.ok(classifyManagedRowState(mutate({ rows: rule.count + 1 })).problemCount > 0, `${qualified} accepted an extra row`);
    assert.ok(classifyManagedRowState(mutate({ rows: 0 })).problemCount > 0, `${qualified} accepted being EMPTY`);
    assert.ok(classifyManagedRowState(mutate({ digest: "tampered" })).problemCount > 0, `${qualified} accepted changed row content`);
  }
});

// ── REGRESSION E: the contract is generic, not a vault special case ────────

test("E: ANY managed table with rows and no certified rule fails closed, extension-owned or not", () => {
  // Nothing in the source names vault.secrets as an exception, and nothing keys on a
  // secret value or a row id.
  const source = readFileSync(SCRIPT, "utf8");
  const rowRegion = source.slice(source.indexOf("const rowQuery"), source.indexOf("const observedRowState"));
  assert.doesNotMatch(rowRegion, /vault|secrets/i, "the row probe special-cases the vault table by name");
  assert.equal(Object.keys(STOCK_MANAGED_ROW_RULES).includes("vault.secrets"), false,
    "vault.secrets was given a positive row rule; its certified pristine state is ZERO rows");

  // A hypothetical future extension-owned table behaves identically to vault.secrets.
  const stock = certifiedRowLines().map((l) => {
    const [schema, name, rows, digest] = l.split("~|~");
    return { schema, name, rows: Number(rows), digest };
  });
  for (const table of [
    { schema: "vault", name: "secrets" },
    { schema: "cron", name: "job" },
    { schema: "net", name: "http_request_queue" },
    { schema: "pgsodium", name: "key" },
  ]) {
    assert.equal(classifyManagedRowState([...stock, { ...table, rows: 0, digest: "" }]).problemCount, 0,
      `an empty ${table.schema}.${table.name} was treated as application state`);
    const verdict = classifyManagedRowState([...stock, { ...table, rows: 1, digest: "" }]);
    assert.equal(verdict.problemCount, 1, `a populated ${table.schema}.${table.name} did not fail closed`);
    assert.match(verdict.problems[0], /no certified stock row state/, `${table.schema}.${table.name} failed for the wrong reason`);
  }
});

// ─── Constraint, sequence and ACL layers of the relation fingerprint ──────
//
// The sixteenth remediation fingerprinted columns, types, nullability, defaults,
// partition relationship, views, indexes, functions and types — but a table can be
// behaviourally altered through pg_constraint alone, and a CHECK or FK creates no
// pg_class object, so it was invisible to the whole inventory. Sequences fingerprinted
// as the literal string "sequence", and ACLs were not read at all.

/** A stock relation entry, with its definition reconstructed around a chosen part. */
const relationDefinition = ({ cols = "id:uuid:NN:", cons = "", acl = "(default)" } = {}) =>
  `relkind=r|parent=|bound=|cols=${cols}|cons=${cons}|acl=${acl}`;

test("relation fingerprint: CONSTRAINTS are part of the structure", () => {
  const base = relationDefinition({ cons: "p:t_pkey:PRIMARY KEY (id):NOTDEFERRABLE:INITIMMEDIATE:VALIDATED:" });
  // An added CHECK, a removed constraint, and a same-name/different-definition change
  // all move the fingerprint — none of them touch columns, so the previous fingerprint
  // could not see any of them.
  const added = relationDefinition({ cons: "c:t_chk:CHECK (length(name) < 10):NOTDEFERRABLE:INITIMMEDIATE:VALIDATED:,p:t_pkey:PRIMARY KEY (id):NOTDEFERRABLE:INITIMMEDIATE:VALIDATED:" });
  const removed = relationDefinition({ cons: "" });
  const altered = relationDefinition({ cons: "p:t_pkey:PRIMARY KEY (id):DEFERRABLE:INITIMMEDIATE:VALIDATED:" });
  for (const [label, variant] of [["added", added], ["removed", removed], ["altered", altered]]) {
    assert.notEqual(fingerprintDefinition(base), fingerprintDefinition(variant), `a ${label} constraint did not change the fingerprint`);
  }
  // The columns are identical across every variant: that is what made this invisible.
  const columnsOf = (d) => /\|cols=([^|]*)/.exec(d)[1];
  for (const variant of [added, removed, altered]) {
    assert.equal(columnsOf(base), columnsOf(variant), "precondition: the column list must be unchanged");
  }
});

test("relation fingerprint: a FOREIGN KEY carries its referenced relation and semantics", () => {
  const fk = (def, extra) => relationDefinition({ cons: `f:t_fk:${def}:NOTDEFERRABLE:INITIMMEDIATE:VALIDATED:${extra}` });
  const a = fk("FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id)", "storage.buckets");
  const b = fk("FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id) ON DELETE CASCADE", "storage.buckets");
  const c = fk("FOREIGN KEY (bucket_id) REFERENCES storage.other(id)", "storage.other");
  assert.notEqual(fingerprintDefinition(a), fingerprintDefinition(b), "ON DELETE semantics were not fingerprinted");
  assert.notEqual(fingerprintDefinition(a), fingerprintDefinition(c), "the referenced relation was not fingerprinted");
});

test("relation fingerprint: deferrability and validation state are fingerprinted", () => {
  const con = (deferrable, deferred, validated) =>
    relationDefinition({ cons: `f:t_fk:FOREIGN KEY (a) REFERENCES b(a):${deferrable}:${deferred}:${validated}:b` });
  const base = con("NOTDEFERRABLE", "INITIMMEDIATE", "VALIDATED");
  assert.notEqual(fingerprintDefinition(base), fingerprintDefinition(con("DEFERRABLE", "INITIMMEDIATE", "VALIDATED")), "deferrability was not fingerprinted");
  assert.notEqual(fingerprintDefinition(base), fingerprintDefinition(con("DEFERRABLE", "INITDEFERRED", "VALIDATED")), "initial deferral was not fingerprinted");
  assert.notEqual(fingerprintDefinition(base), fingerprintDefinition(con("NOTDEFERRABLE", "INITIMMEDIATE", "NOTVALIDATED")), "validation state was not fingerprinted");
});

test("relation fingerprint: a constraint change is REFUSED by the classifier, both directions", () => {
  const entry = STOCK_MANAGED_OBJECT_BASELINE.find((b) => b.schema === "storage" && b.name === "objects" && b.kind === "relation");
  assert.ok(entry, "storage.objects is not in the certified baseline");
  const tampered = wholeBaseline().map((b) =>
    b.schema === entry.schema && b.kind === entry.kind && b.name === entry.name
      ? { schema: b.schema, kind: b.kind, name: b.name, owner: b.owner, definition: relationDefinition({ cons: "c:injected:CHECK (true):NOTDEFERRABLE:INITIMMEDIATE:VALIDATED:" }) }
      : b);
  const verdict = classifyManagedSchemaObjects(tampered);
  assert.equal(verdict.nonStockCount, 1, "a constraint-mutated stock relation was accepted");
  assert.equal(verdict.missingStockCount, 1, "the certified relation was not reported missing");
});

test("sequence fingerprint: increment, bounds, cache and cycle are structure", () => {
  const seq = (o = {}) => {
    const { increment = 1, start = 1, min = 1, max = "9223372036854775807", cache = 1, cycle = "false", acl = "(default)" } = o;
    return `sequence|increment=${increment}|start=${start}|min=${min}|max=${max}|cache=${cache}|cycle=${cycle}|acl=${acl}`;
  };
  const base = seq();
  for (const [label, variant] of [
    ["increment", seq({ increment: 2 })],
    ["start", seq({ start: 100 })],
    ["min", seq({ min: 0 })],
    ["max", seq({ max: "42" })],
    ["cache", seq({ cache: 20 })],
    ["cycle", seq({ cycle: "true" })],
  ]) {
    assert.notEqual(fingerprintDefinition(base), fingerprintDefinition(variant), `an altered sequence ${label} did not change the fingerprint`);
  }
  // The previous fingerprint for EVERY sequence was the bare literal "sequence", so none
  // of the above was distinguishable.
  assert.equal(fingerprintDefinition("sequence"), fingerprintDefinition("sequence"), "sanity");
  assert.notEqual(fingerprintDefinition("sequence"), fingerprintDefinition(base), "the sequence fingerprint did not gain structure");
});

test("ACL: a grant change moves the fingerprint for relations, functions and types", () => {
  const rel = (acl) => relationDefinition({ acl });
  assert.notEqual(fingerprintDefinition(rel("(default)")), fingerprintDefinition(rel("anon=r/owner")), "a relation grant was not fingerprinted");
  assert.notEqual(
    fingerprintDefinition(rel("anon=arwdDxtm/owner")),
    fingerprintDefinition(rel("anon=arwdxtm/owner")),
    "a single revoked privilege was not fingerprinted",
  );
  const fn = (acl) => `ret=uuid|kind=f|vol=s|sec=invoker|body=abc|acl=${acl}`;
  assert.notEqual(fingerprintDefinition(fn("(default)")), fingerprintDefinition(fn("anon=X/owner")), "a function grant was not fingerprinted");
  const typ = (acl) => `typtype=e|enum=a,b|domainbase=|range=|attrs=|acl=${acl}`;
  assert.notEqual(fingerprintDefinition(typ("(default)")), fingerprintDefinition(typ("anon=U/owner")), "a type grant was not fingerprinted");
});

test("the certified baseline still classifies itself as exactly stock", () => {
  const verdict = classifyManagedSchemaObjects(wholeBaseline());
  assert.equal(verdict.nonStockCount, 0, `stock objects flagged: ${verdict.nonStock.slice(0, 3).join(", ")}`);
  assert.equal(verdict.missingStockCount, 0, `baseline objects reported missing: ${verdict.missingStock.slice(0, 3).join(", ")}`);
});

// ─── RLS state, function semantics, schema ACL and default privileges ─────
//
// Each of these was reproduced as a MATERIAL GAP against the previous head before it
// was fixed: the mutation changed the database, the old fingerprint stayed byte-
// identical, and the gate still certified the target as stock.

test("relation fingerprint: RLS state is structure", () => {
  const rel = (rls) => `relkind=r|parent=|bound=|cols=id:uuid:NN:|cons=|acl=(default)|rls=${rls}|replident=d`;
  const enabled = rel("true/false");
  assert.notEqual(fingerprintDefinition(enabled), fingerprintDefinition(rel("false/false")), "DISABLE ROW LEVEL SECURITY did not change the fingerprint");
  assert.notEqual(fingerprintDefinition(enabled), fingerprintDefinition(rel("true/true")), "FORCE ROW LEVEL SECURITY did not change the fingerprint");
  assert.notEqual(fingerprintDefinition(rel("false/false")), fingerprintDefinition(enabled), "ENABLE ROW LEVEL SECURITY did not change the fingerprint");
  // Columns, constraints, indexes and ACL are identical across all three.
  for (const variant of ["false/false", "true/true"]) {
    const [a, b] = [enabled, rel(variant)].map((d) => d.replace(/\|rls=[^|]*/, ""));
    assert.equal(a, b, "precondition: everything except RLS state must be identical");
  }
});

test("relation fingerprint: replica identity is part of the relation-level flags", () => {
  const rel = (ri) => `relkind=r|parent=|bound=|cols=id:uuid:NN:|cons=|acl=(default)|rls=true/false|replident=${ri}`;
  assert.notEqual(fingerprintDefinition(rel("d")), fingerprintDefinition(rel("f")), "replica identity was not fingerprinted");
});

test("relation fingerprint: RLS drift is REFUSED by the classifier, both directions", () => {
  const entry = STOCK_MANAGED_OBJECT_BASELINE.find((b) => b.schema === "storage" && b.name === "objects" && b.kind === "relation");
  assert.ok(entry, "storage.objects is not in the certified baseline");
  const tampered = wholeBaseline().map((b) =>
    b.schema === entry.schema && b.kind === entry.kind && b.name === entry.name
      ? { schema: b.schema, kind: b.kind, name: b.name, owner: b.owner, definition: "relkind=r|cols=id|cons=|acl=(default)|rls=false/false|replident=d" }
      : b);
  const verdict = classifyManagedSchemaObjects(tampered);
  assert.equal(verdict.nonStockCount, 1, "an RLS-mutated stock relation was accepted");
  assert.equal(verdict.missingStockCount, 1, "the certified relation was not reported missing");
});

test("function fingerprint: canonical definition plus behavioural attributes", () => {
  const fn = (o = {}) => {
    const { def = "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ select 1 $$", lang = "sql",
            strict = "false", parallel = "u", leakproof = "false", vol = "s", sec = "invoker", config = "(none)", acl = "(default)" } = o;
    return `def=${def}|lang=${lang}|strict=${strict}|parallel=${parallel}|leakproof=${leakproof}|vol=${vol}|sec=${sec}|config=${config}|acl=${acl}`;
  };
  const base = fn();
  for (const [label, variant] of [
    ["search_path/proconfig", fn({ config: "search_path=pg_catalog" })],
    ["STRICT", fn({ strict: "true" })],
    ["PARALLEL", fn({ parallel: "s" })],
    ["language", fn({ lang: "plpgsql" })],
    ["leakproof", fn({ leakproof: "true" })],
    ["volatility", fn({ vol: "i" })],
    ["security", fn({ sec: "definer" })],
    ["ACL", fn({ acl: "anon=X/owner" })],
    ["body", fn({ def: "CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ select 2 $$" })],
  ]) {
    assert.notEqual(fingerprintDefinition(base), fingerprintDefinition(variant), `an altered function ${label} did not change the fingerprint`);
  }
  // The body is identical across the first eight variants: prosrc alone proves nothing.
  const bodyOf = (d) => /AS \$\$(.*?)\$\$/.exec(d)?.[1];
  assert.equal(bodyOf(base), bodyOf(fn({ config: "search_path=pg_catalog" })), "precondition: the body must be unchanged");
});

const stockSchemaAcl = () => STOCK_MANAGED_SCHEMA_ACL.map((e) => ({ ...e }));

test("schema ACL: the certified stock grants are accepted", () => {
  const verdict = classifyManagedSchemaAcl(stockSchemaAcl());
  assert.equal(verdict.baselineSatisfied, true, `stock schema ACLs flagged: ${verdict.nonStock.join(", ")} / missing ${verdict.missingStock.join(", ")}`);
});

test("schema ACL: an ADDED grant is refused", () => {
  const drifted = stockSchemaAcl().map((e) => (e.schema === "storage" ? { ...e, acl: `${e.acl},anon=UC/supabase_admin` } : e));
  const verdict = classifyManagedSchemaAcl(drifted);
  assert.equal(verdict.nonStockCount, 1, "an added schema grant was accepted");
  assert.equal(verdict.missingStockCount, 1, "the certified schema ACL was not reported missing");
});

test("schema ACL: a REMOVED certified privilege is refused", () => {
  const drifted = stockSchemaAcl().map((e) => (e.schema === "storage" ? { ...e, acl: e.acl.split(",").slice(1).join(",") } : e));
  assert.equal(classifyManagedSchemaAcl(drifted).baselineSatisfied, false, "a removed schema privilege was accepted");
});

test("schema ACL: an entirely MISSING or UNKNOWN managed schema is refused", () => {
  assert.equal(classifyManagedSchemaAcl(stockSchemaAcl().slice(1)).missingStockCount, 1, "a missing managed schema was accepted");
  assert.equal(
    classifyManagedSchemaAcl([...stockSchemaAcl(), { schema: "brand_new_schema", acl: "(default)" }]).nonStockCount,
    1,
    "an unknown managed schema was accepted",
  );
});

const stockDefaultAcl = () => STOCK_DEFAULT_ACL.map((e) => ({ ...e }));

test("default privileges: the certified rule set is accepted", () => {
  assert.equal(classifyDefaultAcl(stockDefaultAcl()).baselineSatisfied, true, "the certified default-privilege set was flagged");
});

test("default privileges: an ADDED rule is refused", () => {
  const verdict = classifyDefaultAcl([...stockDefaultAcl(), { role: "postgres", schema: "storage", objtype: "r", acl: "anon=r/postgres" }]);
  assert.equal(verdict.nonStockCount, 1, "an added ALTER DEFAULT PRIVILEGES rule was accepted");
});

test("default privileges: a REMOVED or ALTERED rule is refused", () => {
  assert.equal(classifyDefaultAcl(stockDefaultAcl().slice(1)).missingStockCount, 1, "a removed default-privilege rule was accepted");
  const altered = stockDefaultAcl().map((e, i) => (i === 0 ? { ...e, acl: `${e.acl},anon=r/postgres` } : e));
  assert.equal(classifyDefaultAcl(altered).baselineSatisfied, false, "an altered default-privilege rule was accepted");
});

test("classifyObjectEmptiness: schema-ACL and default-privilege drift defeat emptiness", () => {
  for (const key of ["user_schema_acl", "user_default_acl"]) {
    const dirty = classifyObjectEmptiness({ [key]: 1 });
    assert.equal(dirty.empty, false, `${key}=1 still certified as application-empty`);
    assert.match(dirty.reason, new RegExp(`${key}=1`), `unexpected reason: ${dirty.reason}`);
  }
});

// ─── F2: extension name AND version ───────────────────────────────────────

const stockExtensions = () => STOCK_EXTENSION_BASELINE.map((e) => ({ ...e }));

test("classifyInstalledExtensions: the certified set at the certified versions is accepted", () => {
  const verdict = classifyInstalledExtensions(stockExtensions());
  assert.equal(verdict.baselineSatisfied, true, `stock extensions were flagged: ${verdict.nonStock.join(", ")} / missing ${verdict.missingStock.join(", ")}`);
});

test("classifyInstalledExtensions: an EXTRA extension is refused", () => {
  const verdict = classifyInstalledExtensions([...stockExtensions(), { name: "hstore", version: "1.8", schema: "extensions" }]);
  assert.equal(verdict.nonStockCount, 1, "an extra extension was accepted");
  assert.match(verdict.nonStock[0], /^hstore@1\.8@extensions$/, `unexpected finding: ${verdict.nonStock[0]}`);
});

test("classifyInstalledExtensions: a stock NAME at a DIFFERENT VERSION is refused", () => {
  const drifted = stockExtensions().map((e) => (e.name === "pgcrypto" ? { ...e, version: "1.2" } : e));
  const verdict = classifyInstalledExtensions(drifted);
  assert.equal(verdict.nonStockCount, 1, "a stock extension at an uncertified version was accepted");
  assert.equal(verdict.missingStockCount, 1, "the certified version was not reported missing");
  assert.equal(verdict.baselineSatisfied, false, "version drift satisfied the baseline");
});

test("classifyInstalledExtensions: a MISSING certified extension is drift", () => {
  const verdict = classifyInstalledExtensions(stockExtensions().slice(1));
  assert.equal(verdict.missingStockCount, 1, "a missing certified extension was not reported");
  assert.equal(verdict.baselineSatisfied, false, "a target missing a platform extension satisfied the baseline");
});

test("classifyInstalledExtensions: a DUPLICATED extension row is refused", () => {
  const dup = stockExtensions();
  const verdict = classifyInstalledExtensions([...dup, { ...dup[0] }]);
  assert.equal(verdict.nonStockCount, 1, "a duplicated extension row was consumed twice");
});

// ─── F3: certified managed row state ──────────────────────────────────────

const certifiedRowState = () =>
  Object.entries(STOCK_MANAGED_ROW_RULES)
    .filter(([, rule]) => rule.kind !== "history")
    .map(([qualified, rule]) => {
      const [schema, name] = qualified.split(".");
      return { schema, name, rows: rule.count, digest: rule.digest };
    });

test("classifyManagedRowState: the certified pristine row state is accepted", () => {
  const verdict = classifyManagedRowState(certifiedRowState());
  assert.equal(verdict.problemCount, 0, `pristine row state was flagged: ${verdict.problems.join("; ")}`);
});

test("classifyManagedRowState: an EXTRA row in a permitted table is refused", () => {
  const state = certifiedRowState().map((t) => (t.name === "schema_migrations" && t.schema === "auth" ? { ...t, rows: t.rows + 1 } : t));
  const verdict = classifyManagedRowState(state);
  assert.equal(verdict.problemCount, 1, "an extra ledger row was accepted");
  assert.match(verdict.problems[0], /auth\.schema_migrations=\d+ rows, certified/, `unexpected problem: ${verdict.problems[0]}`);
});

test("classifyManagedRowState: a MISSING required bootstrap row is refused", () => {
  const verdict = classifyManagedRowState(certifiedRowState().filter((t) => !(t.schema === "_realtime" && t.name === "tenants")));
  assert.equal(verdict.problemCount, 1, "a missing bootstrap row was accepted");
  assert.match(verdict.problems[0], /_realtime\.tenants is EMPTY/, `unexpected problem: ${verdict.problems[0]}`);
});

test("classifyManagedRowState: a MODIFIED stable bootstrap value is refused", () => {
  const state = certifiedRowState().map((t) => (t.schema === "_realtime" && t.name === "tenants" ? { ...t, digest: "0".repeat(32) } : t));
  const verdict = classifyManagedRowState(state);
  assert.equal(verdict.problemCount, 1, "an altered bootstrap row was accepted");
  assert.match(verdict.problems[0], /_realtime\.tenants row content differs/, `unexpected problem: ${verdict.problems[0]}`);
});

test("classifyManagedRowState: rows in a table with NO certified state are refused", () => {
  for (const [schema, name] of [["cron", "job"], ["vault", "secrets"], ["auth", "users"], ["storage", "buckets"], ["storage", "objects"]]) {
    const verdict = classifyManagedRowState([...certifiedRowState(), { schema, name, rows: 1, digest: "" }]);
    assert.equal(verdict.problemCount, 1, `a row in ${schema}.${name} was accepted`);
    assert.match(verdict.problems[0], new RegExp(`${schema}\\.${name}=1`), `unexpected problem: ${verdict.problems[0]}`);
  }
});

test("classifyManagedRowState: the migration ledger is NOT laundered through the row allowance", () => {
  // supabase_migrations.schema_migrations is governed by the migration-history contract
  // and counted as migration_rows; it must neither be flagged here nor excuse anything.
  const verdict = classifyManagedRowState([...certifiedRowState(), { schema: "supabase_migrations", name: "schema_migrations", rows: 161, digest: "" }]);
  assert.equal(verdict.problemCount, 0, `the migration ledger was flagged: ${verdict.problems.join("; ")}`);
  assert.equal(STOCK_MANAGED_ROW_RULES["supabase_migrations.schema_migrations"].kind, "history", "the ledger is not marked as history-governed");
});

test("classifyObjectEmptiness: the new managed categories all defeat application-emptiness", () => {
  assert.equal(classifyObjectEmptiness({}).empty, true, "an all-zero inventory was not empty");
  for (const key of ["user_managed_schema_objects", "user_extensions", "user_managed_table_rows"]) {
    const dirty = classifyObjectEmptiness({ [key]: 1 });
    assert.equal(dirty.empty, false, `${key}=1 still certified as application-empty`);
    assert.match(dirty.reason, new RegExp(`${key}=1`), `unexpected reason: ${dirty.reason}`);
  }
});

// ─── F5: local/remote ROW PAIRING must survive classification ──────────────

const table = (rows) =>
  ["   Local    |   Remote   |     Time", "  ---------|-----------|--------", ...rows].join("\n");
const row = (local, remote) => `   ${local ?? ""}   |   ${remote ?? ""}   | 2026-04-28`;

test("parseHostedMigrationList: SWAPPED local/remote pairs are reported as mismatched, not normalized", () => {
  const out = table([row("20260428120000", "20260501000000"), row("20260501000000", "20260428120000")]);
  const parsed = parseHostedMigrationList(out, ["20260428120000", "20260501000000"]);
  assert.equal(parsed.matchedRows, 0, "swapped rows produced matched rows");
  assert.equal(parsed.mismatchedPairs.length, 2, `swapped rows were not detected: ${JSON.stringify(parsed.mismatchedPairs)}`);
});

test("recognizeMigrationListRows: a swapped table FAILS CLOSED instead of being classified", () => {
  const out = table([row("20260428120000", "20260501000000"), row("20260501000000", "20260428120000")]);
  const parsed = parseHostedMigrationList(out, ["20260428120000", "20260501000000"]);
  const recognized = recognizeMigrationListRows(parsed.rows, ["20260428120000", "20260501000000"]);
  assert.equal(recognized.ok, false, "a shifted migration table was accepted as recognized output");
  assert.match(recognized.reason, /do not agree|not agree/, `unexpected reason: ${recognized.reason}`);
});

test("classifyHostedTarget: equal version SETS with zero matching ROWS are never repeatability", () => {
  const local = ["20260428120000", "20260501000000"];
  // The exact defect: sets are equal, so the set-only classifier said repeatability.
  const setOnly = classifyHostedTarget(local, local);
  assert.equal(setOnly.mode, "repeatability", "precondition: set comparison alone reports repeatability");
  const withPairing = classifyHostedTarget(local, local, {
    matchedRows: 0,
    mismatchedPairs: ["20260428120000!=20260501000000", "20260501000000!=20260428120000"],
    localMigrationCount: 2,
  });
  assert.equal(withPairing.mode, "fail", "a swapped pairing was still classified as repeatability");
  assert.match(withPairing.reason, /name different migrations/, `unexpected reason: ${withPairing.reason}`);
});

test("classifyHostedTarget: a partially-paired history is not repeatability even with equal sets", () => {
  const local = ["20260428120000", "20260501000000"];
  const verdict = classifyHostedTarget(local, local, { matchedRows: 1, mismatchedPairs: [], localMigrationCount: 2 });
  assert.equal(verdict.mode, "fail", "one matched row out of two was accepted as repeatability");
  assert.match(verdict.reason, /paired to the SAME remote version/, `unexpected reason: ${verdict.reason}`);
});

test("parseHostedMigrationList: A/A + B/B is a fully paired history", () => {
  const out = table([row("20260428120000", "20260428120000"), row("20260501000000", "20260501000000")]);
  const parsed = parseHostedMigrationList(out, ["20260428120000", "20260501000000"]);
  assert.equal(parsed.matchedRows, 2, "a correctly paired table did not report two matched rows");
  assert.deepEqual(parsed.mismatchedPairs, [], "a correctly paired table reported mismatches");
  assert.deepEqual(parsed.pendingLocal, [], "a correctly paired table reported pending local migrations");
  const verdict = classifyHostedTarget(["20260428120000", "20260501000000"], ["20260428120000", "20260501000000"], {
    matchedRows: parsed.matchedRows, mismatchedPairs: parsed.mismatchedPairs, localMigrationCount: 2,
  });
  assert.equal(verdict.mode, "repeatability", `a fully paired history was not repeatability: ${verdict.reason ?? ""}`);
});

test("parseHostedMigrationList: A/blank + B/blank is a FRESH remote history", () => {
  const out = table([row("20260428120000", null), row("20260501000000", null)]);
  const parsed = parseHostedMigrationList(out, ["20260428120000", "20260501000000"]);
  assert.deepEqual(parsed.mismatchedPairs, [], "a fresh table reported mismatched pairs");
  assert.equal(parsed.matchedRows, 0, "a fresh table reported matched rows");
  assert.deepEqual(parsed.unexpectedRemote, [], "a fresh table reported unexpected remote rows");
  const recognized = recognizeMigrationListRows(parsed.rows, ["20260428120000", "20260501000000"]);
  assert.equal(recognized.ok, true, `a fresh table was not recognized: ${recognized.reason ?? ""}`);
  const verdict = classifyHostedTarget([], ["20260428120000", "20260501000000"], {
    matchedRows: 0, mismatchedPairs: [], localMigrationCount: 2,
  });
  assert.equal(verdict.mode, "fresh", "an empty remote history was not classified fresh");
});

test("parseHostedMigrationList: A/A + B/blank is a pending delta, not repeatability", () => {
  const out = table([row("20260428120000", "20260428120000"), row("20260501000000", null)]);
  const parsed = parseHostedMigrationList(out, ["20260428120000", "20260501000000"]);
  assert.equal(parsed.matchedRows, 1, "a partial history did not report exactly one matched row");
  assert.deepEqual(parsed.pendingLocal, ["20260501000000"], `unexpected pending set: ${parsed.pendingLocal.join(",")}`);
  const verdict = classifyHostedTarget(["20260428120000"], ["20260428120000", "20260501000000"], {
    matchedRows: 1, mismatchedPairs: [], localMigrationCount: 2,
  });
  assert.equal(verdict.mode, "fail", "a partially-applied target was not refused");
});

test("parseHostedMigrationList: blank/A is unexpected remote drift", () => {
  const out = table([row(null, "20260901000000")]);
  const parsed = parseHostedMigrationList(out, ["20260428120000"]);
  assert.deepEqual(parsed.unexpectedRemote, ["20260901000000"], "a remote-only row was not reported as unexpected");
  assert.deepEqual(parsed.mismatchedPairs, [], "a remote-only row was reported as a mismatched pair");
});

test("parseHostedMigrationList: BACKTICK-rendered swapped pairs are also detected", () => {
  const out = table([
    "   `20260428120000`   |   `20260501000000`   | 2026-04-28",
    "   `20260501000000`   |   `20260428120000`   | 2026-05-01",
  ]);
  const parsed = parseHostedMigrationList(out, ["20260428120000", "20260501000000"]);
  assert.equal(parsed.mismatchedPairs.length, 2, "backtick-rendered swapped rows evaded pairing detection");
  assert.equal(parsed.matchedRows, 0, "backtick-rendered swapped rows reported matched rows");
});

// ─── F5 (extended): one-sided and duplicate rows must reach classification ──

test("parseHostedMigrationList: a stray remote-only row is reported, not absorbed", () => {
  const out = table([row("20260428120000", "20260428120000"), row("20260501000000", "20260501000000"), row(null, "20260428120000")]);
  const parsed = parseHostedMigrationList(out, ["20260428120000", "20260501000000"]);
  assert.equal(parsed.matchedRows, 2, "the two genuine pairs were not matched");
  assert.deepEqual(parsed.unexpectedRemote, ["20260428120000"], `stray row not reported: ${JSON.stringify(parsed.unexpectedRemote)}`);
  assert.equal(parsed.duplicateRemote.length, 1, "the duplicated remote version was not reported");
});

test("classifyHostedTarget: A|A + B|B + |A is NOT repeatability", () => {
  const local = ["20260428120000", "20260501000000"];
  const out = table([row("20260428120000", "20260428120000"), row("20260501000000", "20260501000000"), row(null, "20260428120000")]);
  const parsed = parseHostedMigrationList(out, local);
  // Set equality alone still says repeatability — which is exactly the defect.
  assert.equal(classifyHostedTarget(local, local).mode, "repeatability", "precondition: set-only classification passes");
  const verdict = classifyHostedTarget(local, local, {
    matchedRows: parsed.matchedRows,
    mismatchedPairs: parsed.mismatchedPairs,
    unexpectedRemote: parsed.unexpectedRemote,
    duplicateRemote: parsed.duplicateRemote,
    localMigrationCount: 2,
  });
  assert.equal(verdict.mode, "fail", "a stray remote-only row was normalized into a complete history");
  assert.match(verdict.reason, /row anomaly|anomalies/, `unexpected reason: ${verdict.reason}`);
});

test("verifyHostedRepeatability-shaped input: duplicate remote versions are refused", () => {
  const out = table([row("20260428120000", "20260428120000"), row("20260501000000", "20260428120000")]);
  const parsed = parseHostedMigrationList(out, ["20260428120000", "20260501000000"]);
  assert.ok(parsed.mismatchedPairs.length > 0 || parsed.duplicateRemote.length > 0, "neither mismatch nor duplication was detected");
});

// ─── Row-anomaly evidence must survive the LIVE applyHosted handoff ───────
//
// `classifyHostedTarget` has refused row anomalies since the sixteenth remediation, but
// `applyHosted` passed it a hand-picked subset of the parser's evidence — matchedRows,
// mismatchedPairs, localMigrationCount — and dropped unexpectedRemote and
// duplicateRemote. The classifier read those through `?? []`, so on the LIVE path the
// refusal was dead code. These cases drive the real `applyHosted` entry point through its
// runner seam, not `classifyHostedTarget` directly, because direct invocation is exactly
// what hid the defect.

const MALFORMED_TABLE = [
  "   Local      | Remote     | Time",
  "  -----------|------------|------",
  "   20260428120000 | 20260428120000 | 2026-04-28",
  "   20260501000000 | 20260501000000 | 2026-05-01",
  "                  | 20260428120000 | 2026-04-28",
].join("\n");

/** Drives applyHosted offline: no network, no credentials, no destructive action. */
function applyHostedWithMigrationList(stdout, files) {
  const savedEnv = { ...process.env };
  const savedExit = process.exitCode;
  const calls = [];
  try {
    Object.assign(process.env, {
      SUPABASE_PROJECT_REF: REF,
      FRESH_DB_EXPECTED_PROJECT_REF: REF,
      SUPABASE_DB_URL: `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
      SUPABASE_ACCESS_TOKEN: "sbp_test_token_not_real",
    });
    const runner = (args) => {
      calls.push(args.join(" "));
      if (args.includes("link")) return { status: 0, stdout: "", stderr: "" };
      if (args.includes("list")) return { status: 0, stdout, stderr: "" };
      // Anything else — above all `db push` — would be a destructive step this case must
      // prove is never reached.
      return { status: 0, stdout: "", stderr: "" };
    };
    return { result: applyHosted(files, runner), calls };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    process.exitCode = savedExit;
  }
}

test("applyHosted: a malformed migration table cannot be normalized into REPEATABILITY", () => {
  const files = ["20260428120000_a.sql", "20260501000000_b.sql"];
  // Precondition: the parser DOES recognize the anomalies, so any failure below is the
  // handoff and not the parser.
  const parsed = parseHostedMigrationList(MALFORMED_TABLE, ["20260428120000", "20260501000000"]);
  assert.equal(parsed.matchedRows, 2, "precondition: both genuine pairs must match");
  assert.deepEqual(parsed.mismatchedPairs, [], "precondition: no row has two disagreeing cells");
  assert.deepEqual(parsed.unexpectedRemote, ["20260428120000"], `precondition: the remote-only row must be seen: ${JSON.stringify(parsed.unexpectedRemote)}`);
  assert.equal(parsed.duplicateRemote.length, 1, "precondition: the duplicated remote version must be seen");
  assert.deepEqual(parsed.pendingLocal, [], "precondition: both local versions are paired");
  // And the version SET alone is equal to local history — which is why this shape was
  // dangerous: set comparison on its own reports repeatability.
  const remoteSet = [...new Set(parsed.rows.map((r) => r.remote).filter(Boolean))].sort();
  assert.deepEqual(remoteSet, ["20260428120000", "20260501000000"], "precondition: the deduplicated remote set equals local history");
  assert.equal(classifyHostedTarget(remoteSet, ["20260428120000", "20260501000000"]).mode, "repeatability",
    "precondition: without row evidence the classifier reports repeatability");

  const { result, calls } = applyHostedWithMigrationList(MALFORMED_TABLE, files);

  assert.equal(result.ok, false, "a malformed migration table was accepted by the live apply path");
  assert.equal(result.failedFile, "(hosted target classification)", `refused at the wrong stage: ${result.failedFile}`);
  assert.match(String(result.reason), /row anomal/i, `the row-anomaly reason did not reach the result: ${result.reason}`);
  assert.match(String(result.reason), /remote-only|duplicate remote/, `the specific anomaly was not named: ${result.reason}`);
  // DB_PUSH_REACHED=NO — proven from what the runner was actually asked to do.
  assert.equal(calls.some((c) => /\bdb push\b|db.*push/.test(c)), false, `a destructive push was reached: ${calls.join(" | ")}`);
  assert.equal(calls.some((c) => c.includes("push")), false, `a push command was reached: ${calls.join(" | ")}`);
});

test("applyHosted: a genuinely clean history still classifies (the fix refuses nothing extra)", () => {
  const clean = [
    "   Local      | Remote     | Time",
    "  -----------|------------|------",
    "   20260428120000 | 20260428120000 | 2026-04-28",
    "   20260501000000 | 20260501000000 | 2026-05-01",
  ].join("\n");
  const parsed = parseHostedMigrationList(clean, ["20260428120000", "20260501000000"]);
  assert.equal(parsed.matchedRows, 2);
  assert.deepEqual(parsed.unexpectedRemote, []);
  assert.deepEqual(parsed.duplicateRemote, []);
  const { result } = applyHostedWithMigrationList(clean, ["20260428120000_a.sql", "20260501000000_b.sql"]);
  // Repeatability proceeds past classification; it must NOT be refused as an anomaly.
  assert.notEqual(result.failedFile, "(hosted target classification)",
    `a clean history was refused at classification: ${result.reason}`);
});

test("readHostedMigrationVersions: the pairing record carries EVERY parser anomaly field", () => {
  // Behavioural, not textual. Remediation 21 asserted this by grepping for field NAMES in
  // the hand-written record — which could only ever prove the fields someone remembered to
  // name. The record is now spread from the parser, so the property is checked the only way
  // that actually proves it: every key the parser produces (except the raw rows) must
  // appear in what classification receives.
  const parsed = parseHostedMigrationList(LOCAL_ONLY_TABLE, ["20260428120000", "20260501000000"]);
  const expected = Object.keys(parsed).filter((k) => k !== "rows").sort();
  let seen = null;
  const savedEnv = { ...process.env };
  const savedExit = process.exitCode;
  try {
    Object.assign(process.env, {
      SUPABASE_PROJECT_REF: REF,
      FRESH_DB_EXPECTED_PROJECT_REF: REF,
      SUPABASE_DB_URL: `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
      SUPABASE_ACCESS_TOKEN: "sbp_test_token_not_real",
    });
    const runner = (args) => args.includes("link")
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 0, stdout: LOCAL_ONLY_TABLE, stderr: "" };
    const history = readHostedMigrationVersions(["20260428120000", "20260501000000"], runner);
    assert.equal(history.ok, true, `the migration list was not recognized: ${history.reason ?? ""}`);
    seen = Object.keys(history.pairing).sort();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    process.exitCode = savedExit;
  }
  for (const key of expected) {
    assert.ok(seen.includes(key), `the pairing record drops the parser field ${key}`);
  }
  assert.ok(seen.includes("localMigrationCount"), "the pairing record lost localMigrationCount");

  // ...and applyHosted must forward it wholesale rather than re-listing fields.
  const source = readFileSync(SCRIPT, "utf8");
  const applySrc = source.slice(source.indexOf("function applyHosted"));
  assert.match(applySrc.slice(0, applySrc.indexOf("db push")), /classifyHostedTarget\(history\.remoteVersions, localTimestamps, history\.pairing\)/,
    "applyHosted no longer forwards the whole pairing record");
});

// ─── Local-side one-sided row anomalies (remediation 22) ──────────────────
//
// `pendingLocal` answers "does this version have a correctly paired row ANYWHERE", so a
// stray local-only row for a version that IS paired elsewhere vanishes from it. The table
//
//     A | A
//     B | B
//     A |
//
// therefore produced every anomaly field empty, deduplicated to a remote set equal to
// local history, and certified as REPEATABILITY.

const LOCAL_ONLY_TABLE = [
  "   Local      | Remote     | Time",
  "  -----------|------------|------",
  "   20260428120000 | 20260428120000 | 2026-04-28",
  "   20260501000000 | 20260501000000 | 2026-05-01",
  "   20260428120000 |                | 2026-04-28",
].join("\n");

test("parseHostedMigrationList: a stray LOCAL-ONLY row is preserved as explicit evidence", () => {
  const parsed = parseHostedMigrationList(LOCAL_ONLY_TABLE, ["20260428120000", "20260501000000"]);
  // The facts that made this invisible are all still true...
  assert.equal(parsed.matchedRows, 2, "both genuine pairs must still match");
  assert.deepEqual(parsed.mismatchedPairs, [], "no row has two disagreeing cells");
  assert.deepEqual(parsed.duplicateRemote, [], "the remote column carries no duplicate");
  assert.deepEqual(parsed.unexpectedRemote, [], "there is no remote-only row");
  assert.deepEqual(parsed.pendingLocal, [], "A is paired elsewhere, so it is not pending — this is the blind spot");
  // ...and the anomaly is now recorded on the local side.
  assert.deepEqual(parsed.localOnly, ["20260428120000"], `the local-only row was not recorded: ${JSON.stringify(parsed.localOnly)}`);
  assert.equal(parsed.duplicateLocal.length, 1, "the duplicated local version was not recorded");
  assert.match(parsed.duplicateLocal[0], /^20260428120000x2$/, `unexpected duplicate-local evidence: ${parsed.duplicateLocal[0]}`);
});

test("parseHostedMigrationList: a DUPLICATE matched local row is recorded on both sides", () => {
  const dup = [
    "   Local      | Remote     | Time",
    "  -----------|------------|------",
    "   20260428120000 | 20260428120000 | 2026-04-28",
    "   20260428120000 | 20260428120000 | 2026-04-28",
    "   20260501000000 | 20260501000000 | 2026-05-01",
  ].join("\n");
  const parsed = parseHostedMigrationList(dup, ["20260428120000", "20260501000000"]);
  // duplicateRemote already caught this shape; duplicateLocal is asserted deliberately
  // rather than assumed to be covered by it.
  assert.equal(parsed.duplicateRemote.length, 1, "the duplicated remote version was not recorded");
  assert.equal(parsed.duplicateLocal.length, 1, "the duplicated local version was not recorded");
});

test("parseHostedMigrationList: local-only rows are NORMAL on a fresh target", () => {
  // Every row is local-only against an empty remote; that must not be an anomaly.
  const fresh = [
    "   Local      | Remote     | Time",
    "  -----------|------------|------",
    "   20260428120000 |                | 2026-04-28",
    "   20260501000000 |                | 2026-05-01",
  ].join("\n");
  const parsed = parseHostedMigrationList(fresh, ["20260428120000", "20260501000000"]);
  assert.equal(parsed.localOnly.length, 2, "a fresh target's rows are local-only by definition");
  assert.deepEqual(parsed.duplicateLocal, [], "distinct local-only rows are not duplicates");
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget([], ["20260428120000", "20260501000000"], { ...evidence, localMigrationCount: 2 }).mode,
    "fresh", "a fresh remote history was refused as a local-side anomaly");
});

test("applyHosted: a stray LOCAL-ONLY row cannot be normalized into REPEATABILITY", () => {
  const files = ["20260428120000_a.sql", "20260501000000_b.sql"];
  // Precondition: without the local-side evidence this shape reads as repeatability.
  const parsed = parseHostedMigrationList(LOCAL_ONLY_TABLE, ["20260428120000", "20260501000000"]);
  const remoteSet = [...new Set(parsed.rows.map((r) => r.remote).filter(Boolean))].sort();
  assert.equal(
    classifyHostedTarget(remoteSet, ["20260428120000", "20260501000000"], {
      matchedRows: parsed.matchedRows, mismatchedPairs: parsed.mismatchedPairs,
      unexpectedRemote: parsed.unexpectedRemote, duplicateRemote: parsed.duplicateRemote,
      pendingLocal: parsed.pendingLocal, localMigrationCount: 2,
    }).mode,
    "repeatability",
    "precondition: with only the pre-remediation-22 evidence this shape reports repeatability",
  );

  const { result, calls } = applyHostedWithMigrationList(LOCAL_ONLY_TABLE, files);
  assert.equal(result.ok, false, "a stray local-only row was accepted by the live apply path");
  assert.equal(result.failedFile, "(hosted target classification)", `refused at the wrong stage: ${result.failedFile}`);
  assert.match(String(result.reason), /duplicate local/, `the local-side anomaly was not named: ${result.reason}`);
  assert.equal(calls.some((c) => c.includes("push")), false, `a destructive push was reached: ${calls.join(" | ")}`);
});

test("readHostedMigrationVersions: the pairing record is DERIVED from the parser, not re-listed", () => {
  // Remediation 21 claimed a parser field could never again be dropped while still naming
  // fields by hand — which was not literally true, as `localOnly`/`duplicateLocal` showed.
  // The record is now spread from the parser's own evidence.
  const source = readFileSync(SCRIPT, "utf8");
  const pairing = source.slice(source.indexOf("const { rows: _rows, ...rowEvidence } = parsed;"), source.indexOf("return {", source.indexOf("const { rows: _rows")));
  assert.match(pairing, /\.\.\.rowEvidence/, "the pairing record no longer spreads the parser's evidence");
  assert.doesNotMatch(pairing, /matchedRows:|unexpectedRemote:|duplicateRemote:|localOnly:|duplicateLocal:/,
    "the pairing record went back to naming parser fields by hand, which is how a field gets dropped");
});

// ─── Unexpected Local migration provenance (remediation 23) ───────────────
//
// Row SHAPE cannot express provenance. `localOnly` is the canonical shape of a fresh
// target, so it is never an anomaly by itself — but a Local cell naming a migration this
// repository does not contain is unexplainable in either direction. It made
//   A|A  B|B  X|   read as REPEATABILITY (the remote set still equalled local history)
//   A|   B|   X|   read as FRESH        (every row was legitimately local-only)

const LOCALS = ["20260428120000", "20260501000000"];
const UNKNOWN_LOCAL = "20260601000000";
const migrationTable = (rows) =>
  ["   Local      | Remote     | Time", "  -----------|------------|------", ...rows].join("\n");
const migrationRow = (local, remote) => `   ${local ?? ""}   |   ${remote ?? ""}   | x`;

const MALFORMED_REPEATABILITY = migrationTable([
  migrationRow(LOCALS[0], LOCALS[0]),
  migrationRow(LOCALS[1], LOCALS[1]),
  migrationRow(UNKNOWN_LOCAL, null),
]);
const MALFORMED_FRESH = migrationTable([
  migrationRow(LOCALS[0], null),
  migrationRow(LOCALS[1], null),
  migrationRow(UNKNOWN_LOCAL, null),
]);

test("parseHostedMigrationList: an UNKNOWN Local version is recorded as unexpectedLocal", () => {
  const parsed = parseHostedMigrationList(MALFORMED_REPEATABILITY, LOCALS);
  assert.deepEqual(parsed.unexpectedLocal, [UNKNOWN_LOCAL], `the unknown Local version was not recorded: ${JSON.stringify(parsed.unexpectedLocal)}`);
  // The facts that let it through are all still true, which is why a new one was needed.
  assert.deepEqual(parsed.mismatchedPairs, []);
  assert.deepEqual(parsed.duplicateLocal, []);
  assert.deepEqual(parsed.duplicateRemote, []);
  assert.deepEqual(parsed.unexpectedRemote, []);
  assert.deepEqual(parsed.pendingLocal, [], "both expected locals are paired, so none is pending");
  assert.equal(parsed.matchedRows, 2);
  // localOnly keeps its ROW-SHAPE meaning and is not redefined.
  assert.deepEqual(parsed.localOnly, [UNKNOWN_LOCAL], "localOnly must still mean Local populated / Remote blank");
});

test("CASE A — malformed repeatability is REFUSED, and never reaches a push", () => {
  const parsed = parseHostedMigrationList(MALFORMED_REPEATABILITY, LOCALS);
  // UNEXPECTED_LOCAL_DETECTED=YES
  assert.equal(parsed.unexpectedLocal.length, 1);
  // Refused at recognition, the earliest point...
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS).ok, false, "recognition accepted an unknown Local version");
  // ...and again at classification, for callers that reach it directly.
  const remote = [...new Set(parsed.rows.map((r) => r.remote).filter(Boolean))];
  const { rows: _r, ...evidence } = parsed;
  const classified = classifyHostedTarget(remote, LOCALS, { ...evidence, localMigrationCount: 2 });
  assert.equal(classified.mode, "fail", `REPEATABILITY=NO expected, got ${classified.mode}`);
  assert.match(String(classified.reason), /unknown local/, `the anomaly was not named: ${classified.reason}`);

  // LIVE PATH: through the real applyHosted runner seam.
  const { result, calls } = applyHostedWithMigrationList(MALFORMED_REPEATABILITY, ["20260428120000_a.sql", "20260501000000_b.sql"]);
  assert.equal(result.ok, false, "the live apply path accepted an unknown Local version");
  assert.match(String(result.reason), /does not contain|unknown local/i, `the actionable reason was lost: ${result.reason}`);
  assert.equal(calls.some((c) => c.includes("push")), false, `DB_PUSH_REACHED: ${calls.join(" | ")}`);
});

test("CASE B — malformed FRESH is REFUSED, and never reaches a push", () => {
  const parsed = parseHostedMigrationList(MALFORMED_FRESH, LOCALS);
  assert.equal(parsed.unexpectedLocal.length, 1, "UNEXPECTED_LOCAL_DETECTED=NO");
  // The fresh path is why recognition, not classification alone, has to refuse: with an
  // empty remote history the classifier has no remote version to object to.
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS).ok, false, "recognition accepted an unknown Local version on a fresh target");
  const { rows: _r, ...evidence } = parsed;
  const classified = classifyHostedTarget([], LOCALS, { ...evidence, localMigrationCount: 2 });
  assert.equal(classified.mode, "fail", `FRESH=NO expected, got ${classified.mode}`);

  const { result, calls } = applyHostedWithMigrationList(MALFORMED_FRESH, ["20260428120000_a.sql", "20260501000000_b.sql"]);
  assert.equal(result.ok, false, "the live apply path accepted a malformed fresh target");
  assert.equal(calls.some((c) => c.includes("push")), false, `DB_PUSH_REACHED: ${calls.join(" | ")}`);
});

test("CASE C — a legitimate FRESH target is still accepted", () => {
  const clean = migrationTable([migrationRow(LOCALS[0], null), migrationRow(LOCALS[1], null)]);
  const parsed = parseHostedMigrationList(clean, LOCALS);
  assert.deepEqual(parsed.unexpectedLocal, [], "a legitimate fresh target reported an unknown Local version");
  assert.equal(parsed.localOnly.length, 2, "every row on a fresh target is local-only");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS).ok, true, "a legitimate fresh table was not recognized");
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget([], LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "fresh",
    "a legitimate fresh target was refused");
});

test("CASE D — legitimate REPEATABILITY is still accepted", () => {
  const clean = migrationTable([migrationRow(LOCALS[0], LOCALS[0]), migrationRow(LOCALS[1], LOCALS[1])]);
  const parsed = parseHostedMigrationList(clean, LOCALS);
  assert.deepEqual(parsed.unexpectedLocal, [], "a legitimate history reported an unknown Local version");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS).ok, true, "a legitimate history was not recognized");
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget(LOCALS, LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "repeatability",
    "a legitimate matching history was refused");
});

test("verifyHostedRepeatability refuses an unknown Local version independently", () => {
  // It consumes parser output directly, so it carries its own refusal rather than relying
  // on a caller having gone through recognition first.
  const source = readFileSync(SCRIPT, "utf8");
  const verifySrc = source.slice(source.indexOf("function verifyHostedRepeatability"));
  assert.match(verifySrc.slice(0, verifySrc.indexOf("return { ok: true")), /parsed\.unexpectedLocal\.length > 0/,
    "verifyHostedRepeatability does not refuse unknown Local versions");
});

// ─── Invalid inventory must abort BEFORE any database action (remediation 24) ──
//
// The gate used to record "Migration inventory FAIL", set exitCode 1, and then carry on
// into applyLocal/applyHosted anyway — so a source tree it had already judged invalid
// still reached psql, `supabase link`, target classification and potentially `db push`.
// These cases run the REAL script entrypoint in an isolated cwd, because the defect was
// in orchestration after checkInventoryAndOrdering had already detected the problem.

/**
 * Runs the real script in a throwaway cwd.
 *
 * PATH is emptied so `psql` and `npx` cannot resolve AT ALL. That is what turns "we
 * believe the abort happened" into proof: if execution ever reached an apply function,
 * the run would die with a spawn failure naming that command instead of stopping at the
 * inventory phase. Node itself is invoked by absolute path, so it is unaffected.
 */
function runGateInIsolatedTree(migrationFiles, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fresh-db-inventory-"));
  try {
    mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(dir, "supabase", "roles.sql"), "-- roles\n");
    for (const name of migrationFiles) writeFileSync(path.join(dir, "supabase", "migrations", name), "select 1;\n");
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: "", Path: "", SystemRoot: process.env.SystemRoot ?? "", HOME: dir,
        ALLOW_DESTRUCTIVE_FRESH_DB_TEST: "true",
        // A loopback URL with nothing listening; with PATH empty no client exists anyway.
        FRESH_DB_URL: "postgresql://postgres:pw@127.0.0.1:5/postgres",
        ...env,
      },
    });
    return { ...run, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("invalid migration inventory ABORTS before any database action (local mode)", () => {
  // Duplicate timestamp, different filenames — a defect the inventory check already found.
  const run = runGateInIsolatedTree(["20260904120000_alpha.sql", "20260904120000_beta.sql"]);

  assert.notEqual(run.status, 0, "EXIT_NONZERO=NO — an invalid inventory exited successfully");
  assert.match(run.output, /Migration inventory\.+ FAIL/, "MIGRATION_INVENTORY_FAIL_REPORTED=NO");
  assert.match(run.output, /Migration ordering\.+ FAIL/, "MIGRATION_ORDERING_FAIL_REPORTED=NO");
  assert.match(run.output, /aborting before any database action/, "the abort was not reported");

  // The load-bearing assertions: no database-facing step was reached. With PATH empty,
  // reaching one would surface as a spawn failure naming it.
  assert.doesNotMatch(run.output, /Fresh apply/, "APPLY_REACHED=YES — execution continued past the inventory gate");
  assert.doesNotMatch(run.output, /\bpsql\b/i, "DATABASE_COMMAND_REACHED=YES (psql)");
  assert.doesNotMatch(run.output, /supabase link|migration list|db push|npx/i, "DATABASE_COMMAND_REACHED=YES (supabase CLI)");
  assert.doesNotMatch(run.output, /ENOENT|spawnSync/i, "a spawn was attempted, so an apply function was entered");
});

test("invalid migration inventory ABORTS before any database action (hosted mode)", () => {
  // The abort sits ABOVE the mode branch, so one gate covers both. This proves it rather
  // than asserting it from code shape: hosted mode needs all three hosted variables, and
  // the run must still stop at the inventory phase without a link or a migration list.
  // The ALLOWLISTED validation ref, so the run gets past the environment safety guard and
  // actually reaches the inventory phase. (A non-allowlisted ref is refused even earlier,
  // which is correct but would not exercise this remediation.) PATH is still empty, so no
  // Supabase CLI exists and nothing destructive is reachable regardless.
  const run = runGateInIsolatedTree(["20260904120000_alpha.sql", "20260904120000_beta.sql"], {
    FRESH_DB_URL: "",
    SUPABASE_DB_URL: `postgresql://postgres:pw@db.${HOSTED_ALLOWED_VALIDATION_REFS[0]}.supabase.co:5432/postgres`,
    SUPABASE_ACCESS_TOKEN: "sbp_not_a_real_token",
    SUPABASE_PROJECT_REF: HOSTED_ALLOWED_VALIDATION_REFS[0],
    FRESH_DB_EXPECTED_PROJECT_REF: HOSTED_ALLOWED_VALIDATION_REFS[0],
  });
  assert.notEqual(run.status, 0, "EXIT_NONZERO=NO in hosted mode");
  assert.match(run.output, /Migration inventory\.+ FAIL/, "the inventory failure was not reported in hosted mode");
  assert.match(run.output, /aborting before any database action/, "the hosted run did not abort at the inventory gate");
  assert.doesNotMatch(run.output, /supabase link|migration list|db push/i, "APPLY_HOSTED_REACHED=YES");
  assert.doesNotMatch(run.output, /Fresh apply/, "execution continued past the inventory gate in hosted mode");
});

test("a VALID migration inventory still proceeds past the inventory phase", () => {
  // Non-regression, proven at an observable boundary: with PATH empty the apply step must
  // be REACHED and fail there — which is exactly what the invalid case must never do.
  const run = runGateInIsolatedTree(["20260904120000_alpha.sql", "20260905120000_beta.sql"]);
  assert.match(run.output, /Migration inventory\.+ PASS/, "a valid inventory was reported as failing");
  assert.match(run.output, /Migration ordering\.+ PASS/, "a valid ordering was reported as failing");
  assert.doesNotMatch(run.output, /aborting before any database action/, "a valid inventory was aborted at the gate");
  assert.match(run.output, /Fresh apply/, "a valid inventory did not reach the apply phase");
});

// ─── Partially-parseable migration rows (remediation 25) ──────────────────
//
// The parser skipped a row whenever EITHER cell failed to parse, which threw away rows
// whose OTHER cell held a perfectly valid migration version. `garbage | X` vanished, and
// what remained read as a complete matching history (REPEATABILITY) or as an untouched
// target (FRESH). Headers and separators carry no valid version on either side and must
// stay ignorable.

const GARBAGE_REMOTE = migrationTable([
  migrationRow(LOCALS[0], LOCALS[0]),
  migrationRow(LOCALS[1], LOCALS[1]),
  migrationRow("garbage", UNKNOWN_LOCAL),
]);
const GARBAGE_REMOTE_FRESH = migrationTable([
  migrationRow(LOCALS[0], null),
  migrationRow(LOCALS[1], null),
  migrationRow("garbage", UNKNOWN_LOCAL),
]);
const GARBAGE_LOCAL_SIDE = migrationTable([
  migrationRow(LOCALS[0], "garbage"),
  migrationRow(LOCALS[1], LOCALS[1]),
]);

test("parseHostedMigrationList: a partially-parseable row is recorded, not dropped", () => {
  const parsed = parseHostedMigrationList(GARBAGE_REMOTE, LOCALS);
  assert.equal(parsed.malformedMigrationRows.length, 1, "the partially-parseable row was dropped as chatter");
  assert.match(parsed.malformedMigrationRows[0], /garbage\|20260601000000/, `unexpected evidence: ${parsed.malformedMigrationRows[0]}`);
  // Everything else still looks clean, which is exactly why the row had to be recorded.
  assert.equal(parsed.matchedRows, 2);
  assert.deepEqual(parsed.mismatchedPairs, []);
  assert.deepEqual(parsed.unexpectedRemote, []);
  assert.deepEqual(parsed.unexpectedLocal, []);
});

test("CASE A — a dropped row must not yield REPEATABILITY, and never reaches a push", () => {
  const parsed = parseHostedMigrationList(GARBAGE_REMOTE, LOCALS);
  assert.equal(parsed.malformedMigrationRows.length, 1, "MALFORMED_ROW_DETECTED=NO");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, false,
    "recognition accepted a partially-parseable row");
  const { rows: _r, ...evidence } = parsed;
  const remote = [...new Set(parsed.rows.map((r) => r.remote).filter(Boolean))];
  const classified = classifyHostedTarget(remote, LOCALS, { ...evidence, localMigrationCount: 2 });
  assert.equal(classified.mode, "fail", `REPEATABILITY=NO expected, got ${classified.mode}`);
  assert.match(String(classified.reason), /unreadable row/, `the anomaly was not named: ${classified.reason}`);

  const { result, calls } = applyHostedWithMigrationList(GARBAGE_REMOTE, ["20260428120000_a.sql", "20260501000000_b.sql"]);
  assert.equal(result.ok, false, "the live apply path accepted a partially-parseable row");
  assert.match(String(result.reason), /could not read|unreadable row/i, `the actionable reason was lost: ${result.reason}`);
  assert.equal(calls.some((c) => c.includes("push")), false, `DB_PUSH_REACHED: ${calls.join(" | ")}`);
});

test("CASE B — a dropped row must not yield FRESH, and never reaches a push", () => {
  const parsed = parseHostedMigrationList(GARBAGE_REMOTE_FRESH, LOCALS);
  assert.equal(parsed.malformedMigrationRows.length, 1, "MALFORMED_ROW_DETECTED=NO");
  // The fresh shape is why recognition carries the refusal: the dropped row held the ONLY
  // remote version, so the classifier's set logic would have had nothing to object to.
  const remote = [...new Set(parsed.rows.map((r) => r.remote).filter(Boolean))];
  assert.deepEqual(remote, [], "precondition: the surviving rows leave the remote history empty");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, false,
    "recognition accepted a partially-parseable row on a fresh target");
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget(remote, LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "fail",
    "FRESH=NO expected");

  const { result, calls } = applyHostedWithMigrationList(GARBAGE_REMOTE_FRESH, ["20260428120000_a.sql", "20260501000000_b.sql"]);
  assert.equal(result.ok, false, "the live apply path accepted a malformed fresh target");
  assert.equal(calls.some((c) => c.includes("push")), false, `DB_PUSH_REACHED: ${calls.join(" | ")}`);
});

test("CASE C — the OPPOSITE malformed side is refused too", () => {
  const parsed = parseHostedMigrationList(GARBAGE_LOCAL_SIDE, LOCALS);
  assert.equal(parsed.malformedMigrationRows.length, 1, "a valid Local with an unreadable Remote was dropped");
  assert.match(parsed.malformedMigrationRows[0], /20260428120000\|garbage/, `unexpected evidence: ${parsed.malformedMigrationRows[0]}`);
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, false, "recognition accepted it");
  const { rows: _r, ...evidence } = parsed;
  const remote = [...new Set(parsed.rows.map((r) => r.remote).filter(Boolean))];
  assert.equal(classifyHostedTarget(remote, LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "fail", "classification accepted it");
});

test("CASE D — headers and separators remain ignorable chatter", () => {
  // Neither side carries a valid version, so nothing is flagged.
  const parsed = parseHostedMigrationList(migrationTable([]), LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, [], "a header or separator was treated as migration corruption");
  const noisy = [
    "Connecting to remote database...",
    "   Local      | Remote     | Time",
    "  -----------|------------|------",
    "   20260428120000 | 20260428120000 | 2026-04-28",
    "   20260501000000 | 20260501000000 | 2026-05-01",
    "Finished supabase migration list.",
  ].join("\n");
  const parsedNoisy = parseHostedMigrationList(noisy, LOCALS);
  assert.deepEqual(parsedNoisy.malformedMigrationRows, [], "ordinary CLI chatter was treated as migration corruption");
  assert.equal(parsedNoisy.matchedRows, 2, "the genuine rows were lost");
});

test("CASE E — a legitimate FRESH target is unaffected", () => {
  const clean = migrationTable([migrationRow(LOCALS[0], null), migrationRow(LOCALS[1], null)]);
  const parsed = parseHostedMigrationList(clean, LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, [], "MALFORMED_ROW_DETECTED=YES on a clean fresh table");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, true, "a clean fresh table was refused");
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget([], LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "fresh", "FRESH was lost");
});

test("CASE F — legitimate REPEATABILITY is unaffected", () => {
  const clean = migrationTable([migrationRow(LOCALS[0], LOCALS[0]), migrationRow(LOCALS[1], LOCALS[1])]);
  const parsed = parseHostedMigrationList(clean, LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, [], "MALFORMED_ROW_DETECTED=YES on a clean history");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, true, "a clean history was refused");
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget(LOCALS, LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "repeatability", "REPEATABILITY was lost");
});

test("blank-cell row shapes still parse normally", () => {
  // timestamp|blank, blank|timestamp and blank|blank keep their existing meanings.
  const shapes = migrationTable([migrationRow(LOCALS[0], null), migrationRow(null, LOCALS[1]), migrationRow(null, null)]);
  const parsed = parseHostedMigrationList(shapes, LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, [], "a blank cell was treated as unreadable");
  assert.equal(parsed.rows.length, 2, "blank|blank was not ignored, or a valid shape was lost");
  assert.deepEqual(parsed.localOnly, [LOCALS[0]], "timestamp|blank lost its local-only meaning");
  assert.deepEqual(parsed.unexpectedRemote, [LOCALS[1]], "blank|timestamp lost its remote-only meaning");
});

test("verifyHostedRepeatability refuses partially-parseable rows independently", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const verifySrc = source.slice(source.indexOf("function verifyHostedRepeatability"));
  assert.match(verifySrc.slice(0, verifySrc.indexOf("return { ok: true")), /parsed\.malformedMigrationRows\.length > 0/,
    "verifyHostedRepeatability does not refuse partially-parseable rows");
});

// ─── Truncated migration rows (remediation 26) ────────────────────────────
//
// Remediation 25 detected a partially-parseable row AFTER a line had matched the
// three-column shape. Row DISCOVERY still required two pipes, so a truncated row never
// reached the cell parser at all and simply vanished — the surviving rows then read as a
// complete matching history or an untouched target.

const HEADER_LINES = ["   Local      | Remote     | Time", "  -----------|------------|------"];
const withTruncatedLine = (bodyRows, truncated) => [...HEADER_LINES, ...bodyRows, truncated].join("\n");
const PAIRED = [migrationRow(LOCALS[0], LOCALS[0]), migrationRow(LOCALS[1], LOCALS[1])];
const FRESH_ROWS = [migrationRow(LOCALS[0], null), migrationRow(LOCALS[1], null)];

const truncatedEvidence = (table) => parseHostedMigrationList(table, LOCALS).malformedMigrationRows;

test("CASE A (truncated) — a one-pipe row must not yield REPEATABILITY, and never reaches a push", () => {
  const table = withTruncatedLine(PAIRED, `   garbage | ${UNKNOWN_LOCAL}`);
  const parsed = parseHostedMigrationList(table, LOCALS);
  assert.equal(parsed.malformedMigrationRows.length, 1, "TRUNCATED_ROW_DETECTED=NO — the one-pipe row vanished");
  assert.match(parsed.malformedMigrationRows[0], /garbage\|20260601000000/, `unexpected evidence: ${parsed.malformedMigrationRows[0]}`);
  assert.equal(parsed.matchedRows, 2, "the two genuine rows must still parse normally");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, false, "recognition accepted a truncated row");
  const { rows: _r, ...evidence } = parsed;
  const remote = [...new Set(parsed.rows.map((r) => r.remote).filter(Boolean))];
  assert.equal(classifyHostedTarget(remote, LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "fail", "REPEATABILITY=YES");

  const { result, calls } = applyHostedWithMigrationList(table, ["20260428120000_a.sql", "20260501000000_b.sql"]);
  assert.equal(result.ok, false, "the live apply path accepted a truncated row");
  assert.equal(calls.some((c) => c.includes("push")), false, `DB_PUSH_REACHED: ${calls.join(" | ")}`);
});

test("CASE B (truncated) — a one-pipe row must not yield FRESH, and never reaches a push", () => {
  const table = withTruncatedLine(FRESH_ROWS, `   garbage | ${UNKNOWN_LOCAL}`);
  const parsed = parseHostedMigrationList(table, LOCALS);
  assert.equal(parsed.malformedMigrationRows.length, 1, "TRUNCATED_ROW_DETECTED=NO on the fresh shape");
  const remote = [...new Set(parsed.rows.map((r) => r.remote).filter(Boolean))];
  assert.deepEqual(remote, [], "precondition: the surviving rows leave the remote history empty");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, false, "recognition accepted it");
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget(remote, LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "fail", "FRESH=YES");

  const { result, calls } = applyHostedWithMigrationList(table, ["20260428120000_a.sql", "20260501000000_b.sql"]);
  assert.equal(result.ok, false, "the live apply path accepted a truncated fresh target");
  assert.equal(calls.some((c) => c.includes("push")), false, `DB_PUSH_REACHED: ${calls.join(" | ")}`);
});

test("CASE C — valid|valid is refused on STRUCTURE, not just on readability", () => {
  // Both cells parse perfectly. The row is still truncated, and the gate must not
  // certify from an output format it did not receive whole.
  const evidence = truncatedEvidence(withTruncatedLine(PAIRED, `   ${UNKNOWN_LOCAL} | ${UNKNOWN_LOCAL}`));
  assert.equal(evidence.length, 1, "a structurally truncated row with two readable cells was accepted");
  assert.match(evidence[0], /20260601000000\|20260601000000/, `unexpected evidence: ${evidence[0]}`);
});

test("CASE D — valid|blank truncated is refused", () => {
  const evidence = truncatedEvidence(withTruncatedLine(PAIRED, `   ${UNKNOWN_LOCAL} |`));
  assert.equal(evidence.length, 1, "a truncated row with a blank second cell was accepted");
  assert.match(evidence[0], /20260601000000\|/, `unexpected evidence: ${evidence[0]}`);
});

test("CASE E — either malformed side of a truncated row is refused", () => {
  assert.equal(truncatedEvidence(withTruncatedLine(PAIRED, `   garbage | ${UNKNOWN_LOCAL}`)).length, 1, "garbage|version was accepted");
  assert.equal(truncatedEvidence(withTruncatedLine(PAIRED, `   ${UNKNOWN_LOCAL} | garbage`)).length, 1, "version|garbage was accepted");
});

test("CASE F — one-pipe chatter with no migration version stays ignorable", () => {
  const table = [...HEADER_LINES, ...PAIRED, "   status | complete", "   foo | bar"].join("\n");
  const parsed = parseHostedMigrationList(table, LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, [], "ordinary one-pipe chatter was treated as migration corruption");
  assert.equal(parsed.matchedRows, 2, "the genuine rows were lost");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, true, "chatter caused a refusal");
});

test("CASE G — a normal three-column FRESH table is unchanged", () => {
  const table = [...HEADER_LINES, ...FRESH_ROWS].join("\n");
  const parsed = parseHostedMigrationList(table, LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, []);
  assert.equal(parsed.rows.length, 2, "normal rows were lost by the new discovery model");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, true);
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget([], LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "fresh", "FRESH was lost");
});

test("CASE H — a normal three-column REPEATABILITY table is unchanged", () => {
  const table = [...HEADER_LINES, ...PAIRED].join("\n");
  const parsed = parseHostedMigrationList(table, LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, []);
  assert.equal(parsed.matchedRows, 2);
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget(LOCALS, LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "repeatability", "REPEATABILITY was lost");
});

test("row discovery: headers, separators and blank-cell shapes survive the line-oriented model", () => {
  // The header and separator each carry two pipes and no version; the blank shapes are
  // normal rows. None of them may become corruption evidence.
  const table = [
    "Connecting to remote database...",
    ...HEADER_LINES,
    migrationRow(LOCALS[0], null),
    migrationRow(null, LOCALS[1]),
    migrationRow(null, null),
    "Finished supabase migration list.",
  ].join("\n");
  const parsed = parseHostedMigrationList(table, LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, [], "a header, separator, blank row or prose line was flagged");
  assert.equal(parsed.rows.length, 2, "blank|blank was not ignored, or a valid shape was lost");
  assert.deepEqual(parsed.localOnly, [LOCALS[0]], "timestamp|blank lost its meaning");
  assert.deepEqual(parsed.unexpectedRemote, [LOCALS[1]], "blank|timestamp lost its meaning");
});

// ─── Bare zero-pipe migration tokens (remediation 27) ─────────────────────
//
// Remediation 26 made discovery line-oriented but discarded zero-pipe lines outright.
// A whole line that IS a migration cell is evidence from a structurally truncated
// output, not prose: `20260601000000` alone vanished, and the surviving rows read as a
// complete matching history or an untouched target.

const withBareLine = (bodyRows, bare) => [...HEADER_LINES, ...bodyRows, bare].join("\n");
const bareEvidence = (table) => parseHostedMigrationList(table, LOCALS).malformedMigrationRows;

test("CASE A (bare) — a bare migration token must not yield REPEATABILITY, and never reaches a push", () => {
  const table = withBareLine(PAIRED, `   ${UNKNOWN_LOCAL}`);
  const parsed = parseHostedMigrationList(table, LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, [UNKNOWN_LOCAL], "MALFORMED_ROW_DETECTED=NO — the bare token vanished");
  assert.equal(parsed.matchedRows, 2, "the two genuine rows must still parse normally");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, false, "recognition accepted a bare token");
  const { rows: _r, ...evidence } = parsed;
  const remote = [...new Set(parsed.rows.map((r) => r.remote).filter(Boolean))];
  assert.equal(classifyHostedTarget(remote, LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "fail", "REPEATABILITY=YES");

  const { result, calls } = applyHostedWithMigrationList(table, ["20260428120000_a.sql", "20260501000000_b.sql"]);
  assert.equal(result.ok, false, "the live apply path accepted a bare migration token");
  assert.equal(calls.some((c) => c.includes("push")), false, `DB_PUSH_REACHED: ${calls.join(" | ")}`);
});

test("CASE B (bare) — a bare migration token must not yield FRESH, and never reaches a push", () => {
  const table = withBareLine(FRESH_ROWS, `   ${UNKNOWN_LOCAL}`);
  const parsed = parseHostedMigrationList(table, LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, [UNKNOWN_LOCAL], "MALFORMED_ROW_DETECTED=NO on the fresh shape");
  const remote = [...new Set(parsed.rows.map((r) => r.remote).filter(Boolean))];
  assert.deepEqual(remote, [], "precondition: the surviving rows leave the remote history empty");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, false, "recognition accepted it");
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget(remote, LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "fail", "FRESH=YES");

  const { result, calls } = applyHostedWithMigrationList(table, ["20260428120000_a.sql", "20260501000000_b.sql"]);
  assert.equal(result.ok, false, "the live apply path accepted a bare token on a fresh target");
  assert.equal(calls.some((c) => c.includes("push")), false, `DB_PUSH_REACHED: ${calls.join(" | ")}`);
});

test("CASE C (bare) — a BACKTICK-wrapped bare token is refused", () => {
  // The CLI renders cells both ways; the bare form must be caught in both renderings.
  const evidence = bareEvidence(withBareLine(PAIRED, `   \`${UNKNOWN_LOCAL}\``));
  assert.equal(evidence.length, 1, "a backtick-wrapped bare token was accepted");
  assert.match(evidence[0], /`20260601000000`/, `unexpected evidence: ${evidence[0]}`);
});

test("CASE D (bare) — a bare EXPECTED local token is refused too", () => {
  // Provenance does not rescue the structure: the output shape is still truncated.
  const evidence = bareEvidence(withBareLine(PAIRED, `   ${LOCALS[0]}`));
  assert.equal(evidence.length, 1, "a bare token was excused because the repository knows that version");
  assert.match(evidence[0], /20260428120000/, `unexpected evidence: ${evidence[0]}`);
});

test("CASE E (bare) — ordinary zero-pipe prose stays ignorable", () => {
  const table = [
    ...HEADER_LINES,
    ...PAIRED,
    "Connecting to remote database...",
    "status complete",
    "migration list complete",
    // The load-bearing one: a timestamp EMBEDDED in prose must not qualify. Only a WHOLE
    // line that parses as a migration cell does.
    `Migration ${UNKNOWN_LOCAL} complete`,
    "",
  ].join("\n");
  const parsed = parseHostedMigrationList(table, LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, [], "ordinary prose was treated as migration corruption");
  assert.equal(parsed.matchedRows, 2, "the genuine rows were lost");
  assert.equal(recognizeMigrationListRows(parsed.rows, LOCALS, parsed.malformedMigrationRows).ok, true, "prose caused a refusal");
});

test("CASE F (bare) — a normal FRESH table is unchanged", () => {
  const parsed = parseHostedMigrationList([...HEADER_LINES, ...FRESH_ROWS].join("\n"), LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, []);
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget([], LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "fresh", "FRESH was lost");
});

test("CASE G (bare) — a normal REPEATABILITY table is unchanged", () => {
  const parsed = parseHostedMigrationList([...HEADER_LINES, ...PAIRED].join("\n"), LOCALS);
  assert.deepEqual(parsed.malformedMigrationRows, []);
  const { rows: _r, ...evidence } = parsed;
  assert.equal(classifyHostedTarget(LOCALS, LOCALS, { ...evidence, localMigrationCount: 2 }).mode, "repeatability", "REPEATABILITY was lost");
});
