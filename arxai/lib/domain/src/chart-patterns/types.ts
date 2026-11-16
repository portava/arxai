/** Pure geometric input. Provenance/time validation belongs to the caller. */
export interface ChartPatternCandle {
  open: number; high: number; low: number; close: number;
  isComplete: boolean; isForming: boolean;
}
