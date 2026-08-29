// Capability #36 — journaling seam for incident counterfactual reports.
//
// Kept OUT of incidentReplay.ts so the runner stays a pure, offline-testable
// engine. The only side effect here is an append-only audit-vault event —
// the report is EVIDENCE. Nothing reads it back to change a safeguard
// parameter automatically; adopting any counterfactual configuration stays
// an owner decision.

import { shadowCaptureFAF } from "../auditVault.js";
import type { IncidentCounterfactualReport } from "./incidentReplay.js";

/** Build the audit-vault draft for one report (pure, exported for tests). */
export function buildIncidentReplayAuditDraft(report: IncidentCounterfactualReport): {
  eventType: string; source: string; severity: "INFO";
  systemMode: null; globalState: null; payload: Record<string, unknown>;
} {
  return {
    eventType: "INCIDENT_COUNTERFACTUAL_REPLAY",
    source: "REPLAY_LAB",
    severity: "INFO",
    systemMode: null,
    globalState: null,
    payload: {
      incidentId: report.incidentId,
      synthetic: report.synthetic,
      description: report.description,
      baseline: {
        params: report.baseline.params,
        realizedLossUsd: report.baseline.realizedLossUsd,
        severityScore: report.baseline.severityScore,
        incidentOccurred: report.baseline.incidentOccurred,
        dispatched: report.baseline.dispatched.length,
        blocked: report.baseline.blocked.length,
      },
      alternatives: report.alternatives.map((a) => ({
        label: a.params.label,
        params: a.params,
        verdict: a.verdict,
        realizedLossUsd: a.outcome.realizedLossUsd,
        severityScore: a.outcome.severityScore,
        incidentOccurred: a.outcome.incidentOccurred,
        explanation: a.explanation,
      })),
      preventedBy: report.preventedBy,
      reducedBy: report.reducedBy,
      advisoryOnly: true,
    },
  };
}

/** Journal one report to the audit vault (fire-and-forget, never throws). */
export function journalIncidentReplayReport(report: IncidentCounterfactualReport): void {
  shadowCaptureFAF(buildIncidentReplayAuditDraft(report));
}
