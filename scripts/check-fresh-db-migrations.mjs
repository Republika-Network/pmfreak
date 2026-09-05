#!/usr/bin/env node
// ============================================================================
// PMFreak Fresh Database Migration Proof (Perilla 13 / RR-MIGRATE).
//
// Applies every file under supabase/migrations, in filename order, to an
// isolated Postgres/Supabase database, then validates schema integrity, RLS
// coverage, and tenant isolation. Refuses to run against anything that looks
// like a production/shared database.
//
// Modes (selected by environment variables — see below):
//   local     FRESH_DB_URL points at an isolated local/CI Postgres instance
//             (e.g. a plain `postgres` server, or `supabase start`'s local
//             stack). Real SQL execution, no Supabase-hosted auth/storage.
//   hosted    SUPABASE_DB_URL + SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF
//             point at an isolated hosted Supabase project. Strongest
//             evidence: real auth/storage/PostgREST-compatible roles.
//   verify-only   No database variables set. Runs only the static checks
//             (inventory, ordering, duplicate detection) that don't require
//             a live connection. Does not close RR-MIGRATE by itself.
//
// Required for local/hosted modes:
//   ALLOW_DESTRUCTIVE_FRESH_DB_TEST=true   (never defaults to true)
//   FRESH_DB_EXPECTED_PROJECT_REF=<ref>    (hosted mode only; must exactly
//                                            match SUPABASE_PROJECT_REF)
//
// Usage:
//   npm run check:fresh-db-migrations
//
// Secrets (DB URLs, tokens) are never printed; only redacted host/ref info
// appears in output and in the generated report.
// ============================================================================

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { STOCK_MANAGED_OBJECT_PROFILES } from "./fixtures/managed-object-profiles.mjs";

const ROOT = process.cwd();
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");
const ROLES_FILE = path.join(ROOT, "supabase/roles.sql");
const REPORT_DIR = path.join(ROOT, ".fresh-db-migration-logs");

const KNOWN_PRODUCTION_HOST_FRAGMENTS = ["prod", "production", "pilot"];

// ─── Hosted target identity: the PROJECT REF is the authority ──────────────
//
// Ref equality alone is not a safeguard. Setting BOTH `SUPABASE_PROJECT_REF` and
// `FRESH_DB_EXPECTED_PROJECT_REF` to the live project satisfies the match check,
// and the production-fragment heuristic does not fire on either real ref (neither
// contains "prod", "production" or "pilot") — so name- and URL-shaped signals
// cannot be relied on here. The destructive hosted fresh-apply is therefore pinned
// to ONE explicitly designated disposable project and denied against the live one.
const HOSTED_ALLOWED_MIGRATION_VALIDATION_REF = "ecwkldflddnmdwusatuh"; // pmfreak-migration-validation

// Version-controlled allowlist of disposable validation projects. Rotation happens by
// adding a ref HERE, through reviewed code — never by setting an environment variable.
// Two matching env vars are two copies of the same typo, so a matching handshake is
// NECESSARY BUT NOT SUFFICIENT. Being allowlisted is likewise not sufficient for a fresh
// apply: the target must additionally prove application-object emptiness.
const HOSTED_ALLOWED_VALIDATION_REFS = Object.freeze([HOSTED_ALLOWED_MIGRATION_VALIDATION_REF]);
const HOSTED_DENIED_ACTIVE_PMFREAK_REF = "refvllnadfzjkxlpidrr"; // PMFreak (ACTIVE_HEALTHY) — never a target

function redact(value) {
  if (!value) return "(unset)";
  return value.replace(/:\/\/[^@]+@/, "://[redacted]@").replace(/\/\/.*/, (m) => (m.length > 24 ? `${m.slice(0, 16)}...[redacted]` : m));
}

function sh(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return result;
}

// ─── Portable `npx` invocation ─────────────────────────────────────────────
//
// HARNESS DEFECT (Windows). `spawnSync("npx", [...])` fails with
//   status=null, error.code=ENOENT, error.message="spawnSync npx ENOENT"
// because on Windows `npx` is `npx.cmd` — a batch script, not an executable
// image — and CreateProcess cannot launch it. The first real hosted attempt
// therefore died BEFORE `supabase link`, leaving the hosted database untouched.
//
// The fix is deliberately narrow:
//   * `shell: true` is NOT enabled globally. That would re-parse every argument
//     of every command through a shell.
//   * `sh()` is left alone. It is shared with `psql` (a real executable image),
//     and its execution semantics must not change.
// Only npx-launched commands route through the interpreter, and only on
// Windows: ComSpec with `/d /s /c` (skip AutoRun, strict quote handling).
const WINDOWS_CMD_METACHARACTERS = /[&|<>^"%\r\n]/;

function runNpx(args, opts = {}) {
  if (process.platform !== "win32") return sh("npx", args, opts);

  // Routing through cmd.exe means the interpreter, not CreateProcess, splits
  // the command line. Every argument here is harness-controlled except the
  // project ref, which arrives from the environment — refuse anything carrying
  // cmd metacharacters rather than let it become a second command.
  const unsafe = args.find((arg) => WINDOWS_CMD_METACHARACTERS.test(String(arg)));
  if (unsafe !== undefined) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("refusing to pass an argument containing cmd.exe metacharacters to npx"), {
        code: "ERR_UNSAFE_NPX_ARGUMENT",
      }),
    };
  }

  return sh(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npx", ...args], opts);
}

// ─── Child-process failure diagnostics ─────────────────────────────────────
//
// A launch failure sets `result.error` and leaves `result.status === null` and
// `result.stderr === undefined`. The harness printed that stderr directly, so a
// hard ENOENT rendered as a blank line and read like "the command ran and said
// nothing". Launch failures and non-zero exits are now reported as distinct
// kinds, and a failure can never render an empty diagnostic again.

function scrubSecrets(text) {
  let out = String(text ?? "");
  const secrets = [
    process.env.SUPABASE_ACCESS_TOKEN,
    process.env.SUPABASE_DB_URL,
    process.env.FRESH_DB_URL,
    process.env.SUPABASE_DB_PASSWORD,
    process.env.POSTGRES_PASSWORD,
  ].filter((value) => typeof value === "string" && value.length >= 8);
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  // Any surviving postgres URL credentials, whatever their source.
  return out.replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1[redacted]@");
}

function describeSpawnResult(result, command) {
  const stderr = scrubSecrets(result?.stderr ?? "").trim();
  if (result?.error) {
    return {
      kind: "PROCESS_SPAWN_FAILURE",
      command,
      status: result.status ?? null,
      spawnErrorCode: result.error.code ?? null,
      spawnErrorMessage: scrubSecrets(result.error.message ?? String(result.error)),
      stderr,
    };
  }
  return {
    kind: "COMMAND_EXIT_NONZERO",
    command,
    status: result?.status ?? null,
    spawnErrorCode: null,
    spawnErrorMessage: null,
    stderr,
  };
}

function formatFailure(failure) {
  if (!failure) return "  FAILURE_KIND=UNKNOWN (no diagnostic captured)";
  const lines = [
    `  FAILURE_KIND=${failure.kind}`,
    `  COMMAND=${failure.command}`,
    `  EXIT_STATUS=${failure.status === null ? "null" : failure.status}`,
  ];
  if (failure.kind === "PROCESS_SPAWN_FAILURE") {
    lines.push(`  SPAWN_ERROR_CODE=${failure.spawnErrorCode ?? "(none)"}`);
    lines.push(`  SPAWN_ERROR_MESSAGE=${failure.spawnErrorMessage || "(none)"}`);
    if (failure.spawnErrorCode === "ENOENT") {
      lines.push("  HINT=the command could not be launched at all (not found, or not an executable image on this platform)");
    }
  }
  lines.push(`  STDERR=${failure.stderr ? failure.stderr.slice(0, 2000) : "(empty)"}`);
  return lines.join("\n");
}

function fail(message) {
  console.error(`\nFAIL: ${message}\n`);
  process.exitCode = 1;
  return false;
}

function loadMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

// ─── Step 1: environment safety guard ──────────────────────────────────────

function determineMode() {
  const hasHosted = process.env.SUPABASE_DB_URL && process.env.SUPABASE_ACCESS_TOKEN && process.env.SUPABASE_PROJECT_REF;
  const hasLocal = process.env.FRESH_DB_URL;
  if (hasHosted) return "hosted";
  if (hasLocal) return "local";
  return "verify-only";
}

function safetyGuard(mode) {
  if (mode === "verify-only") return true;

  if (process.env.ALLOW_DESTRUCTIVE_FRESH_DB_TEST !== "true") {
    return fail(
      "ALLOW_DESTRUCTIVE_FRESH_DB_TEST must be explicitly set to 'true' to run a live fresh-apply. " +
        "This variable never defaults to true. Refusing to run against any database without explicit confirmation.",
    );
  }

  const dbUrl = mode === "hosted" ? process.env.SUPABASE_DB_URL : process.env.FRESH_DB_URL;
  const lowerUrl = (dbUrl ?? "").toLowerCase();
  if (KNOWN_PRODUCTION_HOST_FRAGMENTS.some((fragment) => lowerUrl.includes(fragment))) {
    return fail(`Refusing to run: database URL host looks production-like (matched one of: ${KNOWN_PRODUCTION_HOST_FRAGMENTS.join(", ")}). Use an isolated project.`);
  }

  if (mode === "hosted") {
    const actual = (process.env.SUPABASE_PROJECT_REF ?? "").trim();
    const expected = (process.env.FRESH_DB_EXPECTED_PROJECT_REF ?? "").trim();

    if (!actual) {
      return fail("SUPABASE_PROJECT_REF is required in hosted mode. Refusing to run.");
    }
    if (!expected) {
      return fail("FRESH_DB_EXPECTED_PROJECT_REF is required in hosted mode and must exactly match SUPABASE_PROJECT_REF.");
    }
    if (expected !== actual) {
      return fail(`FRESH_DB_EXPECTED_PROJECT_REF (${expected}) does not match SUPABASE_PROJECT_REF (${redact(actual)}). Refusing to run.`);
    }

    // Explicit denial of the live project, checked BEFORE the allowlist so the
    // refusal names the real hazard rather than a generic "not the target" message.
    if (actual === HOSTED_DENIED_ACTIVE_PMFREAK_REF || expected === HOSTED_DENIED_ACTIVE_PMFREAK_REF) {
      return fail(
        "Refusing to run: the target is the ACTIVE PMFreak project. The destructive hosted fresh-apply " +
          "must never run against it, regardless of matching refs or explicit confirmation.",
      );
    }

    if (!HOSTED_ALLOWED_VALIDATION_REFS.includes(actual)) {
      return fail(
        `Refusing to run: SUPABASE_PROJECT_REF (${redact(actual)}) is not in HOSTED_ALLOWED_VALIDATION_REFS. ` +
          "Matching SUPABASE_PROJECT_REF and FRESH_DB_EXPECTED_PROJECT_REF is necessary but NOT sufficient: a " +
          "rotated validation project must first be added to the version-controlled allowlist through reviewed " +
          "source. An empty migration ledger is not proof that a project is disposable.",
      );
    }

    // Historical note. The original single-ref pin cannot express a SECOND validation
    // project, and it had a worse problem: the pinned project now holds the full
    // migration chain, so re-running against it would apply a future migration as a
    // DELTA and still report "fresh apply". Emptiness — not identity — is the property
    // that makes a fresh-apply certification true, so the pin is replaced by a
    // PRE-APPLY emptiness precondition enforced in classifyHostedTarget(), which every
    // ref must satisfy including the originally designated one.
    //
    // Nothing else is relaxed: the active-project denial above still runs FIRST and is
    // absolute, the two-variable ref handshake is still mandatory, the production-like
    // host check still applies, ALLOW_DESTRUCTIVE_FRESH_DB_TEST is still required, and
    // no target is ever inferred — both refs must be supplied explicitly and match.
    if (actual !== HOSTED_ALLOWED_MIGRATION_VALIDATION_REF) {
      console.log(
        `[safety] hosted target ${redact(actual)} is an ALLOWLISTED ROTATED validation project. It may be ` +
          "fresh-applied only after proving BOTH an empty PMFreak migration ledger and an empty application " +
          "object/data state; both preconditions are enforced before any destructive push.",
      );
    }
  }

  return true;
}

// ─── Step 2: migration inventory + ordering ────────────────────────────────

function checkInventoryAndOrdering(files) {
  const errors = [];
  const seenTimestamps = new Map();
  const timestampPattern = /^(\d{14})_[a-z0-9_]+\.sql$/;

  for (const file of files) {
    const match = file.match(timestampPattern);
    if (!match) {
      errors.push(`Migration file does not match <timestamp>_<name>.sql: ${file}`);
      continue;
    }
    const ts = match[1];
    if (seenTimestamps.has(ts)) {
      errors.push(`Duplicate migration timestamp ${ts}: ${seenTimestamps.get(ts)} and ${file}`);
    } else {
      seenTimestamps.set(ts, file);
    }
  }

  const sorted = [...files].sort();
  const lexicographicMatchesDiscovery = JSON.stringify(sorted) === JSON.stringify(files);
  if (!lexicographicMatchesDiscovery) {
    errors.push("Filesystem discovery order does not match lexicographic sort order.");
  }

  return errors;
}

// ─── Step 3: apply migrations (local / hosted) ─────────────────────────────

function applyLocal(files) {
  const dbUrl = process.env.FRESH_DB_URL;
  console.log(`[apply:local] target: ${redact(dbUrl)}`);

  const roles = sh("psql", ["-v", "ON_ERROR_STOP=1", dbUrl, "-f", ROLES_FILE]);
  if (roles.status !== 0) {
    return {
      ok: false,
      failedFile: "supabase/roles.sql",
      failure: describeSpawnResult(roles, "psql -f supabase/roles.sql"),
      stderr: roles.stderr,
      applied: 0,
    };
  }

  for (const file of files) {
    const full = path.join(MIGRATIONS_DIR, file);
    const result = sh("psql", ["-v", "ON_ERROR_STOP=1", dbUrl, "-f", full]);
    if (result.status !== 0) {
      return {
        ok: false,
        failedFile: file,
        failure: describeSpawnResult(result, `psql -f ${file}`),
        stderr: result.stderr,
        applied: files.indexOf(file),
      };
    }
  }
  return { ok: true, applied: files.length };
}

