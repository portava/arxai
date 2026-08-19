// ── @workspace/domain/execution-state ───────────────────────────────────────
// R2 slice S0 — canonical execution-state vocabulary (pure mapping layer over
// the three free-text status columns). No IO, no behavior change; consumers
// arrive in R2 S1+.
export * from "./canonicalState.js";
