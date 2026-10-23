import type { AgentVote, AiAgentContext } from "./aiAgents.types";

// Uses signal confidence + recent BoS as proxies for momentum until a
// dedicated momentum oscillator feed exists.
export function momentumAI(ctx: AiAgentContext): AgentVote {
  const conf = ctx.signal.confidence;
  const dir = ctx.signal.direction;
  const bos = ctx.structure.recentBreakOfStructure;
  const sweep = ctx.structure.recentLiquiditySweep;

  let score = conf;
  const notes: string[] = [`signal conf ${conf}`];

  // Recent BoS adds momentum confirmation
  if (bos) { score += 5; notes.push("recent BoS confirms momentum"); }

  // Opposite-side sweep suggests momentum reversal toward our direction
  if (sweep && dir) {
    const opposite = (dir === "BUY"  && sweep.side === "SELL_SIDE")
                  || (dir === "SELL" && sweep.side === "BUY_SIDE");
    if (opposite && sweep.ageBars <= 3) { score += 8; notes.push(`fresh opposite sweep (${sweep.ageBars} bars)`); }
    else if (!opposite)                  { score -= 10; notes.push("same-side sweep — momentum exhausted"); }
  }

  score = Math.max(0, Math.min(100, score));
  const bias = dir === "BUY" ? "BULLISH" : dir === "SELL" ? "BEARISH" : "NEUTRAL";
  const reasoning = `Momentum read: ${notes.join("; ")} → ${score}`;
  const evidence = { signalConf: conf, recentBoS: bos, sweep, derivedMomentum: score };

  if (score >= 75) return v("EXECUTE", score, bias, reasoning, evidence);
  if (score >= 55) return v("WAIT", score, bias, reasoning, evidence);
  return v("BLOCK", 100 - score, bias, reasoning, evidence);
}

function v(vote: AgentVote["vote"], c: number, b: AgentVote["bias"], r: string, e: Record<string, unknown>): AgentVote {
  return { agent: "momentumAI", vote, confidence: c, bias: b, reasoning: r, evidence: e, vetoBlock: false };
}