// `runner` is an injected seam so the credential-free suite can exercise this whole path
// — link, classification, reason propagation — without npx, a CLI or any network.
function applyHosted(files = loadMigrationFiles(), runner = runNpx) {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  console.log(`[apply:hosted] project ref: ${redact(projectRef)}`);

  const link = runner(["-y", "supabase", "link", "--project-ref", projectRef], {
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN },
  });
  if (link.status !== 0) {
    return { ok: false, failedFile: "(supabase link)", failure: describeSpawnResult(link, "npx supabase link"), stderr: link.stderr };
  }

  // PRE-APPLY gate. Read the target's existing history and classify BEFORE any
  // destructive push, so a populated project can never be delta-applied and then
  // reported as a fresh apply.
  const localTimestamps = files.map((f) => f.match(/^(\d{14})_/)?.[1]).filter(Boolean);
  const history = readHostedMigrationVersions(localTimestamps, runner);
  if (!history.ok) {
    // Keep the actionable reason. "Failed at: (supabase migration list)" alone hides the
    // single most useful fact — that the output format was not recognised — which is
    // exactly the class of regression this check exists to catch.
    return {
      ok: false,
      failedFile: "(supabase migration list)",
      reason: history.reason ? `HOSTED_MIGRATION_LIST_FAILURE=UNRECOGNIZED_OUTPUT — ${history.reason}` : undefined,
      failure: history.failure,
      stderr: history.stderr,
    };
  }
  // The WHOLE evidence record, not a hand-picked subset. Re-listing fields here is what
  // dropped `unexpectedRemote` and `duplicateRemote` before classification.
  const target = classifyHostedTarget(history.remoteVersions, localTimestamps, history.pairing);
  console.log(`[apply:hosted] PRE_APPLY_REMOTE_MIGRATION_COUNT=${target.preApplyRemoteMigrationCount}`);
  console.log(`[apply:hosted] HOSTED_TARGET_CLASSIFICATION=${target.mode.toUpperCase()}`);

  if (target.mode === "fail") {
    return { ok: false, failedFile: "(hosted target classification)", reason: target.reason };
  }

  if (target.mode === "fresh") {
    // The emptiness proof is only meaningful if psql and the CLI address the SAME
    // project. Prove that binding first — before the probe, and before any push.
    const binding = verifyHostedTargetBinding(process.env.SUPABASE_DB_URL, projectRef);
    console.log(`[apply:hosted] DB_URL_PROJECT_REF_IDENTIFIED=${binding.identified ? "YES" : "NO"}`);
    if (!binding.ok) {
      return { ok: false, failedFile: "(hosted target binding)", reason: binding.reason };
    }
    console.log(`[apply:hosted] DB_URL_PROJECT_REF=SUPABASE_PROJECT_REF (${binding.form} form)`);

    // Allowlisted + bound + empty ledger is still not enough. Prove the database carries
    // no application workload before anything destructive runs.
    const probe = probeHostedApplicationState(process.env.SUPABASE_DB_URL);
    if (!probe.ok) {
      return { ok: false, failedFile: "(hosted application-emptiness probe)", reason: probe.reason, failure: probe.failure, stderr: probe.stderr };
    }
    console.log(`[apply:hosted] APPLICATION_EMPTINESS=${probe.verdict.empty ? "EMPTY" : "NOT_EMPTY"}`);
    if (!probe.verdict.empty) {
      // Explicitly NOT repeatability and NOT a delta apply — a populated project with an
      // empty ledger is simply not certifiable here.
      return { ok: false, failedFile: "(hosted application-emptiness probe)", reason: probe.verdict.reason };
    }
  }

  if (target.mode === "repeatability") {
    // Already fully migrated: prove repeatability, never re-run the destructive push,
    // and never call this a fresh apply.
    console.log("[apply:hosted] target already holds the complete local chain — REPEATABILITY only, no push.");
    return { ok: true, certification: "REPEATABILITY", freshApply: false, preApplyRemoteMigrationCount: target.preApplyRemoteMigrationCount };
  }

  const push = runner(["-y", "supabase", "db", "push", "--include-roles"], {
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN },
  });
  if (push.status !== 0) {
    return {
      ok: false,
      failedFile: "(supabase db push)",
      failure: describeSpawnResult(push, "npx supabase db push --include-roles"),
      stderr: push.stderr,
    };
  }

  return { ok: true, certification: "FRESH_APPLY", freshApply: true, preApplyRemoteMigrationCount: 0 };
}

// ─── Step 3b: hosted repeatability verification ────────────────────────────
//
// After a hosted apply, `supabase migration list --linked` prints a table
// comparing the local migration history against what the linked project has
// actually recorded. Two cell renderings are in the wild and BOTH must parse:
//
//   plain (older CLI):
//     Local          | Remote         | Time (UTC)
//    ----------------|----------------|---------------------
//     20260428120000 | 20260428120000 | 2026-04-28 12:00:00
//     20260501000000 |                | 2026-05-01 00:00:00
//
//   backtick-wrapped (current CLI):
//     Local          | Remote         | Time (UTC)
//    ----------------|----------------|---------------------
//     `20260428120000` | `20260428120000` | 2026-04-28 12:00:00
//     `20260501000000` |                  | 2026-05-01 00:00:00
//
// A row with a populated Local column and an empty Remote column is a local
// migration the linked project never recorded (remote-pending — the apply
// didn't fully take, or drifted). A row with a populated Remote column and
// an empty Local column is a migration the project has recorded that no
// local file explains (remote-unexpected — manual/out-of-band drift). The
// Local and Remote columns are read independently: a timestamp on one side
// is never inferred from the other.
//
// parseHostedMigrationList() is a pure function so it can be unit-tested
// against synthetic CLI output. Its row shape has been verified against real
// `supabase migration list --linked` stdout from the linked validation
// project (see docs/release/hosted-supabase-migration-proof.md); the
// backtick form is what that CLI actually emits, and the earlier
// plain-digits-only regex silently matched zero rows against it, reporting
// every local migration as remote-pending.

// A migration cell is either empty, a bare 14-digit timestamp, or the same
// timestamp wrapped in backticks. Anything else means the line is not a
// migration row (header, separator, log noise, truncated digits).
const MIGRATION_CELL_PATTERN = /^\s*(?:`(\d{14})`|(\d{14}))\s*$/;

// null      -> cell is present but empty (the pending / unexpected side)
// string    -> the timestamp the cell carries
// undefined -> not a migration cell at all; the whole line must be ignored
function parseMigrationCell(cell) {
  if (cell.trim() === "") return null;
  const match = MIGRATION_CELL_PATTERN.exec(cell);
  if (!match) return undefined;
  return match[1] ?? match[2];
}

function parseHostedMigrationList(output, localTimestamps) {
  // Grab the first two pipe-delimited cells of every line, then validate
  // them. Validating cells (rather than baking the timestamp shape into the
  // line regex) is what keeps headers, `---|---|---` separators and stray
  // CLI chatter out of the row set while still accepting both cell forms.
  // LINE-ORIENTED DISCOVERY, because the previous row regex required TWO pipes to even
  // look at a line. The CLI's row shape is `local | remote | time`, so a TRUNCATED row
  // carrying only one pipe never reached the cell parser, never reached
  // `malformedMigrationRows`, and simply vanished — leaving the surviving rows to read as
  // a complete matching history (REPEATABILITY) or an untouched target (FRESH). Detecting
  // a partially-parseable row after it has already matched a well-formed shape cannot see
  // a row that never matched at all, so discovery itself is what had to change.
  const rows = [];
  const malformedMigrationRows = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const pipeCount = (rawLine.match(/\|/g) ?? []).length;
    if (pipeCount === 0) {
      // A whole line that IS a migration cell is evidence from a structurally truncated
      // output, not prose. `20260601000000` on its own — bare or backtick-wrapped — was
      // discarded with the rest of the chatter, and the surviving rows then read as a
      // complete matching history or an untouched target.
      //
      // The test is the WHOLE line, through the same cell parser the columns use, so a
      // timestamp merely EMBEDDED in prose ("Migration 20260601000000 complete") does not
      // qualify: the anchored cell pattern rejects it. A blank line parses as an empty
      // cell rather than a version and stays ignorable, as does every other prose line.
      //
      // Provenance does not rescue the structure: a bare EXPECTED local version is
      // refused too, because the output shape is still truncated.
      const bareCell = parseMigrationCell(rawLine);
      if (typeof bareCell === "string") malformedMigrationRows.push(rawLine.trim());
      continue;
    }
    const cells = rawLine.split("|");
    const local = parseMigrationCell(cells[0] ?? "");
    const remote = parseMigrationCell(cells[1] ?? "");
    // A cell "carries a version" only when it parsed as a real timestamp. `undefined` is
    // unreadable and `null` is a legitimately blank cell; neither is a version.
    const carriesAVersion =
      (local !== undefined && local !== null) || (remote !== undefined && remote !== null);
    const evidence = `${(cells[0] ?? "").trim()}|${(cells[1] ?? "").trim()}`;

    if (pipeCount < 2) {
      // TRUNCATED. Structure alone is enough to refuse when a real migration version is
      // present — including `X | X` and `X |`, where both visible cells are perfectly
      // readable. The gate must not certify from an output format it did not receive
      // whole. A one-pipe line with no version on either side (`status | complete`,
      // `foo | bar`) stays ignorable chatter.
      if (carriesAVersion) malformedMigrationRows.push(evidence);
      continue;
    }

    // NORMAL three-column row: unchanged semantics from here down.
    if (local === undefined || remote === undefined) {
      // PARTIALLY PARSEABLE, which is not the same as chatter. A header or separator has
      // NO valid timestamp on either side and is still ignored; a row with one real
      // version and one unreadable cell is a migration row this parser did not
      // understand, and it fails closed.
      if (carriesAVersion) malformedMigrationRows.push(evidence);
      continue;
    }
    if (local === null && remote === null) continue; // blank filler line
    rows.push({ local, remote });
  }

  // ROW PAIRING IS EVIDENCE, NOT NOISE. Reducing the table to a local SET and a remote
  // SET throws away which local version was recorded against which remote one, and two
  // shifted rows — local=A/remote=B and local=B/remote=A — then produce identical sets
  // with ZERO actually-matching rows. That is a misparsed or shifted table, and it was
  // being certified as a complete matching history. A row carrying BOTH cells must agree.
  const mismatchedPairs = rows
    .filter((r) => r.local && r.remote && r.local !== r.remote)
    .map((r) => `${r.local}!=${r.remote}`);
  // The same remote version appearing on two rows is malformed output, not history.
  const remoteSeen = new Map();
  for (const r of rows) if (r.remote) remoteSeen.set(r.remote, (remoteSeen.get(r.remote) ?? 0) + 1);
  const duplicateRemote = [...remoteSeen.entries()].filter(([, n]) => n > 1).map(([v, n]) => `${v}x${n}`);

  // THE LOCAL SIDE, recorded as ROW SHAPE rather than inferred from per-version facts.
  //
  // `localOnly` is every row carrying a Local version and a blank Remote. On a fresh
  // target that is the NORMAL shape — the CLI lists every local migration with an empty
  // Remote — so a local-only row is not an anomaly by itself and is recorded as evidence,
  // not as a refusal.
  //
  // `duplicateLocal` is the anomaly: one local version appearing on more than one row. It
  // is the local-side mirror of `duplicateRemote`, and it is what `pendingLocal` cannot
  // express. `pendingLocal` answers "does this version have a correctly paired row
  // ANYWHERE", so in `A|A`, `B|B`, `A|` the stray `A|` vanishes from it — A is already
  // paired. The table is still malformed, and it deduplicated into a remote set equal to
  // local history and certified as REPEATABILITY.
  const localOnly = [...new Set(rows.filter((r) => r.local && !r.remote).map((r) => r.local))];
  // PROVENANCE, which row shape alone cannot express. `localOnly` is the canonical shape
  // of a fresh target, so it can never be an anomaly by itself — but a Local cell naming a
  // migration this repository does not have is unexplainable in EITHER direction. It made
  // `A|A`, `B|B`, `X|` read as repeatability (the remote set still equalled local history)
  // and `A|`, `B|`, `X|` read as fresh (every row was legitimately local-only).
  const expectedLocal = new Set(localTimestamps);
  const unexpectedLocal = [...new Set(rows.map((r) => r.local).filter((v) => v && !expectedLocal.has(v)))];
  const localSeen = new Map();
  for (const r of rows) if (r.local) localSeen.set(r.local, (localSeen.get(r.local) ?? 0) + 1);
  const duplicateLocal = [...localSeen.entries()].filter(([, n]) => n > 1).map(([v, n]) => `${v}x${n}`);
  const remoteSet = new Set(rows.map((r) => r.remote).filter(Boolean));
  const remoteOnly = [...new Set(rows.filter((r) => r.remote && !r.local).map((r) => r.remote))];
  // Pending = a local version with no row that PAIRS it to the same remote version.
  const pairedLocals = new Set(rows.filter((r) => r.local && r.remote && r.local === r.remote).map((r) => r.local));
  const pendingLocal = localTimestamps.filter((ts) => !pairedLocals.has(ts));
  const matchedRows = rows.filter((r) => r.local && r.remote && r.local === r.remote).length;

  return {
    rows,
    pendingLocal,
    unexpectedRemote: remoteOnly,
    mismatchedPairs,
    duplicateRemote,
    malformedMigrationRows,
    localOnly,
    unexpectedLocal,
    duplicateLocal,
    matchedCount: remoteSet.size,
    matchedRows,
  };
}

