// The existing assistant routes historical requests to the current chart's
// editable research panel. No remote model call, execution, or silent run.
export type ChartResearchExplanation = (
  | { status: "ready"; text: string; netPriceUnits: number }
  | { status: "no_result" | "no_selection" | "unavailable"; reason: string }) & {benchmark?: {text:string}};
const lossPrefix = /^\s*(?:please\s+)?why\s+did\s+(?:this|the selected)\s+(?:(?:historical|simulated)\s+)?trade\b/i;
const lossQuestion = /^\s*(?:please\s+)?why\s+did\s+(?:this|the selected)\s+(?:(?:historical|simulated)\s+)?trade\s+lose(?:\s+money)?[.!?]?\s*$/i;
const explainPrefix = /^\s*(?:please\s+)?explain\s+(?:the\s+)?(?:last\s+)?(?:test|historical)\s+trade\b/i;
const explainQuestion = /^\s*(?:please\s+)?explain\s+(?:the\s+)?(?:last\s+)?(?:test|historical)\s+trade[.!?]?\s*$/i;
/** One grammar for routing and answering: rejected read-only requests never become drafts. */
function followupKind(text: string): "loss" | "explain" | "benchmark" | "unsupported" | null {
  if(/^\s*(?:please\s+)?compare\s+(?:this|the historical test)\s+with\s+buy[- ]and[- ]hold[.!?]?\s*$/i.test(text))return "benchmark";
  if(/^\s*(?:please\s+)?compare\b.*buy[- ]and[- ]hold/i.test(text))return "unsupported";
  if (lossQuestion.test(text)) return "loss";
  if (explainQuestion.test(text)) return "explain";
  return lossPrefix.test(text) || explainPrefix.test(text) ? "unsupported" : null;
}
/** Read the existing selected, source-bound receipt; never infer a trade or run one. */
export function answerChartResearchFollowup(text: string, evidence: ChartResearchExplanation | null): string | null {
  const kind = followupKind(text);
  if (kind === null) return null;
  if (kind === "unsupported") return 'Ask “Why did this trade lose?” or “Explain the historical trade” for the selected simulated trade only. Additional actions or ambiguous trade references were not applied. No calculation or order was run.';
  if(kind==="benchmark")return evidence?.benchmark?.text??"No source-bound cash-funded historical comparison is available. Run a long-only cash scenario in Test an idea first; starting capital, quantity, point value and costs must be explicit. No benchmark or return was invented and no order was sent.";
  if (!evidence) return "Select a completed simulated trade in Test an idea. No current selected historical result is available; no trade was inferred and no order was sent.";
  if (evidence.status !== "ready") return evidence.reason;
  if (kind === "explain") return evidence.text;
  if (!Number.isFinite(evidence.netPriceUnits)) return "The selected historical trade has no finite net result. Its outcome cannot be explained as a loss. No calculation or order was run.";
  const outcome = evidence.netPriceUnits < 0
    ? "The selected simulated trade lost source price units after the modeled costs. The ledger below explains the modeled exit and cost deductions; it does not establish why the market moved."
    : evidence.netPriceUnits > 0
      ? "The selected simulated trade did not lose: its recorded net result is positive after modeled costs."
      : "The selected simulated trade did not lose: its recorded net result is zero after modeled costs.";
  return `${outcome}\n${evidence.text}`;
}
type Handler = (text: string) => string;
let current: Handler | null = null;
export function registerChartResearchAssistant(handler: Handler): () => void {
  current = handler;
  return () => { if (current === handler) current = null; };
}
export function requestChartResearch(text: string): string | null {
  if (followupKind(text) === null && !/^\s*(?:please\s+)?(?:backtest|test\b.*\b(?:strategy|cross|ema|chart))/i.test(text)) return null;
  return current ? current(text) : "Select a ready Smart Chart with “Use chart with assistant” to prepare or inspect a historical test. No other pane was substituted. No calculation or order was run.";
}
