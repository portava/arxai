// ── Honesty-aware Market Heat verdict (Task #611) ───────────────────────────
//
// PURE, deterministic heat-verdict calculation. The single contract the heat
// page, Ruby, and the impact radar all consume.
//
// NON-NEGOTIABLE HONESTY RULES (enforced here, tested deterministically):
//  - News and economic-calendar signals contribute to heat ONLY when their
//    provider reports `connected`. A missing/disconnected provider NEVER
//    produces fake neutral / low-risk heat.
//  - Both fresh price + macro ⇒ "confirmed heat".
//  - Price present but news/calendar missing ⇒ "price-only heat", confidence
//    capped (never high).
//  - Any active source stale/delayed ⇒ display allowed but confidence capped
//    to low; price unavailable ⇒ never high-confidence.
//  - Macro (country/currency/global) scope with NO connected news/calendar ⇒
//    gray "unavailable" — explicitly "News unavailable" / "Calendar
//    unavailable", never "no events" / "low risk".
//  - All sources missing ⇒ clean gray "unavailable" degraded state.
//
// DECISION-SUPPORT ONLY: a verdict can explain, warn, rank, or downgrade, but
// `advisoryOnly` is a const `true` and there is NO field here that any
// execution gate reads. It can never grant or bypass a live-trade gate.

export type MarketHeatScope =
  | "global"
  | "country"
  | "currency"
  | "symbol"
  | "synthetic";

export type MarketHeatDirection =
  | "bullish"
  | "bearish"
  | "neutral"
  | "unavailable";

export type MarketHeatIntensity =
  | "extreme"
  | "high"
  | "moderate"
  | "low"
  | "calm"
  | "unavailable";

/** Overall verdict on how trustworthy/complete the heat read is. */
export type MarketHeatSourceStatus =
  | "confirmed"
  | "price_only"
  | "delayed"
  | "stale"
  | "provider_missing"
  | "unavailable";

export type MarketHeatConfidence = "high" | "medium" | "low" | "none";

/** Per-source liveness state. */
export type HeatSourceStatus =
  | "live"
  | "delayed"
  | "stale"
  | "missing"
  | "unavailable"
  | "error";

export interface MarketHeatSource {
  kind: "price" | "news" | "calendar";
  /** Provider name (e.g. "twelve_data", "none"). */
  name: string;
  status: HeatSourceStatus;
  configured: boolean;
  connected: boolean;
  updatedAt: string | null;
  /** Candles / news items / events observed. */
  recordCount: number;
  note: string | null;
}

export interface MarketHeatVerdict {
  id: string;
  scope: MarketHeatScope;
  /** Stable key ("USD", "US", "EURUSD", "synthetic"). */
  key: string;
  displayName: string;
  /** -100..+100. Sign = direction, magnitude = intensity. 0 when unavailable. */
  heatScore: number;
  direction: MarketHeatDirection;
  intensity: MarketHeatIntensity;
  sourceStatus: MarketHeatSourceStatus;
  priceSource: MarketHeatSource;
  newsSource: MarketHeatSource;
  calendarSource: MarketHeatSource;
  priceUpdatedAt: string | null;
  newsUpdatedAt: string | null;
  calendarUpdatedAt: string | null;
  confidence: MarketHeatConfidence;
  reason: string;
  affectedSymbols: string[];
  warnings: string[];
  /** Const marker — heat is decision-support only, never an execution gate. */
  advisoryOnly: true;
}

// ── Signal inputs ────────────────────────────────────────────────────────────

export interface PriceSignal {
  available: boolean;
  /** -1..+1 normalized directional momentum. */
  momentum: number;
  /** 0..1 normalized volatility (intensity contributor). */
  volatility: number;
  freshness: "LIVE" | "DELAYED" | "STALE" | "UNAVAILABLE";
  updatedAt: string | null;
  source: string;
  candleCount: number;
}

export interface NewsSignal {
  configured: boolean;
  connected: boolean;
  /** 0..1 news-driven risk magnitude — used ONLY when connected. */
  riskScore: number;
  itemCount: number;
  updatedAt: string | null;
  source: string;
  freshness: "LIVE" | "DELAYED" | "STALE" | "UNAVAILABLE";
}

export interface CalendarSignal {
  configured: boolean;
  connected: boolean;
  /** 0..1 calendar-driven impact magnitude — used ONLY when connected. */
  impactScore: number;
  eventCount: number;
  highImpactActive: boolean;
  updatedAt: string | null;
  source: string;
}

