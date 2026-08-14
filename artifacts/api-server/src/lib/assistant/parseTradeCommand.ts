// parseTradeCommand.ts — Ruby AI text/voice command → InstantTradeIntent.
//
// Ruby is allowed to act on CLEAR, DIRECT trade commands only. The parser
// returns:
//   - { kind: "OPEN", … }          — direct buy/sell/open
//   - { kind: "CLOSE_ONE", … }     — "close my EURUSD trade"
//   - { kind: "CLOSE_ALL", … }     — "close all trades"
//   - { kind: "CLOSE_PROFITABLE" } — "close all winners"
//   - { kind: "CLOSE_LOSING" }     — "close all losers"
//   - { kind: "MODIFY", … }        — "set TP to 1.0920", "move SL to break even"
//   - { kind: "MISSING_VOLUME", … } — clear intent but no lot size and no default
//   - { kind: "MISSING_SYMBOL", … } — clear intent but no symbol and no default
//   - { kind: "VAGUE" }            — analysis question, NEVER execute
//   - { kind: "UNKNOWN" }
//
// SAFETY: this parser does NOT execute anything. It returns a typed
// classification that the assistant endpoint then routes — VAGUE
// classifications NEVER reach the instant router.
// Price trigger for watch/conditional commands. `direction` is the side of
// the level we wait for; when the user didn't say above/below, it's left
// undefined and the watch engine resolves it against the live price at
// arm-time (never guessed by the parser).
export type RubyPriceTrigger = { price: number; direction?: "ABOVE" | "BELOW" };

export type RubyParsedCommand =
  | { kind: "OPEN"; side: "BUY" | "SELL"; symbol: string; volume: number; orderType: string }
  | { kind: "CLOSE_ONE"; symbol: string }
  | { kind: "CLOSE_ALL" }
  | { kind: "CLOSE_ALL_SYMBOL_UNSUPPORTED"; symbol: string }
  | { kind: "CLOSE_PROFITABLE" }
  | { kind: "CLOSE_LOSING" }
  | { kind: "PARTIAL_CLOSE"; symbol: string; fraction?: number; volume?: number }
  | { kind: "MODIFY"; positionRef: { symbol?: string }; newStopLoss?: number | "BREAK_EVEN"; newTakeProfit?: number }
  | { kind: "MOVE_SL_TO_BREAKEVEN"; positionRef: { symbol?: string } }
  | { kind: "MONITOR_TRADE"; symbol?: string }
  // WATCH_AND_ENTER is ARX's working conditional/pending entry: the watch
  // evaluator polls live price and fires a MARKET order through the same
  // gated router when the trigger is met (genuine LIMIT/STOP semantics).
  // `pendingKind` is a copy hint (the user said "limit"/"stop"); it does NOT
  // place a broker-native pending order. `expiresInMinutes`, when present,
  // arms the watch with an expiry the evaluator already honors.
  | { kind: "WATCH_AND_ENTER"; side: "BUY" | "SELL"; symbol: string; volume?: number; trigger: RubyPriceTrigger; pendingKind?: "LIMIT" | "STOP"; expiresInMinutes?: number }
  | { kind: "WATCH_AND_CLOSE"; symbol: string; trigger: RubyPriceTrigger; expiresInMinutes?: number }
  // A limit/stop entry was clearly intended but no trigger price was given —
  // ask for the price rather than guess (never place a priceless pending).
  | { kind: "PENDING_NEEDS_PRICE"; side: "BUY" | "SELL"; symbol: string; pendingKind: "LIMIT" | "STOP" }
  // Cancel a pending/conditional entry (alias of CANCEL, kept distinct so the
  // copy can name "pending order" explicitly).
  | { kind: "CANCEL_PENDING_ORDER"; symbol?: string }
  // Broker-native trailing stops are NOT executable in this build (no schema
  // column / EA path). Surfaced honestly as armed-but-not-executable.
  | { kind: "TRAILING_STOP_UNSUPPORTED"; symbol?: string }
  // Risk-percent sizing: a lot cannot be computed safely without trusted
  // broker contract specs, so Ruby asks the user to confirm an exact lot.
  | { kind: "RISK_PERCENT_SIZING"; side: "BUY" | "SELL"; symbol: string; riskPercent: number; orderType: string }
  | { kind: "SCALP_BEST_SETUP" }
  | { kind: "CANCEL" }
  | { kind: "STATUS_CHECK" }
  | { kind: "MISSING_VOLUME"; side: "BUY" | "SELL"; symbol: string }
  | { kind: "MISSING_SYMBOL"; side: "BUY" | "SELL"; volume: number }
  | { kind: "VAGUE"; reason: string }
  | { kind: "UNKNOWN" };

