// Market Data Provider Layer + Quote/Candle wrappers + Session Clock +
// News Risk Filter + Spread/Volatility Monitors + Market Health + Risk
// Governor adapter.
//
// SAFETY:
// - Wraps the SIMULATOR only. No real-broker data, no MT5 bridge calls.
// - Every quote/candle response is tagged with provider + isExecutable=false.
// - News-risk store is in-memory (no DB push), append + soft-edit + delete by id.
// - Risk governor adapter NEVER places orders; it only returns approve/block.

import { marketSimulator } from "./marketSimulator.js";

export type Provider = "SIMULATOR" | "MT5_BRIDGE" | "EXTERNAL" | "CHART_ONLY";
export type Environment = "SIMULATOR" | "DEMO" | "LIVE" | "UNKNOWN";

export const ACTIVE_PROVIDER: Provider = "SIMULATOR";
export const MT5_BRIDGE_CONNECTED = false;

const STALE_QUOTE_MS = 60_000;
const STALE_CANDLE_MS = 5 * 60_000;

// ── Quote envelope ─────────────────────────────────────────────────────────
export interface QuoteEnvelope {
  symbol: string;
  provider: Provider;
  bid: number; ask: number; mid: number; spread: number;
  timestamp: string;
  isLive: boolean;
  isExecutable: boolean;
  environment: Environment;
  ageMs: number;
  isStale: boolean;
  notice: string;
}

export function getQuote(symbol: string): QuoteEnvelope {
  const q = marketSimulator.quote(symbol);
  const ts = new Date().toISOString();
  return {
    symbol, provider: "SIMULATOR",
    bid: q?.bid ?? 0, ask: q?.ask ?? 0, mid: q?.mid ?? 0, spread: q?.spread ?? 0,
    timestamp: ts, isLive: false, isExecutable: false,
    environment: "SIMULATOR",
    ageMs: 0, isStale: !q,
    notice: "Using simulator quote data. MT5 bridge deferred — quotes are not broker-executable.",
  };
}

export function getQuotes(symbols: string[]): QuoteEnvelope[] {
  return symbols.map((s) => getQuote(s));
}

export function dataSource() {
  return {
    activeProvider: ACTIVE_PROVIDER,
    available: {
      SIMULATOR: true,
      CHART_ONLY: true, // TradingView chart embed is chart-only, not executable
      MT5_BRIDGE: MT5_BRIDGE_CONNECTED,
      EXTERNAL: false,
    },
    isExecutable: false,
    environment: "SIMULATOR" as Environment,
    notice: "Active provider: SIMULATOR. Chart embed is visualization only. MT5 bridge deferred.",
  };
}

// ── Candle envelope ────────────────────────────────────────────────────────
export interface CandleEnvelope {
  symbol: string; timeframe: string; provider: Provider;
  candles: Array<{ time: string; open: number; high: number; low: number; close: number; volume: number }>;
  lastCandleTs: string | null;
  ageMs: number;
  isStale: boolean;
  isExecutable: boolean;
}

export function getCandles(symbol: string, timeframe = "M15", limit = 100): CandleEnvelope {
  const raw = marketSimulator.candlesFor(symbol, limit);
  const candles = raw.map((c) => ({
    time: c.tsIso, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v,
  }));
  const last = candles[candles.length - 1] ?? null;
  const ageMs = last ? Date.now() - Date.parse(last.time) : 0;
  return {
    symbol, timeframe, provider: "SIMULATOR", candles,
    lastCandleTs: last?.time ?? null,
    ageMs, isStale: ageMs > STALE_CANDLE_MS,
    isExecutable: false,
  };
}

// ── Market session clock ───────────────────────────────────────────────────
type SessionId = "Sydney" | "Tokyo" | "London" | "NewYork";
export interface SessionWindow { id: SessionId; openUTC: number; closeUTC: number; }

const SESSIONS: SessionWindow[] = [
  { id: "Sydney",  openUTC: 22, closeUTC: 7 },   // 22:00 → 07:00 UTC (wraps)
  { id: "Tokyo",   openUTC: 0,  closeUTC: 9 },
  { id: "London",  openUTC: 7,  closeUTC: 16 },
  { id: "NewYork", openUTC: 13, closeUTC: 22 },
];

