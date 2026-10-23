import { z } from "zod/v4";
import type { AgentName, AgentVote } from "./agents.types";

// ── Display states ────────────────────────────────────────────────────────
//   BUY/SELL/WAIT/BLOCK : echo of the vote kind
//   PASS                : constraint agent approves with no caution
//   WARNING             : constraint agent approves with elevated concern,
//                         or constraint agent voting WAIT
export const DisplayStatusSchema = z.enum([
  "BUY", "SELL", "WAIT", "BLOCK", "PASS", "WARNING",
]);
export type DisplayStatus = z.infer<typeof DisplayStatusSchema>;

export const AgentDisplaySchema = z.object({
  agent: z.string(),                 // narrowed at boundary; AgentName is the source
  label: z.string(),
  status: DisplayStatusSchema,
  reason: z.string().nullable(),
  confidence: z.number(),
  expirationSeconds: z.number(),
});
export type AgentDisplay = z.infer<typeof AgentDisplaySchema> & { agent: AgentName };

// ── Human labels — match the user's spec wording exactly ──────────────────
export const AGENT_LABELS: Record<AgentName, string> = {
  trend:        "Trend Agent",
  momentum:     "Momentum Agent",
  liquidity:    "Liquidity Agent",
  volatility:   "Volatility Agent",
  session:      "Session Agent",
  execution:    "Execution Agent",
  risk:         "Risk Agent",
  traderDna:    "Trader DNA Agent",
  newsMacro:    "News/Macro Agent",
  patternMatch: "Pattern Match Agent",
};

// ── Agent classification ──────────────────────────────────────────────────
// Direction-picking agents have an inherent directional read; their vote
// kind is shown literally. Constraint agents echo the signal direction
// when conditions allow; their vote kind maps to PASS / WARNING / BLOCK.
const DIRECTION_PICKING: ReadonlySet<AgentName> = new Set<AgentName>([
  "trend", "momentum", "liquidity", "newsMacro", "patternMatch",
]);
const CONSTRAINT: ReadonlySet<AgentName> = new Set<AgentName>([
  "volatility", "session", "execution", "risk", "traderDna",
]);

// Evidence keywords that demote PASS → WARNING for a constraint agent.
// Match any substring case-insensitively against an evidence line.
const WARNING_KEYWORDS: ReadonlyArray<string> = [
  "elevated", "abnormal", "approaching", "drift", "trap", "edge",
  "stress", "outside", "exhausted", "risk-off", "low ", "elevated",
  "closing soon", "just opened", "near", "spike", "expansion",
];

const PASS_CONFIDENCE_FLOOR = 70;

// ── Formatter ─────────────────────────────────────────────────────────────
export function formatAgentVote(agent: AgentName, vote: AgentVote): AgentDisplay {
  const label = AGENT_LABELS[agent];
  const base = { agent, label, confidence: vote.confidence, expirationSeconds: vote.expirationSeconds };

  // BLOCK is universal — every agent shows BLOCK with its top blocker.
  if (vote.vote === "BLOCK") {
    return { ...base, status: "BLOCK", reason: vote.blockers[0] ?? vote.evidence[0] ?? null };
  }

  const isConstraint = CONSTRAINT.has(agent);
  const cautioned = vote.evidence.some((e) => containsWarningWord(e));

  if (isConstraint) {
    if (vote.vote === "WAIT") {
      return { ...base, status: "WARNING", reason: pickReason(vote) };
    }
    // BUY or SELL — constraint agent is echoing the signal direction
    if (cautioned || vote.confidence < PASS_CONFIDENCE_FLOOR) {
      return { ...base, status: "WARNING", reason: pickReason(vote) };
    }
    return { ...base, status: "PASS", reason: null };
  }

  // Direction-picking agent — show BUY / SELL / WAIT literally
  if (!DIRECTION_PICKING.has(agent)) {
    // Defensive: every AgentName is in one of the two sets, but keep the
    // formatter total in case the AgentName enum is extended later.
    return { ...base, status: vote.vote, reason: pickReason(vote) };
  }
  if (vote.vote === "WAIT") {
    return { ...base, status: "WAIT", reason: pickReason(vote) };
  }
  // BUY or SELL — direction agent committing to a side
  return { ...base, status: vote.vote, reason: cautioned ? pickReason(vote) : null };
}

// ── Render helpers ────────────────────────────────────────────────────────
//   "Trend Agent: BUY"
//   "Liquidity Agent: WAIT — price is near trap zone"
//   "Volatility Agent: WARNING — candle expansion abnormal"
export function renderAgentLine(d: AgentDisplay): string {
  return d.reason ? `${d.label}: ${d.status} — ${d.reason}` : `${d.label}: ${d.status}`;
}

export function renderAgentPanel(
  votes: ReadonlyArray<{ agent: AgentName; vote: AgentVote }>,
): string[] {
  return votes.map(({ agent, vote }) => renderAgentLine(formatAgentVote(agent, vote)));
}

// ── Internals ─────────────────────────────────────────────────────────────
function pickReason(vote: AgentVote): string | null {
  if (vote.blockers.length > 0) return vote.blockers[0];
  const cautioned = vote.evidence.find((e) => containsWarningWord(e));
  if (cautioned) return cautioned;
  return vote.evidence[0] ?? null;
}

function containsWarningWord(s: string): boolean {
  const lo = s.toLowerCase();
  return WARNING_KEYWORDS.some((k) => lo.includes(k));
}
