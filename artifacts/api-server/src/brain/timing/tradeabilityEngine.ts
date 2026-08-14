// Tradeability / Edge / Danger / Timing Grade Engine.
//
// Heat and tradeability are ALWAYS kept strictly independent:
// - High heat ≠ high tradeability (e.g. news-driven volatility is hot but untradeable)
// - Low heat ≠ untradeable (e.g. a tight compression can offer clean entry)
//
// Advisory only. Never an execution gate.

import type {
  TradeabilityScore,
  EdgeScore,
  DangerScore,
  TimingGrade,
  EntryPermission,
  MoveStage,
  HeatState,
  HeatScore,
} from "@workspace/domain/timing-brain";

export interface TradeabilityEngineInput {
  heatScore: HeatScore;
  heatState: HeatState;
  isFalseHeat: boolean;
  isQuietBeforeStorm: boolean;
  atrRatio: number | null;
  candleBodyRatio: number | null;
  spread: number | null;
  mid: number | null;
  isSynthetic: boolean;
  sessionTradeabilityBonus: number; // 0-25
  fakeoutRisk: number; // 0-100 from session engine
  newsBlocksTrade: boolean;
  newsPhase: string; // NewsPhase string
  dangerFromTrap: number; // 0-100
  dangerFromBroadFlow: number; // 0-100
  candles: Array<{ open: number; high: number; low: number; close: number }>;
}

export interface TradeabilityEngineOutput {
  tradeabilityScore: TradeabilityScore;
  edgeScore: EdgeScore;
  dangerScore: DangerScore;
  timingGrade: TimingGrade;
  entryPermission: EntryPermission;
  moveStage: MoveStage;
}

