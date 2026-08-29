// Capability #22 — Beneficial-Owner Exposure Graph.
//
// Locked here:
//   * All owned accounts are consolidated into ONE economic exposure:
//     instrument nets sum ACROSS accounts and venues.
//   * Cross-source mirrors (trades row + live_positions row with the same
//     dedupe key) count exactly once.
//   * Cross-account findings: same-direction stacking through account
//     splitting and cross-account self-hedges are surfaced explicitly.
//   * HONESTY: an unreadable account becomes a typed UNAVAILABLE gap and
//     coverage.complete=false; equity of unreadable accounts is NOT estimated.
//   * The admission summary (#21 feed) carries the coverage verdict forward.
//
// IO-free, deterministic. Offline `ci` lane.
// Run: pnpm --filter @workspace/api-server run test:beneficial-owner-exposure

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBeneficialOwnerExposureGraph,
  summarizeExposureForAdmission,
  type AccountSnapshotInput,
  type OwnedPositionInput,
} from "@workspace/domain/portfolio-manager";

const okAccount = (key: string, equity: number, venue = "mt5"): AccountSnapshotInput => ({
  accountKey: key, venue, balance: equity, equity, accountType: "demo", status: "OK",
});

const pos = (p: Partial<OwnedPositionInput> & { sourceId: string }): OwnedPositionInput => ({
  source: "trades", accountKey: "mt5:1", venue: "mt5",
  symbol: "EURUSD", direction: "BUY", lots: 1,
  riskAmount: 50, unrealizedPnl: 0, dedupeKey: null,
  ...p,
});

test("all owned accounts consolidate into ONE economic exposure per instrument", () => {
  const g = buildBeneficialOwnerExposureGraph({
    accounts: [okAccount("mt5:1", 5000), okAccount("mt5:2", 3000)],
    positions: [
      pos({ sourceId: "1", accountKey: "mt5:1", symbol: "EURUSD", direction: "BUY", lots: 1 }),
      pos({ sourceId: "2", accountKey: "mt5:2", symbol: "EURUSD", direction: "BUY", lots: 2 }),
    ],
    sourcesRead: ["trades"],
  });
  assert.equal(g.ownerScope, "SINGLE_BENEFICIAL_OWNER");
  const inst = g.byInstrument.find((i) => i.instrument === "EURUSD")!;
  assert.equal(inst.netLots, 3);           // 1 + 2 across BOTH accounts
  assert.equal(inst.accounts.length, 2);
  assert.equal(g.combinedEquity, 8000);    // one owner, one equity pool
  // Currency legs decompose across accounts too: +3 EUR, −3 USD.
  assert.equal(g.byCurrencyLeg.EUR, 3);
  assert.equal(g.byCurrencyLeg.USD, -3);
});

test("cross-source mirrors dedupe to one economic position", () => {
  const g = buildBeneficialOwnerExposureGraph({
    accounts: [okAccount("mt5:1", 5000)],
    positions: [
      pos({ sourceId: "t1", source: "trades", dedupeKey: "trade:7", lots: 1 }),
      pos({ sourceId: "lp9", source: "live_positions", dedupeKey: "trade:7", lots: 1 }),
    ],
    sourcesRead: ["trades", "live_positions"],
  });
  assert.equal(g.totalPositions, 1);
  assert.equal(g.dedupedMirrors, 1);
  assert.equal(g.byInstrument[0]!.netLots, 1); // not doubled
});

test("same-direction stacking across accounts is surfaced as a finding", () => {
  const g = buildBeneficialOwnerExposureGraph({
    accounts: [okAccount("mt5:1", 5000), okAccount("mt5:2", 5000)],
    positions: [
      pos({ sourceId: "1", accountKey: "mt5:1", direction: "BUY" }),
      pos({ sourceId: "2", accountKey: "mt5:2", direction: "BUY" }),
    ],
    sourcesRead: ["trades"],
  });
  const stack = g.crossAccountFindings.find((f) => f.kind === "SAME_DIRECTION_ACROSS_ACCOUNTS");
  assert.ok(stack, "expected a same-direction-across-accounts finding");
  assert.equal(stack!.accounts.length, 2);
});

test("cross-account hedge is surfaced (economically flat, double cost)", () => {
  const g = buildBeneficialOwnerExposureGraph({
    accounts: [okAccount("mt5:1", 5000), okAccount("mt5:2", 5000)],
    positions: [
      pos({ sourceId: "1", accountKey: "mt5:1", direction: "BUY" }),
      pos({ sourceId: "2", accountKey: "mt5:2", direction: "SELL" }),
    ],
    sourcesRead: ["trades"],
  });
  assert.ok(g.crossAccountFindings.some((f) => f.kind === "CROSS_ACCOUNT_HEDGE"));
  assert.equal(g.byInstrument[0]!.netLots, 0);
  assert.equal(g.byInstrument[0]!.grossLots, 2);
});

test("HONESTY: unreadable account = typed gap, incomplete coverage, no equity synthesis", () => {
  const g = buildBeneficialOwnerExposureGraph({
    accounts: [
      okAccount("mt5:1", 5000),
      {
        accountKey: "mt5:2", venue: "mt5", balance: null, equity: null,
        status: "UNAVAILABLE", statusReason: "READ_FAILED: bridge offline",
      },
    ],
    positions: [pos({ sourceId: "1" })],
    sourcesRead: ["trades"],
  });
  assert.equal(g.coverage.complete, false);
  assert.equal(g.coverage.accountsUnavailable, 1);
  assert.ok(g.coverage.gaps.some((x) => x.includes("READ_FAILED: bridge offline")));
  // Combined equity covers ONLY the readable account — the gap is not filled in.
  assert.equal(g.combinedEquity, 5000);
  assert.deepEqual(g.combinedEquityCoverage, { known: 1, unknown: 1 });
  assert.ok(g.reasons.some((r) => r.includes("PARTIAL")));
});

test("unknown riskAmount is counted as unknown, never synthesized into the totals", () => {
  const g = buildBeneficialOwnerExposureGraph({
    accounts: [okAccount("mt5:1", 5000)],
    positions: [
      pos({ sourceId: "1", riskAmount: 50 }),
      pos({ sourceId: "2", riskAmount: null }),
    ],
    sourcesRead: ["trades"],
  });
  assert.equal(g.totalGrossRiskAmount, 50); // NOT 50 + something invented
  assert.equal(g.byInstrument[0]!.riskAmountUnknownCount, 1);
});

test("admission summary (#21 feed) carries venue risk and the coverage verdict", () => {
  const g = buildBeneficialOwnerExposureGraph({
    accounts: [
      okAccount("mt5:1", 5000),
      { accountKey: "deriv:1", venue: "deriv", equity: 2000, balance: 2000, status: "STALE", statusReason: "snapshot 20m old" },
    ],
    positions: [
      pos({ sourceId: "1", venue: "mt5", riskAmount: 40 }),
      pos({ sourceId: "2", venue: "deriv", accountKey: "deriv:1", symbol: "V75", riskAmount: 60 }),
    ],
    sourcesRead: ["trades", "live_positions"],
  });
  const s = summarizeExposureForAdmission(g);
  assert.equal(s.byVenueRiskAmount.mt5, 40);
  assert.equal(s.byVenueRiskAmount.deriv, 60);
  assert.equal(s.totalGrossRiskAmount, 100);
  assert.equal(s.coverageComplete, false); // STALE account → not complete
  assert.ok(s.coverageGaps.length >= 1);
});