function inSessionHour(s: SessionWindow, hour: number): boolean {
  if (s.openUTC < s.closeUTC) return hour >= s.openUTC && hour < s.closeUTC;
  return hour >= s.openUTC || hour < s.closeUTC; // wraps midnight
}
function nextHourFor(target: number, fromHour: number): number {
  return target > fromHour ? target - fromHour : 24 - fromHour + target;
}

// ── Trading week ───────────────────────────────────────────────────────────
// The session windows above are hour-of-day only. Without a day-of-week gate
// the clock reported London and New York OPEN on a Saturday, with an
// ACTIVE/HIGH_VOLATILITY badge and "Good window for trend strategies" — while
// FX and equity markets were shut. A trader waiting for the recommended window
// was pointed at a closed market.
//
// FX week (UTC): opens Sunday 21:00, closes Friday 21:00.
const FX_WEEK_OPEN_DAY = 0;   // Sunday
const FX_WEEK_OPEN_HOUR = 21;
const FX_WEEK_CLOSE_DAY = 5;  // Friday
const FX_WEEK_CLOSE_HOUR = 21;

/** True when the FX trading week is open at `now` (UTC). */
export function isTradingWeekOpen(now: Date): boolean {
  const day = now.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const hour = now.getUTCHours();
  if (day === 6) return false;                                  // Saturday
  if (day === FX_WEEK_OPEN_DAY) return hour >= FX_WEEK_OPEN_HOUR; // Sunday
  if (day === FX_WEEK_CLOSE_DAY) return hour < FX_WEEK_CLOSE_HOUR; // Friday
  return true;                                                   // Mon–Thu
}

/** Whole hours until the FX week reopens; 0 when it is already open. */
export function hoursUntilTradingWeekOpen(now: Date): number {
  if (isTradingWeekOpen(now)) return 0;
  const open = new Date(now);
  open.setUTCHours(FX_WEEK_OPEN_HOUR, 0, 0, 0);
  // Advance to the next Sunday 21:00 UTC at or after `now`.
  while (open.getUTCDay() !== FX_WEEK_OPEN_DAY || open.getTime() <= now.getTime()) {
    open.setUTCDate(open.getUTCDate() + 1);
    open.setUTCHours(FX_WEEK_OPEN_HOUR, 0, 0, 0);
  }
  return Math.ceil((open.getTime() - now.getTime()) / 3_600_000);
}

/** A session is only active if the trading WEEK is open as well as the hour. */
export function inSession(s: SessionWindow, now: Date): boolean {
  return isTradingWeekOpen(now) && inSessionHour(s, now.getUTCHours());
}

export type SessionLabel =
  | "QUIET" | "NORMAL" | "ACTIVE" | "HIGH_VOLATILITY" | "AVOID"
  /** The trading week itself is closed — no session can be active. */
  | "MARKET_CLOSED";

export function sessionClock(now: Date = new Date()) {
  const hour = now.getUTCHours();
  const weekOpen = isTradingWeekOpen(now);
  const weekOpensInHours = weekOpen ? null : hoursUntilTradingWeekOpen(now);

  const active = weekOpen ? SESSIONS.filter((s) => inSessionHour(s, hour)) : [];
  const overlap = active.length >= 2;
  const londonNY = active.some((s) => s.id === "London") && active.some((s) => s.id === "NewYork");
  let label: SessionLabel = "QUIET";
  if (!weekOpen) label = "MARKET_CLOSED";
  else if (londonNY) label = "HIGH_VOLATILITY";
  else if (overlap) label = "ACTIVE";
  else if (active.length === 1) label = "NORMAL";

  // next open/close for each session
  const upcoming = SESSIONS.map((s) => ({
    id: s.id,
    isActive: weekOpen && inSessionHour(s, hour),
    // While the week is closed no session opens at its usual hour-of-day, so
    // the honest answer is "when the week reopens", not a hour-of-day delta.
    nextOpenInHours: weekOpen ? nextHourFor(s.openUTC, hour) : weekOpensInHours,
    nextCloseInHours: weekOpen ? nextHourFor(s.closeUTC, hour) : null,
  }));

  const recommendation = !weekOpen
    ? `Markets are closed for the weekend. Spot FX and equities reopen in about ${weekOpensInHours}h (Sunday 21:00 UTC). No session read applies until then.`
    : label === "HIGH_VOLATILITY"
    ? "Be cautious — heightened volatility around London/NY overlap. Tighten stops."
    : label === "ACTIVE" ? "Good window for trend strategies."
    : label === "NORMAL" ? "Normal liquidity for the active session."
    : "Liquidity is thin — many strategies should stand down.";

  return {
    nowUTC: now.toISOString(),
    activeSessions: active.map((a) => a.id),
    overlap,
    sessionLabel: label,
    marketOpen: weekOpen,
    weekOpensInHours,
    sessions: upcoming,
    recommendation,
    // This clock is the real system UTC clock — it is NOT simulator output.
    // (`ACTIVE_PROVIDER` describes the quote/candle feed, not the calendar.)
    dataSource: "SYSTEM_CLOCK_UTC" as const,
  };
}

