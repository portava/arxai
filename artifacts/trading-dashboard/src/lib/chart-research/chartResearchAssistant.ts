// The existing assistant routes historical requests to the current chart's
// editable research panel. No remote model call, execution, or silent run.
type Handler = (text: string) => string;
let current: Handler | null = null;
export function registerChartResearchAssistant(handler: Handler): () => void {
  current = handler;
  return () => { if (current === handler) current = null; };
}
export function requestChartResearch(text: string): string | null {
  if (!/^\s*(?:please\s+)?(?:backtest|test\b.*\b(?:strategy|cross|ema|chart)|explain\s+(?:the\s+)?(?:last\s+)?(?:test|historical)\s+trade)/i.test(text)) return null;
  return current ? current(text) : "Select a ready Smart Chart with “Use chart with assistant” to prepare a historical test. No other pane was substituted. No calculation or order was run.";
}
