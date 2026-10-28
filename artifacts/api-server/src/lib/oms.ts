// Order Management System + Position Manager + Simulated Execution Engine
// + P/L Engine.
//
// SAFETY:
// - 100% simulator-only. Never calls placeLiveOrderGuarded(). Never writes
//   to live_positions / mt5_commands. Never claims a real broker fill.
// - Every order/position carries an `environment` and a `dataSource` so
//   PAPER, DEMO_SIMULATOR, LIVE_TESTER_INTENT, FUTURE_MT5_* never mix.
// - All state is in-memory (Maps); avoids any DB schema push for this phase.
// - Tick loop is unref()'d so it can never block process exit.

import { marketSimulator } from "./marketSimulator.js";
import { currentNewsRisk, marketHealth } from "./marketDataLayer.js";
import { pushDecision } from "./marketScanner.js";
import { evaluatePreTradeRisk, resolveEffectiveLimits, summarizeActivity, type InstrumentModel, type IntentAction, type IntentOrigin, type RiskDecision, type RiskInFlight, type RiskPosition, type TradeIntent } from "./riskGovernor/preTrade.js";

export type Environment =
  | "PAPER" | "DEMO_SIMULATOR" | "LIVE_TESTER_INTENT"
  | "FUTURE_MT5_DEMO" | "FUTURE_MT5_LIVE";

export type OrderSource =
  | "MANUAL" | "AI_ASSIST" | "AI_AUTO" | "SCANNER" | "BACKTEST" | "REPLAY";

export type OrderStatus =
  | "DRAFT" | "RISK_CHECK_PENDING" | "RISK_REJECTED"
  | "APPROVED_FOR_SIMULATION" | "SUBMITTED_SIMULATOR"
  | "FILLED_SIMULATOR" | "PARTIALLY_FILLED_SIMULATOR"
  | "CANCELLED" | "EXPIRED"
  | "PENDING_MT5_CONNECTION" | "READY_FOR_BROKER_WHEN_CONNECTED"
  | "SUBMITTED_TO_BROKER" | "FILLED_BROKER" | "REJECTED_BY_BROKER"
  | "CLOSED" | "ERROR";

export type OrderType = "MARKET" | "LIMIT" | "STOP";
export type Direction = "BUY" | "SELL";

export interface Order {
  orderId: string;
  environment: Environment;
  source: OrderSource;
  symbol: string;
  direction: Direction;
  orderType: OrderType;
  lotSize: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskAmount?: number;
  riskPercent?: number;
  riskRewardRatio?: number;
  confidenceScore?: number;
  riskScore?: number;
  entrySniperScore?: number;
  opportunityScore?: number;
  strategyId?: number | string;
  status: OrderStatus;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
  auditLogId?: string;
  idempotencyKey?: string;
  positionId?: string;
  /** The user (operator, or agent owner) the order was placed for; null when unknown. */
  ownerUserId: number | null;
  dataSource: "SIMULATOR";
}

export type PositionStatus =
  | "OPEN" | "CLOSED" | "STOPPED_OUT"
  | "TAKE_PROFIT_HIT" | "MANUALLY_CLOSED" | "EXPIRED";

export interface Position {
  positionId: string;
  orderId: string;
  environment: Environment;
  symbol: string;
  direction: Direction;
  lotSize: number;
  entryPrice: number;
  currentPrice: number;
  /**
   * What currentPrice is: SIMULATOR_QUOTE — marked from the simulator quote
   * at currentPriceAsOf; NO_QUOTE — the simulator had no quote on the latest
   * tick, so it is the last mark (as of currentPriceAsOf), not a live price;
   * EXIT_PRICE — the position is closed and this is its exit (SL/TP/close)
   * price, as of the close.
   */
  currentPriceBasis: "SIMULATOR_QUOTE" | "NO_QUOTE" | "EXIT_PRICE";
  currentPriceAsOf: string;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPnL: number;
  realizedPnL: number;
  rMultiple: number;
  riskAmount: number;
  status: PositionStatus;
  openedAt: string;
  closedAt?: string;
  closeReason?: string;
  trailingDistance?: number;
  /** The user the position belongs to (from its order); null when unknown. */
  ownerUserId: number | null;
  /**
   * Every realization booked on this position, in order: one per partial
   * close and one for the final close. `realizedPnL` is their sum, and the
   * P/L engine buckets them by their own time, not by the position's close.
   */
  realizations: Array<{ at: string; pnl: number }>;
  dataSource: "SIMULATOR";
}

/** Restricts a book read to one owner. Omitted = the whole simulator book (internal callers only). */
export interface OmsOwnerScope { ownerUserId?: number }
const inScope = (scope: OmsOwnerScope | undefined, row: { ownerUserId: number | null }) =>
  scope?.ownerUserId == null || row.ownerUserId === scope.ownerUserId;

const orders = new Map<string, Order>();
const positions = new Map<string, Position>();

function newId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function nowIso() { return new Date().toISOString(); }
function audit(kind: string, summary: string, payload: unknown) {
  const id = newId("aud");
  pushDecision({ type: kind, summary, payload });
  return id;
}

