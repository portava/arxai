// ── compliance-gate: eligibility/compliance refusal evaluator ────────────────
// R6 Phase 0 pure core (blueprint §70, spec §1.3/§9, audit-connections G-5,
// audit-workspaces §4.2–4.3). Pure deterministic functions only — wiring into
// routes and the live dispatch pre-gates is a separate integration slice.
export * from "./eligibilityGate";
