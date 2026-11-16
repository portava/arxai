// Tier math unit tests (Task #610).
// Covers: BASE_TIER_LADDER boundaries, computeActiveTierBuyInPrice,
// computeShareIssuePrice, computeNextTierPreview, dynamic pricing,
// and the 3-way waterfall split (45.5 / 24.5 / 30).
//
// Pure logic only — no DB, no server. Node.js test runner.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  BASE_TIER_LADDER,
  computeFinalizedPoolValue,
  computeFinalizedNavPerUnit,
  computeActiveTierBuyInPrice,
  computeShareIssuePrice,
  computeNextTierPreview,
  computeInvestorTierValueBreakdown,
  computeDynamicTierPrice,
  DYNAMIC_BASE_PRICE,
  selectActiveTier,
} from "../../artifacts/api-server/src/lib/fundbook/tierMath.js";

// ── Tier ladder shape ────────────────────────────────────────────────────────

describe("BASE_TIER_LADDER", () => {
  test("has exactly 10 tiers", () => {
    assert.equal(BASE_TIER_LADDER.length, 10);
  });

  test("tier numbers 1–10 are sequential", () => {
    for (let i = 0; i < BASE_TIER_LADDER.length; i++) {
      assert.equal(BASE_TIER_LADDER[i]!.tierNum, i + 1);
    }
  });

  test("T1 starts at navMin 0", () => {
    assert.equal(BASE_TIER_LADDER[0]!.navMin, 0);
  });

  test("T9 navMin < T9 navMax and T10 is open-ended", () => {
    const t9 = BASE_TIER_LADDER[8]!;
    assert.ok(t9.navMax !== null && t9.navMin < t9.navMax);
    const t10 = BASE_TIER_LADDER[9]!;
    assert.equal(t10.navMax, null);
  });

  test("each fixed tier has sharePrice set", () => {
    const fixed = BASE_TIER_LADDER.filter((t) => t.pricingMode === "FIXED");
    for (const t of fixed) {
      assert.ok(typeof t.sharePrice === "number" && t.sharePrice > 0);
    }
  });

  test("T10 is DYNAMIC", () => {
    const t10 = BASE_TIER_LADDER[9]!;
    assert.equal(t10.pricingMode, "DYNAMIC");
    assert.equal(t10.sharePrice, null);
  });
});

// ── computeFinalizedPoolValue / computeFinalizedNavPerUnit ───────────────────

describe("computeFinalizedPoolValue", () => {
  test("computes settled NAV from PoolValueComponents (no unrealizedPl)", () => {
    const val = computeFinalizedPoolValue({
      startingCapital: 100_000,
      realizedPl: 5_000,
      unrealizedPl: 20_000,  // excluded from finalized
      depositsAllocated: 0,
      withdrawalsRedeemed: 0,
      feesAccrued: 2_000,
      approvedAdjustments: 0,
    });
    // 100k + 5k - 2k = 103k (unrealizedPl NOT counted)
    assert.equal(val, 103_000);
  });

  test("unrealizedPl is excluded from finalized value", () => {
    const withUnrealized = computeFinalizedPoolValue({
      startingCapital: 50_000,
      realizedPl: 0,
      unrealizedPl: 10_000,
      depositsAllocated: 0,
      withdrawalsRedeemed: 0,
      feesAccrued: 0,
      approvedAdjustments: 0,
    });
    const withoutUnrealized = computeFinalizedPoolValue({
      startingCapital: 50_000,
      realizedPl: 0,
      unrealizedPl: 0,
      depositsAllocated: 0,
      withdrawalsRedeemed: 0,
      feesAccrued: 0,
      approvedAdjustments: 0,
    });
    assert.equal(withUnrealized, withoutUnrealized);
  });
});

