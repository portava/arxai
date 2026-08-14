// ── Market Heat news-risk + upcoming-events contract (Task #611) ────────────
//
// PURE, deterministic, fail-closed derivations for the two distinct honesty
// surfaces the Global Market Heat card renders besides the country/currency
// grid: "today's news risk" and "upcoming high-impact events".
//
// NON-NEGOTIABLE HONESTY RULE: a missing / disconnected news provider NEVER
// produces a "low risk" verdict. When news is not positively connected the
// level is `unavailable` with an explicit "provider not connected" summary —
// never "low", never "no risk". Decision-support only; no execution coupling.

import type { NewsSignal } from "./heatVerdict.js";

export type MarketHeatNewsRiskLevel =
  | "high"
  | "elevated"
  | "moderate"
  | "low"
  | "unavailable";

/**
 * A single high-severity headline that contributed to the news-risk level.
 * Surfaced so users can judge relevance themselves. Decision-support only.
 */
export interface MarketHeatNewsHeadline {
  headline: string;
  /** Originating outlet/source ("none" when the provider omits it). */
  source: string | null;
  /** ISO publication timestamp (null when unknown — never fabricated). */
  publishedAt: string | null;
  /** Severity bucket the headline matched (drives the visual tone). */
  severity: "high" | "medium" | "low";
}

export interface MarketHeatNewsRisk {
  /** Honest risk level. `unavailable` whenever news is not connected. */
  level: MarketHeatNewsRiskLevel;
  /** Provider positively confirmed connected. */
  connected: boolean;
  /** News items observed (0 when not connected). */
  itemCount: number;
  /** Items matching a high-impact severity keyword (0 when not connected). */
  highImpactCount: number;
  /**
   * Top severity-ranked recent headlines that drove the score — empty when not
   * connected. The UI surfaces these only when risk is elevated/high.
   */
  topHeadlines: MarketHeatNewsHeadline[];
  /** Provider name ("none" when not configured). */
  provider: string;
  updatedAt: string | null;
  /** Human summary — never claims "low risk" when disconnected. */
  summary: string;
}

/** A single upcoming scheduled economic event (honesty-gated upstream). */
export interface MarketHeatEvent {
  id: string;
  title: string;
  currency: string;
  impact: "low" | "medium" | "high";
  /** ISO timestamp. */
  timeUtc: string;
  affectedSymbols: string[];
}

/** Minimal real-news-item shape the severity derivation reads. */
export interface NewsRiskItem {
  headline: string;
  summary?: string | null;
  /** ISO timestamp of publication (recency weighting). */
  publishedAt?: string | null;
  /** Originating outlet/source (carried through to surfaced headlines). */
  source?: string | null;
}

export interface NewsRiskScore {
  /** 0..1 severity+recency-weighted risk magnitude. */
  riskScore: number;
  /** Items matching a high-impact severity keyword. */
  highImpactCount: number;
  /** Items published within the last 2 hours. */
  recentCount: number;
}

// High-impact severity vocabulary — terms that signal market-moving risk.
const HIGH_IMPACT_TERMS = [
  "crash", "crisis", "war", "default", "collapse", "emergency", "recession",
  "sanction", "intervention", "shock", "plunge", "slump", "tumble", "panic",
  "rate hike", "rate cut", "rate decision", "interest rate", "inflation",
  "fomc", "central bank", "fed ", "federal reserve", "ecb", "boj", "boe",
  "nonfarm", "non-farm", "payrolls", "cpi", "geopolit", "downgrade",
];
// Medium-impact severity vocabulary — notable but not necessarily acute.
const MEDIUM_IMPACT_TERMS = [
  "gdp", "jobs", "unemployment", "earnings", "tariff", "trade deal", "election",
  "ppi", "retail sales", "manufacturing", "deficit", "stimulus", "guidance",
  "forecast", "outlook", "surge", "rally", "miss", "beat", "warning",
];

const RECENT_MS = 2 * 60 * 60 * 1000; // 2h — full recency weight.
const DECAY_MS = 24 * 60 * 60 * 1000; // 24h — floor recency weight.

function severityWeightOf(text: string): { weight: number; high: boolean } {
  const t = text.toLowerCase();
  if (HIGH_IMPACT_TERMS.some((w) => t.includes(w))) return { weight: 1, high: true };
  if (MEDIUM_IMPACT_TERMS.some((w) => t.includes(w))) return { weight: 0.5, high: false };
  // A real headline still carries baseline "something is happening" risk.
  return { weight: 0.15, high: false };
}

function recencyFactorOf(publishedAt: string | null | undefined, nowMs: number): number {
  if (!publishedAt) return 0.5; // unknown age ⇒ neutral, never a free "fresh".
  const ms = Date.parse(publishedAt);
  if (!Number.isFinite(ms)) return 0.5;
  const age = nowMs - ms;
  if (age <= RECENT_MS) return 1;
  if (age >= DECAY_MS) return 0.2;
  // Linear decay from 1.0 (2h) down to 0.2 (24h).
  const span = DECAY_MS - RECENT_MS;
  return 1 - ((age - RECENT_MS) / span) * 0.8;
}

