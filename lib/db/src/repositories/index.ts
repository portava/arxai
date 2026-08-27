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

// ── Phase 6 (guided mode) — approval tickets. The atomic dispatch claim lives
// here: a CAS on state='APPROVED' is what makes "one approval, at most one
// order" true across processes, where a mutex cannot reach.
export * as approvalTicketsRepo from "./approvalTicketsRepo";

// Phase 6 — the Personal Trading Constitution. APPEND-ONLY: a new version is a
// new row naming the one it supersedes. Registered with the vault-append-only
// guard, so an UPDATE here fails CI.
export * as tradingConstitutionRepo from "./tradingConstitutionRepo";

// Phase 6 — durable Deriv order intents. req_id restarts at 0 per transport
// instance, so after a restart this row is the ONLY thing that can correlate a
// late reply back to the command that caused it.
export * as derivOrderIntentsRepo from "./derivOrderIntentsRepo";

// Phase 6 — the guided forensic ledger. APPEND-ONLY and vault-guarded: one
// intent id reconstructs a whole trade attempt.
export * as guidedAttemptEventsRepo from "./guidedAttemptEventsRepo";
