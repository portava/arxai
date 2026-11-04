// Profit Mission Phase 1 — pure engine + copy-guard contract tests.
//
// Locks the deterministic planning math, the feasibility tiering (incl. the
// fail-closed Unreasonable path and extreme→high-risk), the probability/
// sample-size honesty, and the banned-vocabulary guard over the engines' own
// generated copy. Everything here is PURE and IO-free — identical inputs always
// produce identical output, which is the "honest estimate, never a promise"
// guarantee. No DB, no network, no clock (callers pass `nowMs`).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMissionMath,
  evaluateFeasibility,
  evaluateProbability,
  checkMissionCopy,
  checkMissionCopyDeep,
  MISSION_BANNED_PHRASES,
  MISSION_STATUSES,
  MISSION_TERMINAL_STATES,
  MISSION_TRANSITIONS,
  canTransition,
  evaluateTransition,
  isTerminalStatus,
  isMissionStatus,
  resolveUserAction,
  specToMinutes,
  specToLabel,
  minutesToSpec,
  resolveMissionTimeframeLabel,
  TIMEFRAME_QUICK_PICKS,
} from "@workspace/domain/profit-mission";
import { parseMissionIntent } from "../assistant/parseMissionIntent.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 5); // a fixed Monday-ish anchor; deterministic

function math(start: number, target: number, days: number, current?: number) {
  return computeMissionMath({
    startingAmount: start,
    targetAmount: target,
    timeframeStartMs: NOW,
    timeframeEndMs: NOW + days * DAY,
    currentValue: current,
    nowMs: NOW,
  });
}

// ── Math ─────────────────────────────────────────────────────────────────────
test("required profit / return / compound daily pace are exact", () => {
  const m = math(1000, 1300, 7); // the canonical $1,000 → $1,300 in 7 days
  assert.equal(m.requiredProfit, 300);
  assert.equal(m.requiredReturnPct, 30);
  assert.equal(m.totalDays, 7);
  // geometric daily return: (1.3^(1/7) - 1) * 100 ≈ 3.819%
  assert.ok(Math.abs(m.requiredDailyReturnPct - 3.819) < 0.01);
  // linear daily pace
  assert.ok(Math.abs(m.requiredDailyProfit - 300 / 7) < 1e-9);
  assert.equal(m.invalid, false);
});

test("progress clamps to 0–100 and pace tracks realised vs required", () => {
  const m = math(1000, 1300, 7, 1150); // halfway in value
  assert.equal(m.progressPct, 50); // (1150-1000)/300 = 50%
  assert.equal(m.progressPctClamped, 50);
  const over = math(1000, 1300, 7, 9999);
  assert.equal(over.progressPctClamped, 100); // clamped, never > 100
});

test("degenerate inputs are flagged invalid (target not above starting)", () => {
  const m = math(1000, 900, 7);
  assert.equal(m.invalid, true);
  assert.ok(m.invalidReasons.includes("TARGET_NOT_ABOVE_STARTING"));
});

// ── Feasibility tiers ─────────────────────────────────────────────────────────
test("low-pace target => Easy / steady", () => {
  const v = evaluateFeasibility({ math: math(1000, 1010, 100), riskProfile: "balanced" });
  assert.equal(v.tier, "Easy");
  assert.equal(v.missionType, "steady_growth");
  assert.ok(v.feasibilityScore > 90);
});

test("$1,000 → $1,300 in 7 days => Aggressive, elevated risk", () => {
  const v = evaluateFeasibility({ math: math(1000, 1300, 7), riskProfile: "balanced" });
  assert.equal(v.tier, "Aggressive");
  assert.ok(v.riskScore > v.feasibilityScore);
});

test("extreme pace (≈7%/day) => Extreme tier with high risk score", () => {
  const v = evaluateFeasibility({ math: math(1000, 2000, 10), riskProfile: "balanced" });
  assert.equal(v.tier, "Extreme");
  assert.ok(v.riskScore >= 80, `riskScore ${v.riskScore} should be high`);
  assert.ok(v.warnings.some((w) => /high-risk|possible loss/i.test(w)));
});

