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
