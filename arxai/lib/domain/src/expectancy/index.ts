// ── expectancy: probability + conservative-EV pure core (R7 step 5) ─────────
// intel-engine.md §2 #18 / replit-command-arx-R7 step 5. Pure deterministic
// functions only — no IO, no clock, no DB. This slice is the CORE engine;
// wiring it to durable shadow/closed-trade outcomes and to scanner scoring is
// a separate integration slice (the scanner today only references this package
// in comments — its calibration factor is a neutral constant until real
// calibration data flows from here).
//
// Doctrine carried by every function in this package:
//   - costs are REQUIRED (typed refusal, never a flattering default)
//   - sample < 30 ⇒ INSUFFICIENT_SAMPLE (never extrapolate)
//   - conservativeEv <= 0 ⇒ WAIT (WAIT is a success state)
//   - deterministic risk outranks this engine forever; nothing here touches
//     dispatch gates.
export * from "./costModel";
export * from "./probabilityEngine";
