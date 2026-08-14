// Chart Brain v2 — Task 3: Market Sentence Engine.
//
// Turns the centralized Chart Intelligence State (Tasks 1–2) into a small set of
// plain-language sentences a trader can read at a glance. It is the natural-
// language READER for the state — never a new data source and never a decision
// maker. Every sentence is:
//   - DETERMINISTIC: same state in => same sentence out (no randomness, no LLM).
//   - DERIVED FROM STATE ONLY: it reads the already-built engine outputs and
//     never re-fetches candles or invents a number.
//   - HONEST: when the underlying engine is not populated (insufficient/dirty
//     data), the sentence says so plainly instead of fabricating a read.
//   - JARGON-LIGHT + WHY-FOCUSED: trader-plain words (buyers, sellers, support,
//     momentum) and the REASON, not raw indicator names.
//
// The chart never executes from these sentences — they are display text. The
// route that serves them stays read-only and per-user gated.

import type { ChartIntelligenceState } from "./chartIntelligence.js";
import type { ChartLevel } from "./engines/marketUnderstandingTypes.js";

export type ChartSentenceTone =
  | "bullish"
  | "bearish"
  | "neutral"
  | "caution"
  | "danger"
  | "info";

export interface ChartMarketSentence {
  /** Stable id for keys/consumers. */
  key: string;
  /** Short human label (e.g. "Market", "Risk"). */
  label: string;
  /** The plain-language sentence. */
  text: string;
  /** Drives colour/emphasis on the client. */
  tone: ChartSentenceTone;
}

export interface ChartMarketSentences {
  /** True only when the market-understanding engines are populated. */
  populated: boolean;
  market: ChartMarketSentence;
  proving: ChartMarketSentence;
  failedToProve: ChartMarketSentence;
  risk: ChartMarketSentence;
  entryTiming: ChartMarketSentence;
  scalp: ChartMarketSentence;
  bestNextAction: ChartMarketSentence;
  whatWouldChange: ChartMarketSentence;
  whatInvalidates: ChartMarketSentence;
  signalFreshness: ChartMarketSentence;
  note: string;
}

// The sentence engine only needs the assembled state; typed as the state minus
// the field it produces to avoid a self-referential dependency.
type SentenceInput = Omit<ChartIntelligenceState, "marketSentences">;

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "the level";
  const abs = Math.abs(n);
  const decimals = abs < 10 ? 5 : abs < 1000 ? 3 : 2;
  return n.toFixed(decimals);
}

function directionWord(
  d: "bullish" | "bearish" | "ranging" | "mixed" | "unknown",
): string {
  switch (d) {
    case "bullish":
      return "up";
    case "bearish":
      return "down";
    case "ranging":
      return "sideways";
    case "mixed":
      return "mixed";
    default:
      return "unclear";
  }
}

function regimeWord(
  r: "trending" | "ranging" | "volatile" | "quiet" | "unknown",
): string {
  switch (r) {
    case "trending":
      return "trending";
    case "ranging":
      return "rangebound";
    case "volatile":
      return "choppy and volatile";
    case "quiet":
      return "quiet";
    default:
      return "unclear";
  }
}

function biasTone(
  d: "bullish" | "bearish" | "neutral" | "unknown",
): ChartSentenceTone {
  if (d === "bullish") return "bullish";
  if (d === "bearish") return "bearish";
  return "neutral";
}

function nearestLevel(s: SentenceInput): {
  level: ChartLevel | null;
  isSupport: boolean;
} {
  const sup = s.marketUnderstanding.levels.nearestSupport;
  const res = s.marketUnderstanding.levels.nearestResistance;
  // Pick whichever is closer by absolute distance%, when both known.
  const sd = sup?.distancePct != null ? Math.abs(sup.distancePct) : Infinity;
  const rd = res?.distancePct != null ? Math.abs(res.distancePct) : Infinity;
  if (sup && sd <= rd) return { level: sup, isSupport: true };
  if (res) return { level: res, isSupport: false };
  if (sup) return { level: sup, isSupport: true };
  return { level: null, isSupport: false };
}

