// Trap Probability + Room-To-Move Engines.
//
// Trap probability: scored from session/PDH-PDL sweeps, oversized post-compression
// candles, weak follow-through, spread widening, broad conflict.
//
// Room to move: distance to nearest liquidity targets vs average session range.
//
// Advisory only. Never an execution gate.

import type { TrapProbability, RoomToMove, BuyPressure, SellPressure } from "@workspace/domain/timing-brain";

export interface TrapRoomInput {
  candles: Array<{ open: number; high: number; low: number; close: number; volume: number }>;
  spread: number | null;
  mid: number | null;
  isSynthetic: boolean;
  killZoneActive: boolean;
  fakeoutRisk: number; // 0-100 from session engine
  atrRatio: number | null;
  heatState: string;
  broadFlowVerdict: string;
}

export interface TrapRoomOutput {
  trapProbability: TrapProbability;
  trapTypes: string[];
  roomToMove: RoomToMove;
  nearestResistance: number | null;
  nearestSupport: number | null;
  distanceToTargetPips: number | null;
  buyPressure: BuyPressure;
  sellPressure: SellPressure;
}

export function computeTrapAndRoom(input: TrapRoomInput): TrapRoomOutput {
  const { candles, spread, mid, isSynthetic, killZoneActive, fakeoutRisk, atrRatio, heatState, broadFlowVerdict } = input;

  if (candles.length < 15) {
    return {
      trapProbability: Math.min(100, Math.max(0, fakeoutRisk)),
      trapTypes: [],
      roomToMove: 50,
      nearestResistance: null,
      nearestSupport: null,
      distanceToTargetPips: null,
      buyPressure: 50,
      sellPressure: 50,
    };
  }

  const trapTypes: string[] = [];
  let trapScore = 0;

  const last = candles[candles.length - 1]!;
  const prev = candles.slice(-10, -1);
  const recent20 = candles.slice(-20);

  // ─── PDH/PDL sweep detection ──────────────────────────────────────────────
  if (candles.length >= 40) {
    const yesterday = candles.slice(-40, -20);
    const pdh = Math.max(...yesterday.map((c) => c.high));
    const pdl = Math.min(...yesterday.map((c) => c.low));

    // Bearish sweep: price swept above PDH but closed back below
    if (last.high > pdh && last.close < pdh) {
      trapScore += 35;
      trapTypes.push("PDH_SWEEP_BEARISH");
    }
    // Bullish sweep: price swept below PDL but closed back above
    if (last.low < pdl && last.close > pdl) {
      trapScore += 35;
      trapTypes.push("PDL_SWEEP_BULLISH");
    }
  }

  // ─── Post-compression oversize candle ────────────────────────────────────
  if (heatState === "WAKE_UP" && atrRatio != null && atrRatio > 2.0) {
    const lastRange = last.high - last.low;
    const prevAvgRange = prev.reduce((s, c) => s + (c.high - c.low), 0) / (prev.length || 1);
    if (prevAvgRange > 0 && lastRange / prevAvgRange > 2.5) {
      trapScore += 25;
      trapTypes.push("POST_COMPRESSION_OVERSIZE");
    }
  }

  // ─── Weak follow-through (wick dominance) ────────────────────────────────
  const body = Math.abs(last.close - last.open);
  const fullRange = last.high - last.low;
  if (fullRange > 0 && body / fullRange < 0.25) {
    trapScore += 20;
    trapTypes.push("WEAK_FOLLOW_THROUGH");
  }

  // ─── Spread widening (false breakout signal) ──────────────────────────────
  const spreadBps = (spread != null && mid != null && mid > 0) ? (spread / mid) * 10_000 : null;
  if (spreadBps != null && spreadBps > (isSynthetic ? 50 : 12)) {
    trapScore += 20;
    trapTypes.push("SPREAD_WIDENING");
  }

  // ─── Broad flow conflict ──────────────────────────────────────────────────
  if (broadFlowVerdict === "CONFLICTED" || broadFlowVerdict === "OPPOSING") {
    trapScore += 15;
    trapTypes.push("BROAD_FLOW_CONFLICT");
  }

  // ─── Kill zone session fakeout risk ──────────────────────────────────────
  if (killZoneActive && fakeoutRisk > 55) {
    trapScore += Math.round((fakeoutRisk - 55) * 0.4);
    trapTypes.push("KILL_ZONE_FAKEOUT_RISK");
  }

  const trapProbability: TrapProbability = Math.min(100, Math.max(0, trapScore));

  // ─── Support / resistance levels ─────────────────────────────────────────
  const lookback = candles.slice(-80);
  const swingHighs = detectSwingHighs(lookback, 3);
  const swingLows = detectSwingLows(lookback, 3);
  const price = last.close;

  const resistanceLevels = swingHighs.filter((h) => h > price).sort((a, b) => a - b);
  const supportLevels = swingLows.filter((l) => l < price).sort((a, b) => b - a);

  const nearestResistance = resistanceLevels[0] ?? null;
  const nearestSupport = supportLevels[0] ?? null;

  // ─── Room to move ─────────────────────────────────────────────────────────
  let roomToMove: RoomToMove = 50;
  if (nearestResistance != null && nearestSupport != null) {
    const distUp = nearestResistance - price;
    const distDown = price - nearestSupport;
    const atr20 = computeSimpleATR(recent20, 14);
    const maxDist = atr20 * 3; // 3× ATR = "full room"
    const distPips = Math.min(distUp, distDown) / (mid ?? (price || 1)) * 10_000;
    roomToMove = Math.min(100, Math.max(0, Math.round((Math.min(distUp, distDown) / (maxDist || 0.001)) * 100)));
    const distToTargetPips = distPips;
    const distanceToTargetPips = Math.round(distToTargetPips * 10) / 10;

    // ─── Buy/sell pressure (volume-weighted) ────────────────────────────────
    const { buy, sell } = computePressure(candles.slice(-20));

    return {
      trapProbability,
      trapTypes,
      roomToMove,
      nearestResistance: Math.round(nearestResistance * 100000) / 100000,
      nearestSupport: Math.round(nearestSupport * 100000) / 100000,
      distanceToTargetPips,
      buyPressure: buy,
      sellPressure: sell,
    };
  }

  const { buy, sell } = computePressure(candles.slice(-20));
  return {
    trapProbability,
    trapTypes,
    roomToMove,
    nearestResistance,
    nearestSupport,
    distanceToTargetPips: null,
    buyPressure: buy,
    sellPressure: sell,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function detectSwingHighs(candles: TrapRoomInput["candles"], lookback: number): number[] {
  const result: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]!;
    const before = candles.slice(i - lookback, i);
    const after = candles.slice(i + 1, i + lookback + 1);
    if (before.every((x) => x.high <= c.high) && after.every((x) => x.high < c.high)) {
      result.push(c.high);
    }
  }
  return result.slice(-5);
}

function detectSwingLows(candles: TrapRoomInput["candles"], lookback: number): number[] {
  const result: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]!;
    const before = candles.slice(i - lookback, i);
    const after = candles.slice(i + 1, i + lookback + 1);
    if (before.every((x) => x.low >= c.low) && after.every((x) => x.low > c.low)) {
      result.push(c.low);
    }
  }
  return result.slice(-5);
}

function computeSimpleATR(candles: TrapRoomInput["candles"], period: number): number {
  if (candles.length < 2) return 0;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i]!;
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  const s = trs.slice(-period);
  return s.reduce((a, b) => a + b, 0) / (s.length || 1);
}

function computePressure(candles: TrapRoomInput["candles"]): { buy: BuyPressure; sell: SellPressure } {
  if (candles.length === 0) return { buy: 50, sell: 50 };
  let buyVol = 0;
  let sellVol = 0;
  for (const c of candles) {
    if (c.close >= c.open) buyVol += c.volume;
    else sellVol += c.volume;
  }
  const total = buyVol + sellVol;
  if (total === 0) return { buy: 50, sell: 50 };
  const buy = Math.min(100, Math.max(0, Math.round((buyVol / total) * 100)));
  return { buy, sell: 100 - buy };
}