test("impossible pace => Unreasonable / unrealistic", () => {
  const v = evaluateFeasibility({ math: math(1000, 2000, 1), riskProfile: "balanced" });
  assert.equal(v.tier, "Unreasonable");
  assert.equal(v.missionType, "unrealistic");
});

test("fail-closed: invalid math => Unreasonable, cannot start, riskScore 100", () => {
  const v = evaluateFeasibility({ math: math(1000, 900, 7), riskProfile: "balanced" });
  assert.equal(v.tier, "Unreasonable");
  assert.equal(v.feasibilityScore, 0);
  assert.equal(v.riskScore, 100);
  assert.equal(v.canStart, false);
  assert.equal(v.startBlockReason, "INVALID_INPUTS");
});

test("feed gate blocks START only; drafting still allowed", () => {
  const m = math(1000, 1300, 7);
  const notReady = evaluateFeasibility({ math: m, riskProfile: "balanced", feed: { ready: false, reason: "STALE_FEED" } });
  assert.equal(notReady.canStart, false);
  assert.equal(notReady.startBlockReason, "STALE_FEED");
  const ready = evaluateFeasibility({ math: m, riskProfile: "balanced", feed: { ready: true } });
  assert.equal(ready.canStart, true);
  assert.equal(ready.startBlockReason, null);
});

test("required-pace fields are surfaced on the verdict (both branches)", () => {
  const m = math(1000, 1300, 7);
  const v = evaluateFeasibility({ math: m, riskProfile: "balanced" });
  assert.equal(v.requiredReturnPct, m.requiredReturnPct);
  assert.equal(v.requiredDailyReturnPct, m.requiredDailyReturnPct);
  // invalid branch still carries the (clamped) fields, never undefined
  const bad = evaluateFeasibility({ math: math(1000, 900, 7), riskProfile: "balanced" });
  assert.equal(typeof bad.requiredReturnPct, "number");
  assert.equal(typeof bad.requiredDailyReturnPct, "number");
});

test("$50 -> $100 in 1 day stays Unreasonable with feasibility 0 / risk 100", () => {
  const m = math(50, 100, 1);
  const v = evaluateFeasibility({ math: m, riskProfile: "aggressive" });
  assert.equal(v.tier, "Unreasonable");
  assert.equal(v.feasibilityScore, 0);
  assert.equal(v.riskScore, 100);
  assert.equal(v.requiredReturnPct, 100);
  assert.equal(v.requiredDailyReturnPct, 100);
});

test("risk mismatch: aggressive-needed target vs balanced selection — exact copy", () => {
  // $1,000 -> $1,300 in 7 days (~3.82%/day) recommends an aggressive profile.
  const m = math(1000, 1300, 7);
  const v = evaluateFeasibility({ math: m, riskProfile: "balanced" });
  assert.equal(v.recommendedRiskProfile, "aggressive");
  assert.equal(v.riskProfileMismatch.mismatch, true);
  assert.equal(v.riskProfileMismatch.selected, "balanced");
  assert.equal(v.riskProfileMismatch.required, "aggressive");
  assert.equal(
    v.riskProfileMismatch.explanation,
    "Your selected risk profile is Balanced, but this target requires Aggressive risk assumptions.",
  );
});

test("risk mismatch: extreme-needed target appends the exceeds-limits clause", () => {
  // $1,000 -> $2,000 in 1 day is Unreasonable and recommends extreme.
  const m = math(1000, 2000, 1);
  const v = evaluateFeasibility({ math: m, riskProfile: "conservative" });
  assert.equal(v.recommendedRiskProfile, "extreme");
  assert.equal(v.riskProfileMismatch.mismatch, true);
  assert.equal(
    v.riskProfileMismatch.explanation,
    "Your selected risk profile is Conservative, but this target requires Extreme risk assumptions. " +
      "This mission exceeds normal aggressive planning limits.",
  );
});

test("risk mismatch: no mismatch when selection meets or exceeds requirement", () => {
  const m = math(1000, 2000, 10); // requires aggressive
  const v = evaluateFeasibility({ math: m, riskProfile: "extreme" });
  assert.equal(v.riskProfileMismatch.mismatch, false);
  assert.equal(v.riskProfileMismatch.explanation, null);
});