// Vague analysis patterns Ruby must answer, NEVER execute.
const VAGUE_PATTERNS: Array<RegExp> = [
  /\bwhat\s+should\s+i\s+(trade|buy|sell|do)\b/i,
  /\bis\s+\S+\s+(good|bullish|bearish|worth)\b/i,
  /\bdo\s+you\s+think\b/i,
  /\bshould\s+i\s+(buy|sell|trade|go|enter|short|long)\b/i,
  /\bwhere\s+is\s+\S+\s+going\b/i,
  /\bfind\s+me\s+a\s+(setup|trade|signal|entry)\b/i,
  /\bwhat\s+do\s+you\s+(think|see|recommend)\b/i,
  /\b(any|got)\s+(ideas|setups|signals)\b/i,
  /\bcan\s+you\s+analyze\b/i,
  /\bwhats?\s+(your\s+)?(view|opinion|take)\b/i,
];

// Symbol canonicaliser — accepts common aliases the user might say.
function canonSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
  if (!s) return null;
  const aliases: Record<string, string> = {
    GOLD: "XAUUSD", SILVER: "XAGUSD", OIL: "WTIUSD",
    NAS: "NAS100", NASDAQ: "NAS100", NASDAQ100: "NAS100",
    SPX: "SPX500", SP500: "SPX500", SP: "SPX500",
    DOW: "US30", DJIA: "US30",
    DAX: "GER40", GER30: "GER40",
    V75: "VOLATILITY75", V75_1S: "VOLATILITY75_1S",
    VOLATILITY75: "VOLATILITY75", VOLATILITY751S: "VOLATILITY75_1S",
    BTC: "BTCUSD", ETH: "ETHUSD",
  };
  return aliases[s] ?? s;
}

// English stop-words that happen to be 6 letters and would otherwise
// match the FX-pair regex (e.g. "trades", "orders", "losing"). Anything
// in this list is rejected as a symbol candidate. Keep additions safe:
// never add real market codes here.
const SYMBOL_STOPWORDS = new Set([
  "TRADES", "ORDERS", "LOSING", "WINNER", "MARKET", "STOPLO", "TARGET",
  "SIGNAL", "POSIT", "SYMBOL", "TICKET", "BROKER", "ACTIVE", "PROFIT",
  "MANUAL", "BUYING", "SELLIN", "CLOSED", "CANCEL", "STOPED",
]);

// Known 3-letter currency / commodity codes used to validate FX pair
// matches. If both halves of a 6-letter token aren't real currency
// codes, it's almost certainly an English word, not a symbol.
const KNOWN_CURRENCY = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD",
  "XAU", "XAG", "XPT", "XPD", "BTC", "ETH",
]);

// Extract symbol by trying single tokens then multi-word symbols
// ("Volatility 75 1s" → VOLATILITY75_1S).
function extractSymbol(text: string): string | null {
  // multi-word "Volatility 75 1s" / "Volatility 75 1 s"
  const v75 = /volatility\s*75(?:\s*1\s*s)?/i.exec(text);
  if (v75) return v75[0].replace(/\s+/g, "").toUpperCase() === "VOLATILITY751S"
    ? "VOLATILITY75_1S" : "VOLATILITY75";
  // 6-letter FX-pair-shaped token. Both 3-letter halves must be a known
  // currency code, otherwise reject (e.g. "trades", "orders" never pass).
  const fxRe = /\b([A-Za-z]{6})\b/g;
  let m: RegExpExecArray | null;
  while ((m = fxRe.exec(text)) !== null) {
    const tok = m[1]!.toUpperCase();
    if (SYMBOL_STOPWORDS.has(tok)) continue;
    const a = tok.slice(0, 3), b = tok.slice(3, 6);
    if (KNOWN_CURRENCY.has(a) && KNOWN_CURRENCY.has(b)) return canonSymbol(tok);
  }
  // index / commodity name token
  const tokMatch = /\b(gold|silver|oil|nasdaq|nas100|sp500|spx500|dow|us30|dax|ger40|btcusd|ethusd|btc|eth)\b/i.exec(text);
  if (tokMatch) return canonSymbol(tokMatch[1]!);
  return null;
}

