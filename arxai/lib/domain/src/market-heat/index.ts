// ── Market Heat domain (Task #611) ───────────────────────────────────────────
// Pure, honesty-aware heat verdict contract + symbol geography mapping. Imported
// by the api-server heat service and the trading-dashboard. Decision-support
// only — never an execution gate.

export * from "./symbolGeography.js";
export * from "./heatVerdict.js";
export * from "./providerHonesty.js";
export * from "./newsRisk.js";
