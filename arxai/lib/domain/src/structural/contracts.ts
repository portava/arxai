/** A new implementation of the documented V6.7 contracts; not recovered research code. */
export const STRUCTURAL_VERSION = "arx-v6.7-implementation-1";
export const HORIZONS = [1, 3, 5, 15, 30, 60] as const;
/** Bar lengths the model accepts. Its internal horizon is always 60 bars of one length. */
export const BAR_STEPS_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000] as const;
/** A user-facing forecast window: a bar length plus how many of the 60 modelled bars it covers. */
export interface ForecastHorizonPreset { id: string; label: string; timeframe: "M1" | "M5" | "M15" | "M30" | "H1" | "H4"; stepMs: number; bars: number; minutes: number }
const preset = (id: string, label: string, timeframe: ForecastHorizonPreset["timeframe"], stepMs: number, bars: number): ForecastHorizonPreset =>
  ({ id, label, timeframe, stepMs, bars, minutes: bars * stepMs / 60_000 });
/** Each window uses the shortest bar length that fits it inside 60 bars. */
export const FORECAST_HORIZONS: readonly ForecastHorizonPreset[] = Object.freeze([
  preset("15m", "15 minutes", "M1", 60_000, 15), preset("30m", "30 minutes", "M1", 60_000, 30),
  preset("1h", "1 hour", "M1", 60_000, 60), preset("4h", "4 hours", "M5", 300_000, 48),
  preset("8h", "8 hours", "M15", 900_000, 32), preset("12h", "12 hours", "M15", 900_000, 48),
  preset("24h", "24 hours", "M30", 1_800_000, 48), preset("2d", "2 days", "H1", 3_600_000, 48),
  preset("1w", "1 week", "H4", 14_400_000, 42),
]);
export const DEFAULT_FORECAST_HORIZON = "1h";
export const forecastHorizon = (id: unknown): ForecastHorizonPreset | null =>
  FORECAST_HORIZONS.find(h => h.id === id) ?? null;
export const CAUSES = ["BOS_UP", "CHOCH_UP", "BOS_DOWN", "CHOCH_DOWN"] as const;
export type Cause = typeof CAUSES[number];
export type Scenario = "UP_FIRST" | "DOWN_FIRST" | "NEITHER";
export type Triple = [number, number, number];
export type Mass = [number, number, number, number];
export interface StructuralBar {
  openTime: number; closeTime: number;
  open: number; high: number; low: number; close: number;
  isFinal: boolean;
}
export interface DataOrigin {
  provider: string; symbol: string; fetchedAt: string;
  kind: "BROKER_HISTORY" | "LIVE_OBSERVED" | "SYNTHETIC_TEST";
  /** Backfill does not establish original historical arrival time. */
  historicalArrivalTimesKnown: boolean;
}
export interface StructuralEvent {
  cause: Cause; index: number; time: number; pivot: number;
  precursorTime: number; atr: number;
}
export interface Pivot { price: number; index: number; knownAt: number }
export interface Precursor { direction: 1 | -1; index: number; pivot: Pivot; atr: number }
export interface StructureRead {
  events: StructuralEvent[]; high: Pivot | null; low: Pivot | null;
  precursor: Precursor | null; trend: -1 | 0 | 1;
  sweeps: number[]; gaps: Array<{ low: number; high: number; direction: 1 | -1; index: number }>;
  retests: number[];
}
export interface FeatureRead { values: number[]; eligible: boolean; structure: StructureRead }
export interface HorizonForecast { minutes: number; bars?: number; probabilities: Triple }
export interface GhostPath {
  scenario: Scenario; probability: number;
  label: "ILLUSTRATIVE_TRAINING_PATH";
  sourceEnd: number | null; candles: StructuralBar[]; unavailableReason: string | null;
}
/**
 * One of three projected paths. The forecast finds the past setups whose
 * structure most resembled the current one, rescales what price did after each
 * to today's price, and takes the 75th / 50th / 25th percentile by where it
 * ended. `share` is the fraction of those matches that ended on this path's
 * side (higher for BULL, lower for BEAR, within the middle half for MIDDLE).
 */
export type TrajectoryKind = "BULL" | "MIDDLE" | "BEAR";
export interface Trajectory {
  kind: TrajectoryKind; percentile: 75 | 50 | 25;
  /** Bull and bear are the edges of the recent-volatility range; middle is the analogs' median. */
  label: "ANALOG_PERCENTILE_PATH" | "VOLATILITY_BAND_EDGE";
  candles: StructuralBar[];
  /** End close relative to the starting close, as a fraction (0.01 = +1%). */
  endChange: number;
  share: number; analogs: number; sourceEnd: number | null;
}
/** Learned adjustment from this user's graded forecasts of the same symbol and window. */
export interface CalibrationRecord {
  applied: boolean; reason: string;
  /** Graded forecasts it learned from, and how many of them were held out to test it. */
  graded: number; heldOut: number;
  /** Weight given to the observed outcome frequencies (0 = raw model, 1 = frequencies only). */
  weight: number; frequencies: Triple | null;
  /** Brier improvement on the held-out forecasts (> 0 = better than the raw model). */
  holdoutGain: number | null;
  /** Window probabilities before calibration. */
  raw: Triple;
  /** Graded forecasts left out because they overlapped one already counted (updates included). */
  skippedOverlapping?: number;
}
/**
 * Set on a forecast issued while an earlier forecast of the same window and
 * feed was still open: it is an update of that one, made `barsIntoWindow` bars
 * in. Updates are graded on their own and never used to learn calibration,
 * since they repeat the open forecast's bet with less time left.
 */