// Pip value heuristic for the simulator (USD-quoted majors approx).
function pipValueUsd(symbol: string, lotSize: number): number {
  if (symbol === "XAUUSD") return 10 * lotSize;       // $10 per $1 move per lot
  if (symbol === "BTCUSDT") return 1 * lotSize;
  if (symbol === "ETHUSDT") return 1 * lotSize;
  if (symbol.endsWith("JPY")) return 9.0 * lotSize;
  return 10 * lotSize; // EURUSD/GBPUSD-ish
}
function priceMoveToUsd(symbol: string, priceMove: number, lotSize: number): number {
  // Convert raw price difference into dollars based on contract heuristic.
  if (symbol === "XAUUSD") return priceMove * 100 * lotSize;
  if (symbol === "BTCUSDT" || symbol === "ETHUSDT") return priceMove * lotSize;
  if (symbol.endsWith("JPY")) return (priceMove / 0.01) * pipValueUsd(symbol, lotSize);
  return (priceMove / 0.0001) * pipValueUsd(symbol, lotSize);
}

// ── Order CRUD ─────────────────────────────────────────────────────────────
export interface CreateOrderInput {
  environment: Environment;
  source: OrderSource;
  symbol: string;
  direction: Direction;
  orderType?: OrderType;
  lotSize: number;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskAmount?: number;
  confidenceScore?: number;
  riskScore?: number;
  entrySniperScore?: number;
  opportunityScore?: number;
  strategyId?: number | string;
  idempotencyKey?: string;
}

function createOrder(input: CreateOrderInput, ownerUserId: number | null): Order {
  if (input.idempotencyKey) {
    const existing = Array.from(orders.values()).find((o) => o.idempotencyKey === input.idempotencyKey && o.ownerUserId === ownerUserId);
    if (existing) return existing;
  }
  const o: Order = {
    orderId: newId("ord"),
    environment: input.environment,
    source: input.source,
    symbol: input.symbol,
    direction: input.direction,
    orderType: input.orderType ?? "MARKET",
    lotSize: input.lotSize,
    entryPrice: input.entryPrice,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    riskAmount: input.riskAmount,
    confidenceScore: input.confidenceScore,
    riskScore: input.riskScore,
    entrySniperScore: input.entrySniperScore,
    opportunityScore: input.opportunityScore,
    strategyId: input.strategyId,
    status: "RISK_CHECK_PENDING",
    createdAt: nowIso(), updatedAt: nowIso(),
    idempotencyKey: input.idempotencyKey,
    ownerUserId,
    dataSource: "SIMULATOR",
  };

  if (o.entryPrice != null && o.stopLoss != null && o.takeProfit != null) {
    const risk = Math.abs(o.entryPrice - o.stopLoss);
    o.riskRewardRatio = risk > 0 ? Number((Math.abs(o.takeProfit - o.entryPrice) / risk).toFixed(2)) : 0;
  }

  // Risk is decided only by the pre-trade Risk Governor (governOms, before
  // this runs). Here the venue only routes: future MT5 environments are not
  // available, the live-tester intent parks until a bridge exists.
  if (o.environment.startsWith("FUTURE_MT5")) {
    o.status = "RISK_REJECTED";
    o.rejectionReason = "FUTURE_MT5_NOT_PERMITTED";
  } else if (o.environment === "LIVE_TESTER_INTENT") {
    o.status = "PENDING_MT5_CONNECTION";
  } else {
    o.status = "APPROVED_FOR_SIMULATION";
  }
  o.auditLogId = audit("ORDER_CREATED", `Order ${o.orderId} ${o.symbol} ${o.direction} ${o.environment} → ${o.status}`, { o });
  orders.set(o.orderId, o);
  return o;
}

export function listOrders(filter?: { environment?: Environment; status?: OrderStatus; source?: OrderSource; limit?: number } & OmsOwnerScope) {
  let arr = Array.from(orders.values()).filter((o) => inScope(filter, o));
  if (filter?.environment) arr = arr.filter((o) => o.environment === filter.environment);
  if (filter?.status) arr = arr.filter((o) => o.status === filter.status);
  if (filter?.source) arr = arr.filter((o) => o.source === filter.source);
  arr.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return arr.slice(0, filter?.limit ?? 200);
}
export function getOrder(id: string) { return orders.get(id) ?? null; }

function patchOrder(id: string, patch: Partial<Order>) {
  const o = orders.get(id); if (!o) return null;
  Object.assign(o, patch, { orderId: o.orderId, updatedAt: nowIso() });
  audit("ORDER_PATCHED", `Order ${id} patched`, { patch });
  return o;
}

function cancelOrder(id: string) {
  const o = orders.get(id); if (!o) return null;
  if (o.status === "FILLED_SIMULATOR" || o.status === "CLOSED") return o;
  o.status = "CANCELLED"; o.updatedAt = nowIso();
  audit("ORDER_CANCELLED", `Order ${id} cancelled`, {});
  return o;
}

