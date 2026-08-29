// #15 Champion-Challenger — pure pairing tests + no-execution pin (OFFLINE).
//
// Locks:
//   * FAKE-CLOCK window: a challenger pairs only when its decision falls
//     within PAIRING_WINDOW_MS of the champion's decision — inside/at/outside
//     the boundary are all asserted against an explicit fake clock.
//   * Resolution honesty: an unresolved (still-tracking) challenger is
//     SKIPPED, never guessed; WAIT/rejected challengers are resolved by
//     definition and judged as REJECT.
//   * Judgment mapping runs through the EXISTING shadow-lab engines:
//     champion lost + challenger blocked → CANDIDATE_AVOIDED_LOSER;
//     champion won + challenger blocked → CANDIDATE_MISSED_WINNER; both
//     traded same direction → concurred; edgeR = candidate − baseline.
//   * NO EXECUTION (pin): the worker source never touches executeInstant,
//     dispatch, the live pipeline, an adapter deliver, or promote.
//   * Env opt-out parsing.
//
// Run: pnpm --filter @workspace/api-server run test:champion-challenger

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const {
  pairChampionWithChallengers,
  challengerResolved,
  championChallengerEnabled,
  PAIRING_WINDOW_MS,
} = await import("../championChallengerWorker.js");
type ChampionDraftObservation = import("../championChallengerWorker.js").ChampionDraftObservation;
type ChallengerShadowObservation = import("../championChallengerWorker.js").ChallengerShadowObservation;

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // fake clock origin

function champion(over: Partial<ChampionDraftObservation> = {}): ChampionDraftObservation {
  return {
    draftId: "d1",
    agentKey: "TREND",
    symbol: "R_75",
    direction: "BUY",
    rMultiple: -1,       // champion lost 1R by default
    edgeScore: 70,
    createdAtMs: T0,
    ...over,
  };
}

function challenger(over: Partial<ChallengerShadowObservation> = {}): ChallengerShadowObservation {
  return {
    shadowId: "s1",
    strategy: "MEAN_REVERT",
    symbol: "R_75",
    action: "WAIT",
    status: "SHADOW_WAIT",
    pnlR: null,
    predictedAtMs: T0 + 60_000,
    ...over,
  };
}

// ── Fake-clock pairing window ────────────────────────────────────────────────

test("fake clock: pairs inside/at the window, refuses one ms outside", () => {
  const inside = challenger({ shadowId: "in", predictedAtMs: T0 + PAIRING_WINDOW_MS - 1 });
  const atEdge = challenger({ shadowId: "edge", predictedAtMs: T0 + PAIRING_WINDOW_MS });
  const outside = challenger({ shadowId: "out", predictedAtMs: T0 + PAIRING_WINDOW_MS + 1 });
  const before = challenger({ shadowId: "before", predictedAtMs: T0 - PAIRING_WINDOW_MS - 1 });
  const pairs = pairChampionWithChallengers(champion(), [inside, atEdge, outside, before]);
  assert.deepEqual(pairs.map((p) => p.challengerShadowId).sort(), ["edge", "in"]);
});

test("symbol mismatch and empty strategy never pair", () => {
  const wrongSymbol = challenger({ shadowId: "x", symbol: "R_100" });
  const noStrategy = challenger({ shadowId: "y", strategy: "  " });
  assert.deepEqual(pairChampionWithChallengers(champion(), [wrongSymbol, noStrategy]), []);
});

test("a non-directional champion pairs nothing (no invented baseline)", () => {
  assert.deepEqual(pairChampionWithChallengers(champion({ direction: "NONE" }), [challenger()]), []);
});

// ── Resolution honesty ───────────────────────────────────────────────────────

test("unresolved challengers are skipped, never guessed", () => {
  const tracking = challenger({ shadowId: "t", action: "BUY", status: "SHADOW_TRACKING_OUTCOME", pnlR: null });
  assert.equal(challengerResolved(tracking), false);
  assert.deepEqual(pairChampionWithChallengers(champion(), [tracking]), []);
});

