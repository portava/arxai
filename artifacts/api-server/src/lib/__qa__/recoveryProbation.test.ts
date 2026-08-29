// #34 Recovery Probation — pure ladder + consumer verdict tests (OFFLINE).
//
// Locks:
//   * AUTHORITY DIRECTION (property): the automatic transition predicate
//     accepts a move iff it does not increase authority — for every
//     (from, to) pair, isTighteningTransition(from,to) ⇔ rank(to) ≤ rank(from),
//     and a simulated auto-driven controller that honors the predicate can
//     NEVER raise authority no matter the input sequence.
//   * Owner-press ladder: nextStageTowardAuthority moves exactly one stage,
//     ends at NORMAL (exit), and every step INCREASES authority — i.e. the
//     automatic predicate refuses exactly what the press grants.
//   * FAKE-CLOCK dwell: an advance press is refused until the stage has been
//     held PROBATION_STAGE_MIN_DWELL_MS, and accepted at/after the boundary.
//   * Consumer matrices: dispatch (BLOCK_ALL/paper/live/A-tier) and guided
//     (only BLOCK_ALL refuses) verdicts; REDUCED_SIZE sizing halves and never
//     exceeds 1.
//   * Doorway mapping: cold release → PAPER_ONLY, hot activate-step release →
//     REDUCED_SIZE — a release NEVER maps to NORMAL/full authority.
//   * SEAM PIN: advanceRecoveryProbationOneStage (the widen seam) is invoked
//     ONLY from the admin route file — no worker/timer path can widen.
//
// Run: pnpm --filter @workspace/api-server run test:recovery-probation

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const {
  probationAuthorityRank,
  isTighteningTransition,
  nextStageTowardAuthority,
  advanceDwellSatisfied,
  initialStageForSource,
  probationDispatchVerdict,
  guidedProbationVerdict,
  probationSizingMultiplier,
  recoveryProbationEnabled,
  PROBATION_STAGE_MIN_DWELL_MS,
} = await import("../recoveryProbation.js");
type RecoveryMode = import("@workspace/domain/kill-switch").RecoveryMode;

const STAGES: RecoveryMode[] = ["BLOCK_ALL", "PAPER_ONLY", "A_PLUS_ONLY", "REDUCED_SIZE", "NORMAL"];
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0); // fake clock origin

// ── Authority-direction property ─────────────────────────────────────────────

test("property: the auto predicate accepts exactly the non-authority-increasing moves", () => {
  for (const from of STAGES) {
    for (const to of STAGES) {
      assert.equal(
        isTighteningTransition(from, to),
        probationAuthorityRank(to) <= probationAuthorityRank(from),
        `${from} → ${to}`,
      );
    }
  }
});

test("property: an auto controller honoring the predicate can never raise authority", () => {
  // Deterministic pseudo-random walk (no flake): try to move to arbitrary
  // stages; apply only when the predicate allows — rank must never rise.
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 50; run++) {
    let stage: RecoveryMode = STAGES[Math.floor(rand() * 4)]!; // any non-exited start
    let rank = probationAuthorityRank(stage);
    for (let step = 0; step < 100; step++) {
      const target = STAGES[Math.floor(rand() * STAGES.length)]!;
      if (isTighteningTransition(stage, target)) {
        stage = target;
        assert.ok(
          probationAuthorityRank(stage) <= rank,
          `auto transition raised authority: rank ${rank} → ${probationAuthorityRank(stage)}`,
        );
        rank = probationAuthorityRank(stage);
      }
    }
  }
});

test("owner-press ladder: one stage per press, strictly toward authority, ends at NORMAL", () => {
  let stage: RecoveryMode = "BLOCK_ALL";
  const seen: RecoveryMode[] = [stage];
  for (let i = 0; i < 10 && stage !== "NORMAL"; i++) {
    const next = nextStageTowardAuthority(stage);
    assert.ok(
      probationAuthorityRank(next) > probationAuthorityRank(stage),
      `press must widen: ${stage} → ${next}`,
    );
    // The press grants exactly what the automatic predicate refuses.
    assert.equal(isTighteningTransition(stage, next), false);
    stage = next;
    seen.push(stage);
  }
  assert.deepEqual(seen, ["BLOCK_ALL", "PAPER_ONLY", "A_PLUS_ONLY", "REDUCED_SIZE", "NORMAL"]);
  assert.equal(nextStageTowardAuthority("NORMAL"), "NORMAL"); // exit is terminal
});

// ── Fake-clock dwell ─────────────────────────────────────────────────────────

test("fake clock: advance dwell refuses before the boundary and accepts at it", () => {
  const entered = T0;
  assert.equal(advanceDwellSatisfied(entered, T0), false);
  assert.equal(advanceDwellSatisfied(entered, T0 + PROBATION_STAGE_MIN_DWELL_MS - 1), false);
  assert.equal(advanceDwellSatisfied(entered, T0 + PROBATION_STAGE_MIN_DWELL_MS), true);
  assert.equal(advanceDwellSatisfied(entered, T0 + PROBATION_STAGE_MIN_DWELL_MS + 1), true);
});

// ── Doorway mapping ──────────────────────────────────────────────────────────

test("no release doorway ever maps to full authority", () => {
  assert.equal(initialStageForSource("kill_switch_release"), "PAPER_ONLY");
  assert.equal(initialStageForSource("activate_step_release"), "REDUCED_SIZE");
  assert.equal(initialStageForSource("emergency_pause_release"), "PAPER_ONLY");
  for (const src of ["kill_switch_release", "activate_step_release", "emergency_pause_release"] as const) {
    assert.notEqual(initialStageForSource(src), "NORMAL");
  }
});

