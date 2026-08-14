import {
  MISTAKE_IMPACT, STRENGTH_IMPACT,
  type MistakeTag, type StrengthTag, type ScoreImpact,
} from "./tags.js";

// Build I — Pure deterministic "AI" review of a single journal entry, plus
// the rollup summarizer for review sessions. Phrased like a coaching note;
// no model call, no I/O.

export interface JournalEntryInput {
  symbol: string;
  direction: "BUY" | "SELL";
  strategyUsed: string | null;
  setupType: string | null;
  emotionalStateBefore: string | null;
  emotionalStateAfter: string | null;
  confidenceLevel: number | null;
  mistakeTags: string[];
  strengthTags: string[];
  pnl: number | null;        // pulled from the linked trade
  userNotes: string | null;
}

export interface AIReview {
  summary: string;
  discipline: string;
  execution: string;
  emotional: string;
  suggestedFocus: string[];
  generatedAtIso: string;
}

export function reviewJournalEntry(e: JournalEntryInput, nowIso: string): AIReview {
  const mistakes = e.mistakeTags as MistakeTag[];
  const strengths = e.strengthTags as StrengthTag[];

  const result = e.pnl == null ? "is still pending" : e.pnl >= 0 ? "was profitable" : "was a loss";
  const conf = e.confidenceLevel == null ? "no confidence rating" : `confidence ${e.confidenceLevel}`;
  const summary =
    `${e.direction} ${e.symbol} via ${e.strategyUsed ?? "unspecified strategy"} ${result}. ` +
    `Logged ${conf}, ${mistakes.length} mistake tag(s), ${strengths.length} strength tag(s).`;

  // Discipline narrative
  const disciplineMistakes = mistakes.filter((t) => (MISTAKE_IMPACT[t]?.discipline ?? 0) < 0);
  const disciplineStrengths = strengths.filter((t) => (STRENGTH_IMPACT[t]?.discipline ?? 0) > 0);
  const discipline = disciplineMistakes.length > 0
    ? `Discipline slipped: ${disciplineMistakes.join(", ").toLowerCase().replace(/_/g, " ")}.`
    : disciplineStrengths.length > 0
      ? `Discipline held strong: ${disciplineStrengths.join(", ").toLowerCase().replace(/_/g, " ")}.`
      : "Discipline neutral on this trade.";

  // Execution narrative
  const execMistakes = mistakes.filter((t) => (MISTAKE_IMPACT[t]?.execution ?? 0) < 0);
  const execStrengths = strengths.filter((t) => (STRENGTH_IMPACT[t]?.execution ?? 0) > 0);
  const execution = execMistakes.length > 0
    ? `Execution issues: ${execMistakes.join(", ").toLowerCase().replace(/_/g, " ")}. Consider checking trigger criteria next time.`
    : execStrengths.length > 0
      ? `Execution was clean: ${execStrengths.join(", ").toLowerCase().replace(/_/g, " ")}.`
      : "Execution was unremarkable.";

  // Emotional narrative
  const moodChanged = e.emotionalStateBefore && e.emotionalStateAfter && e.emotionalStateBefore !== e.emotionalStateAfter;
  const emotional = moodChanged
    ? `Emotional state shifted from ${e.emotionalStateBefore} to ${e.emotionalStateAfter}. Note whether the trade caused the shift or your mood drove the entry.`
    : e.emotionalStateBefore
      ? `Entered in a ${e.emotionalStateBefore} state.`
      : "No emotional state captured.";

  // Suggested focus = top 3 mistakes by absolute total impact
  const ranked = [...mistakes].sort((a, b) =>
    Math.abs(sumImpact(MISTAKE_IMPACT[b])) - Math.abs(sumImpact(MISTAKE_IMPACT[a])),
  );
  const suggestedFocus = ranked.slice(0, 3).map(humanize);

  return { summary, discipline, execution, emotional, suggestedFocus, generatedAtIso: nowIso };
}

function sumImpact(i: ScoreImpact | undefined): number {
  if (!i) return 0;
  return (i.discipline ?? 0) + (i.execution ?? 0) + (i.emotionalControl ?? 0) + (i.consistency ?? 0);
}

function humanize(tag: string): string {
  return tag.toLowerCase().split("_").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}

// ── Review session rollup ──────────────────────────────────────────────────

export interface ReviewSessionInput {
  reviewType: "WEEKLY" | "MONTHLY" | "CUSTOM";
  dateRangeStart: Date;
  dateRangeEnd: Date;
  entries: JournalEntryInput[];
}
export interface ReviewSessionOutput {
  totalTradesReviewed: number;
  biggestStrength: string | null;
  biggestWeakness: string | null;
  aiSummary: string;
  actionPlan: string[];
  metrics: {
    winRate: number;
    avgConfidence: number;
    topMistakes: Array<{ tag: string; count: number }>;
    topStrengths: Array<{ tag: string; count: number }>;
  };
}

export function summarizeReviewSession(s: ReviewSessionInput): ReviewSessionOutput {
  const total = s.entries.length;
  const wins = s.entries.filter((e) => (e.pnl ?? 0) > 0).length;
  const winRate = total === 0 ? 0 : wins / total;
  const confidences = s.entries.map((e) => e.confidenceLevel).filter((n): n is number => typeof n === "number");
  const avgConfidence = confidences.length === 0 ? 0 : confidences.reduce((a, b) => a + b, 0) / confidences.length;

  const mistakeCounts = countTags(s.entries.flatMap((e) => e.mistakeTags));
  const strengthCounts = countTags(s.entries.flatMap((e) => e.strengthTags));
  const topMistakes = topN(mistakeCounts, 5);
  const topStrengths = topN(strengthCounts, 5);

  const biggestStrength = topStrengths[0]?.tag ?? null;
  const biggestWeakness = topMistakes[0]?.tag ?? null;

  const aiSummary =
    `Reviewed ${total} trade${total === 1 ? "" : "s"}. Win rate ${(winRate * 100).toFixed(0)}%. ` +
    `Average pre-trade confidence ${avgConfidence.toFixed(0)}. ` +
    (biggestWeakness ? `Most common mistake: ${humanize(biggestWeakness)}. ` : "") +
    (biggestStrength ? `Most consistent strength: ${humanize(biggestStrength)}.` : "");

  const actionPlan: string[] = [];
  if (biggestWeakness) actionPlan.push(`This week's main improvement goal should be: stop repeating ${humanize(biggestWeakness).toLowerCase()}.`);
  if (biggestStrength) actionPlan.push(`Double down on ${humanize(biggestStrength).toLowerCase()} — it's working.`);
  if (avgConfidence < 50 && total >= 3) actionPlan.push("Confidence is low across recent trades. Take fewer setups, but better ones.");
  if (winRate < 0.4 && total >= 5) actionPlan.push("Win rate is below 50%. Review losing setups and tighten entry criteria before adding new ones.");

  return {
    totalTradesReviewed: total,
    biggestStrength, biggestWeakness, aiSummary, actionPlan,
    metrics: { winRate, avgConfidence, topMistakes, topStrengths },
  };
}

function countTags(tags: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tags) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
function topN(m: Map<string, number>, n: number): Array<{ tag: string; count: number }> {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([tag, count]) => ({ tag, count }));
}
