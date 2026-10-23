import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Compliance Log — append-only audit trail of every rule application,
// veto, promotion, demotion, and constitution check across the system.
// Replay-grade record: given the log, the entire firm's risk-related
// decisions can be reconstructed.
//
// Append-only by contract: the Port has NO update or delete methods.
// ═══════════════════════════════════════════════════════════════════════════

export const ComplianceEventKindSchema = z.enum([
  "RULE_APPLIED",
  "VETO",
  "PROMOTION",
  "DEMOTION",
  "RETIRE",
  "CONSTITUTION_CHECK",
  "KILL_SWITCH_TRIPPED",
  "KILL_SWITCH_RESET",
  "RL_ADMISSION",
  "MANUAL_OVERRIDE",
]);
export type ComplianceEventKind = z.infer<typeof ComplianceEventKindSchema>;

export interface ComplianceEntry {
  entryId: string;
  recordedAt: string;
  kind: ComplianceEventKind;
  source: string;                       // subdomain or component name
  subjectId: string;                    // strategy/decision/agent id this concerns
  outcome: string;                      // short token: "COMPLIANT", "VIOLATION", "EXECUTE", etc
  detail: string;                       // human-readable narrative
  reasons: string[];
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface ComplianceLogPort {
  append(entry: ComplianceEntry): Promise<void>;
  list(filter?: {
    since?: Date;
    until?: Date;
    kind?: ComplianceEventKind;
    subjectId?: string;
  }): Promise<ComplianceEntry[]>;
  // NOTE: intentionally NO update / delete — append-only by contract.
}
