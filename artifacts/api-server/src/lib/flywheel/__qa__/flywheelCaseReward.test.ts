// Flywheel B0 (case files) + B1 (RewardBuilder) — OFFLINE.
//
// Locks:
//   * B0 phases are evidence high-water marks (DRAFTED → DISPATCHED → CLOSED
//     → RECONCILED); absent evidence lands in `missing`, never synthesized;
//     every present section carries a provenance stamp naming its seam.
//   * B1 rewards come ONLY from postings: unknown fee/P&L legs ⇒ UNRECONCILED
//     (excluded, not guessed); no postings / no equity base / mixed currency /
//     non-positive growth all refuse with machine reasons; the happy path's
//     net log-return is exact; a reverse-and-repost correction nets to the
//     corrected figure.
//   * Source pin: rewardBuilder never touches quotes/candles/mark prices —
//     no theoretical-price reward can exist in that file.
//
// Run: pnpm --filter @workspace/api-server run test:flywheel-case-reward

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assembleCaseFile,
  deriveRegimeLabel,
  type CaseDraftEvidence,
  type CasePostingEvidence,
} from "../caseFile.js";
import { buildReward, type RewardPostingLeg } from "../rewardBuilder.js";

function draft(overrides: Partial<CaseDraftEvidence> = {}): CaseDraftEvidence {
  return {
    draftId: "d1",
    missionId: 7,
    userId: 3,
    agentKey: "trend_rider",
    symbol: "EURUSD",
    direction: "BUY",
    entryPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    lot: 0.1,
    riskAmount: 100,
    expectedR: 2,
    status: "proposed",
    reason: null,
    edgeJson: null,
    resultJson: null,
    commandId: null,
    brokerTicket: null,
    pnl: null,
    rMultiple: null,
    exitReason: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    approvedAt: null,
    closedAt: null,
    ...overrides,
  };
}

function posting(overrides: Partial<CasePostingEvidence> = {}): CasePostingEvidence {
  return {
    journalId: "ej_c1_pnl",
    kind: "TRADE_CLOSE_PNL",
    source: "BROKER_EVENT",
    ledger: "DEMO",
    valueUnknown: false,
    effectiveAt: new Date("2026-08-02T00:00:00Z"),
    ...overrides,
  };
}

// ── B0 — phases + honesty ───────────────────────────────────────────────────

test("B0: undispatched draft assembles as DRAFTED with honest missing list", () => {
  const cf = assembleCaseFile(draft(), []);
  assert.equal(cf.phase, "DRAFTED");
  assert.equal(cf.completeness, "PARTIAL");
  assert.ok(cf.missing.some((m) => m.startsWith("DURING_ABSENT")));
  assert.ok(cf.missing.some((m) => m.startsWith("AFTER_ABSENT")));
  assert.equal(cf.ledger, null); // no postings ⇒ honestly unknown partition
  assert.equal(cf.caseId, "cf_d1");
  assert.equal(cf.provenance["before"]?.source, "mission_trade_drafts");
});

test("B0: commandId/ticket without close assembles as DISPATCHED", () => {
  const cf = assembleCaseFile(draft({ commandId: "c1", brokerTicket: "t9", approvedAt: new Date() }), []);
  assert.equal(cf.phase, "DISPATCHED");
  assert.ok(cf.provenance["during"]);
});

test("B0: closed without postings is CLOSED (not RECONCILED) and says why", () => {
  const cf = assembleCaseFile(
    draft({ commandId: "c1", closedAt: new Date("2026-08-02T01:00:00Z"), pnl: 12 }),
    [],
  );
  assert.equal(cf.phase, "CLOSED");
  assert.ok(cf.missing.some((m) => m.startsWith("POSTINGS_ABSENT")));
});