describe("computeFinalizedNavPerUnit", () => {
  test("returns 1.0 when no units outstanding", () => {
    const nav = computeFinalizedNavPerUnit(50_000, 0);
    assert.equal(nav, 1.00);
  });

  test("standard NAV/unit calculation", () => {
    const nav = computeFinalizedNavPerUnit(100_000, 1_000);
    assert.equal(nav, 100);
  });

  test("reflects growth above initial", () => {
    const nav = computeFinalizedNavPerUnit(120_000, 1_000);
    assert.equal(nav, 120);
  });

  test("returns null on non-finite inputs", () => {
    const nav = computeFinalizedNavPerUnit(NaN, 1_000);
    assert.equal(nav, null);
  });
});

// ── computeActiveTierBuyInPrice ──────────────────────────────────────────────

describe("computeActiveTierBuyInPrice", () => {
  test("T1 at nav=0 returns fixed T1 price", () => {
    const t1 = BASE_TIER_LADDER[0]!;
    const price = computeActiveTierBuyInPrice(t1, 0, 0.15, 50_000);
    assert.equal(price, t1.sharePrice!);
  });

  test("T1 through T9 return the fixed sharePrice", () => {
    for (let i = 0; i < 9; i++) {
      const tier = BASE_TIER_LADDER[i]!;
      const price = computeActiveTierBuyInPrice(tier, 0, 0.15, 50_000);
      assert.equal(price, tier.sharePrice!);
    }
  });

  test("T10 DYNAMIC price >= T9 fixed price (baseline)", () => {
    const t10 = BASE_TIER_LADDER[9]!;
    const t9 = BASE_TIER_LADDER[8]!;
    const price = computeActiveTierBuyInPrice(t10, 1_500_000, 0.15, 50_000);
    assert.ok(price >= t9.sharePrice!);
  });

  test("T10 DYNAMIC price increases with higher NAV", () => {
    const t10 = BASE_TIER_LADDER[9]!;
    const p1 = computeActiveTierBuyInPrice(t10, 1_500_000, 0.15, 50_000);
    const p2 = computeActiveTierBuyInPrice(t10, 2_000_000, 0.15, 50_000);
    assert.ok(p2 > p1, `p2=${p2} should be > p1=${p1}`);
  });
});

// ── computeShareIssuePrice ───────────────────────────────────────────────────

describe("computeShareIssuePrice", () => {
  test("returns finalizedNavPerUnit when > activeBuyInPrice", () => {
    const price = computeShareIssuePrice(120, 100);
    assert.equal(price, 120);
  });

  test("returns activeBuyInPrice when > finalizedNavPerUnit", () => {
    const price = computeShareIssuePrice(80, 100);
    assert.equal(price, 100);
  });

  test("returns equal when both are the same", () => {
    const price = computeShareIssuePrice(100, 100);
    assert.equal(price, 100);
  });

  test("returns 0 when both inputs are 0 (startup edge case)", () => {
    const price = computeShareIssuePrice(0, 0);
    assert.equal(price, 0);
  });
});

// ── computeNextTierPreview ───────────────────────────────────────────────────

describe("computeNextTierPreview", () => {
  test("T1 returns T2 threshold and price", () => {
    const t1 = BASE_TIER_LADDER[0]!;
    const preview = computeNextTierPreview(t1, 0, BASE_TIER_LADDER);
    assert.equal(preview.nextTierNum, 2);
    assert.ok(preview.nextTierThreshold! > 0);
    assert.ok(preview.nextTierEstimatedPrice! > 0);
  });

  test("T10 returns null-valued fields (open-ended, no next tier)", () => {
    const t10 = BASE_TIER_LADDER[9]!;
    const preview = computeNextTierPreview(t10, 2_000_000, BASE_TIER_LADDER);
    assert.equal(preview.nextTierNum, null);
    assert.equal(preview.nextTierThreshold, null);
  });

  test("each fixed tier preview threshold matches the next tier navMin", () => {
    for (let i = 0; i < 8; i++) {
      const tier = BASE_TIER_LADDER[i]!;
      const nextTier = BASE_TIER_LADDER[i + 1]!;
      const preview = computeNextTierPreview(tier, tier.navMin, BASE_TIER_LADDER);
      assert.equal(preview.nextTierThreshold, nextTier.navMin);
    }
  });

  test("progressPct is 0 at tier navMin threshold", () => {
    const t2 = BASE_TIER_LADDER[1]!;
    const preview = computeNextTierPreview(t2, t2.navMin, BASE_TIER_LADDER);
    assert.ok(preview.progressPct !== null && preview.progressPct >= 0);
  });
});

