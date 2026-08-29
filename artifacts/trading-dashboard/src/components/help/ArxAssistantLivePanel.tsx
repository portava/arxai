// Phase 13 — ARX AI Live Assistant panel.
// Replaces the menu-heavy help widget with a clean live-chat surface.
// - Streams responses via SSE (fetch + ReadableStream) with safety envelope
// - Voice: gpt-audio speech-to-speech via useVoiceRecorder + useVoiceStream
// - Mic permission only after explicit user click; tracks fully released on stop/close
// - Click-outside closes panel and stops mic
// - Suggestion chips collapsible
// - Market provider connectivity surfaced in-panel
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useGetTimingBrain, getGetTimingBrainQueryKey } from "@workspace/api-client-react";
import { Mic, MicOff, Send, X, Sparkles, Loader2, ChevronDown, ChevronUp, ShieldCheck, Wrench, AlertCircle, Wifi, WifiOff, Radio, Square, VolumeX, Volume2, MoreHorizontal, Plus, Trash2, Eraser, Download, Brain, BrainCircuit, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RubyTypingIndicator, friendlyToolText } from "@/components/ui/RubyTypingIndicator";
import { useVoiceStream, useVoiceRecorder } from "@workspace/integrations-openai-ai-react/audio";
import { AnimatedArxAssistantIcon, useAssistantIconState, usePrefersReducedMotion } from "./AnimatedArxAssistantIcon";
import { useLocation } from "wouter";
import { useRealtimeVoice, type RealtimeMode } from "./useRealtimeVoice";
import { useSpeakResponses, getAvailableVoices, saveVoiceName, getSavedVoiceName, getServerVoicePref, saveServerVoicePref } from "./useSpeakResponses";
import { previewVoice } from "./useRubyTTS";
import { setChatPanelSpeaking } from "@/lib/rubyVoice";
import { useTradingMode } from "@/hooks/useTradingMode";
import { useChartSymbol } from "@/lib/use-chart-symbol";
import { useScannerTimeframe } from "@/hooks/useScannerTimeframe";
import { markActionStart, markActionEnd, markUiFeedback, markRenderComplete, markApiStart, markApiEnd } from "@/lib/perf";
import { useAssistantName, DEFAULT_ASSISTANT_NAME } from "@/lib/assistant-name";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const STORAGE_OPEN_KEY = "arx.assistant.open.v2";
// Phase 22D — voice clip safety caps. Mobile mics + opus typically sit at
// ~24-48 kbps so 20 MB ≈ several minutes; we still cap recording to 15 s
// to keep mobile uploads fast and predictable.
const MAX_VOICE_BYTES = 20 * 1024 * 1024;
const MAX_RECORD_MS = 15_000;

// Phase 22D — map raw network/server errors to clean, user-safe text.
// Strips HTML / stack traces / node_modules paths so we never surface a
// raw Express error page in the chat panel.
function friendlyError(input: unknown, status?: number, name: string = DEFAULT_ASSISTANT_NAME): string {
  const raw = input instanceof Error ? input.message : typeof input === "string" ? input : "";
  const looksLikeHtml = /<!DOCTYPE|<html|<pre|node_modules|raw-body|body-parser|\/home\/runner|stack|at \w+ \(/i.test(raw);
  // Phase 22G — realtime voice handshake errors get a soft, fallback-aware
  // copy. Never surface raw WebRTC / SDP / OpenAI internals.
  const isRealtimeHandshake =
    /Realtime voice handshake failed|Realtime voice channel error|Couldn't reach Realtime voice provider|Couldn't start Realtime voice session|Failed to (?:create WebRTC offer|apply Realtime voice answer)|Realtime voice not available|Safety envelope (?:missing|mismatch)/i.test(raw);
  const isMicDenied = /Microphone access denied|NotAllowedError|Permission denied/i.test(raw);
  const code = isRealtimeHandshake
    ? "REALTIME_HANDSHAKE_FAILED"
    : isMicDenied
      ? "MIC_DENIED"
      : /VOICE_TOO_LARGE/.test(raw)
        ? "VOICE_TOO_LARGE"
        : /PAYLOAD_TOO_LARGE|413/.test(raw) || status === 413
          ? "VOICE_TOO_LARGE"
          : /401|Unauthorized/i.test(raw) || status === 401
            ? "AUTH"
            : /403|Forbidden/i.test(raw) || status === 403
              ? "AUTH"
              : /Failed to fetch|NetworkError|network/i.test(raw)
                ? "NETWORK_ERROR"
                : /AI_OFFLINE|voice_unavailable|503/.test(raw) || status === 503
                  ? "AI_OFFLINE"
                  : looksLikeHtml
                    ? "UNKNOWN"
                    : "RAW";
  switch (code) {
    case "REALTIME_HANDSHAKE_FAILED": return "Realtime voice is unavailable. Fallback voice mode is active — text chat still works.";
    case "MIC_DENIED":      return "Microphone access is blocked. Enable it in your browser settings.";
    case "VOICE_TOO_LARGE": return "Voice clip is too long. Please try a shorter message.";
    case "AUTH":            return `Sign in to chat with ${name}.`;
    case "NETWORK_ERROR":   return "Connection issue. Please try again.";
    case "AI_OFFLINE":      return `${name} is reconnecting. Try again in a moment.`;
    case "UNKNOWN":         return "Something went wrong. Please try again.";
    case "RAW":             return raw.length > 0 && raw.length < 220 ? raw : "Something went wrong. Please try again.";
  }
}
const STORAGE_CHIPS_KEY = "arx.assistant.chips.v2";

type Status = "idle" | "thinking" | "streaming" | "tool" | "speaking" | "listening" | "recording" | "realtime" | "error";

interface ToolEvent { name: string; status?: string; durationMs?: number; result?: { action?: string; mute?: boolean; [key: string]: unknown } }
import { RubyReasoningBlock } from "@/components/ruby/RubyReasoningBlock";
import { buildReasoningFromChartRead } from "@/lib/rubyReasoningBlock";
import type { RubyReasoningBlockData } from "@/lib/rubyReasoningBlock";
import { FeedConfidenceBadge } from "@/components/charts/FeedConfidenceBadge";
import { useScannerTruth } from "@/hooks/useScannerTruth";
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolEvent[];
  intent?: string;
  pending?: boolean;
  voicePending?: boolean;
  /** Optional structured Ruby reasoning. When present, the bubble renders the
   *  ONE standardized, ALWAYS-VISIBLE reasoning block — the same labeled format
   *  used on the Scalp / Scanner surfaces. Never fabricated from prose: it is
   *  only set when a structured (honesty-gated) read is attached to the reply. */
  reasoning?: RubyReasoningBlockData;
  /** Optional feed-confidence context for a chart read (Task #777). When present
   *  the bubble renders the SAME compact FeedConfidenceBadge the chart popover
   *  and Scanner Ruby Chart Read show, capped by `aiUsableResolved` — the SINGLE
   *  resolved verdict that already drove the reasoning prose (no second source of
   *  truth). DISPLAY ONLY — never an execution input. */
  chartReadFeed?: {
    symbol: string;
    timeframe: string;
    /** `false` when the read was withheld (gated / feed-unconfirmed /
     *  structural-only), `true` for a fully-confirmed read — the exact verdict
     *  that drove the reasoning block's Feed/Data line. */
    aiUsableResolved: boolean | null;
  };
}
interface MarketStatus { provider: string; connected: boolean; notes?: string | null }
// T023 — context-aware Ruby briefing (state-derived; replaces static greeting).
interface RubyBriefing {
  headline: string;
  lines: string[];
  setupGuidance: string | null;
  suggestions: Array<{ label: string; prompt: string }>;
  updatedAt: string;
  mode: string;
}
interface VoiceModeStatus {
  realtimeConfigured: boolean;
  currentMode: "true_webrtc_realtime_available" | "degraded_gpt_audio" | "text_only";
  notes: string;
}

const SUGGESTIONS: ReadonlyArray<{ label: string; prompt: string }> = [
  { label: "Summarize my performance", prompt: "Summarize my trading performance — win rate, best/worst strategy, biggest mistake, recent lessons." },
  { label: "Biggest mistake",          prompt: "What is my biggest trading mistake based on my journal so far?" },
  { label: "Best strategy",            prompt: "What is my best strategy and what is my worst strategy?" },
  { label: "Am I overtrading?",        prompt: "Am I overtrading today compared to my recent average?" },
  { label: "Largest loss",             prompt: "What was my largest loss?" },
  { label: "Check MT5 bridge",         prompt: "What is my MT5 bridge status right now?" },
  { label: "Explain my risk",          prompt: "Explain my current risk limits in plain English." },
  { label: "Market update",            prompt: "Give me a market update if live data is available." },
  { label: "How do I use this?",       prompt: "How do I use ARX? Walk me through the main pages." },
];

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + url, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

interface Conversation { id: number; title: string }