test("small-account warning carries the drawdown / min-lot caveat", () => {
  const m = math(50, 60, 30);
  const v = evaluateFeasibility({ math: m, riskProfile: "balanced" });
  assert.ok(
    v.warnings.some((w) =>
      /Small balances have less room for drawdown and may be more affected by minimum lot sizing\./.test(w),
    ),
  );
});

// ── Probability + sample-size honesty ─────────────────────────────────────────
test("Phase-1 (no sample) => low confidence + explicit sample-size warning", () => {
  const m = math(1000, 1300, 7);
  const f = evaluateFeasibility({ math: m, riskProfile: "balanced" });
  const p = evaluateProbability({ math: m, feasibility: f, riskProfile: "balanced", sampleSize: 0 });
  assert.equal(p.confidence, "low");
  assert.equal(p.sampleSize, 0);
  assert.ok(p.sampleSizeWarnings.length >= 1);
  assert.equal(p.isEstimate, true);
  // target-hit is a damped, honest estimate (never exceeds feasibility)
  assert.ok(p.targetHitProbability <= f.feasibilityScore);
  // failure + target-hit are complementary, bounded 0–100
  assert.equal(p.targetHitProbability + p.failureProbability, 100);
});

test("unreasonable mission => target-hit estimate capped very low", () => {
  const m = math(1000, 2000, 1);
  const f = evaluateFeasibility({ math: m, riskProfile: "extreme" });
  const p = evaluateProbability({ math: m, feasibility: f, riskProfile: "extreme", sampleSize: 0 });
  assert.ok(p.targetHitProbability <= 5);
});

test("sampleSize 0 => planningProjectionOnly with the exact note; >0 clears it", () => {
  const m = math(1000, 1300, 7);
  const f = evaluateFeasibility({ math: m, riskProfile: "balanced" });
  const none = evaluateProbability({ math: m, feasibility: f, riskProfile: "balanced", sampleSize: 0 });
  assert.equal(none.planningProjectionOnly, true);
  assert.equal(
    none.planningProjectionNote,
    "No historical sample is available yet. These values are mathematical " +
      "planning projections based on your inputs, not backtested probabilities.",
  );
  const some = evaluateProbability({ math: m, feasibility: f, riskProfile: "balanced", sampleSize: 50 });
  assert.equal(some.planningProjectionOnly, false);
  assert.equal(some.planningProjectionNote, "");
});

// ── Banned-vocabulary guard ───────────────────────────────────────────────────
test("copy guard flags forbidden promise language", () => {
  assert.equal(checkMissionCopy("this is a guaranteed, risk-free profit").ok, false);
  assert.deepEqual(
    checkMissionCopy("a risk-free sure thing").violations.sort(),
    ["risk-free", "sure thing"].sort(),
  );
  assert.equal(checkMissionCopy("an honest probability estimate with possible loss").ok, true);
});

test("engine-generated copy never contains banned vocabulary", () => {
  // Sweep a representative spread of tiers/profiles and assert every piece of
  // generated copy passes the marketing/compliance guard.
  const cases: Array<[number, number, number]> = [
    [1000, 1010, 100],
    [1000, 1300, 7],
    [1000, 2000, 10],
    [1000, 2000, 1],
    [50, 900, 2],
  ];
  // Sweep across selected profiles too, so the mismatch explanation copy is
  // exercised (selected below required) and swept for banned vocabulary.
  const profiles = ["conservative", "balanced", "aggressive", "extreme"] as const;
  for (const [s, t, d] of cases) {
    for (const selected of profiles) {
      const m = math(s, t, d);
      const f = evaluateFeasibility({ math: m, riskProfile: selected });
      const p = evaluateProbability({ math: m, feasibility: f, riskProfile: selected, sampleSize: 0 });
      const copy = [
        f.explanation,
        ...f.warnings,
        f.riskProfileMismatch.explanation ?? "",
        p.disclaimer,
        p.planningProjectionNote,
        ...p.sampleSizeWarnings,
      ];
      const r = checkMissionCopyDeep(copy);
      assert.ok(
        r.ok,
        `banned vocab leaked for ${s}->${t}/${d}d (${selected}): ${r.violations.join(", ")}`,
      );
    }
  }
});