test("B0: closed with postings is RECONCILED, carries journal ids + ledger", () => {
  const cf = assembleCaseFile(
    draft({ commandId: "c1", closedAt: new Date("2026-08-02T01:00:00Z"), pnl: 12 }),
    [posting(), posting({ journalId: "ej_c1_fee", kind: "TRADE_CLOSE_FEE" })],
  );
  assert.equal(cf.phase, "RECONCILED");
  assert.equal(cf.ledger, "DEMO");
  assert.deepEqual((cf.after as { postingJournalIds: string[] }).postingJournalIds, ["ej_c1_pnl", "ej_c1_fee"]);
});

test("B0: regime label is read, never inferred", () => {
  assert.equal(deriveRegimeLabel({ regime: "TREND" }), "TREND");
  assert.equal(deriveRegimeLabel({ other: 1 }, null, 5), "UNKNOWN");
  assert.equal(deriveRegimeLabel(), "UNKNOWN");
});

// ── B1 — reward honesty ─────────────────────────────────────────────────────

function leg(overrides: Partial<RewardPostingLeg> = {}): RewardPostingLeg {
  return {
    journalId: "ej_c1_pnl",
    kind: "TRADE_CLOSE_PNL",
    account: "REALIZED_PNL",
    amountMinor: -1000n, // pnl +1000 posted as −pnl on the income account
    currency: "USD",
    scale: 2,
    valueUnknown: false,
    ledger: "DEMO",
    ...overrides,
  };
}

const baseInput = {
  caseId: "cf_d1",
  userId: 3,
  strategyId: "trend_rider",
  regimeLabel: "TREND",
  instrument: "EURUSD",
};

test("B1: happy path — exact net log-return from postings only", () => {
  const postings: RewardPostingLeg[] = [
    leg(), // pnl +1000 minor
    leg({ journalId: "ej_c1_pnl", account: "BROKER_CASH", amountMinor: 1000n }),
    leg({ journalId: "ej_c1_fee", kind: "TRADE_CLOSE_FEE", account: "FEES_EXPENSE", amountMinor: 100n }),
    leg({ journalId: "ej_c1_fee", account: "BROKER_CASH", amountMinor: -100n }),
  ];
  const r = buildReward({ ...baseInput, postings, equityBaseMinor: 100_000n });
  assert.equal(r.status, "RECONCILED");
  // net = 1000 − 100 = 900 minor over 100000 ⇒ ln(1.009)
  assert.equal(r.netPnlMinor, 900n);
  assert.ok(Math.abs((r.netLogReturn ?? 0) - Math.log(1.009)) < 1e-12);
  assert.deepEqual(r.journalIds, ["ej_c1_pnl", "ej_c1_fee"]);
});

test("B1: unknown fee ⇒ UNRECONCILED with UNKNOWN_FEES — excluded, not guessed", () => {
  const postings: RewardPostingLeg[] = [
    leg(),
    leg({ account: "BROKER_CASH", amountMinor: 1000n }),
    leg({ journalId: "ej_c1_fee", kind: "TRADE_CLOSE_FEE", account: "FEES_EXPENSE", amountMinor: 0n, valueUnknown: true }),
    leg({ journalId: "ej_c1_fee", kind: "TRADE_CLOSE_FEE", account: "UNKNOWN_SUSPENSE", amountMinor: 0n, valueUnknown: true }),
  ];
  const r = buildReward({ ...baseInput, postings, equityBaseMinor: 100_000n });
  assert.equal(r.status, "UNRECONCILED");
  assert.equal(r.netLogReturn, null);
  assert.equal(r.netPnlMinor, null);
  assert.ok(r.reasons.some((x) => x.startsWith("UNKNOWN_FEES")));
});

test("B1: unknown P&L ⇒ UNRECONCILED with UNKNOWN_PNL", () => {
  const postings: RewardPostingLeg[] = [
    leg({ account: "BROKER_CASH", amountMinor: 0n, valueUnknown: true }),
    leg({ account: "UNKNOWN_SUSPENSE", amountMinor: 0n, valueUnknown: true }),
  ];
  const r = buildReward({ ...baseInput, postings, equityBaseMinor: 100_000n });
  assert.equal(r.status, "UNRECONCILED");
  assert.ok(r.reasons.some((x) => x.startsWith("UNKNOWN_PNL")));
});

