// Offline, single-process comparative probe. Run each checkout in a fresh Node
// process with the SAME script and stripped environment; no provider or DB I/O.
import { mock } from "node:test";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = resolve(process.argv[2] ?? process.cwd());
const url = (path) => pathToFileURL(resolve(root, path)).href;
const api = "artifacts/api-server/src/";
const routerUrl = url(api + "lib/data/marketDataRouter.ts");
const router = await import(routerUrl);
const now = Date.now(), interval = 900_000, end = Math.floor(now / interval) * interval;
const provenance = { providerId: "mt5_broker", subProviderId: null, brokerCode: "mt5", source: "DERIVED", sourceId: "mt5_broker:EURUSD:M15", bridgeConnectionId: null, userId: null, brokerSymbol: null, environment: "unknown", receivedAt: new Date(now).toISOString(), delayed: false };
const bars = Array.from({ length: 200 }, (_, i) => { const open = 1.09 + i * 0.00004; return { time: new Date(end - (200 - i) * interval).toISOString(), open, high: open + 0.0008, low: open - 0.0004, close: open + 0.0002, volume: 100 }; });
const routed = { ok: true, symbol: "EURUSD", assetClass: "forex", candles: bars, primaryProvider: "mt5_broker", provenance, attempts: [], userMessage: "", adminDetail: "" };
const quote = { ok: true, symbol: "EURUSD", assetClass: "forex", quote: { symbol: "EURUSD", bid: 1.0979, ask: 1.0981, spread: 0.0002, last: 1.098, timestamp: new Date(now).toISOString() }, primaryProvider: "mt5_broker", provenance: { ...provenance, source: "LIVE_TICK", sourceId: "mt5_broker:EURUSD" }, attempts: [], userMessage: "", adminDetail: "" };
mock.module(routerUrl, { namedExports: { ...router, routeCandles: async () => routed, routeQuote: async () => quote } });
const sessionUrl = url(api + "lib/data/chart/sessionProfile.ts");
const session = await import(sessionUrl);
mock.module(sessionUrl, { namedExports: { ...session, getSessionProfile: async () => null } });
const { scannerSourceIdentity } = await import(url(api + "lib/scannerInputIntegrity.ts"));
const evidence = { symbol: "EURUSD", timeframe: "M15", source: "mt5_broker", sourceIdentity: scannerSourceIdentity(routed), lastClosedCandleAt: new Date(end).toISOString() };
const { buildRubyMarketEdge } = await import(url("lib/domain/src/signal-intelligence/index.ts"));
const { computeTimingRead } = await import(url(api + "brain/timing/marketTimingBrainService.ts"));
const { buildSymbolTruthSnapshot } = await import(url(api + "lib/truth/symbolTruthSnapshot.ts"));
const { getChartCandles } = await import(url(api + "lib/data/chart/chartDataService.ts"));
const absent = async () => { throw new Error("offline unavailable"); };
const input = { symbol: "EURUSD", displayName: "EURUSD", timeframe: "M15", assetClass: "forex", candles: bars, currentPrice: 1.098, dataSource: "LIVE_FEED", scanner: { bias: "bullish", recommendedAction: "BUY", confidenceScore: 85, entrySniperScore: 85, riskRewardRatio: 2, setupType: "Trend", entry: 1.098, entryZone: { from: 1.0978, to: 1.0982 }, stopLoss: 1.097, takeProfit: 1.1, reasonForTrade: "", reasonToAvoid: "" }, scalp: null, execution: null, newsRiskLevel: null, previous: null, now };
const news = { phase: "NONE", eventName: null, minutesUntil: null, minutesSince: null, eventType: "none", surpriseScore: null, heatAdjustment: 0, blocksTrade: false };
const broad = { verdict: "UNAVAILABLE", institutionalFlowScore: 50, competingCatalyst: false, description: "", correlatedAssets: [], dataQuality: "unavailable" };
const timingDeps = { routeCandlesFn: async () => routed, routeQuoteFn: async () => quote, computeNewsHeatFn: async () => news, computeBroadFlowFn: async () => broad };
const signal = () => ({ ...buildRubyMarketEdge(input), marketEvidence: { ...evidence, userId: 1 } });
const deps = { getChartCandlesFn: getChartCandles, buildNewsFn: absent, evaluateScalpFn: absent, buildScannerFn: async () => signal(), computeTimingFn: (req) => computeTimingRead(req, timingDeps) };
const run = () => buildSymbolTruthSnapshot("EURUSD", "M15", 1, deps);
const old = new Date(now - 86_400_000).toISOString();
const expired = { ...buildRubyMarketEdge({ ...input, previous: { ...signal(), generatedAt: old, firstSeenAt: old, overallScore: 80 } }), marketEvidence: { ...evidence, userId: 1 } };
const expiredSnap = await buildSymbolTruthSnapshot("EURUSD", "M15", 1, { ...deps, buildScannerFn: async () => expired, computeTimingFn: absent });
const staleBars = { ...routed, primaryProvider: "assistant_real:twelve_data", provenance: { ...provenance, providerId: "assistant_real", subProviderId: "twelve_data", brokerCode: "third_party", sourceId: "assistant_real:twelve_data:EURUSD:M15" }, candles: bars.map(c => ({ ...c, time: new Date(Date.parse(c.time) + interval - 86_400_000).toISOString() })) };
const staleQuote = { ...quote, primaryProvider: "assistant_real:twelve_data", provenance: { ...quote.provenance, providerId: "assistant_real", subProviderId: "twelve_data", source: "STALE", sourceId: "assistant_real:twelve_data:EURUSD" }, quote: { ...quote.quote, timestamp: old } };
const staleTiming = await computeTimingRead({ symbol: "EURUSD", timeframe: "M15", persistSnapshot: false }, { ...timingDeps, routeCandlesFn: async () => staleBars, routeQuoteFn: async () => staleQuote });
const staleSnap = await buildSymbolTruthSnapshot("EURUSD", "M15", 1, { ...deps, buildScannerFn: absent, computeTimingFn: async () => staleTiming });
const currentTiming = await computeTimingRead({ symbol: "EURUSD", timeframe: "M15", persistSnapshot: false }, timingDeps);
const noGeometry = await buildSymbolTruthSnapshot("EURUSD", "M15", 1, { ...deps, buildScannerFn: absent, computeTimingFn: async () => currentTiming });
for (let i = 0; i < 200; i++) await run();
const ack = [], complete = [];
for (let i = 0; i < 2000; i++) { const start = performance.now(); const pending = run(); ack.push(performance.now() - start); await pending; complete.push(performance.now() - start); }
function stats(samples) { samples.sort((a,b) => a-b); return { median: samples[Math.ceil(samples.length * .5) - 1], p95: samples[Math.ceil(samples.length * .95) - 1], p99: samples[Math.ceil(samples.length * .99) - 1] }; }
console.log(JSON.stringify({ root, runtime: process.version, fixture: "200 actual routed OHLC bars; production chart, timing, Ruby domain and Truth composers; offline provider/session/news/account stand-ins", count: complete.length, warmup: 200, milliseconds: { invocationReturn: stats(ack), completedSnapshot: stats(complete) }, probes: { expired: { lifecycle: expired.lifecycleStage, present: expiredSnap.components.scanner.present, action: expiredSnap.verdict.bestAction }, staleTiming: { dataQuality: staleTiming.dataQuality.label, present: staleSnap.components.timing.present, action: staleSnap.verdict.bestAction }, noGeometry: { action: noGeometry.verdict.bestAction, withheld: noGeometry.levels.withheld } }, limits: "Processing cost only, no network/DB/browser/broker timing. Invocation return is not a rendered user acknowledgement; completion awaits all local composers. No competitor benchmark." }));
process.exit(0);