/**
 * Derive a 0..1 news-risk magnitude from REAL provider news items, weighting
 * each item by severity (keyword vocabulary) AND recency (published age). The
 * strongest fresh signal dominates, with volume and average severity as
 * secondary contributors. Pure: same input ⇒ same output. Decision-support
 * only — no execution coupling. Empty/none ⇒ 0 (the caller, not this function,
 * decides connected vs unavailable honesty).
 */
export function deriveNewsRiskScore(
  items: readonly NewsRiskItem[],
  nowMs: number,
): NewsRiskScore {
  if (items.length === 0) {
    return { riskScore: 0, highImpactCount: 0, recentCount: 0 };
  }
  let maxItem = 0;
  let sumItem = 0;
  let highImpactCount = 0;
  let recentCount = 0;
  for (const it of items) {
    const text = `${it.headline ?? ""} ${it.summary ?? ""}`;
    const sev = severityWeightOf(text);
    if (sev.high) highImpactCount++;
    const recency = recencyFactorOf(it.publishedAt, nowMs);
    if (recency >= 1) recentCount++;
    const itemScore = sev.weight * recency;
    if (itemScore > maxItem) maxItem = itemScore;
    sumItem += itemScore;
  }
  const avgItem = sumItem / items.length;
  const volume = Math.min(items.length / 12, 1);
  const riskScore = Math.max(
    0,
    Math.min(1, maxItem * 0.6 + avgItem * 0.2 + volume * 0.2),
  );
  return { riskScore, highImpactCount, recentCount };
}

/**
 * Rank REAL provider news items by severity × recency and return the top N as
 * surfaced headlines (with their matched severity bucket). Pure: same input ⇒
 * same output (V8 sort is stable, so equal-score items keep provider order).
 * Decision-support only — never an execution input. Empty in ⇒ empty out.
 */
export function selectTopNewsHeadlines(
  items: readonly NewsRiskItem[],
  nowMs: number,
  limit = 3,
): MarketHeatNewsHeadline[] {
  if (items.length === 0 || limit <= 0) return [];
  const scored = items.map((it, i) => {
    const text = `${it.headline ?? ""} ${it.summary ?? ""}`;
    const sev = severityWeightOf(text);
    const recency = recencyFactorOf(it.publishedAt, nowMs);
    const severity: MarketHeatNewsHeadline["severity"] = sev.high
      ? "high"
      : sev.weight >= 0.5
        ? "medium"
        : "low";
    return {
      i,
      score: sev.weight * recency,
      headline: {
        headline: it.headline,
        source: it.source ?? null,
        publishedAt: it.publishedAt ?? null,
        severity,
      } satisfies MarketHeatNewsHeadline,
    };
  });
  // Skip empty headlines (defensive): a blank string carries no signal.
  return scored
    .filter((s) => s.headline.headline.trim().length > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.i - b.i))
    .slice(0, limit)
    .map((s) => s.headline);
}

/** Map a 0..1 risk score to an honest connected risk level. */
export function newsRiskLevelOf(
  riskScore: number,
): Exclude<MarketHeatNewsRiskLevel, "unavailable"> {
  const risk = Math.max(0, Math.min(1, riskScore));
  if (risk >= 0.66) return "high";
  if (risk >= 0.4) return "elevated";
  if (risk >= 0.2) return "moderate";
  return "low";
}

/**
 * Derive an honest "today's news risk" verdict from the normalized news signal.
 * Pure: same input ⇒ same output. Fail-closed: not connected ⇒ `unavailable`.
 */
export function deriveNewsRisk(
  news: NewsSignal,
  detail?: { topHeadlines?: MarketHeatNewsHeadline[]; highImpactCount?: number },
): MarketHeatNewsRisk {
  if (!news.connected) {
    return {
      level: "unavailable",
      connected: false,
      itemCount: 0,
      highImpactCount: 0,
      topHeadlines: [],
      provider: news.source || "none",
      updatedAt: null,
      summary: news.configured
        ? "News risk unavailable — provider not connected (not 'low risk')."
        : "News risk unavailable — no news provider configured (not 'low risk').",
    };
  }

  // Connected: a stale/delayed feed caps how strong a claim we make.
  const degraded = news.freshness === "STALE" || news.freshness === "DELAYED";

  let level: MarketHeatNewsRiskLevel = newsRiskLevelOf(news.riskScore);

  // Never let a degraded feed read as "high" — cap to elevated.
  if (degraded && level === "high") level = "elevated";

  const freshnessNote = degraded
    ? news.freshness === "STALE"
      ? " (feed stale — confidence reduced)"
      : " (feed delayed — confidence reduced)"
    : "";

  const summaryByLevel: Record<MarketHeatNewsRiskLevel, string> = {
    high: "High news risk — active high-impact headlines.",
    elevated: "Elevated news risk — notable headline activity.",
    moderate: "Moderate news risk — some headline activity.",
    low: "Low news risk — quiet headline flow.",
    unavailable: "News risk unavailable.",
  };

  return {
    level,
    connected: true,
    itemCount: news.itemCount,
    highImpactCount: Math.max(0, detail?.highImpactCount ?? 0),
    topHeadlines: detail?.topHeadlines ?? [],
    provider: news.source || "none",
    updatedAt: news.updatedAt,
    summary: summaryByLevel[level] + freshnessNote,
  };
}
