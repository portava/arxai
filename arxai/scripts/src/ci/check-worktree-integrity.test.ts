// Regression suite for the worktree-integrity tripwire.
//
// A guard that only ever passes is indistinguishable from no guard at all, so
// this suite plants the exact stale-export signatures the guard exists to
// catch and asserts it goes red on each:
//
//   - mass deletion in the WORKTREE view (`git status --porcelain` ` D` rows);
//   - mass deletion in the INDEX view (`git diff --cached --name-status` `D`
//     rows) — the state the "Git commit prior to merge" auto-commit commits;
//   - a secret literal re-appearing in the on-disk `.replit`.
//
// And it asserts the things the guard must tolerate, or it becomes a nuisance
// that gets disabled:
//
//   - ordinary trees (edits, adds, a handful of deletions at/under threshold);
//   - deduplication across the two git views (the same staged deletion appears
//     in BOTH commands' output and must count once);
//   - commented-out / short / unquoted .replit assignments;
//   - missing git / not-a-work-tree / missing .replit → PASS with a note,
//     never a false fail.
//
// REDACTION is asserted, not assumed: the planted fake secret value must not
// appear anywhere in the guard's output.
//
// Pure classification over injected snapshots — no repo mutation. The final
// section runs the real collector against this workspace and asserts SHAPE and
// redaction only: this scratchpad workspace is itself a stale export (hundreds
// of tracked deletions + a re-exposed .replit token), so the live result being
// red here is correct behavior, not a test failure.

import {
  classifyWorktreeIntegrity,
  findReplitSecretAssignments,
  parseDeletedPaths,
  checkWorktreeIntegrity,
  MASS_DELETION_THRESHOLD,
  DELETION_SAMPLE_LIMIT,
  type WorktreeSnapshot,
} from "./check-worktree-integrity.js";

export {};

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function expect(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** A healthy snapshot the cases below perturb one axis at a time. */
function cleanSnapshot(overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    gitAvailable: true,
    insideWorkTree: true,
    statusPorcelain: " M artifacts/api-server/src/index.ts\n?? scratch.md\n",
    stagedNameStatus: "M\tartifacts/api-server/src/index.ts\n",
    replitSource:
      'run = "npm run dev"\n# VAULT_OVERRIDE_TOKEN = "was-scrubbed-see-secrets"\nARX_BETA_INVITE_REQUIRED = "true"\n',
    ...overrides,
  };
}

const FAKE_SECRET_VALUE = "hunter2hunter2hunter2";

// eslint-disable-next-line no-console
console.log("\nworktree-integrity guard — regression suite");

// ── 1. Clean trees pass ─────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log("\n  Clean states");

{
  const r = classifyWorktreeIntegrity(cleanSnapshot());
  expect(
    "an ordinary working tree passes",
    r.ok && r.violations.length === 0 && r.name === "worktree-integrity",
    r.violations[0],
  );
}

{
  // Exactly AT threshold must pass — the tripwire is "more than", so a large
  // legitimate refactor at the boundary does not false-fail.
  const porcelain = Array.from(
    { length: MASS_DELETION_THRESHOLD },
    (_, i) => ` D src/legacy/file${i}.ts`,
  ).join("\n");
  const r = classifyWorktreeIntegrity(cleanSnapshot({ statusPorcelain: porcelain }));
  expect(
    `exactly ${MASS_DELETION_THRESHOLD} deletions (at threshold) passes`,
    r.ok,
    r.violations[0],
  );
}

// ── 2. Mass deletion — the stale-export signature ───────────────────────────
// eslint-disable-next-line no-console
console.log("\n  Rule 1 — mass deletion");

{
  const n = MASS_DELETION_THRESHOLD + 1;
  const porcelain = Array.from({ length: n }, (_, i) => ` D src/kept/file${i}.ts`).join("\n");
  const r = classifyWorktreeIntegrity(cleanSnapshot({ statusPorcelain: porcelain }));
  expect(
    `${n} worktree deletions (threshold + 1) fails`,
    !r.ok && r.violations[0].includes(`${n} tracked files`) && r.violations[0].includes("stale-export"),
    r.violations[0] ?? "no violation raised",
  );
  expect(
    "offending paths are listed",
    r.violations.some((v) => v.includes("deleted: src/kept/file0.ts")),
    r.violations.slice(1, 3).join(" | "),
  );
}

