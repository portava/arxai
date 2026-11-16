// ── risk-correlation: static risk families + cluster exposure guard ─────────
// R3 slice 6 pure core (spec check 20, audit-risk.md finding F3). Pure
// deterministic functions only — wiring into the live dispatch pre-gates is a
// separate integration slice.
export * from "./riskFamilies";
export * from "./correlationGuard";