// ── 1. Current market sentence ────────────────────────────────────────────
function sentenceMarket(s: SentenceInput): ChartMarketSentence {
  const base = { key: "market", label: "Market" } as const;
  if (!s.marketUnderstanding.trend.populated) {
    return {
      ...base,
      tone: "neutral",
      text: `Not enough clean data on ${s.displaySymbol} ${s.timeframe} to read the market yet.`,
    };
  }
  const t = s.marketUnderstanding.trend;
  const regime = regimeWord(t.regime);
  const dir = directionWord(t.direction);
  const pressure = s.marketUnderstanding.candleIntent.dominantPressure;
  const pressureClause =
    pressure === "buyers"
      ? ", with buyers in control"
      : pressure === "sellers"
        ? ", with sellers in control"
        : pressure === "balanced"
          ? ", with buyers and sellers balanced"
          : "";
  const tone =
    t.direction === "bullish"
      ? "bullish"
      : t.direction === "bearish"
        ? "bearish"
        : "neutral";
  if (t.regime === "ranging" || t.direction === "ranging") {
    return {
      ...base,
      tone: "neutral",
      text: `${s.displaySymbol} is ${regime} on ${s.timeframe}${pressureClause} — price is rotating rather than trending.`,
    };
  }
  return {
    ...base,
    tone,
    text: `${s.displaySymbol} is ${regime} ${dir} on ${s.timeframe}${pressureClause}.`,
  };
}

// ── 2. What price is proving ──────────────────────────────────────────────
function sentenceProving(s: SentenceInput): ChartMarketSentence {
  const base = { key: "proving", label: "Proving" } as const;
  const ci = s.marketUnderstanding.candleIntent;
  if (!ci.populated) {
    return {
      ...base,
      tone: "neutral",
      text: "No clear proof yet — the recent candles aren't showing a decisive hand.",
    };
  }
  const intent = ci.latestIntent;
  const pressure = ci.dominantPressure;
  const who =
    pressure === "buyers" ? "buyers" : pressure === "sellers" ? "sellers" : null;
  switch (intent) {
    case "pushing":
      return {
        ...base,
        tone: who === "sellers" ? "bearish" : "bullish",
        text: `Price is proving ${who ?? "one side"} are pushing — the latest bar drove in their direction and held.`,
      };
    case "continuing":
      return {
        ...base,
        tone: who === "sellers" ? "bearish" : "bullish",
        text: `Price is proving the move has follow-through — ${who ?? "the active side"} kept control into the close.`,
      };
    case "breaking_structure":
      return {
        ...base,
        tone: who === "sellers" ? "bearish" : "bullish",
        text: "Price is proving it can break structure — it pushed past the prior swing instead of stalling.",
      };
    case "rejecting":
      return {
        ...base,
        tone: "caution",
        text: "Price is proving a level matters — it was rejected there and pushed back.",
      };
    case "absorbing":
      return {
        ...base,
        tone: "neutral",
        text: "Price is proving there's a wall of orders — pushes are being absorbed without progress.",
      };
    default:
      return {
        ...base,
        tone: "neutral",
        text: "Price hasn't proven much yet — the last bar was indecisive.",
      };
  }
}