test("banned-phrase list is non-empty and lower-cased", () => {
  assert.ok(MISSION_BANNED_PHRASES.length > 0);
  for (const p of MISSION_BANNED_PHRASES) assert.equal(p, p.toLowerCase());
});

// ── Mission state machine (pure / fail-closed) ────────────────────────────────
test("status vocabulary has all 11 states and a 4-state terminal set", () => {
  assert.equal(MISSION_STATUSES.length, 11);
  assert.equal(MISSION_TERMINAL_STATES.length, 4);
  for (const s of MISSION_TERMINAL_STATES) {
    assert.ok(isMissionStatus(s));
    assert.ok(isTerminalStatus(s));
    // terminal states are frozen — no outbound transitions
    assert.equal(MISSION_TRANSITIONS[s].length, 0);
  }
});

test("legal user transitions: running⇄paused and cancel from non-terminal", () => {
  assert.ok(canTransition("running", "paused"));
  assert.ok(canTransition("paused", "running"));
  assert.ok(canTransition("running", "cancelled"));
  assert.ok(canTransition("draft", "cancelled"));
  assert.ok(canTransition("paused", "cancelled"));
});

test("illegal transitions are rejected with an honest reason", () => {
  assert.equal(evaluateTransition("draft", "running").ok, false); // must pass approval
  assert.equal(evaluateTransition("draft", "running").error, "ILLEGAL_TRANSITION");
  // unknown states are fail-closed
  assert.equal(evaluateTransition("nonsense" as never, "running").error, "UNKNOWN_FROM_STATE");
  assert.equal(evaluateTransition("running", "nonsense" as never).error, "UNKNOWN_TO_STATE");
  // no-op transition
  assert.equal(evaluateTransition("running", "running").error, "NO_OP_TRANSITION");
});

test("terminal states are frozen — no transition out is ever legal", () => {
  for (const term of MISSION_TERMINAL_STATES) {
    for (const to of MISSION_STATUSES) {
      const v = evaluateTransition(term, to);
      assert.equal(v.ok, false, `${term} -> ${to} must be rejected`);
    }
    // and the specific reason for a non-no-op target is TERMINAL_STATE
    const other = MISSION_STATUSES.find((s) => s !== term)!;
    assert.equal(evaluateTransition(term, other).error, "TERMINAL_STATE");
  }
});

test("resolveUserAction maps actions to status + event, fail-closed when illegal", () => {
  const pause = resolveUserAction("running", "pause");
  assert.ok(pause.ok && pause.resolved.to === "paused" && pause.resolved.eventType === "paused");
  const resume = resolveUserAction("paused", "resume");
  assert.ok(resume.ok && resume.resolved.to === "running" && resume.resolved.eventType === "resumed");
  const cancel = resolveUserAction("draft", "cancel");
  assert.ok(cancel.ok && cancel.resolved.to === "cancelled" && cancel.resolved.eventType === "cancelled");
  // illegal: cannot pause a draft, cannot resume a running mission
  assert.equal(resolveUserAction("draft", "pause").ok, false);
  assert.equal(resolveUserAction("running", "resume").ok, false);
  // cannot act on a terminal mission
  assert.equal(resolveUserAction("completed", "cancel").ok, false);
});

// ── Timeframe unit helpers ────────────────────────────────────────────────────

test("specToMinutes: converts each unit to the correct total minutes", () => {
  assert.equal(specToMinutes(5, "minutes"), 5);
  assert.equal(specToMinutes(2, "hours"), 120);
  assert.equal(specToMinutes(1, "days"), 1440);
  assert.equal(specToMinutes(1, "weeks"), 10080);
  assert.equal(specToMinutes(0, "hours"), 0);
  assert.equal(specToMinutes(-1, "days"), 0);
});

