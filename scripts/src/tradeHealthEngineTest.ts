// Live Trade Health & Management (Task #198) — PURE engine unit tests.
//
// Verifies the honesty + guidance-only contracts of the trade-health domain:
//  1. classifyTradeHealth maps the live price + stop buffer + thesis into
//     healthy / weakening / danger / invalidated (invalidation overrides).
//  2. computeTpProgress / computeSlDistance are honest: known numbers from real
//     inputs, known:false (with a plain note) when inputs are missing.
//  3. break-even / partial suggestions are `suggested:true` ONLY when valid.
//  4. matchTradeStyle reads holding time → scalp/intraday/swing; unknown openAt.
//  5. buildSetupAlternatives draws only the zones that are real (no fabrication).
//  6. detectConflicts: opposite (hedged), duplicate (stacked), over-exposure.
//  7. detectCorrelation: forex positions sharing a currency leg cluster.
//  8. detectOvertrading fires only on real thresholds; null inputs → no warning.
//  9. buildTradeHealthHandshake states (PASS/WARN/BLOCK) + honest NOT_AVAILABLE.
// 10. buildTradeHealthReport composes overlays only for real entries; honest
//     empty summary; NO close/modify side effects (pure — inputs unmutated).
// 11. No internal UPPER_SNAKE enum token leaks into ANY user-facing string.
//
// Pure & deterministic (nowMs / evaluatedAtIso passed in). No DB, no IO.
//
// Run: pnpm --filter @workspace/scripts run test:trade-health

import {
  assessOpenPosition,
  buildSetupAlternatives,
  buildTradeHealthHandshake,
  buildTradeHealthOverlayLayers,
  buildTradeHealthReport,
  classifyTradeHealth,
  computeSlDistance,
  computeTpProgress,
  deriveBreakEvenSuggestion,
  derivePartialCloseSuggestion,
  detectConflicts,
  detectCorrelation,
  detectOvertrading,
  matchTradeStyle,
  type OpenPositionInput,
  type OriginalSignalInput,
  type OvertradingInput,
} from "@workspace/domain/trade-health";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

// User-facing strings must never contain an internal UPPER_SNAKE token.
const TOKEN_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const collectedCopy: string[] = [];
function collect(...s: (string | null | undefined)[]) {
  for (const x of s) if (x) collectedCopy.push(x);
}

const NOW = Date.UTC(2026, 5, 5, 12, 0, 0);

function mkPos(over: Partial<OpenPositionInput> = {}): OpenPositionInput {
  return {
    ticket: "T1",
    symbol: "EURUSD",
    side: "BUY",
    lotSize: 0.1,
    entryPrice: 1.1,
    currentPrice: 1.105,
    stopLoss: 1.09,
    takeProfit: 1.12,
    floatingPnl: 5,
    openedAtMs: NOW - 30 * 60 * 1000,
    priceAgeMs: 5_000,
    accountMode: "DEMO",
    fillRecorded: true,
    ...over,
  };
}

function mkSignal(over: Partial<OriginalSignalInput> = {}): OriginalSignalInput {
  return {
    symbol: "EURUSD",
    direction: "BUY",
    hasSufficientData: true,
    invalidationPrice: 1.085,
    entryZone: { from: 1.099, to: 1.101 },
    retestZone: { from: 1.095, to: 1.097 },
    watchZone: { from: 1.09, to: 1.092 },
    ...over,
  };
}

// ── 1. classification ────────────────────────────────────────────────────────
{
  // healthy: price above entry, little buffer consumed
  const h = classifyTradeHealth(mkPos({ currentPrice: 1.105 }), null);
  check("healthy when buffer mostly intact", h.state === "healthy");

  // weakening: ~40% of the 1.10→1.09 buffer consumed (price 1.096)
  const w = classifyTradeHealth(mkPos({ currentPrice: 1.096 }), null);
  check("weakening at ~40% buffer consumed", w.state === "weakening");

  // danger: ~80% consumed (price 1.092)
  const d = classifyTradeHealth(mkPos({ currentPrice: 1.092 }), null);
  check("danger near stop", d.state === "danger");

  // invalidated overrides: price below the thesis invalidation
  const inv = classifyTradeHealth(mkPos({ currentPrice: 1.084 }), mkSignal());
  check("invalidated when thesis broken", inv.state === "invalidated");

  // no stop → falls back to floating P/L sign, honestly
  const noSlNeg = classifyTradeHealth(
    mkPos({ stopLoss: null, currentPrice: null, floatingPnl: -10 }),
    null,
  );
  check("no-stop negative P/L → weakening", noSlNeg.state === "weakening");
  check(
    "no-stop fallback says floating-only",
    noSlNeg.reasons.some((r) => /floating/i.test(r)),
  );
  collect(h.headline, w.headline, d.headline, inv.headline, noSlNeg.headline, ...noSlNeg.reasons);
}

