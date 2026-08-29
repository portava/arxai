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
import { evaluateRisk } from "./marketDataLayer.js";
import { preTradeCheck, logOrderOutcome } from "./riskGovernor2.js";
import { pushDecision } from "./marketScanner.js";

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
  dataSource: "SIMULATOR";
}

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

export function createOrder(input: CreateOrderInput): Order {
  if (input.idempotencyKey) {
    const existing = Array.from(orders.values()).find((o) => o.idempotencyKey === input.idempotencyKey);
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
    dataSource: "SIMULATOR",
  };

  // Risk + market-health check (advisory).
  const guard = evaluateRisk({
    symbol: o.symbol, direction: o.direction, lotSize: o.lotSize,
    stopLoss: o.stopLoss, takeProfit: o.takeProfit, entryPrice: o.entryPrice,
    confidenceScore: o.confidenceScore, maxLossUsd: o.riskAmount,
  });
  o.riskRewardRatio = guard.riskRewardRatio;

  // Risk Governor 2.0 — account protection layer (cannot bypass).
  const acct = preTradeCheck({
    environment: o.environment, source: o.source, symbol: o.symbol, direction: o.direction,
    lotSize: o.lotSize, entryPrice: o.entryPrice, stopLoss: o.stopLoss, takeProfit: o.takeProfit,
    riskAmount: o.riskAmount, confidenceScore: o.confidenceScore,
    entrySniperScore: o.entrySniperScore, opportunityScore: o.opportunityScore,
    idempotencyKey: o.idempotencyKey,
  });

  if (!guard.approved) {
    o.status = "RISK_REJECTED";
    o.rejectionReason = guard.reasons.join("; ");
  } else if (!acct.approved) {
    o.status = "RISK_REJECTED";
    o.rejectionReason = `ACCOUNT_PROTECTION:${acct.hardBlocks.join(",")}`;
  } else if (o.environment === "LIVE_TESTER_INTENT" || o.environment.startsWith("FUTURE_MT5")) {
    o.status = "PENDING_MT5_CONNECTION";
  } else {
    o.status = "APPROVED_FOR_SIMULATION";
  }
  o.auditLogId = audit("ORDER_CREATED", `Order ${o.orderId} ${o.symbol} ${o.direction} ${o.environment} → ${o.status}`, { o, guard: guard.reasons, account: acct.hardBlocks });
  orders.set(o.orderId, o);
  logOrderOutcome({ orderId: o.orderId, symbol: o.symbol, environment: o.environment, source: o.source, status: o.status, reason: o.rejectionReason, auditLogId: o.auditLogId });
  return o;
}

export function listOrders(filter?: { environment?: Environment; status?: OrderStatus; source?: OrderSource; limit?: number }) {
  let arr = Array.from(orders.values());
  if (filter?.environment) arr = arr.filter((o) => o.environment === filter.environment);
  if (filter?.status) arr = arr.filter((o) => o.status === filter.status);
  if (filter?.source) arr = arr.filter((o) => o.source === filter.source);
  arr.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return arr.slice(0, filter?.limit ?? 200);
}
export function getOrder(id: string) { return orders.get(id) ?? null; }

export function patchOrder(id: string, patch: Partial<Order>) {
  const o = orders.get(id); if (!o) return null;
  Object.assign(o, patch, { orderId: o.orderId, updatedAt: nowIso() });
  audit("ORDER_PATCHED", `Order ${id} patched`, { patch });
  return o;
}

export function cancelOrder(id: string) {
  const o = orders.get(id); if (!o) return null;
  if (o.status === "FILLED_SIMULATOR" || o.status === "CLOSED") return o;
  o.status = "CANCELLED"; o.updatedAt = nowIso();
  audit("ORDER_CANCELLED", `Order ${id} cancelled`, {});
  return o;
}