// ── Simulator execution ────────────────────────────────────────────────────
function submitToSimulator(orderId: string): { order: Order; position?: Position; error?: string } {
  const o = orders.get(orderId);
  if (!o) return { order: o!, error: "not_found" };
  if (o.environment === "LIVE_TESTER_INTENT" || o.environment.startsWith("FUTURE_MT5")) {
    return { order: o, error: "Order is for tester intent / future broker — not eligible for simulator fill." };
  }
  if (o.status !== "APPROVED_FOR_SIMULATION" && o.status !== "DRAFT" && o.status !== "RISK_CHECK_PENDING") {
    return { order: o, error: `Order status ${o.status} not eligible.` };
  }
  const q = marketSimulator.quote(o.symbol);
  if (!q) { o.status = "ERROR"; o.rejectionReason = "no quote"; return { order: o, error: "no quote" }; }
  const fillPrice = o.direction === "BUY" ? q.ask : q.bid;
  o.entryPrice = o.entryPrice ?? fillPrice;
  o.status = "FILLED_SIMULATOR"; o.updatedAt = nowIso();

  const risk = o.entryPrice && o.stopLoss
    ? Math.abs(priceMoveToUsd(o.symbol, Math.abs(o.entryPrice - o.stopLoss), o.lotSize))
    : (o.riskAmount ?? 0);

  const p: Position = {
    positionId: newId("pos"), orderId: o.orderId,
    environment: o.environment, symbol: o.symbol, direction: o.direction,
    lotSize: o.lotSize, entryPrice: fillPrice, currentPrice: fillPrice,
    currentPriceBasis: "SIMULATOR_QUOTE", currentPriceAsOf: q.tsIso,
    stopLoss: o.stopLoss, takeProfit: o.takeProfit,
    unrealizedPnL: 0, realizedPnL: 0, rMultiple: 0,
    riskAmount: risk, status: "OPEN",
    openedAt: nowIso(), ownerUserId: o.ownerUserId, realizations: [], dataSource: "SIMULATOR",
  };
  positions.set(p.positionId, p);
  o.positionId = p.positionId;
  audit("SIMULATOR_FILL", `Filled ${o.symbol} ${o.direction} @ ${fillPrice} env=${o.environment}`, { orderId: o.orderId, positionId: p.positionId });
  return { order: o, position: p };
}

function pnlFor(p: Position): number {
  const move = p.direction === "BUY" ? (p.currentPrice - p.entryPrice) : (p.entryPrice - p.currentPrice);
  return Number(priceMoveToUsd(p.symbol, move, p.lotSize).toFixed(2));
}

function tickPosition(p: Position) {
  if (p.status !== "OPEN") return;
  const q = marketSimulator.quote(p.symbol);
  if (!q) { p.currentPriceBasis = "NO_QUOTE"; return; }
  p.currentPrice = p.direction === "BUY" ? q.bid : q.ask;
  p.currentPriceBasis = "SIMULATOR_QUOTE"; p.currentPriceAsOf = q.tsIso;
  p.unrealizedPnL = pnlFor(p);
  p.rMultiple = p.riskAmount > 0 ? Number((p.unrealizedPnL / p.riskAmount).toFixed(2)) : 0;
  // SL / TP triggers using mid for fairness.
  const mid = q.mid;
  if (p.stopLoss != null) {
    if ((p.direction === "BUY" && mid <= p.stopLoss) || (p.direction === "SELL" && mid >= p.stopLoss)) {
      closePosition(p.positionId, "STOPPED_OUT", p.stopLoss);
      return;
    }
  }
  if (p.takeProfit != null) {
    if ((p.direction === "BUY" && mid >= p.takeProfit) || (p.direction === "SELL" && mid <= p.takeProfit)) {
      closePosition(p.positionId, "TAKE_PROFIT_HIT", p.takeProfit);
      return;
    }
  }
  // Trailing stop (simulator only).
  if (p.trailingDistance && p.trailingDistance > 0) {
    if (p.direction === "BUY") {
      const proposed = p.currentPrice - p.trailingDistance;
      if (p.stopLoss == null || proposed > p.stopLoss) p.stopLoss = Number(proposed.toFixed(5));
    } else {
      const proposed = p.currentPrice + p.trailingDistance;
      if (p.stopLoss == null || proposed < p.stopLoss) p.stopLoss = Number(proposed.toFixed(5));
    }
  }
}

export function tickAll() {
  for (const p of positions.values()) tickPosition(p);
}

// Background loop — light, unref()'d.
const TICK_MS = 2000;
setInterval(() => { try { tickAll(); } catch { /* swallow */ } }, TICK_MS).unref?.();

// ── Position management actions ────────────────────────────────────────────
export function listPositions(filter?: { environment?: Environment; status?: PositionStatus; limit?: number } & OmsOwnerScope) {
  let arr = Array.from(positions.values()).filter((p) => inScope(filter, p));
  if (filter?.environment) arr = arr.filter((p) => p.environment === filter.environment);
  if (filter?.status) arr = arr.filter((p) => p.status === filter.status);
  arr.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  return arr.slice(0, filter?.limit ?? 200);
}
export function getPosition(id: string) { return positions.get(id) ?? null; }

function closePosition(id: string, reason: PositionStatus = "MANUALLY_CLOSED", overridePrice?: number) {
  const p = positions.get(id); if (!p) return null;
  if (p.status !== "OPEN") return p;
  if (overridePrice != null) p.currentPrice = overridePrice;
  // The remainder's P/L adds to anything a partial close already realized.
  const final = pnlFor(p);
  const at = nowIso();
  p.realizations.push({ at, pnl: final });
  p.realizedPnL = Number((p.realizedPnL + final).toFixed(2));
  p.unrealizedPnL = 0;
  p.rMultiple = p.riskAmount > 0 ? Number((p.realizedPnL / p.riskAmount).toFixed(2)) : 0;
  p.status = reason; p.closedAt = at;
  p.closeReason = reason;
  p.currentPriceBasis = "EXIT_PRICE"; p.currentPriceAsOf = p.closedAt;
  // Mark linked order CLOSED.
  const ord = orders.get(p.orderId); if (ord) { ord.status = "CLOSED"; ord.updatedAt = nowIso(); }
  audit("POSITION_CLOSED", `Closed ${p.symbol} ${p.direction} ${reason} pnl=${p.realizedPnL} R=${p.rMultiple}`, { positionId: id });
  return p;
}