// ── 2. TP progress / SL distance honesty ─────────────────────────────────────
{
  const tp = computeTpProgress(mkPos({ entryPrice: 1.1, currentPrice: 1.11, takeProfit: 1.12 }));
  check("tp progress 50% at halfway", tp.known && tp.progressPct === 50);

  const tpNoTp = computeTpProgress(mkPos({ takeProfit: null }));
  check("tp unknown when no target", !tpNoTp.known && tpNoTp.progressPct === null);

  const sl = computeSlDistance(mkPos({ entryPrice: 1.1, currentPrice: 1.095, stopLoss: 1.09 }));
  check("sl buffer 50% remaining at midpoint", sl.known && sl.bufferRemainingPct === 50);

  const slNoSl = computeSlDistance(mkPos({ stopLoss: null }));
  check("sl unknown when no stop", !slNoSl.known && slNoSl.distancePrice === null);
  collect(tp.note, tpNoTp.note, sl.note, slNoSl.note);
}

// ── 3. break-even / partial validity ─────────────────────────────────────────
{
  const tpHalf = computeTpProgress(mkPos({ currentPrice: 1.11 })); // 50%
  const be = deriveBreakEvenSuggestion(mkPos({ currentPrice: 1.11, floatingPnl: 10 }), tpHalf);
  check("break-even suggested when in profit & halfway", be.suggested);

  const beNo = deriveBreakEvenSuggestion(
    mkPos({ currentPrice: 1.095, floatingPnl: -5 }),
    computeTpProgress(mkPos({ currentPrice: 1.095 })),
  );
  check("break-even not suggested when not in profit", !beNo.suggested);

  const tp70 = computeTpProgress(mkPos({ currentPrice: 1.114 })); // 70%
  const pc = derivePartialCloseSuggestion(mkPos({ currentPrice: 1.114, floatingPnl: 14 }), tp70, "healthy");
  check("partial suggested when well into the move", pc.suggested);

  const pcNo = derivePartialCloseSuggestion(
    mkPos({ currentPrice: 1.101, floatingPnl: 1 }),
    computeTpProgress(mkPos({ currentPrice: 1.101 })),
    "healthy",
  );
  check("partial not suggested early", !pcNo.suggested);
  collect(be.note, beNo.note, pc.note, pcNo.note);
}

// ── 4. style matching ────────────────────────────────────────────────────────
{
  const scalp = matchTradeStyle(mkPos({ openedAtMs: NOW - 20 * 60 * 1000 }), NOW);
  check("scalp under 1h", scalp.detectedStyle === "scalp");
  const intraday = matchTradeStyle(mkPos({ openedAtMs: NOW - 5 * 60 * 60 * 1000 }), NOW);
  check("intraday within a day", intraday.detectedStyle === "intraday");
  const swing = matchTradeStyle(mkPos({ openedAtMs: NOW - 48 * 60 * 60 * 1000 }), NOW);
  check("swing beyond a day", swing.detectedStyle === "swing");
  const unknown = matchTradeStyle(mkPos({ openedAtMs: null }), NOW);
  check("unknown when no open time", unknown.detectedStyle === "unknown");
  collect(scalp.note, intraday.note, swing.note, unknown.note);
}

// ── 5. setup alternatives (only real zones) ──────────────────────────────────
{
  const all = buildSetupAlternatives(mkSignal());
  check("three alternatives from full signal", all.length === 3);
  const partial = buildSetupAlternatives(mkSignal({ retestZone: null, watchZone: null }));
  check("only aggressive when other zones missing", partial.length === 1 && partial[0]!.kind === "aggressive");
  check("no alternatives without a signal", buildSetupAlternatives(null).length === 0);
  for (const a of all) collect(a.label, a.note);
}

// ── 6. conflict detection ────────────────────────────────────────────────────
{
  const opposite = detectConflicts([
    mkPos({ ticket: "A", side: "BUY" }),
    mkPos({ ticket: "B", side: "SELL" }),
  ]);
  check("opposite exposure flagged", opposite.some((c) => c.kind === "opposite"));

  const dup = detectConflicts([
    mkPos({ ticket: "A", side: "BUY" }),
    mkPos({ ticket: "B", side: "BUY" }),
  ]);
  check("duplicate exposure flagged", dup.some((c) => c.kind === "duplicate"));

  const over = detectConflicts([
    mkPos({ ticket: "A", side: "BUY" }),
    mkPos({ ticket: "B", side: "BUY" }),
    mkPos({ ticket: "C", side: "BUY" }),
  ]);
  check("over-exposure flagged at 3+", over.some((c) => c.kind === "over_exposure"));

  check("no conflict on a single position", detectConflicts([mkPos()]).length === 0);
  for (const c of [...opposite, ...dup, ...over]) collect(c.note);
}