// ── Consumer matrices ────────────────────────────────────────────────────────

test("dispatch verdict matrix: BLOCK_ALL refuses everything; PAPER_ONLY refuses only live", () => {
  for (const mode of ["paper", "demo", "live"]) {
    assert.equal(probationDispatchVerdict({ stage: "BLOCK_ALL", executionMode: mode, edgeTier: "A" }).allowed, false, `BLOCK_ALL/${mode}`);
  }
  assert.equal(probationDispatchVerdict({ stage: "PAPER_ONLY", executionMode: "paper", edgeTier: null }).allowed, true);
  assert.equal(probationDispatchVerdict({ stage: "PAPER_ONLY", executionMode: "demo", edgeTier: null }).allowed, true);
  assert.equal(probationDispatchVerdict({ stage: "PAPER_ONLY", executionMode: "live", edgeTier: "A" }).allowed, false);
});

test("dispatch verdict matrix: A_PLUS_ONLY gates live on an A-tier edge; REDUCED_SIZE allows", () => {
  assert.equal(probationDispatchVerdict({ stage: "A_PLUS_ONLY", executionMode: "live", edgeTier: "A" }).allowed, true);
  assert.equal(probationDispatchVerdict({ stage: "A_PLUS_ONLY", executionMode: "live", edgeTier: "B" }).allowed, false);
  assert.equal(probationDispatchVerdict({ stage: "A_PLUS_ONLY", executionMode: "live", edgeTier: null }).allowed, false);
  assert.equal(probationDispatchVerdict({ stage: "A_PLUS_ONLY", executionMode: "paper", edgeTier: null }).allowed, true);
  assert.equal(probationDispatchVerdict({ stage: "REDUCED_SIZE", executionMode: "live", edgeTier: "C" }).allowed, true);
});

test("every refusal carries an honest reason (never a silent block)", () => {
  const refused = [
    probationDispatchVerdict({ stage: "BLOCK_ALL", executionMode: "paper", edgeTier: null }),
    probationDispatchVerdict({ stage: "PAPER_ONLY", executionMode: "live", edgeTier: "A" }),
    probationDispatchVerdict({ stage: "A_PLUS_ONLY", executionMode: "live", edgeTier: "B" }),
    guidedProbationVerdict("BLOCK_ALL"),
  ];
  for (const v of refused) {
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.length > 0 && v.reasons[0]!.length > 0);
  }
});

test("guided verdict: only BLOCK_ALL refuses the proven-demo guided path", () => {
  assert.equal(guidedProbationVerdict("BLOCK_ALL").allowed, false);
  for (const s of ["PAPER_ONLY", "A_PLUS_ONLY", "REDUCED_SIZE", "NORMAL"] as RecoveryMode[]) {
    assert.equal(guidedProbationVerdict(s).allowed, true, s);
  }
});

test("sizing multiplier never exceeds 1 and halves under any active stage", () => {
  assert.equal(probationSizingMultiplier(null), 1);
  assert.equal(probationSizingMultiplier("NORMAL"), 1);
  for (const s of ["BLOCK_ALL", "PAPER_ONLY", "A_PLUS_ONLY", "REDUCED_SIZE"] as RecoveryMode[]) {
    const m = probationSizingMultiplier(s);
    assert.equal(m, 0.5, s);
    assert.ok(m <= 1);
  }
});

// ── Env opt-out ──────────────────────────────────────────────────────────────

test("env opt-out: absent = enabled; explicit disable values disable", () => {
  assert.equal(recoveryProbationEnabled(undefined), true);
  assert.equal(recoveryProbationEnabled("1"), true);
  assert.equal(recoveryProbationEnabled("true"), true);
  for (const v of ["0", "false", "off", "no", " FALSE "]) {
    assert.equal(recoveryProbationEnabled(v), false, v);
  }
});

// ── Seam pin: only the admin route may widen ────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("seam pin: advanceRecoveryProbationOneStage is called ONLY from the admin route", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.resolve(here, "../..");   // artifacts/api-server/src
  const callers: string[] = [];
  for (const f of walk(srcRoot)) {
    if (f.includes("__qa__")) continue;
    const src = readFileSync(f, "utf8");
    // A call site, not the definition/exports.
    if (/advanceRecoveryProbationOneStage\s*\(\{/.test(src) && !f.endsWith("recoveryProbation.ts")) {
      callers.push(path.relative(srcRoot, f));
    }
  }
  assert.deepEqual(callers, ["routes/adminEngineDrivers.ts"],
    `the widen seam must have exactly one caller (the owner-press admin route); found: ${callers.join(", ")}`);
});

test("seam pin: the release doorways arm probation and the engage path only tightens", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const routeSrc = readFileSync(
    path.resolve(here, "../../routes/adminLiveSharedReadiness.ts"), "utf8",
  );
  // Both release doorways arm.
  assert.ok((routeSrc.match(/armRecoveryProbation\(/g) ?? []).length >= 2,
    "both the cold-release doorway and the activate-step release must arm probation");
  // The engage path tightens to BLOCK_ALL and never advances.
  assert.ok(routeSrc.includes('toStage: "BLOCK_ALL"'));
  assert.ok(!routeSrc.includes("advanceRecoveryProbationOneStage"));
});