export interface ForecastUpdate { of: string; anchorAsOf: number; barsIntoWindow: number }
/** The judgement of one finished forecast, made once its whole window has closed. */
export interface ForecastGrade {
  gradeVersion: string;
  letter: "A" | "B" | "C" | "D" | "F";
  /**
   * 1 − Brier of the probabilities shown / Brier of the baseline (the
   * training period's own outcome frequencies). 0 = no better than always
   * guessing those odds; > 0 = better; < 0 = worse. Floored at −1.
   */
  skill: number;
  /** The older yardstick: 1 − Brier/uniform Brier (beats a coin toss among three). Kept for comparison. */
  skillVsUniform?: number;
  /** True when this grade was re-derived on read from a stored older grade; the stored record is unchanged. */
  rederived?: boolean;
  /** Probability the forecast gave the outcome that actually happened. */
  probabilityOfOutcome: number;
  /** Where price actually ended relative to the start, and which path ended nearest to it. */
  actualEndChange: number; nearestPath: TrajectoryKind | null;
  /** Whether the actual end landed between the bear and bull paths' ends. */
  insideRange: boolean | null;
  /** Mean absolute error of the middle path's closes, as a fraction of price. */
  middlePathError: number | null;
  /** Per-close errors in instrument price points on the favored route and the unchanged-price benchmark. */
  priceScore?: { method: PriceEstimate["method"]; matched: number; mae: number; flatMae: number };
  routeScore?: { scenario: Scenario; matched: number; mae: number; flatMae: number };
}
/** A per-candle median price estimate conditional on the first break in this window. */
export interface ForecastRoute {
  scenario: Scenario;
  matches: number;
  candles: StructuralBar[];
}
export interface PriceEstimate {
  method: "FLAT" | "ANALOG_MEDIAN";
  tested: number;
  candles: StructuralBar[];
}
export interface StructuralForecast {
  paperInstruction?: import("./paperInstruction.js").ForecastPaperInstruction;
  atiSpecialists?: import("./atiSpecialists.js").SpecialistReceipt;
  atiEarlyBreak?: import("./atiValidation.js").AtiEarlyBreak;
  version: string; asOf: number; origin: DataOrigin; modelId: string;
  featureVersion: string; eventDefinitionVersion: string;
  trainedThrough: number; features: number[]; preBreakEligible: boolean;
  mode: "PREBREAK" | "POST_PRECURSOR" | "BASELINE";
  gateReason: string; validation: "NOT_YET_VALIDATED";
  mass: Mass[]; baselineMass: Mass[]; horizons: HorizonForecast[];
  paths: GhostPath[]; history: StructuralBar[];
  executionAuthority: "NONE";
  /** Bar length; absent on forecasts saved before multi-horizon support (one minute). */
  stepMs?: number;
  /** Bars of the 60 modelled that the requested window covers; absent means 60. */
  horizonBars?: number;
  /** Which engine drew the bull-bear range for this market, and the out-of-sample evidence. Absent on older forecasts. */
  range?: { engine: "HISTORY" | "VOLATILITY"; reason: string; tested: number; historyInside: number | null; volatilityInside: number | null;
    /** What sized the volatility range: the hour-of-week forecast (M15/H1) or the last 120 bars. Absent on older forecasts. */
    volatility?: "HOUR_OF_WEEK" | "RECENT_120_BARS" };
  /** True only when the analogs' up/down share reliably beat a coin flip on this market's untested setups. */
  directionEdge?: boolean;
  horizonId?: string;
  /** Bull / middle / bear projected paths; absent on forecasts saved before them. */
  trajectories?: Trajectory[];
  /** Saved at issue time. Each route uses only completed historical matches. Older forecasts contain ranges only. */
  routes?: ForecastRoute[];
  priceEstimate?: PriceEstimate;
  /** Calibration applied to this window's probabilities, if any was learned. */
  calibration?: CalibrationRecord;
  /** Present when this forecast updates one whose window was still open. */
  update?: ForecastUpdate;
}
export const forecastStepMs = (f: Pick<StructuralForecast, "stepMs">): number => f.stepMs ?? 60_000;
export const forecastHorizonBars = (f: Pick<StructuralForecast, "horizonBars">): number => f.horizonBars ?? 60;
export const forecastHorizonId = (f: Pick<StructuralForecast, "horizonId">): string => f.horizonId ?? DEFAULT_FORECAST_HORIZON;
export interface ForecastScore {
  atiValidation?: import("./atiValidation.js").AtiStructuralOutcome;
  evaluationVersion: string;
  /** Counted in bars of the forecast's bar length (minutes for one-minute bars). */
  horizon: number; minutes?: number; observedThrough: number; outcome: Scenario;
  event: StructuralEvent | null; brier: number; baselineBrier: number; logLoss: number;
  /** Present on the forecast's own window once it has fully closed. */
  grade?: ForecastGrade;
  /** Brier of the probabilities the user was shown (after any calibration). */
  shownBrier?: number;
  /** Grade added later to a window first scored before grades existed. The
   * original score row is kept; this one is appended beside it. */
  lateGrade?: boolean;
}
export const scenarioOf = (event?: StructuralEvent | null): Scenario =>
  !event ? "NEITHER" : event.cause.endsWith("UP") ? "UP_FIRST" : "DOWN_FIRST";
export const scenarioIndex = (scenario: Scenario): number =>
  scenario === "UP_FIRST" ? 0 : scenario === "DOWN_FIRST" ? 1 : 2;
