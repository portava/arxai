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
export interface StructuralForecast {
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
  horizonId?: string;
}
export const forecastStepMs = (f: Pick<StructuralForecast, "stepMs">): number => f.stepMs ?? 60_000;
export const forecastHorizonBars = (f: Pick<StructuralForecast, "horizonBars">): number => f.horizonBars ?? 60;
export const forecastHorizonId = (f: Pick<StructuralForecast, "horizonId">): string => f.horizonId ?? DEFAULT_FORECAST_HORIZON;
export interface ForecastScore {
  evaluationVersion: string;
  /** Counted in bars of the forecast's bar length (minutes for one-minute bars). */
  horizon: number; minutes?: number; observedThrough: number; outcome: Scenario;
  event: StructuralEvent | null; brier: number; baselineBrier: number; logLoss: number;
}
export const scenarioOf = (event?: StructuralEvent | null): Scenario =>
  !event ? "NEITHER" : event.cause.endsWith("UP") ? "UP_FIRST" : "DOWN_FIRST";
export const scenarioIndex = (scenario: Scenario): number =>
  scenario === "UP_FIRST" ? 0 : scenario === "DOWN_FIRST" ? 1 : 2;