test("specToLabel: builds human-readable labels with correct pluralisation", () => {
  assert.equal(specToLabel(1, "minutes"), "1 minute");
  assert.equal(specToLabel(5, "minutes"), "5 minutes");
  assert.equal(specToLabel(1, "hours"), "1 hour");
  assert.equal(specToLabel(3, "hours"), "3 hours");
  assert.equal(specToLabel(1, "days"), "1 day");
  assert.equal(specToLabel(7, "days"), "7 days");
  assert.equal(specToLabel(1, "weeks"), "1 week");
  assert.equal(specToLabel(2, "weeks"), "2 weeks");
});

test("minutesToSpec: decomposes into the most natural (amount, unit) pair", () => {
  assert.deepEqual(minutesToSpec(30), { amount: 30, unit: "minutes" });
  assert.deepEqual(minutesToSpec(60), { amount: 1, unit: "hours" });
  assert.deepEqual(minutesToSpec(120), { amount: 2, unit: "hours" });
  assert.deepEqual(minutesToSpec(1440), { amount: 1, unit: "days" });
  assert.deepEqual(minutesToSpec(10080), { amount: 1, unit: "weeks" });
  assert.deepEqual(minutesToSpec(0), { amount: 1, unit: "minutes" });
});

test("resolveMissionTimeframeLabel: precedence label → amount+unit → span fallback", () => {
  // 1. Persisted label wins outright.
  assert.equal(
    resolveMissionTimeframeLabel({
      timeframeLabel: "30 minutes",
      timeframeAmount: 1,
      timeframeUnit: "days",
      timeframeStart: new Date(NOW).toISOString(),
      timeframeEnd: new Date(NOW + 7 * DAY).toISOString(),
    }),
    "30 minutes",
  );
  // Blank/whitespace label is ignored, falls through to amount+unit.
  assert.equal(
    resolveMissionTimeframeLabel({ timeframeLabel: "   ", timeframeAmount: 2, timeframeUnit: "hours" }),
    "2 hours",
  );
  // 2. No label → reconstruct from amount + unit.
  assert.equal(
    resolveMissionTimeframeLabel({ timeframeAmount: 1, timeframeUnit: "days" }),
    "1 day",
  );
  // 3. Legacy fallback (no label, no amount/unit) → natural label from the span.
  assert.equal(
    resolveMissionTimeframeLabel({
      timeframeStart: new Date(NOW).toISOString(),
      timeframeEnd: new Date(NOW + 7 * DAY).toISOString(),
    }),
    "7 days",
  );
  // Sub-day legacy span stays honest (e.g. 30-minute span → "30 minutes"),
  // never a fractional-day number.
  assert.equal(
    resolveMissionTimeframeLabel({
      timeframeStart: new Date(NOW).toISOString(),
      timeframeEnd: new Date(NOW + 30 * 60 * 1000).toISOString(),
    }),
    "30 minutes",
  );
  // Nothing usable → em dash, never a fabricated number.
  assert.equal(resolveMissionTimeframeLabel({}), "—");
  // Zero/invalid amount does not satisfy the amount+unit branch.
  assert.equal(resolveMissionTimeframeLabel({ timeframeAmount: 0, timeframeUnit: "hours" }), "—");
});

test("TIMEFRAME_QUICK_PICKS: all picks round-trip through specToMinutes", () => {
  for (const pick of TIMEFRAME_QUICK_PICKS) {
    const minutes = specToMinutes(pick.amount, pick.unit);
    assert.ok(minutes > 0, `${pick.label} should have positive minutes`);
  }
  // Sanity: chips cover at least 3 distinct units
  const units = new Set(TIMEFRAME_QUICK_PICKS.map((p) => p.unit));
  assert.ok(units.size >= 3, "quick picks should span at least 3 units");
});

// ── New math pace fields ──────────────────────────────────────────────────────

const MINUTE = 60 * 1000;

function mathMs(start: number, target: number, durationMs: number, current?: number) {
  const now = NOW;
  return computeMissionMath({
    startingAmount: start,
    targetAmount: target,
    timeframeStartMs: now,
    timeframeEndMs: now + durationMs,
    currentValue: current,
    nowMs: now,
  });
}

test("timeframeMinutes: 10-hour mission = 600 minutes", () => {
  const m = mathMs(50, 100, 10 * 60 * MINUTE);
  assert.equal(m.timeframeMinutes, 600);
});

