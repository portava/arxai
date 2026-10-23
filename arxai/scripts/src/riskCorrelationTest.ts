// Test: risk-correlation static families + cluster exposure guard
// (lib/domain/src/risk-correlation — R3 slice 6 pure core, spec check 20).
//
// What this suite pins, and why each pin exists:
//
//   1. EXHAUSTIVE UNIVERSE COVERAGE. Every one of the 250 approved markets
//      resolves to a NON-unknown family when its asset class is supplied.
//      The family data in lib/domain is hand-derived from lib/markets (the
//      domain package may not import @workspace/markets), so this loop is the
//      drift alarm: add a market the resolver cannot classify and this test
//      goes red.
//
//   2. UNKNOWN ISOLATION. An unclassifiable symbol gets its OWN family —
//      two strangers never pool. Pooling would let unknown correlation
//      create capacity (spec check 20's forbidden outcome).
//
//   3. CLUSTER MATH. Same-family same-direction sums absolute risk;
//      opposite-direction hedges neither reduce nor join the cluster
//      (netting is venue-specific — no offset credit).
//
//   4. CAP SEMANTICS. null = no cap (matching the existing nullable-cap
//      convention), 0 = zero capacity (never "unlimited"), exact-at-cap is
//      allowed, over-cap refuses, malformed caps refuse. Production cap
//      values remain an owner decision; nothing here blesses a default.
//
// Pure unit test — no DB, no network, no clock. Offline CI lane.

import { ARX_TOP_250 } from "@workspace/markets";
import { riskCorrelation } from "@workspace/domain";
import { isEntrypoint, type CiTestResultLike } from "./ci/inProcessAppHarness.js";

const {
  resolveRiskFamily,
  isUnknownFamily,
  UNKNOWN_FAMILY_PREFIX,
  evaluateClusterExposure,
  CLUSTER_RISK_EXCEEDED,
  CLUSTER_POSITIONS_EXCEEDED,
  CANDIDATE_INVALID,
  OPEN_POSITION_INVALID,
  CLUSTER_CAP_INVALID,
} = riskCorrelation;

