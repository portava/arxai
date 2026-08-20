// ── deriv-contracts: Deriv contract model + demo-only virtual gate ──────────
// R5 Phase 2 pure slice (audit-deriv.md G2/G3/G5 groundwork). Multiplier
// contract types modeled DISTINCT from MT5 CFD positions (spec §17:1040),
// capability-driven validators (never hardcoded venue limits), and the
// structural demo-only execution lock. Pure deterministic functions only —
// NO network code, NO buy/sell calls in this slice; the execution client is
// a later, separately gated slice.
export * from "./types";
export * from "./virtualGate";