test("requiredReturnPerHourPct: $50→$100 in 10 hours = 10%/hr", () => {
  const m = mathMs(50, 100, 10 * 60 * MINUTE);
  assert.equal(m.requiredReturnPct, 100);
  // 100% over 10 hours = 10%/hr
  assert.ok(Math.abs(m.requiredReturnPerHourPct - 10) < 1e-9);
});

test("requiredDailyEquivalentReturnPct: 10%/hr × 24 = 240%/day", () => {
  const m = mathMs(50, 100, 10 * 60 * MINUTE);
  assert.ok(Math.abs(m.requiredDailyEquivalentReturnPct - 240) < 1e-9);
});

test("requiredReturnPerHourPct: $50→$100 in 30 min = 200%/hr", () => {
  const m = mathMs(50, 100, 30 * MINUTE);
  assert.ok(Math.abs(m.requiredReturnPerHourPct - 200) < 1e-9);
  assert.ok(Math.abs(m.requiredDailyEquivalentReturnPct - 4800) < 1e-9);
});

test("pace fields: zero timeframe (invalid) yields 0 for per-hour / per-day", () => {
  // same start and end → timeframeMinutes = 0
  const m = computeMissionMath({
    startingAmount: 500,
    targetAmount: 750,
    timeframeStartMs: NOW,
    timeframeEndMs: NOW,
    nowMs: NOW,
  });
  assert.equal(m.timeframeMinutes, 0);
  assert.equal(m.requiredReturnPerHourPct, 0);
  assert.equal(m.requiredDailyEquivalentReturnPct, 0);
});

// ── Unit-aware mission classification ─────────────────────────────────────────

function classify(start: number, target: number, durationMs: number) {
  const m = mathMs(start, target, durationMs);
  return evaluateFeasibility({ math: m, riskProfile: "balanced" });
}

test("unitAwareMissionClass: <60 min → always a Scalp-zone class", () => {
  // Any gain in <60 min produces a high daily-equivalent rate → Extreme or Unrealistic scalp.
  // We assert the classification is one of the three Scalp-zone labels (never Intraday/Swing/etc).
  const v = classify(1000, 1010, 30 * MINUTE);
  const scalp30min = v.unitAwareMissionClass;
  assert.ok(
    ["Scalp", "Extreme scalp", "Unrealistic scalp"].includes(scalp30min),
    `expected a Scalp-zone class for <60 min, got ${scalp30min}`,
  );
  // Also confirm the zone boundary: 59-min mission is still Scalp-zone
  const v59 = classify(1000, 1001, 59 * MINUTE);
  assert.ok(
    ["Scalp", "Extreme scalp", "Unrealistic scalp"].includes(v59.unitAwareMissionClass),
    `expected a Scalp-zone class for 59 min, got ${v59.unitAwareMissionClass}`,
  );
});

test("unitAwareMissionClass: <60 min + large gain → 'Extreme scalp' or 'Unrealistic scalp'", () => {
  // $50→$100 in 30 min = 100% in 30 min yields an extremely high daily rate.
  const v = classify(50, 100, 30 * MINUTE);
  assert.ok(
    ["Extreme scalp", "Unrealistic scalp"].includes(v.unitAwareMissionClass),
    `expected Extreme/Unrealistic scalp for 100% in 30min, got ${v.unitAwareMissionClass}`,
  );
});

test("unitAwareMissionClass: 1–23 hr → Intraday zone", () => {
  // Any gain in <24 hr produces a high daily equivalent → High-risk intraday / Unrealistic intraday.
  // Confirm the zone is always Intraday-zone (not Swing/Multi-day).
  const v = classify(1000, 1010, 4 * 60 * MINUTE); // 4 hours
  assert.ok(
    ["Intraday", "High-risk intraday", "Unrealistic intraday"].includes(v.unitAwareMissionClass),
    `expected an Intraday-zone class for 4hr, got ${v.unitAwareMissionClass}`,
  );
});

