// Tiny window-event bus so any surface can open the assistant chat panel with
// a question already typed in (e.g. the position side card's "Ask Eleanor").
// The panel's own conversation + stream reader then handle the turn, so no
// second SSE parser and no throw-away conversations.

export const ASSISTANT_PROMPT_EVENT = "arx:assistant-prompt";

export type AssistantPromptDetail = { text: string };

export function openAssistantWithPrompt(text: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent<AssistantPromptDetail>(ASSISTANT_PROMPT_EVENT, { detail: { text } }));
  } catch { /* noop */ }
}

/** Subscribe; returns an unsubscribe function. */
export function onAssistantPrompt(handler: (text: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const text = (e as CustomEvent<AssistantPromptDetail>).detail?.text;
    if (typeof text === "string" && text.trim()) handler(text);
  };
  window.addEventListener(ASSISTANT_PROMPT_EVENT, listener);
  return () => window.removeEventListener(ASSISTANT_PROMPT_EVENT, listener);
}

/** Chat-route rate limit (429) copy; `retryAfterSeconds` from the body or header. */
export function chatRateLimitedText(retryAfterSeconds: number | null | undefined): string {
  return typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
    ? `You've sent a lot of messages — try again in ${retryAfterSeconds} s.`
    : "You've sent a lot of messages — try again in a minute.";
}
