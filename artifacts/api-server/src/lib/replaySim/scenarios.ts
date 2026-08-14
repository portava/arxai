// Build JJ — Scenario generation (synthetic + recorded). REPLAY_ONLY.
import { randomUUID } from "node:crypto";
import { db, replayScenariosTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface Candle {
  t: number;       // unix ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type MarketCondition =
  | "TRENDING_UP" | "TRENDING_DOWN" | "RANGING"
  | "VOLATILE"   | "CHOPPY"        | "BREAKOUT" | "REVERSAL";

export interface Scenario {
  scenarioId: string;
  title: string;
  symbol: string;
  timeframe: string;
  source: "SYNTHETIC" | "RECORDED" | "IMPORTED";
  marketCondition: MarketCondition;
  candles: Candle[];
  notes: string;
}

function seedrand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}

export function generateSyntheticCandles(
  marketCondition: MarketCondition,
  count: number,
  basePrice = 1000,
  seed = 42,
): Candle[] {
  const rand = seedrand(seed);
  const candles: Candle[] = [];
  let price = basePrice;
  let trend = 0;
  switch (marketCondition) {
    case "TRENDING_UP":   trend = +0.5; break;
    case "TRENDING_DOWN": trend = -0.5; break;
    case "BREAKOUT":      trend = +0.2; break;
    case "REVERSAL":      trend = +0.4; break;
    case "VOLATILE":      trend = 0;    break;
    case "CHOPPY":        trend = 0;    break;
    default:              trend = 0;    break;
  }
  const volMul = marketCondition === "VOLATILE" ? 3 : marketCondition === "CHOPPY" ? 1.8 : 1;
  const startT = Date.UTC(2026, 0, 1, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    let driftStep = trend;
    if (marketCondition === "REVERSAL" && i > Math.floor(count / 2)) driftStep = -0.6;
    if (marketCondition === "BREAKOUT" && i > Math.floor(count * 0.6)) driftStep = +1.5;
    const noise = (rand() - 0.5) * 4 * volMul;
    const o = price;
    const c = +(o + driftStep + noise).toFixed(4);
    const h = +(Math.max(o, c) + Math.abs(noise) * 0.5).toFixed(4);
    const l = +(Math.min(o, c) - Math.abs(noise) * 0.5).toFixed(4);
    const v = Math.floor(100 + rand() * 900);
    candles.push({ t: startT + i * 5 * 60_000, o, h, l, c, v });
    price = c;
  }
  return candles;
}

export function buildSyntheticScenario(opts: {
  title?: string;
  symbol?: string;
  timeframe?: string;
  marketCondition?: MarketCondition;
  candleCount?: number;
  basePrice?: number;
  seed?: number;
  notes?: string;
}): Scenario {
  const marketCondition = opts.marketCondition ?? "TRENDING_UP";
  const symbol = opts.symbol ?? "V75";
  const timeframe = opts.timeframe ?? "M5";
  const candleCount = Math.max(20, Math.min(opts.candleCount ?? 120, 2000));
  return {
    scenarioId: `scn_${randomUUID()}`,
    title: opts.title ?? `${marketCondition} ${symbol} ${timeframe} (${candleCount} candles)`,
    symbol,
    timeframe,
    source: "SYNTHETIC",
    marketCondition,
    candles: generateSyntheticCandles(marketCondition, candleCount, opts.basePrice ?? 1000, opts.seed ?? Date.now() & 0xFFFF),
    notes: opts.notes ?? "Synthetic scenario for REPLAY_ONLY use. Not real market data.",
  };
}

export async function persistScenario(s: Scenario) {
  await db.insert(replayScenariosTable).values({
    scenarioId: s.scenarioId,
    title: s.title,
    symbol: s.symbol,
    timeframe: s.timeframe,
    source: s.source,
    marketCondition: s.marketCondition,
    candles: s.candles,
    notes: s.notes,
  });
}

export async function listScenarios(limit = 50) {
  const rows = await db.select().from(replayScenariosTable).limit(limit);
  return rows.map(r => ({
    scenarioId: r.scenarioId,
    title: r.title,
    symbol: r.symbol,
    timeframe: r.timeframe,
    source: r.source,
    marketCondition: r.marketCondition,
    candleCount: Array.isArray(r.candles) ? (r.candles as unknown[]).length : 0,
    notes: r.notes,
    createdAt: r.createdAt,
  }));
}

export async function getScenario(scenarioId: string): Promise<Scenario | null> {
  const rows = await db.select().from(replayScenariosTable).where(eq(replayScenariosTable.scenarioId, scenarioId)).limit(1);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    scenarioId: r.scenarioId,
    title: r.title,
    symbol: r.symbol,
    timeframe: r.timeframe,
    source: r.source as Scenario["source"],
    marketCondition: r.marketCondition as MarketCondition,
    candles: r.candles as Candle[],
    notes: r.notes,
  };
}

export function validateCandles(candles: unknown): { valid: boolean; reason?: string; candles?: Candle[] } {
  if (!Array.isArray(candles)) return { valid: false, reason: "candles must be an array" };
  if (candles.length === 0) return { valid: false, reason: "candles array is empty" };
  if (candles.length < 5) return { valid: false, reason: "need at least 5 candles for replay" };
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i] as Partial<Candle>;
    if (typeof c.o !== "number" || typeof c.h !== "number" || typeof c.l !== "number" || typeof c.c !== "number") {
      return { valid: false, reason: `candle[${i}] missing OHLC numeric fields` };
    }
    if (c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c)) {
      return { valid: false, reason: `candle[${i}] OHLC inconsistent (high<max(o,c) or low>min(o,c))` };
    }
    out.push({ t: typeof c.t === "number" ? c.t : Date.now() + i * 60_000, o: c.o, h: c.h, l: c.l, c: c.c, v: typeof c.v === "number" ? c.v : 1 });
  }
  return { valid: true, candles: out };
}
