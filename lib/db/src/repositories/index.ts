// ── Repository layer ────────────────────────────────────────────────────────
// Use these instead of importing tables + drizzle directly into route
// handlers. This keeps storage swappable and route handlers thin.
export { symbolsRepo } from "./symbolsRepo";
export { tradePlansRepo } from "./tradePlansRepo";
export { aiDecisionLogRepo } from "./aiDecisionLogRepo";
export { tradeManagementRepo } from "./tradeManagementRepo";
export { learningInsightsRepo } from "./learningInsightsRepo";
export { userSettingsRepo } from "./userSettingsRepo";
export * as betaInvitesRepo from "./betaInvites";
export * as joinRequestsRepo from "./joinRequests";
export * as passwordResetTokensRepo from "./passwordResetTokens";
export * as passwordResetThrottleRepo from "./passwordResetThrottle";
export * as tradingModeGate from "./tradingModeGate";
export { mt5ConnectionRepo } from "./mt5ConnectionRepo";

// ── Session 2 Phase 6 — the Black Box. Append-only, bitemporal, hash-chained
// decision log whose row_hash is computed IN POSTGRES (pgcrypto), never by the
// application, and verified against the pure canonicaliser shared byte-for-byte
// with the feature path. Inert: writing to it is a side effect of deciding,
// never a step in deciding.
export * as eventLogRepo from "./eventLogRepo";