test("B1: no postings / no equity base / mixed currency all refuse honestly", () => {
  const none = buildReward({ ...baseInput, postings: [], equityBaseMinor: 100_000n });
  assert.equal(none.status, "UNRECONCILED");
  assert.ok(none.reasons[0]!.startsWith("NO_POSTINGS"));

  const noEq = buildReward({ ...baseInput, postings: [leg(), leg({ account: "BROKER_CASH", amountMinor: 1000n })], equityBaseMinor: null });
  assert.equal(noEq.status, "UNRECONCILED");
  assert.ok(noEq.reasons[0]!.startsWith("NO_EQUITY_BASE"));

  const mixed = buildReward({
    ...baseInput,
    postings: [leg(), leg({ journalId: "ej_c1_fee", kind: "TRADE_CLOSE_FEE", account: "FEES_EXPENSE", amountMinor: 5n, currency: "EUR" })],
    equityBaseMinor: 100_000n,
  });
  assert.equal(mixed.status, "UNRECONCILED");
  assert.ok(mixed.reasons[0]!.startsWith("MIXED_CURRENCY"));
});

test("B1: reverse-and-repost correction nets to the corrected figure", () => {
  const postings: RewardPostingLeg[] = [
    // original (wrong): pnl +1000
    leg(),
    leg({ account: "BROKER_CASH", amountMinor: 1000n }),
    // reversal: negated legs
    leg({ journalId: "ej_c1_corr_reversal", kind: "CORRECTION_REVERSAL", amountMinor: 1000n }),
    leg({ journalId: "ej_c1_corr_reversal", kind: "CORRECTION_REVERSAL", account: "BROKER_CASH", amountMinor: -1000n }),
    // repost (right): pnl +800
    leg({ journalId: "ej_c1_corr_repost", kind: "CORRECTION_REPOST", amountMinor: -800n }),
    leg({ journalId: "ej_c1_corr_repost", kind: "CORRECTION_REPOST", account: "BROKER_CASH", amountMinor: 800n }),
  ];
  const r = buildReward({ ...baseInput, postings, equityBaseMinor: 100_000n });
  assert.equal(r.status, "RECONCILED");
  assert.equal(r.netPnlMinor, 800n);
});

test("B1: growth factor ≤ 0 refuses (ln undefined — surfaced, not clamped)", () => {
  const postings: RewardPostingLeg[] = [
    leg({ amountMinor: 200_000n }), // pnl −200000 ⇒ growth 1 − 2 < 0
    leg({ account: "BROKER_CASH", amountMinor: -200_000n }),
  ];
  const r = buildReward({ ...baseInput, postings, equityBaseMinor: 100_000n });
  assert.equal(r.status, "UNRECONCILED");
  assert.ok(r.reasons[0]!.startsWith("GROWTH_FACTOR_NONPOSITIVE"));
});

// ── Source pins ─────────────────────────────────────────────────────────────

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

test("pin: rewardBuilder derives from postings only — no quote/candle/mark-price surface", () => {
  const src = readSrc("../rewardBuilder.ts");
  for (const banned of ["getQuote", "candle", "Candle", "markPrice", "midPrice", "marketData"]) {
    assert.ok(!src.includes(banned), `rewardBuilder.ts must not reference ${banned}`);
  }
});

test("pin: rewards journal the UNRECONCILED status literally (excluded downstream)", () => {
  const src = readSrc("../rewardBuilder.ts");
  assert.match(src, /"UNRECONCILED"/);
  // and the worker only feeds RECONCILED rewards to the posterior stage
  const worker = readSrc("../flywheelWorker.ts");
  assert.match(worker, /eq\(flywheelRewardsTable\.status, "RECONCILED"\)/);
});