function extractVolume(text: string): number | null {
  // "0.01 lots", "0.01 lot", "0.05", "1.5 lots". The negative lookahead stops a
  // risk-percent figure ("risk 1%", "2% risk") from being mis-read as a lot size
  // — that phrasing is handled by extractRiskPercent (ask for an exact lot).
  const m = /\b(\d+(?:\.\d+)?)\s*(?:lots?|lot)?\b(?!\s*(?:%|percent|pct))/i.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0 || v > 100) return null;
  return v;
}

function extractPrice(text: string, label: "tp" | "sl"): number | null {
  // Permissive: allows arbitrary tokens between the label and the number,
  // e.g. "set TP on EURUSD to 1.0920" or "move SL to 1.10".
  const re = label === "tp"
    ? /(?:tp|take\s*profit)[\s\S]{0,32}?(\d+(?:\.\d+)?)/i
    : /(?:sl|stop\s*loss)[\s\S]{0,32}?(\d+(?:\.\d+)?)/i;
  const m = re.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

// Conditional/trigger phrasing: "when it hits 1.09", "at 1.0950",
// "if it reaches 1.10", "above 1.20", "below 1.05". Returns the price and,
// when the user named a side, the direction. Direction-less triggers leave
// `direction` undefined — the watch engine resolves it against live price.
function extractTrigger(text: string): RubyPriceTrigger | null {
  const re = /\b(when|if|at|once|reach(?:es)?|hits?|touch(?:es)?|above|over|below|under|drops?\s+to|rises?\s+to|breaks?\s+(?:above|below))\b[\s\S]{0,24}?(\d+(?:\.\d+)?)/i;
  const m = re.exec(text);
  if (!m) return null;
  const price = Number(m[2]);
  if (!Number.isFinite(price) || price <= 0) return null;
  let direction: "ABOVE" | "BELOW" | undefined;
  if (/\b(above|over|rises?\s+to|breaks?\s+above)\b/i.test(text)) direction = "ABOVE";
  else if (/\b(below|under|drops?\s+to|breaks?\s+below)\b/i.test(text)) direction = "BELOW";
  return direction ? { price, direction } : { price };
}

// Partial-close fraction: "half" → 0.5, "a third" → ~0.33, "50%" → 0.5,
// "75 percent" → 0.75. Returns null when no fraction phrasing is present.
function extractFraction(text: string): number | null {
  if (/\bhalf\b/i.test(text)) return 0.5;
  if (/\b(a\s+)?third\b/i.test(text)) return 1 / 3;
  if (/\b(a\s+)?quarter\b/i.test(text)) return 0.25;
  const pct = /\b(\d+(?:\.\d+)?)\s*(?:%|percent|pct)(?!\w)/i.exec(text);
  if (pct) {
    const v = Number(pct[1]);
    if (Number.isFinite(v) && v > 0 && v < 100) return v / 100;
  }
  return null;
}

// Risk-percent sizing phrasing: "risk 1%", "risking 2 percent", "1% risk",
// "risk of 0.5%". Returns the percent (0 < x < 100) or null. Distinct from the
// partial-close fraction extractor — this requires the word "risk" nearby.
function extractRiskPercent(text: string): number | null {
  const a = /\brisk(?:ing)?\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*(?:%|percent|pct)(?!\w)/i.exec(text);
  const b = /\b(\d+(?:\.\d+)?)\s*(?:%|percent|pct)\s+risk\b/i.exec(text);
  const m = a ?? b;
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0 || v >= 100) return null;
  return v;
}

// Order-expiry / time-in-force phrasing for conditional entries: "expire in 30
// minutes", "good for 2 hours", "valid for 45 min", "cancel after 1h",
// "expires in 1 hour". Returns whole minutes (capped to 7 days) or null.
function extractExpiryMinutes(text: string): number | null {
  const re = /\b(?:expir\w*|good\s+for|valid\s+for|cancel\s+after|expire\s+after|time\s*in\s*force)\b[\s\S]{0,14}?(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|h|m|d)\b/i;
  const m = re.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]!.toLowerCase();
  const mins =
    unit.startsWith("d") ? n * 24 * 60
    : unit.startsWith("h") ? n * 60
    : n;
  const rounded = Math.round(mins);
  if (rounded <= 0) return null;
  return Math.min(rounded, 7 * 24 * 60);
}