// ── 7. correlation ───────────────────────────────────────────────────────────
{
  const corr = detectCorrelation([
    mkPos({ ticket: "A", symbol: "EURUSD" }),
    mkPos({ ticket: "B", symbol: "GBPUSD" }),
  ]);
  check("USD cluster flagged", corr.some((c) => c.driver === "USD"));
  check("no correlation for one forex pair", detectCorrelation([mkPos({ symbol: "EURUSD" })]).length === 0);
  check(
    "synthetic/non-forex symbols are immune",
    detectCorrelation([mkPos({ symbol: "Volatility 75 Index" }), mkPos({ symbol: "XAUUSD" })]).every(
      (c) => !c.symbols.includes("VOLATILITY75INDEX"),
    ),
  );

  // risk_cluster: two longs that share NO currency leg but the same risk-on
  // posture (long AUDUSD + long NZDJPY) are connected risk.
  const riskOn = detectCorrelation([
    mkPos({ ticket: "C", symbol: "AUDUSD", side: "BUY" }),
    mkPos({ ticket: "D", symbol: "NZDJPY", side: "BUY" }),
  ]);
  check(
    "risk-on cluster flagged across different currencies",
    riskOn.some((c) => c.kind === "risk_cluster" && c.driver === "risk-on sentiment"),
  );
  check(
    "risk-cluster note carries no internal enum token",
    riskOn.filter((c) => c.kind === "risk_cluster").every((c) => !c.note.includes("risk_cluster")),
  );

  // Selling AUDUSD + buying USDCAD are both risk-OFF (short the risk leg).
  const riskOff = detectCorrelation([
    mkPos({ ticket: "E", symbol: "AUDUSD", side: "SELL" }),
    mkPos({ ticket: "F", symbol: "USDCAD", side: "BUY" }),
  ]);
  check(
    "risk-off cluster flagged",
    riskOff.some((c) => c.kind === "risk_cluster" && c.driver === "risk-off sentiment"),
  );

  // Opposing postures must NOT cluster (long AUDUSD risk-on vs long USDCAD risk-off).
  check(
    "opposing risk postures do not cluster",
    detectCorrelation([
      mkPos({ ticket: "G", symbol: "AUDUSD", side: "BUY" }),
      mkPos({ ticket: "H", symbol: "USDCAD", side: "BUY" }),
    ]).every((c) => c.kind !== "risk_cluster"),
  );

  // Two havens net-neutral (no posture) → never a risk cluster.
  check(
    "net-neutral haven pair carries no posture",
    detectCorrelation([
      mkPos({ ticket: "I", symbol: "USDJPY", side: "BUY" }),
      mkPos({ ticket: "J", symbol: "USDCHF", side: "BUY" }),
    ]).every((c) => c.kind !== "risk_cluster"),
  );

  for (const c of [...corr, ...riskOn, ...riskOff]) collect(c.note);
}

// ── 8. overtrading (real thresholds only) ────────────────────────────────────
{
  const allNull: OvertradingInput = {
    recentTradeCount: null,
    windowMinutes: null,
    recentLosses: null,
    lotVsBaseline: null,
    tradingThroughNews: null,
  };
  check("no warnings on all-null inputs", detectOvertrading(allNull).length === 0);

  const rapid = detectOvertrading({ ...allNull, recentTradeCount: 6, windowMinutes: 15 });
  check("rapid re-entry flagged", rapid.some((w) => w.kind === "rapid_reentry"));

  const revenge = detectOvertrading({ ...allNull, recentLosses: true, lotVsBaseline: 2 });
  check("revenge sizing flagged", revenge.some((w) => w.kind === "revenge_sizing"));

  const noRevenge = detectOvertrading({ ...allNull, recentLosses: false, lotVsBaseline: 2 });
  check("no revenge sizing without a recent loss", noRevenge.length === 0);

  const news = detectOvertrading({ ...allNull, tradingThroughNews: true });
  check("news trading flagged", news.some((w) => w.kind === "news_trading"));
  for (const w of [...rapid, ...revenge, ...news]) collect(w.note);
}

