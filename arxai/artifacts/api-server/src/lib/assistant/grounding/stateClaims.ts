// Narrow, structured checks for present-tense market-state assertions. This is
// not a general semantic truth detector. News text, examples and forecasts are
// never authority for the current chart's direction, freshness or verification.
import type { ToolOutput } from "./evidence.js";

export type MarketStateKind = "direction" | "action" | "live" | "verified";
export interface MarketStateFact {
  kind: MarketStateKind;
  value: string | null;
  symbols: string[];
  timeframe: string | null;
  path: string;
}
const TOOLS = new Set(["readChartStructure", "getFinalTradeRead", "getMarketScannerOpportunities", "getMarketSnapshot", "getSymbolMarketContext", "getTopOpportunitiesForMe", "explainOpportunityRanking"]);
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const direction = (value: unknown): string | null => typeof value !== "string" ? null
  : /^(BUY|LONG|BULLISH|UP)$/i.test(value) ? "BUY"
  : /^(SELL|SHORT|BEARISH|DOWN)$/i.test(value) ? "SELL"
  : /^(NEUTRAL|FLAT|SIDEWAYS)$/i.test(value) ? "NEUTRAL" : null;

export function collectMarketStateFacts(outputs: ToolOutput[]): MarketStateFact[] {
  const facts: MarketStateFact[] = [];
  for (const output of outputs) {
    if (!TOOLS.has(output.name)) continue;
    const seen = new WeakSet<object>();
    const walk = (value: unknown, path: string, symbols: string[], timeframe: string | null, depth: number): void => {
      if (!value || typeof value !== "object" || depth > 10 || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) { value.forEach((row, i) => walk(row, `${path}[${i}]`, symbols, timeframe, depth + 1)); return; }
      const row = value as Record<string, unknown>;
      const ownSymbols = [row.symbol, row.displaySymbol, row.ticker, row.instrument].filter((v): v is string => typeof v === "string" && v.length > 1 && v.length < 100).map(norm);
      const scope = ownSymbols.length ? ownSymbols : symbols;
      const tf = typeof row.timeframe === "string" ? row.timeframe.toUpperCase() : timeframe;
      const add = (kind: MarketStateKind, state: string | null, key: string) => facts.push({kind, value: state, symbols: scope, timeframe: tf, path: `${path}.${key}`});
      for (const key of ["direction", "bias", "trend"]) if (key in row) add("direction", direction(row[key]), key);
      for (const key of ["recommendedAction", "decision", "action"]) if (typeof row[key] === "string") {
        const action = String(row[key]);
        add("action", direction(action) ?? (/^(WAIT|WAIT_FOR_CONFIRMATION|NO_TRADE|AVOID|AVOID_FOR_NOW|REJECT|TRADE_WATCH)$/i.test(action) ? "WAIT" : null), key);
      }
      if (row.liveSetupWithheld === true) add("action", "WAIT", "liveSetupWithheld");
      if (row.canShowLiveTradeSetup === false) add("action", "WAIT", "canShowLiveTradeSetup");
      for (const key of ["isLive", "liveConfirmed", "feedConfirmed"]) if (typeof row[key] === "boolean") add("live", String(row[key]), key);
      for (const key of ["stale", "isStale", "feedUnconfirmed"]) if (row[key] === true) add("live", "false", key);
      for (const key of ["freshness", "tradeHealthFreshness"]) if (typeof row[key] === "string") {
        const value = String(row[key]);
        add("live", /^(LIVE|LIVE_CONFIRMED|REALTIME|REAL_TIME|FRESH|CURRENT)$/i.test(value) ? "true" : /^(STALE|DELAYED|UNAVAILABLE|CLOSED|OFFLINE|HISTORICAL_ONLY)$/i.test(value) ? "false" : null, key);
      }
      for (const key of ["chartVerified", "chartReadVerified"]) if (typeof row[key] === "boolean") add("verified", String(row[key]), key);
      for (const key of ["basis", "chartReadBasis"]) if (typeof row[key] === "string" && /^(VERIFIED|PARTIAL|SYNCING|INSUFFICIENT|STRUCTURAL_ONLY|UNKNOWN)$/i.test(String(row[key]))) add("verified", /^VERIFIED$/i.test(String(row[key])) ? "true" : "false", key);
      for (const [key, child] of Object.entries(row)) {
        if (/news|headline|article|scenario|condition|forecast|projection|historical|replay|example/i.test(key)) continue;
        walk(child, `${path}.${key}`, scope, tf, depth + 1);
      }
    };
    walk(output.result, output.name, [], null, 0);
  }
  return facts;
}