// Pending-entry order-type wording: "limit" → LIMIT, "buy stop"/"stop order"/
// "stop entry" → STOP. Never matches "stop loss"/"sl" (that's a protective
// stop, handled by MODIFY/break-even). A copy hint only.
function extractPendingKind(text: string): "LIMIT" | "STOP" | null {
  if (/\blimit\b/i.test(text)) return "LIMIT";
  if (/\b(buy|sell)\s+stop\b/i.test(text) || /\bstop\s+(?:order|entry)\b/i.test(text)) return "STOP";
  return null;
}

export type ParseDefaults = {
  defaultSymbol?: string | null;
  defaultVolume?: number | null;
  defaultOrderType?: string | null;
};

export function parseTradeCommand(rawText: string, defaults: ParseDefaults = {}): RubyParsedCommand {
  const text = rawText.trim();
  if (!text) return { kind: "UNKNOWN" };

  // Cancel a pending/conditional ENTRY explicitly — "cancel my pending order",
  // "cancel the limit order", "cancel my buy stop on EURUSD". Named distinctly
  // from the generic CANCEL so the copy can say "pending order". Both route to
  // the same stand-down handler (no broker touch). Checked before generic CANCEL.
  if (/\bcancel\b/i.test(text)
      && /\b(pending|limit|stop)\s+order(s)?\b/i.test(text)
      && !/\bstop\s*loss\b/i.test(text)) {
    const symbol = extractSymbol(text) ?? undefined;
    return { kind: "CANCEL_PENDING_ORDER", ...(symbol ? { symbol } : {}) };
  }

  // Cancel a pending Ruby action — "cancel that", "never mind", "stop
  // watching", "forget it". Matched before everything else so it can't be
  // mistaken for a trade. Bare "stop" is NOT enough (collides with "stop loss").
  if (/\b(cancel(\s+(that|it|the\s+watch|my\s+watch|everything))?|never\s*mind|forget\s+it|stop\s+(watching|monitoring|the\s+watch))\b/i.test(text)
      && !/\bstop\s*loss\b/i.test(text)) {
    return { kind: "CANCEL" };
  }

  // Trailing stop — "set a trailing stop", "trail my stop 20 pips", "trailing
  // stop on EURUSD". Broker-native trailing stops are NOT executable in this
  // build (no schema column / EA path), so surface honestly rather than place a
  // fixed stop and pretend it trails. Checked before MODIFY/break-even (which
  // would otherwise swallow "stop"). Requires the word "trail".
  if (/\btrail(?:ing)?\b/i.test(text) && /\bstop\b/i.test(text)) {
    const symbol = extractSymbol(text) ?? undefined;
    return { kind: "TRAILING_STOP_UNSUPPORTED", ...(symbol ? { symbol } : {}) };
  }

  // Status check — "what are you watching?", "anything pending?", "status".
  if (/\b(what\s+are\s+you\s+(watching|monitoring|tracking)|are\s+you\s+(watching|monitoring)\s+anything|any(thing)?\s+pending|what'?s?\s+pending|(show|list)\s+(my\s+)?(watches|pending|monitors)|^status\b)\b/i.test(text)) {
    return { kind: "STATUS_CHECK" };
  }

  // Scalp-the-best-setup — explicit scalp intent. Checked BEFORE the vague
  // patterns ("find me a setup" is otherwise vague) because the user is
  // asking Ruby to act on the strongest current scalp opportunity.
  if (/\b(scalp|scalping)\b/i.test(text)
      && /\b(best|top|strongest|find|get|take|do)\b/i.test(text)) {
    return { kind: "SCALP_BEST_SETUP" };
  }

  // Vague analysis → never execute
  for (const p of VAGUE_PATTERNS) if (p.test(text)) return { kind: "VAGUE", reason: "ANALYSIS_QUESTION" };

  // Watch-and-enter — "buy EURUSD when it hits 1.09", "sell XAUUSD at 1850".
  // Must precede the immediate OPEN block (which would otherwise treat the
  // trigger price as a stray number / report MISSING_VOLUME).
  {
    const trigger = extractTrigger(text);
    const wantBuy = /\b(buy|long|go\s+long|enter\s+long)\b/i.test(text);
    const wantSell = /\b(sell|short|go\s+short|enter\s+short)\b/i.test(text);
    const pendingKind = extractPendingKind(text);
    const expiresInMinutes = extractExpiryMinutes(text);
    if (trigger && (wantBuy || wantSell)) {
      const side: "BUY" | "SELL" = wantBuy ? "BUY" : "SELL";
      const symbol = extractSymbol(text) ?? defaults.defaultSymbol ?? null;
      if (symbol) {
        // The first number is the trigger price; a second explicit "x lots"
        // is the size. Fall back to the configured default volume.
        const lotMatch = /\b(\d+(?:\.\d+)?)\s*(?:lots?|lot)\b/i.exec(text);
        const volume = lotMatch ? Number(lotMatch[1]) : (defaults.defaultVolume ?? undefined);
        return {
          kind: "WATCH_AND_ENTER", side, symbol, trigger,
          ...(typeof volume === "number" && volume > 0 ? { volume } : {}),
          ...(pendingKind ? { pendingKind } : {}),
          ...(expiresInMinutes != null ? { expiresInMinutes } : {}),
        };
      }
    }
    // Pending limit/stop entry intended but NO trigger price given — ask for
    // the price rather than guess. Never arm a priceless conditional entry.
    if (!trigger && pendingKind && (wantBuy || wantSell)) {
      const side: "BUY" | "SELL" = wantBuy ? "BUY" : "SELL";
      const symbol = extractSymbol(text) ?? defaults.defaultSymbol ?? null;
      if (symbol) return { kind: "PENDING_NEEDS_PRICE", side, symbol, pendingKind };
    }
    // Watch-and-close — "close EURUSD when it reaches 1.10".
    if (trigger && /\bclose\b/i.test(text)) {
      const symbol = extractSymbol(text) ?? defaults.defaultSymbol ?? null;
      if (symbol) return {
        kind: "WATCH_AND_CLOSE", symbol, trigger,
        ...(expiresInMinutes != null ? { expiresInMinutes } : {}),
      };
    }
  }

  // Monitor a position — "monitor my EURUSD", "watch my XAUUSD trade",
  // "keep an eye on EURUSD". No trigger price (that would be a watch-and-*).
  if (/\b(monitor|keep\s+an?\s+eye\s+on|watch\s+(my|the))\b/i.test(text)
      && !extractTrigger(text)) {
    const symbol = extractSymbol(text) ?? defaults.defaultSymbol ?? undefined;
    return { kind: "MONITOR_TRADE", ...(symbol ? { symbol } : {}) };
  }

  // Move stop to break-even — "move SL to break even", "breakeven my EURUSD",
  // "set break even". Distinct from a priced MODIFY so it maps to the
  // break-even permission. Checked before MODIFY.
  if (/\bbreak\s*even\b/i.test(text) && !extractPrice(text, "tp")) {
    const symbol = extractSymbol(text) ?? undefined;
    return { kind: "MOVE_SL_TO_BREAKEVEN", positionRef: symbol ? { symbol } : {} };
  }

  // Close-all variants. CRITICAL: if a symbol is present alongside
  // "close all" (e.g. "close all EURUSD"), we MUST NOT silently fall
  // through to account-wide CLOSE_ALL — that would liquidate every
  // open position. Return CLOSE_ALL_SYMBOL_UNSUPPORTED so the caller
  // refuses with an explicit "not implemented yet" message instead of
  // a dangerous mass-close.
  if (/\bclose\s+(all|every|everything)\b/i.test(text)) {
    if (/\b(profitable|winning|winners|in\s+profit)\b/i.test(text)) return { kind: "CLOSE_PROFITABLE" };
    if (/\b(losing|losers|in\s+loss|red)\b/i.test(text)) return { kind: "CLOSE_LOSING" };
    const sym = extractSymbol(text);
    if (sym) return { kind: "CLOSE_ALL_SYMBOL_UNSUPPORTED", symbol: sym };
    return { kind: "CLOSE_ALL" };
  }

  // Modify (SL/TP) — "set TP to 1.0920", "move SL to break even"
  if (/\b(set|move|change|update)\b/i.test(text) && /\b(stop\s*loss|sl|take\s*profit|tp)\b/i.test(text)) {
    const symbol = extractSymbol(text) ?? undefined;
    const breakEven = /\bbreak\s*even\b/i.test(text);
    const newStopLoss = breakEven
      ? ("BREAK_EVEN" as const)
      : (extractPrice(text, "sl") ?? undefined);
    const newTakeProfit = extractPrice(text, "tp") ?? undefined;
    if (newStopLoss !== undefined || newTakeProfit !== undefined) {
      return {
        kind: "MODIFY",
        positionRef: symbol ? { symbol } : {},
        ...(newStopLoss !== undefined ? { newStopLoss } : {}),
        ...(newTakeProfit !== undefined ? { newTakeProfit } : {}),
      };
    }
  }

  // Partial close — "close half my EURUSD", "close 50% of XAUUSD",
  // "close 0.01 of EURUSD", "partially close EURUSD". Checked before the
  // full CLOSE_ONE so a fraction/size isn't swallowed by a full close.
  if (/\b(close|partial(?:ly)?\s+close|take\s+(?:some|partial)\s+profit|trim|scale\s+out)\b/i.test(text)
      && !/\b(when|if)\b/i.test(text)) {
    const fraction = extractFraction(text);
    // explicit "0.01 of EURUSD" lot-out (a number followed by "of")
    const lotOf = /\b(\d+(?:\.\d+)?)\s*(?:lots?\s+)?of\b/i.exec(text);
    const partialLot = lotOf ? Number(lotOf[1]) : null;
    const isPartial = fraction != null
      || (partialLot != null && Number.isFinite(partialLot) && partialLot > 0)
      || /\b(partial(?:ly)?|take\s+(?:some|partial)\s+profit|trim|scale\s+out)\b/i.test(text);
    if (isPartial) {
      const symbol = extractSymbol(text) ?? defaults.defaultSymbol ?? null;
      if (symbol) {
        return {
          kind: "PARTIAL_CLOSE", symbol,
          ...(fraction != null ? { fraction } : {}),
          ...(partialLot != null && Number.isFinite(partialLot) && partialLot > 0 ? { volume: partialLot } : {}),
        };
      }
    }
  }

  // Close one — "close my EURUSD trade", "close EURUSD"
  if (/\bclose\b/i.test(text) && !/\b(at|when|if)\b/i.test(text)) {
    const symbol = extractSymbol(text) ?? defaults.defaultSymbol ?? null;
    if (symbol) return { kind: "CLOSE_ONE", symbol };
  }

  // Open — "buy EURUSD 0.01", "sell XAUUSD", "go long EURUSD 0.05"
  const buyMatch = /\b(buy|long|go\s+long|open\s+(?:a\s+)?(?:market\s+)?buy|enter\s+long)\b/i.test(text);
  const sellMatch = /\b(sell|short|go\s+short|open\s+(?:a\s+)?(?:market\s+)?sell|enter\s+short)\b/i.test(text);
  if (buyMatch || sellMatch) {
    const side: "BUY" | "SELL" = buyMatch ? "BUY" : "SELL";
    const symbol = extractSymbol(text) ?? defaults.defaultSymbol ?? null;
    // An explicit lot size ALWAYS wins. Risk-% sizing is only considered when
    // the user gave no explicit lot — a lot is never silently fabricated from
    // a percent (broker contract specs aren't trusted here), so Ruby asks the
    // user to confirm an exact lot instead of mis-sizing live money.
    const explicitVolume = extractVolume(text);
    const riskPercent = explicitVolume == null ? extractRiskPercent(text) : null;
    const orderType = defaults.defaultOrderType ?? (side === "BUY" ? "MARKET_BUY" : "MARKET_SELL");
    if (riskPercent != null && symbol) {
      return { kind: "RISK_PERCENT_SIZING", side, symbol, riskPercent, orderType };
    }
    const volume = explicitVolume ?? defaults.defaultVolume ?? null;
    if (!symbol && volume != null) return { kind: "MISSING_SYMBOL", side, volume };
    if (symbol && volume == null) return { kind: "MISSING_VOLUME", side, symbol };
    if (symbol && volume != null) return { kind: "OPEN", side, symbol, volume, orderType };
    return { kind: "VAGUE", reason: "MISSING_SYMBOL_AND_VOLUME" };
  }

  return { kind: "UNKNOWN" };
}
