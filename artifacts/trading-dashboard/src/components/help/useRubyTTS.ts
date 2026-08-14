// useRubyTTS — server-side TTS for Ruby.
// Calls /api/me/assistant/tts to get ElevenLabs or OpenAI audio.
// Falls back to browser speechSynthesis if server not available.

import { useCallback, useEffect, useRef, useState } from "react";
import { sanitizeForSpeech, getSavedVoiceName, saveVoiceName } from "./useSpeakResponses";
import { voicePrefsAreServerBacked } from "./useUserVoiceSettings";
import { DEFAULT_ASSISTANT_NAME } from "@/lib/assistant-name";

const PREF_KEY    = "arx.tts.preference.v1";
const ENABLED_KEY = "arx.assistant.speakResponses.v1";

export interface TTSVoice {
  id:     string;
  label:  string;
  gender: "female" | "male";
  accent: string;
  note:   string;
}

export interface TTSProviders {
  providers: {
    openai:     { available: boolean; voices: TTSVoice[] };
    elevenlabs: { available: boolean; voices: TTSVoice[] };
  };
  defaultProvider: "openai" | "elevenlabs" | "browser";
  defaultVoice:    string;
}

export interface TTSPreference {
  provider: "openai" | "elevenlabs" | "browser";
  voiceId:  string;
}

export type TTSState = "idle" | "loading" | "speaking" | "error";

export interface UseRubyTTSApi {
  state:            TTSState;
  enabled:          boolean;
  providers:        TTSProviders | null;
  preference:       TTSPreference | null;
  setPreference:    (p: TTSPreference) => void;
  toggleEnabled:    () => void;
  speak:            (text: string) => void;
  stop:             () => void;
  replay:           () => void;
  lastSpoken:       string | null;
  reloadProviders:  () => void;
  // Phase 22V — mobile autoplay handling. When the browser refuses
  // `audio.play()` (Safari / mobile Chrome require a user gesture for
  // the first audio), we keep the decoded blob URL ready and surface
  // `autoplayBlocked=true` so a "Tap to hear Ruby" banner can call
  // `playPending()` from within a click handler.
  autoplayBlocked:  boolean;
  pendingPreview:   string | null;
  playPending:      () => Promise<void>;
  dismissPending:   () => void;
  // Phase 22V audio-unlock primer. Call this from inside any user
  // gesture handler (panel open, send button, mic press, toggle) to
  // create + warm the persistent `<audio>` element so subsequent
  // `audio.play()` calls won't be refused by mobile browser autoplay
  // policy. Safe to call multiple times — only the first call has
  // effect; subsequent calls are no-ops.
  primeAudio:       () => void;
}

function loadPref(): TTSPreference | null {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) ?? "null"); } catch { return null; }
}
function savePref(p: TTSPreference) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch {}
}
function getEnabled(): boolean {
  try { const v = localStorage.getItem(ENABLED_KEY); return v === null ? true : v === "1"; } catch { return true; }
}
function setEnabledLS(v: boolean) {
  try { localStorage.setItem(ENABLED_KEY, v ? "1" : "0"); } catch {}
}