export function sessionsList() {
  return {
    sessions: SESSIONS.map((s) => ({ id: s.id, openUTC: s.openUTC, closeUTC: s.closeUTC })),
    clock: sessionClock(),
  };
}

// ── News risk store (in-memory) ────────────────────────────────────────────
export interface NewsEvent {
  id: number;
  eventName: string;
  currency: string;
  impact: "low" | "medium" | "high";
  eventTime: string; // ISO
  affectedSymbols: string[];
  avoidBeforeMinutes: number;
  avoidAfterMinutes: number;
  notes?: string;
  source: "MANUAL" | "SIMULATED" | "EXTERNAL";
  createdAt: string;
}

const newsEvents = new Map<number, NewsEvent>();
let newsSeq = 1;

// Seed with a couple of simulated events so the UI has something to show.
function seedNews() {
  if (newsEvents.size > 0) return;
  const now = Date.now();
  const e1: NewsEvent = {
    id: newsSeq++, eventName: "FOMC Statement", currency: "USD", impact: "high",
    eventTime: new Date(now + 90 * 60_000).toISOString(),
    affectedSymbols: ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"],
    avoidBeforeMinutes: 30, avoidAfterMinutes: 60,
    notes: "Simulated event for tester.", source: "SIMULATED",
    createdAt: new Date().toISOString(),
  };
  const e2: NewsEvent = {
    id: newsSeq++, eventName: "Non-Farm Payrolls (placeholder)", currency: "USD", impact: "high",
    eventTime: new Date(now + 6 * 3600_000).toISOString(),
    affectedSymbols: ["EURUSD", "USDJPY", "XAUUSD"],
    avoidBeforeMinutes: 30, avoidAfterMinutes: 30,
    notes: "Placeholder until external calendar provider is connected.", source: "SIMULATED",
    createdAt: new Date().toISOString(),
  };
  newsEvents.set(e1.id, e1);
  newsEvents.set(e2.id, e2);
}
seedNews();

// Sweep stale news events every 30 minutes (event time older than 48h).
setInterval(() => {
  const cutoff = Date.now() - 48 * 3600_000;
  for (const [id, e] of newsEvents) {
    if (Date.parse(e.eventTime) < cutoff) newsEvents.delete(id);
  }
}, 30 * 60_000).unref?.();

export function listNewsEvents(): NewsEvent[] {
  return Array.from(newsEvents.values()).sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime));
}

export function addNewsEvent(input: Omit<NewsEvent, "id" | "createdAt" | "source"> & { source?: NewsEvent["source"] }): NewsEvent {
  const e: NewsEvent = {
    ...input, id: newsSeq++,
    source: input.source ?? "MANUAL",
    createdAt: new Date().toISOString(),
  };
  newsEvents.set(e.id, e);
  return e;
}

export function patchNewsEvent(id: number, patch: Partial<NewsEvent>): NewsEvent | null {
  const cur = newsEvents.get(id);
  if (!cur) return null;
  const upd = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt };
  newsEvents.set(id, upd);
  return upd;
}
export function deleteNewsEvent(id: number) { return newsEvents.delete(id); }

