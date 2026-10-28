// Task #512 — One Truth, One Brain (pure domain barrel).
export * from "./truth.types.js";
export {
  composeVerdict,
  evaluateLevelStaleness,
  summarizeAgreement,
  stageFromAgreement,
  type AgreementSummary,
} from "./composeVerdict.js";
export * from "./evidenceClass.js";
export { SYNTHETIC_EVENT_RISK_LABEL } from "./syntheticEventRisk.js";