export async function run(): Promise<CiTestResultLike> {
  let passes = 0;
  let failures = 0;

  function assert(cond: boolean, label: string) {
    if (cond) {
      passes++;
      console.log(`  ✓ ${label}`);
    } else {
      failures++;
      console.error(`  ✗ ${label}`);
    }
  }

  console.log("riskCorrelationTest");
  console.log("===================\n");

  // ── 1. Exhaustive: all 250 approved markets resolve with assetClass ───────
  console.log("Exhaustive universe coverage (assetClass supplied)");
  {
    assert(ARX_TOP_250.length === 250, `universe is exactly 250 markets (got ${ARX_TOP_250.length})`);

    const unresolved: string[] = [];
    const families = new Set<string>();
    for (const market of ARX_TOP_250) {
      const r = resolveRiskFamily(market.standardSymbol, market.assetClass);
      if (r.isUnknown || isUnknownFamily(r.family) || r.family.length === 0) {
        unresolved.push(`${market.standardSymbol} [${market.assetClass}]`);
      }
      families.add(r.family);
    }
    assert(
      unresolved.length === 0,
      unresolved.length === 0
        ? "every universe entry resolves to a known family"
        : `unresolved entries: ${unresolved.slice(0, 10).join(", ")}${unresolved.length > 10 ? "…" : ""}`,
    );
    assert(families.size > 1, `families are split, not pooled (${families.size} distinct families)`);
  }

  // ── 2. Class-less inference agrees with class-supplied resolution ─────────
  console.log("\nClass-less symbol inference (non-stock/etf classes)");
  {
    // Single stocks and ETFs are NOT inferable from a bare ticker by design;
    // every other class must resolve identically without the class hint.
    const inferable = ARX_TOP_250.filter(
      (m) => m.assetClass !== "stock" && m.assetClass !== "etf",
    );
    const mismatches: string[] = [];
    for (const market of inferable) {
      const withClass = resolveRiskFamily(market.standardSymbol, market.assetClass);
      const bare = resolveRiskFamily(market.standardSymbol);
      if (bare.family !== withClass.family) {
        mismatches.push(`${market.standardSymbol}: ${bare.family} != ${withClass.family}`);
      }
    }
    assert(
      mismatches.length === 0,
      mismatches.length === 0
        ? `bare-symbol inference matches class-supplied for all ${inferable.length} non-stock/etf entries`
        : `mismatches: ${mismatches.slice(0, 8).join("; ")}`,
    );
    assert(
      resolveRiskFamily("AAPL").isUnknown,
      "a bare stock ticker without assetClass is honestly UNKNOWN, not guessed",
    );
    assert(
      resolveRiskFamily("AAPL", "stock").family === "stocks",
      "…and resolves to the stocks family once the class is supplied",
    );
  }

  // ── 3. Specific family pins ────────────────────────────────────────────────
  console.log("\nSpecific family assignments");
  {
    const fam = (s: string, c?: string) => resolveRiskFamily(s, c).family;

    // The audit's check-20 failure scenario: EURUSD+GBPUSD stacking. These
    // MUST share a family so the cluster cap can bind them.
    assert(fam("EURUSD") === "fx:usd-bloc", "EURUSD → fx:usd-bloc");
    assert(fam("GBPUSD") === "fx:usd-bloc", "GBPUSD → fx:usd-bloc (clusters with EURUSD — audit scenario)");
    assert(fam("USDJPY") === "fx:usd-bloc", "USDJPY → fx:usd-bloc (USD precedence)");
    assert(fam("EURGBP") === "fx:eur-bloc", "EURGBP → fx:eur-bloc");
    assert(fam("EURJPY") === "fx:eur-bloc", "EURJPY → fx:eur-bloc (EUR precedence over JPY)");
    assert(fam("GBPJPY") === "fx:jpy-crosses", "GBPJPY → fx:jpy-crosses");
    assert(fam("CHFJPY") === "fx:jpy-crosses", "CHFJPY → fx:jpy-crosses");
    assert(fam("GBPAUD") === "fx:gbp-bloc", "GBPAUD (no USD/EUR/JPY) → fx:gbp-bloc");
    assert(fam("AUDNZD") === "fx:aud-bloc", "AUDNZD (no USD/EUR/JPY) → fx:aud-bloc");
    assert(fam("USDTRY") === "fx:usd-bloc", "USDTRY exotic → fx:usd-bloc");

    assert(fam("XAUUSD") === "metals", "XAUUSD → metals");
    assert(fam("XAGEUR") === "metals", "XAGEUR → metals (same family as gold — no cross-metal capacity)");

    assert(fam("BTCUSD") === "crypto", "BTCUSD → crypto");
    assert(fam("PEPEUSD") === "crypto", "PEPEUSD → crypto");
    assert(fam("US30") === "indices", "US30 → indices");
    assert(fam("GER40") === "indices", "GER40 → indices");
    assert(fam("USOIL") === "energy", "USOIL → energy");
    assert(fam("COPPER") === "commodities", "COPPER → commodities");
    assert(fam("SPY", "etf") === "etf", "SPY [etf] → etf");

    // Synthetic sub-families — split by product family, per the R3 command.
    assert(fam("Volatility 75 Index") === "synthetic:volatility", "Volatility 75 Index → synthetic:volatility");
    assert(fam("Volatility 150 1s Index") === "synthetic:volatility", "Volatility 150 1s Index → synthetic:volatility");
    assert(fam("Boom 500 Index") === "synthetic:boom-crash", "Boom 500 Index → synthetic:boom-crash");
    assert(fam("Crash 1000 Index") === "synthetic:boom-crash", "Crash 1000 Index → synthetic:boom-crash (boom+crash share one family)");
    assert(fam("Jump 25 Index") === "synthetic:jump", "Jump 25 Index → synthetic:jump");
    assert(fam("Step Index") === "synthetic:step", "Step Index → synthetic:step");
    assert(fam("Range Break 100 Index") === "synthetic:range", "Range Break 100 Index → synthetic:range");

    // Deriv provider codes resolve to the same synthetic families.
    assert(fam("R_75") === "synthetic:volatility", "Deriv code R_75 → synthetic:volatility");
    assert(fam("1HZ100V") === "synthetic:volatility", "Deriv code 1HZ100V → synthetic:volatility");
    assert(fam("BOOM500N") === "synthetic:boom-crash", "Deriv code BOOM500N → synthetic:boom-crash");
    assert(fam("JD50") === "synthetic:jump", "Deriv code JD50 → synthetic:jump");
    assert(fam("stpRNG") === "synthetic:step", "Deriv code stpRNG → synthetic:step");

    // An unvetted asset-class label never fabricates a family.
    const bogusClass = resolveRiskFamily("EURUSD", "made_up_class");
    assert(bogusClass.family === "fx:usd-bloc", "an unrecognised class label falls through to symbol inference");
  }

  // ── 4. Unknown isolation — strangers never pool ────────────────────────────
  console.log("\nUnknown-symbol isolation (spec check 20)");
  {
    const a = resolveRiskFamily("WEIRD_TICKER_1");
    const b = resolveRiskFamily("WEIRD_TICKER_2");
    assert(a.isUnknown && b.isUnknown, "unclassifiable symbols resolve as unknown");
    assert(a.family.startsWith(UNKNOWN_FAMILY_PREFIX), "unknown family carries the unknown prefix");
    assert(a.family !== b.family, "two unknown strangers get DIFFERENT families (no pooling)");
    assert(
      resolveRiskFamily("WEIRD_TICKER_1").family === a.family,
      "the same unknown symbol resolves to the same family (deterministic)",
    );
    assert(
      resolveRiskFamily("  weird_ticker_1 ").family === a.family,
      "unknown family key is normalised (trim + case)",
    );

    // Guard-level: an unknown candidate ignores other unknown strangers…
    const strangers = evaluateClusterExposure({
      candidate: { symbol: "WEIRD_TICKER_1", side: "BUY", riskAmount: 100 },
      openPositions: [
        { symbol: "WEIRD_TICKER_2", side: "BUY", riskAmount: 500 },
        { symbol: "WEIRD_TICKER_3", side: "BUY", riskAmount: 500 },
      ],
      maxClusterRisk: 150,
      maxClusterPositions: null,
    });
    assert(strangers.allowed, "unknown candidate is not clustered with unknown strangers");
    assert(strangers.clusterRisk === 100 && strangers.clusterCount === 1,
      `…cluster is the candidate alone (risk ${strangers.clusterRisk}, count ${strangers.clusterCount})`);

    // …but DOES cluster with itself (same symbol = same instrument).
    const sameSymbol = evaluateClusterExposure({
      candidate: { symbol: "WEIRD_TICKER_1", side: "BUY", riskAmount: 100 },
      openPositions: [{ symbol: "WEIRD_TICKER_1", side: "BUY", riskAmount: 100 }],
      maxClusterRisk: 150,
      maxClusterPositions: null,
    });
    assert(!sameSymbol.allowed && sameSymbol.reason === CLUSTER_RISK_EXCEEDED,
      "the SAME unknown symbol clusters with itself and the cap binds");
  }

  // ── 5. Cluster math ────────────────────────────────────────────────────────
  console.log("\nCluster math");
  {
    const openPositions = [
      { symbol: "GBPUSD", side: "BUY", riskAmount: 200 },   // same family, same dir
      { symbol: "USDJPY", side: "SELL", riskAmount: 500 },  // same family, OPPOSITE dir
      { symbol: "XAUUSD", side: "BUY", riskAmount: 900 },   // different family
      { symbol: "AUDUSD", side: "long", riskAmount: -50 },  // synonym side, negative risk
    ];
    const r = evaluateClusterExposure({
      candidate: { symbol: "EURUSD", side: "buy", riskAmount: 100 },
      openPositions,
      maxClusterRisk: null,
      maxClusterPositions: null,
    });
    assert(r.allowed, "null caps allow (unset = no cap, matching daily-loss semantics)");
    assert(r.clusterKey === "fx:usd-bloc|BUY", `clusterKey is family|side (got ${r.clusterKey})`);
    assert(r.clusterRisk === 350,
      `cluster risk = 100 + 200 + |−50|: hedge gives no offset, negative risk counts absolute (got ${r.clusterRisk})`);
    assert(r.clusterCount === 3, `cluster count includes candidate, excludes hedge+other family (got ${r.clusterCount})`);

    const again = evaluateClusterExposure({
      candidate: { symbol: "EURUSD", side: "buy", riskAmount: 100 },
      openPositions,
      maxClusterRisk: null,
      maxClusterPositions: null,
    });
    assert(JSON.stringify(again) === JSON.stringify(r), "evaluator is pure and deterministic");

    // The opposite-direction candidate forms its own cluster.
    const sellSide = evaluateClusterExposure({
      candidate: { symbol: "EURUSD", side: "SELL", riskAmount: 100 },
      openPositions,
      maxClusterRisk: null,
      maxClusterPositions: null,
    });
    assert(sellSide.clusterKey === "fx:usd-bloc|SELL", "opposite-direction candidate gets its own cluster key");
    assert(sellSide.clusterRisk === 600 && sellSide.clusterCount === 2,
      `…clustering with the open SELL only (risk ${sellSide.clusterRisk}, count ${sellSide.clusterCount})`);

    // Cross-symbol clustering is the point: candidate GBPUSD clusters with an
    // open EURUSD (the audit's stacking scenario is now constrained).
    const stack = evaluateClusterExposure({
      candidate: { symbol: "GBPUSD", side: "BUY", riskAmount: 300 },
      openPositions: [{ symbol: "EURUSD", side: "BUY", riskAmount: 300 }],
      maxClusterRisk: 500,
      maxClusterPositions: null,
    });
    assert(!stack.allowed && stack.reason === CLUSTER_RISK_EXCEEDED,
      "EURUSD+GBPUSD stacking is refused by the shared-family cap (audit check 20 scenario)");
  }

  // ── 6. Cap semantics: unset / breached / exact / zero / malformed ─────────
  console.log("\nCap semantics");
  {
    const base = {
      candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 100 },
      openPositions: [{ symbol: "GBPUSD", side: "BUY", riskAmount: 200 }],
    };

    const unset = evaluateClusterExposure({ ...base, maxClusterRisk: null, maxClusterPositions: null });
    assert(unset.allowed && unset.reason === undefined, "both caps null → allowed, no reason");

    const exactRisk = evaluateClusterExposure({ ...base, maxClusterRisk: 300, maxClusterPositions: null });
    assert(exactRisk.allowed, "exactly-at-risk-cap (300 of 300) is allowed");

    const overRisk = evaluateClusterExposure({ ...base, maxClusterRisk: 299.99, maxClusterPositions: null });
    assert(!overRisk.allowed && overRisk.reason === CLUSTER_RISK_EXCEEDED, "over-risk-cap refuses with CLUSTER_RISK_EXCEEDED");
    assert(overRisk.clusterRisk === 300 && overRisk.clusterCount === 2, "…and reports the offending cluster numbers");

    const exactCount = evaluateClusterExposure({ ...base, maxClusterRisk: null, maxClusterPositions: 2 });
    assert(exactCount.allowed, "exactly-at-position-cap (2 of 2) is allowed");

    const overCount = evaluateClusterExposure({ ...base, maxClusterRisk: null, maxClusterPositions: 1 });
    assert(!overCount.allowed && overCount.reason === CLUSTER_POSITIONS_EXCEEDED, "over-position-cap refuses with CLUSTER_POSITIONS_EXCEEDED");

    const zeroRisk = evaluateClusterExposure({ ...base, maxClusterRisk: 0, maxClusterPositions: null });
    assert(!zeroRisk.allowed && zeroRisk.reason === CLUSTER_RISK_EXCEEDED, "risk cap 0 means ZERO capacity, never unlimited");

    const zeroCount = evaluateClusterExposure({ ...base, maxClusterRisk: null, maxClusterPositions: 0 });
    assert(!zeroCount.allowed && zeroCount.reason === CLUSTER_POSITIONS_EXCEEDED, "position cap 0 means ZERO capacity, never unlimited");

    const negativeCap = evaluateClusterExposure({ ...base, maxClusterRisk: -5, maxClusterPositions: null });
    assert(!negativeCap.allowed && negativeCap.reason === CLUSTER_CAP_INVALID, "a negative cap refuses (never degrades to no-cap)");

    const nanCap = evaluateClusterExposure({ ...base, maxClusterRisk: NaN, maxClusterPositions: null });
    assert(!nanCap.allowed && nanCap.reason === CLUSTER_CAP_INVALID, "a NaN cap refuses");

    const fractionalCount = evaluateClusterExposure({ ...base, maxClusterRisk: null, maxClusterPositions: 2.5 });
    assert(!fractionalCount.allowed && fractionalCount.reason === CLUSTER_CAP_INVALID, "a fractional position cap refuses");
  }

  // ── 7. Fail-closed input validation ────────────────────────────────────────
  console.log("\nFail-closed input validation");
  {
    const nanRisk = evaluateClusterExposure({
      candidate: { symbol: "EURUSD", side: "BUY", riskAmount: NaN },
      openPositions: [],
      maxClusterRisk: null,
      maxClusterPositions: null,
    });
    assert(!nanRisk.allowed && nanRisk.reason === CANDIDATE_INVALID, "non-finite candidate risk refuses");

    const emptySymbol = evaluateClusterExposure({
      candidate: { symbol: "   ", side: "BUY", riskAmount: 1 },
      openPositions: [],
      maxClusterRisk: null,
      maxClusterPositions: null,
    });
    assert(!emptySymbol.allowed && emptySymbol.reason === CANDIDATE_INVALID, "blank candidate symbol refuses");

    const badSide = evaluateClusterExposure({
      candidate: { symbol: "EURUSD", side: "HOLD", riskAmount: 1 },
      openPositions: [],
      maxClusterRisk: null,
      maxClusterPositions: null,
    });
    assert(!badSide.allowed && badSide.reason === CANDIDATE_INVALID, "unrecognised candidate side refuses");

    // A corrupt OPEN ROW refuses the dispatch rather than being skipped —
    // skipping would silently create capacity.
    const corruptRow = evaluateClusterExposure({
      candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 1 },
      openPositions: [{ symbol: "GBPUSD", side: "BUY", riskAmount: Infinity }],
      maxClusterRisk: null,
      maxClusterPositions: null,
    });
    assert(!corruptRow.allowed && corruptRow.reason === OPEN_POSITION_INVALID, "a non-finite open-position risk refuses the dispatch");

    const corruptSide = evaluateClusterExposure({
      candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 1 },
      openPositions: [{ symbol: "GBPUSD", side: "???", riskAmount: 5 }],
      maxClusterRisk: null,
      maxClusterPositions: null,
    });
    assert(!corruptSide.allowed && corruptSide.reason === OPEN_POSITION_INVALID, "an unrecognised open-position side refuses the dispatch");
  }

  console.log(`\nResult: ${passes} passed, ${failures} failed`);
  return { name: "riskCorrelationTest", passes, failures };
}

if (isEntrypoint(import.meta.url)) {
  run().then(
    (r) => process.exit(r.failures > 0 ? 1 : 0),
    (err) => {
      console.error("[riskCorrelationTest] FAILED:", err);
      process.exit(1);
    },
  );
}