export function currentNewsRisk(symbol?: string) {
  const now = Date.now();
  const active: Array<{ event: NewsEvent; minutesUntil: number; minutesSince: number; inWindow: boolean }> = [];
  for (const e of newsEvents.values()) {
    if (symbol && !e.affectedSymbols.includes(symbol)) continue;
    const t = Date.parse(e.eventTime);
    const minutesUntil = (t - now) / 60_000;
    const minutesSince = (now - t) / 60_000;
    const inWindow = (minutesUntil >= 0 && minutesUntil <= e.avoidBeforeMinutes)
      || (minutesSince >= 0 && minutesSince <= e.avoidAfterMinutes);
    if (inWindow || (minutesUntil > 0 && minutesUntil < 240)) {
      active.push({ event: e, minutesUntil, minutesSince, inWindow });
    }
  }
  active.sort((a, b) => Math.abs(a.minutesUntil) - Math.abs(b.minutesUntil));
  const blocking = active.find((a) => a.inWindow && a.event.impact === "high");
  return {
    symbol: symbol ?? null,
    blocking: !!blocking,
    blockReason: blocking ? `Within news avoid window: ${blocking.event.eventName}` : null,
    events: active.slice(0, 10),
    dataSource: "SIMULATOR",
  };
}

// ── Spread + volatility monitors ───────────────────────────────────────────
export function spreadMonitor(symbol = "EURUSD") {
  const q = marketSimulator.quote(symbol);
  if (!q) return { symbol, spread: 0, mid: 0, spreadBps: 0, label: "SPREAD_TOO_HIGH" as const, dataSource: ACTIVE_PROVIDER };
  const acceptable = q.spread / q.mid < 0.0008;
  return {
    symbol, spread: q.spread, mid: q.mid,
    spreadBps: Number(((q.spread / q.mid) * 10_000).toFixed(2)),
    label: acceptable ? "SPREAD_ACCEPTABLE" as const : "SPREAD_TOO_HIGH" as const,
    dataSource: ACTIVE_PROVIDER,
  };
}

export function volatilityMonitor(symbol = "EURUSD", timeframe = "M15") {
  const candles = marketSimulator.candlesFor(symbol, 30);
  if (candles.length === 0) return { symbol, timeframe, atr: 0, label: "LOW_LIQUIDITY" as const, dataSource: ACTIVE_PROVIDER };
  const ranges = candles.map((c) => c.h - c.l);
  const avg = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const lastRange = ranges[ranges.length - 1] ?? 0;
  const ratio = avg > 0 ? lastRange / avg : 1;
  let label: "QUIET" | "NORMAL" | "ELEVATED" | "HIGH_VOLATILITY";
  if (ratio < 0.6) label = "QUIET";
  else if (ratio < 1.2) label = "NORMAL";
  else if (ratio < 1.8) label = "ELEVATED";
  else label = "HIGH_VOLATILITY";
  return {
    symbol, timeframe,
    atr: Number(avg.toFixed(5)),
    lastRange: Number(lastRange.toFixed(5)),
    ratio: Number(ratio.toFixed(2)),
    label, dataSource: ACTIVE_PROVIDER,
  };
}

// ── Market health (composite) ──────────────────────────────────────────────
export type HealthLabel =
  | "TRADEABLE" | "CAUTION" | "HIGH_SPREAD" | "HIGH_VOLATILITY"
  | "LOW_LIQUIDITY" | "NEWS_RISK" | "DATA_STALE" | "MT5_DEFERRED";

export function marketHealth(symbol = "EURUSD", timeframe = "M15") {
  const quote = getQuote(symbol);
  const spread = spreadMonitor(symbol);
  const vol = volatilityMonitor(symbol, timeframe);
  const session = sessionClock();
  const news = currentNewsRisk(symbol);

  const labels: HealthLabel[] = [];
  if (quote.isStale) labels.push("DATA_STALE");
  if (spread.label === "SPREAD_TOO_HIGH") labels.push("HIGH_SPREAD");
  if (vol.label === "HIGH_VOLATILITY") labels.push("HIGH_VOLATILITY");
  if (vol.label === "QUIET" || session.sessionLabel === "QUIET") labels.push("LOW_LIQUIDITY");
  if (news.blocking) labels.push("NEWS_RISK");
  if (!MT5_BRIDGE_CONNECTED) labels.push("MT5_DEFERRED");
  if (labels.length === 0 || (labels.length === 1 && labels[0] === "MT5_DEFERRED")) labels.unshift("TRADEABLE");
  else if (!labels.includes("DATA_STALE") && !news.blocking) labels.unshift("CAUTION");

  return {
    symbol, timeframe, labels,
    quote, spread, volatility: vol, session, news,
    dataSource: ACTIVE_PROVIDER,
    mt5BridgeConnected: MT5_BRIDGE_CONNECTED,
  };
}

