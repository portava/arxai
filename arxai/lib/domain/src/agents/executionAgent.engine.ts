import { buildVote, signalDirectionAsVote, type AgentContext, type AgentVote } from "./agents.types";

// Broker state changes fast — short expiration.
const EXPIRATION_SEC = 30;

export function executionAgent(ctx: AgentContext): AgentVote {
  const broker = ctx.broker;
  const evidence: string[] = [];
  const blockers: string[] = [];

  if (!broker.health.isHealthy) {
    blockers.push(`broker unhealthy: ${broker.health.reasons.join("; ") || "unknown"}`);
    return buildVote({ vote: "BLOCK", confidence: 100, blockers, evidence,
      expirationSeconds: EXPIRATION_SEC });
  }
  if (broker.health.isStale) {
    blockers.push(`broker connection stale (${broker.health.ageSeconds ?? "?"}s)`);
    return buildVote({ vote: "BLOCK", confidence: 100, blockers, evidence,
      expirationSeconds: EXPIRATION_SEC });
  }

  const exec = broker.execution;
  if (!exec) {
    return buildVote({ vote: "WAIT", confidence: 50,
      evidence: ["no execution-quality samples yet"],
      expirationSeconds: EXPIRATION_SEC });
  }
  evidence.push(`broker quality ${exec.qualityScore.toFixed(0)}`);
  evidence.push(`avg latency ${exec.avgLatencyMs.toFixed(0)}ms`);
  evidence.push(`avg slippage ${(exec.avgSlippagePips ?? 0).toFixed(2)}p`);

  if (exec.avgLatencyMs > 600) {
    blockers.push(`latency ${exec.avgLatencyMs.toFixed(0)}ms > 600ms`);
    return buildVote({ vote: "BLOCK", confidence: 95, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }
  if (Math.abs(exec.avgSlippagePips ?? 0) > 1.5) {
    blockers.push(`slippage ${(exec.avgSlippagePips ?? 0).toFixed(2)}p > 1.5p`);
    return buildVote({ vote: "BLOCK", confidence: 95, evidence, blockers,
      expirationSeconds: EXPIRATION_SEC });
  }

  let score = exec.qualityScore;
  if (exec.avgLatencyMs > 360) { score -= 15; evidence.push("latency elevated"); }
  if (Math.abs(exec.avgSlippagePips ?? 0) > 0.9) { score -= 10; evidence.push("slippage elevated"); }
  score = Math.max(0, Math.min(100, score));

  if (score < 55) {
    return buildVote({ vote: "WAIT", confidence: score, evidence,
      expirationSeconds: EXPIRATION_SEC });
  }
  return buildVote({
    vote: signalDirectionAsVote(ctx.signal.direction),
    confidence: score, evidence, expirationSeconds: EXPIRATION_SEC,
  });
}
