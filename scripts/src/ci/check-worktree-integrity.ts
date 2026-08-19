// Worktree-integrity tripwire — catch a stale-export overwrite BEFORE it is
// committed.
//
// WHY THIS GUARD EXISTS
// ---------------------
// Four times on 2026-08-19 a stale workspace export silently overwrote the
// Replit working tree. The signature both times was identical and machine-
// detectable:
//
//   1. Dozens-to-hundreds of tracked files showed up DELETED (the export was
//      taken before those files existed, so restoring it "deletes" them), and
//   2. `.replit` regained a secret literal that had been scrubbed from the
//      tracked file (the export predated the scrub).
//
// The damage happened when Replit's "Git commit prior to merge" auto-commit
// then committed that state, destroying reviewed work and re-publishing the
// secret. This guard runs with `ci:guards` and goes red on either signature so
// the state fails loudly before any commit can launder it.
//
// Two deliberately separate rules:
//
//   RULE 1 — MASS DELETION. More than MASS_DELETION_THRESHOLD tracked files
//   deleted (worktree or index, union of `git status --porcelain` and
//   `git diff --cached --name-status`) fails. Legitimate work deletes a
//   handful of files; only an overwrite from a stale snapshot deletes dozens
//   at once.
//
//   RULE 2 — SECRET LITERAL IN .replit. Any uncommented `NAME = "value"`
//   assignment in the on-disk `.replit` whose NAME contains KEY / SECRET /
//   TOKEN / PEPPER / PASSWORD and whose quoted value is 8+ characters fails.
//   `.replit` is git-tracked, so a secret literal there is one auto-commit
//   away from being published. Violations report the LINE NUMBER and VARIABLE
//   NAME only — the value itself is never printed, because a guard that
//   echoes the secret into CI logs re-leaks the thing it guards.
//
// GRACEFUL DEGRADATION (honesty doctrine — refuse/empty-with-reason, never
// fabricate): when git is not on PATH or the directory is not a work tree
// (CI environments that consume an export without `.git`), Rule 1 cannot be
// evaluated, so it is SKIPPED with an explicit note instead of false-failing.
// Rule 2 needs only the filesystem and runs regardless; a missing `.replit`
// is likewise a note, not an invented pass/fail.
//
// All classification is pure over an injected snapshot (`WorktreeSnapshot`) so
// the regression suite can exercise every branch without mutating a real repo.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, reportResult, type CheckResult } from "./_lib.js";

// ── Rule constants ──────────────────────────────────────────────────────────

/** More than this many tracked deletions = stale-export signature. */
export const MASS_DELETION_THRESHOLD = 20;

/** How many deleted paths to list verbatim before summarising the rest. */
export const DELETION_SAMPLE_LIMIT = 20;

/**
 * One .replit line that assigns a quoted 8+-char literal to a secret-shaped
 * variable name. Anchored at line start through `[A-Z_]*`, so a `#`-commented
 * line can never match; the explicit comment skip below states the same
 * constraint twice on purpose.
 */
export const SECRET_ASSIGNMENT_LINE_RE =
  /^\s*([A-Z_]*(?:KEY|SECRET|TOKEN|PEPPER|PASSWORD)[A-Z_]*)\s*=\s*"[^"]{8,}"/;

// ── Injected snapshot (pure input for classification) ───────────────────────

export interface WorktreeSnapshot {
  /** false = git binary missing / unrunnable. */
  gitAvailable: boolean;
  /** false = `git rev-parse --is-inside-work-tree` did not answer "true". */
  insideWorkTree: boolean;
  /** Raw stdout of `git status --porcelain`. */
  statusPorcelain: string;
  /** Raw stdout of `git diff --cached --name-status`. */
  stagedNameStatus: string;
  /** On-disk `.replit` content, or null when the file does not exist. */
  replitSource: string | null;
}

// ── Pure pieces ─────────────────────────────────────────────────────────────

/**
 * Union of deleted tracked paths from both git views, deduplicated. Porcelain
 * lines are `XY <path>` — a `D` in either column (staged deletion, worktree
 * deletion, or an unmerged DD/DU/UD state) counts. Name-status lines are
 * `D<TAB><path>`; renames (`R…`) are not deletions and are skipped.
 */
export function parseDeletedPaths(
  statusPorcelain: string,
  stagedNameStatus: string,
): string[] {
  const deleted = new Set<string>();

  for (const line of statusPorcelain.split("\n")) {
    if (line.length < 4) continue;
    if (line[0] !== "D" && line[1] !== "D") continue;
    deleted.add(line.slice(3));
  }

  for (const line of stagedNameStatus.split("\n")) {
    const parts = line.split("\t");
    if (parts[0] !== "D" || parts.length < 2) continue;
    deleted.add(parts[1]);
  }

  return [...deleted].sort();
}

export interface SecretFinding {
  /** 1-indexed line number in .replit. */
  line: number;
  /** The variable name only. The value is deliberately never captured. */
  variable: string;
}

