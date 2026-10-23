// ═══════════════════════════════════════════════════════════════════════════
// Adversarial Validation — barrel exports.
//
// Actively attempts to BREAK strategies before they're allowed live. Six
// attack categories (edge fragility, regime collapse, execution sabotage,
// behavioral stress, contradiction testing, overfit exposure) plus a
// strategy-level assumption audit. The master decision engine grades
// fragility and emits restrictions/demotions/retirements.
// ═══════════════════════════════════════════════════════════════════════════

export * from "./edgeFragility.engine";
export * from "./regimeCollapse.engine";
export * from "./executionSabotage.engine";
export * from "./behavioralStress.engine";
export * from "./contradictionTest.engine";
export * from "./overfitExposure.engine";
export * from "./assumptionAudit.engine";
export * from "./strategyAttack.engine";
export * from "./adversarialValidation.engine";
