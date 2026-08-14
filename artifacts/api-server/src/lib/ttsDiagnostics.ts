// In-memory diagnostics buffer for Ruby TTS calls.
// Admin-only surface — never exposed to regular users. No secrets, no
// API keys, no full request bodies. Records the last N TTS attempts so
// the Admin Ruby Voice Settings page can show what is actually happening.

export interface TTSDiagnosticEntry {
  ts:              string;                          // ISO timestamp
  userId:          number | null;                   // requesting user
  providerAsked:   "openai" | "elevenlabs" | "auto" | "browser";
  providerUsed:    "openai" | "elevenlabs" | "browser" | "none";
  voiceId:         string;
  status:          "ok" | "error" | "no_provider";
  httpStatus:      number;
  mime:            string | null;
  bytes:           number;                          // 0 if error
  durationMs:      number;
  fallback:        boolean;                         // server-side fallback happened
  fallbackReason:  string | null;
  errorCode:       string | null;
  errorMessage:    string | null;                   // friendly, no stack
  isTest:          boolean;                         // came from admin test endpoint

  // Phase 22V — richer admin diagnostics
  openaiModel?:        string | null;   // model actually sent to OpenAI
  styleApplied?:       boolean;         // whether `instructions` was sent (gpt-4o-mini-tts)
  loadedFromBackend?:  boolean;         // request was driven by server-stored prefs
  autoplayBlocked?:    boolean;         // client reported the browser refused autoplay
}

const RING_SIZE = 50;
const ring: TTSDiagnosticEntry[] = [];

export function recordTTSDiagnostic(entry: TTSDiagnosticEntry): void {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
}

export function listTTSDiagnostics(limit = 20): TTSDiagnosticEntry[] {
  const n = Math.max(1, Math.min(limit, RING_SIZE));
  return ring.slice(-n).reverse();
}

export function lastTTSDiagnostic(): TTSDiagnosticEntry | null {
  return ring.length === 0 ? null : ring[ring.length - 1]!;
}
