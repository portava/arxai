// Self-Trade AI — profile templates (Task #211, Foundation).
//
// Pure, side-effect-free constants. Each template is a named risk/behavior
// personality used to seed a new agent's settings row. Templates DO NOT execute
// anything; they only describe defaults the control room can later tune.
//
// SAFETY: these are seed defaults only. The 16-gate live pipeline, Risk
// Governor, per-user allocation, and kill switches remain the authoritative
// runtime guards regardless of any value here.

import type { SelfTradeProfileTemplate } from "@workspace/db";

export interface SelfTradeProfileSpec {
  template: SelfTradeProfileTemplate;
  displayName: string;
  tagline: string;
  // Default risk envelope (seeded into self_trade_agent_settings).
  riskPerTradePct: number;
  maxLotPerTrade: number;
  maxConcurrentPositions: number;
  maxDailyLossUsd: number;
  maxWeeklyLossUsd: number;
  dailyProfitGoalUsd: number;
  weeklyProfitGoalUsd: number;
  // Quota engine seeds (daily minimum 3 / base max 5 / opt-in extension).
  dailyMinTrades: number;
  baseMaxTrades: number;
  extensionEnabled: boolean;
  extensionMaxTrades: number;
  // Permission seeds.
  allowedSymbols: string[];
  allowedSessions: string[];
  allowedStrategies: string[];
  newsTradingPermission: "BLOCK" | "CAUTION" | "ALLOW";
  requireStopLoss: boolean;
  // Default autonomy level the control room starts the agent at (L0–L4).
  defaultAutonomyLevel: number;
}

// The five fleet personalities. Conservative → aggressive.
export const SELF_TRADE_PROFILES: Record<SelfTradeProfileTemplate, SelfTradeProfileSpec> = {
  ALPHA: {
    template: "ALPHA",
    displayName: "Alpha",
    tagline: "Disciplined all-rounder — balanced risk, majors only.",
    riskPerTradePct: 0.5,
    maxLotPerTrade: 0.05,
    maxConcurrentPositions: 2,
    maxDailyLossUsd: 100,
    maxWeeklyLossUsd: 300,
    dailyProfitGoalUsd: 150,
    weeklyProfitGoalUsd: 600,
    dailyMinTrades: 3,
    baseMaxTrades: 5,
    extensionEnabled: false,
    extensionMaxTrades: 0,
    allowedSymbols: ["EURUSD", "GBPUSD", "USDJPY"],
    allowedSessions: ["LONDON", "NEWYORK"],
    allowedStrategies: ["TREND_CONTINUATION", "BREAK_OF_STRUCTURE"],
    newsTradingPermission: "CAUTION",
    requireStopLoss: true,
    defaultAutonomyLevel: 0,
  },
  BLAZE: {
    template: "BLAZE",
    displayName: "Blaze",
    tagline: "High-tempo scalper — fast cycles, tight risk, news-averse.",
    riskPerTradePct: 0.75,
    maxLotPerTrade: 0.05,
    maxConcurrentPositions: 3,
    maxDailyLossUsd: 120,
    maxWeeklyLossUsd: 360,
    dailyProfitGoalUsd: 180,
    weeklyProfitGoalUsd: 720,
    dailyMinTrades: 5,
    baseMaxTrades: 5,
    extensionEnabled: true,
    extensionMaxTrades: 3,
    allowedSymbols: ["EURUSD", "GBPUSD"],
    allowedSessions: ["LONDON", "NEWYORK"],
    allowedStrategies: ["LIQUIDITY_SWEEP", "VOLATILITY_EXPANSION"],
    newsTradingPermission: "BLOCK",
    requireStopLoss: true,
    defaultAutonomyLevel: 0,
  },
  ATLAS: {
    template: "ATLAS",
    displayName: "Atlas",
    tagline: "Patient swing builder — wide stops, low frequency, trend-led.",
    riskPerTradePct: 1,
    maxLotPerTrade: 0.1,
    maxConcurrentPositions: 2,
    maxDailyLossUsd: 200,
    maxWeeklyLossUsd: 500,
    dailyProfitGoalUsd: 250,
    weeklyProfitGoalUsd: 1000,
    dailyMinTrades: 3,
    baseMaxTrades: 4,
    extensionEnabled: false,
    extensionMaxTrades: 0,
    allowedSymbols: ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"],
    allowedSessions: ["LONDON", "NEWYORK", "ASIA"],
    allowedStrategies: ["TREND_CONTINUATION"],
    newsTradingPermission: "CAUTION",
    requireStopLoss: true,
    defaultAutonomyLevel: 0,
  },
  NOVA: {
    template: "NOVA",
    displayName: "Nova",
    tagline: "Adaptive explorer — broad symbol set, moderate aggression.",
    riskPerTradePct: 1,
    maxLotPerTrade: 0.1,
    maxConcurrentPositions: 4,
    maxDailyLossUsd: 250,
    maxWeeklyLossUsd: 750,
    dailyProfitGoalUsd: 300,
    weeklyProfitGoalUsd: 1200,
    dailyMinTrades: 3,
    baseMaxTrades: 6,
    extensionEnabled: true,
    extensionMaxTrades: 4,
    allowedSymbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "XAUUSD"],
    allowedSessions: ["LONDON", "NEWYORK", "ASIA"],
    allowedStrategies: ["TREND_CONTINUATION", "BREAK_OF_STRUCTURE", "VOLATILITY_EXPANSION"],
    newsTradingPermission: "CAUTION",
    requireStopLoss: true,
    defaultAutonomyLevel: 0,
  },
  TITAN: {
    template: "TITAN",
    displayName: "Titan",
    tagline: "Aggressive growth — highest risk envelope, full strategy stack.",
    riskPerTradePct: 1.5,
    maxLotPerTrade: 0.2,
    maxConcurrentPositions: 5,
    maxDailyLossUsd: 400,
    maxWeeklyLossUsd: 1200,
    dailyProfitGoalUsd: 500,
    weeklyProfitGoalUsd: 2000,
    dailyMinTrades: 5,
    baseMaxTrades: 8,
    extensionEnabled: true,
    extensionMaxTrades: 6,
    allowedSymbols: ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "XAUUSD", "BTCUSD"],
    allowedSessions: ["LONDON", "NEWYORK", "ASIA"],
    allowedStrategies: [
      "TREND_CONTINUATION", "BREAK_OF_STRUCTURE", "LIQUIDITY_SWEEP", "VOLATILITY_EXPANSION",
    ],
    newsTradingPermission: "ALLOW",
    requireStopLoss: true,
    defaultAutonomyLevel: 0,
  },
};

export function getProfileSpec(
  template: SelfTradeProfileTemplate,
): SelfTradeProfileSpec {
  return SELF_TRADE_PROFILES[template];
}

export function listProfileSpecs(): SelfTradeProfileSpec[] {
  return Object.values(SELF_TRADE_PROFILES);
}
