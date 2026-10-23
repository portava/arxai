import { z } from "zod/v4";
import {
  SymbolIdSchema, StrategyIdSchema, TradeIntentIdSchema,
  SystemModeSchema, SeveritySchema, Score01Schema,
} from "./systemIntegration.types";

// ═══════════════════════════════════════════════════════════════════════════
// Decision Flow — master pipeline gate
// Implements the spec flow:
//   Market Data → Sensors → Specialist Agents → Red Team / Blue Team
//   → Judge → Execution Microstructure Check → Cognitive Risk Check
//   → Risk Governor → Control Tower → Execution Layer → Monitoring
//   → Black Box Vault → Replay Lab → Audit AI → Validation Pipeline
//   → Portfolio Manager
//
// Pure. Returns the stage at which the flow halts (if any), the final
// decision, and structured reasons / blockers.
// ═══════════════════════════════════════════════════════════════════════════

export const FlowStageSchema = z.enum([
  "MARKET_DATA", "SENSORS", "SPECIALIST_AGENTS",
  "RED_TEAM_BLUE_TEAM", "JUDGE",
  "EXECUTION_MICROSTRUCTURE_CHECK", "COGNITIVE_RISK_CHECK",
  "RISK_GOVERNOR", "CONTROL_TOWER", "EXECUTION_LAYER",
  "MONITORING", "BLACK_BOX_VAULT", "REPLAY_LAB",
  "AUDIT_AI", "VALIDATION_PIPELINE", "PORTFOLIO_MANAGER",
]);
export type FlowStage = z.infer<typeof FlowStageSchema>;

export const FLOW_ORDER: ReadonlyArray<FlowStage> = [
  "MARKET_DATA", "SENSORS", "SPECIALIST_AGENTS",
  "RED_TEAM_BLUE_TEAM", "JUDGE",
  "EXECUTION_MICROSTRUCTURE_CHECK", "COGNITIVE_RISK_CHECK",
  "RISK_GOVERNOR", "CONTROL_TOWER", "EXECUTION_LAYER",
  "MONITORING", "BLACK_BOX_VAULT", "REPLAY_LAB",
  "AUDIT_AI", "VALIDATION_PIPELINE", "PORTFOLIO_MANAGER",
];

export const StageGateSchema = z.object({
  passed: z.boolean(),
  reasons: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
});
export type StageGate = z.infer<typeof StageGateSchema>;

export const DecisionFlowInputSchema = z.object({
  generatedAtIso: z.string(),
  intentId: TradeIntentIdSchema,
  symbol: SymbolIdSchema,
  strategyId: StrategyIdSchema,

  // Per-stage gates supplied by the caller after running each subdomain.
  marketData:                  StageGateSchema,
  sensors:                     StageGateSchema,
  specialistAgents:            StageGateSchema,
  redBlueTeam:                 StageGateSchema,
  judge:                       StageGateSchema,
  executionMicrostructure:     StageGateSchema,
  cognitiveRisk:               StageGateSchema,
  riskGovernor:                StageGateSchema,
  controlTower:                StageGateSchema,
  executionLayer:              StageGateSchema,
  monitoring:                  StageGateSchema,
  blackBoxVault:               StageGateSchema,
  replayLab:                   StageGateSchema,
  auditAi:                     StageGateSchema,
  validationPipeline:          StageGateSchema,
  portfolioManager:            StageGateSchema,

  // Side info used to enrich reasons.
  systemMode: SystemModeSchema,
  worstSeverity: SeveritySchema,
  compositeRisk01: Score01Schema,
});
export type DecisionFlowInput = z.infer<typeof DecisionFlowInputSchema>;

export const DecisionFlowVerdictSchema = z.object({
  generatedAtIso: z.string(),
  intentId: TradeIntentIdSchema,
  symbol: SymbolIdSchema,
  strategyId: StrategyIdSchema,

  finalDecision: z.enum(["PROCEED", "HALTED"]),
  haltedAtStage: FlowStageSchema.nullable(),
  stagesPassed: z.array(FlowStageSchema),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type DecisionFlowVerdict = z.infer<typeof DecisionFlowVerdictSchema>;

export function runDecisionFlow(input: DecisionFlowInput): DecisionFlowVerdict {
  const stageGates: ReadonlyArray<readonly [FlowStage, StageGate]> = [
    ["MARKET_DATA",                     input.marketData],
    ["SENSORS",                         input.sensors],
    ["SPECIALIST_AGENTS",               input.specialistAgents],
    ["RED_TEAM_BLUE_TEAM",              input.redBlueTeam],
    ["JUDGE",                           input.judge],
    ["EXECUTION_MICROSTRUCTURE_CHECK",  input.executionMicrostructure],
    ["COGNITIVE_RISK_CHECK",            input.cognitiveRisk],
    ["RISK_GOVERNOR",                   input.riskGovernor],
    ["CONTROL_TOWER",                   input.controlTower],
    ["EXECUTION_LAYER",                 input.executionLayer],
    ["MONITORING",                      input.monitoring],
    ["BLACK_BOX_VAULT",                 input.blackBoxVault],
    ["REPLAY_LAB",                      input.replayLab],
    ["AUDIT_AI",                        input.auditAi],
    ["VALIDATION_PIPELINE",             input.validationPipeline],
    ["PORTFOLIO_MANAGER",               input.portfolioManager],
  ];

  const passed: FlowStage[] = [];
  const reasons: string[] = [
    `mode=${input.systemMode} worstSeverity=${input.worstSeverity} compositeRisk=${((input.compositeRisk01 as unknown as number)*100).toFixed(0)}%`,
  ];
  const blockers: string[] = [];

  let halted: FlowStage | null = null;
  for (const [stage, gate] of stageGates) {
    if (!gate.passed) {
      halted = stage;
      blockers.push(`halted at ${stage}`);
      blockers.push(...gate.blockers);
      reasons.push(...gate.reasons);
      break;
    }
    passed.push(stage);
    reasons.push(...gate.reasons);
  }

  return {
    generatedAtIso: input.generatedAtIso,
    intentId: input.intentId, symbol: input.symbol, strategyId: input.strategyId,
    finalDecision: halted === null ? "PROCEED" : "HALTED",
    haltedAtStage: halted,
    stagesPassed: passed,
    reasons, blockers,
  };
}