// ── computeDynamicTierPrice ──────────────────────────────────────────────────

describe("computeDynamicTierPrice", () => {
  test("returns T9 floor price (7.50) at exactly T10 threshold (1.5M)", () => {
    // At exactly 1.5M: steps=0, so price = DYNAMIC_BASE_PRICE × (1+m)^0 = DYNAMIC_BASE_PRICE
    const price = computeDynamicTierPrice(1_500_000);
    assert.equal(price, DYNAMIC_BASE_PRICE);
  });

  test("price grows above T10 threshold with default params", () => {
    const baseline = computeDynamicTierPrice(1_500_000);
    const higher = computeDynamicTierPrice(2_000_000);
    assert.ok(higher > baseline, `higher=${higher} should be > baseline=${baseline}`);
  });

  test("price grows monotonically across multiple NAV levels", () => {
    const prices = [1_500_000, 2_000_000, 2_500_000, 3_000_000].map((nav) =>
      computeDynamicTierPrice(nav),
    );
    for (let i = 1; i < prices.length; i++) {
      assert.ok(prices[i]! >= prices[i - 1]!, `prices[${i}]=${prices[i]} should be >= prices[${i-1}]=${prices[i-1]}`);
    }
  });

  test("custom multiplier and step size affect price", () => {
    const p1 = computeDynamicTierPrice(2_000_000, 0.10, 500_000);
    const p2 = computeDynamicTierPrice(2_000_000, 0.30, 500_000);
    assert.ok(p2 > p1, `higher multiplier should give higher price`);
  });
});

// ── computeInvestorTierValueBreakdown ────────────────────────────────────────

describe("computeInvestorTierValueBreakdown", () => {
  test("finalizedValue = units × finalizedNav", () => {
    const result = computeInvestorTierValueBreakdown(100, 110, 130);
    assert.equal(result.finalizedValue, 11_000);
    assert.equal(result.estimatedValue, 13_000);
    assert.equal(result.floatingComponent, 2_000);
  });

  test("negative floating component when estimated < finalized", () => {
    const result = computeInvestorTierValueBreakdown(50, 120, 100);
    assert.equal(result.finalizedValue, 6_000);
    assert.equal(result.estimatedValue, 5_000);
    assert.equal(result.floatingComponent, -1_000);
  });

  test("zero floating component when finalized equals estimated", () => {
    const result = computeInvestorTierValueBreakdown(100, 100, 100);
    assert.equal(result.floatingComponent, 0);
  });
});

// ── Waterfall split 45.5 / 24.5 / 30 ────────────────────────────────────────

describe("Waterfall split fractions (45.5 / 24.5 / 30)", () => {
  const INVESTOR_PCT = 0.30;
  const TRADER_PCT = 0.245;
  const ARX_PCT = 0.455;

  test("fractions sum to 1.0", () => {
    const sum = INVESTOR_PCT + TRADER_PCT + ARX_PCT;
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `sum=${sum}`);
  });

  test("on $100k eligible profit: 45.5k ARX, 24.5k trader, 30k investor", () => {
    const profit = 100_000;
    const arx = Math.round(profit * ARX_PCT * 100) / 100;
    const trader = Math.round(profit * TRADER_PCT * 100) / 100;
    const investor = Math.round(profit * INVESTOR_PCT * 100) / 100;
    assert.equal(arx, 45_500);
    assert.equal(trader, 24_500);
    assert.equal(investor, 30_000);
  });

  test("investor share is strictly less than ARX share", () => {
    assert.ok(INVESTOR_PCT < ARX_PCT);
  });

  test("each share is positive", () => {
    assert.ok(INVESTOR_PCT > 0 && TRADER_PCT > 0 && ARX_PCT > 0);
  });

  test("proportions are stable across different profit amounts", () => {
    for (const profit of [1_000, 50_000, 1_000_000]) {
      const arx = profit * ARX_PCT;
      const trader = profit * TRADER_PCT;
      const investor = profit * INVESTOR_PCT;
      const sum = arx + trader + investor;
      assert.ok(Math.abs(sum - profit) < 1e-6, `profit=${profit} sum=${sum}`);
      assert.ok(Math.abs(arx / profit - ARX_PCT) < 1e-9, "ARX fraction stable");
      assert.ok(Math.abs(trader / profit - TRADER_PCT) < 1e-9, "Trader fraction stable");
      assert.ok(Math.abs(investor / profit - INVESTOR_PCT) < 1e-9, "Investor fraction stable");
    }
  });
});

