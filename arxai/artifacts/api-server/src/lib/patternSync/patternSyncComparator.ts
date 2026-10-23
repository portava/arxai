// ── Pattern Sync comparator (Task #752, admin-cockpit-only) ─────────────────
//
// Multi-symbol comparison over a primary timeframe (H4) plus an optional entry
// timeframe (M15). PURE + DETERMINISTIC. Ranks leader / followers / lagging,
// computes same-pattern scores against the leader, H4/M15 alignment, fakeout
// risk, and a human-readable cockpit summary.
//
// SAFETY: ADVISORY ONLY. Consumed exclusively by the admin Pattern Sync Command
// Center. Never feeds the 18-gate live pipeline, kill switch, risk limits, or
// any execution path. No profit/guaranteed language.

import {
  type PatternSyncBias,
  type PatternSyncEngineResult,
  patternMatchScore,
} from "./patternSyncEngine.js";

export type PatternSyncRowStatus =
  | "Leader"
  | "Following"
  | "Lagging"
  | "Choppy"
  | "Confirmation Needed"
  | "Not Synced";

export type AlignmentVerdict = "aligned" | "not_aligned" | "unknown";

export interface PatternSyncSymbolInput {
  symbol: string;
  h4: PatternSyncEngineResult; // primary big-picture read
  m15?: PatternSyncEngineResult | null; // entry-timing read
}

export interface PatternSyncComparedRow {
  symbol: string;
  sufficient: boolean;
  patternType: string;
  status: PatternSyncRowStatus;
  trendBias: PatternSyncBias;
  matchScore: number;
  h4Bias: PatternSyncBias;
  m15Timing: PatternSyncBias | null;
  h4m15Alignment: AlignmentVerdict;
  entryQuality: "clean" | "late" | "countertrend" | "choppy" | "unknown";
  cleanSetupScore: number;
  choppinessScore: number;
  continuationScore: number;
  pullbackScore: number;
  fakeoutRiskScore: number;
  keySupport: number | null;
  keyResistance: number | null;
  lateEntryRisk: boolean;
  countertrendOpenTrade: boolean;
  nearKeyLevel: boolean;
  summary: string;
}

export interface PatternSyncComparison {
  timeframe: string;
  generatedAt: string;
  sufficient: boolean;
  leaderSymbol: string | null;
  followerSymbols: string[];
  laggingSymbols: string[];
  cleanestSymbol: string | null;
  choppiestSymbol: string | null;
  strongestBullishSymbol: string | null;
  strongestBearishSymbol: string | null;
  bestContinuationSymbol: string | null;
  bestPullbackSymbol: string | null;
  highestFakeoutRiskSymbol: string | null;
  sharedPatternType: string | null;
  sharedBias: PatternSyncBias | null;
  patternMatchScore: number; // leader-vs-cohort average
  rows: PatternSyncComparedRow[];
  readableSummary: string;
}

function alignmentOf(h4: PatternSyncBias, m15: PatternSyncBias | null): AlignmentVerdict {
  if (m15 == null) return "unknown";
  if (h4 === "ranging" || m15 === "ranging") return h4 === m15 ? "aligned" : "not_aligned";
  return h4 === m15 ? "aligned" : "not_aligned";
}

function entryQualityOf(row: {
  alignment: AlignmentVerdict;
  h4: PatternSyncEngineResult;
  m15?: PatternSyncEngineResult | null;
}): PatternSyncComparedRow["entryQuality"] {
  if (!row.h4.sufficient) return "unknown";
  if (row.h4.choppinessScore >= 65) return "choppy";
  if (row.alignment === "not_aligned") return "countertrend";
  const extension = row.m15?.signature.extension ?? row.h4.signature.extension;
  if (extension >= 0.9) return "late";
  if (row.h4.cleanSetupScore >= 60) return "clean";
  return "choppy";
}

function pickMax<T>(items: T[], score: (t: T) => number): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const it of items) {
    const s = score(it);
    if (s > bestScore) { bestScore = s; best = it; }
  }
  return best;
}