function partialClose(id: string, fraction: number) {
  const p = positions.get(id); if (!p || p.status !== "OPEN") return null;
  const f = Math.max(0.01, Math.min(0.99, fraction));
  const closedLots = Number((p.lotSize * f).toFixed(2));
  if (closedLots <= 0) return p;
  // Realize a partial PnL using a clone, then reduce the live position.
  const closedShare: Position = { ...p, lotSize: closedLots };
  const realized = pnlFor(closedShare);
  p.realizations.push({ at: nowIso(), pnl: realized });
  p.realizedPnL = Number((p.realizedPnL + realized).toFixed(2));
  p.lotSize = Number((p.lotSize - closedLots).toFixed(2));
  audit("POSITION_PARTIAL_CLOSE", `Partial close ${id} ${closedLots} lots, pnl+=${realized}`, {});
  return p;
}

function moveStop(id: string, newStop: number) {
  const p = positions.get(id); if (!p || p.status !== "OPEN") return null;
  p.stopLoss = newStop;
  audit("POSITION_MOVE_STOP", `Move stop ${id} → ${newStop}`, {});
  return p;
}
function moveTakeProfit(id: string, newTp: number) {
  const p = positions.get(id); if (!p || p.status !== "OPEN") return null;
  p.takeProfit = newTp;
  audit("POSITION_MOVE_TP", `Move TP ${id} → ${newTp}`, {});
  return p;
}
function moveStopToBreakEven(id: string) {
  const p = positions.get(id); if (!p || p.status !== "OPEN") return null;
  p.stopLoss = p.entryPrice;
  audit("POSITION_BREAKEVEN", `Stop → BE ${id}`, {});
  return p;
}
function applyTrailingStop(id: string, distance: number) {
  const p = positions.get(id); if (!p || p.status !== "OPEN") return null;
  p.trailingDistance = distance;
  audit("POSITION_TRAILING", `Trailing stop ${id} dist=${distance}`, {});
  return p;
}

// ── P/L engine ─────────────────────────────────────────────────────────────
function bucketByDay(p: Position): string { return (p.closedAt ?? p.openedAt).slice(0, 10); }

export function pnlSummary(env?: Environment, scope?: OmsOwnerScope) {
  const all = Array.from(positions.values()).filter((p) => (!env || p.environment === env) && inScope(scope, p));
  const closed = all.filter((p) => p.status !== "OPEN");
  const open = all.filter((p) => p.status === "OPEN");
  const today = new Date().toISOString().slice(0, 10);
  const startWeek = new Date(); startWeek.setUTCDate(startWeek.getUTCDate() - 7);
  const startMonth = new Date(); startMonth.setUTCMonth(startMonth.getUTCMonth() - 1);

  // Realized P/L is booked when it is realized: a partial close on a still
  // open position counts on its own day, the final close on its day.
  const realized = all.flatMap((p) => p.realizations);
  const sumRealized = (since: (at: string) => boolean) =>
    Number(realized.filter((r) => since(r.at)).reduce((a, r) => a + r.pnl, 0).toFixed(2));
  const wins = closed.filter((p) => p.realizedPnL > 0).length;
  const losses = closed.filter((p) => p.realizedPnL < 0).length;
  const avgR = closed.length ? Number((closed.reduce((a, b) => a + b.rMultiple, 0) / closed.length).toFixed(2)) : 0;
  // Max drawdown (running min of cumulative).
  let cum = 0, peak = 0, dd = 0;
  for (const p of [...closed].sort((a, b) => Date.parse(a.closedAt ?? a.openedAt) - Date.parse(b.closedAt ?? b.openedAt))) {
    cum += p.realizedPnL;
    peak = Math.max(peak, cum);
    dd = Math.min(dd, cum - peak);
  }
  return {
    environment: env ?? "ALL",
    dailyPnL: sumRealized((at) => at.slice(0, 10) === today),
    weeklyPnL: sumRealized((at) => Date.parse(at) >= +startWeek),
    monthlyPnL: sumRealized((at) => Date.parse(at) >= +startMonth),
    openUnrealizedPnL: Number(open.reduce((a, b) => a + b.unrealizedPnL, 0).toFixed(2)),
    closedRealizedPnL: sumRealized(() => true),
    wins, losses,
    winRate: wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : 0,
    averageR: avgR,
    maxDrawdown: Number(dd.toFixed(2)),
    // With no closed positions, winRate, averageR and maxDrawdown above were
    // not measured (they read 0); closedCount lets a reader say so.
    closedCount: closed.length,
    // dailyPnL is the UTC calendar day (00:00 UTC onward), not the viewer's day.
    dayBoundary: "UTC" as const,
    dataSource: "SIMULATOR" as const,
  };
}