export interface CheckedStateClaim { text: string; start: number; end: number; grounded: boolean; paths: string[]; detail: string }
const subject = String.raw`(?:(?:the|this|your)\s+)?(?:(?:[a-z][a-z0-9_/.]{2,20})(?:\s+(?:M\d+|H\d+|D1|W1|MN1))?(?:\s+(?:setup|signal|direction|bias|structure|trend))?|setup|signal|direction|bias|structure|trend)`;
const patterns: Array<{kind: MarketStateKind; regex: RegExp}> = [
  {kind:"direction", regex:new RegExp(String.raw`\b(${subject})\s+(?:is|remains|shows)\s+(?:(?:a|an|confirmed|clear|strong|currently|now)\s+)*(BUY|SELL|bullish|bearish|neutral)\b`, "gi")},
  {kind:"live", regex:/\b((?:(?:the|this|your)\s+)?(?:[a-z][a-z0-9_/.]{2,20}\s+)?(?:price feed|market data|chart data|feed|quote))\s+(?:is|are|remains)\s+(?:(?:currently|now)\s+)*(live|real-time|fresh)\b/gi},
  {kind:"verified", regex:/\b((?:(?:the|this|your)\s+)?(?:[a-z][a-z0-9_/.]{2,20}\s+)?(?:chart read|chart reading|chart|read))\s+(?:is|has been)\s+(?:(?:fully|now|already)\s+)*(verified)\b/gi},
];

/** Ignore reported/illustrative quotations, but do not let quotation marks
 * around a claimed present fact evade checking. Keep offsets unchanged. */
function discussionText(text: string): string {
  return text.replace(/\b(?:you said|you wrote|the user said|the phrase|the example|for example|say|suppose|imagine)\s*:?\s*["“`][^"”`]*["”`]/gi, value => " ".repeat(value.length));
}
function isScenario(text: string, start: number, end: number): boolean {
  // A new "but"/semicolon starts a separate assertion; unrelated negation or
  // an earlier hypothetical cannot hide an affirmative clause that follows it.
  const before = text.slice(0, start).split(/;|\bbut\b/i).at(-1) ?? "";
  const after = text.slice(end).split(/;|\bbut\b|\band\b/i)[0] ?? "";
  return /\b(?:cannot|can't|couldn't|do not|don't)\s+(?:confirm|say|claim|assert|verify)(?:\s+that)?\s*$/i.test(before)
    || /\b(?:not|isn't)\s+(?:true|correct)\s+that\s*$/i.test(before)
    || /\bwhether\s*$/i.test(before)
    || /\b(?:if|unless|when|once|assuming|suppose|imagine|hypothetically|would|could|might|may|should)\b/i.test(before)
    || /\b(?:if|unless|once|when)\b/i.test(after) || /\?\s*$/.test(text);
}

export function checkMarketStateClaims(text: string, facts: MarketStateFact[], knownSymbols: Set<string>): CheckedStateClaim[] {
  const claims: CheckedStateClaim[] = [];
  const work = discussionText(text);
  const aliases = [...knownSymbols].filter(symbol => symbol.length > 1).sort((a, b) => b.length - a.length);
  for (const {kind, regex} of patterns) {
    for (const match of work.matchAll(regex)) {
      const start = match.index!, end = start + match[0].length;
      if (isScenario(work, start, end)) continue;
      const scopeText = match[1]!;
      const tf = /\b(M\d+|H\d+|D1|W1|MN1)\b/i.exec(scopeText)?.[1]?.toUpperCase() ?? null;
      const mentioned = aliases.filter(alias => new RegExp(`(?<![a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?![a-z0-9])`, "i").test(scopeText)).map(norm);
      // An explicit unknown ticker must not borrow the only other market's fact.
      const bareSubject = scopeText.replace(/\b(?:the|this|your|setup|signal|direction|bias|structure|trend|price|feed|market|data|quote|chart|read|reading|M\d+|H\d+|D1|W1|MN1)\b/gi, "").trim();
      if (!mentioned.length && bareSubject) mentioned.push(norm(bareSubject));
      let scoped = facts.filter(f => (!tf || f.timeframe === tf) && (!mentioned.length || f.symbols.some(symbol => mentioned.includes(symbol))));
      // With no named market, multiple symbol scopes are ambiguous. Never use
      // one market's valid status to bless another market's sentence.
      const groups = new Set(scoped.filter(f => f.symbols.length).map(f => f.symbols[0]));
      if (!mentioned.length && groups.size > 1) scoped = [];
      const desired = kind === "direction" ? direction(match[2]) : "true";
      const isSetup = kind === "direction" && /^(BUY|SELL)$/i.test(match[2]!);
      const relevant = scoped.filter(f => f.kind === kind || isSetup && f.kind === "action");
      const paths = relevant.map(f => `${f.path}=${f.value ?? "unknown"}`);
      const grounded = relevant.length > 0 && relevant.every(f => f.value === desired);
      claims.push({text:text.slice(start,end),start,end,grounded,paths,
        detail: grounded ? "Supported by scoped structured market state" : `Current ${kind} assertion is unsupported${paths.length ? `: ${paths.join(", ")}` : ": no unambiguous structured evidence for this market/timeframe"}`});
    }
  }
  return claims;
}
