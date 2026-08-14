// ═══════════════════════════════════════════════════════════════════════════
// Validation Command Center — barrel exports.
//
// Institutional-grade validation. Builds on Phase 7 (`validation-pipeline`)
// by adding the seven dimensions every candidate must pass before earning
// live authority: edge quality, risk survival, statistical reliability,
// market regime fit, execution reality, trader behavior safety, edge
// durability. Every engine is pure; every decision is explainable.
// ═══════════════════════════════════════════════════════════════════════════

export * from "./statisticalSignificance.engine";
export * from "./monteCarloValidator.engine";
export * from "./regimeSpecificValidator.engine";
export * from "./stressValidation.engine";
export * from "./executionRealityValidator.engine";
export * from "./traderBehaviorValidator.engine";
export * from "./edgeDurability.engine";
export * from "./outOfSampleValidator.engine";
export * from "./validationConfidence.engine";
export * from "./validationScorecard.engine";
export * from "./validationCommandCenter.engine";
export * from "./validationAuditReport.engine";
