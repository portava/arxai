import type { AuditPort } from "./ports";
import type { PipelineOutcome, StageResult } from "./pipeline.types";
import type { DomainEvent } from "../events/domainEvents.types";

// Audit always runs — even when an upstream stage rejected. Persisting the
// rejection reasons is just as important as persisting successful events.
export async function runAudit(
  outcome: { results: StageResult[]; events: DomainEvent[] },
  port: AuditPort,
): Promise<StageResult<{ persistedCount: number }>> {
  const start = Date.now();
  try {
    if (outcome.events.length > 0) await port.record(outcome.events);
    return {
      stage: "AUDIT", status: "PASSED",
      output: { persistedCount: outcome.events.length },
      reasons: [`Recorded ${outcome.events.length} event(s)`],
      events: [],
      durationMs: Date.now() - start,
    };
  } catch (err) {
    // Audit failure must NEVER throw upstream — surface it but keep the
    // pipeline outcome intact.
    return {
      stage: "AUDIT", status: "ERRORED",
      output: null,
      reasons: [`Audit port error: ${(err as Error).message}`],
      events: [],
      durationMs: Date.now() - start,
    };
  }
}

// Convenience: append the audit result to an existing outcome.
export function withAudit(
  outcome: PipelineOutcome,
  auditResult: StageResult,
): PipelineOutcome {
  return { ...outcome, results: [...outcome.results, auditResult] };
}
