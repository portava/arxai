import { z } from "zod/v4";
import type { ExecutionPyramidContext } from "../execution-pyramid/executionPyramid.types";

// ── Vote shape — exactly as specified ─────────────────────────────────────
//   {
//     vote: "BUY" | "SELL" | "WAIT" | "BLOCK";
//     confidence: number;
//     evidence: string[];
//     blockers: string[];
//     expirationSeconds: number;
//   }
export const AgentVoteKindSchema = z.enum(["BUY", "SELL", "WAIT", "BLOCK"]);
export type AgentVoteKind = z.infer<typeof AgentVoteKindSchema>;

export const AgentVoteSchema = z.object({
  vote: AgentVoteKindSchema,
  confidence: z.number().min(0).max(100),
  evidence: z.array(z.string()),
  blockers: z.array(z.string()),
  expirationSeconds: z.number().int().min(0),
});
export type AgentVote = z.infer<typeof AgentVoteSchema>;

// ── 10 agents (matches the user's named list) ─────────────────────────────
export const AgentNameSchema = z.enum([
  "trend",
  "momentum",
  "liquidity",
  "volatility",
  "session",
  "execution",
  "risk",
  "traderDna",
  "newsMacro",
  "patternMatch",
]);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const ALL_AGENTS: ReadonlyArray<AgentName> = [
  "trend", "momentum", "liquidity", "volatility", "session",
  "execution", "risk", "traderDna", "newsMacro", "patternMatch",
];

// ── Agent input — alias the pyramid context (already aggregates every
//    slice each agent needs; avoids parallel context shapes). ──────────────
export type AgentContext = ExecutionPyramidContext;

// ── Helpers ───────────────────────────────────────────────────────────────
// Translate a signal direction into a vote kind. Constraint agents (risk,
// execution, vol, session, dna) don't pick direction — they echo the
// signal's direction when conditions allow.
export function signalDirectionAsVote(direction: "BUY" | "SELL" | null | undefined): "BUY" | "SELL" | "WAIT" {
  if (direction === "BUY")  return "BUY";
  if (direction === "SELL") return "SELL";
  return "WAIT";
}

// Build a vote with sane defaults — keeps each agent terse.
export function buildVote(input: {
  vote: AgentVoteKind;
  confidence: number;
  evidence?: string[];
  blockers?: string[];
  expirationSeconds: number;
}): AgentVote {
  return {
    vote: input.vote,
    confidence: clamp(input.confidence, 0, 100),
    evidence: input.evidence ?? [],
    blockers: input.blockers ?? [],
    expirationSeconds: Math.max(0, Math.round(input.expirationSeconds)),
  };
}

// Vote freshness check — true when the vote has not yet expired.
export function isVoteFresh(vote: AgentVote, castAt: string, now: Date = new Date()): boolean {
  const ageSec = (now.getTime() - new Date(castAt).getTime()) / 1000;
  return ageSec < vote.expirationSeconds;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
