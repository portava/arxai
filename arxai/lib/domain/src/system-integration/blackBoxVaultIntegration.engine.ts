import { z } from "zod/v4";
import {
  SeveritySchema, VaultEventSchema, VaultEventKindSchema,
  type Severity, type VaultEvent,
} from "./systemIntegration.types";

// ═══════════════════════════════════════════════════════════════════════════
// Black Box Vault Integration
// Pure mapper — produces a list of structured VaultEvent records for the
// caller to persist in the Black Box Vault. Covers all 7 upgrade layers.
// ═══════════════════════════════════════════════════════════════════════════

const SimpleEventSchema = z.object({
  severity: SeveritySchema,
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
type SimpleEvent = z.infer<typeof SimpleEventSchema>;

export const VaultIntegrationInputSchema = z.object({
  generatedAtIso: z.string(),
  microstructureWarnings: z.array(SimpleEventSchema).default([]),
  resilienceEvents:       z.array(SimpleEventSchema).default([]),
  cognitiveRiskEvents:    z.array(SimpleEventSchema).default([]),
  complexityEvents:       z.array(SimpleEventSchema).default([]),
  stressTestResults:      z.array(SimpleEventSchema).default([]),
  explanationNarratives:  z.array(SimpleEventSchema).default([]),
  attentionPriorityDecisions: z.array(SimpleEventSchema).default([]),
});
export type VaultIntegrationInput = z.infer<typeof VaultIntegrationInputSchema>;

export const VaultIntegrationOutputSchema = z.object({
  generatedAtIso: z.string(),
  events: z.array(VaultEventSchema),
  countsByKind: z.record(VaultEventKindSchema, z.int().nonnegative()),
  worstSeverity: SeveritySchema,
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type VaultIntegrationOutput = z.infer<typeof VaultIntegrationOutputSchema>;

const SEVERITY_ORDER: Record<Severity, number> = {
  INFO: 0, WARN: 1, DANGER: 2, CRITICAL: 3,
};

function worstOf(events: ReadonlyArray<VaultEvent>): Severity {
  let worst: Severity = "INFO";
  for (const e of events) {
    if (SEVERITY_ORDER[e.severity] > SEVERITY_ORDER[worst]) worst = e.severity;
  }
  return worst;
}

function pack(
  kind: VaultIntegrationOutput["events"][number]["kind"],
  generatedAtIso: string,
  src: ReadonlyArray<SimpleEvent>,
): VaultEvent[] {
  return src.map((e) => ({
    kind, generatedAtIso,
    severity: e.severity, summary: e.summary, payload: e.payload,
  }));
}

export function runBlackBoxVaultIntegration(input: VaultIntegrationInput): VaultIntegrationOutput {
  const events: VaultEvent[] = [
    ...pack("MICROSTRUCTURE_WARNING",      input.generatedAtIso, input.microstructureWarnings),
    ...pack("RESILIENCE_EVENT",            input.generatedAtIso, input.resilienceEvents),
    ...pack("COGNITIVE_RISK_EVENT",        input.generatedAtIso, input.cognitiveRiskEvents),
    ...pack("COMPLEXITY_EVENT",            input.generatedAtIso, input.complexityEvents),
    ...pack("STRESS_TEST_RESULT",          input.generatedAtIso, input.stressTestResults),
    ...pack("EXPLANATION_NARRATIVE",       input.generatedAtIso, input.explanationNarratives),
    ...pack("ATTENTION_PRIORITY_DECISION", input.generatedAtIso, input.attentionPriorityDecisions),
  ];

  const countsByKind = {
    MICROSTRUCTURE_WARNING:      input.microstructureWarnings.length,
    RESILIENCE_EVENT:            input.resilienceEvents.length,
    COGNITIVE_RISK_EVENT:        input.cognitiveRiskEvents.length,
    COMPLEXITY_EVENT:            input.complexityEvents.length,
    STRESS_TEST_RESULT:          input.stressTestResults.length,
    EXPLANATION_NARRATIVE:       input.explanationNarratives.length,
    ATTENTION_PRIORITY_DECISION: input.attentionPriorityDecisions.length,
  };

  const worst = worstOf(events);
  const reasons: string[] = [`packed ${events.length} vault event(s); worst severity ${worst}`];
  const blockers: string[] = worst === "CRITICAL"
    ? ["one or more CRITICAL events recorded — caller must trip system safeguards"]
    : [];

  return {
    generatedAtIso: input.generatedAtIso,
    events, countsByKind, worstSeverity: worst, reasons, blockers,
  };
}