// ── Simulator execution ────────────────────────────────────────────────────
export function submitToSimulator(orderId: string): { order: Order; position?: Position; error?: string } {
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
    stopLoss: o.stopLoss, takeProfit: o.takeProfit,
    unrealizedPnL: 0, realizedPnL: 0, rMultiple: 0,
    riskAmount: risk, status: "OPEN",
    openedAt: nowIso(), dataSource: "SIMULATOR",
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
  const q = marketSimulator.quote(p.symbol); if (!q) return;
  p.currentPrice = p.direction === "BUY" ? q.bid : q.ask;
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
export function listPositions(filter?: { environment?: Environment; status?: PositionStatus; limit?: number }) {
  let arr = Array.from(positions.values());
  if (filter?.environment) arr = arr.filter((p) => p.environment === filter.environment);
  if (filter?.status) arr = arr.filter((p) => p.status === filter.status);
  arr.sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  return arr.slice(0, filter?.limit ?? 200);
}
export function getPosition(id: string) { return positions.get(id) ?? null; }

export function closePosition(id: string, reason: PositionStatus = "MANUALLY_CLOSED", overridePrice?: number) {
  const p = positions.get(id); if (!p) return null;
  if (p.status !== "OPEN") return p;
  if (overridePrice != null) p.currentPrice = overridePrice;
  p.realizedPnL = pnlFor(p);
  p.unrealizedPnL = 0;
  p.rMultiple = p.riskAmount > 0 ? Number((p.realizedPnL / p.riskAmount).toFixed(2)) : 0;
  p.status = reason; p.closedAt = nowIso();
  p.closeReason = reason;
  // Mark linked order CLOSED.
  const ord = orders.get(p.orderId); if (ord) { ord.status = "CLOSED"; ord.updatedAt = nowIso(); }
  audit("POSITION_CLOSED", `Closed ${p.symbol} ${p.direction} ${reason} pnl=${p.realizedPnL} R=${p.rMultiple}`, { positionId: id });
  return p;
}

export function partialClose(id: string, fraction: number) {
  const p = positions.get(id); if (!p || p.status !== "OPEN") return null;
  const f = Math.max(0.01, Math.min(0.99, fraction));
  const closedLots = Number((p.lotSize * f).toFixed(2));
  if (closedLots <= 0) return p;
  // Realize a partial PnL using a clone, then reduce the live position.
  const closedShare: Position = { ...p, lotSize: closedLots };
  const realized = pnlFor(closedShare);
  p.realizedPnL = Number((p.realizedPnL + realized).toFixed(2));
  p.lotSize = Number((p.lotSize - closedLots).toFixed(2));
  audit("POSITION_PARTIAL_CLOSE", `Partial close ${id} ${closedLots} lots, pnl+=${realized}`, {});
  return p;
}

export function moveStop(id: string, newStop: number) {
  const p = positions.get(id); if (!p || p.status !== "OPEN") return null;
  p.stopLoss = newStop;
  audit("POSITION_MOVE_STOP", `Move stop ${id} → ${newStop}`, {});
  return p;
}
export function moveTakeProfit(id: string, newTp: number) {
  const p = positions.get(id); if (!p || p.status !== "OPEN") return null;
  p.takeProfit = newTp;
  audit("POSITION_MOVE_TP", `Move TP ${id} → ${newTp}`, {});
  return p;
}
export function moveStopToBreakEven(id: string) {
  const p = positions.get(id); if (!p || p.status !== "OPEN") return null;
  p.stopLoss = p.entryPrice;
  audit("POSITION_BREAKEVEN", `Stop → BE ${id}`, {});
  return p;
}
export function applyTrailingStop(id: string, distance: number) {
  const p = positions.get(id); if (!p || p.status !== "OPEN") return null;
  p.trailingDistance = distance;
  audit("POSITION_TRAILING", `Trailing stop ${id} dist=${distance}`, {});
  return p;
}

// ── P/L engine ─────────────────────────────────────────────────────────────
function bucketByDay(p: Position): string { return (p.closedAt ?? p.openedAt).slice(0, 10); }

export function pnlSummary(env?: Environment) {
  const all = Array.from(positions.values()).filter((p) => !env || p.environment === env);
  const closed = all.filter((p) => p.status !== "OPEN");
  const open = all.filter((p) => p.status === "OPEN");
  const today = new Date().toISOString().slice(0, 10);
  const startWeek = new Date(); startWeek.setUTCDate(startWeek.getUTCDate() - 7);
  const startMonth = new Date(); startMonth.setUTCMonth(startMonth.getUTCMonth() - 1);

  const closedToday = closed.filter((p) => bucketByDay(p) === today);
  const closedWeek = closed.filter((p) => Date.parse(p.closedAt ?? p.openedAt) >= +startWeek);
  const closedMonth = closed.filter((p) => Date.parse(p.closedAt ?? p.openedAt) >= +startMonth);

  const sum = (arr: Position[]) => Number(arr.reduce((a, b) => a + b.realizedPnL, 0).toFixed(2));
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
    dailyPnL: sum(closedToday),
    weeklyPnL: sum(closedWeek),
    monthlyPnL: sum(closedMonth),
    openUnrealizedPnL: Number(open.reduce((a, b) => a + b.unrealizedPnL, 0).toFixed(2)),
    closedRealizedPnL: sum(closed),
    wins, losses,
    winRate: wins + losses > 0 ? Number(((wins / (wins + losses)) * 100).toFixed(1)) : 0,
    averageR: avgR,
    maxDrawdown: Number(dd.toFixed(2)),
    dataSource: "SIMULATOR" as const,
  };
}

export function pnlBy(group: "symbol" | "strategy" | "source" | "environment") {
  const all = Array.from(positions.values()).filter((p) => p.status !== "OPEN");
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

export function pnlDaily(env?: Environment) {
  const all = Array.from(positions.values()).filter((p) => p.status !== "OPEN" && (!env || p.environment === env));
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

// ── Broker reconciliation: NOT IMPLEMENTED, reported as such ───────────────
//
// This function used to return `brokerOrders: []`, `brokerPositions: []` and
// `mismatches: []` — empty arrays that the page rendered as "Broker orders 0 /
// Broker positions 0 / Mismatches 0". Nothing had been compared against any
// broker, so those zeros were a fabricated reconciliation result on a page
// titled "Compare local OMS state vs MT5 bridge state".
//
// Counts we cannot measure are now `null` with an explicit reason, and the
// local counts are labelled with what they actually are: the process-local
// in-memory simulator Maps, which are wiped on restart and are not a
// persisted book.
export function brokerReconStatus() {
  return {
    brokerConnected: false,
    // Kept for older clients; same meaning, same value.
    mt5Connected: false,
    /** null = never read. NOT "zero broker orders". */
    brokerOrders: null,
    brokerPositions: null,
    /** null = no comparison was performed, so no mismatch count exists. */
    mismatches: null,
    comparisonPerformed: false,
    comparisonUnavailableReason:
      "No broker snapshot has been read. Nothing on this endpoint has been compared against a broker.",
    localOrders: orders.size,
    localPositions: positions.size,
    localLiveIntents: Array.from(orders.values()).filter((o) => o.environment === "LIVE_TESTER_INTENT").length,
    localSource: "IN_MEMORY_SIMULATOR",
    localSourceNote:
      "Local counts come from this server process's in-memory simulator and reset when the process restarts.",
    syncStatus: "NOT_IMPLEMENTED",
    notice:
      "Broker reconciliation is not implemented on this endpoint. No broker state has been read and no comparison has been made.",
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