export function pnlBy(group: "symbol" | "strategy" | "source" | "environment", scope?: OmsOwnerScope) {
  const all = Array.from(positions.values()).filter((p) => p.status !== "OPEN" && inScope(scope, p));
  const map = new Map<string, { count: number; pnl: number; wins: number; losses: number }>();
  for (const p of all) {
    let key: string;
    if (group === "symbol") key = p.symbol;
    else if (group === "environment") key = p.environment;
    else {
      const o = orders.get(p.orderId);
      key = group === "strategy" ? String(o?.strategyId ?? "none") : String(o?.source ?? "MANUAL");
    }
    const cur = map.get(key) ?? { count: 0, pnl: 0, wins: 0, losses: 0 };
    cur.count += 1; cur.pnl = Number((cur.pnl + p.realizedPnL).toFixed(2));
    if (p.realizedPnL > 0) cur.wins += 1; else if (p.realizedPnL < 0) cur.losses += 1;
    map.set(key, cur);
  }
  return Array.from(map.entries()).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.pnl - a.pnl);
}

export function pnlDaily(env?: Environment, scope?: OmsOwnerScope) {
  const all = Array.from(positions.values()).filter((p) => p.status !== "OPEN" && (!env || p.environment === env) && inScope(scope, p));
  const map = new Map<string, { day: string; pnl: number; trades: number; wins: number; losses: number }>();
  for (const p of all) {
    const day = bucketByDay(p);
    const cur = map.get(day) ?? { day, pnl: 0, trades: 0, wins: 0, losses: 0 };
    cur.trades += 1; cur.pnl = Number((cur.pnl + p.realizedPnL).toFixed(2));
    if (p.realizedPnL > 0) cur.wins += 1; else if (p.realizedPnL < 0) cur.losses += 1;
    map.set(day, cur);
  }
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
}

// ── Broker reconciliation placeholder ──────────────────────────────────────
export function brokerReconStatus() {
  return {
    mt5Connected: false,
    brokerOrders: [] as unknown[],
    brokerPositions: [] as unknown[],
    localOrders: orders.size,
    localPositions: positions.size,
    localLiveIntents: Array.from(orders.values()).filter((o) => o.environment === "LIVE_TESTER_INTENT").length,
    mismatches: [] as unknown[],
    syncStatus: "DEFERRED",
    notice: "Broker reconciliation activates after MT5 bridge is connected.",
  };
}

// ── Helpers for dashboard ──────────────────────────────────────────────────
export function omsDashboardSummary() {
  const open = listPositions({ status: "OPEN" });
  const closed = Array.from(positions.values()).filter((p) => p.status !== "OPEN");
  const today = new Date().toISOString().slice(0, 10);
  const closedToday = closed.filter((p) => bucketByDay(p) === today);
  const best = closedToday.reduce<Position | null>((acc, p) => (!acc || p.realizedPnL > acc.realizedPnL) ? p : acc, null);
  const worst = closedToday.reduce<Position | null>((acc, p) => (!acc || p.realizedPnL < acc.realizedPnL) ? p : acc, null);
  return {
    openPositions: open.length,
    pendingOrders: listOrders({ status: "APPROVED_FOR_SIMULATION" }).length + listOrders({ status: "PENDING_MT5_CONNECTION" }).length,
    todayPnL: Number(closedToday.reduce((a, b) => a + b.realizedPnL, 0).toFixed(2)),
    bestTradeToday: best ? { symbol: best.symbol, pnl: best.realizedPnL } : null,
    worstTradeToday: worst ? { symbol: worst.symbol, pnl: worst.realizedPnL } : null,
    pendingMt5Intents: Array.from(orders.values()).filter((o) => o.status === "PENDING_MT5_CONNECTION").length,
    aiVsManual: {
      ai: closed.filter((p) => { const o = orders.get(p.orderId); return o && (o.source === "AI_ASSIST" || o.source === "AI_AUTO"); }).reduce((a, b) => a + b.realizedPnL, 0),
      manual: closed.filter((p) => { const o = orders.get(p.orderId); return o && o.source === "MANUAL"; }).reduce((a, b) => a + b.realizedPnL, 0),
    },
    orderSystemStatus: "RUNNING",
    dataSource: "SIMULATOR",
  };
}

// ── Governed entry points (the only exported way to change the book) ───────
//
// Every order the simulator OMS creates, amends or fills, and every stop,
// target or close on its positions, is evaluated by the pre-trade Risk
// Governor (lib/riskGovernor) for the operator or agent driving it — the same
// 13 rules and stop switches as paper, demo and live, written to that user's
// user_risk_events trail. The OMS supplies its own book as the facts: its
// simulated account, open positions, quotes, spread and news window, today's
// P/L, and the simulator's venue rules (take profit required, an R:R floor,
// a model-confidence floor for AI orders). It decides nothing itself.

export interface OmsActor {
  /** The operator, or the owner of the agent, on whose behalf the OMS acts. */
  userId: number;
  /** Who decided this action; defaults from the order source, else manual. */
  origin?: IntentOrigin;
}

export interface OmsGovernance {
  allowed: boolean;
  blockedBy: string[];
  reason: string | null;
  auditEventId: number | null;
}

export type OmsActionResult<T> =
  | { ok: true; value: T; governance: OmsGovernance }
  | { ok: false; error: "not_found" | "not_open" | "risk_blocked" | "would_widen"; governance?: OmsGovernance; message: string };

const SOURCE_ORIGIN: Record<OrderSource, IntentOrigin> = {
  MANUAL: "manual", AI_ASSIST: "ruby", AI_AUTO: "automation", SCANNER: "automation", BACKTEST: "system", REPLAY: "system",
};

/** Simulated account balance the OMS book is sized on. */
export const SIMULATOR_STARTING_BALANCE = 10_000;