// ─── Hosted target classification (pre-apply) ──────────────────────────────
//
// A "fresh apply" certification is only true if the target had NO PMFreak migration
// history before the apply. Applying to an already-populated project applies a DELTA;
// calling that a fresh apply would certify something that never happened.
//
//   fresh          remote history empty                  -> full chain may be applied
//   repeatability  remote set === local set exactly      -> already proven; do NOT re-push
//   fail           partial, or any unexpected remote      -> not certifiable as fresh
//
// Pure so it can be unit-tested without network or credentials.
function classifyHostedTarget(remoteVersions, localVersions, pairing = null) {
  const remote = [...new Set(remoteVersions)].sort();
  const local = [...new Set(localVersions)].sort();

  // PAIRING FIRST. Set comparison alone cannot tell a complete history from a shifted
  // table: local=A/remote=B plus local=B/remote=A yields identical sets with zero rows
  // actually matching. When row evidence is available it is authoritative, and no
  // malformed pairing may become a successful classification.
  if (pairing) {
    if ((pairing.mismatchedPairs?.length ?? 0) > 0) {
      return {
        mode: "fail",
        preApplyRemoteMigrationCount: remote.length,
        unexpected: [],
        missing: local,
        reason:
          `hosted migration table contains ${pairing.mismatchedPairs.length} row(s) whose Local and Remote cells ` +
          `name different migrations (${pairing.mismatchedPairs.slice(0, 5).join(", ")}). A shifted or misparsed ` +
          "table is never certifiable in any mode.",
      };
    }
    // A local version on more than one row is malformed output whatever the other cells
    // say. It is listed here rather than as its own rule because it is the same class of
    // fact as the remote-side anomalies: a row the canonical pairing cannot explain.
    const oneSided = [
      ...(pairing.unexpectedRemote ?? []).map((v) => `remote-only ${v}`),
      ...(pairing.duplicateRemote ?? []).map((v) => `duplicate remote ${v}`),
      ...(pairing.duplicateLocal ?? []).map((v) => `duplicate local ${v}`),
      ...(pairing.unexpectedLocal ?? []).map((v) => `unknown local ${v}`),
      ...(pairing.malformedMigrationRows ?? []).map((v) => `unreadable row ${v}`),
    ];
    if (oneSided.length > 0) {
      return {
        mode: "fail",
        preApplyRemoteMigrationCount: remote.length,
        unexpected: pairing.unexpectedRemote ?? [],
        missing: local.filter((v) => !remote.includes(v)),
        reason:
          `hosted migration table contains ${oneSided.length} row anomaly/anomalies ` +
          `(${oneSided.slice(0, 5).join(", ")}${oneSided.length > 5 ? ", ..." : ""}). A row the parser could not ` +
          "pair is never normalized into a version set.",
      };
    }
    const expectedRows = pairing.localMigrationCount ?? local.length;
    if (remote.length > 0 && (pairing.matchedRows ?? 0) !== expectedRows) {
      return {
        mode: "fail",
        preApplyRemoteMigrationCount: remote.length,
        unexpected: [],
        missing: local.filter((v) => !remote.includes(v)),
        reason:
          `hosted target reports ${remote.length} remote migration version(s) but only ${pairing.matchedRows ?? 0} of ` +
          `${expectedRows} local migration(s) are paired to the SAME remote version. Repeatability requires row ` +
          "matches, not merely equal version sets.",
      };
    }
  }
  const unexpected = remote.filter((v) => !local.includes(v));
  const missing = local.filter((v) => !remote.includes(v));

  if (unexpected.length > 0) {
    return {
      mode: "fail",
      preApplyRemoteMigrationCount: remote.length,
      unexpected,
      missing,
      reason:
        `hosted target carries ${unexpected.length} migration version(s) with no local file ` +
        `(${unexpected.slice(0, 5).join(", ")}${unexpected.length > 5 ? ", ..." : ""}). Drifted targets are ` +
        "never certifiable as a fresh apply.",
    };
  }

  if (remote.length === 0) {
    return { mode: "fresh", preApplyRemoteMigrationCount: 0, unexpected: [], missing: local };
  }

  if (missing.length === 0) {
    return { mode: "repeatability", preApplyRemoteMigrationCount: remote.length, unexpected: [], missing: [] };
  }

  return {
    mode: "fail",
    preApplyRemoteMigrationCount: remote.length,
    unexpected: [],
    missing,
    reason:
      `hosted target already holds ${remote.length} of ${local.length} local migration(s) and is missing ` +
      `${missing.length}. Applying only the delta would NOT be a fresh apply; use an empty project to certify ` +
      "a fresh apply, or a fully-migrated one to prove repeatability.",
  };
}

// The harness addresses the hosted target through TWO independent channels: the CLI
// (linked by SUPABASE_PROJECT_REF) and psql (SUPABASE_DB_URL). If those point at
// different projects, an emptiness proof taken over one says nothing about the other —
// so the binding is proven before the probe is trusted, and before anything destructive.
//
// Positive extraction only. A URL is never accepted because it merely ends in a Supabase
// domain, contains a ref as a substring, or because the two ref variables agree.
// Supabase project refs are lowercase alphanumeric; both supported connection shapes
// encode the ref in a fixed position.
function extractSupabaseProjectRefFromDbUrl(dbUrl) {
  let parsed;
  try {
    parsed = new URL(String(dbUrl ?? ""));
  } catch {
    return { ok: false, reason: "SUPABASE_DB_URL is not a parseable connection URL." };
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    return { ok: false, reason: `SUPABASE_DB_URL is not a postgres connection URL (protocol ${parsed.protocol}).` };
  }
  const host = parsed.hostname.toLowerCase();
  const user = decodeURIComponent(parsed.username ?? "");

  // Direct database host: db.<PROJECT_REF>.supabase.co
  const direct = /^db\.([a-z0-9]{16,32})\.supabase\.(co|com)$/.exec(host);
  if (direct) return { ok: true, ref: direct[1], form: "direct" };

  // Pooler: the ref is encoded in the authenticated username as postgres.<PROJECT_REF>
  if (/(^|\.)pooler\.supabase\.(com|co)$/.test(host)) {
    const pooled = /^postgres\.([a-z0-9]{16,32})$/.exec(user);
    if (pooled) return { ok: true, ref: pooled[1], form: "pooler" };
    return {
      ok: false,
      reason: "SUPABASE_DB_URL uses a pooler host but its username is not postgres.<PROJECT_REF>, so the target project cannot be positively identified.",
    };
  }

  return {
    ok: false,
    reason: `SUPABASE_DB_URL host is not a recognized Supabase project form (expected db.<ref>.supabase.co or a pooler host with a postgres.<ref> username); refusing to guess the target project.`,
  };
}

function verifyHostedTargetBinding(dbUrl, projectRef) {
  const extracted = extractSupabaseProjectRefFromDbUrl(dbUrl);
  if (!extracted.ok) {
    return { ok: false, identified: false, reason: `DB_URL_PROJECT_REF_IDENTIFIED=NO — ${extracted.reason}` };
  }
  if (extracted.ref !== projectRef) {
    return {
      ok: false,
      identified: true,
      reason:
        `DB_URL_PROJECT_REF (${redact(extracted.ref)}) does not match SUPABASE_PROJECT_REF (${redact(projectRef)}). ` +
        "The CLI and the emptiness probe would address different projects; refusing to proceed.",
    };
  }
  return { ok: true, identified: true, ref: extracted.ref, form: extracted.form };
}

// An empty MIGRATION LEDGER is not an empty DATABASE. A project can carry a real
// application workload with no PMFreak migration history at all, and pushing into it
// would be destructive. This classifier turns raw counts into a structured verdict that
// NAMES the non-empty category, so a refusal is diagnosable instead of a bare boolean.
//
// Normal Supabase platform schemas and system objects must NOT make a genuinely new
// project look non-fresh, so the probe below counts only non-platform state.
function classifyObjectEmptiness(counts) {
  // Tables are not the only way a project carries an application. A target holding only
  // views, materialised views, sequences, foreign tables, functions/procedures or
  // user-defined types is NOT pristine and must never be fresh-applied.
  const categories = [
    ["user_schemas", "user-created schemas outside the Supabase platform set"],
    ["user_relations", "application relations (tables, partitioned tables, views, materialised views, sequences, foreign tables)"],
    ["public_rows", "rows in public application tables"],
    ["user_functions", "user-defined functions/procedures"],
    ["user_types", "user-defined types (composite, domain, enum)"],
    ["user_policies", "RLS policies that are not platform/extension-owned (including on managed relations such as storage.objects)"],
    ["user_triggers", "triggers that do not exactly match the certified stock platform baseline (extra, altered, or MISSING)"],
    ["user_event_triggers", "database-level event triggers that are not platform/extension-owned"],
    ["user_managed_schema_objects", "relations/indexes/functions/types inside managed schemas that do not exactly match ONE complete certified stock profile (extra, altered, re-owned, MISSING, or a hybrid of two profiles)"],
    ["user_schema_acl", "managed schema ACLs (pg_namespace.nspacl) that are not the certified stock grants (added, removed, or an unknown managed schema)"],
    ["user_default_acl", "ALTER DEFAULT PRIVILEGES rules (pg_default_acl) outside the certified stock set — these grant rights on objects the migration chain is about to create"],
    ["user_extensions", "installed PostgreSQL extensions that are not the certified stock set at the certified versions (extra, missing, or wrong version)"],
    ["user_managed_table_rows", "managed platform tables whose row state is not the certified pristine one (extra rows, missing bootstrap rows, altered stable content, or rows in a table a pristine project leaves empty)"],
    ["migration_rows", "PMFreak migration-history rows"],
    ["auth_users", "auth.users identities"],
    ["storage_buckets", "storage buckets"],
    ["storage_objects", "storage objects"],
  ];
  const nonEmpty = categories
    .filter(([key]) => Number(counts[key] ?? 0) > 0)
    .map(([key, description]) => ({ category: key, count: Number(counts[key] ?? 0), description }));
  return {
    empty: nonEmpty.length === 0,
    nonEmpty,
    reason: nonEmpty.length === 0
      ? null
      : `hosted target is NOT application-empty: ${nonEmpty.map((n) => `${n.category}=${n.count}`).join(", ")}. ` +
        "A fresh-apply certification requires a genuinely new project; this one already carries application state.",
  };
}

/**
 * CERTIFIED STOCK PLATFORM TRIGGER BASELINE.
 *
 * Measured on a genuinely stock, isolated Supabase project (no migrations, no seed):
 * a fresh instance carries ZERO non-extension-owned policies but FOUR non-internal,
 * non-extension-owned triggers. Those four are shipped by the storage service's own
 * migrations, so neither `tgisinternal` nor `pg_depend deptype='e'` excludes them —
 * counting them naively would make EVERY project non-fresh and disable fresh-apply.
 *
 * This is a STRICT STRUCTURAL baseline, deliberately NOT a names-only allowlist and
 * NOT an owner-based exemption: a user-created trigger can invoke a platform-owned
 * function, so function ownership alone proves nothing about the trigger's provenance.
 * A trigger is treated as platform stock ONLY when every fingerprint field matches,
 * including the normalised `pg_get_triggerdef()` text. A stock NAME with a changed
 * definition, a different function, or a different target relation is NOT stock.
 *
 * Drift is deliberately biased toward refusal: if a future Supabase version changes
 * its stock triggers, this baseline stops matching and the target is reported NON-empty
 * until the baseline is re-certified by hand. A false NON_EMPTY is always preferable to
 * a false EMPTY followed by a destructive push. The baseline is versioned source and is
 * NEVER learned from the target under inspection.
 */
const STOCK_PLATFORM_TRIGGER_BASELINE = Object.freeze([
  {
    relation_schema: "storage", relation_name: "buckets", trigger_name: "enforce_bucket_name_length_trigger",
    function_schema: "storage", function_name: "enforce_bucket_name_length", function_owner: "supabase_storage_admin",
    definition: 'CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length()',
  },
  {
    relation_schema: "storage", relation_name: "buckets", trigger_name: "protect_buckets_delete",
    function_schema: "storage", function_name: "protect_delete", function_owner: "supabase_storage_admin",
    definition: 'CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete()',
  },
  {
    relation_schema: "storage", relation_name: "objects", trigger_name: "protect_objects_delete",
    function_schema: "storage", function_name: "protect_delete", function_owner: "supabase_storage_admin",
    definition: 'CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete()',
  },
  {
    relation_schema: "storage", relation_name: "objects", trigger_name: "update_objects_updated_at",
    function_schema: "storage", function_name: "update_updated_at_column", function_owner: "supabase_storage_admin",
    definition: 'CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column()',
  },
]);

