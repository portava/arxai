// Eleanor voice: voice never places, changes, closes or confirms an order.
//
// A spoken utterance can be misheard, can come from someone else in the room,
// and carries no tap-to-confirm. So the instant-trade command route refuses
// every execution path for source "eleanor_voice", including the confirm resend
// and "close it" answers to a reversal alert. The only voice command it accepts
// is "keep it / hold", which acknowledges an alert and sends nothing to a
// broker. Typed commands are unchanged.

export const VOICE_EXECUTION_BLOCKED = "VOICE_EXECUTION_BLOCKED" as const;

export const VOICE_EXECUTION_BLOCKED_MESSAGE =
  "I don't place, change, close or confirm orders by voice, so nothing was sent. Type the command in the chat and confirm it there, or use the Trade Action Center.";

// Same "keep" phrasing the command route accepts for alert answers.
const KEEP_ACK_RE = /^(?:ok(?:ay)?[,\s]*)?(?:keep(?:\s+(?:it|the\s+trade|running))?|hold(?:\s+it)?|stay\s+in|leave\s+it(?:\s+open)?|don'?t\s+close(?:\s+it)?)[.!\s]*$/i;
const KEEP_SYMBOL_RE = /^(?:keep|hold)\s+[A-Za-z0-9._#-]{3,20}[.!\s]*$/i;

export type VoiceCommandDecision =
  | { allowed: true }
  | { allowed: false; classification: typeof VOICE_EXECUTION_BLOCKED; message: string };

export function voiceCommandDecision(input: { source: string; text: string; confirm: boolean }): VoiceCommandDecision {
  if (input.source !== "eleanor_voice") return { allowed: true };
  const text = input.text.trim();
  if (!input.confirm && (KEEP_ACK_RE.test(text) || KEEP_SYMBOL_RE.test(text))) return { allowed: true };
  return { allowed: false, classification: VOICE_EXECUTION_BLOCKED, message: VOICE_EXECUTION_BLOCKED_MESSAGE };
}