test("challengerResolved matrix", () => {
  assert.equal(challengerResolved(challenger({ action: "WAIT", status: "SHADOW_WAIT" })), true);
  assert.equal(challengerResolved(challenger({ action: "BUY", status: "SHADOW_REJECTED" })), true);
  assert.equal(challengerResolved(challenger({ action: "BUY", status: "SHADOW_WIN", pnlR: 1.5 })), true);
  assert.equal(challengerResolved(challenger({ action: "BUY", status: "SHADOW_WIN", pnlR: null })), false);
  assert.equal(challengerResolved(challenger({ action: "SELL", status: "SHADOW_TRACKING_OUTCOME", pnlR: 1 })), false);
});

// ── Judgments run through the existing shadow-lab engines ────────────────────

test("champion lost, challenger stayed out → CANDIDATE_AVOIDED_LOSER", () => {
  const pairs = pairChampionWithChallengers(champion({ rMultiple: -1 }), [challenger({ action: "WAIT" })]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]!.outcome.comparisonClass, "BASELINE_TRADED_CANDIDATE_BLOCKED");
  assert.equal(pairs[0]!.outcome.judgment, "CANDIDATE_AVOIDED_LOSER");
  assert.equal(pairs[0]!.outcome.candidateEdgeR, 1); // 0 − (−1)
});

test("champion won, challenger stayed out → CANDIDATE_MISSED_WINNER", () => {
  const pairs = pairChampionWithChallengers(champion({ rMultiple: 2 }), [challenger({ action: "WAIT" })]);
  assert.equal(pairs[0]!.outcome.judgment, "CANDIDATE_MISSED_WINNER");
  assert.equal(pairs[0]!.outcome.candidateEdgeR, -2);
});

test("both traded the same direction and won → CONCURRED_RIGHT with real edgeR", () => {
  const c = challenger({ action: "BUY", status: "SHADOW_WIN", pnlR: 1.2 });
  const pairs = pairChampionWithChallengers(champion({ rMultiple: 0.8 }), [c]);
  assert.equal(pairs[0]!.outcome.comparisonClass, "CONCURRED_TRADED");
  assert.equal(pairs[0]!.outcome.judgment, "CONCURRED_RIGHT");
  assert.ok(Math.abs(pairs[0]!.outcome.candidateEdgeR - 0.4) < 1e-9);
});

test("opposite directions are classified as such, edge decides the winner", () => {
  const c = challenger({ action: "SELL", status: "SHADOW_LOSS", pnlR: -1 });
  const pairs = pairChampionWithChallengers(champion({ rMultiple: 1 }), [c]);
  assert.equal(pairs[0]!.outcome.comparisonClass, "OPPOSITE_DIRECTIONS");
  assert.equal(pairs[0]!.outcome.judgment, "BASELINE_BETTER_DIRECTION");
});

test("pair ids are stable and the pair cap holds", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    challenger({ shadowId: `s${i}`, action: "WAIT" }));
  const pairs = pairChampionWithChallengers(champion(), many, { maxPairs: 5 });
  assert.equal(pairs.length, 5);
  assert.equal(pairs[0]!.pairId, "cc:d1:s0");
});

// ── No-execution pin ─────────────────────────────────────────────────────────

test("no-execution pin: the worker source touches no dispatch surface", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.resolve(here, "../championChallengerWorker.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [
    "executeInstant", "dispatchApprovedDraft", "liveCommandPipeline",
    "guidedDispatchEntry", ".deliver(", "promote(", "approveProposalDraft",
  ]) {
    assert.ok(!src.includes(forbidden), `championChallengerWorker must not reference ${forbidden}`);
  }
});

test("env opt-out: absent = enabled; disable values disable", () => {
  assert.equal(championChallengerEnabled(undefined), true);
  for (const v of ["0", "false", "off", "no"]) {
    assert.equal(championChallengerEnabled(v), false, v);
  }
});