{
  // Deletions visible only in the INDEX (already staged by the auto-commit
  // machinery) must fire even when the porcelain worktree column is quiet.
  const staged = Array.from({ length: 40 }, (_, i) => `D\tsrc/kept/file${i}.ts`).join("\n");
  const r = classifyWorktreeIntegrity(
    cleanSnapshot({ statusPorcelain: "", stagedNameStatus: staged }),
  );
  expect(
    "40 staged-only deletions fail via git diff --cached",
    !r.ok && r.violations[0].includes("40 tracked files"),
    r.violations[0] ?? "no violation raised",
  );
}

{
  // The same staged deletion shows up in BOTH commands (`D ` porcelain row and
  // `D<TAB>` name-status row). Counting it twice would fire the tripwire at
  // half the intended threshold.
  const paths = Array.from({ length: MASS_DELETION_THRESHOLD }, (_, i) => `src/x/file${i}.ts`);
  const porcelain = paths.map((p) => `D  ${p}`).join("\n");
  const staged = paths.map((p) => `D\t${p}`).join("\n");
  const deduped = parseDeletedPaths(porcelain, staged);
  const r = classifyWorktreeIntegrity(
    cleanSnapshot({ statusPorcelain: porcelain, stagedNameStatus: staged }),
  );
  expect(
    "a deletion seen by both git views counts once",
    deduped.length === MASS_DELETION_THRESHOLD && r.ok,
    `${deduped.length} unique, ok=${r.ok}`,
  );
}

{
  // Renames and modifications are not deletions.
  const noise = ["R100\tsrc/a.ts\tsrc/b.ts", "M\tsrc/c.ts"].join("\n");
  expect(
    "renames/modifications in name-status are not counted as deletions",
    parseDeletedPaths("", noise).length === 0,
  );
}

{
  // Huge deletion lists are summarised, not dumped wholesale into CI output.
  const porcelain = Array.from({ length: 300 }, (_, i) => ` D f${i}.ts`).join("\n");
  const r = classifyWorktreeIntegrity(cleanSnapshot({ statusPorcelain: porcelain }));
  const sampled = r.violations.filter((v) => v.startsWith("deleted: ")).length;
  expect(
    "deletion listing is capped with an honest remainder count",
    sampled === DELETION_SAMPLE_LIMIT &&
      r.violations.some((v) => v.includes(`${300 - DELETION_SAMPLE_LIMIT} more deleted paths`)),
    `${sampled} sampled of 300`,
  );
}

// ── 3. Secret literal in .replit ────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log("\n  Rule 2 — .replit secret literal");

{
  const replit = `run = "npm run dev"\n\nVAULT_OVERRIDE_TOKEN = "${FAKE_SECRET_VALUE}"\n`;
  const r = classifyWorktreeIntegrity(cleanSnapshot({ replitSource: replit }));
  expect(
    "an uncommented secret assignment fails with line + variable name",
    !r.ok &&
      r.violations.length === 1 &&
      r.violations[0].includes(".replit:3") &&
      r.violations[0].includes("VAULT_OVERRIDE_TOKEN"),
    r.violations[0] ?? "no violation raised",
  );
  const everywhere = [...r.violations, ...(r.notes ?? [])].join("\n");
  expect(
    "the secret VALUE never appears in the guard's output",
    !everywhere.includes(FAKE_SECRET_VALUE),
  );
}

