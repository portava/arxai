// Build FF — Sniper Entry Filter.
//
// Pure function. Scores a Build AA decision + Build DD market summary +
// CC mistake warnings + cooldown context. Returns PASS/WAIT/REJECT.
// Only PASS may be paper-executed by FF.

import type { TradeDecision } from "../../routes/tradeDecision.js";
import type { SniperResult } from "./types.js";

export function runSniperFilter(args: {
  decision: TradeDecision;
  minSniperEntryScore: number;
  conflict: { sameSymbolDirOpen: number; totalOpen: number; maxOpen: number; maxSameSym: number };
  cooldown: { active: boolean; reason: string | null; until: string | null };
  recentMistakeWarnings?: string[];
}): SniperResult {
  const d = args.decision;
  const reasons: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const c: Record<string, number> = {};
  let score = 0;

  // Hard short-circuits ─ REJECT immediately.
  if (!d.shouldTrade || d.action === "HOLD") {
    blockers.push(`AA shouldTrade=${d.shouldTrade} action=${d.action}`);
    return { sniperEntryScore: 0, status: "REJECT", reasons, blockers, warnings, components: c };
  }
  if (args.conflict.sameSymbolDirOpen >= args.conflict.maxSameSym) {
    blockers.push(`Same-symbol/dir conflict: ${args.conflict.sameSymbolDirOpen} open ≥ cap ${args.conflict.maxSameSym}`);
    return { sniperEntryScore: 0, status: "REJECT", reasons, blockers, warnings, components: c };
  }
  if (args.conflict.totalOpen >= args.conflict.maxOpen) {
    blockers.push(`Open paper trades cap hit (${args.conflict.totalOpen}/${args.conflict.maxOpen})`);
    return { sniperEntryScore: 0, status: "REJECT", reasons, blockers, warnings, components: c };
  }
  if (args.cooldown.active) {
    blockers.push(`Cooldown active until ${args.cooldown.until} — ${args.cooldown.reason}`);
    return { sniperEntryScore: 0, status: "REJECT", reasons, blockers, warnings, components: c };
  }
  if (d.stopLoss == null || d.takeProfit == null || !d.positionSize || d.positionSize <= 0) {
    blockers.push("Decision missing SL/TP/positionSize");
    return { sniperEntryScore: 0, status: "REJECT", reasons, blockers, warnings, components: c };
  }
  const md = d.marketDataSummary;
  if (!md) {
    blockers.push("Missing Build DD marketDataSummary");
    return { sniperEntryScore: 0, status: "REJECT", reasons, blockers, warnings, components: c };
  }
  if (md.dataQualityStatus === "MISSING") {
    blockers.push("DD market data quality MISSING");
    return { sniperEntryScore: 0, status: "REJECT", reasons, blockers, warnings, components: c };
  }
  if (d.tradeWindow.status === "AVOID") {
    blockers.push(`AA tradeWindow=AVOID (${d.tradeWindow.reason})`);
    return { sniperEntryScore: 0, status: "REJECT", reasons, blockers, warnings, components: c };
  }

  // ── Component scoring (each 0..max) ──
  // 1. Spread quality (0..15) — tighter is better
  const spreadPct = md.mid > 0 ? md.spread / md.mid : 1;
  c.spread = spreadPct < 0.0005 ? 15 : spreadPct < 0.001 ? 12 : spreadPct < 0.003 ? 8 : spreadPct < 0.005 ? 4 : 0;
  if (c.spread < 8) warnings.push(`Spread ${(spreadPct * 100).toFixed(3)}% is wide`);
  score += c.spread;

  // 2. Volatility stability (0..10)
  c.volatility = md.volatilityLevel === "NORMAL" ? 10 : md.volatilityLevel === "LOW" ? 7 : md.volatilityLevel === "HIGH" ? 4 : 0;
  if (md.volatilityLevel === "EXTREME") {
    blockers.push("Volatility EXTREME");
    return { sniperEntryScore: 0, status: "REJECT", reasons, blockers, warnings, components: c };
  }
  score += c.volatility;

  // 3. Liquidity / session (0..10)
  c.liquidity = md.liquidityLevel === "HIGH" ? 10 : md.liquidityLevel === "MEDIUM" ? 7 : md.liquidityLevel === "LOW" ? 3 : 0;
  if (c.liquidity < 7) warnings.push(`Liquidity is ${md.liquidityLevel}`);
  score += c.liquidity;

  // 4. Candle confirmation = candlesAvailable adequacy (0..5)
  c.candle = md.candlesAvailable >= 100 ? 5 : md.candlesAvailable >= 50 ? 3 : md.candlesAvailable >= 20 ? 1 : 0;
  score += c.candle;

  // 5. Risk/reward quality (0..15)
  const entry = md.mid;
  const slDist = Math.abs(entry - d.stopLoss);
  const tpDist = Math.abs(d.takeProfit - entry);
  const rr = slDist > 0 ? tpDist / slDist : 0;
  c.rr = rr >= 3 ? 15 : rr >= 2 ? 12 : rr >= 1.5 ? 8 : rr >= 1 ? 4 : 0;
  if (rr < 1.5) warnings.push(`RR ratio ${rr.toFixed(2)} below 1.5`);
  score += c.rr;

  // 6. Distance to SL is reasonable (not too tight, not absurd) (0..5)
  const slPct = entry > 0 ? slDist / entry : 0;
  c.slDistance = slPct >= 0.001 && slPct <= 0.10 ? 5 : slPct > 0.10 ? 0 : 2;
  if (c.slDistance < 5) warnings.push(`SL distance ${(slPct * 100).toFixed(2)}% of price is unusual`);
  score += c.slDistance;

  // 7. Distance to TP is achievable (0..5)
  const tpPct = entry > 0 ? tpDist / entry : 0;
  c.tpDistance = tpPct >= 0.001 && tpPct <= 0.30 ? 5 : 1;
  score += c.tpDistance;

  // 8. AA confidence vs sniper threshold (0..15)
  c.confidence = d.confidence >= 85 ? 15 : d.confidence >= 75 ? 12 : d.confidence >= 65 ? 8 : d.confidence >= 55 ? 4 : 0;
  score += c.confidence;

  // 9. AA risk score inverted (0..10)
  c.risk = d.riskScore <= 20 ? 10 : d.riskScore <= 40 ? 7 : d.riskScore <= 60 ? 3 : 0;
  score += c.risk;

  // 10. Trade window status (0..5)
  c.window = d.tradeWindow.status === "GOOD" ? 5 : d.tradeWindow.status === "WAIT" ? 2 : 0;
  if (d.tradeWindow.status !== "GOOD") warnings.push(`AA tradeWindow=${d.tradeWindow.status} (${d.tradeWindow.reason})`);
  score += c.window;

  // 11. CC known mistake warnings (0..5, penalty)
  const mistakes = [...(d.knownMistakeWarnings ?? []), ...(args.recentMistakeWarnings ?? [])];
  if (mistakes.length === 0) c.mistakes = 5;
  else if (mistakes.length <= 1) c.mistakes = 2;
  else c.mistakes = 0;
  if (mistakes.length > 0) warnings.push(`CC has ${mistakes.length} mistake warning(s) for this setup`);
  score += c.mistakes;

  const sniperEntryScore = Math.max(0, Math.min(100, Math.round(score)));

  // Decide
  let status: SniperResult["status"];
  if (sniperEntryScore >= args.minSniperEntryScore) {
    status = "PASS";
    reasons.push(`Composite sniper score ${sniperEntryScore} ≥ threshold ${args.minSniperEntryScore}`);
  } else if (sniperEntryScore >= args.minSniperEntryScore - 15) {
    status = "WAIT";
    reasons.push(`Sniper score ${sniperEntryScore} below threshold ${args.minSniperEntryScore} — wait for better setup`);
  } else {
    status = "REJECT";
    reasons.push(`Sniper score ${sniperEntryScore} far below threshold ${args.minSniperEntryScore}`);
  }

  return { sniperEntryScore, status, reasons, blockers, warnings, components: c };
}