export function comparePatternSync(
  inputs: PatternSyncSymbolInput[],
  options?: { timeframe?: string; now?: Date },
): PatternSyncComparison {
  const timeframe = options?.timeframe ?? "H4";
  const generatedAt = (options?.now ?? new Date()).toISOString();
  const sufficientInputs = inputs.filter((i) => i.h4.sufficient);

  if (sufficientInputs.length === 0) {
    return {
      timeframe,
      generatedAt,
      sufficient: false,
      leaderSymbol: null,
      followerSymbols: [],
      laggingSymbols: [],
      cleanestSymbol: null,
      choppiestSymbol: null,
      strongestBullishSymbol: null,
      strongestBearishSymbol: null,
      bestContinuationSymbol: null,
      bestPullbackSymbol: null,
      highestFakeoutRiskSymbol: null,
      sharedPatternType: null,
      sharedBias: null,
      patternMatchScore: 0,
      rows: inputs.map((i) => emptyRow(i)),
      readableSummary: "Insufficient candle history across the comparison set — no Pattern Sync leader can be asserted.",
    };
  }

  // ── Shared bias = majority directional bias of the cohort. ───────────────
  const biasCounts: Record<PatternSyncBias, number> = { bullish: 0, bearish: 0, ranging: 0 };
  for (const i of sufficientInputs) biasCounts[i.h4.trendBias] += 1;
  const sharedBias: PatternSyncBias =
    biasCounts.bullish >= biasCounts.bearish && biasCounts.bullish >= biasCounts.ranging ? "bullish"
    : biasCounts.bearish >= biasCounts.ranging ? "bearish"
    : "ranging";

  // ── Leader = strongest aligned chart: clean + continuation + confidence,
  //    penalised by fakeout. Prefer charts that match the shared bias. ───────
  const leaderScore = (i: PatternSyncSymbolInput): number => {
    const r = i.h4;
    let s = r.cleanSetupScore * 0.35 + r.continuationScore * 0.35 + r.confidenceScore * 0.3;
    s -= r.fakeoutRiskScore * 0.25;
    if (sharedBias !== "ranging" && r.trendBias === sharedBias) s += 12;
    if (sharedBias !== "ranging" && r.trendBias !== sharedBias) s -= 20;
    return s;
  };
  const leaderInput = pickMax(sufficientInputs, leaderScore);
  const leader = leaderInput?.h4 ?? null;

  // ── Rows. ─────────────────────────────────────────────────────────────────
  const rows: PatternSyncComparedRow[] = inputs.map((i) => {
    if (!i.h4.sufficient) return emptyRow(i);
    const r = i.h4;
    const m15Bias = i.m15?.sufficient ? i.m15.trendBias : null;
    const alignment = alignmentOf(r.trendBias, m15Bias);
    const match = leader ? patternMatchScore(leader, r) : 0;
    const entryQuality = entryQualityOf({ alignment, h4: r, m15: i.m15 });
    const extension = i.m15?.signature.extension ?? r.signature.extension;
    const lateEntryRisk = extension >= 0.85;
    const countertrendOpenTrade = r.tradeContext?.tradeDirectionAlignment === "countertrend";
    const nearKeyLevel =
      r.resistanceBreakStatus === "rejected" || r.resistanceBreakStatus === "broken" ||
      r.supportHoldStatus === "broken" || r.supportHoldStatus === "holding";

    let status: PatternSyncRowStatus;
    if (leaderInput && i.symbol === leaderInput.symbol) status = "Leader";
    else if (r.choppinessScore >= 65) status = "Choppy";
    else if (match >= 80) status = "Following";
    else if (match >= 60) status = "Following";
    else if (match >= 40) status = "Confirmation Needed";
    else if (sharedBias !== "ranging" && r.trendBias === sharedBias) status = "Lagging";
    else status = "Not Synced";

    return {
      symbol: i.symbol,
      sufficient: true,
      patternType: r.detectedPatternType,
      status,
      trendBias: r.trendBias,
      matchScore: match,
      h4Bias: r.trendBias,
      m15Timing: m15Bias,
      h4m15Alignment: alignment,
      entryQuality,
      cleanSetupScore: r.cleanSetupScore,
      choppinessScore: r.choppinessScore,
      continuationScore: r.continuationScore,
      pullbackScore: r.pullbackScore,
      fakeoutRiskScore: r.fakeoutRiskScore,
      keySupport: r.levels.nearestSupport,
      keyResistance: r.levels.nearestResistance,
      lateEntryRisk,
      countertrendOpenTrade,
      nearKeyLevel,
      summary: r.readableSummary,
    };
  });

  const sufficientRows = rows.filter((r) => r.sufficient);
  const followerSymbols = sufficientRows.filter((r) => r.status === "Following").map((r) => r.symbol);
  const laggingSymbols = sufficientRows
    .filter((r) => r.status === "Lagging" || r.status === "Confirmation Needed")
    .map((r) => r.symbol);

  const cleanest = pickMax(sufficientInputs, (i) => i.h4.cleanSetupScore);
  const choppiest = pickMax(sufficientInputs, (i) => i.h4.choppinessScore);
  const strongestBull = pickMax(
    sufficientInputs.filter((i) => i.h4.trendBias === "bullish"),
    (i) => i.h4.continuationScore + i.h4.confidenceScore,
  );
  const strongestBear = pickMax(
    sufficientInputs.filter((i) => i.h4.trendBias === "bearish"),
    (i) => i.h4.continuationScore + i.h4.confidenceScore,
  );
  const bestContinuation = pickMax(sufficientInputs, (i) => i.h4.continuationScore);
  const bestPullback = pickMax(sufficientInputs, (i) => i.h4.pullbackScore);
  const highestFakeout = pickMax(sufficientInputs, (i) => i.h4.fakeoutRiskScore);

  const matchScores = sufficientRows
    .filter((r) => leaderInput && r.symbol !== leaderInput.symbol)
    .map((r) => r.matchScore);
  const avgMatch = matchScores.length > 0
    ? Math.round(matchScores.reduce((a, b) => a + b, 0) / matchScores.length)
    : (leader ? 100 : 0);

  const sharedPatternType = leader ? leader.detectedPatternType : null;

  const readableSummary = buildComparisonSummary({
    leaderInput, rows: sufficientRows, sharedBias, followerSymbols, laggingSymbols,
  });

  return {
    timeframe,
    generatedAt,
    sufficient: true,
    leaderSymbol: leaderInput?.symbol ?? null,
    followerSymbols,
    laggingSymbols,
    cleanestSymbol: cleanest?.symbol ?? null,
    choppiestSymbol: choppiest?.symbol ?? null,
    strongestBullishSymbol: strongestBull?.symbol ?? null,
    strongestBearishSymbol: strongestBear?.symbol ?? null,
    bestContinuationSymbol: bestContinuation?.symbol ?? null,
    bestPullbackSymbol: bestPullback?.symbol ?? null,
    highestFakeoutRiskSymbol: highestFakeout?.symbol ?? null,
    sharedPatternType,
    sharedBias,
    patternMatchScore: avgMatch,
    rows,
    readableSummary,
  };
}