/** Hard rules the simulator venue adds to every entry it books (rule 13). */
export const SIMULATOR_VENUE_RULES = {
  source: "simulator_oms", requireTakeProfit: true, minRewardRiskRatio: 1.2, minAiConfidence: 70,
} as const;

function simulatorInstrument(symbol: string): InstrumentModel {
  return {
    // Money per 1.0 price move per lot, from the same heuristic the OMS P/L uses.
    contractSize: priceMoveToUsd(symbol, 1, 1), quoteToAccountFx: 1,
    volumeStep: 0.01, minVolume: 0.01, maxVolume: null, source: "simulator_oms",
  };
}

async function governOms(args: {
  actor: OmsActor; origin: IntentOrigin; action: IntentAction; environment: Environment;
  symbol: string; side: Direction; lots: number; entryPrice?: number | null;
  stopLoss?: number | null; takeProfit?: number | null; ref: string;
  position?: { entryPrice: number; stopLoss: number | null } | null;
  aiConfidence?: number | null;
}): Promise<OmsGovernance> {
  const { enforcePreTradeRisk } = await import("./riskGovernor/enforce.js");
  const open = Array.from(positions.values()).filter((p) => p.status === "OPEN" && p.environment === args.environment);
  const book: RiskPosition[] = open.map((p) => ({
    symbol: p.symbol, side: p.direction, lots: p.lotSize, entryPrice: p.entryPrice, stopLoss: p.stopLoss ?? null,
  }));
  const instruments: Record<string, InstrumentModel> = {};
  for (const s of new Set([args.symbol, ...open.map((p) => p.symbol)])) instruments[s] = simulatorInstrument(s);
  const now = new Date();
  const inFlight: RiskInFlight[] = Array.from(orders.values())
    .filter((o) => `oms:${o.orderId}` !== args.ref && o.environment === args.environment
      && (o.status === "APPROVED_FOR_SIMULATION" || o.status === "PENDING_MT5_CONNECTION"
        || (o.status === "FILLED_SIMULATOR" && now.getTime() - Date.parse(o.updatedAt) < 60_000)))
    .map((o) => ({ ref: `oms:${o.orderId}`, symbol: o.symbol, side: o.direction, lots: o.lotSize, at: new Date(o.updatedAt),
      kind: o.status === "FILLED_SIMULATOR" ? "filled" as const : "pending" as const }));
  const q = marketSimulator.quote(args.symbol);
  const floating = open.reduce((a, p) => a + p.unrealizedPnL, 0);
  const today = now.toISOString().slice(0, 10);
  const realized = Array.from(positions.values())
    .filter((p) => p.status !== "OPEN" && p.environment === args.environment && (p.closedAt ?? "").slice(0, 10) === today)
    .reduce((a, p) => a + p.realizedPnL, 0);
  // Rule 13 counts trades on the simulator's own book, like its P/L.
  const dayStart = `${today}T00:00:00.000Z`;
  const activity = summarizeActivity(
    Array.from(positions.values())
      .filter((p) => p.status !== "OPEN" && p.environment === args.environment && p.closedAt)
      .map((p) => ({ closedAt: new Date(p.closedAt!), pnl: p.realizedPnL })),
    open.filter((p) => p.openedAt >= dayStart).length,
    now, `simulator_oms:${args.environment}`,
  );
  const balance = SIMULATOR_STARTING_BALANCE;
  const equity = balance + floating;
  const usedMargin = open.reduce((a, p) => a + (simulatorInstrument(p.symbol).contractSize ?? 0) * p.entryPrice * p.lotSize / 100, 0);

  const intent: TradeIntent = {
    userId: args.actor.userId, venue: "PAPER", origin: args.origin, action: args.action,
    symbol: args.symbol, side: args.side, lots: args.lots,
    entryPrice: args.entryPrice ?? null, stopLoss: args.stopLoss ?? null, takeProfit: args.takeProfit ?? null,
    intentRef: args.ref, position: args.position ?? null, aiConfidence: args.aiConfidence ?? null,
  };
  const health = marketHealth(args.symbol);
  const news = currentNewsRisk(args.symbol);
  const r = await enforcePreTradeRisk(intent, {
    facts: {
      now,
      account: { equity, freeMargin: equity - usedMargin, leverage: 100, currency: "USD", source: "simulator_oms" },
      instruments, positions: book, inFlight,
      quote: q ? { bid: q.bid, ask: q.ask, at: now, source: "simulator_oms" } : null,
      broker: { status: "CONNECTED", lastSeenAt: now, detail: "internal simulator OMS" },
      daily: { realizedPnl: realized, floatingPnl: floating },
      activity,
      market: {
        spreadTooWide: health.spread.label === "SPREAD_TOO_HIGH",
        newsBlock: news.blocking ? news.blockReason || "high-impact news" : null,
        source: "simulator_market_data",
      },
      venueRules: SIMULATOR_VENUE_RULES,
    },
    auditContext: { caller: "simulator_oms", environment: args.environment, ref: args.ref },
  });
  return { allowed: r.allowed, blockedBy: r.blockedBy, reason: r.primaryReason, auditEventId: r.auditEventId };
}

/**
 * What the Risk Governor would say, at platform-default limits, about a
 * hypothetical simulator entry on an empty book. Pure (no audit row, no
 * user): for shadow mode, which tracks ideas and never books an order.
 */