// ── Data quality panel ─────────────────────────────────────────────────────
export function dataQuality(symbol = "EURUSD", timeframe = "M15") {
  const q = getQuote(symbol);
  const c = getCandles(symbol, timeframe, 1);
  return {
    quoteSource: q.provider,
    candleSource: c.provider,
    lastQuoteTime: q.timestamp,
    lastCandleTime: c.lastCandleTs,
    quoteIsStale: q.isStale,
    candleIsStale: c.isStale,
    simulatorActive: true,
    chartActive: true,
    mt5Connected: MT5_BRIDGE_CONNECTED,
    brokerExecutableData: false,
    scannerProvider: ACTIVE_PROVIDER,
    riskGovernorProvider: ACTIVE_PROVIDER,
    notice: "Active provider is SIMULATOR. Chart embed is visual only. MT5 bridge is deferred — no quote here is broker-executable.",
  };
}

// ── Risk governor adapter (read-only; never places orders) ─────────────────
export interface GuardInput {
  symbol: string; direction?: "BUY" | "SELL";
  lotSize?: number; stopLoss?: number; takeProfit?: number;
  entryPrice?: number; maxLossUsd?: number;
  confidenceScore?: number; tradesToday?: number;
  dailyLossUsd?: number; maxDailyLossUsd?: number;
}

export interface GuardResult {
  approved: boolean;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "BLOCK";
  reasons: string[]; warnings: string[];
  marketHealth: ReturnType<typeof marketHealth>;
  newsRisk: ReturnType<typeof currentNewsRisk>;
  sessionRisk: ReturnType<typeof sessionClock>;
  maxLoss: number;
  riskRewardRatio: number;
  dataSource: Provider;
}

export function evaluateRisk(input: GuardInput): GuardResult {
  const mh = marketHealth(input.symbol);
  const news = currentNewsRisk(input.symbol);
  const session = sessionClock();
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (mh.quote.isStale) reasons.push("Quote data is stale.");
  if (mh.spread.label === "SPREAD_TOO_HIGH") reasons.push("Spread is too wide.");
  if (mh.volatility.label === "HIGH_VOLATILITY") warnings.push("High volatility.");
  if (mh.volatility.label === "QUIET" || session.sessionLabel === "QUIET") warnings.push("Low liquidity session.");
  if (news.blocking) reasons.push(news.blockReason || "Inside high-impact news window.");
  if (input.stopLoss == null) reasons.push("Missing stop loss.");
  if (input.lotSize != null && input.lotSize > 0.5) warnings.push("Lot size is large.");
  if (input.confidenceScore != null && input.confidenceScore < 50) warnings.push("Low AI confidence.");
  if (input.tradesToday != null && input.tradesToday >= 5) warnings.push("Possible overtrading.");
  if (input.dailyLossUsd != null && input.maxDailyLossUsd != null && input.dailyLossUsd >= input.maxDailyLossUsd) {
    reasons.push("Max daily loss reached.");
  }

  let rr = 0;
  if (input.entryPrice != null && input.stopLoss != null && input.takeProfit != null) {
    const risk = Math.abs(input.entryPrice - input.stopLoss);
    const reward = Math.abs(input.takeProfit - input.entryPrice);
    rr = risk > 0 ? Number((reward / risk).toFixed(2)) : 0;
    if (rr < 1.2) reasons.push(`Poor risk/reward (${rr}).`);
  }

  let riskLevel: GuardResult["riskLevel"] = "LOW";
  if (reasons.length > 0) riskLevel = "BLOCK";
  else if (warnings.length >= 2) riskLevel = "HIGH";
  else if (warnings.length === 1) riskLevel = "MEDIUM";

  return {
    approved: reasons.length === 0,
    riskLevel, reasons, warnings,
    marketHealth: mh, newsRisk: news, sessionRisk: session,
    maxLoss: input.maxLossUsd ?? 0,
    riskRewardRatio: rr,
    dataSource: ACTIVE_PROVIDER,
  };
}
