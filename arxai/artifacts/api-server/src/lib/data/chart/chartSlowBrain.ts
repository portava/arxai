// Chart Brain v2 — Slow Brain boundary.
//
// The Slow Brain is the deep-analysis tier of the chart speed architecture. It
// NEVER runs on the request hot path and NEVER on the live-execution or
// candle-render path — it is background-only and purely additive. This module
// exists so that boundary is explicit and enforceable in code from day one; the
// heavy market-understanding engines (a later Chart Brain v2 task) will register
// behind this guard.
//
// INVARIANT: SLOW_BRAIN_BLOCKED_LIVE_EXECUTION is ALWAYS false. The Slow Brain
// can never block, gate, or delay live execution. If a caller ever tries to run
// Slow Brain work inside a live-execution / candle-render context, the guard
// throws — that is a programming error caught at the call site, never a runtime
// trading decision.

/** Inviolable: the Slow Brain never blocks live execution. */
export const SLOW_BRAIN_BLOCKED_LIVE_EXECUTION = false as const;

/** Only context in which Slow Brain work may run. */
export type SlowBrainContext = "background";

let slowBrainLastRunAt: string | null = null;

/** Last completed background Slow Brain pass, or null when it has never run. */
export function getSlowBrainLastRunAt(): string | null {
  return slowBrainLastRunAt;
}

/** Records a completed background Slow Brain pass (instrumentation only). */
export function markSlowBrainRun(at: Date = new Date()): void {
  slowBrainLastRunAt = at.toISOString();
}

/**
 * Hard guard: Slow Brain work may run ONLY in an explicit background context,
 * never on the live-execution or candle-render path. Throws on misuse so the
 * boundary fails loudly at the call site instead of leaking into production
 * trading.
 */
export function assertSlowBrainContext(context: SlowBrainContext): void {
  if (context !== "background") {
    throw new Error(
      "Chart Slow Brain may only run in a background context — never on the live-execution or candle-render path.",
    );
  }
}
