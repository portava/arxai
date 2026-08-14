import type { AgentVote, AiAgentContext } from "./aiAgents.types";

// executionAI represents the broker readiness viewpoint. Broker-level issues
// are physical constraints — they always veto.
export function executionAI(ctx: AiAgentContext): AgentVote {
  const broker = ctx.broker;
  if (!broker.health.isHealthy) {
    return vote("BLOCK", 100, "NEUTRAL",
      `Broker unhealthy: ${broker.health.reasons.join("; ") || "unknown"}`,
      { health: broker.health }, true);
  }
  if (broker.health.isStale) {
    return vote("BLOCK", 100, "NEUTRAL",
      `Broker stale (age ${broker.health.ageSeconds ?? "?"}s)`,
      { health: broker.health }, true);
  }

  const exec = broker.execution;
  if (!exec) {
    return vote("WAIT", 50, "NEUTRAL",
      "No execution-quality samples yet — insufficient data", { broker });
  }

  let score = exec.qualityScore;
  const reasons: string[] = [`broker quality ${exec.qualityScore.toFixed(0)}`];

  if (exec.avgLatencyMs > 600) {
    return vote("BLOCK", 95, "NEUTRAL", `Latency ${exec.avgLatencyMs.toFixed(0)}ms >600`, { exec }, true);
  }
  if (Math.abs(exec.avgSlippagePips ?? 0) > 1.5) {
    return vote("BLOCK", 95, "NEUTRAL",
      `Slippage ${(exec.avgSlippagePips ?? 0).toFixed(2)}p >1.5`, { exec }, true);
  }
  if (exec.avgLatencyMs > 360) { score -= 15; reasons.push("latency elevated"); }
  if (Math.abs(exec.avgSlippagePips ?? 0) > 0.9) { score -= 10; reasons.push("slippage elevated"); }

  score = Math.max(0, Math.min(100, score));
  if (score >= 75) return vote("EXECUTE", score, "NEUTRAL", reasons.join("; "), { exec });
  if (score >= 55) return vote("WAIT",    score, "NEUTRAL", reasons.join("; "), { exec });
  return vote("BLOCK", 100 - score, "NEUTRAL", reasons.join("; "), { exec });
}

function vote(v: AgentVote["vote"], c: number, b: AgentVote["bias"], r: string, e: Record<string, unknown>, veto = false): AgentVote {
  return { agent: "executionAI", vote: v, confidence: c, bias: b, reasoning: r, evidence: e, vetoBlock: veto };
}