export function ArxAssistantLivePanel() {
  const { name } = useAssistantName();
  const [pathname] = useLocation();
  const tradingMode = useTradingMode();
  const pageContextRef = useRef<{ pathname: string; label?: string | null }>({ pathname: pathname || "/", label: typeof document !== "undefined" ? document.title : null });
  useEffect(() => {
    pageContextRef.current = { pathname: pathname || "/", label: typeof document !== "undefined" ? document.title : null };
  }, [pathname]);
  const [open, setOpen] = useState<boolean>(() => {
    if (typeof sessionStorage === "undefined") return false;
    return sessionStorage.getItem(STORAGE_OPEN_KEY) === "1";
  });
  const [chipsOpen, setChipsOpen] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(STORAGE_CHIPS_KEY) !== "0";
  });
  // Auto-listen (hands-free continuous voice) is intentionally DISABLED.
  // The VAD loop restarted the mic and interrupted Ruby's own speech, so the
  // only voice-input path is manual press-to-record. The `useAutoListen` hook
  // file is kept on disk for a future deliberate rebuild but is no longer
  // wired into this panel.
  const hasGreetedRef = useRef(false);
  const [chartSymbol] = useChartSymbol();
  // Task #602 follow-on — mirror the on-screen chart symbol/timeframe into a ref
  // so a chat chart-read ("read this", "what do you see") can default to what
  // the user is actually viewing. A ref stays fresh without re-binding sendText.
  const [scannerTimeframe] = useScannerTimeframe();
  const chartContextRef = useRef<{ chartSymbol: string | null; chartTimeframe: string | null }>({
    chartSymbol: chartSymbol ?? null,
    chartTimeframe: scannerTimeframe ?? null,
  });
  useEffect(() => {
    chartContextRef.current = { chartSymbol: chartSymbol ?? null, chartTimeframe: scannerTimeframe ?? null };
  }, [chartSymbol, scannerTimeframe]);
  const [briefingSuggestions, setBriefingSuggestions] = useState<ReadonlyArray<{ label: string; prompt: string }> | null>(null);
  const [briefingUpdatedAt, setBriefingUpdatedAt] = useState<string | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState<string>("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [isVoiceUploading, setIsVoiceUploading] = useState(false);
  const recordTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Silence-detection (auto-send when the user stops talking) refs.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRafRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSpokenRef = useRef(false);
  const [marketStatus, setMarketStatus] = useState<MarketStatus | null>(null);
  const [voiceMode, setVoiceMode] = useState<VoiceModeStatus | null>(null);
  const [realtimeMode, setRealtimeMode] = useState<RealtimeMode | null>(null);
  // Phase 22K — memory controls menu state
  const [menuOpen, setMenuOpen] = useState(false);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryEnabled, setMemoryEnabledState] = useState<boolean>(true);
  const hydratedRef = useRef(false);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Tracks the live mic MediaStream so we can fully release it on stop/close.
  const micStreamRef = useRef<MediaStream | null>(null);

  usePrefersReducedMotion();
  const iconState = useAssistantIconState({
    open,
    thinking: status === "thinking" || status === "tool",
    typing: status === "streaming",
    error: status === "error",
  });

  // Persist UI prefs
  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(STORAGE_OPEN_KEY, open ? "1" : "0");
  }, [open]);
  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_CHIPS_KEY, chipsOpen ? "1" : "0");
  }, [chipsOpen]);

  // Browser TTS for typed-chat replies (Phase 22G).
  // Disabled by default; only speaks after the user opts in. Always silenced
  // when voice modes are active so we never double-speak.
  const tts = useSpeakResponses();
  // activeTTS = tts with server voice support baked into speak()
  const activeTTS = tts;

  // Coordinate with RubyVoiceProvider so it never interrupts chat responses
  useEffect(() => {
    setChatPanelSpeaking(tts.state === "speaking");
  }, [tts.state]);

  // Voice plumbing
  const workletPath = `${BASE}/audio-playback-worklet.js`;
  const recorder = useVoiceRecorder();
  const { streamVoiceResponse } = useVoiceStream({
    workletPath,
    onUserTranscript: (chunk) => {
      // Show what Ruby heard as a user bubble. If we already placed an
      // optimistic "transcribing…" placeholder on send, fill that in so the
      // user can confirm the transcription was correct; otherwise append.
      setMessages((cur) => {
        const idx = [...cur].reverse().findIndex((m) => m.role === "user" && m.voicePending);
        if (idx !== -1) {
          const realIdx = cur.length - 1 - idx;
          const next = cur.slice();
          next[realIdx] = { ...next[realIdx], content: chunk, voicePending: false };
          return next;
        }
        return [...cur, { id: `u-v-${Date.now()}`, role: "user", content: chunk }];
      });
    },
    onTranscript: (_chunk, full) => {
      setStatus("speaking");
      setMessages((cur) => {
        const last = cur[cur.length - 1];
        if (last && last.role === "assistant" && last.pending) {
          return [...cur.slice(0, -1), { ...last, content: full }];
        }
        return [...cur, { id: `a-v-${Date.now()}`, role: "assistant", content: full, pending: true }];
      });
    },
    onComplete: () => {
      setMessages((cur) => {
        const last = cur[cur.length - 1];
        if (!last || last.role !== "assistant") return cur;
        return [...cur.slice(0, -1), { ...last, pending: false }];
      });
      setStatus("idle");
    },
    onError: (e) => {
      setStatus("error");
      setErrorBanner(friendlyError(e, undefined, name));
    },
  });

  // ── true OpenAI Realtime WebRTC voice (Phase 15C) ────────────────────
  const realtime = useRealtimeVoice({
    onUserTranscript: (text, isFinal) => {
      if (!isFinal) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      setMessages((cur) => [...cur, { id: `u-rt-${Date.now()}`, role: "user", content: trimmed }]);
    },
    onAssistantTranscript: (text, isFinal) => {
      setMessages((cur) => {
        const last = cur[cur.length - 1];
        if (last && last.role === "assistant" && last.pending) {
          return [...cur.slice(0, -1), { ...last, content: text, pending: !isFinal }];
        }
        return [...cur, { id: `a-rt-${Date.now()}`, role: "assistant", content: text, pending: !isFinal }];
      });
    },
    onMode: (mode, _reason) => {
      // Phase 22G — track the mode honestly but DO NOT spam the chat with
      // technical reason codes. The voice badge handles the user-visible
      // status; onError already surfaces a single friendly line if there
      // is something the user actually needs to see.
      setRealtimeMode(mode);
    },
    onError: (msg) => setErrorBanner(friendlyError(msg, undefined, name)),
  });

  // Phase 22G — Map realtime hook state → panel status pill.
  // Critical fix: when realtime fails/disconnects, we MUST also clear a
  // "thinking" status, otherwise a failed handshake leaves the global
  // spinner on and disables the input + suggestion chips + send button.
  // Also: realtime "connecting" no longer borrows the global "thinking"
  // status; we use a dedicated "realtimeConnecting" flag so text chat,
  // chips, and the send button stay live even while voice is handshaking.
  const realtimeConnecting = realtime.state === "connecting";
  useEffect(() => {
    if (realtime.state === "listening" || realtime.state === "muted") setStatus("realtime");
    else if (realtime.state === "speaking") setStatus("speaking");
    else if (realtime.state === "failed" || realtime.state === "disconnected") {
      // Voice path is over — make sure no realtime-derived status is stuck.
      setStatus((s) => (s === "realtime" || s === "speaking" || s === "thinking" ? "idle" : s));
    } else if (realtime.state === "idle") {
      setStatus((s) => (s === "realtime" ? "idle" : s));
    }
  }, [realtime.state]);

  const releaseMic = useCallback(() => {
    // Tear down silence detection alongside the mic stream.
    if (analyserRafRef.current != null) { cancelAnimationFrame(analyserRafRef.current); analyserRafRef.current = null; }
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    if (audioCtxRef.current) { try { void audioCtxRef.current.close(); } catch { /* noop */ } audioCtxRef.current = null; }
    hasSpokenRef.current = false;
    const s = micStreamRef.current;
    if (s) {
      try { s.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      micStreamRef.current = null;
    }
  }, []);

  const stopVoiceFully = useCallback(async () => {
    try { await recorder.stopRecording(); } catch { /* noop */ }
    releaseMic();
    if (status === "recording" || status === "listening" || status === "speaking") setStatus("idle");
  }, [recorder, releaseMic, status]);

  // ── T023: context-aware briefing (replaces the static greeting) ───────────
  // Fetches a state-derived briefing from the server (real live/market/account
  // state only — never fabricated) and renders it as Ruby's opening message
  // plus contextual suggestions. Used on open and by the Refresh button.
  const loadBriefing = useCallback(async (opts?: { refresh?: boolean }) => {
    setBriefingLoading(true);
    try {
      const page = encodeURIComponent(pageContextRef.current.pathname || "/");
      const symQs = chartSymbol ? `&symbol=${encodeURIComponent(chartSymbol)}` : "";
      const r = await fetch(`${BASE}/api/me/assistant/briefing?page=${page}${symQs}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { briefing: RubyBriefing };
      const b = data.briefing;
      const parts: string[] = [b.headline];
      if (b.lines.length) parts.push("", ...b.lines.map((l) => `• ${l}`));
      if (b.setupGuidance) parts.push("", b.setupGuidance);
      const content = parts.join("\n");
      setMessages((cur) => {
        const next = cur.filter((m) => m.id !== "ruby-briefing");
        return [...next, { id: "ruby-briefing", role: "assistant" as const, content }];
      });
      if (Array.isArray(b.suggestions) && b.suggestions.length > 0) setBriefingSuggestions(b.suggestions);
      setBriefingUpdatedAt(b.updatedAt);
      if (!opts?.refresh && activeTTS.enabled) activeTTS.speak(b.headline);
    } catch {
      // Honest, non-fabricated fallback so the panel always opens cleanly.
      setMessages((cur) => {
        if (cur.some((m) => m.id === "ruby-briefing")) return cur;
        return [...cur, { id: "ruby-briefing", role: "assistant" as const, content: `Hi — I'm ${name}. I'm here when you're ready.` }];
      });
    } finally {
      setBriefingLoading(false);
    }
  }, [chartSymbol, activeTTS]);

  useEffect(() => {
    if (!open || hasGreetedRef.current) return;
    hasGreetedRef.current = true;
    // Small delay so panel animation completes before speaking.
    const t = setTimeout(() => { void loadBriefing(); }, 600);
    return () => clearTimeout(t);
  }, [open, loadBriefing]);

  // Click outside closes + stops mic
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      void closePanel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ensure conversation + load market status when opened.
  // Ruby rehydration: on first open per session, try to resume the user's
  // most recent conversation (with its messages) so chats persist across
  // refresh/logout/login. Only fall back to a brand-new "Live chat" if
  // there is no prior conversation. Page reloads then start fresh inside
  // the session — but next time the user closes/reopens the panel after a
  // refresh we restore again so nothing is silently lost.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        if (!conversation) {
          // Track resume status with a local flag so we don't depend on the
          // stale `conversation` closure value after the async fetch above
          // resolves (React won't have re-rendered inside this same effect
          // run). Otherwise we'd POST a brand-new "Live chat" on top of
          // the one we just rehydrated, leaving message history pointing
          // at an orphaned id.
          let resumed = false;
          if (!hydratedRef.current) {
            hydratedRef.current = true;
            const listRes = await fetch(`${BASE}/api/me/assistant/conversations`, { credentials: "include" });
            if (listRes.ok && !cancelled) {
              const j = (await listRes.json()) as { conversations?: Array<{ id: number; title: string; archivedAt?: string | null }> };
              const latest = (j.conversations ?? []).find((c) => !c.archivedAt);
              if (latest) {
                const convRes = await fetch(`${BASE}/api/me/assistant/conversations/${latest.id}`, { credentials: "include" });
                if (convRes.ok && !cancelled) {
                  const cj = (await convRes.json()) as { conversation: Conversation; messages: Array<{ id: number; role: "user" | "assistant"; content: string; intent?: string | null }> };
                  setConversation(cj.conversation);
                  setMessages(cj.messages.map((m) => ({
                    id: `h-${m.id}`,
                    role: m.role,
                    content: m.content,
                    intent: m.intent ?? undefined,
                  })));
                  resumed = true;
                }
              }
            }
          }
          if (!cancelled && !resumed) {
            const r = await postJson<{ conversation: Conversation }>("/api/me/assistant/conversations", { title: "Live chat" });
            if (cancelled) return;
            setConversation(r.conversation);
          }
        }
        // PART D fix — these three were sequential awaits, costing 3 RTTs
        // on every panel-open. They are fully independent, so fire them
        // in parallel and let each handler update state when it resolves.
        // We use Promise.allSettled so one slow/failed call (e.g. voice
        // status when audio is offline) doesn't block the others.
        const [memSettled, msSettled, vsSettled] = await Promise.allSettled([
          fetch(`${BASE}/api/me/assistant/memory`,        { credentials: "include" }),
          fetch(`${BASE}/api/me/assistant/market-status`, { credentials: "include" }),
          fetch(`${BASE}/api/me/assistant/voice-status`,  { credentials: "include" }),
        ]);
        // Each .json() can still throw (truncated body, network drop mid-parse),
        // so each block gets its own try/catch — a single bad response must
        // never tear down the surrounding IIFE and skip the others.
        if (!cancelled && memSettled.status === "fulfilled" && memSettled.value.ok) {
          try {
            const mj = (await memSettled.value.json()) as { memory?: { memoryEnabled?: boolean } };
            if (!cancelled && typeof mj.memory?.memoryEnabled === "boolean") setMemoryEnabledState(mj.memory.memoryEnabled);
          } catch { /* non-fatal — memory toggle stays at last-known value */ }
        }
        if (!cancelled && msSettled.status === "fulfilled" && msSettled.value.ok) {
          try {
            const j = (await msSettled.value.json()) as MarketStatus;
            if (!cancelled) setMarketStatus(j);
          } catch { /* non-fatal */ }
        }
        if (!cancelled && vsSettled.status === "fulfilled" && vsSettled.value.ok) {
          try {
            const j = (await vsSettled.value.json()) as VoiceModeStatus;
            if (!cancelled) setVoiceMode(j);
          } catch { /* non-fatal */ }
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "unknown";
        setErrorBanner(/401|403/.test(msg) ? `Sign in to chat with ${name}.` : "Couldn't start a chat session.");
      }
    })();
    return () => { cancelled = true; };
  }, [open, conversation]);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 120); }, [open]);
  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, status]);

  const closePanel = useCallback(async () => {
    setOpen(false);
    abortRef.current?.abort();
    abortRef.current = null;
    await stopVoiceFully();
    await realtime.stop();
    setRealtimeMode(null);
    tts.stop();
    setStatus("idle");
  }, [stopVoiceFully, realtime, tts]);

  // ── Silence detection — auto-send when the user stops talking ─────────
  // Watches the live mic stream's volume; once the user has spoken and then
  // goes quiet for SILENCE_HOLD_MS, it fires the same stopVoiceAndSend path
  // the manual mic uses. Self-contained (Web Audio API on the existing
  // stream); does not touch the recorder package or auto-reopen the mic.
  // Teardown is handled by releaseMic, which runs on every stop.
  const startSilenceMonitor = useCallback((stream: MediaStream) => {
    const SILENCE_HOLD_MS = 1500; // quiet this long after speech → send
    const SPEECH_RMS = 0.025;     // above this = speaking
    const SILENCE_RMS = 0.015;    // below this = silent (hysteresis gap)
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      hasSpokenRef.current = false;
      const tick = () => {
        if (!audioCtxRef.current) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        if (rms > SPEECH_RMS) {
          hasSpokenRef.current = true;
          if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
        } else if (rms < SILENCE_RMS && hasSpokenRef.current && !silenceTimerRef.current) {
          silenceTimerRef.current = setTimeout(() => {
            silenceTimerRef.current = null;
            stopAndSendRef.current?.();
          }, SILENCE_HOLD_MS);
        }
        analyserRafRef.current = requestAnimationFrame(tick);
      };
      analyserRafRef.current = requestAnimationFrame(tick);
    } catch {
      // Web Audio unavailable — fall back to the manual mic + max-duration
      // timer; the user can still tap to send.
    }
  }, []);

  // ── voice: explicit permission, record, then stream to /voice ──────
  const startVoiceRecord = useCallback(async () => {
    setErrorBanner(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setErrorBanner("Microphone access denied. Voice mode unavailable — text chat still works.");
      return;
    }
    micStreamRef.current = stream;
    try {
      await recorder.startRecording();
      setStatus("recording");
      // Auto-send when the user stops talking (silence detection on the live
      // mic stream). The MAX_RECORD_MS timer below remains as a hard cap.
      startSilenceMonitor(stream);
      // Auto-stop after MAX_RECORD_MS so mobile users can't accidentally
      // upload multi-minute clips. The timer fires stopVoiceAndSend
      // through a ref (set right after this callback).
      if (recordTimeoutRef.current) clearTimeout(recordTimeoutRef.current);
      recordTimeoutRef.current = setTimeout(() => {
        stopAndSendRef.current?.();
      }, MAX_RECORD_MS);
    } catch {
      releaseMic();
      setErrorBanner("Couldn't start recording.");
    }
  }, [recorder, releaseMic, startSilenceMonitor]);

  // Forward ref so the auto-stop timer (created inside startVoiceRecord)
  // can call the latest stopVoiceAndSend without a circular dep.
  const stopAndSendRef = useRef<(() => void) | null>(null);

  // Phase 22E — extracted so both the manual mic button and the auto-listen
  // hook can stream the same blob through the same upload pipeline.
  const uploadVoiceBlob = useCallback(async (blob: Blob): Promise<void> => {
    if (isVoiceUploading) return;
    if (!conversation) return;
    if (!blob || blob.size === 0) return;
    if (blob.size > MAX_VOICE_BYTES) {
      setStatus("error");
      setErrorBanner("Voice clip is too long. Please try a shorter message.");
      return;
    }
    setStatus("listening");
    setIsVoiceUploading(true);
    // Optimistic user bubble so the spoken message is represented in the chat
    // immediately; onUserTranscript fills it with the transcribed text.
    setMessages((cur) => [...cur, { id: `u-v-${Date.now()}`, role: "user", content: "", voicePending: true }]);
    try {
      await streamVoiceResponse(`${BASE}/api/me/assistant/conversations/${conversation.id}/voice`, blob);
    } catch (e) {
      setStatus("error");
      setErrorBanner(friendlyError(e, undefined, name));
      // Drop the optimistic placeholder if no transcript ever arrived.
      setMessages((cur) => cur.filter((m) => !(m.role === "user" && m.voicePending)));
    } finally {
      setIsVoiceUploading(false);
    }
  }, [conversation, isVoiceUploading, streamVoiceResponse]);

  const stopVoiceAndSend = useCallback(async () => {
    if (recordTimeoutRef.current) { clearTimeout(recordTimeoutRef.current); recordTimeoutRef.current = null; }
    if (isVoiceUploading) return; // prevent double-tap
    if (!conversation) { await stopVoiceFully(); return; }
    let blob: Blob;
    try { blob = await recorder.stopRecording(); }
    catch { releaseMic(); setStatus("idle"); return; }
    releaseMic();
    if (!blob || blob.size === 0) { setStatus("idle"); return; }
    await uploadVoiceBlob(blob);
  }, [conversation, recorder, releaseMic, uploadVoiceBlob, isVoiceUploading, stopVoiceFully]);

  // ── Manual voice flow — explicit state lock ─────────────────────────
  // Voice is press-to-record ONLY. There is no auto-listen / VAD loop and
  // nothing ever re-opens the mic on its own. The flow always returns to
  // `idle` after Ruby finishes — it never auto-restarts listening.
  //
  //   idle                      → nothing happening; mic is inactive
  //   recording_user_voice      → user tapped the mic; capturing their clip
  //   processing_voice_message  → clip uploaded; waiting on Ruby's reply
  //   ruby_speaking             → Ruby is talking back (TTS or voice stream);
  //                               the mic stays inactive and recording is
  //                               blocked until she finishes or the user
  //                               manually stops her.
  const voiceFlow: "idle" | "recording_user_voice" | "processing_voice_message" | "ruby_speaking" =
    status === "recording"
      ? "recording_user_voice"
      : (isVoiceUploading || status === "listening")
        ? "processing_voice_message"
        : (status === "speaking" || tts.state === "speaking")
          ? "ruby_speaking"
          : "idle";
  const rubySpeaking = voiceFlow === "ruby_speaking";

  // Keep the auto-stop timer pointing at the latest stopVoiceAndSend.
  useEffect(() => { stopAndSendRef.current = () => { void stopVoiceAndSend(); }; }, [stopVoiceAndSend]);
  // Always clear the auto-stop timer on unmount.
  useEffect(() => () => { if (recordTimeoutRef.current) clearTimeout(recordTimeoutRef.current); }, []);

  // ── streaming text send ─────────────────────────────────────────────
  const sendText = useCallback(async (text: string) => {
    if (!text.trim()) return;
    if (!conversation) { setErrorBanner("Chat session not ready yet. One moment…"); return; }
    // PART 8 — Ruby first-text timing. Three distinct moments matter:
    //   send (T0) → "thinking" indicator visible (T1, sub-100ms)
    //              → first visible token (markRenderComplete — the
    //                budget the user actually feels)
    //              → done (markActionEnd — full message complete)
    // TTS deliberately does NOT block the text path; the action ends as
    // soon as the SSE "done" event lands.
    const rubyPid = markActionStart("ruby.sendMessage", { page: typeof location !== "undefined" ? location.pathname : undefined });
    let firstTextMarked = false;
    // Silence any in-flight TTS before starting a new turn so we never
    // talk over ourselves.
    tts.stop();
    setErrorBanner(null);
    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", content: text };
    const placeholder: ChatMessage = { id: `a-${Date.now() + 1}`, role: "assistant", content: "", toolCalls: [], pending: true };
    setMessages((cur) => [...cur, userMsg, placeholder]);
    setInput("");
    setStatus("thinking");
    markUiFeedback(rubyPid); // "Ruby is thinking…" indicator visible

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    markApiStart(rubyPid, "POST /api/me/assistant/conversations/:id/messages");

    let res: Response;
    try {
      res = await fetch(`${BASE}/api/me/assistant/conversations/${conversation.id}/messages`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ content: text, pageContext: { ...pageContextRef.current, ...chartContextRef.current } }),
        signal: controller.signal,
      });
    } catch (e) {
      markApiEnd(rubyPid, "POST /api/me/assistant/conversations/:id/messages");
      if ((e as { name?: string }).name === "AbortError") { setStatus("idle"); markActionEnd(rubyPid); return; }
      setStatus("error"); setErrorBanner("Connection lost. Please try again.");
      markActionEnd(rubyPid, { bottleneck: "network" });
      return;
    }
    if (!res.ok || !res.body) {
      markApiEnd(rubyPid, "POST /api/me/assistant/conversations/:id/messages");
      setStatus("error");
      setErrorBanner(res.status === 401 ? "Sign in to chat with ARX AI." : `Assistant error (${res.status}).`);
      markActionEnd(rubyPid, { bottleneck: "api" });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantText = "";
    const tools: ToolEvent[] = [];
    let intent: string | undefined;

    setStatus("streaming");
    // Begin a fresh streaming-speech turn so Ruby reads each sentence aloud
    // as it arrives instead of waiting for the whole reply. Suppressed in
    // realtime/mic voice mode (handled by WebRTC) — see voiceModeActive below.
    const streamingVoiceActive =
      activeTTS.enabled &&
      !(realtime.state === "listening" || realtime.state === "speaking" ||
        realtime.state === "connecting" || realtime.state === "muted" ||
        micActiveRef.current);
    if (streamingVoiceActive) activeTTS.speakStreamReset();
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { break; }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const raw of events) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev: { type?: string; content?: string; intent?: string; name?: string; status?: string; durationMs?: number; message?: string; safetyMode?: string; liveLocked?: boolean; allowOrderExecution?: boolean; readOnlyMode?: boolean; ts?: number; read?: Record<string, unknown>; symbol?: string; timeframe?: string; readLayer?: string; feedUnconfirmed?: boolean };
        try { ev = JSON.parse(payload); } catch {
          // Phase 22F — malformed JSON on the wire. Backend should never
          // emit this (CANONICAL filter on the server enforces JSON); if
          // it ever does, drop silently. NEVER surface raw text to the UI.
          if (import.meta.env.DEV) console.warn("[arx-assistant] dropped malformed SSE payload");
          continue;
        }
        // Phase 22F — strict canonical whitelist (mirror of server CANONICAL set).
        // Anything outside this set is server-side noise that escaped the
        // first filter; drop it, log in dev only, never surface to UI.
        const KNOWN_TYPES = new Set(["safety", "intent", "content", "content_clear", "tool_call", "tool_result", "reasoning", "error", "done", "ping"]);
        if (!ev.type || !KNOWN_TYPES.has(ev.type)) {
          if (import.meta.env.DEV) console.warn("[arx-assistant] dropped non-canonical SSE event", ev?.type);
          continue;
        }
        // Phase Ruby-Speed — server emits `content_clear` when a turn that
        // streamed preamble ("Let me check the scanner...") turned into a
        // tool call. Strip exactly that many trailing characters from the
        // visible assistant message so the user never sees the preamble.
        if (ev.type === "content_clear") {
          const chars = typeof (ev as { chars?: number }).chars === "number" ? (ev as { chars: number }).chars : 0;
          if (chars > 0 && assistantText.length >= chars) {
            assistantText = assistantText.slice(0, assistantText.length - chars);
            setMessages((cur) => {
              const last = cur[cur.length - 1];
              if (!last || last.role !== "assistant") return cur;
              return [...cur.slice(0, -1), { ...last, content: assistantText }];
            });
            // Don't read aloud preamble the user no longer sees.
            if (streamingVoiceActive) activeTTS.speakStreamRetract(assistantText.length);
          }
          continue;
        }
        if (ev.type === "ping") {
          // Heartbeat — keep-alive only, no UI side effect.
          continue;
        }
        if (ev.type === "safety") {
          // Phase 28 — Safety-envelope validator (read-only assistant gate).
          //
          // The backend now emits a per-user DYNAMIC envelope where:
          //   - safetyMode ∈ {"off" | "simulated" | "demo" | "live" | "paper_only"}
          //   - liveLocked is true UNLESS the user's effective tradingMode is LIVE
          //   - allowOrderExecution is the ONE field that actually means
          //     "execution can reach a broker today"
          //
          // The previous strict check (safetyMode==="paper_only" AND
          // liveLocked===true) disabled the assistant for every non-paper
          // mode (off/simulated/demo/even live-read-only), which is wrong:
          // the assistant is READ-ONLY chat and is safe to run as long as
          // execution gates remain locked.
          //
          // Disable the assistant only when the envelope is missing/malformed
          // OR when execution is actually unlocked (which would imply a chat
          // turn could trigger a real trade — it cannot today, but we fail
          // closed defensively).
          const VALID_MODES = new Set(["off", "simulated", "demo", "live", "paper_only"]);
          const envelopeMissing =
            typeof ev.safetyMode !== "string" ||
            typeof ev.liveLocked !== "boolean";
          const envelopeMalformed =
            !envelopeMissing && !VALID_MODES.has(ev.safetyMode as string);
          // Only disable assistant if envelope is missing/malformed.
          // allowOrderExecution=true is valid in live mode — Ruby still
          // cannot bypass backend guards; execution is always server-gated.
          const executionUnlocked = false; // no longer block on this
          if (envelopeMissing || envelopeMalformed) {
            if (import.meta.env.DEV) {
              console.warn("[arx-assistant] safety envelope rejected", {
                safetyMode: ev.safetyMode,
                liveLocked: ev.liveLocked,
                allowOrderExecution: ev.allowOrderExecution,
                envelopeMissing, envelopeMalformed, executionUnlocked,
              });
            }
            setErrorBanner("Safety envelope mismatch — assistant disabled.");
            // PART 8 — close out the perf row before bailing so we don't
            // leak a "still running" ruby.sendMessage action.
            markApiEnd(rubyPid, "POST /api/me/assistant/conversations/:id/messages");
            markActionEnd(rubyPid, { bottleneck: "api" });
            controller.abort(); return;
          }
        }
        else if (ev.type === "intent" && ev.intent) { intent = ev.intent; }
        else if (ev.type === "content" && typeof ev.content === "string") {
          assistantText += ev.content;
          setMessages((cur) => {
            const last = cur[cur.length - 1];
            if (!last || last.role !== "assistant") return cur;
            return [...cur.slice(0, -1), { ...last, content: assistantText, intent, toolCalls: tools.slice() }];
          });
          setStatus("streaming");
          // Read aloud as Ruby types: feed the text so far; completed
          // sentences are spoken in order, the trailing partial is held.
          if (streamingVoiceActive) activeTTS.speakStreamPush(assistantText);
          // PART 8 — first-text time is the budget the user actually
          // feels (target ≤1500ms). Recorded once per turn.
          if (!firstTextMarked && assistantText.trim().length > 0) {
            firstTextMarked = true;
            markRenderComplete(rubyPid);
          }
        }
        else if (ev.type === "tool_call" && ev.name) {
          tools.push({ name: ev.name });
          setStatus("tool");
          setMessages((cur) => {
            const last = cur[cur.length - 1];
            if (!last || last.role !== "assistant") return cur;
            return [...cur.slice(0, -1), { ...last, toolCalls: tools.slice() }];
          });
        }
        else if (ev.type === "tool_result" && ev.name) {
          const tc = tools.find((t) => t.name === ev.name && !t.status);
          if (tc) { tc.status = ev.status; tc.durationMs = ev.durationMs; }
          setMessages((cur) => {
            const last = cur[cur.length - 1];
            if (!last || last.role !== "assistant") return cur;
            return [...cur.slice(0, -1), { ...last, toolCalls: tools.slice() }];
          });
        }
        else if (ev.type === "reasoning" && ev.read && typeof ev.read === "object") {
          // Structured, honesty-gated chart read from the readChartStructure
          // tool. Build the ONE standardized Ruby Reasoning Block from the SAME
          // builder the Scanner Ruby Chart Read uses — NEVER fabricated from
          // prose. The builder honours readLayer: an INSUFFICIENT / gated read
          // renders WAIT, STRUCTURAL_ONLY renders a conditional read with the
          // limit stated in Feed/Data, and no direction or level is invented.
          const layer = ev.readLayer ?? "INSUFFICIENT";
          const structuralOnly = layer === "STRUCTURAL_ONLY";
          const feedNotConfirmed = ev.feedUnconfirmed === true;
          const gated = (ev.read as { gated?: boolean }).gated === true;
          const reasoning = buildReasoningFromChartRead({
            read: ev.read as Parameters<typeof buildReasoningFromChartRead>[0]["read"],
            symbol: ev.symbol ?? "",
            timeframe: ev.timeframe ?? "",
            // INDEPENDENT booleans, exactly like the Scanner Ruby Chart Read panel:
            // structuralOnly comes from the read tier, feedNotConfirmed from the
            // server's explicit feed verdict. Both can be true (feed-unconfirmed
            // STRUCTURAL_ONLY → WAIT) or only one (sufficiency-withheld on a clean
            // feed → conditional structural read). Never guessed from readLayer.
            structuralOnly,
            feedNotConfirmed,
          }, name);
          // Task #777 — attach the SAME feed-confidence verdict that drove the
          // reasoning so the chat bubble can render the identical FeedConfidenceBadge
          // the chart popover / Scanner Ruby Chart Read show. `aiUsableResolved`
          // mirrors the builder's `withheld` gate EXACTLY (gated / feed-unconfirmed
          // / structural-only ⇒ false; fully-confirmed ⇒ true), so the badge can
          // never look more confident than the prose. Only when we know the exact
          // symbol+timeframe (needed to resolve the live feed status for the popover
          // details) — otherwise the badge is omitted rather than guessed.
          const sym = (ev.symbol ?? "").trim();
          const tf = (ev.timeframe ?? "").trim();
          const chartReadFeed =
            sym && tf
              ? {
                  symbol: sym,
                  timeframe: tf,
                  aiUsableResolved:
                    gated || feedNotConfirmed || structuralOnly ? false : true,
                }
              : undefined;
          setMessages((cur) => {
            const last = cur[cur.length - 1];
            if (!last || last.role !== "assistant") return cur;
            return [...cur.slice(0, -1), { ...last, reasoning, chartReadFeed }];
          });
        }
        else if (ev.type === "error" && ev.message) { setErrorBanner(friendlyError(ev.message, undefined, name)); }
        else if (ev.type === "done") {
          // PART 8 — full-message budget (concise ≤4000ms target).
          // TTS is kicked off below but is INTENTIONALLY excluded from
          // this action's timing — text-completion is what blocks the UI.
          markApiEnd(rubyPid, "POST /api/me/assistant/conversations/:id/messages");
          markActionEnd(rubyPid);
          setMessages((cur) => {
            const last = cur[cur.length - 1];
            if (!last || last.role !== "assistant") return cur;
            return [...cur.slice(0, -1), { ...last, pending: false, intent, toolCalls: tools.slice() }];
          });
          // Handle voice mode change from Ruby tool
          const allTools = tools.slice();
          const voiceCmd = allTools.find((t: {name?: string; result?: {action?: string; mute?: boolean}}) =>
            t.name === "setVoiceMode" && t.result?.action === "voice_mode_change"
          );
          if (voiceCmd?.result?.mute !== undefined) {
            tts.setEnabled(!voiceCmd.result.mute);
          }

          setStatus("idle");
          // Speak the final reply — on by default, user can mute via chat command
          const voiceModeActive =
            realtime.state === "listening" ||
            realtime.state === "speaking" ||
            realtime.state === "connecting" ||
            realtime.state === "muted" ||
            micActiveRef.current;
          if (activeTTS.enabled && !voiceModeActive && assistantText.trim()) {
            if (streamingVoiceActive) {
              // Ruby has been reading sentences aloud AS they streamed in
              // (speakStreamPush). At end-of-stream just flush the trailing
              // partial sentence so speech stays in sync with the text —
              // do NOT call the one-shot speak() here, which would restart
              // playback from the top and cause the delayed "speaks after the
              // text is done" behavior.
              activeTTS.speakStreamFlush(assistantText);
            } else {
              // Fallback: streaming speech wasn't active for this turn (e.g.
              // TTS was toggled on mid-stream). Speak the final reply once.
              // speak() internally shortens to Quick-read or 2 sentences so
              // TTS doesn't read a long report aloud, and binds the audio to
              // a generation id so stale playback is dropped.
              activeTTS.speak(assistantText);
            }
          }
        }
      }
    }
    setStatus((s) => (s === "streaming" || s === "tool" || s === "thinking" ? "idle" : s));
    // Safety net — if the stream ended without a `done` event (network
    // hang-up, server crash mid-stream), close the perf row anyway so
    // the action doesn't leak as "still running" in the ring buffer.
    // markActionEnd is idempotent (returns null on the second call).
    markActionEnd(rubyPid);
  }, [conversation]);

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void sendText(input); };

  // Track mic-active in a ref so the streaming `done` handler can read the
  // latest value without re-creating sendText.
  const micActiveRef = useRef(false);
  useEffect(() => {
    micActiveRef.current = status === "recording" || status === "listening";
  }, [status]);

  // Status pill — reflects the manual voice-flow state lock. Voice is
  // press-to-record only; the pill never advertises a hands-free / listening
  // loop because there isn't one.
  const statusPill = useMemo(() => {
    switch (status) {
      case "thinking":  return { label: `${name} is thinking`,  cls: "bg-warning/20 text-warning border-warning/40", pulse: true };
      case "streaming": return { label: `${name} is typing`,   cls: "bg-ruby/20 text-ruby border-ruby/40", pulse: true };
      case "tool":      return { label: `${name} is checking`, cls: "bg-premium/20 text-premium border-premium/40", pulse: true };
      case "recording": return { label: "Recording…",  cls: "bg-danger/20 text-danger border-danger/40", pulse: true };
      case "listening": return { label: "Sending voice message…", cls: "bg-success/20 text-success border-success/40", pulse: true };
      case "realtime":  return { label: realtime.isMuted ? `${name} is on standby` : `${name} is listening`, cls: "bg-premium/20 text-ruby border-premium/40", pulse: !realtime.isMuted };
      case "speaking":  return { label: `${name} is speaking…`,   cls: "bg-ruby/20 text-ruby border-ruby/40", pulse: true };
      case "error":     return { label: `${name} is reconnecting`, cls: "bg-danger/20 text-danger border-danger/40", pulse: true };
      default: {
        // When typed-reply TTS is reading the answer aloud the overall status
        // is "idle" but the user is hearing speech — surface "Ruby is
        // speaking…" so the badge matches what they hear. Once it ends the
        // flow returns to idle; the mic is never auto-restarted.
        if (tts.state === "speaking") {
          return { label: `${name} is speaking…`, cls: "bg-ruby/20 text-ruby border-ruby/40", pulse: true };
        }
        return { label: "Tap to record", cls: "bg-success/20 text-success border-success/40", pulse: false };
      }
    }
  }, [status, realtime.isMuted, tts.state, name]);

  const micActive = status === "recording" || status === "listening";
  // realtimeEngaged = panel should treat realtime as in-progress (controls visible, mic disabled).
  // realtimeConnected = peer is actually connected (badge may claim "active"). Honest separation.
  const realtimeEngaged = realtime.state === "connecting" || realtime.state === "listening" || realtime.state === "speaking" || realtime.state === "muted";
  const realtimeConnected = realtime.state === "listening" || realtime.state === "speaking" || realtime.state === "muted";

  return (
    <>
      {/* Floating trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => { if (open) { void closePanel(); } else { setOpen(true); } }}
        className={cn(
          "fixed z-50 rounded-full shadow-lg transition-all",
          "bottom-20 right-4 md:bottom-6 md:right-6",
          "h-14 w-14 flex items-center justify-center",
          "bg-gradient-to-br from-ruby to-success text-foreground",
          "hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ruby",
        )}
        data-testid="arx-assistant-trigger"
        aria-label={open ? `Close ${name} assistant` : `Open ${name} assistant`}
        title={open ? `Close ${name}` : `Open ${name} — your ARX trading assistant`}
      >
        <AnimatedArxAssistantIcon state={iconState.state} status={iconState.status} className="h-7 w-7" />
      </button>

      {open && (
        <div
          ref={panelRef}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden rounded-2xl border shadow-2xl",
            "bottom-20 right-2 md:bottom-20 md:right-6",
            "w-[min(440px,calc(100vw-1rem))] h-[min(760px,calc(100vh-6rem))]",
            "bg-card/95 backdrop-blur border-border text-foreground",
          )}
          role="dialog"
          aria-label={`${name} — ARX Live Assistant`}
          data-testid="arx-assistant-panel"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-ruby/15 text-ruby ring-1 ring-ruby/30">
                <Brain className="h-4 w-4" />
              </span>
              <div>
                <div className="text-sm font-semibold leading-tight">{name}</div>
                <div className="text-[11px] text-txt-secondary">ARX trading assistant</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Phase 22K — memory controls menu (new chat / clear chat / clear all memory) */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  disabled={memoryBusy}
                  className="text-txt-secondary hover:text-foreground disabled:opacity-50"
                  aria-label="Chat menu"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  data-testid="arx-menu-button"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {menuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-7 z-10 w-56 rounded-md border border-border bg-card shadow-lg py-1 text-xs"
                    onMouseLeave={() => setMenuOpen(false)}
                    data-testid="arx-menu"
                  >
                    <button
                      role="menuitem"
                      type="button"
                      disabled={memoryBusy}
                      onClick={async () => {
                        setMenuOpen(false);
                        setMemoryBusy(true);
                        try {
                          const r = await postJson<{ conversation: Conversation }>("/api/me/assistant/conversations", { title: "New chat" });
                          setConversation(r.conversation);
                          setMessages([]);
                          setErrorBanner(null);
                        } catch {
                          setErrorBanner("Could not start a new chat. Please try again.");
                        } finally { setMemoryBusy(false); }
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-secondary disabled:opacity-50"
                      data-testid="arx-menu-new-chat"
                    >
                      <Plus className="h-3.5 w-3.5 text-ruby" />
                      Start new {name} chat
                    </button>
                    {/* Memory on/off toggle. Disabled = Ruby stops using
                        long-term recall but past chats remain saved. */}
                    <button
                      role="menuitem"
                      type="button"
                      disabled={memoryBusy}
                      onClick={async () => {
                        setMemoryBusy(true);
                        try {
                          const next = !memoryEnabled;
                          const res = await fetch(`${BASE}/api/me/assistant/memory/settings`, {
                            method: "PATCH", credentials: "include",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ memoryEnabled: next }),
                          });
                          if (!res.ok) throw new Error("toggle_failed");
                          setMemoryEnabledState(next);
                        } catch {
                          setErrorBanner(`Could not change ${name} memory setting.`);
                        } finally { setMemoryBusy(false); }
                      }}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-foreground hover:bg-secondary disabled:opacity-50"
                      data-testid="arx-menu-memory-toggle"
                    >
                      <span className="flex items-center gap-2">
                        {memoryEnabled ? <BrainCircuit className="h-3.5 w-3.5 text-success" /> : <Brain className="h-3.5 w-3.5 text-txt-muted" />}
                        Long-term memory
                      </span>
                      <span className={cn("text-[10px] uppercase tracking-wider rounded-full px-2 py-0.5 border", memoryEnabled ? "border-success/40 text-success bg-success/10" : "border-border text-txt-secondary bg-secondary")}>
                        {memoryEnabled ? "On" : "Off"}
                      </span>
                    </button>
                    {/* Export — downloads full chat history + memory as JSON */}
                    <a
                      role="menuitem"
                      href={`${BASE}/api/me/assistant/export`}
                      onClick={() => setMenuOpen(false)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-secondary"
                      data-testid="arx-menu-export"
                    >
                      <Download className="h-3.5 w-3.5 text-ruby" />
                      Export {name} chat history
                    </a>
                    <button
                      role="menuitem"
                      type="button"
                      disabled={memoryBusy || !conversation}
                      onClick={async () => {
                        setMenuOpen(false);
                        if (!conversation) return;
                        if (!window.confirm(`Clear this chat? This removes only the current conversation. Long-term ${name} memory is preserved.`)) return;
                        setMemoryBusy(true);
                        try {
                          const res = await fetch(`${BASE}/api/me/assistant/conversations/${conversation.id}`, {
                            method: "DELETE", credentials: "include",
                          });
                          if (!res.ok) throw new Error("delete_failed");
                          const r = await postJson<{ conversation: Conversation }>("/api/me/assistant/conversations", { title: "Live chat" });
                          setConversation(r.conversation);
                          setMessages([]);
                          setErrorBanner(null);
                        } catch {
                          setErrorBanner("Could not clear this chat. Please try again.");
                        } finally { setMemoryBusy(false); }
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-secondary disabled:opacity-50"
                      data-testid="arx-menu-clear-chat"
                    >
                      <Eraser className="h-3.5 w-3.5 text-warning" />
                      Clear current chat
                    </button>
                    <div className="my-1 border-t border-border" />
                    <button
                      role="menuitem"
                      type="button"
                      disabled={memoryBusy}
                      onClick={async () => {
                        setMenuOpen(false);
                        if (!window.confirm(`Clear ALL ${name} memory? This removes saved chat history, long-term summary, preferences, and unresolved tasks for this account. This cannot be undone.`)) return;
                        setMemoryBusy(true);
                        try {
                          const res = await fetch(`${BASE}/api/me/assistant/memory`, {
                            method: "DELETE", credentials: "include",
                          });
                          if (!res.ok) throw new Error("wipe_failed");
                          const r = await postJson<{ conversation: Conversation }>("/api/me/assistant/conversations", { title: "Live chat" });
                          setConversation(r.conversation);
                          setMessages([]);
                          setErrorBanner(null);
                        } catch {
                          setErrorBanner("Could not clear ARX memory. Please try again.");
                        } finally { setMemoryBusy(false); }
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left text-danger hover:bg-danger/15 disabled:opacity-50"
                      data-testid="arx-menu-clear-all"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Clear all {name} memory
                    </button>
                    <div className="px-3 py-2 text-[10px] text-txt-muted leading-snug border-t border-border">
                      {name} remembers saved conversations to help personalize ARX. You can clear chat or memory anytime.
                    </div>
                  </div>
                )}
              </div>
              <button onClick={() => void closePanel()} className="text-txt-secondary hover:text-foreground" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Live status bar — blank when idle; shows the current action
              (recording / thinking / speaking) only while something is
              happening. Controls (speak toggle, voice picker) live by the
              input bar; the mic is next to the chat input. */}
          {(() => {
            // Single source of truth for *voice* status. Thinking/typing are
            // shown by the in-chat pending bubble (RubyTypingIndicator), so we
            // deliberately don't repeat them here — that was the duplicated
            // status in multiple places. "Speaking" follows the live speech
            // engine (tts.state) so it clears the moment she stops.
            const isSpeaking = tts.state === "speaking";
            const statusText =
              status === "recording" || voiceFlow === "recording_user_voice"
                ? "Recording — release or pause to send"
                : voiceFlow === "processing_voice_message"
                  ? "Sending your voice message…"
                  : isSpeaking
                    ? `${name} is speaking…`
                    : null;
            if (!statusText) return null;
            return (
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-txt-secondary" data-testid="arx-status-bar">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ruby/15 text-ruby">
                  <Brain className="h-3 w-3" />
                </span>
                <span>{statusText}</span>
                <span className="flex items-center gap-0.5" aria-hidden="true">
                  <span className="inline-block h-1 w-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="inline-block h-1 w-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="inline-block h-1 w-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "300ms" }} />
                </span>
                {tts.state === "speaking" && (
                  <button
                    type="button"
                    onClick={() => tts.stop()}
                    className="ml-auto grid h-6 w-6 place-items-center rounded-full border border-danger/50 bg-danger/10 text-danger hover:border-danger"
                    title="Stop speaking"
                    aria-label="Stop speaking"
                    data-testid="arx-speak-stop"
                  >
                    <Square className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })()}

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.length === 0 && (
              <div className="rounded-2xl border border-border bg-secondary/60 p-3.5 text-sm text-foreground">
                <div className="font-semibold mb-1 flex items-center gap-2">
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-ruby/15 text-ruby"><Brain className="h-3.5 w-3.5" /></span>
                  Hi, I’m {name} — your ARX trading assistant.
                </div>
                <div className="text-txt-secondary">
                  Ask me anything about your account, trades, risk, strategy, or the markets. Here’s what I can do:
                </div>
                <ul className="mt-2.5 space-y-2">
                  <li className="flex items-start gap-2">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-ruby/15 text-ruby"><Mic className="h-3.5 w-3.5" /></span>
                    <span className="text-txt-secondary"><span className="text-foreground font-medium">Talk to me by voice</span> — tap the mic, speak, and I’ll show what I heard, then reply.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-success/15 text-success"><Volume2 className="h-3.5 w-3.5" /></span>
                    <span className="text-txt-secondary"><span className="text-foreground font-medium">I can speak back</span> — turn on the speaker icon above and I’ll read my answers aloud.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary"><Sparkles className="h-3.5 w-3.5" /></span>
                    <span className="text-txt-secondary"><span className="text-foreground font-medium">Read the market &amp; review trades</span> — ask for a setup read, your risk, or a recap of today.</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-warning/15 text-warning"><ShieldCheck className="h-3.5 w-3.5" /></span>
                    <span className="text-txt-secondary">I follow your account permissions and risk controls — I never place a trade without your confirmation.</span>
                  </li>
                </ul>
                <div className="mt-2.5 text-txt-muted text-xs">
                  Try the suggestions below, type a question, or tap the mic to start.
                </div>
                {!memoryEnabled && (
                  <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-txt-secondary">
                    Long-term memory is off — I won’t reference past conversations.
                  </div>
                )}
              </div>
            )}
            {messages.map((m) => (<MessageBubble key={m.id} m={m} />))}
            {errorBanner && (
              <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/15 px-3 py-2 text-xs text-danger">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5" />
                <span>{errorBanner}</span>
              </div>
            )}
          </div>

          {/* Suggestion chips */}
          <div className="border-t border-border px-4 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setChipsOpen((v) => !v)}
                  className="flex items-center gap-1 text-[11px] text-txt-secondary hover:text-foreground"
                  aria-expanded={chipsOpen}
                >
                  {chipsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
                  Quick suggestions
                </button>
                {/* Phase 3 — advisory timing chip for active chart symbol */}
                <RubyTimingChip symbol={chartSymbol ?? "EURUSD"} />
              </div>
              <div className="flex items-center gap-2">
                {briefingUpdatedAt && (
                  <span className="text-[10px] text-txt-muted">
                    Updated {new Date(briefingUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
                <button
                  onClick={() => void loadBriefing({ refresh: true })}
                  disabled={briefingLoading}
                  className="flex items-center gap-1 text-[10px] text-txt-secondary hover:text-ruby disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Refresh briefing"
                  title="Refresh briefing"
                >
                  <RefreshCw className={cn("h-3 w-3", briefingLoading && "animate-spin")} />
                  Refresh
                </button>
              </div>
            </div>
            {chipsOpen && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(briefingSuggestions ?? SUGGESTIONS).map((s) => (
                  <button
                    key={s.label}
                    onClick={() => void sendText(s.prompt)}
                    disabled={status === "thinking" || status === "streaming"}
                    className={cn(
                      "rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-foreground hover:border-ruby hover:text-ruby",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Input row */}
          <form onSubmit={onSubmit} className="flex items-center gap-2 border-t border-border px-3 py-2.5">
            {/* Speak responses toggle */}
            <button
              type="button"
              onClick={() => { if (tts.supported) tts.setEnabled(!tts.enabled); }}
              disabled={!tts.supported}
              aria-pressed={tts.enabled}
              data-testid="arx-speak-toggle-card"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border text-txt-secondary hover:text-foreground disabled:opacity-50 transition"
              title={!tts.supported ? "Speech not supported" : tts.enabled ? "Speak responses: on" : "Speak responses: off"}
            >
              {tts.enabled && tts.supported ? <Volume2 className="h-4 w-4 text-success" /> : <VolumeX className="h-4 w-4" />}
            </button>
            {/* Voice picker */}
            <div className="relative shrink-0">
              {showVoicePicker && (
                <>
                  <div className="fixed inset-0 z-[199]" onClick={() => setShowVoicePicker(false)} />
                  <VoicePicker onClose={() => setShowVoicePicker(false)} />
                </>
              )}
              <button
                type="button"
                onClick={() => setShowVoicePicker((v) => !v)}
                className="grid h-9 w-9 place-items-center rounded-full border border-border text-txt-secondary hover:text-foreground transition"
                title="Choose voice"
                aria-label="Choose voice"
              >
                <Radio className="h-4 w-4" />
              </button>
            </div>
            {/* Realtime (true WebRTC) controls — only when key is configured server-side */}
            {voiceMode?.realtimeConfigured && !realtimeEngaged && (
              <button
                type="button"
                onClick={() => { void realtime.start(); }}
                className="h-9 w-9 rounded-full flex items-center justify-center border border-ruby/50 bg-ruby/15 text-ruby hover:border-ruby hover:text-ruby"
                aria-label="Start Realtime voice (WebRTC)"
                data-testid="arx-realtime-start"
                disabled={micActive || status === "thinking" || status === "streaming"}
                title="Start live voice conversation (WebRTC)"
              >
                <Radio className="h-4 w-4" />
              </button>
            )}
            {realtimeEngaged && (
              <>
                <button
                  type="button"
                  onClick={() => realtime.toggleMute()}
                  className={cn(
                    "h-9 w-9 rounded-full flex items-center justify-center border",
                    realtime.isMuted
                      ? "border-border bg-card text-txt-secondary"
                      : "border-premium/60 bg-premium/10 text-ruby animate-pulse",
                  )}
                  aria-label={realtime.isMuted ? "Unmute Realtime mic" : "Mute Realtime mic"}
                  data-testid="arx-realtime-mute"
                  title={realtime.isMuted ? "Unmute" : "Mute"}
                >
                  {realtime.isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => { void realtime.stop(); setRealtimeMode(null); }}
                  className="h-9 w-9 rounded-full flex items-center justify-center border border-danger/50 bg-danger/15 text-danger hover:border-danger hover:text-danger"
                  aria-label="End Realtime voice session"
                  data-testid="arx-realtime-stop"
                  title="End live voice session"
                >
                  <Square className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={async () => {
                // Manual press-to-record ONLY. Tap to start; tap again to stop
                // and send. The mic is never re-opened automatically and the
                // recorder is blocked while Ruby is speaking so the user can't
                // record over her — they must let her finish or hit Stop first.
                if (status === "recording") {
                  await stopVoiceAndSend();
                } else {
                  await startVoiceRecord();
                }
              }}
              className={cn(
                "h-9 w-9 rounded-full flex items-center justify-center border",
                micActive
                  ? "border-success/60 bg-success/10 text-success animate-pulse"
                  : "border-border bg-card text-foreground hover:text-ruby hover:border-ruby",
              )}
              aria-label={status === "recording" ? "Stop and send voice message" : "Record voice message"}
              data-testid="arx-mic-toggle"
              disabled={realtimeEngaged || isVoiceUploading || rubySpeaking || status === "thinking" || status === "streaming" || status === "listening"}
              title={
                rubySpeaking
                  ? `${name} is speaking — let her finish or tap Stop first`
                  : status === "recording"
                    ? "Recording… tap to send"
                    : "Tap to record"
              }
            >
              {micActive ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
            </button>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={status === "recording" ? "Recording… tap mic to send" : `Ask ${name} about the market…`}
              className="flex-1 bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={status === "thinking" || status === "streaming" || status === "recording" || status === "listening"}
              data-testid="arx-input"
            />
            <Button
              type="submit"
              disabled={!input.trim() || status === "thinking" || status === "streaming" || status === "recording" || status === "listening"}
              className="h-9 px-3 bg-ruby text-foreground hover:bg-ruby"
              data-testid="arx-send"
            >
              {status === "thinking" || status === "streaming"
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Send className="h-4 w-4" />}
            </Button>
          </form>
        </div>
      )}
    </>
  );
}

// ── FormattedMessage — renders markdown naturally without reading symbols ──
function FormattedMessage({ text }: { text: string }) {
  // Convert markdown to clean readable HTML-like structure
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let key = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { elements.push(<br key={key++} />); continue; }

    // Headers → bold
    const headerMatch = trimmed.match(/^#{1,3}\s+(.+)/);
    if (headerMatch) {
      elements.push(<p key={key++} className="font-semibold mt-1">{headerMatch[1]}</p>);
      continue;
    }

    // Bullet points → natural paragraph with soft dot
    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)/);
    if (bulletMatch) {
      elements.push(
        <p key={key++} className="pl-3 before:content-['·'] before:mr-2 before:text-txt-secondary">
          {formatInline(bulletMatch[1])}
        </p>
      );
      continue;
    }

    // Numbered list
    const numMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (numMatch) {
      elements.push(<p key={key++} className="pl-3">{formatInline(numMatch[1])}</p>);
      continue;
    }

    elements.push(<p key={key++}>{formatInline(trimmed)}</p>);
  }

  return <div className="space-y-0.5 leading-relaxed">{elements}</div>;
}

function formatInline(text: string): React.ReactNode {
  // Bold **text**
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((p, i) => i % 2 === 1 ? <strong key={i} className="font-semibold text-white">{p}</strong> : p);
}

// ── VoicePicker ────────────────────────────────────────────────────────────
type SV = { id: string; label: string; gender: "female"|"male"; accent: string; note: string; provider: "elevenlabs"|"openai" };

function VoicePicker({ onClose }: { onClose: () => void }) {
  const { name } = useAssistantName();
  const [serverVoices, setServerVoices] = useState<SV[]>([]);
  const [browserVoices, setBrowserVoices] = useState<ReturnType<typeof getAvailableVoices>>([]);
  const [selected, setSelected] = useState<string>(getServerVoicePref()?.voiceId ?? getSavedVoiceName() ?? "");
  const [previewing, setPreviewing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Load server voices
    fetch("/api/me/assistant/tts/voices", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data?.ok) { setLoading(false); return; }
        const el: SV[] = data.providers?.elevenlabs?.available
          ? (data.providers.elevenlabs.voices || []).map((v: Omit<SV,"provider">) => ({...v, provider: "elevenlabs" as const})) : [];
        const oa: SV[] = data.providers?.openai?.available
          ? (data.providers.openai.voices || []).map((v: Omit<SV,"provider">) => ({...v, provider: "openai" as const})) : [];
        setServerVoices([...el, ...oa]);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    // Load browser voices
    const loadBrowser = () => setBrowserVoices(getAvailableVoices());
    loadBrowser();
    window.speechSynthesis?.addEventListener("voiceschanged", loadBrowser);
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", loadBrowser);
  }, []);

  const preview = (voiceId: string, provider: "elevenlabs"|"openai"|"browser") => {
    if (previewing) return;
    setPreviewing(true);
    previewVoice(voiceId, provider, name).finally(() => setPreviewing(false));
  };

  const selectVoice = (voiceId: string, provider: "elevenlabs"|"openai"|"browser") => {
    setSelected(voiceId);
    if (provider === "browser") {
      saveServerVoicePref(null);
      saveVoiceName(voiceId);
    } else {
      saveServerVoicePref({ provider, voiceId });
    }
    preview(voiceId, provider);
  };

  const serverFemale = serverVoices.filter(v => v.gender === "female");
  const serverMale   = serverVoices.filter(v => v.gender === "male");
  const bFemale = browserVoices.filter(v => v.genderHint === "female");
  const bMale   = browserVoices.filter(v => v.genderHint === "male");
  const bOther  = browserVoices.filter(v => v.genderHint === "unknown");

  return (
    <div className="fixed bottom-20 right-4 w-80 max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl z-[200] p-3">
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-sm font-medium text-white">{name}'s Voice</span>
          <p className="text-[10px] text-txt-muted mt-0.5">{loading ? "Loading voices…" : "Tap any to preview"}</p>
        </div>
        <button type="button" onClick={onClose} className="text-txt-secondary hover:text-white text-xs px-2 py-1 rounded border border-border">
          {previewing ? "Playing…" : "Done"}
        </button>
      </div>

      {!loading && serverVoices.length === 0 && browserVoices.length === 0 && (
        <p className="text-xs text-txt-muted py-4 text-center">No voices available.</p>
      )}

      {serverVoices.length > 0 && (
        <>
          <div className="text-[10px] text-ruby/70 mb-2">✨ Natural AI Voices</div>
          {serverFemale.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-txt-muted mb-1">♀ Women</div>
              <div className="space-y-1">
                {serverFemale.map(v => (
                  <button key={v.id} type="button" onClick={() => selectVoice(v.id, v.provider)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 border transition ${selected === v.id ? "bg-ruby/20 text-ruby border-ruby/40" : "text-foreground hover:bg-secondary border-transparent"}`}>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{v.label}</div>
                      <div className="text-txt-muted text-[10px]">{v.accent} · {v.note}</div>
                    </div>
                    {selected === v.id && <span className="text-ruby shrink-0">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {serverMale.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-txt-muted mb-1">♂ Men</div>
              <div className="space-y-1">
                {serverMale.map(v => (
                  <button key={v.id} type="button" onClick={() => selectVoice(v.id, v.provider)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 border transition ${selected === v.id ? "bg-ruby/20 text-ruby border-ruby/40" : "text-foreground hover:bg-secondary border-transparent"}`}>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{v.label}</div>
                      <div className="text-txt-muted text-[10px]">{v.accent} · {v.note}</div>
                    </div>
                    {selected === v.id && <span className="text-ruby shrink-0">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {browserVoices.length > 0 && <div className="border-t border-border my-2" />}
        </>
      )}

      {browserVoices.length > 0 && (
        <>
          <div className="text-[10px] text-txt-muted mb-2">Browser voices</div>
          {[["♀ Women", bFemale], ["♂ Men", bMale], ["Other", bOther]].map(([label, list]) =>
            (list as typeof browserVoices).length > 0 ? (
              <div key={label as string} className="mb-2">
                <div className="text-xs text-txt-muted mb-1">{label as string}</div>
                <div className="space-y-1">
                  {(list as typeof browserVoices).map(v => (
                    <button key={v.name} type="button" onClick={() => selectVoice(v.name, "browser")}
                      className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 border transition ${selected === v.name ? "bg-ruby/20 text-ruby border-ruby/40" : "text-foreground hover:bg-secondary border-transparent"}`}>
                      <div className="min-w-0">
                        <div className="font-medium truncate">{v.name.replace(/ Online.*$/, "").replace(/Microsoft |Google /, "")}</div>
                        {"accent" in v && <div className="text-txt-muted text-[10px]">{(v as {accent:string}).accent}</div>}
                      </div>
                      {selected === v.name && <span className="text-ruby shrink-0">✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            ) : null
          )}
        </>
      )}
    </div>
  );
}


// ── ChatChartReadFeedBadge ─────────────────────────────────────────────────
// Renders the SAME compact FeedConfidenceBadge the chart popover and Scanner
// Ruby Chart Read show, for a chat chart-read message (Task #777). The live
// feed-status detail (source, last candle/tick, broker-synthetic "broker
// candles" note, anomalies) comes from the SAME shared `useScannerTruth` query
// the scanner badge uses — no independent feed-status poll. The verdict, though,
// is the one already resolved server-side and folded into the reasoning prose:
// `aiUsableResolved` CAPS the badge so it can never look more confident than the
// read it sits above. DISPLAY ONLY — it gates nothing.
function ChatChartReadFeedBadge({
  symbol,
  timeframe,
  aiUsableResolved,
}: {
  symbol: string;
  timeframe: string;
  aiUsableResolved: boolean | null;
}) {
  const { feedStatus } = useScannerTruth(symbol, timeframe);
  return (
    <FeedConfidenceBadge
      feedStatus={feedStatus}
      aiUsableResolved={aiUsableResolved}
      showTrailingGap
    />
  );
}

function MessageBubble({ m }: { m: ChatMessage }) {
  const { name } = useAssistantName();
  const isUser = m.role === "user";
  const [expanded, setExpanded] = useState(false);
  // Long Ruby answers collapse to a readable height with Show more/less so the
  // panel never shows an unreadable wall of text. Full content is preserved.
  const isLong = !isUser && (m.content?.length ?? 0) > 480;
  // Dev/admin debug drawer — only inside the chat bubble in dev builds.
  // Regular users never see raw internal tool/function names.
  const showInternalToolNames = import.meta.env.DEV;
  // Pick the most-recent pending tool call for the friendly contextual line
  // (e.g. "Ruby is reviewing your performance…").
  const pendingTool = !isUser && m.toolCalls?.find((t) => !t.status);
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words",
          isUser ? "bg-primary/15 text-foreground border border-primary/25"
                 : "bg-secondary/60 text-foreground border border-border",
        )}
      >
        {/* Friendly tool status (no raw names) — shown while a tool call is
            in flight so the chat never falls silent during background work. */}
        {pendingTool && (
          <div className="mb-1">
            <RubyTypingIndicator
              state="usingTool"
              contextText={friendlyToolText(pendingTool.name, name)}
              testId="ruby-tool-indicator"
            />
          </div>
        )}
        {/* Dev-only debug drawer with the actual tool identifiers, kept so
            engineers can still verify the wire protocol. Collapsed by
            default in dev; never rendered in production builds. */}
        {showInternalToolNames && m.toolCalls && m.toolCalls.length > 0 && (
          <details className="mb-1 text-[10px] text-txt-muted" data-testid="ruby-tool-debug">
            <summary className="cursor-pointer select-none">debug · tools</summary>
            <div className="mt-1 flex flex-wrap gap-1">
              {m.toolCalls.map((t, i) => (
                <span
                  key={`${t.name}-${i}`}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5",
                    t.status === "error"
                      ? "border-danger/40 text-danger bg-danger/10"
                      : t.status === "ok"
                      ? "border-success/40 text-success bg-success/10"
                      : "border-premium/40 text-premium bg-premium/10",
                  )}
                >
                  <Wrench className="h-2.5 w-2.5" />
                  {t.name}
                </span>
              ))}
            </div>
          </details>
        )}
        {m.content
          ? (
            <>
              <div className={cn(isLong && !expanded && "max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>
                <FormattedMessage text={m.content} />
              </div>
              {isLong && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="mt-1.5 text-xs font-semibold text-ruby hover:underline"
                  data-testid="ruby-msg-toggle"
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              )}
            </>
          )
          : m.pending
            ? <RubyTypingIndicator state={pendingTool ? "usingTool" : "thinking"}
                                   contextText={pendingTool ? friendlyToolText(pendingTool.name, name) : undefined}
                                   testId="ruby-pending-indicator" />
            : m.voicePending
              ? (
                <span className="inline-flex items-center gap-1.5 text-txt-secondary" data-testid="arx-voice-transcribing">
                  <Mic className="h-3.5 w-3.5 text-ruby" />
                  Transcribing your message…
                </span>
              )
              : null}
        {!isUser && m.reasoning && (
          <div className="mt-2" data-testid="ruby-chat-reasoning-wrap">
            {/* Task #777 — the SAME compact feed-confidence badge the chart popover
                and Scanner Ruby Chart Read show, driven off the single resolved
                verdict that produced the reasoning below (no second source). */}
            {m.chartReadFeed && (
              <div className="mb-2 flex items-center gap-2" data-testid="ruby-chat-feed-badge-wrap">
                <ChatChartReadFeedBadge {...m.chartReadFeed} />
              </div>
            )}
            <RubyReasoningBlock data={m.reasoning} testid="ruby-chat-reasoning" dense />
          </div>
        )}
      </div>
    </div>
  );
}

// ── RubyTimingChip ─────────────────────────────────────────────────────────
// Compact advisory timing grade chip for the active chart symbol.
// Shown next to the suggestion chips; advisory only, never a gate.
// Renders nothing when data is unavailable (honest empty, fail-open).
const TIMING_CHIP_COLOR: Record<string, string> = {
  "A+": "border-success/40 bg-success/10 text-success",
  "A":  "border-success/40 bg-success/10 text-success",
  "B":  "border-primary/40 bg-primary/10 text-primary",
  "C":  "border-warning/40 bg-warning/10 text-warning",
  "D":  "border-warning/40 bg-warning/10 text-warning",
  "F":  "border-danger/40 bg-danger/10 text-danger",
};
function RubyTimingChip({ symbol }: { symbol: string }) {
  const q = useGetTimingBrain(symbol, {}, {
    query: {
      queryKey: getGetTimingBrainQueryKey(symbol),
      refetchInterval: 90_000,
      retry: false,
      staleTime: 60_000,
    },
  });
  if (!q.data) return null;
  const r = q.data;
  const colorClass = TIMING_CHIP_COLOR[r.timingGrade as string] ?? "border-border/40 bg-muted text-txt-secondary";
  const permLabel: Record<string, string> = {
    GO: "GO", WAIT_FOR_ENTRY: "Wait", WAIT_NEWS: "News", NO_TRADE: "Skip", STAND_DOWN: "Stand down",
  };
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold leading-none", colorClass)}
      title={`${symbol} timing: ${r.timingGrade} grade · ${r.entryPermission} — advisory only`}
    >
      {symbol} · {r.timingGrade} · {permLabel[r.entryPermission as string] ?? r.entryPermission}
    </span>
  );
}
