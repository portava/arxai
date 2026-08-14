// Smart Chart Layers & News Radar (Task #197) — PURE builder unit tests.
//
// Verifies the honesty + consistency contracts of the smart-chart domain:
//  1. classifyNewsSeverity elevates a live/imminent high-impact event to CRITICAL.
//  2. mapEventSeverityToAlertPriority is a 1:1 ladder (CRITICAL bypass intact).
//  3. eventState maps signed countdowns to UPCOMING/IMMINENT/LIVE/RECENT.
//  4. eventAffectsSymbol matches currency-in-symbol + affected markets.
//  5. deriveNewsBehavior: NO_PROVIDER when disconnected; NEWS_LIVE / PRE_NEWS /
//     POST_NEWS / NORMAL for connected provider; only affecting events drive it.
//  6. buildSignalLayers draws Ruby geometry ONLY for the matching symbol; a
//     mismatched signal symbol yields no signal zones (structure still drawn).
//  7. buildTradeHealthSlots flags slots reserved + only for the symbol.
//  7b. buildExecutionCostLayers draws a LIVE (non-reserved) fill band + break-even
//      line from real numbers (BUY be>fill, SELL be<fill); honest-skip on nulls.
//  7c. escalateNewsRiskLevel raises scanner risk to the radar severity, never
//      lowers, and a null radar severity leaves the risk untouched.
//  8. buildOverlayHandshake: symbol-mismatch → WARN; chart-not-loaded → BLOCK;
//     all-good → PASS; freshness ages PASS→WARN→FAIL; unknowns NOT_AVAILABLE.
//  9. No internal UPPER_SNAKE enum token leaks into ANY user-facing string.
//
// Pure & deterministic (now/age passed in). No DB, no IO.
//
// Run: pnpm --filter @workspace/scripts run test:smart-chart-layers

import {
  buildExecutionCostLayers,
  buildOverlayHandshake,
  buildRadarEvents,
  buildSignalLayers,
  buildTradeHealthSlots,
  classifyNewsSeverity,
  deriveNewsBehavior,
  escalateNewsRiskLevel,
  eventAffectsSymbol,
  eventState,
  isWithinQuietHoursUtc,
  mapEventSeverityToAlertPriority,
  newsToastDecision,
  type NewsRadarEvent,
  type RawCalendarEvent,
  type SignalLayerInput,
  type StructureLevelInput,
} from "@workspace/domain/smart-chart";

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
function assertNoTokens(label: string, s: string) {
  check(`${label}: no internal token in "${s.slice(0, 60)}…"`, !TOKEN_RE.test(s));
}

function mkEvent(over: Partial<NewsRadarEvent> = {}): NewsRadarEvent {
  return {
    id: "e1",
    title: "US CPI YoY",
    currency: "USD",
    severity: "HIGH",
    eventTimeIso: "2026-06-05T12:30:00.000Z",
    countdownSeconds: 600,
    state: "IMMINENT",
    affectsSymbol: true,
    affectedSymbols: ["EURUSD", "USDJPY"],
    ...over,
  };
}

// 1. severity classification
check(
  "high+LIVE → CRITICAL",
  classifyNewsSeverity("high", "LIVE") === "CRITICAL",
);
check(
  "high+IMMINENT → CRITICAL",
  classifyNewsSeverity("high", "IMMINENT") === "CRITICAL",
);
check(
  "high+UPCOMING → HIGH",
  classifyNewsSeverity("high", "UPCOMING") === "HIGH",
);
check("medium → MEDIUM", classifyNewsSeverity("medium", "LIVE") === "MEDIUM");
check("low → LOW", classifyNewsSeverity("low", "LIVE") === "LOW");

// 2. severity → alert priority ladder is 1:1
check(
  "severity→priority 1:1",
  mapEventSeverityToAlertPriority("CRITICAL") === "CRITICAL" &&
    mapEventSeverityToAlertPriority("HIGH") === "HIGH" &&
    mapEventSeverityToAlertPriority("MEDIUM") === "MEDIUM" &&
    mapEventSeverityToAlertPriority("LOW") === "LOW",
);