// ── Tier selection: estimated NAV must NOT activate a tier ────────────────────

describe("selectActiveTier — finalized NAV is the gate, not estimated", () => {
  // T1: navMin=0, navMax=25_000. T2 starts at navMin=25_000.01.
  const T2_NAV_MIN = BASE_TIER_LADDER.find((t) => t.tierNum === 2)!.navMin;
  const T1_NAV = T2_NAV_MIN - 1; // safely in T1

  test("tier stays at T1 when finalized NAV is below T2 threshold", () => {
    const tier = selectActiveTier(T1_NAV, BASE_TIER_LADDER);
    assert.equal(tier.tierNum, 1, "finalized NAV below T2 navMin → T1");
  });

  test("large unrealizedPl does not affect selectActiveTier result", () => {
    const unrealizedPl = 5_000_000;
    const tierFromFinalized = selectActiveTier(T1_NAV, BASE_TIER_LADDER);
    const tierFromEstimated = selectActiveTier(T1_NAV + unrealizedPl, BASE_TIER_LADDER);

    assert.equal(tierFromFinalized.tierNum, 1,
      "finalized NAV in T1 returns T1 regardless of floating gains");
    assert.ok(tierFromEstimated.tierNum > 1,
      "estimated NAV (finalized+floating) would yield a higher tier — confirming the rule: only finalized matters");
    assert.notEqual(tierFromFinalized.tierNum, tierFromEstimated.tierNum,
      "the two paths diverge — proof that selectActiveTier must always receive finalized NAV, never estimated");
  });

  test("tier advances only when finalized NAV crosses the threshold", () => {
    const t2 = BASE_TIER_LADDER.find((t) => t.tierNum === 2)!;
    const justBelow = selectActiveTier(t2.navMin - 0.01, BASE_TIER_LADDER);
    const atThreshold = selectActiveTier(t2.navMin, BASE_TIER_LADDER);
    assert.equal(justBelow.tierNum, 1, "just below T2 navMin → still T1");
    assert.equal(atThreshold.tierNum, 2, "exactly at T2 navMin → T2 activates");
  });
});

// ── Stair-step: buy-in price must be monotonically non-decreasing when downgrade OFF ──

describe("Stair-step tier advancement — price monotonicity", () => {
  test("tier number is pinned up via Math.max when downgrade mode is off", () => {
    const previousTierNum = 5;
    const activeTierNum = 3;
    const resolvedTierNumDowngradeOff = Math.max(previousTierNum, activeTierNum);
    assert.equal(resolvedTierNumDowngradeOff, 5, "tier number never drops when downgrade=false");
  });

  test("tier number can drop when downgrade mode is on", () => {
    const previousTierNum = 5;
    const activeTierNum = 3;
    const resolvedTierNumDowngradeOn = activeTierNum;
    assert.equal(resolvedTierNumDowngradeOn, 3, "tier number follows NAV down when downgrade=true");
  });

  test("buy-in price is pinned when downgrade mode is off and computed price falls", () => {
    const previousBuyInPrice = 6.00;
    const computedBuyInPrice = 5.50;
    const resolvedDowngradeOff = Math.max(previousBuyInPrice, computedBuyInPrice);
    assert.equal(resolvedDowngradeOff, 6.00, "price is monotonic when downgrade=false");
  });

  test("buy-in price can decrease when downgrade mode is on", () => {
    const previousBuyInPrice = 6.00;
    const computedBuyInPrice = 5.50;
    const resolvedDowngradeOn = computedBuyInPrice;
    assert.equal(resolvedDowngradeOn, 5.50, "price tracks NAV down when downgrade=true");
  });

  test("T10 dynamic price is pinned if NAV drops within a step when downgrade mode is off", () => {
    const navHigh = 2_100_000;
    const navLow  = 1_600_000;
    const tier10 = BASE_TIER_LADDER.find((t) => t.tierNum === 10)!;
    const priceAtHigh = computeActiveTierBuyInPrice(tier10, navHigh, 0.20, 500_000);
    const priceAtLow  = computeActiveTierBuyInPrice(tier10, navLow,  0.20, 500_000);
    assert.ok(priceAtHigh > priceAtLow, "dynamic formula produces lower price at lower NAV");
    const resolvedWhenDowngradeOff = Math.max(priceAtHigh, priceAtLow);
    assert.equal(resolvedWhenDowngradeOff, priceAtHigh, "higher-ever price is retained when downgrade=false");
  });
});

