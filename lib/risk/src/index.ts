// @workspace/risk — the objective kernel and the sizing chain.
//
// One pure pipeline: the objective says what size would be growth-optimal, and
// every stage after it can only make that number SMALLER. Vol targeting
// proposes, the Kelly cap trims, the learned nudge may only tighten, the floor
// stack takes a minimum. That monotonicity is the property that makes the
// package safe to extend — a new floor or a new model can be added without a
// fresh safety review, because the worst it can do is trade smaller.
//
// Additive and standalone. Imports nothing from the dispatch/gate path
// (`lib/domain/src/safety-contracts`, `artifacts/api-server/src/lib/live`, the
// 23-gate evaluator), reads no clock and no feed, and places no trades. Wiring
// it into live sizing is a separate, later work order.

export { kellyStar, logGrowthRate, expectedLogWealth } from "./objective.js";
export type { Outcome } from "./objective.js";

export {
  volTargetBaseFrac,
  kellyCapGovernor,
  enforceTightenOnly,
  applyFloorStack,
  dailyWeeklyLossCapFloor,
  stopRatchetFloor,
  decideSize,
  hashInputs,
  stableStringify,
} from "./sizing.js";
export type {
  VolTargetInput,
  VolTargetResult,
  VolTargetReason,
  KellyCapInput,
  KellyCapResult,
  KellyCapReason,
  Floor,
  FloorStackResult,
  SizingInputs,
  SizingDecision,
  SizingReason,
} from "./sizing.js";
