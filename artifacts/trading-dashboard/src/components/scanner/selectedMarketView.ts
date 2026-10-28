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
  readWithheldReason?: string | null;
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

/** Shown when the feed is not live-confirmed and the server gave no reason. */
export const NOT_LIVE_LEVELS_REASON =
  "The market data feed is not confirmed live, so entry, stop and target are not shown.";

/**
 * Whether the snapshot may show a DIRECTIONAL read (bias, confidence, trend,
 * levels). Downgrade-only: only a LIVE_CONFIRMED feed with no server-stated
 * withheld reason qualifies; a missing dataState is not a confirmation.
 */
export function selectedMarketReadShown(ok: {
  dataState?: SelectedMarketDataState;
  readWithheldReason?: string | null;
}): boolean {
  return ok.dataState === "LIVE_CONFIRMED" && !ok.readWithheldReason;
}

export function resolveSelectedMarketView(
  ok: SelectedMarketViewInput,
): SelectedMarketView {
  const h = ok.highlights;
  const hasLevels =
    selectedMarketReadShown(ok) &&
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

  // A feed that is not live-confirmed: state that, never the drift sentence.
  if (!selectedMarketReadShown(ok)) {
    return { kind: "withheld", reason: ok.readWithheldReason ?? ok.levelsWithheldReason ?? NOT_LIVE_LEVELS_REASON };
  }

  // Otherwise the guard withheld drifted geometry — surface its own reason.
  return { kind: "withheld", reason: ok.levelsWithheldReason ?? WITHHELD_FALLBACK_REASON };
}

// Clock-skew allowance before a data time is treated as stamped in the future.
const DATA_AS_OF_SKEW_MS = 5_000;

/**
 * The "Data as of …" label. A data time later than now is not an observation
 * (e.g. a forming bar's scheduled close): it is never clamped to "0s ago".
 * Downgrade-only: the client never invents a time the server did not send.
 */
export function selectedMarketDataAsOfLabel(dataAsOf: string | null | undefined, nowMs: number): string {
  if (!dataAsOf) return "Awaiting live market data";
  const t = Date.parse(dataAsOf);
  if (!Number.isFinite(t)) return "Data time unknown";
  if (t > nowMs + DATA_AS_OF_SKEW_MS) return "Data time unconfirmed (the feed stamped it in the future)";
  const s = Math.round((nowMs - Math.min(t, nowMs)) / 1000);
  if (s < 60) return `Data as of ${s}s ago`;
  return `Data as of ${Math.round(s / 60)}m ago`;
}