export function useRubyTTS(): UseRubyTTSApi {
  const [state,     setState]     = useState<TTSState>("idle");
  const [enabled,   setEnabledSt] = useState(getEnabled);
  const [providers, setProviders] = useState<TTSProviders | null>(null);
  const [pref,      setPrefSt]    = useState<TTSPreference | null>(loadPref);

  const providersRef = useRef<TTSProviders | null>(null);
  const prefRef      = useRef<TTSPreference | null>(loadPref());
  const audioRef     = useRef<HTMLAudioElement | null>(null);
  const abortRef     = useRef<AbortController | null>(null);
  const queueRef     = useRef<string[]>([]);
  const busyRef      = useRef(false);
  const enabledRef   = useRef(getEnabled());
  const lastSpokenRef = useRef<string | null>(null);
  const [lastSpoken, setLastSpoken] = useState<string | null>(null);

  // Autoplay-block state: blob URL + the source utterance, plus a flag
  // the UI can render against. `autoplayBlockedReportRef` carries the
  // "last attempt was blocked" signal into the *next* TTS POST so
  // server-side diagnostics can record it.
  const pendingUrlRef = useRef<string | null>(null);
  const autoplayBlockedReportRef = useRef<boolean>(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [pendingPreview,  setPendingPreview]  = useState<string | null>(null);

  // Phase 22V — persistent <audio> element + audio-unlock primer.
  // Mobile Safari / Chrome only allow `audio.play()` from within a user
  // gesture for the very first audio in the session. After that, the
  // SAME audio element can be reused (setting `.src` + `.play()`) and
  // playback works without further gestures. We keep one element across
  // all speak() calls so once the user opens the chat / taps mic / sends
  // a message, Ruby auto-speaks every subsequent response.
  const primedRef = useRef<boolean>(false);
  const primeAudio = useCallback(() => {
    if (primedRef.current) return;
    primedRef.current = true;
    try {
      const audio = audioRef.current ?? new Audio();
      audio.preload = "auto";
      audio.muted = true;
      // 1-frame silent WAV — tiny, always-decodable across browsers.
      audio.src =
        "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
      audioRef.current = audio;
      const p = audio.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
        }).catch(() => { /* fine — the next speak() will retry */ });
      } else {
        audio.muted = false;
      }
    } catch { /* noop — primer is best-effort */ }
  }, []);

  // Keep refs in sync
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Load providers on mount
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/me/assistant/tts/voices", { credentials: "include" });
        if (!r.ok || !alive) return;
        const data = await r.json() as TTSProviders & { ok: boolean };
        if (!data?.ok) return;
        providersRef.current = data;
        setProviders(data);
        // Auto-set preference if none saved
        if (!loadPref() && data.defaultProvider !== "browser") {
          const p: TTSPreference = { provider: data.defaultProvider as "openai" | "elevenlabs", voiceId: data.defaultVoice };
          prefRef.current = p;
          setPrefSt(p);
          savePref(p);
        }
      } catch {}
    };
    load();
    const t = setTimeout(load, 3000); // retry
    return () => { alive = false; clearTimeout(t); };
  }, []);

  const stopAudio = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Phase 22V — preserve the persistent <audio> element across
    // stop/speak cycles so the mobile-Safari autoplay unlock primed by
    // `primeAudio()` survives. Just pause + detach handlers + clear
    // src; DO NOT null audioRef.current (that would destroy the
    // primed element and force every subsequent speak() to create a
    // fresh, un-unlocked Audio instance).
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* noop */ }
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      try { audioRef.current.removeAttribute("src"); audioRef.current.load(); } catch { /* noop */ }
    }
    busyRef.current = false;
    setState("idle");
  }, []);

  const stop = useCallback(() => {
    stopAudio();
    queueRef.current = [];
    try { window.speechSynthesis?.cancel(); } catch {}
  }, [stopAudio]);

  const playNext = useCallback(async () => {
    if (busyRef.current || queueRef.current.length === 0 || !enabledRef.current) return;
    const text = queueRef.current.shift()!;
    if (!text) return;

    // Always re-read the saved preference from LS on each utterance so
    // changes written by the VoicePicker / backend mirror are picked up
    // live without remounting this hook. Falls back to the providers'
    // server-advertised defaults (Bella when ElevenLabs is configured)
    // when no concrete pref is saved or the saved provider is "auto" —
    // which guarantees a brand-new user with a pristine server row still
    // hears Ruby through a real ElevenLabs voice instead of the browser.
    const provs = providersRef.current;
    let currentPref: TTSPreference | null = loadPref();
    const needsDefault =
      !currentPref ||
      !currentPref.voiceId ||
      (currentPref.provider as string) === "auto" ||
      (currentPref.provider !== "browser" &&
        currentPref.provider !== "openai" &&
        currentPref.provider !== "elevenlabs");
    if (needsDefault && provs && provs.defaultProvider !== "browser") {
      currentPref = {
        provider: provs.defaultProvider as "openai" | "elevenlabs",
        voiceId:  provs.defaultVoice,
      };
    }
    prefRef.current = currentPref;
    const useServer = currentPref &&
      currentPref.provider !== "browser" &&
      provs?.providers[currentPref.provider]?.available;

    if (!useServer) {
      // Browser TTS fallback
      if (!("speechSynthesis" in window)) return;
      busyRef.current = true;
      setState("speaking");
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95; u.pitch = 1.05; u.volume = 1.0;
      const saved = getSavedVoiceName();
      if (saved) {
        const v = window.speechSynthesis.getVoices().find((x) => x.name === saved);
        if (v) u.voice = v;
      }
      u.onend  = () => { busyRef.current = false; setState("idle"); void playNext(); };
      u.onerror = () => { busyRef.current = false; setState("idle"); void playNext(); };
      window.speechSynthesis.speak(u);
      return;
    }

    // Server TTS
    busyRef.current = true;
    setState("loading");
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await fetch("/api/me/assistant/tts", {
        method: "POST",
        credentials: "include",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: currentPref!.voiceId,
          provider: currentPref!.provider,
          loadedFromBackend: voicePrefsAreServerBacked(),
          // Tell the server whether the previous TTS attempt in this
          // tab was blocked by the browser's autoplay policy. Used by
          // admin diagnostics only; never affects gating.
          autoplayBlocked: autoplayBlockedReportRef.current,
        }),
      });

      if (!resp.ok) throw new Error(`TTS ${resp.status}`);
      const blob  = await resp.blob();
      const url   = URL.createObjectURL(blob);
      // Reuse the persistent <audio> element when it has been primed.
      // This is the key to mobile autoplay: a single user gesture
      // unlocks THIS element forever, so subsequent `.src=` + `.play()`
      // on the SAME element succeed without further gestures.
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      try { audio.pause(); } catch { /* noop */ }
      audio.src = url;
      audio.muted = false;
      setState("speaking");
      audio.onended = () => { URL.revokeObjectURL(url); busyRef.current = false; setState("idle"); void playNext(); };
      audio.onerror = () => { URL.revokeObjectURL(url); busyRef.current = false; setState("idle"); void playNext(); };
      try {
        await audio.play();
        // Successful play — clear any prior "blocked" report so the
        // next TTS POST doesn't keep claiming autoplay was blocked.
        autoplayBlockedReportRef.current = false;
      } catch (playErr) {
        // Mobile Safari / Chrome refuse audio.play() without a user
        // gesture. Stash the blob URL and surface a banner so the UI
        // can replay it from within a click handler.
        const name = (playErr as { name?: string } | null)?.name ?? "";
        if (name === "NotAllowedError" || name === "AbortError") {
          // Keep the audio element + url for playPending() to reuse.
          if (pendingUrlRef.current) {
            try { URL.revokeObjectURL(pendingUrlRef.current); } catch { /* noop */ }
          }
          pendingUrlRef.current = url;
          autoplayBlockedReportRef.current = true;
          setAutoplayBlocked(true);
          setPendingPreview(text.length > 80 ? text.slice(0, 77) + "…" : text);
          busyRef.current = false;
          setState("idle");
          return;
        }
        throw playErr;
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        // Server TTS failed — fall back to browser speech for this utterance
        // so Ruby still speaks even if ElevenLabs/OpenAI is unreachable.
        busyRef.current = false;
        if ("speechSynthesis" in window) {
          busyRef.current = true;
          setState("speaking");
          const u = new SpeechSynthesisUtterance(text);
          u.rate = 0.95; u.pitch = 1.05; u.volume = 1.0;
          const saved = getSavedVoiceName();
          if (saved) {
            const v = window.speechSynthesis.getVoices().find((x) => x.name === saved);
            if (v) u.voice = v;
          }
          u.onend  = () => { busyRef.current = false; setState("idle"); void playNext(); };
          u.onerror = () => { busyRef.current = false; setState("idle"); void playNext(); };
          window.speechSynthesis.speak(u);
        } else {
          setState("idle");
          void playNext();
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const speak = useCallback((text: string) => {
    if (!enabledRef.current) return;
    const clean = sanitizeForSpeech(text);
    if (!clean) return;
    // Stop any in-flight audio AND browser speech so Ruby never overlaps herself.
    stopAudio();
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    queueRef.current = [clean];
    lastSpokenRef.current = clean;
    setLastSpoken(clean);
    void playNext();
  }, [playNext, stopAudio]);

  const replay = useCallback(() => {
    const text = lastSpokenRef.current;
    if (!text) return;
    stopAudio();
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    queueRef.current = [text];
    void playNext();
  }, [playNext, stopAudio]);

  const toggleEnabled = useCallback(() => {
    const next = !enabledRef.current;
    enabledRef.current = next;
    setEnabledSt(next);
    setEnabledLS(next);
    if (!next) stop();
  }, [stop]);

  const setPreference = useCallback((p: TTSPreference) => {
    prefRef.current = p;
    setPrefSt(p);
    savePref(p);
    saveVoiceName(p.voiceId);
  }, []);

  const playPending = useCallback(async () => {
    const url = pendingUrlRef.current;
    if (!url) { setAutoplayBlocked(false); setPendingPreview(null); return; }
    try {
      // Phase 22V — REUSE the persistent <audio> element here. Tapping
      // "Play" is itself a user gesture that unlocks audio on iOS, so
      // mark primedRef so subsequent speak() calls reuse the same
      // (now-unlocked) element instead of creating a fresh one.
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      try { audio.pause(); } catch { /* noop */ }
      audio.src = url;
      audio.muted = false;
      primedRef.current = true;
      setState("speaking");
      audio.onended = () => {
        URL.revokeObjectURL(url);
        pendingUrlRef.current = null;
        busyRef.current = false;
        setAutoplayBlocked(false);
        setPendingPreview(null);
        autoplayBlockedReportRef.current = false;
        setState("idle");
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        pendingUrlRef.current = null;
        busyRef.current = false;
        setAutoplayBlocked(false);
        setPendingPreview(null);
        setState("idle");
      };
      await audio.play();
    } catch {
      try { URL.revokeObjectURL(url); } catch { /* noop */ }
      pendingUrlRef.current = null;
      setAutoplayBlocked(false);
      setPendingPreview(null);
      setState("idle");
    }
  }, []);

  const dismissPending = useCallback(() => {
    const url = pendingUrlRef.current;
    if (url) { try { URL.revokeObjectURL(url); } catch { /* noop */ } }
    pendingUrlRef.current = null;
    setAutoplayBlocked(false);
    setPendingPreview(null);
  }, []);

  const reloadProviders = useCallback(() => {
    fetch("/api/me/assistant/tts/voices", { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.ok) return;
        providersRef.current = data;
        setProviders(data);
        if (!loadPref() && data.defaultProvider !== "browser") {
          const p: TTSPreference = { provider: data.defaultProvider as "openai"|"elevenlabs", voiceId: data.defaultVoice };
          prefRef.current = p; setPrefSt(p); savePref(p);
        }
      }).catch(() => {});
  }, []);

  return {
    state, enabled, providers,
    preference: pref, setPreference, toggleEnabled,
    speak, stop, replay,
    lastSpoken, reloadProviders,
    autoplayBlocked, pendingPreview, playPending, dismissPending,
    primeAudio,
  };
}

// ── Standalone preview function (used by VoicePicker) ─────────────────────────
export async function previewVoice(voiceId: string, provider: "openai" | "elevenlabs" | "browser", name: string = DEFAULT_ASSISTANT_NAME): Promise<void> {
  if (provider === "browser") {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(`Hey, I'm ${name}. How can I help you trade today?`);
    u.rate = 0.95; u.pitch = 1.05;
    const v = window.speechSynthesis.getVoices().find((x) => x.name === voiceId);
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
    return;
  }
  try {
    const resp = await fetch("/api/me/assistant/tts", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Hey there, I'm ${name}. How can I help you trade today?`,
        voice: voiceId,
        provider,
      }),
    });
    if (!resp.ok) return;
    const blob  = await resp.blob();
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.onerror = () => URL.revokeObjectURL(url);
    await audio.play();
  } catch {}
}
