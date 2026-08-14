// Ruby Voice — global proactive speech for alerts, trade events, and
// anything Ruby wants to convey outside the chat panel.
//
// Design:
//   - Single shared queue so concurrent callers never overlap audio.
//   - Reads the same localStorage preference key as useSpeakResponses so
//     the user's "Speak responses" toggle controls all Ruby speech.
//   - Sanitizes all text before speaking (strips tokens, code, URLs).
//   - iOS Safari watchdog prevents stuck "speaking" state.
//   - Priority levels: "urgent" jumps the queue and cancels current speech.
//   - Works without the chat panel being open.
//   - Never auto-starts; only speaks when the user has opted in.

const STORAGE_KEY = "arx.assistant.speakResponses.v1";
const CHARS_PER_SEC = 14;
const WATCHDOG_GRACE = 4_000;
const MAX_SPEAK_MS = 90_000;

export type RubyPriority = "normal" | "urgent";

interface QueueItem {
  text: string;
  priority: RubyPriority;
}

// ── Sanitize ────────────────────────────────────────────────────────────────
function sanitize(input: string): string {
  if (!input) return "";
  let s = input;
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`[^`]*`/g, " ");
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/\b[A-Za-z0-9+/_-]{24,}\b/g, " ");
  s = s.replace(/\b(?:api[_-]?key|token|secret|password|hash|bearer)\s*[:=]\s*\S+/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 800) s = s.slice(0, 800) + "…";
  return s;
}

// ── Singleton engine ─────────────────────────────────────────────────────────
class RubyVoiceEngine {
  private queue: QueueItem[] = [];
  private speaking = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private listeners = new Set<() => void>();

  get supported() {
    return (
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      typeof window.SpeechSynthesisUtterance === "function"
    );
  }

  get enabled() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  get isSpeaking() {
    return this.speaking;
  }

  // Subscribe to state changes (for React hooks).
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((fn) => fn());
  }

  private clearWatchdog() {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private done() {
    this.clearWatchdog();
    this.currentUtterance = null;
    this.speaking = false;
    this.notify();
    this.flush();
  }

  private flush() {
    if (this.speaking || this.queue.length === 0 || !this.supported || !this.enabled) return;
    const item = this.queue.shift()!;
    const clean = sanitize(item.text);
    if (!clean) { this.flush(); return; }

    try {
      window.speechSynthesis.cancel();
      const u = new window.SpeechSynthesisUtterance(clean);
      u.rate = 1.05;
      u.pitch = 1.0;
      u.volume = 1.0;
      u.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";

      u.onend = () => {
        if (this.currentUtterance === u) this.done();
      };
      u.onerror = () => {
        if (this.currentUtterance === u) this.done();
      };

      this.currentUtterance = u;
      this.speaking = true;
      this.notify();
      window.speechSynthesis.speak(u);

      // Watchdog for iOS Safari onend never firing.
      const estMs = Math.min(MAX_SPEAK_MS, Math.max(2_500, Math.ceil(clean.length / CHARS_PER_SEC) * 1000 + WATCHDOG_GRACE));
      this.watchdog = setTimeout(() => {
        if (this.currentUtterance === u) {
          try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
          this.done();
        }
      }, estMs);
    } catch {
      this.done();
    }
  }

  speak(text: string, priority: RubyPriority = "normal") {
    if (!this.supported || !this.enabled) return;
    // Never interrupt the chat panel mid-response — queue instead
    if (_chatPanelSpeaking && priority !== "urgent") {
      this.queue.push({ text, priority });
      return;
    }
    const clean = sanitize(text);
    if (!clean) return;

    if (priority === "urgent") {
      // Cancel everything, jump to front.
      try { window.speechSynthesis.cancel(); } catch { /* noop */ }
      this.clearWatchdog();
      this.currentUtterance = null;
      this.speaking = false;
      this.queue.unshift({ text: clean, priority });
    } else {
      this.queue.push({ text: clean, priority });
    }
    this.flush();
  }

  stop() {
    if (!this.supported) return;
    try { window.speechSynthesis.cancel(); } catch { /* noop */ }
    this.clearWatchdog();
    this.currentUtterance = null;
    this.speaking = false;
    this.queue = [];
    this.notify();
  }
}

export const rubyVoice = new RubyVoiceEngine();

// ── Chat panel coordination ────────────────────────────────────────────────
// The chat panel sets this to true while it is actively speaking a response
// so RubyVoiceEngine never interrupts mid-conversation.
let _chatPanelSpeaking = false;
export function setChatPanelSpeaking(v: boolean) { _chatPanelSpeaking = v; }
export function isChatPanelSpeaking() { return _chatPanelSpeaking; }