export function computeTradeability(input: TradeabilityEngineInput): TradeabilityEngineOutput {
  const {
    heatScore, heatState, isFalseHeat, isQuietBeforeStorm, atrRatio, candleBodyRatio,
    spread, mid, isSynthetic, sessionTradeabilityBonus, fakeoutRisk, newsBlocksTrade,
    newsPhase, dangerFromTrap, dangerFromBroadFlow, candles,
  } = input;

  // ─── Spread check ─────────────────────────────────────────────────────────
  const spreadBps = (spread != null && mid != null && mid > 0) ? (spread / mid) * 10_000 : null;
  const spreadTooHigh = spreadBps != null && spreadBps > (isSynthetic ? 60 : 12);
  const spreadPenalty = spreadTooHigh ? (isSynthetic ? 15 : 25) : 0;

  // ─── Move stage from candle extension ────────────────────────────────────
  const moveStage = computeMoveStage(candles, atrRatio);

  // ─── Edge score (0-100) ───────────────────────────────────────────────────
  // Edge = clean structure + momentum alignment + no false signals
  let edge = 50; // base
  if (heatState === "CLEAN_MOMENTUM") edge += 30;
  else if (heatState === "WAKE_UP")   edge += 20;
  else if (heatState === "COMPRESSION") edge += 15; // setup building
  else if (heatState === "DIRTY_HEAT")  edge -= 15;
  else if (heatState === "FALSE_HEAT")  edge -= 30;
  else if (heatState === "TRAP_HEAT")   edge -= 25;
  else if (heatState === "NEWS_HEAT")   edge -= 10; // news moves can be unidirectional

  if (candleBodyRatio != null) {
    if (candleBodyRatio >= 0.7) edge += 10;
    else if (candleBodyRatio < 0.3) edge -= 10;
  }
  if (atrRatio != null) {
    if (atrRatio >= 1.5 && atrRatio <= 2.5) edge += 8; // good expansion, not extreme
    if (atrRatio > 3.0) edge -= 15; // extreme — exhaustion zone
  }
  if (moveStage === "EXHAUSTED") edge -= 20;
  if (moveStage === "MATURE")    edge -= 8;
  edge -= spreadPenalty * 0.5;

  const edgeScore: EdgeScore = Math.min(100, Math.max(0, Math.round(edge)));

  // ─── Tradeability score (0-100) ──────────────────────────────────────────
  let trade = edgeScore * 0.6 + sessionTradeabilityBonus;
  if (newsBlocksTrade) trade -= 40;
  else if (newsPhase === "PRE_EVENT")  trade -= 15;
  else if (newsPhase === "POST_EVENT") trade -= 8;
  if (isFalseHeat) trade -= 25;
  if (spreadTooHigh) trade -= spreadPenalty;
  if (fakeoutRisk > 70) trade -= 15;
  if (moveStage === "EXHAUSTED") trade -= 20;
  if (isQuietBeforeStorm) trade += 5; // setup available

  const tradeabilityScore: TradeabilityScore = Math.min(100, Math.max(0, Math.round(trade)));

  // ─── Danger score (0-100) ─────────────────────────────────────────────────
  let danger = 20; // base
  danger += Math.round(dangerFromTrap * 0.4);
  danger += Math.round(dangerFromBroadFlow * 0.2);
  if (newsBlocksTrade) danger += 30;
  else if (newsPhase === "AT_EVENT") danger += 40;
  else if (newsPhase === "PRE_EVENT") danger += 20;
  if (heatState === "EXHAUSTION_HEAT") danger += 20;
  if (heatState === "TRAP_HEAT")       danger += 30;
  if (heatState === "FALSE_HEAT")      danger += 15;
  if (fakeoutRisk > 70) danger += 15;
  if (moveStage === "EXHAUSTED") danger += 15;
  if (spreadTooHigh) danger += 10;

  const dangerScore: DangerScore = Math.min(100, Math.max(0, Math.round(danger)));

  // ─── Timing grade ─────────────────────────────────────────────────────────
  const composite = tradeabilityScore * 0.5 + edgeScore * 0.3 - dangerScore * 0.2;
  let timingGrade: TimingGrade;
  if (composite >= 80)      timingGrade = "A+";
  else if (composite >= 68) timingGrade = "A";
  else if (composite >= 55) timingGrade = "B";
  else if (composite >= 42) timingGrade = "C";
  else if (composite >= 28) timingGrade = "D";
  else                      timingGrade = "F";

  // ─── Entry permission ─────────────────────────────────────────────────────
  let entryPermission: EntryPermission;
  if (newsBlocksTrade || newsPhase === "AT_EVENT") {
    entryPermission = "WAIT_NEWS";
  } else if (dangerScore >= 75 || heatState === "TRAP_HEAT") {
    entryPermission = "STAND_DOWN";
  } else if (tradeabilityScore < 25) {
    entryPermission = "NO_TRADE";
  } else if (tradeabilityScore < 50 || moveStage === "EXHAUSTED") {
    entryPermission = "WAIT_FOR_ENTRY";
  } else {
    entryPermission = "GO";
  }

  return { tradeabilityScore, edgeScore, dangerScore, timingGrade, entryPermission, moveStage };
}

function computeMoveStage(
  candles: TradeabilityEngineInput["candles"],
  atrRatio: number | null,
): MoveStage {
  if (candles.length < 20) return "EARLY";

  // Extension = how far current price has moved from 20-candle midpoint
  const recent = candles.slice(-20);
  const highs = recent.map((c) => c.high);
  const lows = recent.map((c) => c.low);
  const sessionHigh = Math.max(...highs);
  const sessionLow = Math.min(...lows);
  const sessionRange = sessionHigh - sessionLow;
  const lastClose = candles[candles.length - 1]!.close;

  // Where within the range is the current price?
  const pctInRange = sessionRange > 0
    ? Math.abs(lastClose - (sessionHigh + sessionLow) / 2) / (sessionRange / 2)
    : 0;

  // ATR ratio also indicates exhaustion
  const atrExtreme = atrRatio != null && atrRatio > 2.5;

  if (pctInRange >= 0.9 || atrExtreme) return "EXHAUSTED";
  if (pctInRange >= 0.7) return "MATURE";
  if (pctInRange >= 0.4) return "DEVELOPING";
  return "EARLY";
}
