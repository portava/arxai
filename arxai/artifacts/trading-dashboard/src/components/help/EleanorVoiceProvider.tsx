// EleanorVoiceProvider — mounts once at the app root. Provides:
//   - useEleanorSpeak() hook: call eleanorSpeak(text, priority?) from any component
//   - Polls /api/me/notifications and speaks new critical/warning alerts
//     automatically when the user has TTS enabled.
//
// Safe defaults:
//   - Only speaks when user has opted in ("Speak responses" toggle ON).
//   - Deduplicates: never speaks the same notification ID twice per session.
//   - Does not speak while the chat panel is already speaking (checked via
//     window.speechSynthesis.speaking).
//   - Stops on unmount.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { eleanorVoice, type EleanorPriority } from "@/lib/eleanorVoice";

// ── Context ──────────────────────────────────────────────────────────────────
interface EleanorVoiceCtx {
  eleanorSpeak: (text: string, priority?: EleanorPriority) => void;
  eleanorStop: () => void;
  isSpeaking: boolean;
  isEnabled: boolean;
}

const EleanorVoiceContext = createContext<EleanorVoiceCtx>({
  eleanorSpeak: () => {},
  eleanorStop: () => {},
  isSpeaking: false,
  isEnabled: false,
});

export function useEleanorSpeak() {
  return useContext(EleanorVoiceContext);
}

// ── Notification alert poller ────────────────────────────────────────────────
type Notif = {
  id: number;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  status: "unread" | "read" | "dismissed";
};

const ALERT_POLL_MS = 15_000;
// Only speak warning + critical — info is too noisy.
const SPEAK_SEVERITIES = new Set(["warning", "critical"]);

// ── Provider ─────────────────────────────────────────────────────────────────
export function EleanorVoiceProvider({ children }: { children: ReactNode }) {
  // Sync React state with the singleton engine.
  const isSpeaking = useSyncExternalStore(
    (cb) => eleanorVoice.subscribe(cb),
    () => eleanorVoice.isSpeaking,
    () => false,
  );

  const isEnabled = eleanorVoice.enabled;

  const eleanorSpeak = useCallback((text: string, priority: EleanorPriority = "normal") => {
    eleanorVoice.speak(text, priority);
  }, []);

  const eleanorStop = useCallback(() => {
    eleanorVoice.stop();
  }, []);

  // Track which notification IDs we've already spoken this session.
  const spokenIds = useRef(new Set<number>());

  // Poll notifications and speak new ones.
  useEffect(() => {
    let active = true;

    async function poll() {
      if (!active) return;
      // Perf: don't poll notifications while the tab is backgrounded — the
      // next interval tick after the user returns picks up any new alerts.
      if (typeof document !== "undefined" && document.hidden) return;
      if (!eleanorVoice.enabled || !eleanorVoice.supported) return;

      try {
        const r = await fetch("/api/me/notifications?limit=10", { credentials: "include" });
        if (!r.ok || !active) return;
        const data = (await r.json()) as { notifications?: Notif[] };
        const notifs = data.notifications ?? [];

        for (const n of notifs) {
          if (!active) break;
          if (n.status !== "unread") continue;
          if (!SPEAK_SEVERITIES.has(n.severity)) continue;
          if (spokenIds.current.has(n.id)) continue;

          spokenIds.current.add(n.id);

          // Build a natural Eleanor speech for the alert.
          const priority: EleanorPriority = n.severity === "critical" ? "urgent" : "normal";
          const speech = buildAlertSpeech(n);
          eleanorVoice.speak(speech, priority);
        }
      } catch {
        // Network error — silent fail, retry next poll.
      }
    }

    // First poll after a short delay so the app is settled.
    const initial = setTimeout(() => { void poll(); }, 3_000);
    const interval = setInterval(() => { void poll(); }, ALERT_POLL_MS);

    // Resume immediately when the user returns to the tab instead of waiting
    // for the next interval tick (avoids a post-refocus alert delay).
    function onVisible() {
      if (typeof document !== "undefined" && !document.hidden) void poll();
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      active = false;
      clearTimeout(initial);
      clearInterval(interval);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }, []);

  return (
    <EleanorVoiceContext.Provider value={{ eleanorSpeak, eleanorStop, isSpeaking, isEnabled }}>
      {children}
    </EleanorVoiceContext.Provider>
  );
}

// ── Speech builder ───────────────────────────────────────────────────────────
// Turns a notification into natural Eleanor speech. Keeps it short and clear.
function buildAlertSpeech(n: Notif): string {
  const prefix =
    n.severity === "critical"
      ? "Heads up — "
      : "Just so you know — ";

  // Use the message if it's short enough to speak naturally.
  // Otherwise fall back to just the title.
  const body =
    n.message && n.message.length <= 160
      ? n.message
      : n.title;

  return `${prefix}${body}`;
}