// ── 3. What price failed to prove ─────────────────────────────────────────
function sentenceFailedToProve(s: SentenceInput): ChartMarketSentence {
  const base = { key: "failedToProve", label: "Failed to prove" } as const;
  const ci = s.marketUnderstanding.candleIntent;
  if (!ci.populated) {
    return {
      ...base,
      tone: "neutral",
      text: "Nothing has clearly failed yet — there isn't enough data to call a failure.",
    };
  }
  const intent = ci.latestIntent;
  if (intent === "failing_to_break") {
    return {
      ...base,
      tone: "caution",
      text: "Price failed to prove it can break through — the attempt stalled and pulled back.",
    };
  }
  if (intent === "exhausting") {
    return {
      ...base,
      tone: "caution",
      text: "Price failed to prove the move can continue — momentum is running out of steam.",
    };
  }
  if (intent === "trapping") {
    return {
      ...base,
      tone: "danger",
      text: "Price failed to prove the breakout was real — it looks like a trap that snapped back.",
    };
  }
  // Surface the strongest opposing evidence when present.
  const against = s.marketUnderstanding.evidence.evidenceAgainst[0];
  if (against) {
    return {
      ...base,
      tone: "caution",
      text: `Price hasn't proven the move is clean — ${against.text.toLowerCase()}`,
    };
  }
  return {
    ...base,
    tone: "neutral",
    text: "No clear failure — price hasn't been rejected or trapped at a key level.",
  };
}

// ── 4. Risk sentence ──────────────────────────────────────────────────────
function sentenceRisk(s: SentenceInput): ChartMarketSentence {
  const base = { key: "risk", label: "Risk" } as const;
  if (s.stale || !s.aiUsable) {
    return {
      ...base,
      tone: "danger",
      text: "Risk is high right now because the feed isn't clean — don't trust this read for a live decision.",
    };
  }
  const r = s.marketUnderstanding.readiness;
  if (r.vetoed && r.vetoReason) {
    return {
      ...base,
      tone: "danger",
      text: `Risk is too high to act — ${r.vetoReason.toLowerCase()}`,
    };
  }
  const contradiction = s.marketUnderstanding.evidence.contradictions[0];
  if (contradiction && contradiction.severity === "high") {
    return {
      ...base,
      tone: "danger",
      text: `Risk is elevated — ${contradiction.text.toLowerCase()}`,
    };
  }
  if (s.marketUnderstanding.timeframeAgreement.scalpOnlyWarning) {
    return {
      ...base,
      tone: "caution",
      text: "Risk is moderate — the timeframes disagree, so treat anything here as scalp-only.",
    };
  }
  if (contradiction) {
    return {
      ...base,
      tone: "caution",
      text: `Risk is moderate — ${contradiction.text.toLowerCase()}`,
    };
  }
  return {
    ...base,
    tone: "info",
    text: "Risk looks normal for this read — no major conflicts in the picture.",
  };
}

// ── 5. Entry-timing sentence ──────────────────────────────────────────────
function sentenceEntryTiming(s: SentenceInput): ChartMarketSentence {
  const base = { key: "entryTiming", label: "Entry timing" } as const;
  const setup = s.setupState;
  if (!setup.populated || setup.stage === "no_setup") {
    return {
      ...base,
      tone: "neutral",
      text: "No setup to time yet — there's nothing actionable forming.",
    };
  }
  switch (setup.stage) {
    case "idea_forming":
      return {
        ...base,
        tone: "neutral",
        text: "Too early to act — the idea is still forming and needs confirmation.",
      };
    case "watchlist":
      return {
        ...base,
        tone: "info",
        text: "On the watchlist — worth watching, but the trigger hasn't fired yet.",
      };
    case "trigger":
      return {
        ...base,
        tone: "caution",
        text: "The trigger is firing — watch closely, this is where timing matters.",
      };
    case "confirmation_needed":
      return {
        ...base,
        tone: "caution",
        text: "Wait for confirmation — the setup is close but unproven; a confirmed close decides it.",
      };
    case "entry_valid":
      return {
        ...base,
        tone:
          setup.direction === "bullish"
            ? "bullish"
            : setup.direction === "bearish"
              ? "bearish"
              : "info",
        text: "Entry timing is valid now — the conditions for this setup are in place.",
      };
    case "stale":
      return {
        ...base,
        tone: "caution",
        text: "The window has gone stale — the timing has passed; wait for a fresh setup.",
      };
    case "invalid":
      return {
        ...base,
        tone: "danger",
        text: "The setup is invalidated — don't time an entry off it.",
      };
    default:
      return {
        ...base,
        tone: "neutral",
        text: "Timing is unclear from the current setup.",
      };
  }
}

