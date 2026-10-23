// Deterministic chart-read routing (Task #602 follow-up).
//
// The chat assistant lets the model pick tools (tool_choice:"auto"). For a
// single-symbol "read/analyze <symbol>" request the model was drifting to the
// OLD getSymbolMarketContext / getTradeMarketContext path, whose 8-section UX6
// output collapses to "Data insufficient / no primary timeframe / key levels
// not available" — even though readChartStructure (the SAME shared service the
// Scanner "Ruby Chart Read" panel uses) would produce a real structural read.
//
// These helpers are PURE (no DB / no network / no LLM) so chart-read routing is
// unit-testable offline. They live in their own module — separate from the
// db-importing tools.ts — so the routing test stays in the offline `ci` lane
// instead of the DB-backed integration lane. tools.ts re-exports them.

// detectChartReadIntent is a high-precision classifier: when it returns true
// the handler FORCES tool_choice to readChartStructure on the first turn so
// chat and the Scanner panel never disagree. A miss simply falls back to "auto"
// + the (non-contradictory) system prompt, so false negatives are safe.
// We deliberately DO NOT force for account/journal analysis ("analyze my
// performance") or trade-management ("should I hold these V75 buys") — those
// keep their existing performance / trade-decision / action-draft flows.
export function detectChartReadIntent(text: string): boolean {
  const s = (text ?? "").toLowerCase();
  if (!s.trim()) return false;

  // Exclude analysis aimed at the user's OWN account / journal / performance —
  // not a market chart. These must keep getMyPerformanceSummary / journal flows.
  if (/\banaly[sz]\w*\s+(my\s+)?(performance|trades?|trading|journal|account|portfolio|p&l|pnl|results?|stats?|statistics|history|risk|exposure)\b/.test(s)) {
    return false;
  }
  // Also exclude own-trade management framed as "analyze (my) (open/current/live)
  // positions / orders / holdings" — that is trade management, not a market
  // chart read, and must keep its existing trade-decision flow.
  if (/\banaly[sz]\w*\s+(?:my\s+)?(?:open\s+|current\s+|live\s+)?(positions?|orders?|holdings?)\b/.test(s)) {
    return false;
  }

  // Symbol-looking token: Deriv synthetics (v75, boom1000, crash500, step
  // index, jump 25, volatility 75), real currency PAIRS (eurusd / eur/usd /
  // xauusd), metals / crypto / indices by name. Lowercased input. The pair
  // matcher is restricted to known currency codes so plain 6-letter words
  // (e.g. "another") never look like a symbol.
  const SYMBOL = /\b(v\d{2,4}|boom\s?\d+|crash\s?\d+|step\s?index|jump\s?\d+|volatility\s?\d+|(?:usd|eur|gbp|jpy|aud|nzd|cad|chf|xau|xag)\/?(?:usd|eur|gbp|jpy|aud|nzd|cad|chf|xau|xag)|gold|silver|btc|eth|us30|us500|nas100|ger40|uk100|spx|ndx)\b/;

  // 1. "analyze / analyse / analyzing <anything>" (verb forms) OR
  //    "analysis on/of/for <…>" — in a trading chat this is a chart read
  //    (account-analysis already excluded above). The bare NOUN "analysis"
  //    alone is intentionally NOT a trigger (e.g. "where are the analysis tools").
  if (/\banaly[sz](?:e|es|ed|ing)\b/.test(s)) return true;
  if (/\banalysis\s+(on|of|for)\b/.test(s)) return true;

  // 2. "read / redo / re-read" + chart|structure|setup, OR + this|it|that
  //    (defaults to the on-screen chart symbol), OR + a symbol token.
  if (/\b(re-?read|read|redo)\s+(?:the\s+|my\s+|this\s+|on\s+)?(chart|structure|setup)\b/.test(s)) return true;
  if (/\b(re-?read|read|redo)\s+(?:the\s+|on\s+)?(this|it|that)\b/.test(s)) return true;
  if (/\b(re-?read|read|redo)\b/.test(s) && SYMBOL.test(s)) return true;

  // 3. "chart read" / "chart structure" / "chart setup".
  if (/\bchart\s+(read|structure|setup)\b/.test(s)) return true;

  // 4. "what do / can you see" — open chart-read phrasing.
  if (/\bwhat\s+(do|can)\s+you\s+see\b/.test(s)) return true;

  // 5. "what's / whats / what is the structure/setup/read/chart" /
  //    "your read" / "a read".
  if (/\bwhat(?:'s|s|\s+is)?\s+(?:the\s+)?(structure|setup|read|chart)\b/.test(s)) return true;
  if (/\b(your|a)\s+read\b/.test(s)) return true;

  // 6. "structure/setup/bias on|for|of <symbol>".
  if (/\b(structure|setup|bias)\s+(on|for|of)\b/.test(s) && SYMBOL.test(s)) return true;

  return false;
}

// detectTradeOptionsIntent (Upgrade Eleanor Options Response Logic): high-
// precision classifier for a request for actionable trade OPTIONS / setups /
// possible entries — "what are my options", "give me setups", "possible
// entries", "where can I enter", "how would I trade this", "trade plan". Like
// detectChartReadIntent, a true result FORCES the honesty-gated readChartStructure
// on the first turn, so the structured options are built ONLY from real gated
// levels. Forcing that read is READ-ONLY, so a false positive is harmless; the
// caller ORs this with detectChartReadIntent. We DELIBERATELY exclude the
// derivatives sense of "options" (option chain / options trading), account /
// billing / withdrawal "options", and own-account performance analysis.
export function detectTradeOptionsIntent(text: string): boolean {
  const s = (text ?? "").toLowerCase();
  if (!s.trim()) return false;

  // Exclude own-account / journal / performance analysis — keep existing flows.
  if (/\banaly[sz]\w*\s+(my\s+)?(performance|trades?|trading|journal|account|portfolio|p&l|pnl|results?|stats?|statistics|history|risk|exposure|positions?|orders?|holdings?)\b/.test(s)) {
    return false;
  }
  // Exclude the DERIVATIVES sense of "option(s)" (this app trades forex /
  // synthetics, not equity options).
  if (/\boptions?\s+(trading|chain|contract|contracts|expir\w*|strike|call|put|premium|greeks?)\b/.test(s)) return false;
  if (/\boption\s+chain\b/.test(s)) return false;
  // Exclude account / billing / settings / navigation "options".
  if (/\b(payment|billing|deposit|withdraw\w*|account|settings?|menu|display|notification|subscription|privacy|security|language)\s+options?\b/.test(s)) return false;
  if (/\boptions?\s+(page|menu|tab|screen|panel|button|for\s+(?:withdraw\w*|deposit\w*|pay\w*|fund\w*|billing))\b/.test(s)) return false;

  // 1. Trade "options" in a market / setup sense.
  if (/\b(trade|trading|entry|setup|market|buy|sell|long|short)\s+options?\b/.test(s)) return true;
  if (/\b(my|any|some|possible|potential|available|best|good)\s+options?\b/.test(s)) return true;
  if (/\bwhat\s+(are|were)\s+(my|the)\s+options?\b/.test(s)) return true;
  if (/\b(give|show|list|got|get)\s+me\s+(?:some\s+|the\s+|my\s+)?options?\b/.test(s)) return true;
  if (/\boptions?\s+(on|for)\b/.test(s)) return true; // "options on V75" / "options for gold"

  // 2. Trade setups (plural) / setup ideas.
  if (/\b(trade|trading)\s+setups?\b/.test(s)) return true;
  if (/\bsetups?\b/.test(s) && /\b(any|possible|potential|good|best|show|give|list|some|what|got)\b/.test(s)) return true;
  if (/\bsetup\s+ideas?\b/.test(s)) return true;

  // 3. Possible entries / where to enter / entry points.
  if (/\b(possible|potential|good|best)\s+entr(?:y|ies)\b/.test(s)) return true;
  if (/\bentry\s+(points?|ideas?|zones?|levels?)\b/.test(s)) return true;
  if (/\bwhere\s+(?:can|do|should|would|could)\s+(?:i|we)\s+(?:get\s+in|enter|buy|sell|go\s+long|go\s+short)\b/.test(s)) return true;
  if (/\bwhere\s+to\s+(enter|get\s+in|buy|sell)\b/.test(s)) return true;

  // 4. "how would/do I trade this", trade plan / play.
  if (/\bhow\s+(would|do|should|can|could)\s+(i|you|we)\s+trade\b/.test(s)) return true;
  if (/\bhow\s+to\s+trade\b/.test(s)) return true;
  if (/\b(trade|trading)\s+plan\b/.test(s)) return true;
  if (/\bgive\s+me\s+(?:a\s+|the\s+)?(plan|play|game\s?plan)\b/.test(s)) return true;
  if (/\bwhat(?:'s|s|\s+is)?\s+(?:the\s+)?(play|game\s?plan)\b/.test(s)) return true;

  return false;
}

// OpenAI chat-completions tool_choice union (the subset we use).
export type AssistantToolChoice =
  | "auto"
  | { type: "function"; function: { name: string } };

// Pure resolver for the chat handler's per-turn tool_choice. We force the
// structural read ONLY on the first turn of a detected chart-read request;
// every later turn (and every non-chart-read request) stays "auto" so the
// model finalizes the natural-language answer and can call follow-up tools
// (e.g. getTradeMarketContext for P&L context). Forcing first-turn-only also
// prevents an infinite re-force loop.
export function resolveAssistantToolChoice(
  turn: number,
  chartReadIntent: boolean,
): AssistantToolChoice {
  if (turn === 0 && chartReadIntent) {
    return { type: "function", function: { name: "readChartStructure" } };
  }
  return "auto";
}