/** Whitespace-normalised so formatting differences are not mistaken for drift. */
function normalizeTriggerDefinition(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Classifies observed triggers against the certified baseline. Every field must match
 * for a trigger to be treated as stock; anything unmatched — extra, altered, retargeted,
 * or simply unrecognised — counts as an application customization. Ambiguity never
 * resolves to "empty".
 */
function classifyObservedTriggers(observed) {
  const remaining = STOCK_PLATFORM_TRIGGER_BASELINE.map((b) => ({ ...b, definition: normalizeTriggerDefinition(b.definition) }));
  const nonStock = [];
  for (const t of observed ?? []) {
    if (t.is_internal) continue;              // PostgreSQL internal (FK enforcement) triggers
    if (t.extension_owned) continue;          // positively proven extension-owned
    const fingerprint = {
      relation_schema: t.relation_schema, relation_name: t.relation_name, trigger_name: t.trigger_name,
      function_schema: t.function_schema, function_name: t.function_name, function_owner: t.function_owner,
      definition: normalizeTriggerDefinition(t.definition),
    };
    const idx = remaining.findIndex((b) =>
      b.relation_schema === fingerprint.relation_schema &&
      b.relation_name === fingerprint.relation_name &&
      b.trigger_name === fingerprint.trigger_name &&
      b.function_schema === fingerprint.function_schema &&
      b.function_name === fingerprint.function_name &&
      b.function_owner === fingerprint.function_owner &&
      b.definition === fingerprint.definition);
    if (idx === -1) {
      nonStock.push(`${fingerprint.relation_schema}.${fingerprint.relation_name}:${fingerprint.trigger_name}`);
      continue;
    }
    remaining.splice(idx, 1); // consume: a duplicated stock fingerprint is still an extra
  }
  // BOTH DRIFT DIRECTIONS. Checking only for extras meant an empty or partially
  // initialised target — one MISSING certified platform triggers — scored zero and
  // sailed through to the destructive push; `classifyObservedTriggers([])` literally
  // returned nonStockCount 0. A fresh target must present EXACTLY the certified stock
  // set: anything extra, altered, or absent is drift and refuses FRESH.
  const missingStock = remaining.map((b) => `${b.relation_schema}.${b.relation_name}:${b.trigger_name}`);
  return {
    nonStockCount: nonStock.length,
    nonStock,
    missingStockCount: missingStock.length,
    missingStock,
    baselineSatisfied: nonStock.length === 0 && missingStock.length === 0,
  };
}

/**
 * CERTIFIED PLATFORM OWNERSHIP FOR MANAGED SCHEMAS.
 *
 * WHY THIS EXISTS. The object inventory used to exclude every managed schema from the
 * relation/function/type counters, so a target holding ONLY a user-created
 * `storage.custom_table`, `auth.custom_fn` or `cron.custom_type` reported zero for all of
 * them and was certified application-empty immediately before a destructive `db push`.
 * The defect is the MODEL, not the counter: "the schema is managed" says nothing about
 * who created the object in it. Managed schema != platform owned.
 *
 * THE REPLACEMENT IS POSITIVE EVIDENCE, per object, from PostgreSQL's own metadata:
 *
 *   1. extension-owned  — proven by `pg_depend` deptype 'e'; already how every other
 *                         category exempts stock objects, and version-proof.
 *   2. platform-owned   — the object's OWNER is the role the platform service itself
 *                         runs its own migrations as. Supabase's auth service owns its
 *                         objects as `supabase_auth_admin`, storage as
 *                         `supabase_storage_admin`, and so on. An object created by an
 *                         operator through the SQL editor, a migration or the API is
 *                         owned by `postgres`, so it does NOT match — which is the whole
 *                         point.
 *
 * Anything else inside a managed schema counts as application state. Deliberately NOT a
 * name prefix, NOT a schema exemption, and NOT "trusted because it is in auth/storage".
 * A managed schema with no certified owner set (an unrecognised one) exempts NOTHING, so
 * a new platform schema fails closed rather than opening a hole.
 *
 * Biased toward refusal, exactly like the trigger baseline: if a future Supabase version
 * introduces a stock object under a different owner, this reports NON-empty until the
 * ownership model is re-certified by hand. A false NON_EMPTY is always preferable to a
 * false EMPTY followed by a destructive push.
 */
/**
 * CERTIFIED STOCK EXTENSION BASELINE — NAME **AND VERSION**.
 *
 * Every object carrying a `pg_depend` extension dependency is exempted from the object
 * inventory, which is sound only if the extension belongs on a pristine project. A
 * names-only list was not enough: `hstore` at any version is drift, but so is a STOCK
 * extension name at a version the platform never shipped — the name matched, every
 * object it owns stayed exempt, and the target certified fresh against a differently
 * versioned installation that `CREATE EXTENSION IF NOT EXISTS` would then meet.
 *
 * The fingerprint is `name@version@schema`. Drift in EITHER direction refuses FRESH: an
 * extra extension, a missing one, or a version that is not the certified one. A platform
 * upgrade therefore refuses until this list is re-certified by hand, which is intended.
 */
const STOCK_EXTENSION_BASELINE = Object.freeze([
  { name: "pg_stat_statements", version: "1.11", schema: "extensions" },
  { name: "pgcrypto", version: "1.3", schema: "extensions" },
  { name: "plpgsql", version: "1.0", schema: "pg_catalog" },
  { name: "supabase_vault", version: "0.3.1", schema: "vault" },
  { name: "uuid-ossp", version: "1.1", schema: "extensions" },
]);

const extensionKey = (e) => `${e.name}@${e.version}@${e.schema}`;

/** Classifies the installed extension set against the certified one, both directions. */
function classifyInstalledExtensions(observed) {
  const remaining = STOCK_EXTENSION_BASELINE.map(extensionKey);
  const nonStock = [];
  for (const e of observed ?? []) {
    const index = remaining.indexOf(extensionKey(e));
    if (index === -1) {
      nonStock.push(extensionKey(e));
      continue;
    }
    remaining.splice(index, 1);
  }
  return {
    nonStockCount: nonStock.length,
    nonStock,
    missingStockCount: remaining.length,
    missingStock: remaining,
    baselineSatisfied: nonStock.length === 0 && remaining.length === 0,
  };
}

/**
 * CERTIFIED ROW STATE FOR STOCK MANAGED TABLES.
 *
 * A table-name allowlist proved only "this table is normally non-empty". It did not
 * prove "these are the stock rows", so an extra row in a permitted ledger or bootstrap
 * table still certified as fresh. Every legitimately-populated table now carries an
 * explicit rule, and a populated managed table WITHOUT one refuses FRESH.
 *
 *   ledger     a platform service's own migration history: exact cardinality plus a
 *              digest over the stable key projection, so an inserted, removed or edited
 *              ledger row is caught. Version-bound by construction.
 *   bootstrap  rows a new project legitimately ships with: exact cardinality plus a
 *              digest over PLATFORM DEFAULT columns only. Instance-specific values —
 *              names, external ids, jwt secrets, timestamps — are deliberately excluded
 *              because they vary per project and fingerprinting them would refuse every
 *              target. The stable projection is what proves the row is bootstrap state.
 *   history    `supabase_migrations.schema_migrations`, governed by the migration-history
 *              contract and counted as `migration_rows`. Named here ONLY so it cannot be
 *              laundered through the stock-row allowance; it carries no row rule.
 */
const STOCK_MANAGED_ROW_RULES = Object.freeze({
  "auth.schema_migrations": { kind: "ledger", count: 77, projection: "version", digest: "a52750ffd8d87982d5a5425be6ea91c8" },
  "storage.migrations": { kind: "ledger", count: 63, projection: "id::text||':'||name", digest: "087989384b776815d32387b866b730df" },
  "realtime.schema_migrations": { kind: "ledger", count: 81, projection: "version::text", digest: "e6d7261362bd5fa45276ed1b993c6b5e" },
  "_realtime.schema_migrations": { kind: "ledger", count: 33, projection: "version::text", digest: "b206edc47893d6f354768ff7cf0ed724" },
  "supabase_functions.migrations": { kind: "ledger", count: 2, projection: "version", digest: "38b1040e3cbc0a1c5c3be8883b827734" },
  "_realtime.tenants": {
    kind: "bootstrap", count: 1, digest: "a2e42ef4144d4728594714480300a4e0",
    projection:
      "max_concurrent_users::text||','||max_events_per_second::text||','||max_bytes_per_second::text||','||" +
      "max_channels_per_client::text||','||max_joins_per_second::text||','||suspend::text||','||" +
      "postgres_cdc_default::text||','||private_only::text||','||presence_enabled::text",
  },
  "_realtime.feature_flags": {
    kind: "bootstrap", count: 1, digest: "e2b82a07ed6194d579dd0d4d143d40ed",
    projection: "name||','||enabled::text||','||coalesce(rollout_percentage::text,'')||','||coalesce(bucket_key,'')",
  },
  "_realtime.extensions": { kind: "bootstrap", count: 1, digest: "ef33364c7f2274ff477068170de843b5", projection: "type" },
  "supabase_migrations.schema_migrations": { kind: "history" },
});

/**
 * Classifies observed managed-table row state against the certified rules. Every failure
 * mode the finding named is a refusal: an extra row, a missing bootstrap row, a changed
 * stable field, and rows in a table that has no rule at all.
 */
function classifyManagedRowState(observed) {
  const problems = [];
  for (const t of observed ?? []) {
    const qualified = `${t.schema}.${t.name}`;
    const rule = STOCK_MANAGED_ROW_RULES[qualified];
    if (rule?.kind === "history") continue; // counted as migration_rows, never excused here
    if (Number(t.rows) === 0) continue;
    if (!rule) {
      problems.push(`${qualified}=${t.rows} (no certified stock row state; a pristine project has none)`);
      continue;
    }
    if (Number(t.rows) !== rule.count) {
      problems.push(`${qualified}=${t.rows} rows, certified ${rule.count}`);
      continue;
    }
    if (t.digest !== rule.digest) {
      problems.push(`${qualified} row content differs from the certified ${rule.kind} state`);
    }
  }
  // A certified table that is EMPTY is drift too: a pristine project carries those rows.
  for (const [qualified, rule] of Object.entries(STOCK_MANAGED_ROW_RULES)) {
    if (rule.kind === "history") continue;
    const seen = (observed ?? []).find((t) => `${t.schema}.${t.name}` === qualified);
    if (!seen || Number(seen.rows) === 0) {
      problems.push(`${qualified} is EMPTY but a pristine project carries ${rule.count} row(s)`);
    }
  }
  return { problemCount: problems.length, problems };
}

/**
 * The structural fingerprint an observed object must present to match the baseline.
 *
 * EXACT BYTES. This used to hash a whitespace-canonicalized form
 * (`replace(/\s+/g, " ")`), which is not SQL-lexically aware: it collapsed whitespace
 * INSIDE string literals, where whitespace is DATA rather than formatting. Reproduced
 * against the certified stock `realtime.apply_rls`: changing only
 * `'Error 400: Bad Request, no primary key'` to `'Error 400: Bad  Request, ...'` — a
 * function that now returns a different value — normalized to the same text and produced
 * the identical fingerprint c2529bc57768c673eb39c6e7, so a rewritten managed function
 * classified as certified stock.
 *
 * WHY EXACT RATHER THAN LEXICAL-AWARE NORMALIZATION. A lexer would have to be right about
 * single-quoted literals with doubled quotes, E'' escapes, quoted identifiers, and
 * dollar-quoted bodies with arbitrary tags — which `pg_get_functiondef` emits, and which
 * themselves contain single-quoted literals. Being wrong anywhere in that just moves the
 * collision inward, which is the failure mode this remediation exists to end. Hashing the
 * bytes cannot be wrong about SQL syntax because it makes no claim about it.
 *
 * THE TRADEOFF, STATED. Formatting-only differences now change the fingerprint too, so a
 * platform release that reformats its own deparse output refuses FRESH until the baseline
 * is re-certified by hand. That is the same bias every other certified baseline here
 * already carries: a false NON_EMPTY is always preferable to a false EMPTY followed by a
 * destructive push.
 */
function fingerprintDefinition(definition) {
  return createHash("sha256").update(String(definition ?? ""), "utf8").digest("hex").slice(0, 24);
}

/**
 * CERTIFIED MANAGED SCHEMA ACL BASELINE.
 *
 * The seventeenth remediation fingerprinted ACLs on relations, functions and types —
 * but not on the SCHEMAS containing them. `pg_namespace.nspacl` was read nowhere, so
 * `GRANT CREATE ON SCHEMA storage TO anon` changed the target's security posture while
 * every object fingerprint stayed byte-identical and the gate still certified it stock.
 * Reproduced before this fix, not inferred.
 *
 * Versioned source, never learned from the target. Drift in either direction refuses
 * FRESH: an added grant, a removed certified privilege, or an unknown managed schema.
 */
const STOCK_MANAGED_SCHEMA_ACL = Object.freeze([
  { schema: "_realtime", acl: "" },
  { schema: "auth", acl: "anon=U/supabase_admin,authenticated=U/supabase_admin,dashboard_user=UC/supabase_admin,postgres=U/supabase_admin,service_role=U/supabase_admin,supabase_admin=UC/supabase_admin,supabase_auth_admin=UC/supabase_admin" },
  { schema: "extensions", acl: "anon=U/postgres,authenticated=U/postgres,dashboard_user=UC/postgres,postgres=UC/postgres,service_role=U/postgres" },
  { schema: "graphql", acl: "anon=U/supabase_admin,authenticated=U/supabase_admin,postgres=U*/supabase_admin,service_role=U/supabase_admin,supabase_admin=UC/supabase_admin" },
  { schema: "graphql_public", acl: "anon=U/supabase_admin,authenticated=U/supabase_admin,postgres=U*/supabase_admin,service_role=U/supabase_admin,supabase_admin=UC/supabase_admin" },
  { schema: "pgbouncer", acl: "" },
  { schema: "realtime", acl: "anon=U/supabase_admin,authenticated=U/supabase_admin,postgres=U*/supabase_admin,service_role=U/supabase_admin,supabase_admin=UC/supabase_admin,supabase_realtime_admin=U*C*/supabase_admin" },
  { schema: "storage", acl: "anon=U/supabase_admin,authenticated=U/supabase_admin,dashboard_user=UC/supabase_admin,postgres=U*/supabase_admin,service_role=U/supabase_admin,supabase_admin=UC/supabase_admin,supabase_storage_admin=U*C*/supabase_admin" },
  { schema: "supabase_functions", acl: "anon=U/supabase_admin,authenticated=U/supabase_admin,postgres=U/supabase_admin,service_role=U/supabase_admin,supabase_admin=UC/supabase_admin,supabase_functions_admin=UC/supabase_admin" },
  { schema: "supabase_migrations", acl: "" },
  { schema: "vault", acl: "postgres=U*/supabase_admin,service_role=U/supabase_admin,supabase_admin=UC/supabase_admin" },
]);

function classifyManagedSchemaAcl(observed) {
  const remaining = STOCK_MANAGED_SCHEMA_ACL.map((e) => `${e.schema}=${e.acl}`);
  const nonStock = [];
  for (const s of observed ?? []) {
    const key = `${s.schema}=${s.acl}`;
    const index = remaining.indexOf(key);
    if (index === -1) {
      nonStock.push(key);
      continue;
    }
    remaining.splice(index, 1);
  }
  return {
    nonStockCount: nonStock.length,
    nonStock,
    missingStockCount: remaining.length,
    missingStock: remaining,
    baselineSatisfied: nonStock.length === 0 && remaining.length === 0,
  };
}

/**
 * CERTIFIED DEFAULT PRIVILEGE BASELINE (`pg_default_acl`).
 *
 * A customised `ALTER DEFAULT PRIVILEGES` rule grants privileges on objects the
 * migration chain is ABOUT to create, while every existing relation, function and type
 * stays identical. Reproduced: adding one rule moved `pg_default_acl` from 27 rows to
 * 28 with every current fingerprint unchanged and the target still certified stock.
 *
 * The whole rule set is certified as source: role, schema, object type and the ACL.
 */
const STOCK_DEFAULT_ACL = Object.freeze([
  { role: "postgres", schema: "public", objtype: "S", acl: "anon=rwU/postgres,authenticated=rwU/postgres,postgres=rwU/postgres,service_role=rwU/postgres" },
  { role: "postgres", schema: "public", objtype: "f", acl: "anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres" },
  { role: "postgres", schema: "public", objtype: "r", acl: "anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres" },
  { role: "postgres", schema: "storage", objtype: "S", acl: "anon=rwU/postgres,authenticated=rwU/postgres,postgres=rwU/postgres,service_role=rwU/postgres" },
  { role: "postgres", schema: "storage", objtype: "f", acl: "anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres" },
  { role: "postgres", schema: "storage", objtype: "r", acl: "anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres" },
  { role: "supabase_admin", schema: "extensions", objtype: "S", acl: "postgres=r*w*U*/supabase_admin" },
  { role: "supabase_admin", schema: "extensions", objtype: "f", acl: "postgres=X*/supabase_admin" },
  { role: "supabase_admin", schema: "extensions", objtype: "r", acl: "postgres=a*r*w*d*D*x*t*m*/supabase_admin" },
  { role: "supabase_admin", schema: "graphql", objtype: "S", acl: "anon=rwU/supabase_admin,authenticated=rwU/supabase_admin,postgres=rwU/supabase_admin,service_role=rwU/supabase_admin" },
  { role: "supabase_admin", schema: "graphql", objtype: "f", acl: "anon=X/supabase_admin,authenticated=X/supabase_admin,postgres=X/supabase_admin,service_role=X/supabase_admin" },
  { role: "supabase_admin", schema: "graphql", objtype: "r", acl: "anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,postgres=arwdDxtm/supabase_admin,service_role=arwdDxtm/supabase_admin" },
  { role: "supabase_admin", schema: "graphql_public", objtype: "S", acl: "anon=rwU/supabase_admin,authenticated=rwU/supabase_admin,postgres=rwU/supabase_admin,service_role=rwU/supabase_admin" },
  { role: "supabase_admin", schema: "graphql_public", objtype: "f", acl: "anon=X/supabase_admin,authenticated=X/supabase_admin,postgres=X/supabase_admin,service_role=X/supabase_admin" },
  { role: "supabase_admin", schema: "graphql_public", objtype: "r", acl: "anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,postgres=arwdDxtm/supabase_admin,service_role=arwdDxtm/supabase_admin" },
  { role: "supabase_admin", schema: "public", objtype: "S", acl: "anon=rwU/supabase_admin,authenticated=rwU/supabase_admin,postgres=rwU/supabase_admin,service_role=rwU/supabase_admin" },
  { role: "supabase_admin", schema: "public", objtype: "f", acl: "anon=X/supabase_admin,authenticated=X/supabase_admin,postgres=X/supabase_admin,service_role=X/supabase_admin" },
  { role: "supabase_admin", schema: "public", objtype: "r", acl: "anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,postgres=arwdDxtm/supabase_admin,service_role=arwdDxtm/supabase_admin" },
  { role: "supabase_admin", schema: "realtime", objtype: "S", acl: "dashboard_user=rwU/supabase_admin,postgres=rwU/supabase_admin" },
  { role: "supabase_admin", schema: "realtime", objtype: "f", acl: "dashboard_user=X/supabase_admin,postgres=X/supabase_admin" },
  { role: "supabase_admin", schema: "realtime", objtype: "r", acl: "dashboard_user=arwdDxtm/supabase_admin,postgres=arwdDxtm/supabase_admin" },
  { role: "supabase_admin", schema: "supabase_functions", objtype: "S", acl: "anon=rwU/supabase_admin,authenticated=rwU/supabase_admin,postgres=rwU/supabase_admin,service_role=rwU/supabase_admin" },
  { role: "supabase_admin", schema: "supabase_functions", objtype: "f", acl: "anon=X/supabase_admin,authenticated=X/supabase_admin,postgres=X/supabase_admin,service_role=X/supabase_admin" },
  { role: "supabase_admin", schema: "supabase_functions", objtype: "r", acl: "anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,postgres=arwdDxtm/supabase_admin,service_role=arwdDxtm/supabase_admin" },
  { role: "supabase_auth_admin", schema: "auth", objtype: "S", acl: "dashboard_user=rwU/supabase_auth_admin,postgres=rwU/supabase_auth_admin" },
  { role: "supabase_auth_admin", schema: "auth", objtype: "f", acl: "dashboard_user=X/supabase_auth_admin,postgres=X/supabase_auth_admin" },
  { role: "supabase_auth_admin", schema: "auth", objtype: "r", acl: "dashboard_user=arwdDxtm/supabase_auth_admin,postgres=arwdDxtm/supabase_auth_admin" },
]);

const defaultAclKey = (d) => `${d.role}|${d.schema}|${d.objtype}|${d.acl}`;

function classifyDefaultAcl(observed) {
  const remaining = STOCK_DEFAULT_ACL.map(defaultAclKey);
  const nonStock = [];
  for (const d of observed ?? []) {
    const index = remaining.indexOf(defaultAclKey(d));
    if (index === -1) {
      nonStock.push(defaultAclKey(d));
      continue;
    }
    remaining.splice(index, 1);
  }
  return {
    nonStockCount: nonStock.length,
    nonStock,
    missingStockCount: remaining.length,
    missingStock: remaining,
    baselineSatisfied: nonStock.length === 0 && remaining.length === 0,
  };
}

/**
 * CERTIFIED STOCK MANAGED-SCHEMA OBJECT BASELINE — WITH STRUCTURE.
 *
 * Matching on schema + kind + name + owner was not enough. All four survive a stock
 * object being REWRITTEN in place: `CREATE OR REPLACE` on a platform function, an
 * `ALTER TABLE` on a stock table, a same-named index rebuilt over different columns, a
 * type redefined. The identity fields still matched, so the target still certified as
 * pristine. Ownership was already shown not to be provenance; a name is not structure.
 *
 * Each entry therefore carries a `fingerprint`: a sha256 prefix over the EXACT bytes of a
 * deterministic definition —
 *
 *   relations  relkind, partition parent and bound, and every column in order with its
 *              type, nullability and default;
 *   views      the view definition; sequences their kind;
 *   indexes    `pg_get_indexdef`;
 *   functions  identity arguments (so overloads are distinct), return type, kind,
 *              volatility, security mode, and a digest of the body;
 *   types      typtype plus structure — enum labels in order, domain base, range
 *              subtype, composite attributes.
 *
 * It is NOT a hash of the name: the name is already a separate field, so a fingerprint
 * derived from it would prove nothing. Versioned source, never learned from the target
 * under inspection, and drift in either direction refuses FRESH.
 */
const LOCAL_STOCK_PROFILE = STOCK_MANAGED_OBJECT_PROFILES.find((p) => p.id === "local-cli-stock");
const HOSTED_STOCK_PROFILE = STOCK_MANAGED_OBJECT_PROFILES.find((p) => p.id === "hosted-platform-stock");
if (!LOCAL_STOCK_PROFILE || !HOSTED_STOCK_PROFILE) {
  throw new Error("the certified managed-object profiles are incomplete; refusing to classify anything as stock");
}

/**
 * The certified LOCAL profile's objects. One profile, never the union of both: a target is
 * certified against a COMPLETE profile, so this is the set the CLI development stack must
 * match in full. See classifyManagedSchemaObjects.
 */
const STOCK_MANAGED_OBJECT_BASELINE = LOCAL_STOCK_PROFILE.objects;

/**
 * THE ONE DYNAMIC EXCEPTION, ON STRUCTURAL EVIDENCE.
 *
 * The realtime service creates a `realtime.messages_YYYY_MM_DD` partition per day plus
 * its primary-key index, so no fixed list can hold them. The previous rule accepted a
 * name regex plus an owner — repeating exactly the provenance mistake the object
 * baseline exists to correct: a standalone table named `realtime.messages_2026_09_03`,
 * re-owned to `supabase_realtime_admin`, passed.
 *
 * Acceptance now requires the object to BE a partition of the certified parent:
 * the realtime service role owns it; the name carries a REAL calendar date; a relation
 * is `parent=realtime.messages` with a bound of exactly that date to the next day and
 * the certified column shape; an index is exactly the certified index over that
 * partition. All of it is checked as the same normalised definition the baseline uses,
 * with the date substituted into the certified template — so an altered column list, a
 * different bound, a standalone table or a rebuilt index all fail.
 */
// The THREE shapes the realtime service creates per day: the partition itself, its primary
// key, and the broadcast index. All three are date-derived, so none of them can be frozen
// into a static profile — a profile captured today would refuse every project on any other
// day. Both index shapes must prove ATTACHMENT to their certified partitioned parent index
// (realtime.messages_pkey and realtime.messages_inserted_at_topic_index respectively, both
// themselves certified static objects); a look-alike index that merely shares the
// definition is not the service's index and is refused.
const REALTIME_PARTITION_NAME = /^messages_(20\d{2})_(\d{2})_(\d{2})(_pkey|_inserted_at_topic_idx)?$/;
const REALTIME_PARTITION_TEMPLATES = Object.freeze({
  relation: "relkind=r|parent=realtime.messages|bound=FOR VALUES FROM ('<DATE> 00:00:00') TO ('<NEXT> 00:00:00')|cols=topic:text:NN:,extension:text:NN:,payload:jsonb:NULL:,event:text:NULL:,private:boolean:NULL:false,updated_at:timestamp without time zone:NN:now(),inserted_at:timestamp without time zone:NN:now(),id:uuid:NN:gen_random_uuid(),binary_payload:bytea:NULL:|cons=p:messages_<DATE_US>_pkey:PRIMARY KEY (id, inserted_at):NOTDEFERRABLE:INITIMMEDIATE:VALIDATED:,c:messages_payload_exclusive:CHECK (payload IS NULL OR binary_payload IS NULL):NOTDEFERRABLE:INITIMMEDIATE:VALIDATED:|acl=dashboard_user=arwdDxtm/supabase_realtime_admin,postgres=arwdDxtm/supabase_realtime_admin,supabase_realtime_admin=arwdDxtm/supabase_realtime_admin|rls=false/false|replident=d",
  index: "indexdef=CREATE UNIQUE INDEX messages_<DATE_US>_pkey ON realtime.messages_<DATE_US> USING btree (id, inserted_at)|indexparent=realtime.messages_pkey",
  topicIndex: "indexdef=CREATE INDEX messages_<DATE_US>_inserted_at_topic_idx ON realtime.messages_<DATE_US> USING btree (inserted_at DESC, topic) WHERE ((extension = 'broadcast'::text) AND (private IS TRUE))|indexparent=realtime.messages_inserted_at_topic_index",
});

/** The certified definition for a partition of a given date, or null if it is not one. */
function realtimePartitionDefinition(object) {
  if (object.schema !== "realtime" || object.owner !== "supabase_realtime_admin") return null;
  const match = REALTIME_PARTITION_NAME.exec(object.name);
  if (!match) return null;
  const [, year, month, day, suffix] = match;
  const isIndex = Boolean(suffix);
  if (isIndex ? object.kind !== "index" : object.kind !== "relation") return null;
  const date = `${year}-${month}-${day}`;
  // A REAL calendar date, not merely digit-shaped: `2026_02_31` is not a partition.
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  const next = new Date(parsed.getTime() + 86_400_000).toISOString().slice(0, 10);
  const template = suffix === "_pkey" ? REALTIME_PARTITION_TEMPLATES.index
    : suffix === "_inserted_at_topic_idx" ? REALTIME_PARTITION_TEMPLATES.topicIndex
    : REALTIME_PARTITION_TEMPLATES.relation;
  return template
    .split("<DATE_US>").join(`${year}_${month}_${day}`)
    .split("<DATE>").join(date)
    .split("<NEXT>").join(next);
}

function isRealtimeDailyPartition(object) {
  const expected = realtimePartitionDefinition(object);
  if (expected === null) return false;
  // The DEFINITION must match, byte for byte, for the same reason the fingerprint is now
  // exact: canonicalizing whitespace here would reopen the same literal-data collision.
  return String(object.definition ?? "") === String(expected);
}

/**
 * Classifies objects observed inside MANAGED schemas.
 *
 * Extension ownership is proven upstream in SQL (`pg_depend`); those rows never reach
 * here. What arrives is every non-extension-owned relation, function and type in a
 * managed schema, and each must be positively attributable to that schema's platform
 * role or it counts as application state.
 *
 * Pure, so every case below is unit-testable offline — no hosted project is contacted to
 * prove the classifier.
 */
/**
 * The emptiness contribution of a managed-object verdict. Zero requires a COMPLETE profile
 * match; anything else contributes at least one problem, so a target can never be certified
 * application-empty because its objects were individually findable across the union of
 * profiles.
 */
function managedObjectProblemCount(verdict) {
  if (verdict.baselineSatisfied) return 0;
  return Math.max(1, verdict.nonStockCount + verdict.missingStockCount);
}

function classifyManagedSchemaObjectsAgainstProfile(observed, profile) {
  const nonStock = [];
  // Consumed as they are matched, so a DUPLICATED stock fingerprint is still an extra,
  // and whatever is left over at the end is a MISSING stock object — drift in the other
  // direction, which an emptiness check that only looked for extras would have passed.
  const remaining = profile.objects.map((b) => ({ ...b }));
  for (const object of observed ?? []) {
    if (isRealtimeDailyPartition(object)) continue;
    // The probe always supplies a `definition`; a precomputed `fingerprint` is accepted
    // so offline regressions can construct observations without a database.
    const fingerprint = object.fingerprint ?? fingerprintDefinition(object.definition ?? "");
    const index = remaining.findIndex(
      (b) =>
        b.schema === object.schema && b.kind === object.kind && b.name === object.name &&
        b.owner === object.owner && b.fingerprint === fingerprint,
    );
    if (index === -1) {
      // Not certified stock. Neither ownership nor the name stands in for provenance: an
      // owner can be reassigned, and a stock object can be rewritten under its own name.
      nonStock.push(`${object.schema}.${object.name} (${object.kind}, owner ${object.owner || "unknown"})`);
      continue;
    }
    remaining.splice(index, 1);
  }
  const missingStock = remaining.map((b) => `${b.schema}.${b.name} (${b.kind})`);
  return {
    profileId: profile.id,
    nonStockCount: nonStock.length,
    nonStock,
    missingStockCount: missingStock.length,
    missingStock,
    baselineSatisfied: nonStock.length === 0 && missingStock.length === 0,
  };
}

/**
 * COMPLETE-PROFILE classification. Supabase ships materially different stock objects on
 * the local CLI stack and on the hosted platform, and remediation 28 made fingerprints
 * exact bytes, so no single set can certify both. A target is stock when it matches ONE
 * certified profile IN FULL:
 *
 *   MATCH(local) OR MATCH(hosted)
 *
 * NOT "every object matches something in some profile". That weaker union rule would
 * accept a Frankenstein platform assembled from mutually inconsistent snapshots — the
 * local build of one object beside the hosted build of another, a combination no real
 * platform ever shipped. Each profile is evaluated independently, and the verdict is a
 * complete match or nothing.
 */
function classifyManagedSchemaObjects(observed) {
  const profileResults = STOCK_MANAGED_OBJECT_PROFILES.map((profile) =>
    classifyManagedSchemaObjectsAgainstProfile(observed, profile));
  const matching = profileResults.filter((r) => r.baselineSatisfied);
  // Diagnostics come from the CLOSEST profile so a refusal is attributable to something a
  // maintainer can act on. This NEVER softens the verdict: `baselineSatisfied` below is a
  // complete-profile match, and the counts it reports are that profile's own, never a
  // per-object minimum taken across profiles.
  const closest = matching[0] ?? profileResults.reduce((best, r) =>
    (r.nonStockCount + r.missingStockCount) < (best.nonStockCount + best.missingStockCount) ? r : best);
  return {
    baselineSatisfied: matching.length > 0,
    // Which profile the target actually IS. Decided by content, never by a caller-supplied
    // label or an environment name — a target that claims to be hosted but carries the
    // local build is not hosted.
    matchedProfile: matching.length > 0 ? matching[0].profileId : null,
    // Explicit when profiles are indistinguishable over the observed surface, rather than
    // silently picking one.
    matchingProfiles: matching.map((r) => r.profileId),
    closestProfile: closest.profileId,
    profileResults,
    nonStockCount: closest.nonStockCount,
    nonStock: closest.nonStock,
    missingStockCount: closest.missingStockCount,
    missingStock: closest.missingStock,
  };
}

/** The managed schemas whose ACLs are certified. Kept beside the baseline it drives. */
const PLATFORM_SCHEMA_ACL_PREDICATE =
  "nspname IN ('auth','storage','realtime','_realtime','supabase_functions','vault','cron','net'," +
  "'supabase_migrations','extensions','graphql','graphql_public','pgbouncer','pgsodium','pgsodium_masks'," +
  "'_analytics','_supavisor')";

const PLATFORM_SCHEMA_PREDICATE =
  "n.nspname NOT LIKE 'pg\\_%' AND n.nspname NOT IN ('information_schema','public','auth','storage','realtime'," +
  "'extensions','graphql','graphql_public','pgbouncer','pgsodium','pgsodium_masks','pgtle','vault','cron','net'," +
  "'dbdev','pgmq','repack','tiger','tiger_data','topology','supabase_functions','supabase_migrations','etl'," +
  "'_analytics','_realtime','_supavisor','_timescaledb_cache','_timescaledb_catalog','_timescaledb_config'," +
  "'_timescaledb_internal','timescaledb_experimental','timescaledb_information')";

// Read-only probe over the already-required SUPABASE_DB_URL, through the existing psql
// runner. Never mutates; used only to decide whether a fresh apply may proceed.
function probeHostedApplicationState(dbUrl, runner = sh) {
  // Application schemas = public, plus any schema outside the Supabase platform set.
  // MANAGED schemas are NOT exempt — they are inventoried separately below, by ownership
  // rather than by schema name, because a custom object in `storage` is still custom.
  const APP = `(n.nspname = 'public' OR (${PLATFORM_SCHEMA_PREDICATE}))`;
  const MANAGED = `NOT (n.nspname = 'public' OR (${PLATFORM_SCHEMA_PREDICATE})) AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`;
  // Extension-owned objects are NOT application state. A stock Supabase project ships
  // plenty of them, so they are excluded through PostgreSQL's own dependency metadata
  // (pg_depend deptype 'e') rather than a hand-maintained list that would rot.
  const notExtensionOwned = (cls, alias) =>
    `not exists (select 1 from pg_depend d where d.classid = '${cls}'::regclass and d.objid = ${alias}.oid and d.deptype = 'e')`;
  const query = `
    select
      (select count(*) from pg_namespace n where ${PLATFORM_SCHEMA_PREDICATE}) as user_schemas,
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r','p','v','m','S','f','i','I') and ${APP}
           and ${notExtensionOwned("pg_class", "c")}) as user_relations,
      (select coalesce(sum(n_live_tup), 0) from pg_stat_user_tables where schemaname = 'public') as public_rows,
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where ${APP} and ${notExtensionOwned("pg_proc", "p")}) as user_functions,
      (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
         where ${APP} and t.typtype in ('c','d','e','r','m')
           and ${notExtensionOwned("pg_type", "t")}
           -- composite types implicitly created for a relation are already counted above
           and (t.typtype <> 'c' or not exists (
                 select 1 from pg_class rc where rc.oid = t.typrelid and rc.relkind <> 'c'))) as user_types,
      -- Policies are counted across EVERY schema, managed ones included: Supabase
      -- explicitly supports application RLS policies on storage.objects, so a managed
      -- schema does not make a policy platform state. A genuinely stock project was
      -- measured at ZERO non-extension-owned policies, so this needs no baseline.
      (select count(*) from pg_policy pol
         where not exists (select 1 from pg_depend d
                             where d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.deptype = 'e')) as user_policies,
      (select case when to_regclass('supabase_migrations.schema_migrations') is null then 0
                   else (select count(*) from supabase_migrations.schema_migrations) end) as migration_rows,
      (select case when to_regclass('auth.users') is null then 0
                   else (select count(*) from auth.users) end) as auth_users,
      (select case when to_regclass('storage.buckets') is null then 0
                   else (select count(*) from storage.buckets) end) as storage_buckets,
      (select case when to_regclass('storage.objects') is null then 0
                   else (select count(*) from storage.objects) end) as storage_objects;
  `;
  const result = runner("psql", ["-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", ",", dbUrl, "-c", query]);
  if (result.status !== 0) {
    // Fail closed: an unprovable target is never a fresh target.
    return { ok: false, failure: describeSpawnResult(result, "psql (hosted application-emptiness probe)"), stderr: result.stderr };
  }
  const fields = (result.stdout ?? "").trim().split(/\r?\n/).pop()?.split(",") ?? [];
  const keys = ["user_schemas", "user_relations", "public_rows", "user_functions", "user_types", "user_policies", "migration_rows", "auth_users", "storage_buckets", "storage_objects"];
  if (fields.length !== keys.length || fields.some((f) => !/^\d+$/.test(f.trim()))) {
    return { ok: false, reason: `the application-emptiness probe returned unrecognized output (${fields.length} field(s)); refusing to infer emptiness.` };
  }
  const counts = Object.fromEntries(keys.map((k, i) => [k, Number(fields[i].trim())]));

  // Triggers need per-object FINGERPRINTS, not a count, because the stock platform
  // baseline is matched structurally. A separate read-only query returns one row per
  // non-internal trigger; `~|~` is used as the field separator because a trigger
  // definition can legitimately contain almost anything else.
  const triggerQuery = `
    select n.nspname || '~|~' || c.relname || '~|~' || t.tgname || '~|~' || fn.nspname || '~|~' ||
           pr.proname || '~|~' || pg_get_userbyid(pr.proowner) || '~|~' ||
           replace(replace(pg_get_triggerdef(t.oid), chr(10), ' '), chr(13), ' ') || '~|~' ||
           case when exists (select 1 from pg_depend d
                               where d.classid = 'pg_trigger'::regclass and d.objid = t.oid and d.deptype = 'e')
                then 'ext' else 'user' end
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc pr on pr.oid = t.tgfoid
      join pg_namespace fn on fn.oid = pr.pronamespace
     where not t.tgisinternal;
  `;
  const trig = runner("psql", ["-v", "ON_ERROR_STOP=1", "-t", "-A", dbUrl, "-c", triggerQuery]);
  if (trig.status !== 0) {
    // Fail closed: an unprovable trigger surface is never an empty one.
    return { ok: false, failure: describeSpawnResult(trig, "psql (hosted trigger-fingerprint probe)"), stderr: trig.stderr };
  }
  const observed = [];
  for (const line of (trig.stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const f = line.split("~|~");
    if (f.length !== 8) {
      return { ok: false, reason: `the trigger-fingerprint probe returned an unrecognized row (${f.length} field(s)); refusing to infer emptiness.` };
    }
    observed.push({
      relation_schema: f[0], relation_name: f[1], trigger_name: f[2],
      function_schema: f[3], function_name: f[4], function_owner: f[5],
      definition: f[6], is_internal: false, extension_owned: f[7] === "ext",
    });
  }
  // EVENT TRIGGERS are database-level and live in pg_event_trigger, entirely outside
  // pg_trigger — so every counter above can read zero while a user event trigger sits
  // ready to fire during the migration DDL itself and rewrite or block the push. The
  // measured stock project carries ZERO of them, so no structural baseline is needed and
  // no schema exemption applies: anything not positively extension-owned refuses FRESH.
  const eventQuery = `
    -- evtenabled is a "char" and evtevent a name; both need an explicit cast, or
    -- PostgreSQL cannot choose a concatenation operator and this probe errors on
    -- EVERY database -- which is how it behaved until a live run exposed it.
    select evt.evtname::text || '~|~' || evt.evtevent::text || '~|~' || evt.evtenabled::text || '~|~' ||
           fn.nspname || '~|~' || pr.proname || '~|~' ||
           case when exists (select 1 from pg_depend d
                               where d.classid = 'pg_event_trigger'::regclass and d.objid = evt.oid and d.deptype = 'e')
                then 'ext' else 'user' end
      from pg_event_trigger evt
      join pg_proc pr on pr.oid = evt.evtfoid
      join pg_namespace fn on fn.oid = pr.pronamespace;
  `;
  const evt = runner("psql", ["-v", "ON_ERROR_STOP=1", "-t", "-A", dbUrl, "-c", eventQuery]);
  if (evt.status !== 0) {
    return { ok: false, failure: describeSpawnResult(evt, "psql (hosted event-trigger probe)"), stderr: evt.stderr };
  }
  const eventTriggers = [];
  for (const line of (evt.stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const f = line.split("~|~");
    if (f.length !== 6) {
      return { ok: false, reason: `the event-trigger probe returned an unrecognized row (${f.length} field(s)); refusing to infer emptiness.` };
    }
    // Extension ownership is the ONLY exemption, and only when pg_depend proves it. A
    // platform-owned trigger FUNCTION never launders the event trigger's own provenance.
    if (f[5] === "ext") continue;
    eventTriggers.push({ name: f[0], event: f[1], enabled: f[2], function_schema: f[3], function_name: f[4] });
  }
  counts.user_event_triggers = eventTriggers.length;

  // MANAGED-SCHEMA INVENTORY. One row per non-extension-owned relation, function and
  // type inside a managed schema, carrying the OWNER — the positive evidence the
  // classifier decides on. Extension-owned objects are excluded in SQL by pg_depend, so
  // a stock project's pg_cron/pg_net/pgsodium content never reaches the classifier.
  // Each row carries the object's STRUCTURAL DEFINITION, which the classifier
  // fingerprints. Identity fields alone cannot detect a stock object rewritten in place.
  const managedQuery = `
    select n.nspname || '~|~' || (case when c.relkind in ('i','I') then 'index' else 'relation' end) || '~|~' ||
           c.relname || '~|~' || pg_get_userbyid(c.relowner) || '~|~' ||
           translate(encode(convert_to((case
              -- An attached partition index carries its PARENT identity. An exact
              -- pg_get_indexdef does not prove attachment: a standalone index on the same
              -- partition may carry an equivalent definition, and equivalence is exactly
              -- what attaching one requires -- so the definition alone cannot distinguish
              -- a certified service index from a look-alike. The suffix is emitted ONLY
              -- when a parent exists, so no unattached index's fingerprint changes.
              when c.relkind in ('i','I') then 'indexdef=' || coalesce(pg_get_indexdef(c.oid), '')
                   || coalesce((select '|indexparent=' || pn.nspname || '.' || pc.relname
                                  from pg_inherits ii
                                  join pg_class pc on pc.oid = ii.inhparent
                                  join pg_namespace pn on pn.oid = pc.relnamespace
                                 where ii.inhrelid = c.oid), '')
              when c.relkind = 'v' then 'viewdef=' || coalesce(pg_get_viewdef(c.oid, true), '')
              when c.relkind = 'm' then 'matviewdef=' || coalesce(pg_get_viewdef(c.oid, true), '')
              when c.relkind = 'S' then 'sequence'
                   || '|increment=' || coalesce((select s.seqincrement::text from pg_sequence s where s.seqrelid = c.oid), '')
                   || '|start=' || coalesce((select s.seqstart::text from pg_sequence s where s.seqrelid = c.oid), '')
                   || '|min=' || coalesce((select s.seqmin::text from pg_sequence s where s.seqrelid = c.oid), '')
                   || '|max=' || coalesce((select s.seqmax::text from pg_sequence s where s.seqrelid = c.oid), '')
                   || '|cache=' || coalesce((select s.seqcache::text from pg_sequence s where s.seqrelid = c.oid), '')
                   || '|cycle=' || coalesce((select s.seqcycle::text from pg_sequence s where s.seqrelid = c.oid), '')
                   || '|acl=' || coalesce(array_to_string(array(select unnest(c.relacl)::text order by 1), ','), '(default)')
              else 'relkind=' || c.relkind::text
                   || '|parent=' || coalesce((select pn.nspname || '.' || pc.relname from pg_inherits i
                        join pg_class pc on pc.oid = i.inhparent join pg_namespace pn on pn.oid = pc.relnamespace
                        where i.inhrelid = c.oid), '')
                   || '|bound=' || coalesce(pg_get_expr(c.relpartbound, c.oid), '')
                   || '|cols=' || coalesce((select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
                        (case when a.attnotnull then 'NN' else 'NULL' end) || ':' ||
                        coalesce(pg_get_expr(ad.adbin, ad.adrelid), ''), ',' order by a.attnum)
                        from pg_attribute a left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
                        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '')
                   || '|cons=' || coalesce((select string_agg(con.contype::text || ':' || con.conname || ':' ||
                        pg_get_constraintdef(con.oid, true) || ':' ||
                        (case when con.condeferrable then 'DEFERRABLE' else 'NOTDEFERRABLE' end) || ':' ||
                        (case when con.condeferred then 'INITDEFERRED' else 'INITIMMEDIATE' end) || ':' ||
                        (case when con.convalidated then 'VALIDATED' else 'NOTVALIDATED' end) || ':' ||
                        coalesce((select rn.nspname || '.' || rc.relname from pg_class rc join pg_namespace rn on rn.oid = rc.relnamespace
                                  where rc.oid = con.confrelid), ''),
                        ',' order by con.conname)
                        from pg_constraint con where con.conrelid = c.oid
                          and not exists (select 1 from pg_depend d2 where d2.classid = 'pg_constraint'::regclass and d2.objid = con.oid and d2.deptype = 'e')), '')
                   || '|acl=' || coalesce(array_to_string(array(select unnest(c.relacl)::text order by 1), ','), '(default)')
        || '|rls=' || c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
        || '|replident=' || c.relreplident::text
            end), 'UTF8'), 'base64'), chr(10) || chr(13), '')
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r','p','v','m','S','f','i','I') and (${MANAGED})
       and ${notExtensionOwned("pg_class", "c")}
    union all
    select n.nspname || '~|~' || 'function' || '~|~' ||
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' || '~|~' ||
           pg_get_userbyid(p.proowner) || '~|~' ||
           translate(encode(convert_to(
             'def=' || coalesce(pg_get_functiondef(p.oid), 'ret=' || pg_catalog.format_type(p.prorettype, null) || '|kind=' || p.prokind::text) ||
             '|lang=' || l.lanname || '|strict=' || p.proisstrict::text || '|parallel=' || p.proparallel::text ||
             '|leakproof=' || p.proleakproof::text || '|vol=' || p.provolatile::text ||
             '|sec=' || (case when p.prosecdef then 'definer' else 'invoker' end) ||
             '|config=' || coalesce(array_to_string(array(select unnest(p.proconfig) order by 1), ','), '(none)') ||
             '|acl=' || coalesce(array_to_string(array(select unnest(p.proacl)::text order by 1), ','), '(default)')
           , 'UTF8'), 'base64'), chr(10) || chr(13), '')
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
     where (${MANAGED}) and ${notExtensionOwned("pg_proc", "p")}
    union all
    select n.nspname || '~|~' || 'type' || '~|~' || t.typname || '~|~' || pg_get_userbyid(t.typowner) || '~|~' ||
           translate(encode(convert_to(
           'typtype=' || t.typtype::text ||
           '|enum=' || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '') ||
           '|domainbase=' || coalesce((select format_type(t.typbasetype, t.typtypmod) where t.typtype = 'd'), '') ||
           '|domaincons=' || coalesce((select string_agg(con.conname || ':' || pg_get_constraintdef(con.oid, true), ',' order by con.conname)
                from pg_constraint con where con.contypid = t.oid), '') ||
           '|range=' || coalesce((select format_type(r.rngsubtype, null) from pg_range r where r.rngtypid = t.oid), '') ||
           '|attrs=' || coalesce((select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)
                from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped), '') ||
           '|acl=' || coalesce(array_to_string(array(select unnest(t.typacl)::text order by 1), ','), '(default)')
           , 'UTF8'), 'base64'), chr(10) || chr(13), '')
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where (${MANAGED}) and t.typtype in ('c','d','e','r','m')
       and ${notExtensionOwned("pg_type", "t")}
       and (t.typtype <> 'c' or not exists (
             select 1 from pg_class rc where rc.oid = t.typrelid and rc.relkind <> 'c'));
  `;
  const managed = runner("psql", ["-v", "ON_ERROR_STOP=1", "-t", "-A", dbUrl, "-c", managedQuery]);
  if (managed.status !== 0) {
    // Fail closed: an unprovable managed surface is never an empty one.
    return { ok: false, failure: describeSpawnResult(managed, "psql (managed-schema ownership probe)"), stderr: managed.stderr };
  }
  const managedObjects = [];
  for (const line of (managed.stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const f = line.split("~|~");
    if (f.length < 5) {
      return { ok: false, reason: `the managed-schema object probe returned an unrecognized row (${f.length} field(s)); refusing to infer emptiness.` };
    }
    // LOSSLESS TRANSPORT. The definition arrives base64-encoded because the previous
    // wire format flattened newlines to spaces (`replace(pg_get_functiondef(...), chr(10),
    // ' ')`) BEFORE JavaScript ever saw it — so a newline inside a string literal was
    // already erased upstream, and no JS-side fix could have recovered it. base64 also
    // removes a latent transport hazard: a definition containing a newline would
    // otherwise have split into fragments across the line-oriented reader.
    let definition;
    try {
      definition = Buffer.from(f.slice(4).join("~|~"), "base64").toString("utf8");
    } catch {
      return { ok: false, reason: "the managed-schema object probe returned an undecodable definition; refusing to infer emptiness." };
    }
    managedObjects.push({ schema: f[0], kind: f[1], name: f[2], owner: f[3], definition });
  }
  const managedVerdict = classifyManagedSchemaObjects(managedObjects);
  // Drift in EITHER direction defeats fresh certification, exactly as for triggers: a
  // target MISSING certified platform objects is not pristine either. Zero requires a
  // COMPLETE profile match — never merely that every object was found somewhere across the
  // union of profiles, which is how a hybrid platform would have slipped through.
  counts.user_managed_schema_objects = managedObjectProblemCount(managedVerdict);

  // INSTALLED EXTENSIONS. Exempting extension-owned objects is only sound if the
  // extension itself is stock, so the set is inventoried rather than assumed.
  const extResult = runner("psql", ["-v", "ON_ERROR_STOP=1", "-t", "-A", dbUrl, "-c",
    "select e.extname || '~|~' || e.extversion || '~|~' || n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace order by 1;"]);
  if (extResult.status !== 0) {
    return { ok: false, failure: describeSpawnResult(extResult, "psql (installed-extension probe)"), stderr: extResult.stderr };
  }
  const installedExtensions = [];
  for (const line of (extResult.stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const f = line.split("~|~");
    if (f.length !== 3) {
      return { ok: false, reason: `the installed-extension probe returned an unrecognized row (${f.length} field(s)); refusing to infer emptiness.` };
    }
    installedExtensions.push({ name: f[0], version: f[1], schema: f[2] });
  }
  // SCHEMA ACLs. Object-level grants were proven; the schemas holding them were not, so
  // `GRANT CREATE ON SCHEMA storage TO anon` changed the security posture invisibly.
  const schemaAclResult = runner("psql", ["-v", "ON_ERROR_STOP=1", "-t", "-A", dbUrl, "-c",
    "select nspname || '~|~' || coalesce(array_to_string(array(select unnest(nspacl)::text order by 1), ','), '(default)') " +
    "from pg_namespace where " + PLATFORM_SCHEMA_ACL_PREDICATE + " order by 1;"]);
  if (schemaAclResult.status !== 0) {
    return { ok: false, failure: describeSpawnResult(schemaAclResult, "psql (managed schema ACL probe)"), stderr: schemaAclResult.stderr };
  }
  const observedSchemaAcl = [];
  for (const line of (schemaAclResult.stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const f = line.split("~|~");
    if (f.length !== 2) {
      return { ok: false, reason: `the managed schema ACL probe returned an unrecognized row (${f.length} field(s)); refusing to infer emptiness.` };
    }
    observedSchemaAcl.push({ schema: f[0], acl: f[1] });
  }
  const schemaAclVerdict = classifyManagedSchemaAcl(observedSchemaAcl);
  counts.user_schema_acl = schemaAclVerdict.nonStockCount + schemaAclVerdict.missingStockCount;

  // DEFAULT PRIVILEGES. These grant rights on objects the migration chain is about to
  // create, while every existing object stays identical.
  const defaultAclResult = runner("psql", ["-v", "ON_ERROR_STOP=1", "-t", "-A", dbUrl, "-c",
    "select pg_get_userbyid(d.defaclrole) || '~|~' || coalesce(n.nspname, '(global)') || '~|~' || d.defaclobjtype::text || '~|~' || " +
    "coalesce(array_to_string(array(select unnest(d.defaclacl)::text order by 1), ','), '') " +
    "from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by 1;"]);
  if (defaultAclResult.status !== 0) {
    return { ok: false, failure: describeSpawnResult(defaultAclResult, "psql (default privileges probe)"), stderr: defaultAclResult.stderr };
  }
  const observedDefaultAcl = [];
  for (const line of (defaultAclResult.stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const f = line.split("~|~");
    if (f.length !== 4) {
      return { ok: false, reason: `the default-privileges probe returned an unrecognized row (${f.length} field(s)); refusing to infer emptiness.` };
    }
    observedDefaultAcl.push({ role: f[0], schema: f[1], objtype: f[2], acl: f[3] });
  }
  const defaultAclVerdict = classifyDefaultAcl(observedDefaultAcl);
  counts.user_default_acl = defaultAclVerdict.nonStockCount + defaultAclVerdict.missingStockCount;

  const extensionVerdict = classifyInstalledExtensions(installedExtensions);
  // Drift in EITHER direction: an extra extension, a missing one, or a wrong version.
  counts.user_extensions = extensionVerdict.nonStockCount + extensionVerdict.missingStockCount;
  const nonStockExtensions = extensionVerdict.nonStock;

  // ROWS IN STOCK MANAGED TABLES. `query_to_xml` runs one count per table inside a single
  // read-only statement, so no table is missed and nothing is mutated. Only the
  // platform's own bookkeeping may be non-empty.
  // Each populated table also returns a DIGEST over its certified stable projection, so
  // "this table may be non-empty" is no longer the whole test. The projections come from
  // STOCK_MANAGED_ROW_RULES, so the rules in source drive the SQL rather than the reverse.
  const EMPTY_SQL_STRING = "''";
  const projectionCase = Object.entries(STOCK_MANAGED_ROW_RULES)
    .filter(([, rule]) => typeof rule.projection === "string")
    .map(([qualified, rule]) => {
      const [schema, name] = qualified.split(".");
      const inner =
        `select md5(coalesce(string_agg(x, ${EMPTY_SQL_STRING}|${EMPTY_SQL_STRING} order by x), ` +
        `${EMPTY_SQL_STRING}${EMPTY_SQL_STRING})) as c from (select %s as x from %I.%I) s`;
      return (
        `when n.nspname = '${schema}' and c.relname = '${name}' then ` +
        `(xpath('/row/c/text()', query_to_xml(format('${inner}', ` +
        `'${rule.projection.replace(/'/g, "''")}', n.nspname, c.relname), false, true, ${EMPTY_SQL_STRING})))[1]::text`
      );
    })
    .join("\n              ");
  // ROW STATE IS NOT AN OWNERSHIP QUESTION. Extension ownership excuses an OBJECT from the
  // static managed profiles -- a stock project ships plenty of extension objects -- but it
  // says nothing about what a table CONTAINS. vault.secrets is owned by supabase_vault and
  // carries zero rows on pristine stock, so exempting it here let a target hold real
  // operator data and still certify as application-empty ahead of a destructive push. The
  // exemption is therefore NOT applied to this probe: every managed ordinary/partitioned
  // table is counted, whoever owns it, and classifyManagedRowState decides. That contract
  // is generic -- an extension-owned table with rows and no certified stock rule fails
  // closed, so a future platform image cannot smuggle state in behind an extension.
  const rowQuery = `
    select n.nspname || '~|~' || c.relname || '~|~' ||
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
           || '~|~' || coalesce((case
              ${projectionCase}
              else null end), '')
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r','p') and (${MANAGED});
  `;
  const rowResult = runner("psql", ["-v", "ON_ERROR_STOP=1", "-t", "-A", dbUrl, "-c", rowQuery]);
  if (rowResult.status !== 0) {
    return { ok: false, failure: describeSpawnResult(rowResult, "psql (managed-table row probe)"), stderr: rowResult.stderr };
  }
  const observedRowState = [];
  for (const line of (rowResult.stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const f = line.split("~|~");
    if (f.length !== 4 || !/^\d+$/.test(f[2].trim())) {
      return { ok: false, reason: `the managed-table row probe returned an unrecognized row (${f.length} field(s)); refusing to infer emptiness.` };
    }
    observedRowState.push({ schema: f[0], name: f[1], rows: Number(f[2].trim()), digest: f[3].trim() });
  }
  const rowVerdict = classifyManagedRowState(observedRowState);
  const populatedManagedTables = rowVerdict.problems;
  counts.user_managed_table_rows = rowVerdict.problemCount;

  const triggers = classifyObservedTriggers(observed);
  // Drift in EITHER direction defeats fresh certification.
  counts.user_triggers = triggers.nonStockCount + triggers.missingStockCount;

  const verdict = classifyObjectEmptiness(counts);
  return {
    ok: true, counts, observedTriggers: observed,
    nonStockTriggers: triggers.nonStock, missingStockTriggers: triggers.missingStock,
    eventTriggers, managedObjects,
    nonStockManagedObjects: managedVerdict.nonStock, missingStockManagedObjects: managedVerdict.missingStock,
    matchedManagedProfile: managedVerdict.matchedProfile, matchingManagedProfiles: managedVerdict.matchingProfiles,
    closestManagedProfile: managedVerdict.closestProfile, managedProfileResults: managedVerdict.profileResults,
    installedExtensions, nonStockExtensions, missingStockExtensions: extensionVerdict.missingStock,
    observedRowState, populatedManagedTables,
    observedSchemaAcl, nonStockSchemaAcl: schemaAclVerdict.nonStock, missingStockSchemaAcl: schemaAclVerdict.missingStock,
    observedDefaultAcl, nonStockDefaultAcl: defaultAclVerdict.nonStock, missingStockDefaultAcl: defaultAclVerdict.missingStock,
    verdict,
  };
}

// Reads the linked project's migration history WITHOUT mutating it.
//
// FAIL-CLOSED RECOGNITION. A zero exit does not prove the output was understood. The CLI
// prints one row per LOCAL migration even when the remote is empty, so with local
// migrations present, "zero recognized rows" can never legitimately mean "empty remote" —
// it means the format was not recognized. That is exactly how the earlier backtick
// regression behaved, and it must never be readable as TARGET_IS_FRESH.
function readHostedMigrationVersions(localTimestamps, runner = runNpx) {
  const list = runner(["-y", "supabase", "migration", "list", "--linked"], {
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN },
  });
  if (list.status !== 0) {
    return { ok: false, failure: describeSpawnResult(list, "npx supabase migration list --linked"), stderr: list.stderr };
  }
  const parsed = parseHostedMigrationList(list.stdout ?? "", localTimestamps);
  const recognition = recognizeMigrationListRows(parsed.rows, localTimestamps, parsed.malformedMigrationRows);
  if (!recognition.ok) return { ok: false, reason: recognition.reason };
  // ONE evidence object, DERIVED rather than re-listed.
  //
  // Remediation 21 fixed the handoff but assembled this object by naming fields, and its
  // comment claimed a parser field could never again be dropped. That claim was not
  // literally true: adding `localOnly` and `duplicateLocal` to the parser would have
  // required remembering to name them here too. Spreading the parser's own row evidence
  // makes the guarantee real — everything the parser produces except the raw `rows`
  // travels, and a future field arrives without a second edit.
  const { rows: _rows, ...rowEvidence } = parsed;
  const pairing = {
    ...rowEvidence,
    // `pendingLocal` is carried for completeness and drives no rule of its own:
    // `classifyHostedTarget` derives `missing` from the version sets and enforces pairing
    // through `matchedRows === localMigrationCount`.
    localMigrationCount: [...new Set(localTimestamps)].length,
  };

  return {
    ok: true,
    remoteVersions: parsed.rows.map((r) => r.remote).filter(Boolean),
    pairing,
    // The WHOLE row picture is carried forward. Passing only the mismatched pairs and a
    // match count still let one-sided anomalies vanish: `A|A`, `B|B` plus a bare `|A`
    // produced two clean matches, and `classifyHostedTarget` deduplicated the remote
    // versions so the stray row disappeared into an equal set and certified
    // repeatability. A row this parser could not account for must never be normalized
    // away by a later stage.
    matchedRows: parsed.matchedRows,
    mismatchedPairs: parsed.mismatchedPairs,
    unexpectedRemote: parsed.unexpectedRemote,
    pendingLocal: parsed.pendingLocal,
    duplicateRemote: parsed.duplicateRemote,
    localMigrationCount: [...new Set(localTimestamps)].length,
  };
}

// Pure, so the invariant is unit-testable without a CLI.
function recognizeMigrationListRows(rows, localTimestamps, malformedRows = []) {
  const locals = [...new Set(localTimestamps)];
  // Refused FIRST, and refused here rather than only at classification: on the fresh
  // shape the dropped row was the only remote version in the output, so the classifier
  // would have had nothing to object to.
  if (malformedRows.length > 0) {
    return {
      ok: false,
      reason:
        `UNRECOGNIZED_OUTPUT: ${malformedRows.length} migration row(s) carry a valid migration version ` +
        `alongside a cell this parser could not read (${malformedRows.slice(0, 5).join(", ")}` +
        `${malformedRows.length > 5 ? ", ..." : ""}). A partially understood row is never dropped as chatter.`,
    };
  }
  if (locals.length === 0) return { ok: true };
  if (rows.length === 0) {
    return {
      ok: false,
      reason:
        `UNRECOGNIZED_OUTPUT: 'supabase migration list --linked' exited 0 but no migration rows were recognized, ` +
        `while ${locals.length} local migration(s) exist. The CLI lists every LOCAL migration even against an empty ` +
        "remote, so zero recognized rows means the output format was not understood — not that the target is fresh.",
    };
  }
  // A row whose two populated cells disagree is a PARSING/PAIRING failure. It is never
  // normalized into two independent set members, because doing so is exactly what let a
  // shifted table read as a complete history.
  const mismatched = rows.filter((r) => r.local && r.remote && r.local !== r.remote);
  if (mismatched.length > 0) {
    const shown = mismatched.slice(0, 5).map((r) => `local=${r.local}/remote=${r.remote}`).join(", ");
    return {
      ok: false,
      reason:
        `UNRECOGNIZED_OUTPUT: ${mismatched.length} migration row(s) carry a Local and a Remote version that do ` +
        `not agree (${shown}${mismatched.length > 5 ? ", ..." : ""}). A populated pair must name the SAME ` +
        "migration; a shifted or misparsed table is never classifiable as history.",
    };
  }
  // Refused HERE, at recognition, and not only at classification. A Local version the
  // repository cannot explain means the table is not understood, and recognition failure
  // aborts before any classification — which is what protects the FRESH path, where the
  // classifier never sees a remote version to object to. `classifyHostedTarget` repeats
  // the refusal for callers that reach it directly.
  const unknownLocal = [...new Set(rows.map((r) => r.local).filter((v) => v && !locals.includes(v)))];
  if (unknownLocal.length > 0) {
    return {
      ok: false,
      reason:
        `UNRECOGNIZED_OUTPUT: the parsed migration table names ${unknownLocal.length} Local migration ` +
        `version(s) that this repository does not contain (${unknownLocal.slice(0, 5).join(", ")}` +
        `${unknownLocal.length > 5 ? ", ..." : ""}). A Local cell naming an unknown migration is not ` +
        "classifiable as either a fresh target or a matching history.",
    };
  }
  const seenLocal = new Set(rows.map((r) => r.local).filter(Boolean));
  const unaccounted = locals.filter((v) => !seenLocal.has(v));
  if (unaccounted.length > 0) {
    return {
      ok: false,
      reason:
        `UNRECOGNIZED_OUTPUT: the parsed migration table does not account for ${unaccounted.length} local ` +
        `migration(s) (${unaccounted.slice(0, 5).join(", ")}${unaccounted.length > 5 ? ", ..." : ""}). Refusing to ` +
        "classify the target from partially-understood output.",
    };
  }
  return { ok: true };
}

function verifyHostedRepeatability(files) {
  const list = runNpx(["-y", "supabase", "migration", "list", "--linked"], {
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN },
  });
  if (list.status !== 0) {
    return {
      ok: false,
      reason: "`supabase migration list --linked` failed",
      failure: describeSpawnResult(list, "npx supabase migration list --linked"),
      stderr: list.stderr,
    };
  }

  const localTimestamps = files.map((f) => f.match(/^(\d{14})_/)?.[1]).filter(Boolean);
  const parsed = parseHostedMigrationList(list.stdout ?? "", localTimestamps);

  if (parsed.mismatchedPairs.length > 0) {
    return {
      ok: false,
      reason:
        `${parsed.mismatchedPairs.length} migration row(s) pair a Local version with a DIFFERENT Remote version ` +
        `(${parsed.mismatchedPairs.slice(0, 5).join(", ")}${parsed.mismatchedPairs.length > 5 ? ", ..." : ""}). ` +
        "A shifted or misparsed table is never repeatability.",
    };
  }
  if (parsed.malformedMigrationRows.length > 0) {
    return {
      ok: false,
      reason: `${parsed.malformedMigrationRows.length} migration row(s) could not be fully read (${parsed.malformedMigrationRows.slice(0, 5).join(", ")}); a partially parseable row is never repeatability`,
    };
  }
  if (parsed.unexpectedLocal.length > 0) {
    return {
      ok: false,
      reason: `${parsed.unexpectedLocal.length} Local migration version(s) in the hosted table are not present in this repository (${parsed.unexpectedLocal.slice(0, 5).join(", ")}); an unexplainable Local cell is never repeatability`,
    };
  }
  if (parsed.duplicateLocal.length > 0) {
    return {
      ok: false,
      reason: `${parsed.duplicateLocal.length} local migration version(s) appear on more than one row (${parsed.duplicateLocal.slice(0, 5).join(", ")}); malformed output is never repeatability`,
    };
  }
  if (parsed.duplicateRemote.length > 0) {
    return {
      ok: false,
      reason: `${parsed.duplicateRemote.length} remote migration version(s) appear on more than one row (${parsed.duplicateRemote.slice(0, 5).join(", ")}); malformed output is never repeatability`,
    };
  }
  if (parsed.pendingLocal.length > 0) {
    return {
      ok: false,
      reason: `${parsed.pendingLocal.length} local migration(s) not recorded on the linked project (remote-pending): ${parsed.pendingLocal.slice(0, 5).join(", ")}${parsed.pendingLocal.length > 5 ? ", ..." : ""}`,
    };
  }
  if (parsed.unexpectedRemote.length > 0) {
    return {
      ok: false,
      reason: `${parsed.unexpectedRemote.length} migration(s) recorded on the linked project with no matching local file (remote-unexpected drift): ${parsed.unexpectedRemote.slice(0, 5).join(", ")}${parsed.unexpectedRemote.length > 5 ? ", ..." : ""}`,
    };
  }
  // matchedROWS, not a set size: repeatability means every local migration is recorded
  // against ITSELF on the remote, one row at a time.
  if (parsed.matchedRows !== files.length) {
    return {
      ok: false,
      reason:
        `migration pairing mismatch: ${files.length} local file(s) discovered but ${parsed.matchedRows} row(s) ` +
        `pair a local version with the SAME remote version (remote version set size ${parsed.matchedCount})`,
    };
  }

  return { ok: true, matchedCount: parsed.matchedCount, matchedRows: parsed.matchedRows };
}

// ─── Step 4: schema / RLS / RPC smoke checks (local mode) ──────────────────

function runSchemaSmoke(dbUrl) {
  const query = `
    select
      (select count(*) from pg_tables where schemaname = 'public') as table_count,
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) as tables_without_rls;
  `;
  const result = sh("psql", ["-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", ",", dbUrl, "-c", query]);
  if (result.status !== 0) return { ok: false, failure: describeSpawnResult(result, "psql (schema smoke)"), stderr: result.stderr };
  const [tableCount, tablesWithoutRls] = result.stdout.trim().split(",");
  return { ok: true, tableCount: Number(tableCount), tablesWithoutRls: Number(tablesWithoutRls) };
}

// ─── Report ─────────────────────────────────────────────────────────────────

function printAndWriteReport(lines) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const report = lines.join("\n");
  console.log(`\n${report}\n`);
  writeFileSync(path.join(REPORT_DIR, "fresh-db-migration-report.txt"), report + "\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const files = loadMigrationFiles();
  const mode = determineMode();

  console.log(`PMFreak Fresh Database Migration Proof`);
  console.log(`Mode: ${mode}`);
  console.log(`Migration files discovered: ${files.length}\n`);

  const results = [];

  const safe = safetyGuard(mode);
  results.push(["Environment safety", safe ? "PASS" : "FAIL"]);
  if (!safe) {
    printAndWriteReport(results.map(([k, v]) => `${k.padEnd(26, ".")} ${v}`));
    return;
  }

  const inventoryErrors = checkInventoryAndOrdering(files);
  results.push(["Migration inventory", inventoryErrors.length === 0 ? "PASS" : "FAIL"]);
  results.push(["Migration ordering", inventoryErrors.length === 0 ? "PASS" : "FAIL"]);
  if (inventoryErrors.length > 0) {
    inventoryErrors.forEach((e) => console.error(`  - ${e}`));
    process.exitCode = 1;
    // HARD PRECONDITION, not merely a failed exit code. This used to fall through: the
    // gate recorded "Migration inventory FAIL", set exitCode 1, and then carried on into
    // applyLocal/applyHosted anyway — so a source tree it had already judged invalid
    // (duplicate timestamps, malformed filenames, ordering defects) still reached
    // `psql`, `supabase link`, target classification and potentially `db push`. Exit
    // status is not side-effect prevention.
    //
    // The abort sits ABOVE the mode branch on purpose: one gate covers verify-only,
    // local and hosted, so no future mode can be added below it and quietly bypass it.
    results.push(["Decision", "FAIL — invalid migration inventory; NO database action attempted"]);
    console.error("  aborting before any database action: the migration source is invalid");
    printAndWriteReport(results.map(([k, v]) => `${k.padEnd(26, ".")} ${v}`));
    return;
  }

  if (mode === "verify-only") {
    results.push(["Fresh apply", "SKIPPED (no FRESH_DB_URL / SUPABASE_DB_URL set)"]);
    console.log("verify-only mode: static checks only. RR-MIGRATE cannot be closed from this run alone.");
    printAndWriteReport(results.map(([k, v]) => `${k.padEnd(26, ".")} ${v}`));
    return;
  }

  let applyResult;
  if (mode === "local") {
    applyResult = applyLocal(files);
  } else {
    applyResult = applyHosted(files);
  }

  const label = mode === "hosted" && applyResult.ok && applyResult.certification === "REPEATABILITY"
    ? "Fresh apply (SKIPPED — target already fully migrated; REPEATABILITY only)"
    : "Fresh apply";
  results.push([label, applyResult.ok ? "PASS" : "FAIL"]);
  if (!applyResult.ok) {
    console.error(`  Failed at: ${applyResult.failedFile ?? "(link/push step)"}`);
    if (applyResult.reason) console.error(`  ${applyResult.reason}`);
    if (applyResult.failure) console.error(formatFailure(applyResult.failure));
    process.exitCode = 1;
    printAndWriteReport(results.map(([k, v]) => `${k.padEnd(26, ".")} ${v}`));
    return;
  }

  if (mode === "local") {
    const smoke = runSchemaSmoke(process.env.FRESH_DB_URL);
    results.push(["Schema contracts", smoke.ok ? "PASS" : "FAIL"]);
    if (smoke.ok) {
      console.log(`  Tables in public schema: ${smoke.tableCount}`);
      console.log(`  Tables without RLS enabled: ${smoke.tablesWithoutRls}`);
    } else {
      console.error(formatFailure(smoke.failure));
      process.exitCode = 1;
    }
  } else {
    results.push(["Schema contracts", "MANUAL (run docs/release/database-bootstrap-runbook.md §5 against the linked project)"]);

    const repeatability = verifyHostedRepeatability(files);
    results.push(["Repeatability (remote state)", repeatability.ok ? "PASS" : "FAIL"]);
    if (!repeatability.ok) {
      console.error(`  ${repeatability.reason}`);
      if (repeatability.failure) console.error(formatFailure(repeatability.failure));
      process.exitCode = 1;
    } else {
      console.log(`  Matched local+remote migration rows: ${repeatability.matchedCount}`);
    }
  }

  results.push(["Decision", process.exitCode ? "FAIL — see above" : "PASS"]);
  printAndWriteReport(results.map(([k, v]) => `${k.padEnd(26, ".")} ${v}`));
}

// Main-module detection must compare resolved filesystem paths, not a hand-built
// file:// string. On Windows `process.argv[1]` is `C:\...\script.mjs` while
// `import.meta.url` is `file:///C:/.../script.mjs`, so the string comparison was
// always false and `main()` never ran — a silent EXIT=0 with no output.
// Importing the module (tests) must still NOT execute the destructive harness.
const isMainModule = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) main();

export {
  classifyManagedSchemaObjects,
  STOCK_MANAGED_OBJECT_BASELINE,
  STOCK_MANAGED_OBJECT_PROFILES,
  LOCAL_STOCK_PROFILE,
  HOSTED_STOCK_PROFILE,
  classifyManagedSchemaObjectsAgainstProfile,
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
  determineMode,
  safetyGuard,
  checkInventoryAndOrdering,
  redact,
  parseHostedMigrationList,
  classifyHostedTarget,
  classifyObjectEmptiness,
  classifyObservedTriggers,
  normalizeTriggerDefinition,
  STOCK_PLATFORM_TRIGGER_BASELINE,
  probeHostedApplicationState,
  extractSupabaseProjectRefFromDbUrl,
  verifyHostedTargetBinding,
  recognizeMigrationListRows,
  readHostedMigrationVersions,
  HOSTED_ALLOWED_VALIDATION_REFS,
  applyHosted,
  verifyHostedRepeatability,
  runNpx,
  scrubSecrets,
  describeSpawnResult,
  formatFailure,
  KNOWN_PRODUCTION_HOST_FRAGMENTS,
  HOSTED_ALLOWED_MIGRATION_VALIDATION_REF,
  HOSTED_DENIED_ACTIVE_PMFREAK_REF,
  loadMigrationFiles,
  main,
};
