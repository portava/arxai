// Eleanor execution (2026-11-04): the chat box is ONE input. A message that reads
// like a DIRECT trade/watch command goes to Eleanor's gated command route
// (/api/me/assistant/instant-trade-command) first; anything else, and anything
// the server classifies as VAGUE/UNKNOWN, goes to the analytical chat as
// before. This pre-filter is deliberately narrow (imperative trading verbs or a
// reply to a reversal alert) so ordinary questions never touch the command
// route — the server's parser is the authority on what is a command.

const COMMAND_START =
  /^(?:ok(?:ay)?[,\s]+|please\s+|eleanor[,\s]+|hey\s+eleanor[,\s]+)?(?:buy|sell|long|short|go\s+long|go\s+short|close|exit|flatten|partial(?:ly)?\s+close|take\s+(?:half|partial)|move\s+(?:my\s+)?(?:stop|sl)|set\s+(?:my\s+)?(?:stop|sl|tp|take\s+profit)|breakeven|break\s+even|monitor|watch|track|cancel|stand\s+down|status|what\s+are\s+you\s+watching|scalp)\b/i;

const ALERT_REPLY =
  /^(?:ok(?:ay)?[,\s]*)?(?:keep(?:\s+(?:it|the\s+trade|running|[A-Za-z0-9._#-]{3,20}))?|hold(?:\s+it)?|stay\s+in|leave\s+it(?:\s+open)?|don'?t\s+close(?:\s+it)?|close\s+it(?:\s+now)?)[.!\s]*$/i;

const QUESTION_HINT = /\?\s*$|^(?:should|could|would|can|do|does|is|are|what|why|how|when|where|which)\b/i;

export function looksLikeEleanorCommand(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (ALERT_REPLY.test(t)) return true;
  // "should I buy EURUSD?" / "what do you think about closing?" are questions
  // for the analyst, not commands — even though they contain trading verbs.
  if (QUESTION_HINT.test(t)) return false;
  if (t.length > 160) return false;
  return COMMAND_START.test(t);
}

/** Classifications that mean "this was not a command — hand it to the chat". */
export const NOT_A_COMMAND = new Set(["VAGUE", "UNKNOWN"]);

export function eleanorCommandHandled(resp: { ok?: boolean; classification?: string; error?: string } | null | undefined): boolean {
  if (!resp) return false;
  if (resp.classification && NOT_A_COMMAND.has(resp.classification)) return false;
  // A transport failure (HTTP_xxx) must not swallow the message either.
  if (!resp.classification && typeof resp.error === "string" && /^HTTP_/.test(resp.error)) return false;
  return true;
}

// ── Account mode for the command route ─────────────────────────────────────
// The instant-trade route only executes accountMode "live". A LIVE_SHARED user
// is a live user whether or not they have armed one-click (same rule as
// QuickTradeModal); while the mode is still loading we fail closed to "demo".
export function eleanorCommandAccountMode(mode: {
  isLoading?: boolean;
  isLiveShared?: boolean;
  isLiveArmed?: boolean;
}): "live" | "demo" {
  if (mode.isLoading) return "demo";
  return mode.isLiveShared === true || mode.isLiveArmed === true ? "live" : "demo";
}

const SETTINGS_PATH = "Settings → ARX Single Confirm (One-Click)";

/** Plain-language sentence for a refusal code from the command route. Returns
 *  null for codes it does not know, so the caller can fall back to the server's
 *  own message. Never echoes a raw code to the user. */
export function friendlyEleanorCommandError(code: string | null | undefined, name: string): string | null {
  if (!code) return null;
  const perm = (what: string, toggle: string) =>
    `${name} isn't allowed to ${what} yet. Turn on "${toggle}" under ${name} execution authority in ${SETTINGS_PATH}.`;
  switch (code) {
    case "ELEANOR_OPEN_COMMANDS_NOT_ENABLED": return perm("open new trades", "Open new trades");
    case "ELEANOR_CLOSE_COMMANDS_NOT_ENABLED": return perm("close trades", "Close trades");
    case "ELEANOR_MODIFY_COMMANDS_NOT_ENABLED": return perm("change stop loss / take profit", "Change stop loss / take profit");
    case "ELEANOR_PARTIAL_CLOSE_NOT_ENABLED": return perm("partially close trades", "Partial close");
    case "ELEANOR_BREAK_EVEN_NOT_ENABLED": return perm("move your stop to break-even", "Move stop to break-even");
    case "ELEANOR_TRADING_NOT_ENABLED":
    case "ELEANOR_ADVISE_ONLY_MODE":
    case "ELEANOR_AI_AUTO_NOT_ENABLED":
      return `${name} can't act on commands right now. Set ${name} execution authority to "AI-Assisted" in ${SETTINGS_PATH}.`;
    case "ELEANOR_LOT_CAP_EXCEEDED": return `That size is above your "Max lot per ${name} trade" cap. Use a smaller lot or raise the cap in ${SETTINGS_PATH}.`;
    case "ELEANOR_SYMBOL_NOT_ALLOWED": return `That market isn't on ${name}'s allowed symbol list.`;
    case "ELEANOR_ASSET_CLASS_NOT_ALLOWED": return `That asset class isn't on ${name}'s allowed list.`;
    case "ELEANOR_MAX_OPEN_POSITIONS_REACHED": return `You've reached your "Max open ${name} positions" cap — close one first or raise the cap in ${SETTINGS_PATH}.`;
    case "ELEANOR_DAILY_TRADE_LIMIT_REACHED": return `You've reached your "Max ${name} trades per day" cap for today.`;
    case "UNSUPPORTED_ACCOUNT_MODE_FOR_INSTANT_LIVE":
      return `${name} commands run on your live account only, and your account isn't in live mode. Use the trade ticket for demo trades.`;
    case "LIVE_ONE_CLICK_DISABLED":
      return `Live one-click isn't armed, so I can't open this trade from chat. Arm one-click in ${SETTINGS_PATH}, or place it from the trade ticket.`;
    case "MASTER_LIVE_USER_ACCESS_BLOCKED":
      return "Your account doesn't have live trading access yet, so I can't send this to the broker.";
    default: return null;
  }
}

/** The chat reply for one command-route response. */
export function eleanorCommandReplyText(
  resp: { ok?: boolean; message?: string; error?: string; retryAfterSeconds?: number },
  name: string,
): string {
  if (resp.error === "rate_limited") return `Too many commands — try again in ${resp.retryAfterSeconds ?? 60} s.`;
  const friendly = resp.ok ? null : friendlyEleanorCommandError(resp.error, name);
  if (friendly) return friendly;
  if (resp.message) return resp.message;
  if (resp.ok) return "Done.";
  return "I couldn't do that just now. Please try again.";
}

/** A non-live user can't execute from chat: answer before showing Confirm. */
export function eleanorNotLiveReply(name: string): string {
  return `${name} commands run on your live account only, and your account isn't in live mode right now — so I haven't sent anything. Use the trade ticket for demo trades, or switch to live and arm one-click in ${SETTINGS_PATH}.`;
}