function emptyRow(i: PatternSyncSymbolInput): PatternSyncComparedRow {
  return {
    symbol: i.symbol,
    sufficient: false,
    patternType: "unclear",
    status: "Not Synced",
    trendBias: "ranging",
    matchScore: 0,
    h4Bias: "ranging",
    m15Timing: null,
    h4m15Alignment: "unknown",
    entryQuality: "unknown",
    cleanSetupScore: 0,
    choppinessScore: 0,
    continuationScore: 0,
    pullbackScore: 0,
    fakeoutRiskScore: 0,
    keySupport: null,
    keyResistance: null,
    lateEntryRisk: false,
    countertrendOpenTrade: false,
    nearKeyLevel: false,
    summary: `Insufficient candle history for ${i.symbol}.`,
  };
}

function buildComparisonSummary(a: {
  leaderInput: PatternSyncSymbolInput | null;
  rows: PatternSyncComparedRow[];
  sharedBias: PatternSyncBias;
  followerSymbols: string[];
  laggingSymbols: string[];
}): string {
  if (!a.leaderInput) return "No clear Pattern Sync leader in the current comparison set.";
  const leader = a.leaderInput.h4;
  const parts: string[] = [];
  parts.push(`${a.leaderInput.symbol} is the current ${a.sharedBias} market leader (${leader.detectedPatternType.replace(/_/g, " ")}, clean setup ${leader.cleanSetupScore}/100).`);
  if (a.followerSymbols.length > 0) {
    parts.push(`Following the same pattern: ${a.followerSymbols.join(", ")}.`);
  }
  if (a.laggingSymbols.length > 0) {
    parts.push(`Lagging / needs confirmation: ${a.laggingSymbols.join(", ")} — wait for a clean break-and-hold before treating them as synced.`);
  }
  const counter = a.rows.filter((r) => r.countertrendOpenTrade).map((r) => r.symbol);
  if (counter.length > 0) parts.push(`Countertrend open-trade risk on: ${counter.join(", ")}.`);
  const fakeout = a.rows.filter((r) => r.fakeoutRiskScore >= 60).map((r) => r.symbol);
  if (fakeout.length > 0) parts.push(`Elevated fakeout risk near key levels on: ${fakeout.join(", ")}.`);
  parts.push("Advisory only — Pattern Sync does not place trades or bypass any safety gate.");
  return parts.join(" ");
}
