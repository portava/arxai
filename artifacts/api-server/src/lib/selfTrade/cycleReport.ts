// Self-Trade AI — operator report for one autonomous cycle (response body of
// POST /self-trade-ai/run-autonomous-cycle).
//
// Pure shaping of RunAutonomousCycleResult; no IO. Existing fields are passed
// through unchanged. Added for the operator surface:
//   - protective.held      considered − acted (holds are also in managementHeld)
//   - protective.waitBudgetMs   the per-cycle wait for a fresh EA sweep
//   - managementHeldDetails     reason, count, kind and standalone plain-English
//                               text per hold reason (no per-position detail,
//                               no account data; that stays in the audit log)
//
// "acted" means handed to the EA through the gated pipeline. It is never a
// broker-confirmed close or stop move; those arrive via reconciliation.

import { summarizeManagementHold } from "@workspace/domain/self-trade";
import type { RunAutonomousCycleResult } from "./autonomousCycle.js";
import { PROTECTIVE_EVIDENCE_WAIT_MS } from "./protectiveActionPath.js";

export type ManagementHoldKind = "PROTECTIVE" | "OBSERVATION" | "PAUSE" | "OTHER";

export interface ManagementHoldDetail {
  reason: string;
  count: number;
  kind: ManagementHoldKind;
  text: string;
}

export interface RunCycleResponse extends Omit<RunAutonomousCycleResult, "protective"> {
  ok: true;
  protective: RunAutonomousCycleResult["protective"] & { held: number; waitBudgetMs: number };
  managementHeldDetails: ManagementHoldDetail[];
}

const KIND_ORDER: Record<ManagementHoldKind, number> = { PROTECTIVE: 0, PAUSE: 1, OBSERVATION: 2, OTHER: 3 };

function holdKind(reason: string): ManagementHoldKind {
  if (reason.startsWith("PROTECTIVE_")) return "PROTECTIVE";
  if (reason.startsWith("MANAGEMENT_OBSERVATION_")) return "OBSERVATION";
  if (reason === "MANAGEMENT_PAUSED_AACI_REVIEW") return "PAUSE";
  return "OTHER";
}

export function buildRunCycleResponse(result: RunAutonomousCycleResult): RunCycleResponse {
  const waitBudgetSec = PROTECTIVE_EVIDENCE_WAIT_MS / 1000;
  const managementHeldDetails = Object.entries(result.managementHeld)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([reason, count]) => ({
      reason,
      count,
      kind: holdKind(reason),
      text: summarizeManagementHold(reason, { waitBudgetSec }),
    }))
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.count - a.count || a.reason.localeCompare(b.reason),
    );
  return {
    ok: true,
    ...result,
    protective: {
      ...result.protective,
      held: Math.max(0, result.protective.considered - result.protective.acted),
      waitBudgetMs: PROTECTIVE_EVIDENCE_WAIT_MS,
    },
    managementHeldDetails,
  };
}
