// agentDriftDetector — detects when one agent's behavior has drifted
// meaningfully from a baseline contract (e.g. yesterday's snapshot of the
// same agent on the same situation). Pure function: caller supplies the
// baseline (typically pulled from the vault) and the current contract.

import type { AgentOutputContract } from "../contracts/agentContract.types";
import {
  AGENT_VOTE_SCALAR, type AgentVote,
} from "../agentVote.types";
import { compareVersions } from "../contracts/agentSchemaVersion.engine";

export type DriftSeverity = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export interface AgentDriftReport {
  agentId: string;
  agentName: string;
  drifted: boolean;
  severity: DriftSeverity;
  voteDelta: number;             // 0..4 (scalar distance)
  confidenceDelta01: number;     // current - baseline
  versionCompare: ReturnType<typeof compareVersions>;
  authorityChanged: boolean;
  reasons: string[];
}

export function detectAgentDrift(
  baseline: AgentOutputContract,
  current: AgentOutputContract,
): AgentDriftReport {
  if (baseline.agentId !== current.agentId) {
    throw new Error(`drift baseline/current agentId mismatch: ${baseline.agentId} vs ${current.agentId}`);
  }
  const voteDelta = Math.abs(
    AGENT_VOTE_SCALAR[baseline.vote as AgentVote] - AGENT_VOTE_SCALAR[current.vote as AgentVote],
  );
  const confDelta = +(current.confidence01 - baseline.confidence01).toFixed(3);
  const versionCompare = compareVersions(baseline.agentVersion, current.agentVersion);
  const authorityChanged = baseline.authorityLevel !== current.authorityLevel;

  const reasons: string[] = [];
  if (voteDelta >= 3) reasons.push(`vote flipped (${baseline.vote} → ${current.vote})`);
  else if (voteDelta >= 2) reasons.push(`vote shifted ${voteDelta} steps (${baseline.vote} → ${current.vote})`);
  if (Math.abs(confDelta) >= 0.40) reasons.push(`confidence shifted by ${confDelta.toFixed(2)}`);
  if (authorityChanged) reasons.push(`authority level changed ${baseline.authorityLevel} → ${current.authorityLevel}`);
  if (versionCompare === "MAJOR_DIFF") reasons.push(`major version change ${baseline.agentVersion} → ${current.agentVersion}`);

  let severity: DriftSeverity = "NONE";
  if (authorityChanged || voteDelta >= 3 || versionCompare === "MAJOR_DIFF") severity = "HIGH";
  else if (voteDelta >= 2 || Math.abs(confDelta) >= 0.40) severity = "MEDIUM";
  else if (voteDelta >= 1 || Math.abs(confDelta) >= 0.20) severity = "LOW";

  return {
    agentId: current.agentId, agentName: current.agentName,
    drifted: severity !== "NONE",
    severity, voteDelta, confidenceDelta01: confDelta,
    versionCompare, authorityChanged, reasons,
  };
}