export function previewSimulatorEntry(t: {
  symbol: string; side: Direction; lots: number; stopLoss: number | null; takeProfit: number | null;
  aiConfidence: number | null; origin: IntentOrigin;
}): RiskDecision {
  const now = new Date();
  const q = marketSimulator.quote(t.symbol);
  const health = marketHealth(t.symbol);
  const news = currentNewsRisk(t.symbol);
  return evaluatePreTradeRisk({
    userId: 0, venue: "PAPER", origin: t.origin, action: "OPEN", symbol: t.symbol, side: t.side, lots: t.lots,
    stopLoss: t.stopLoss, takeProfit: t.takeProfit, aiConfidence: t.aiConfidence,
  }, {
    now, limits: resolveEffectiveLimits({}),
    account: { equity: SIMULATOR_STARTING_BALANCE, freeMargin: SIMULATOR_STARTING_BALANCE, leverage: 100, currency: "USD", source: "simulator_oms" },
    instruments: { [t.symbol]: simulatorInstrument(t.symbol) },
    quote: q ? { bid: q.bid, ask: q.ask, at: now, source: "simulator_oms" } : null,
    positions: [], inFlight: [],
    broker: { status: "CONNECTED", lastSeenAt: now, detail: "internal simulator OMS" },
    daily: { realizedPnl: 0, floatingPnl: 0 },
    market: { spreadTooWide: health.spread.label === "SPREAD_TOO_HIGH", newsBlock: news.blocking ? news.blockReason || "high-impact news" : null, source: "simulator_market_data" },
    venueRules: SIMULATOR_VENUE_RULES,
  });
}

function blocked<T>(g: OmsGovernance): OmsActionResult<T> {
  return { ok: false, error: "risk_blocked", governance: g, message: g.reason ?? "Blocked by Risk Governor." };
}

/** Create an order. A governor refusal is recorded on the order as RISK_REJECTED. */
export async function placeOrder(input: CreateOrderInput, actor: OmsActor): Promise<{ order: Order; governance: OmsGovernance }> {
  if (input.idempotencyKey) {
    const existing = Array.from(orders.values()).find((o) => o.idempotencyKey === input.idempotencyKey && o.ownerUserId === actor.userId);
    if (existing) return { order: existing, governance: { allowed: existing.status !== "RISK_REJECTED", blockedBy: [], reason: null, auditEventId: null } };
  }
  const pendingId = newId("ord");
  const g = await governOms({
    actor, origin: actor.origin ?? SOURCE_ORIGIN[input.source], action: "OPEN", environment: input.environment,
    symbol: input.symbol, side: input.direction, lots: input.lotSize,
    entryPrice: input.orderType && input.orderType !== "MARKET" ? input.entryPrice ?? null : null,
    stopLoss: input.stopLoss ?? null, takeProfit: input.takeProfit ?? null, ref: `oms:${pendingId}`,
    aiConfidence: input.confidenceScore ?? null,
  });
  const order = createOrder(input, actor.userId);
  if (!g.allowed && order.status !== "RISK_REJECTED") {
    order.status = "RISK_REJECTED";
    order.rejectionReason = `RISK_GOVERNOR_BLOCK[${g.blockedBy.join(",")}]: ${g.reason ?? ""}`.trim();
    order.updatedAt = nowIso();
    audit("ORDER_RISK_GOVERNOR_BLOCK", `Order ${order.orderId} refused by the pre-trade Risk Governor`, { blockedBy: g.blockedBy });
  }
  return { order, governance: g };
}

/** Fill an approved order in the simulator, re-checked at fill time. */
export async function fillOrder(orderId: string, actor: OmsActor): Promise<OmsActionResult<{ order: Order; position?: Position; error?: string }>> {
  const o = orders.get(orderId);
  if (!o) return { ok: false, error: "not_found", message: "not found" };
  const g = await governOms({
    actor, origin: actor.origin ?? SOURCE_ORIGIN[o.source], action: "OPEN", environment: o.environment,
    symbol: o.symbol, side: o.direction, lots: o.lotSize,
    entryPrice: o.orderType !== "MARKET" ? o.entryPrice ?? null : null,
    stopLoss: o.stopLoss ?? null, takeProfit: o.takeProfit ?? null, ref: `oms:${o.orderId}`,
    aiConfidence: o.confidenceScore ?? null,
  });
  if (!g.allowed) {
    if (o.status === "APPROVED_FOR_SIMULATION" || o.status === "DRAFT" || o.status === "RISK_CHECK_PENDING") {
      o.status = "RISK_REJECTED";
      o.rejectionReason = `RISK_GOVERNOR_BLOCK[${g.blockedBy.join(",")}]: ${g.reason ?? ""}`.trim();
      o.updatedAt = nowIso();
    }
    return blocked(g);
  }
  return { ok: true, value: submitToSimulator(orderId), governance: g };
}

/** Change an unfilled order's size, stop or target; the changed order is re-checked. */
export async function amendOrder(id: string, patch: Pick<Partial<Order>, "stopLoss" | "takeProfit" | "lotSize" | "rejectionReason">,
  actor: OmsActor): Promise<OmsActionResult<Order>> {
  const o = orders.get(id);
  if (!o) return { ok: false, error: "not_found", message: "not found" };
  const next = { ...o, ...patch };
  const g = await governOms({
    actor, origin: actor.origin ?? SOURCE_ORIGIN[o.source], action: "OPEN", environment: o.environment,
    symbol: o.symbol, side: o.direction, lots: next.lotSize,
    entryPrice: o.orderType !== "MARKET" ? o.entryPrice ?? null : null,
    stopLoss: next.stopLoss ?? null, takeProfit: next.takeProfit ?? null, ref: `oms:${o.orderId}`,
    aiConfidence: o.confidenceScore ?? null,
  });
  if (!g.allowed) return blocked(g);
  return { ok: true, value: patchOrder(id, patch)!, governance: g };
}