/**
 * Scan .replit line-by-line for uncommented secret-literal assignments.
 * Returns line numbers and variable names ONLY — the matched value is dropped
 * on the floor here so no later code path can print it by accident.
 */
export function findReplitSecretAssignments(replitSource: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = replitSource.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("#")) continue;
    const m = SECRET_ASSIGNMENT_LINE_RE.exec(line);
    if (!m) continue;
    findings.push({ line: i + 1, variable: m[1] });
  }
  return findings;
}

/** Pure classification over an injected snapshot. */
export function classifyWorktreeIntegrity(snap: WorktreeSnapshot): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  // RULE 1 — mass deletion (needs git; skipped with a reason when unavailable).
  if (!snap.gitAvailable) {
    notes.push(
      "git is not available — mass-deletion tripwire SKIPPED (an export without git must not false-fail). The .replit secret scan still runs.",
    );
  } else if (!snap.insideWorkTree) {
    notes.push(
      "not a git work tree — mass-deletion tripwire SKIPPED (CI exports without .git must not false-fail). The .replit secret scan still runs.",
    );
  } else {
    const deleted = parseDeletedPaths(snap.statusPorcelain, snap.stagedNameStatus);
    if (deleted.length > MASS_DELETION_THRESHOLD) {
      violations.push(
        `${deleted.length} tracked files are deleted (worktree or index) — over the tripwire of ${MASS_DELETION_THRESHOLD}. ` +
          "This is the stale-export signature: a snapshot restored over the working tree deletes everything created since. " +
          "Do NOT commit. Restore the tree (git checkout -- . / git stash) and re-sync before any commit.",
      );
      for (const p of deleted.slice(0, DELETION_SAMPLE_LIMIT)) {
        violations.push(`deleted: ${p}`);
      }
      if (deleted.length > DELETION_SAMPLE_LIMIT) {
        violations.push(
          `… and ${deleted.length - DELETION_SAMPLE_LIMIT} more deleted paths (run \`git status --porcelain\` for the full list)`,
        );
      }
    } else {
      notes.push(
        `tracked deletions: ${deleted.length} (tripwire fires above ${MASS_DELETION_THRESHOLD}).`,
      );
    }
  }

  // RULE 2 — secret literal in .replit (filesystem only, runs regardless).
  if (snap.replitSource === null) {
    notes.push(".replit not found on disk — secret-literal scan has nothing to scan.");
  } else {
    const findings = findReplitSecretAssignments(snap.replitSource);
    for (const f of findings) {
      violations.push(
        `.replit:${f.line} → uncommented secret-shaped assignment \`${f.variable} = "…"\` (value REDACTED — never printed). ` +
          ".replit is git-tracked; committing this publishes the secret. Remove the literal and use Replit Secrets / env injection instead.",
      );
    }
    if (findings.length === 0) {
      notes.push(".replit scanned: no uncommented secret-literal assignments.");
    }
  }

  return {
    name: "worktree-integrity",
    ok: violations.length === 0,
    violations,
    notes,
  };
}

// ── Impure shell: gather the snapshot from the real environment ─────────────

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; ran: boolean } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { ok: false, stdout: "", ran: false };
  return { ok: r.status === 0, stdout: r.stdout ?? "", ran: true };
}

export function takeWorktreeSnapshot(root: string = ROOT): WorktreeSnapshot {
  let replitSource: string | null = null;
  try {
    replitSource = readFileSync(join(root, ".replit"), "utf8");
  } catch {
    replitSource = null;
  }

  const probe = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!probe.ran) {
    return {
      gitAvailable: false,
      insideWorkTree: false,
      statusPorcelain: "",
      stagedNameStatus: "",
      replitSource,
    };
  }
  const inside = probe.ok && probe.stdout.trim() === "true";
  if (!inside) {
    return {
      gitAvailable: true,
      insideWorkTree: false,
      statusPorcelain: "",
      stagedNameStatus: "",
      replitSource,
    };
  }

  const status = git(root, ["status", "--porcelain"]);
  const staged = git(root, ["diff", "--cached", "--name-status"]);
  // A work tree where status/diff themselves fail is indistinguishable from
  // "git unusable" — degrade the same way rather than classify partial data.
  if (!status.ok || !staged.ok) {
    return {
      gitAvailable: true,
      insideWorkTree: false,
      statusPorcelain: "",
      stagedNameStatus: "",
      replitSource,
    };
  }

  return {
    gitAvailable: true,
    insideWorkTree: true,
    statusPorcelain: status.stdout,
    stagedNameStatus: staged.stdout,
    replitSource,
  };
}

export function checkWorktreeIntegrity(): CheckResult {
  return classifyWorktreeIntegrity(takeWorktreeSnapshot());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkWorktreeIntegrity();
  reportResult(r);
  process.exit(r.ok ? 0 : 1);
}