test("unitAwareMissionClass: 1–6 days → Swing", () => {
  const v = evaluateFeasibility({ math: math(1000, 1010, 3), riskProfile: "balanced" });
  assert.equal(v.unitAwareMissionClass, "Swing");
});

test("unitAwareMissionClass: ≥7 days → Multi-day", () => {
  const v = evaluateFeasibility({ math: math(1000, 1010, 14), riskProfile: "balanced" });
  assert.equal(v.unitAwareMissionClass, "Multi-day");
});

test("unitAwareMissionClass present in invalid (fail-closed) branch", () => {
  const v = evaluateFeasibility({ math: math(1000, 900, 7), riskProfile: "balanced" });
  assert.ok(typeof v.unitAwareMissionClass === "string");
  assert.ok(v.unitAwareMissionClass.length > 0);
});

// ── Short-timeframe warnings ───────────────────────────────────────────────────

test("minute-based missions get the short-timeframe spread/slippage warning", () => {
  const v = classify(1000, 1001, 30 * MINUTE);
  assert.ok(
    v.warnings.some((w) => /spread.*slippage|slippage.*spread/i.test(w)),
    `expected spread/slippage warning, warnings: ${JSON.stringify(v.warnings)}`,
  );
});

test("missions ≤30 min also get the execution speed warning", () => {
  const v = classify(1000, 1001, 20 * MINUTE);
  assert.ok(
    v.warnings.some((w) => /confirmed live feed.*fast execution|fast execution.*confirmed live feed/i.test(w)),
    `expected execution speed warning, warnings: ${JSON.stringify(v.warnings)}`,
  );
});

// ── NL mission intent parser ──────────────────────────────────────────────────

test("parseMissionIntent: 'turn $500 into $750 in 2 hours'", () => {
  const r = parseMissionIntent("turn $500 into $750 in 2 hours");
  assert.ok(r.ok, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, 500);
  assert.equal(r.intent.targetAmount, 750);
  assert.equal(r.intent.timeframeUnit, "hours");
  assert.equal(r.intent.timeframeAmount, 2);
  assert.equal(r.intent.timeframeMinutes, 120);
});

test("parseMissionIntent: '$1000 to $1500 in 30 minutes'", () => {
  const r = parseMissionIntent("$1000 to $1500 in 30 minutes");
  assert.ok(r.ok, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, 1000);
  assert.equal(r.intent.targetAmount, 1500);
  assert.equal(r.intent.timeframeUnit, "minutes");
  assert.equal(r.intent.timeframeMinutes, 30);
});

test("parseMissionIntent: 'double $200 in 1 week'", () => {
  const r = parseMissionIntent("double $200 in 1 week");
  assert.ok(r.ok, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, 200);
  assert.equal(r.intent.targetAmount, 400);
  assert.equal(r.intent.timeframeUnit, "weeks");
  assert.equal(r.intent.timeframeMinutes, 10080);
});

test("parseMissionIntent: 'make $100 profit from $500 in 3 days'", () => {
  const r = parseMissionIntent("make $100 profit from $500 in 3 days");
  assert.ok(r.ok, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, 500);
  assert.equal(r.intent.targetAmount, 600);
  assert.equal(r.intent.timeframeUnit, "days");
  assert.equal(r.intent.timeframeMinutes, 3 * 1440);
});

test("parseMissionIntent: 'grow $500 to $700 in 45min'", () => {
  const r = parseMissionIntent("grow $500 to $700 in 45min");
  assert.ok(r.ok, r.ok ? "" : r.reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, 500);
  assert.equal(r.intent.targetAmount, 700);
  assert.equal(r.intent.timeframeUnit, "minutes");
  assert.equal(r.intent.timeframeMinutes, 45);
});

test("parseMissionIntent: returns ok:false for gibberish", () => {
  const r = parseMissionIntent("hello world no amounts here");
  assert.equal(r.ok, false);
});

test("parseMissionIntent: returns ok:false when target ≤ start", () => {
  const r = parseMissionIntent("turn $750 into $500 in 2 hours");
  assert.equal(r.ok, false);
});

test("parseMissionIntent: empty input returns ok:false", () => {
  assert.equal(parseMissionIntent("").ok, false);
});