/** Cancel an unfilled order. Removes pending exposure, so it is never refused. */
export function withdrawOrder(id: string): Order | null {
  return cancelOrder(id);
}

function openPosition(id: string): Position | OmsActionResult<never> {
  const p = positions.get(id);
  if (!p) return { ok: false, error: "not_found", message: "not found" };
  if (p.status !== "OPEN") return { ok: false, error: "not_open", message: `position is ${p.status}` };
  return p;
}
const isResult = (v: unknown): v is OmsActionResult<never> => typeof v === "object" && v != null && "ok" in v;

export async function closeOmsPosition(id: string, actor: OmsActor): Promise<OmsActionResult<Position>> {
  const p = openPosition(id); if (isResult(p)) return p;
  const g = await governOms({ actor, origin: actor.origin ?? "manual", action: "CLOSE", environment: p.environment,
    symbol: p.symbol, side: p.direction, lots: p.lotSize, ref: `oms:${p.positionId}` });
  if (!g.allowed) return blocked(g);
  return { ok: true, value: closePosition(id, "MANUALLY_CLOSED")!, governance: g };
}

export async function partialCloseOmsPosition(id: string, fraction: number, actor: OmsActor): Promise<OmsActionResult<Position>> {
  const p = openPosition(id); if (isResult(p)) return p;
  const lots = Number((p.lotSize * Math.max(0.01, Math.min(0.99, fraction))).toFixed(2));
  const g = await governOms({ actor, origin: actor.origin ?? "manual", action: "PARTIAL_CLOSE", environment: p.environment,
    symbol: p.symbol, side: p.direction, lots, ref: `oms:${p.positionId}` });
  if (!g.allowed) return blocked(g);
  return { ok: true, value: partialClose(id, fraction)!, governance: g };
}

async function governStop(p: Position, stopLoss: number, takeProfit: number | null, actor: OmsActor): Promise<OmsGovernance> {
  return governOms({ actor, origin: actor.origin ?? "manual", action: "MODIFY", environment: p.environment,
    symbol: p.symbol, side: p.direction, lots: p.lotSize, stopLoss, takeProfit, ref: `oms:${p.positionId}`,
    position: { entryPrice: p.entryPrice, stopLoss: p.stopLoss ?? null } });
}

export async function moveOmsStop(id: string, stopLoss: number, actor: OmsActor): Promise<OmsActionResult<Position>> {
  const p = openPosition(id); if (isResult(p)) return p;
  const g = await governStop(p, stopLoss, p.takeProfit ?? null, actor);
  if (!g.allowed) return blocked(g);
  return { ok: true, value: moveStop(id, stopLoss)!, governance: g };
}

export async function moveOmsTakeProfit(id: string, takeProfit: number, actor: OmsActor): Promise<OmsActionResult<Position>> {
  const p = openPosition(id); if (isResult(p)) return p;
  const g = await governOms({ actor, origin: actor.origin ?? "manual", action: "MODIFY", environment: p.environment,
    symbol: p.symbol, side: p.direction, lots: p.lotSize, stopLoss: p.stopLoss ?? null, takeProfit,
    ref: `oms:${p.positionId}`, position: { entryPrice: p.entryPrice, stopLoss: p.stopLoss ?? null } });
  if (!g.allowed) return blocked(g);
  return { ok: true, value: moveTakeProfit(id, takeProfit)!, governance: g };
}

/** Break-even only ever tightens: refused when the stop is already past entry. */
export async function moveOmsStopToBreakEven(id: string, actor: OmsActor): Promise<OmsActionResult<Position>> {
  const p = openPosition(id); if (isResult(p)) return p;
  const widens = p.stopLoss != null && (p.direction === "BUY" ? p.entryPrice < p.stopLoss : p.entryPrice > p.stopLoss);
  if (widens) return { ok: false, error: "would_widen", message: `The stop ${p.stopLoss} is already past entry ${p.entryPrice}; break-even would widen it.` };
  const g = await governStop(p, p.entryPrice, p.takeProfit ?? null, actor);
  if (!g.allowed) return blocked(g);
  return { ok: true, value: moveStopToBreakEven(id)!, governance: g };
}

/**
 * Trailing distance: the tick loop only ever moves the stop toward price, so
 * setting it adds no risk. It is still checked as a modify at the stop the
 * trail would set now, when that is tighter than the current stop.
 */
export async function setOmsTrailingStop(id: string, distance: number, actor: OmsActor): Promise<OmsActionResult<Position>> {
  const p = openPosition(id); if (isResult(p)) return p;
  const proposed = Number((p.direction === "BUY" ? p.currentPrice - distance : p.currentPrice + distance).toFixed(5));
  const tighter = p.stopLoss == null || (p.direction === "BUY" ? proposed > p.stopLoss : proposed < p.stopLoss);
  const g = await governStop(p, tighter ? proposed : p.stopLoss!, p.takeProfit ?? null, actor);
  if (!g.allowed) return blocked(g);
  return { ok: true, value: applyTrailingStop(id, distance)!, governance: g };
}
