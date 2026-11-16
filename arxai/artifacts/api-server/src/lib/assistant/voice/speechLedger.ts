// Eleanor voice: the speech ledger.
//
// A short-lived, per-user record of text the ARX text verifier has ALREADY
// released to that user (verified chat content, the server-composed briefing).
// The TTS route reads it so a verified chat answer can be read aloud with its
// checked figures, while any other text sent to /tts is checked against an empty
// evidence set (so an unverified figure is never spoken).
//
// In-memory, bounded (per-user chars, user count) and time-limited. After a
// restart the TTS route also reads the user's persisted assistant messages,
// which are stored in their verified form.

const TTL_MS = 30 * 60_000;
const MAX_CHARS_PER_USER = 40_000;
const MAX_ENTRIES_PER_USER = 40;
const MAX_USERS = 5_000;

interface Entry { text: string; at: number }
const _ledger = new Map<number, Entry[]>();

function prune(entries: Entry[], nowMs: number): Entry[] {
  const fresh = entries.filter((e) => nowMs - e.at <= TTL_MS);
  let total = 0;
  const kept: Entry[] = [];
  for (let i = fresh.length - 1; i >= 0 && kept.length < MAX_ENTRIES_PER_USER; i--) {
    total += fresh[i]!.text.length;
    if (total > MAX_CHARS_PER_USER) break;
    kept.unshift(fresh[i]!);
  }
  return kept;
}

function put(userId: number, entries: Entry[]): void {
  _ledger.delete(userId);
  if (entries.length > 0) _ledger.set(userId, entries);
  while (_ledger.size > MAX_USERS) {
    const oldest = _ledger.keys().next().value;
    if (oldest === undefined) break;
    _ledger.delete(oldest);
  }
}

/** Record a complete piece of verified text (e.g. the briefing). */
export function recordVerifiedSpeechSource(userId: number, text: string, nowMs = Date.now()): void {
  if (!Number.isInteger(userId) || userId <= 0 || !text.trim()) return;
  put(userId, prune([...(_ledger.get(userId) ?? []), { text, at: nowMs }], nowMs));
}

/**
 * Open one verified turn. The returned function appends each verified delta to
 * the same entry, so a sentence split across two released segments still
 * matches as one string.
 */
export function openVerifiedSpeechTurn(userId: number, nowMs: () => number = Date.now): (delta: string) => void {
  let entry: Entry | null = null;
  return (delta: string) => {
    if (!Number.isInteger(userId) || userId <= 0 || !delta) return;
    const now = nowMs();
    const entries = _ledger.get(userId) ?? [];
    if (!entry || !entries.includes(entry)) {
      entry = { text: "", at: now };
      entries.push(entry);
    }
    entry.text += delta;
    entry.at = now;
    put(userId, prune(entries, now));
  };
}

/** Verified texts for this user that are still inside the window. */
export function trustedSpeechFor(userId: number, nowMs = Date.now()): string[] {
  const entries = _ledger.get(userId);
  if (!entries) return [];
  const kept = prune(entries, nowMs);
  put(userId, kept);
  return kept.map((e) => e.text);
}

/** TEST-ONLY. */
export function __resetSpeechLedgerForTests(): void {
  _ledger.clear();
}