// 3. event state from signed countdown
check("upcoming far → UPCOMING", eventState(3600) === "UPCOMING");
check("≤15m → IMMINENT", eventState(600) === "IMMINENT");
check("negative small → LIVE", eventState(-60) === "LIVE");
check("≤-30m → RECENT", eventState(-2400) === "RECENT");

// 4. symbol mapping
check("USD in EURUSD", eventAffectsSymbol("EURUSD", "USD", []));
check("currency miss, market hit", eventAffectsSymbol("US30", "USD", ["US30"]));
check("no match", !eventAffectsSymbol("AUDCAD", "JPY", ["USDJPY"]));

// 5. news behavior
const noProvider = deriveNewsBehavior(false, [mkEvent()]);
check("disconnected → NO_PROVIDER", noProvider.mode === "NO_PROVIDER");
assertNoTokens("NO_PROVIDER note", noProvider.note);

const live = deriveNewsBehavior(true, [
  mkEvent({ state: "LIVE", severity: "CRITICAL", affectsSymbol: true }),
]);
check("live high-impact → NEWS_LIVE", live.mode === "NEWS_LIVE");
assertNoTokens("NEWS_LIVE note", live.note);

const pre = deriveNewsBehavior(true, [
  mkEvent({ state: "IMMINENT", severity: "HIGH", affectsSymbol: true }),
]);
check("imminent high-impact → PRE_NEWS_CAUTION", pre.mode === "PRE_NEWS_CAUTION");

const post = deriveNewsBehavior(true, [
  mkEvent({
    state: "RECENT",
    severity: "HIGH",
    affectsSymbol: true,
    countdownSeconds: -600,
  }),
]);
check("recent high-impact → POST_NEWS", post.mode === "POST_NEWS");

const normalNonAffecting = deriveNewsBehavior(true, [
  mkEvent({ affectsSymbol: false, state: "LIVE", severity: "CRITICAL" }),
]);
check(
  "non-affecting events ignored → NORMAL",
  normalNonAffecting.mode === "NORMAL",
);

// 5b. buildRadarEvents — HONESTY GATE: events surface ONLY from a connected,
// real calendar provider. A disconnected calendar can NEVER emit events (and so
// can never raise an actionable Critical/High alert), even with raw events fed
// in. This is the guard against surfacing mock/synthetic events as real.
const rawCal: RawCalendarEvent[] = [
  {
    id: "cpi",
    title: "US CPI YoY",
    currency: "USD",
    impact: "high",
    eventTimeIso: new Date(Date.now() + 600_000).toISOString(),
    affectedMarkets: ["EURUSD", "USDJPY"],
  },
];
const disconnectedRadar = buildRadarEvents({
  calendarConnected: false,
  rawEvents: rawCal,
  symbol: "EURUSD",
  synthetic: false,
  nowMs: Date.now(),
});
check(
  "disconnected calendar → no events (no mock-as-real)",
  disconnectedRadar.length === 0,
);
const disconnectedBehavior = deriveNewsBehavior(false, disconnectedRadar);
check(
  "disconnected calendar → non-actionable NO_PROVIDER behavior",
  disconnectedBehavior.mode === "NO_PROVIDER",
);

const nowFixed = Date.parse("2026-06-05T12:20:00.000Z");
const connectedRadar = buildRadarEvents({
  calendarConnected: true,
  rawEvents: [
    {
      id: "cpi",
      title: "US CPI YoY",
      currency: "USD",
      impact: "high",
      eventTimeIso: "2026-06-05T12:30:00.000Z",
      affectedMarkets: ["EURUSD", "USDJPY"],
    },
  ],
  symbol: "EURUSD",
  synthetic: false,
  nowMs: nowFixed,
});
check(
  "connected calendar → maps real event onto symbol (CRITICAL, imminent, affects)",
  connectedRadar.length === 1 &&
    connectedRadar[0]!.affectsSymbol === true &&
    connectedRadar[0]!.severity === "CRITICAL" &&
    connectedRadar[0]!.state === "IMMINENT",
);
const syntheticRadar = buildRadarEvents({
  calendarConnected: true,
  rawEvents: [
    {
      id: "cpi",
      title: "US CPI YoY",
      currency: "USD",
      impact: "high",
      eventTimeIso: "2026-06-05T12:30:00.000Z",
      affectedMarkets: ["EURUSD"],
    },
  ],
  symbol: "Volatility 75 Index",
  synthetic: true,
  nowMs: nowFixed,
});
check(
  "synthetic instrument is immune → event present but does not affect symbol",
  syntheticRadar.length === 1 && syntheticRadar[0]!.affectsSymbol === false,
);