test("parseMissionIntent: timeframeLabel is set for valid parses", () => {
  const r = parseMissionIntent("$500 to $600 in 2 hours");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.intent.timeframeLabel, "2 hours");
});

test("parseMissionIntent: 'Make $200 in 5 hours' parses via single-amount fallback", () => {
  const r = parseMissionIntent("Make $200 in 5 hours");
  assert.ok(r.ok, r.ok ? "" : (r as { reason: string }).reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, null);
  assert.equal(r.intent.targetAmount, 200);
  assert.equal(r.intent.timeframeUnit, "hours");
  assert.equal(r.intent.timeframeMinutes, 5 * 60);
  assert.equal(r.intent.riskProfile, null);
});

test("parseMissionIntent: 'make $500 in 30 minutes' parses correctly", () => {
  const r = parseMissionIntent("make $500 in 30 minutes");
  assert.ok(r.ok, r.ok ? "" : (r as { reason: string }).reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, null);
  assert.equal(r.intent.targetAmount, 500);
  assert.equal(r.intent.timeframeUnit, "minutes");
  assert.equal(r.intent.timeframeMinutes, 30);
});

test("parseMissionIntent: riskProfile is null when no keyword present", () => {
  const r = parseMissionIntent("turn $500 into $750 in 2 hours");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.intent.riskProfile, null);
});

test("parseMissionIntent: extracts riskProfile 'aggressive' from text", () => {
  const r = parseMissionIntent("turn $500 into $750 in 2 hours, aggressive risk");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.intent.riskProfile, "aggressive");
  assert.equal(r.intent.startingAmount, 500);
  assert.equal(r.intent.targetAmount, 750);
});

test("parseMissionIntent: extracts riskProfile 'conservative' from text", () => {
  const r = parseMissionIntent("grow $1000 to $1200 in 3 days — conservative approach");
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.intent.riskProfile, "conservative");
});

test("parseMissionIntent: target-only 'scalp this account to $100 in 20 minutes'", () => {
  const r = parseMissionIntent("scalp this account to $100 in 20 minutes");
  assert.ok(r.ok, r.ok ? "" : (r as { reason: string }).reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, null);
  assert.equal(r.intent.targetAmount, 100);
  assert.equal(r.intent.timeframeUnit, "minutes");
  assert.equal(r.intent.timeframeMinutes, 20);
});

test("parseMissionIntent: target-only 'take account to $500 in 1 hour'", () => {
  const r = parseMissionIntent("take account to $500 in 1 hour");
  assert.ok(r.ok, r.ok ? "" : (r as { reason: string }).reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, null);
  assert.equal(r.intent.targetAmount, 500);
  assert.equal(r.intent.timeframeUnit, "hours");
});

test("parseMissionIntent: relative time 'by tomorrow' resolves to 24 hours", () => {
  const r = parseMissionIntent("grow this to $500 by tomorrow");
  assert.ok(r.ok, r.ok ? "" : (r as { reason: string }).reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, null);
  assert.equal(r.intent.targetAmount, 500);
  assert.equal(r.intent.timeframeUnit, "hours");
  assert.equal(r.intent.timeframeMinutes, 24 * 60);
});

test("parseMissionIntent: relative time 'by EOD' resolves to 8 hours", () => {
  const r = parseMissionIntent("take it to $1200 by EOD");
  assert.ok(r.ok, r.ok ? "" : (r as { reason: string }).reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, null);
  assert.equal(r.intent.targetAmount, 1200);
  assert.equal(r.intent.timeframeUnit, "hours");
  assert.equal(r.intent.timeframeMinutes, 8 * 60);
});

test("parseMissionIntent: relative time 'by end of week' resolves to 5 days", () => {
  const r = parseMissionIntent("grow $1000 to $1300 by end of week");
  assert.ok(r.ok, r.ok ? "" : (r as { reason: string }).reason);
  if (!r.ok) return;
  assert.equal(r.intent.startingAmount, 1000);
  assert.equal(r.intent.targetAmount, 1300);
  assert.equal(r.intent.timeframeUnit, "days");
  assert.equal(r.intent.timeframeMinutes, 5 * 1440);
});