{
  const findings = findReplitSecretAssignments(
    [
      `API_KEY = "${FAKE_SECRET_VALUE}"`, // matches: KEY
      `SESSION_SECRET = "${FAKE_SECRET_VALUE}"`, // matches: SECRET
      `HASH_PEPPER = "${FAKE_SECRET_VALUE}"`, // matches: PEPPER
      `DB_PASSWORD = "${FAKE_SECRET_VALUE}"`, // matches: PASSWORD
      `  MY_TOKEN = "${FAKE_SECRET_VALUE}"`, // matches: leading whitespace ok
      `# OLD_TOKEN = "${FAKE_SECRET_VALUE}"`, // commented — must not match
      `TOKEN = "short"`, // under 8 chars — must not match
      `MY_TOKEN = $VAULT_REF`, // unquoted env reference — must not match
      `ARX_BETA_INVITE_REQUIRED = "true"`, // no secret-shaped word — must not match
      `monKEYpatch = "${FAKE_SECRET_VALUE}"`, // lowercase name — must not match
    ].join("\n"),
  );
  expect(
    "secret-name matching: 5 planted shapes hit, 5 decoys ignored",
    findings.length === 5 &&
      findings.map((f) => f.variable).join(",") ===
        "API_KEY,SESSION_SECRET,HASH_PEPPER,DB_PASSWORD,MY_TOKEN",
    findings.map((f) => `${f.line}:${f.variable}`).join(","),
  );
  expect(
    "findings carry line numbers and variable names only (no value field)",
    findings.every((f) => Object.keys(f).sort().join(",") === "line,variable"),
  );
}

// ── 4. Graceful degradation — never a false fail ────────────────────────────
// eslint-disable-next-line no-console
console.log("\n  Degradation — exports without git must not false-fail");

{
  const r = classifyWorktreeIntegrity(
    cleanSnapshot({ gitAvailable: false, statusPorcelain: "", stagedNameStatus: "" }),
  );
  expect(
    "git unavailable → PASS with an explicit skip note",
    r.ok && (r.notes ?? []).some((n) => n.includes("git is not available")),
    (r.notes ?? []).join(" | "),
  );
}

{
  const r = classifyWorktreeIntegrity(
    cleanSnapshot({ insideWorkTree: false, statusPorcelain: "", stagedNameStatus: "" }),
  );
  expect(
    "not a work tree → PASS with an explicit skip note",
    r.ok && (r.notes ?? []).some((n) => n.includes("not a git work tree")),
    (r.notes ?? []).join(" | "),
  );
}

{
  // Degraded git must NOT degrade the secret scan — the one state the incident
  // actually produced is "no usable git, secret back in .replit".
  const r = classifyWorktreeIntegrity(
    cleanSnapshot({
      gitAvailable: false,
      statusPorcelain: "",
      stagedNameStatus: "",
      replitSource: `X_TOKEN = "${FAKE_SECRET_VALUE}"\n`,
    }),
  );
  expect(
    "secret scan still fires when git is unavailable",
    !r.ok && r.violations[0].includes("X_TOKEN"),
    r.violations[0] ?? "no violation raised",
  );
}

{
  const r = classifyWorktreeIntegrity(cleanSnapshot({ replitSource: null }));
  expect(
    "missing .replit → PASS with a note, not an invented result",
    r.ok && (r.notes ?? []).some((n) => n.includes(".replit not found")),
    (r.notes ?? []).join(" | "),
  );
}

// ── 5. Live collector — shape and redaction only ────────────────────────────
// This workspace is itself a stale export (that incident is why this guard
// exists), so the live result is legitimately red here. Asserting ok===true
// would be asserting a falsehood; asserting shape + redaction is what is
// honestly checkable everywhere.
// eslint-disable-next-line no-console
console.log("\n  Live collector");

{
  const r = checkWorktreeIntegrity();
  expect(
    "live run returns a well-formed CheckResult",
    r.name === "worktree-integrity" &&
      typeof r.ok === "boolean" &&
      Array.isArray(r.violations) &&
      Array.isArray(r.notes ?? []),
    r.ok ? "live tree clean" : `${r.violations.length} violation(s) on the live tree (expected in a stale-export workspace)`,
  );
  const secretLines = r.violations.filter((v) => v.startsWith(".replit:"));
  expect(
    "live .replit violations (if any) are redacted",
    secretLines.every((v) => v.includes("REDACTED") && !/=\s*"[^"…]{8,}"/.test(v)),
    secretLines[0] ?? "no .replit violation on the live tree",
  );
}

const failed = results.filter((r) => !r.ok).length;
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed}/${results.length} worktree-integrity cases passed`);
process.exit(failed === 0 ? 0 : 1);