// 6. signal layers — symbol consistency
const sig: SignalLayerInput = {
  symbol: "EURUSD",
  hasSufficientData: true,
  entryZone: { from: 1.1, to: 1.101 },
  watchZone: { from: 1.102, to: 1.103 },
  retestZone: { from: 1.099, to: 1.0995 },
  doNotChaseZone: { from: 1.105, to: 1.106 },
  invalidationPrice: 1.098,
  stopLoss: 1.0975,
  takeProfitZones: [
    { from: 1.11, to: 1.111 },
    { from: 1.12, to: 1.121 },
  ],
};
const levels: StructureLevelInput[] = [
  { kind: "support", price: 1.0985, personality: "defended" },
  { kind: "resistance", price: 1.107, personality: "retest pending" },
];
const matched = buildSignalLayers(sig, levels, "EURUSD");
check(
  "matched: entry zone drawn",
  matched.some((l) => l.id === "signal-entry" && l.kind === "zone"),
);
check(
  "matched: SL + 2 TP drawn",
  matched.some((l) => l.id === "signal-sl") &&
    matched.filter((l) => l.group === "targets" && l.id.startsWith("signal-tp"))
      .length === 2,
);
check(
  "matched: structure levels drawn",
  matched.filter((l) => l.group === "structure").length === 2,
);
for (const l of matched) assertNoTokens(`layer label ${l.id}`, l.label);

const mismatched = buildSignalLayers(sig, levels, "GBPUSD");
check(
  "mismatch: no signal zones (consistency)",
  mismatched.every((l) => l.group !== "signal_zones" && l.group !== "targets"),
);
check(
  "mismatch: structure still drawn",
  mismatched.filter((l) => l.group === "structure").length === 2,
);

const blind = buildSignalLayers(null, levels, "EURUSD");
check("null signal: only structure", blind.every((l) => l.group === "structure"));

// 7. reserved trade-health slots — only for the symbol, all flagged reserved,
//    and ONLY in the trade_health group (execution-cost is now drawn live).
const reserved = buildTradeHealthSlots(
  [
    { ticket: "T1", symbol: "EURUSD", entryPrice: 1.1 },
    { ticket: "T2", symbol: "GBPUSD", entryPrice: 1.27 },
  ],
  "EURUSD",
);
check(
  "trade-health: only EURUSD slot, flagged reserved",
  reserved.length === 1 && reserved.every((l) => l.reserved === true),
);
check(
  "trade-health: only trade_health group (no reserved exec-cost)",
  reserved.every((l) => l.group === "trade_health"),
);
for (const l of reserved) assertNoTokens(`trade-health label ${l.id}`, l.label);

// 7b. execution-cost overlay — LIVE (non-reserved), real numbers only.
// BUY: break-even sits ABOVE the fill (price must rise to cover cost).
const execBuy = buildExecutionCostLayers({
  side: "BUY",
  expectedFill: 1.1,
  fillLow: 1.0999,
  fillHigh: 1.1002,
  breakEvenPoints: 20,
  pointSize: 0.0001,
});
const buyBand = execBuy.find((l) => l.id === "exec-cost-fill-band");
const buyBe = execBuy.find((l) => l.id === "exec-cost-break-even");
check(
  "exec-cost BUY: fill band drawn live (non-reserved zone)",
  !!buyBand &&
    buyBand.kind === "zone" &&
    buyBand.group === "execution_cost" &&
    buyBand.reserved !== true &&
    buyBand.priceFrom === 1.0999 &&
    buyBand.priceTo === 1.1002,
);
check(
  "exec-cost BUY: break-even line ABOVE fill",
  !!buyBe && buyBe.kind === "line" && buyBe.price! > 1.1,
);
for (const l of execBuy) assertNoTokens(`exec-cost BUY label ${l.id}`, l.label);