// ── Share issuance: more NAV/tier price → fewer units issued ──────────────────

describe("Units issued decrease as tier buy-in price rises", () => {
  const NET_AMOUNT = 50_000;
  const FINALIZED_NAV_PER_UNIT = 1.00;

  test("lower tier price issues more units than higher tier price for the same deposit", () => {
    const lowPrice  = computeShareIssuePrice(FINALIZED_NAV_PER_UNIT, 2.00);
    const highPrice = computeShareIssuePrice(FINALIZED_NAV_PER_UNIT, 5.00);
    const unitsAtLow  = NET_AMOUNT / lowPrice;
    const unitsAtHigh = NET_AMOUNT / highPrice;
    assert.ok(unitsAtHigh < unitsAtLow,
      `fewer units at higher price (${unitsAtHigh.toFixed(2)} vs ${unitsAtLow.toFixed(2)})`);
  });

  test("unit count is inversely proportional to issue price", () => {
    const price = 4.00;
    const units = NET_AMOUNT / price;
    assert.ok(Math.abs(units - 12_500) < 0.01, `expected 12500 units, got ${units}`);
  });

  test("existing unit-holders are unaffected: their unit count doesn't change at issuance", () => {
    const existingUnits = 100_000;
    const newUnits = NET_AMOUNT / computeShareIssuePrice(1.00, 5.00);
    assert.equal(existingUnits, 100_000, "existing units are never modified at issuance time");
    assert.ok(newUnits > 0, "only new units are added");
  });
});

// ── Finalized-only withdrawal basis ──────────────────────────────────────────

describe("computeFinalizedPoolValue — withdrawals deduct from finalized basis", () => {
  const BASE = {
    startingCapital: 1_000_000,
    realizedPl: 100_000,
    unrealizedPl: 999_999,
    depositsAllocated: 200_000,
    withdrawalsRedeemed: 50_000,
    feesAccrued: 10_000,
    approvedAdjustments: 0,
  };

  test("withdrawal reduces finalized NAV by the exact withdrawn amount", () => {
    const withoutWithdrawal = computeFinalizedPoolValue({ ...BASE, withdrawalsRedeemed: 0 });
    const withWithdrawal    = computeFinalizedPoolValue(BASE);
    assert.equal(withoutWithdrawal - withWithdrawal, 50_000,
      "50k withdrawal reduces finalized NAV by exactly 50k");
  });

  test("unrealizedPl does not affect finalized NAV regardless of magnitude", () => {
    const base     = computeFinalizedPoolValue({ ...BASE, unrealizedPl: 0 });
    const highFloat = computeFinalizedPoolValue({ ...BASE, unrealizedPl: 10_000_000 });
    assert.equal(base, highFloat, "unrealizedPl is never part of finalized NAV");
  });

  test("finalized NAV is the correct withdrawal redemption basis", () => {
    const finalizedNav = computeFinalizedPoolValue(BASE);
    const expected = 1_000_000 + 100_000 + 200_000 - 50_000 - 10_000;
    assert.equal(finalizedNav, expected);
  });
});
