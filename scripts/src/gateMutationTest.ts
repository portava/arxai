// Multi-broker spec §16 / Phase 2 — mutation tests proving the risk, mode and
// reconciliation gates can FAIL RED.
//
// WHY THIS EXISTS. Every safety gate in this repo ships with a test asserting
// it behaves correctly. That proves the gate works TODAY; it does not prove the
// test would NOTICE if someone broke the gate tomorrow. A test that passes
// against both the correct and the broken implementation is decoration — the
// same class of false assurance as the REVOKE that could not enforce anything
// (Owner Decision Registry, Ruling 12).
//
// HOW IT WORKS. For each case below: back the target file up, apply a surgical
// source mutation that BREAKS the gate, run the test that is supposed to catch
// it, and require a NON-ZERO exit. A mutation that SURVIVES (its test still
// passes) is a coverage hole and is reported as a failure. The original file is
// restored in a `finally`, and every restoration is verified by content hash
// before the harness exits.
//
// SAFETY:
//   * Refuses to run against a dirty worktree, so an interrupted run can never
//     be mistaken for — or confused by — genuine uncommitted edits.
//   * Restores from an in-memory copy of the original bytes in `finally`, then
//     re-verifies every file byte-for-byte at the end and reports loudly if any
//     file is left mutated.
//   * Mutates source ONLY; never touches the database, network, or git.

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const ROOT = join(import.meta.dirname, "../..");

interface MutationCase {
  /** What invariant this mutation breaks, in plain language. */
  readonly breaks: string;
  /** Repo-relative file to mutate. */
  readonly file: string;
  /** Exact source substring to replace (must appear EXACTLY once). */
  readonly find: string;
  /** The broken replacement. */
  readonly replace: string;
  /** pnpm filter + script that must go RED. */
  readonly pkg: string;
  readonly script: string;
}

const CASES: readonly MutationCase[] = [
  {
    breaks: "an UNKNOWN outcome must HOLD its exposure reservation, never release it",
    file: "artifacts/api-server/src/lib/live/liveCommandPipeline.ts",
    find: `    case "LIVE_ACKNOWLEDGED":
    case "LIVE_PARTIALLY_FILLED":
      return "HOLD";
    default:
      return "HOLD";`,
    replace: `    case "LIVE_ACKNOWLEDGED":
    case "LIVE_PARTIALLY_FILLED":
      return "RELEASE";
    default:
      return "RELEASE";`,
    pkg: "@workspace/api-server",
    script: "test:ack-partial-fill",
  },
  {
    breaks: "a short fill must be classified PARTIAL, not recorded as a full fill",
    file: "artifacts/api-server/src/lib/live/liveCommandPipeline.ts",
    find: "  return executed < requested - LIVE_VOLUME_EPSILON;",
    replace: "  return false;",
    pkg: "@workspace/api-server",
    script: "test:ack-partial-fill",
  },
  {
    breaks: "a success-looking EA report with NO broker ticket must be UNKNOWN, never FILLED",
    file: "artifacts/api-server/src/lib/live/liveCommandPipeline.ts",
    find: `  return input.hasBrokerTicket ? "LIVE_FILLED" : "LIVE_UNKNOWN";`,
    replace: `  return "LIVE_FILLED";`,
    pkg: "@workspace/api-server",
    script: "test:ack-partial-fill",
  },
  {
    breaks: "the emergency kill switch must refuse dispatch when engaged",
    file: "artifacts/api-server/src/lib/live/liveCommandPipeline.ts",
    find: "export function emergencyKillSwitchBlocksDispatch(",
    replace: "export function emergencyKillSwitchBlocksDispatch_MUTANT_UNUSED(",
    pkg: "@workspace/api-server",
    script: "test:emergency-kill-switch-gate",
  },
  {
    breaks: "the append-only ledger guard must reject raw-SQL UPDATE/DELETE",
    file: "scripts/src/ci/check-vault-mutations.ts",
    find: `const APPEND_ONLY_SQL_TABLES = [
  "execution_events",
  "owner_decisions",
];`,
    replace: `const APPEND_ONLY_SQL_TABLES: string[] = [];`,
    pkg: "@workspace/scripts",
    script: "test:vault-mutations",
  },
];

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function worktreeIsDirty(): boolean {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  // A git failure is NOT treated as clean: refuse rather than risk a mutation
  // run against an unknown working state.
  if (r.status !== 0) return true;
  return (r.stdout ?? "").trim().length > 0;
}

/** Run a package script; returns true when it FAILED (which is what we want). */
function scriptGoesRed(pkg: string, script: string): boolean {
  const r = spawnSync(
    "npx",
    ["--yes", "pnpm@9", "--filter", pkg, "run", script],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 180_000,
      env: {
        ...process.env,
        // The suites only need a parseable URL at module init; none of them
        // opens a connection.
        DATABASE_URL: process.env["DATABASE_URL"] ?? "postgres://u:p@127.0.0.1:1/none",
      },
    },
  );
  return r.status !== 0;
}

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;
  const fail = (msg: string) => { failures += 1; console.log(`  ✗ ${msg}`); };
  const pass = (msg: string) => { passes += 1; console.log(`  ✓ ${msg}`); };

  console.log("\ngateMutationTest — every safety gate must be able to fail red\n");

  if (worktreeIsDirty()) {
    console.log(
      "  ! SKIPPED: the worktree is dirty (or git is unavailable). This harness\n" +
      "    rewrites tracked source files and restores them, so it refuses to run\n" +
      "    when it cannot tell its own edits from yours. Commit or stash first.",
    );
    return { name: "gateMutationTest", passes: 0, failures: 0 };
  }

  const originals = new Map<string, string>();

  try {
    for (const c of CASES) {
      const abs = join(ROOT, c.file);
      const original = readFileSync(abs, "utf8");
      originals.set(abs, original);

      const occurrences = original.split(c.find).length - 1;
      if (occurrences !== 1) {
        // A drifted anchor means the mutation silently stopped testing
        // anything — that is itself a failure, never a skip.
        fail(`anchor matched ${occurrences}x (expected exactly 1) in ${c.file} — mutation "${c.breaks}" is not being applied`);
        continue;
      }

      writeFileSync(abs, original.replace(c.find, c.replace), "utf8");
      const wentRed = scriptGoesRed(c.pkg, c.script);
      writeFileSync(abs, original, "utf8");

      if (wentRed) {
        pass(`${c.script} catches: ${c.breaks}`);
      } else {
        fail(`MUTATION SURVIVED — ${c.script} still passes with this broken: ${c.breaks}`);
      }
    }
  } finally {
    // Restore unconditionally, then PROVE the tree is back.
    for (const [abs, original] of originals) {
      try { writeFileSync(abs, original, "utf8"); } catch { /* reported below */ }
    }
    for (const [abs, original] of originals) {
      let onDisk = "";
      try { onDisk = readFileSync(abs, "utf8"); } catch { /* falls through to mismatch */ }
      if (sha(onDisk) !== sha(original)) {
        failures += 1;
        console.log(`  ✗ CRITICAL: ${abs} was NOT restored — restore it from git before committing`);
      }
    }
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "gateMutationTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[gateMutationTest] FAILED:", err);
      process.exit(1);
    },
  );
}
