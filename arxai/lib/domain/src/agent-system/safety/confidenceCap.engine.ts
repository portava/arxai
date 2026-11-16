// confidenceCap — enforces an upper bound on confidence when underlying
// data is missing, stale, or self-conflicting. Never raises confidence;
// only ever lowers it. Reason is recorded for the vault.

import type { AgentSystemSnapshot } from "../agentSystem.types";
import {
  SENSOR_FRESHNESS_THRESHOLD_MS,
  type AgentDataSourceId, type AgentOutputContract,
} from "../contracts/agentContract.types";

const CAP_STALE = 0.50;          // any stale data source
const CAP_WARNINGS = 0.70;       // 2+ self-flagged warnings
const CAP_CONFLICT = 0.60;       // a blocker exists alongside a non-NEUTRAL vote

function observedAtFor(snap: AgentSystemSnapshot, src: AgentDataSourceId): string | null {
  switch (src) {
    case "market":    return snap.market.observedAt;
    case "account":   return snap.account.observedAt;
    case "execution": return snap.execution.observedAt;
    case "behavior":  return snap.behavior.observedAt;
    case "news":      return snap.news.observedAt;
    case "policy":    return null;   // policy is static reference data
    case "setup":     return null;   // setup is the proposed trade itself
  }
}

export interface ConfidenceCapApplication {
  agentId: string;
  agentName: string;
  applied: boolean;
  beforeConfidence01: number;
  afterConfidence01: number;
  cap: number | null;
  reasons: string[];
}

export function applyConfidenceCap(
  c: AgentOutputContract,
  snap: AgentSystemSnapshot,
): { contract: AgentOutputContract; application: ConfidenceCapApplication } {
  const reasons: string[] = [];
  let cap = 1.0;

  // Stale-data check: any cited source older than its freshness threshold.
  for (const src of c.dataSourcesUsed) {
    const observedIso = observedAtFor(snap, src);
    if (!observedIso) continue;
    const ageMs = snap.now.getTime() - Date.parse(observedIso);
    if (ageMs > SENSOR_FRESHNESS_THRESHOLD_MS[src]) {
      cap = Math.min(cap, CAP_STALE);
      reasons.push(`stale ${src} data (age ${(ageMs / 1000).toFixed(1)}s > ${SENSOR_FRESHNESS_THRESHOLD_MS[src] / 1000}s)`);
    }
  }
  // Self-conflict: blockers on a non-NEUTRAL vote means the agent is voting
  // and blocking at the same time — treat as conflicted.
  if (c.vote !== "NEUTRAL" && c.blockers.length > 0) {
    cap = Math.min(cap, CAP_CONFLICT);
    reasons.push(`self-conflict: ${c.blockers.length} blocker(s) alongside ${c.vote} vote`);
  }
  // Self-uncertainty: 2+ warnings indicates the agent itself isn't sure.
  if (c.warnings.length >= 2) {
    cap = Math.min(cap, CAP_WARNINGS);
    reasons.push(`high warning count (${c.warnings.length})`);
  }

  if (c.confidence01 > cap) {
    return {
      contract: {
        ...c,
        confidence01: cap,
        uncertaintyReason: c.uncertaintyReason ?? reasons.join("; "),
      },
      application: {
        agentId: c.agentId, agentName: c.agentName, applied: true,
        beforeConfidence01: c.confidence01, afterConfidence01: cap,
        cap, reasons,
      },
    };
  }
  return {
    contract: c,
    application: {
      agentId: c.agentId, agentName: c.agentName, applied: false,
      beforeConfidence01: c.confidence01, afterConfidence01: c.confidence01,
      cap: cap < 1.0 ? cap : null, reasons,
    },
  };
}
