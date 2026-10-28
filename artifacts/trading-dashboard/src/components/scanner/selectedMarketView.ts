// Pure render-state resolver for the "Pick a market — Ruby explains it" panel
// (Task #518). The panel must NEVER render numeric entry/stop/target when the
// stale-level guard withheld them, and must NEVER render zeros styled as levels
// when there is no confirmed live feed. This pure function encodes exactly the
// three render branches the panel draws, so the decision is unit-testable
// without mounting the whole panel.
//
//   - "levels"   → real geometry passed the guard on a LIVE_CONFIRMED feed.
//   - "withheld" → guard fired (levels too far from price); show its reason.
//   - "waiting"  → no confirmed live feed (UNAVAILABLE / STALE / SYNCING /
//                  unstated); show the waiting language, never the numbers.

export type SelectedMarketDataState =
  | "LIVE_CONFIRMED"
  | "SYNCING"
  | "STALE"
  | "UNAVAILABLE";

export interface SelectedMarketLevels {
  entryLow: number;
  entryHigh: number;
  stop: number;
  target: number;
  riskReward: number;
}

export type SelectedMarketView =
  | { kind: "levels"; levels: SelectedMarketLevels }
  | { kind: "withheld"; reason: string }
  | { kind: "waiting" };

export interface SelectedMarketViewInput {
  levelsWithheld?: boolean;
  levelsWithheldReason?: string | null;
  dataState?: SelectedMarketDataState;
  highlights: {
    entryZone: { low: number; high: number } | null;
    suggestedStop: number | null;
    suggestedTakeProfit: number | null;
    riskRewardRatio: number;
  };
}

// Shown only if the backend ever withholds without supplying its own reason
// (the builder always supplies the guard's sentence on the withheld path).
export const WITHHELD_FALLBACK_REASON =
  "Saved levels are too far from the current price to show. They'll return once the feed and analysis line up.";

export function resolveSelectedMarketView(
  ok: SelectedMarketViewInput,
): SelectedMarketView {
  const h = ok.highlights;
  const hasLevels =
    !ok.levelsWithheld &&
    h.entryZone != null &&
    h.suggestedStop != null &&
    h.suggestedTakeProfit != null;

  // Levels print as numbers only on a confirmed live feed. A STALE / SYNCING
  // (or unstated) feed is the same condition under which the panel's reasoning
  // block says the levels are withheld, so the Highlights box must agree.
  const feedConfirmed = ok.dataState === "LIVE_CONFIRMED";

  if (feedConfirmed && hasLevels && h.entryZone && h.suggestedStop != null && h.suggestedTakeProfit != null) {
    return {
      kind: "levels",
      levels: {
        entryLow: h.entryZone.low,
        entryHigh: h.entryZone.high,
        stop: h.suggestedStop,
        target: h.suggestedTakeProfit,
        riskReward: h.riskRewardRatio,
      },
    };
  }

  // No confirmed feed → honest waiting state (never zeros styled as levels).
  if (ok.dataState === "UNAVAILABLE") return { kind: "waiting" };

  // The guard withheld drifted geometry — surface its own reason.
  if (ok.levelsWithheld) {
    return { kind: "withheld", reason: ok.levelsWithheldReason ?? WITHHELD_FALLBACK_REASON };
  }

  // Levels exist but the feed is not confirmed live → waiting language.
  if (!feedConfirmed) return { kind: "waiting" };

  // Confirmed feed, no complete geometry published.
  return { kind: "withheld", reason: ok.levelsWithheldReason ?? WITHHELD_FALLBACK_REASON };
}