// ── 9. handshake states ──────────────────────────────────────────────────────
{
  const good = buildTradeHealthHandshake({ p: mkPos(), signal: mkSignal(), chartSymbol: "EURUSD" });
  check("handshake PASS when all good", good.overallStatus === "PASS");

  const mismatch = buildTradeHealthHandshake({ p: mkPos(), signal: mkSignal(), chartSymbol: "GBPUSD" });
  check("handshake WARN on symbol mismatch", mismatch.overallStatus === "WARN");

  const noPrice = buildTradeHealthHandshake({
    p: mkPos({ currentPrice: null, entryPrice: null }),
    signal: null,
    chartSymbol: "EURUSD",
  });
  check("handshake BLOCK with no sync/price", noPrice.overallStatus === "BLOCK");
  check(
    "fill not stored → NOT_AVAILABLE honest",
    buildTradeHealthHandshake({ p: mkPos({ fillRecorded: undefined }), signal: null, chartSymbol: null })
      .checks.some((c) => c.key === "fillSlippageStored" && c.status === "NOT_AVAILABLE"),
  );
  collect(good.userFacingMessage, mismatch.userFacingMessage, noPrice.userFacingMessage);
  for (const c of good.checks) collect(c.detail);
}

// ── 10. report composition + purity (no side effects) ────────────────────────
{
  const positions = [
    mkPos({ ticket: "A", symbol: "EURUSD", currentPrice: 1.105 }),
    mkPos({ ticket: "B", symbol: "GBPUSD", side: "SELL", entryPrice: 1.27, currentPrice: 1.268, stopLoss: 1.28, takeProfit: 1.25 }),
  ];
  const frozenSnapshot = JSON.stringify(positions);
  const report = buildTradeHealthReport({
    positions,
    signalsBySymbol: { EURUSD: mkSignal() },
    overtrading: {
      recentTradeCount: null,
      windowMinutes: null,
      recentLosses: null,
      lotVsBaseline: null,
      tradingThroughNews: null,
    },
    chartSymbol: "EURUSD",
    nowMs: NOW,
    evaluatedAtIso: "2026-06-05T12:00:00.000Z",
  });
  check("report assesses every position", report.assessments.length === 2);
  check("overlays only for the chart symbol", report.overlays.every((o) => o.id.startsWith("trade-health-") && o.group === "trade_health"));
  check("overlay anchored at entry", report.overlays.some((o) => o.price === 1.1));
  check("USD correlation surfaces in report", report.correlations.some((c) => c.driver === "USD"));
  check("inputs not mutated (pure)", JSON.stringify(positions) === frozenSnapshot);

  const empty = buildTradeHealthReport({
    positions: [],
    signalsBySymbol: {},
    overtrading: {
      recentTradeCount: null,
      windowMinutes: null,
      recentLosses: null,
      lotVsBaseline: null,
      tradingThroughNews: null,
    },
    chartSymbol: null,
    nowMs: NOW,
    evaluatedAtIso: "2026-06-05T12:00:00.000Z",
  });
  check("empty report has honest summary + no overlays", empty.overlays.length === 0 && /no open positions/i.test(empty.summary));

  collect(report.summary, empty.summary);
  for (const a of report.assessments) {
    collect(a.headline, a.tpProgress.note, a.slDistance.note, a.breakEven.note, a.partialClose.note, a.styleMatch.note, ...a.reasons);
    for (const o of report.overlays) collect(o.label);
  }
}

// ── 11. assessment overlay sanity via assessOpenPosition ─────────────────────
{
  const a = assessOpenPosition({ p: mkPos(), signal: mkSignal(), chartSymbol: "EURUSD", nowMs: NOW });
  check("assessment carries entry price", a.entryPrice === 1.1);
  check("alert true only when not healthy", a.alert === (a.state !== "healthy"));
  const layers = buildTradeHealthOverlayLayers([a], "EURUSD");
  check("overlay built for matching symbol", layers.length === 1);
  check("no overlay for a different symbol", buildTradeHealthOverlayLayers([a], "GBPUSD").length === 0);
}

// ── 11(b). no internal tokens in ANY user-facing copy ────────────────────────
for (const s of collectedCopy) {
  if (TOKEN_RE.test(s)) {
    check(`no internal token in "${s.slice(0, 60)}…"`, false);
  }
}
check(`scanned ${collectedCopy.length} copy strings for internal tokens`, collectedCopy.length > 0);

if (failures > 0) {
  console.error(`\n${failures} trade-health check(s) failed.`);
  process.exit(1);
}
console.log("\nAll trade-health engine checks passed.");

export {};