// SELL: break-even sits BELOW the fill.
const execSell = buildExecutionCostLayers({
  side: "SELL",
  expectedFill: 1.1,
  fillLow: 1.0998,
  fillHigh: 1.1001,
  breakEvenPoints: 20,
  pointSize: 0.0001,
});
const sellBe = execSell.find((l) => l.id === "exec-cost-break-even");
check(
  "exec-cost SELL: break-even line BELOW fill",
  !!sellBe && sellBe.price! < 1.1,
);

// Honest-skip: null/invalid numbers emit NO fabricated layer.
const execEmpty = buildExecutionCostLayers({
  side: "BUY",
  expectedFill: null,
  fillLow: null,
  fillHigh: null,
  breakEvenPoints: null,
  pointSize: null,
});
check("exec-cost: all-null inputs → no layers (honest-skip)", execEmpty.length === 0);
const execNoBe = buildExecutionCostLayers({
  side: "BUY",
  expectedFill: 1.1,
  fillLow: 1.0999,
  fillHigh: 1.1002,
  breakEvenPoints: null,
  pointSize: 0.0001,
});
check(
  "exec-cost: missing break-even points → band only, no fabricated line",
  execNoBe.length === 1 && execNoBe[0]!.id === "exec-cost-fill-band",
);

// 7c. escalateNewsRiskLevel — radar reflection is escalate-only + honest null.
check(
  "escalate: CRITICAL radar raises a 'low' scanner risk",
  escalateNewsRiskLevel("low", "CRITICAL") === "critical",
);
check(
  "escalate: lower radar severity NEVER downgrades a higher scanner risk",
  escalateNewsRiskLevel("high", "LOW") === "high",
);
check(
  "escalate: null radar severity leaves scanner risk untouched",
  escalateNewsRiskLevel("medium", null) === "medium",
);
check(
  "escalate: equal severity is a no-op",
  escalateNewsRiskLevel("high", "HIGH") === "high",
);

// 8. overlay handshake states
const good = buildOverlayHandshake({
  chartLoaded: true,
  chartSymbol: "EURUSD",
  signalSymbol: "EURUSD",
  signalExists: true,
  hasSufficientData: true,
  levelCount: 3,
  newsMapped: true,
  overlayAgeMs: 1000,
});
check("handshake good → PASS", good.overallStatus === "PASS");
assertNoTokens("handshake message", good.userFacingMessage);

const mismatch = buildOverlayHandshake({
  chartLoaded: true,
  chartSymbol: "EURUSD",
  signalSymbol: "GBPUSD",
  signalExists: true,
  hasSufficientData: true,
  levelCount: 3,
  newsMapped: true,
  overlayAgeMs: 1000,
});
check(
  "handshake symbol mismatch → WARN",
  mismatch.overallStatus === "WARN" &&
    mismatch.checks.some(
      (c) => c.key === "symbolMatch" && c.status === "WARN",
    ),
);

const notLoaded = buildOverlayHandshake({
  chartLoaded: false,
  chartSymbol: null,
  signalSymbol: null,
  signalExists: false,
  hasSufficientData: false,
  levelCount: 0,
  newsMapped: false,
  overlayAgeMs: null,
});
check("handshake chart-not-loaded → BLOCK", notLoaded.overallStatus === "BLOCK");
check(
  "handshake unknowns → NOT_AVAILABLE",
  notLoaded.checks.some(
    (c) => c.key === "symbolMatch" && c.status === "NOT_AVAILABLE",
  ) &&
    notLoaded.checks.some(
      (c) => c.key === "freshness" && c.status === "NOT_AVAILABLE",
    ),
);