// ── 6. Scalp sentence ─────────────────────────────────────────────────────
function sentenceScalp(s: SentenceInput): ChartMarketSentence {
  const base = { key: "scalp", label: "Scalp" } as const;
  if (!s.marketUnderstanding.populated) {
    return {
      ...base,
      tone: "neutral",
      text: "No scalp read — not enough clean data for a quick trade call.",
    };
  }
  const tf = s.marketUnderstanding.timeframeAgreement;
  const momentum = s.fastFlags.momentumBurst;
  if (tf.scalpOnlyWarning) {
    return {
      ...base,
      tone: "caution",
      text: momentum
        ? "Scalp-only: there's a quick momentum burst, but the bigger trend doesn't back it — keep it small and fast."
        : "Scalp-only: the timeframes disagree, so only quick in-and-out trades make sense here.",
    };
  }
  if (momentum) {
    return {
      ...base,
      tone: "info",
      text: "A momentum burst is present — a scalp can work if you respect a tight stop.",
    };
  }
  if (s.marketUnderstanding.trend.regime === "quiet") {
    return {
      ...base,
      tone: "neutral",
      text: "Poor scalp conditions — the market is quiet with little movement to capture.",
    };
  }
  return {
    ...base,
    tone: "neutral",
    text: "No strong scalp edge right now — momentum isn't bursting.",
  };
}

// ── 7. Best next action ───────────────────────────────────────────────────
function sentenceBestNextAction(s: SentenceInput): ChartMarketSentence {
  const base = { key: "bestNextAction", label: "Best next action" } as const;
  const d = s.decisionState;
  if (!d.populated) {
    return {
      ...base,
      tone: "neutral",
      text: "Best action: wait — there isn't a clean enough read to do anything.",
    };
  }
  if (d.vetoed) {
    return {
      ...base,
      tone: "danger",
      text: "Best action: stand aside — conditions veto taking a trade here.",
    };
  }
  const { level, isSupport } = nearestLevel(s);
  const levelTxt = level ? fmtPrice(level.price) : null;
  switch (d.actionability) {
    case "ready":
      return {
        ...base,
        tone: biasTone(d.bias),
        text: `Best action: this is the cleanest it gets (${d.quality}) — if it fits your plan, act with a defined stop.`,
      };
    case "prepare":
      return {
        ...base,
        tone: "caution",
        text: levelTxt
          ? `Best action: get ready — set an alert around ${levelTxt} and wait for a confirmed close.`
          : "Best action: get ready — wait for a confirmed close before committing.",
      };
    case "watch":
      return {
        ...base,
        tone: "info",
        text: levelTxt
          ? `Best action: watch ${levelTxt} (${isSupport ? "support" : "resistance"}) and let price prove itself first.`
          : "Best action: watch and let price prove itself before doing anything.",
      };
    case "stand_aside":
      return {
        ...base,
        tone: "neutral",
        text: "Best action: stand aside — there's no edge worth the risk right now.",
      };
    default:
      return {
        ...base,
        tone: "neutral",
        text: "Best action: wait for the picture to clear.",
      };
  }
}

