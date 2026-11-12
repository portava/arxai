/** A new implementation of the documented V6.7 contracts; not recovered research code. */
export const STRUCTURAL_VERSION = "arx-v6.7-implementation-1";
export const HORIZONS = [1, 3, 5, 15, 30, 60] as const;
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
export interface HorizonForecast { minutes: number; probabilities: Triple }
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
}
export interface ForecastScore {
  evaluationVersion: string;
  horizon: number; observedThrough: number; outcome: Scenario;
  event: StructuralEvent | null; brier: number; baselineBrier: number; logLoss: number;
}
export const scenarioOf = (event?: StructuralEvent | null): Scenario =>
  !event ? "NEITHER" : event.cause.endsWith("UP") ? "UP_FIRST" : "DOWN_FIRST";
export const scenarioIndex = (scenario: Scenario): number =>
  scenario === "UP_FIRST" ? 0 : scenario === "DOWN_FIRST" ? 1 : 2;
