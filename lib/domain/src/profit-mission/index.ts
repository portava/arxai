// @workspace/domain/profit-mission — pure planning engines for Profit Missions.
//
// PLANNING + DISPLAY ONLY. These engines compute mission math, a feasibility
// verdict, and a probability/risk read. They are advisory, deterministic, and
// IO-free; nothing here can relax, override, or trigger any execution gate.

export * from "./types.js";
export * from "./timeframeUnit.js";
export * from "./bannedVocabulary.js";
export { computeMissionMath } from "./missionMath.js";
export { evaluateFeasibility } from "./feasibilityEngine.js";
export type { FeasibilityInput } from "./feasibilityEngine.js";
export { evaluateProbability } from "./probabilityEngine.js";
export type { ProbabilityInput } from "./probabilityEngine.js";
export * from "./stateMachine.js";
export * from "./agents/index.js";
// Phase 5 — Edge Engine, Opportunity Router & Queue, Trade Drafts, Mission Impact.
export * from "./edgeEngine.js";
export * from "./opportunityRouter.js";
export * from "./tradeDraft.js";
export * from "./missionImpact.js";
// Phase 6 — Risk Governor & Anti-Blow-up Layer (additive, stricter-only).
export * from "./missionRisk.js";
export * from "./blowupRisk.js";
// Phase 7 — Execution Quality, Exposure & Net-Profit Filter (block/downgrade-only).
export * from "./executionQuality.js";
export * from "./netProfit.js";
export * from "./exposure.js";
export * from "./capitalEfficiency.js";
export * from "./executionHealthGate.js";
// Phase 8 — Exit Manager Pro, Profit Locks & Controlled Compounding.
export * from "./exitManager.js";
export * from "./partialProfitPlan.js";
export * from "./profitMilestones.js";
export * from "./missedProfit.js";
export * from "./compounding.js";
// Phase 9 — Testing Lab integration, drift detector & promotion gates.
export * from "./missionAutomation.js";
// F-build — pure driver tick planner (decides; the api-server worker composes).
export * from "./missionDriverPlan.js";
export * from "./missionTestingLab.js";
export * from "./missionDriftDetector.js";
export * from "./missionPromotionGate.js";
export * from "./missionRiskCertificate.js";
export * from "./missionBriefing.js";
export * from "./missionLearningLoop.js";