// ── 8. What would change the decision ─────────────────────────────────────
function sentenceWhatWouldChange(s: SentenceInput): ChartMarketSentence {
  const base = { key: "whatWouldChange", label: "What would change it" } as const;
  if (!s.marketUnderstanding.populated) {
    return {
      ...base,
      tone: "neutral",
      text: "A clean feed and more candles would give us a read to change.",
    };
  }
  const tf = s.marketUnderstanding.timeframeAgreement;
  if (tf.scalpOnlyWarning) {
    return {
      ...base,
      tone: "info",
      text: "If the higher timeframes line up with the move, this upgrades from scalp-only to a real trend trade.",
    };
  }
  const { level, isSupport } = nearestLevel(s);
  if (level) {
    const price = fmtPrice(level.price);
    return isSupport
      ? {
          ...base,
          tone: "info",
          text: `A confirmed close below ${price} would flip the read bearish; a strong hold there would confirm the upside.`,
        }
      : {
          ...base,
          tone: "info",
          text: `A confirmed close above ${price} would flip the read bullish; a clean rejection there would confirm the downside.`,
        };
  }
  return {
    ...base,
    tone: "info",
    text: "A decisive close that breaks or defends the nearest level would change the read.",
  };
}

// ── 9. What invalidates ───────────────────────────────────────────────────
function sentenceWhatInvalidates(s: SentenceInput): ChartMarketSentence {
  const base = { key: "whatInvalidates", label: "What invalidates" } as const;
  const setup = s.setupState;
  if (setup.invalidationCondition) {
    const price = setup.invalidationPrice;
    const priceClause = price != null ? ` (${fmtPrice(price)})` : "";
    return {
      ...base,
      tone: "danger",
      text: `This idea is wrong if ${setup.invalidationCondition.toLowerCase()}${priceClause}.`,
    };
  }
  const { level, isSupport } = nearestLevel(s);
  if (level) {
    const price = fmtPrice(level.price);
    return {
      ...base,
      tone: "caution",
      text: isSupport
        ? `Treat a confirmed close below ${price} as the line that invalidates the bullish case.`
        : `Treat a confirmed close above ${price} as the line that invalidates the bearish case.`,
    };
  }
  return {
    ...base,
    tone: "neutral",
    text: "No clear invalidation level yet — wait for structure before risking anything.",
  };
}

// ── 10. Signal freshness ──────────────────────────────────────────────────
function sentenceSignalFreshness(s: SentenceInput): ChartMarketSentence {
  const base = { key: "signalFreshness", label: "Freshness" } as const;
  if (s.stale) {
    return {
      ...base,
      tone: "danger",
      text: "The feed is stale — this read is frozen, not live; refresh before trusting it.",
    };
  }
  const setup = s.setupState;
  if (!setup.populated || setup.ageBars == null) {
    return {
      ...base,
      tone: "neutral",
      text: "No active setup to age — freshness only matters once one forms.",
    };
  }
  const age = setup.ageBars;
  const decay = setup.decayScore;
  if (setup.stage === "stale") {
    return {
      ...base,
      tone: "caution",
      text: `This read is stale — the setup is ${age} bars old and has decayed past its window.`,
    };
  }
  if (decay != null && decay >= 60) {
    return {
      ...base,
      tone: "caution",
      text: `Getting old — the setup is ${age} bars in and starting to decay.`,
    };
  }
  return {
    ...base,
    tone: "info",
    text: `Fresh read — the setup is only ${age} bar${age === 1 ? "" : "s"} old.`,
  };
}

/**
 * Deterministically map the assembled Chart Intelligence State to plain-language
 * sentences. Pure: reads only the state, never re-fetches or fabricates.
 */
export function buildMarketSentences(s: SentenceInput): ChartMarketSentences {
  const populated = s.marketUnderstanding.populated;
  return {
    populated,
    market: sentenceMarket(s),
    proving: sentenceProving(s),
    failedToProve: sentenceFailedToProve(s),
    risk: sentenceRisk(s),
    entryTiming: sentenceEntryTiming(s),
    scalp: sentenceScalp(s),
    bestNextAction: sentenceBestNextAction(s),
    whatWouldChange: sentenceWhatWouldChange(s),
    whatInvalidates: sentenceWhatInvalidates(s),
    signalFreshness: sentenceSignalFreshness(s),
    note: populated
      ? "Sentences derived deterministically from the chart intelligence state."
      : "Limited read — market-understanding engines are not fully populated, so sentences stay honest about the missing data.",
  };
}