export interface HeatVerdictInput {
  id: string;
  scope: MarketHeatScope;
  key: string;
  displayName: string;
  affectedSymbols: string[];
  price: PriceSignal;
  news: NewsSignal;
  calendar: CalendarSignal;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function priceSourceOf(p: PriceSignal): MarketHeatSource {
  const status: HeatSourceStatus =
    !p.available || p.freshness === "UNAVAILABLE"
      ? "unavailable"
      : p.freshness === "STALE"
        ? "stale"
        : p.freshness === "DELAYED"
          ? "delayed"
          : "live";
  return {
    kind: "price",
    name: p.source || "none",
    status,
    configured: p.source !== "none" && p.source !== "",
    connected: p.available && p.candleCount > 0,
    updatedAt: p.updatedAt,
    recordCount: p.candleCount,
    note:
      status === "unavailable"
        ? "No live price feed for this market."
        : status === "stale"
          ? "Price feed is stale."
          : status === "delayed"
            ? "Price feed is delayed."
            : null,
  };
}

function newsSourceOf(n: NewsSignal): MarketHeatSource {
  const status: HeatSourceStatus = !n.configured
    ? "missing"
    : !n.connected
      ? "unavailable"
      : n.freshness === "STALE"
        ? "stale"
        : n.freshness === "DELAYED"
          ? "delayed"
          : "live";
  return {
    kind: "news",
    name: n.source || "none",
    status,
    configured: n.configured,
    connected: n.connected,
    updatedAt: n.updatedAt,
    recordCount: n.itemCount,
    note: n.connected ? null : "News provider not connected.",
  };
}

function calendarSourceOf(c: CalendarSignal): MarketHeatSource {
  const status: HeatSourceStatus = !c.configured
    ? "missing"
    : !c.connected
      ? "unavailable"
      : "live";
  return {
    kind: "calendar",
    name: c.source || "none",
    status,
    configured: c.configured,
    connected: c.connected,
    updatedAt: c.updatedAt,
    recordCount: c.eventCount,
    note: c.connected ? null : "Economic-calendar provider not connected.",
  };
}

function intensityOf(magnitude: number): MarketHeatIntensity {
  if (magnitude >= 0.8) return "extreme";
  if (magnitude >= 0.6) return "high";
  if (magnitude >= 0.4) return "moderate";
  if (magnitude >= 0.2) return "low";
  return "calm";
}

function directionOf(momentum: number, hasPrice: boolean): MarketHeatDirection {
  if (!hasPrice) return "neutral";
  if (momentum >= 0.12) return "bullish";
  if (momentum <= -0.12) return "bearish";
  return "neutral";
}

// ── The verdict ──────────────────────────────────────────────────────────────

/**
 * Compute an honesty-aware heat verdict. Pure: same input ⇒ same output.
 */
export function computeHeatVerdict(input: HeatVerdictInput): MarketHeatVerdict {
  const { price, news, calendar, scope } = input;

  const priceSource = priceSourceOf(price);
  const newsSource = newsSourceOf(news);
  const calendarSource = calendarSourceOf(calendar);

  const priceActive = priceSource.connected;
  const newsActive = news.connected;
  const calActive = calendar.connected;
  const macroActive = newsActive || calActive;
  const isMacro =
    scope === "country" || scope === "currency" || scope === "global";

  const warnings: string[] = [];
  if (!newsActive) warnings.push("News provider not connected.");
  if (!calActive) warnings.push("Economic-calendar provider not connected.");

  const base = {
    id: input.id,
    scope: input.scope,
    key: input.key,
    displayName: input.displayName,
    priceSource,
    newsSource,
    calendarSource,
    priceUpdatedAt: price.updatedAt,
    newsUpdatedAt: news.updatedAt,
    calendarUpdatedAt: calendar.updatedAt,
    affectedSymbols: input.affectedSymbols,
    advisoryOnly: true as const,
  };

  // ── Synthetic scope: immune to real-world macro. Heat is price-only here and
  //    that is the HONEST, complete answer (not a degraded state). ──
  if (scope === "synthetic") {
    if (!priceActive) {
      return {
        ...base,
        heatScore: 0,
        direction: "unavailable",
        intensity: "unavailable",
        sourceStatus: "unavailable",
        confidence: "none",
        reason: "No live price feed for this synthetic market.",
        warnings: ["No live price feed for this synthetic market."],
      };
    }
    const magnitude = clamp(
      Math.abs(price.momentum) * 0.7 + price.volatility * 0.3,
      0,
      1,
    );
    const heatScore = Math.round(
      clamp(price.momentum, -1, 1) * magnitude * 100,
    );
    const delayed = price.freshness !== "LIVE";
    return {
      ...base,
      heatScore,
      direction: directionOf(price.momentum, true),
      intensity: intensityOf(magnitude),
      sourceStatus: delayed
        ? price.freshness === "STALE"
          ? "stale"
          : "delayed"
        : "price_only",
      confidence: delayed ? "low" : "medium",
      reason:
        "Synthetic market — driven by price action only (immune to real-world news/economic events).",
      warnings: [],
    };
  }

  // ── Macro scope (country / currency / global): requires a connected
  //    news or economic-calendar provider. Without it, we NEVER fabricate
  //    country heat from price alone — it is honestly unavailable. ──
  if (isMacro && !macroActive) {
    const newsMissing = !newsActive;
    const calMissing = !calActive;
    const reason =
      newsMissing && calMissing
        ? "News and economic-calendar providers are not connected — country heat is unavailable (not low risk, not 'no events')."
        : newsMissing
          ? "News provider is not connected — news heat is unavailable (not low risk)."
          : "Economic-calendar provider is not connected — event heat is unavailable (not 'no events').";
    return {
      ...base,
      heatScore: 0,
      direction: "unavailable",
      intensity: "unavailable",
      sourceStatus: "provider_missing",
      confidence: "none",
      reason,
      warnings,
    };
  }

  // ── Symbol scope with nothing available ⇒ gray unavailable. ──
  if (!priceActive && !macroActive) {
    return {
      ...base,
      heatScore: 0,
      direction: "unavailable",
      intensity: "unavailable",
      sourceStatus: "unavailable",
      confidence: "none",
      reason:
        "No live price, news, or economic-calendar data is available for this market.",
      warnings,
    };
  }

  // ── At least one real signal is active. Combine ONLY connected sources. ──
  let magnitude = 0;
  let weight = 0;
  if (priceActive) {
    const pm = clamp(Math.abs(price.momentum) * 0.7 + price.volatility * 0.3, 0, 1);
    magnitude += pm * 0.5;
    weight += 0.5;
  }
  if (newsActive) {
    magnitude += clamp(news.riskScore, 0, 1) * 0.3;
    weight += 0.3;
  }
  if (calActive) {
    magnitude += clamp(calendar.impactScore, 0, 1) * 0.2;
    weight += 0.2;
  }
  magnitude = weight > 0 ? clamp(magnitude / weight, 0, 1) : 0;

  const direction = directionOf(price.momentum, priceActive);
  const sign = direction === "bullish" ? 1 : direction === "bearish" ? -1 : 0;
  const heatScore = Math.round(
    (sign !== 0 ? sign : 1) * magnitude * 100 * (sign === 0 ? 1 : 1),
  );

  // Source status + confidence per the honesty ladder.
  const anyDelayed =
    (priceActive && price.freshness === "DELAYED") ||
    (newsActive && news.freshness === "DELAYED");
  const anyStale =
    (priceActive && price.freshness === "STALE") ||
    (newsActive && news.freshness === "STALE");

  let sourceStatus: MarketHeatSourceStatus;
  let confidence: MarketHeatConfidence;

  if (anyStale) {
    sourceStatus = "stale";
    confidence = "low";
  } else if (anyDelayed) {
    sourceStatus = "delayed";
    confidence = "low";
  } else if (priceActive && newsActive && calActive) {
    sourceStatus = "confirmed";
    confidence = magnitude >= 0.4 ? "high" : "medium";
  } else if (priceActive) {
    // Price present, but news and/or calendar missing ⇒ price-only.
    sourceStatus = "price_only";
    confidence = "medium";
  } else {
    // Macro signal only (no price) ⇒ never high-confidence.
    sourceStatus = "price_only";
    confidence = "low";
  }

  const reasonParts: string[] = [];
  if (sourceStatus === "confirmed") {
    reasonParts.push("Confirmed heat from live price, news, and calendar.");
  } else if (sourceStatus === "price_only") {
    reasonParts.push(
      priceActive
        ? "Price-only heat — news/economic-calendar provider is not connected."
        : "Macro-only heat — price feed not available.",
    );
  } else if (sourceStatus === "stale") {
    reasonParts.push("Data is stale — confidence capped to low.");
  } else if (sourceStatus === "delayed") {
    reasonParts.push("Data is delayed — confidence capped to low.");
  }
  if (!newsActive) reasonParts.push("News unavailable.");
  if (!calActive) reasonParts.push("Calendar unavailable.");

  return {
    ...base,
    heatScore: clamp(heatScore, -100, 100),
    direction,
    intensity: intensityOf(magnitude),
    sourceStatus,
    confidence,
    reason: reasonParts.join(" "),
    warnings,
  };
}