const stale = buildOverlayHandshake({
  chartLoaded: true,
  chartSymbol: "EURUSD",
  signalSymbol: "EURUSD",
  signalExists: true,
  hasSufficientData: true,
  levelCount: 3,
  newsMapped: true,
  overlayAgeMs: 10 * 60 * 1000,
});
check(
  "handshake stale freshness → FAIL check",
  stale.checks.some((c) => c.key === "freshness" && c.status === "FAIL"),
);
for (const c of [...good.checks, ...mismatch.checks, ...notLoaded.checks]) {
  assertNoTokens(`check detail ${c.key}`, c.detail);
}

// 10. isWithinQuietHoursUtc — wrap-around, unset bounds, empty window.
check("quiet hours: unset bounds → false", !isWithinQuietHoursUtc(null, 6, 3));
check("quiet hours: start===end → empty window", !isWithinQuietHoursUtc(8, 8, 8));
check("quiet hours: same-day window inside", isWithinQuietHoursUtc(9, 17, 12));
check("quiet hours: same-day window outside", !isWithinQuietHoursUtc(9, 17, 20));
check("quiet hours: same-day end is exclusive", !isWithinQuietHoursUtc(9, 17, 17));
check("quiet hours: wrap-around before midnight", isWithinQuietHoursUtc(22, 6, 23));
check("quiet hours: wrap-around after midnight", isWithinQuietHoursUtc(22, 6, 3));
check("quiet hours: wrap-around daytime outside", !isWithinQuietHoursUtc(22, 6, 12));

// 11. newsToastDecision — preference-aware alert routing (mirrors Alert prefs).
//   CRITICAL can never be silenced; HIGH gated on prefs LOADED + market on +
//   not quiet; MEDIUM/LOW + non-affecting + non-imminent never interrupt.
const liveAffecting = {
  state: "LIVE" as const,
  affectsSymbol: true,
};
check(
  "toast: CRITICAL interrupts even when prefs off + quiet + not loaded",
  newsToastDecision({
    severity: "CRITICAL",
    ...liveAffecting,
    prefsLoaded: false,
    marketAlertsEnabled: false,
    quietHoursActive: true,
  }) === true,
);
check(
  "toast: HIGH suppressed until prefs loaded (load race)",
  newsToastDecision({
    severity: "HIGH",
    ...liveAffecting,
    prefsLoaded: false,
    marketAlertsEnabled: true,
    quietHoursActive: false,
  }) === false,
);
check(
  "toast: HIGH suppressed when market alerts disabled",
  newsToastDecision({
    severity: "HIGH",
    ...liveAffecting,
    prefsLoaded: true,
    marketAlertsEnabled: false,
    quietHoursActive: false,
  }) === false,
);
check(
  "toast: HIGH suppressed during quiet hours",
  newsToastDecision({
    severity: "HIGH",
    ...liveAffecting,
    prefsLoaded: true,
    marketAlertsEnabled: true,
    quietHoursActive: true,
  }) === false,
);
check(
  "toast: HIGH fires when loaded + enabled + not quiet",
  newsToastDecision({
    severity: "HIGH",
    ...liveAffecting,
    prefsLoaded: true,
    marketAlertsEnabled: true,
    quietHoursActive: false,
  }) === true,
);
check(
  "toast: MEDIUM never interrupts",
  newsToastDecision({
    severity: "MEDIUM",
    ...liveAffecting,
    prefsLoaded: true,
    marketAlertsEnabled: true,
    quietHoursActive: false,
  }) === false,
);
check(
  "toast: non-affecting event never interrupts",
  newsToastDecision({
    severity: "CRITICAL",
    state: "LIVE",
    affectsSymbol: false,
    prefsLoaded: true,
    marketAlertsEnabled: true,
    quietHoursActive: false,
  }) === false,
);
check(
  "toast: non-imminent CRITICAL does not interrupt",
  newsToastDecision({
    severity: "CRITICAL",
    state: "UPCOMING",
    affectsSymbol: true,
    prefsLoaded: true,
    marketAlertsEnabled: true,
    quietHoursActive: false,
  }) === false,
);

if (failures > 0) {
  console.error(`\nsmart-chart-layers: ${failures} FAILED`);
  process.exit(1);
} else {
  console.log("\nsmart-chart-layers: all checks passed");
}

export {};
