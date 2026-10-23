// Phase 22G — Browser speechSynthesis hook for typed-chat replies.
//
// SAFETY:
// - Disabled by default. Only speaks when user toggles "Speak responses" on.
// - Never auto-starts; only invoked via speak() after the user opted in.
// - Stops immediately on stop(), on user toggle off, on panel close, on
//   user typing the next message, and on unmount.
// - Sanitizes text before speaking: strips URLs, code blocks, raw bridge
//   tokens, hash-shaped strings, and anything that looks like a secret.
// - When the browser does not support SpeechSynthesis, supported=false and
//   speak() is a no-op (UI surfaces an honest "Speech not supported" state).
// - Preference persisted to localStorage (per-browser, not per-user — UI is
//   already auth-gated and localStorage is browser-scoped).

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "arx.assistant.speakResponses.v1";

export type SpeakState = "idle" | "speaking" | "unsupported";

export interface UseSpeakResponsesApi {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  supported: boolean;
  state: SpeakState;
  speak: (text: string) => void;
  stop: () => void;
  // ── Streaming speech (read aloud while Ruby types) ────────────────────
  // Begin a fresh streaming utterance for a new turn. Clears any queued
  // sentences and resets the consumed-text pointer.
  speakStreamReset: () => void;
  // Feed the full assistant text accumulated SO FAR. Newly *completed*
  // sentences (those ending in . ! ? or a newline) are queued and spoken
  // in order; the trailing partial sentence is held until the next push
  // or flush. Idempotent w.r.t. already-spoken text.
  speakStreamPush: (fullTextSoFar: string) => void;
  // Speak any remaining trailing text (the final partial sentence) once the
  // stream is complete.
  speakStreamFlush: (fullText: string) => void;
  // Cancel any not-yet-spoken queued sentences and rewind the pointer to
  // newLength. Used when the server retracts streamed preamble that turned
  // into a tool call, so we never read aloud text the user never sees.
  speakStreamRetract: (newLength: number) => void;
}

// Extract complete sentences from `rest`, the not-yet-consumed tail of the
// streamed text. A sentence is complete when it ends in ., !, ? (optionally
// repeated) followed by whitespace, or at a newline. A trailing fragment with
// no terminator is left unconsumed so it isn't spoken mid-word. Returns the
// completed sentence segments (raw, pre-sanitize) and how many chars of `rest`
// were consumed.
export function extractCompleteSentences(rest: string): { sentences: string[]; consumed: number } {
  const sentences: string[] = [];
  let start = 0;
  let consumed = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "." || c === "!" || c === "?") {
      let j = i;
      while (j + 1 < rest.length && (rest[j + 1] === "." || rest[j + 1] === "!" || rest[j + 1] === "?")) j++;
      const next = rest[j + 1];
      // Boundary only when an actual whitespace char follows the terminator.
      // (next === undefined = end of current buffer → could be "1." of "1.5",
      // so leave it for a later push/flush.)
      if (next !== undefined && /\s/.test(next)) {
        let k = j + 1;
        while (k < rest.length && /\s/.test(rest[k])) k++;
        sentences.push(rest.slice(start, k));
        start = k; consumed = k; i = k - 1;
      }
    } else if (c === "\n") {
      let k = i;
      while (k < rest.length && rest[k] === "\n") k++;
      sentences.push(rest.slice(start, k));
      start = k; consumed = k; i = k - 1;
    }
  }
  return { sentences, consumed };
}

// Sanitize text before sending to the TTS engine. Defense-in-depth:
// Phase 22F tools never return secrets, but we additionally strip anything
// that looks like a token / hash / URL / code so it is not spoken aloud.
export function sanitizeForSpeech(input: string): string {
  if (!input) return "";
  let s = input;
  // Strip fenced code blocks entirely
  s = s.replace(/```[\s\S]*?```/g, " ");
  // Strip inline code
  s = s.replace(/`[^`]*`/g, " ");
  // Strip URLs
  s = s.replace(/https?:\/\/\S+/gi, " ");
  // Strip markdown headers
  s = s.replace(/^#{1,6}\s+/gm, " ");
  // Strip bold/italic markers **text** *text* __text__ _text_
  s = s.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  s = s.replace(/_{1,3}([^_]+)_{1,3}/g, "$1");
  // Strip bullet points and numbered lists
  s = s.replace(/^\s*[-*•]\s+/gm, " ");
  s = s.replace(/^\s*\d+\.\s+/gm, " ");
  // Strip blockquotes
  s = s.replace(/^>\s+/gm, " ");
  // Strip horizontal rules
  s = s.replace(/^[-*_]{3,}$/gm, " ");
  // Strip table pipes
  s = s.replace(/\|/g, " ");
  // Strip parenthetical references like (1), [2], (source)
  s = s.replace(/\(\d+\)/g, " ");
  s = s.replace(/\[\d+\]/g, " ");
  // Strip redacted secrets
  s = s.replace(/\b[A-Za-z0-9+/_-]{24,}\b/g, " ");
  s = s.replace(/\b(?:api[_-]?key|token|secret|password|hash|bearer)\s*[:=]\s*\S+/gi, " ");
  // Strip leftover punctuation clusters (---, ..., etc)
  s = s.replace(/\.{2,}/g, ". ");
  s = s.replace(/-{2,}/g, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  // Cap length
  if (s.length > 1200) s = s.slice(0, 1200) + ".";
  return s;
}

// ── Voice preference storage ────────────────────────────────────────────────
const VOICE_PREF_KEY = "arx.assistant.voiceName.v1";

export function getSavedVoiceName(): string | null {
  try { return localStorage.getItem(VOICE_PREF_KEY); } catch { return null; }
}
export function saveVoiceName(name: string) {
  try { localStorage.setItem(VOICE_PREF_KEY, name); } catch { /* noop */ }
}

// ── Server voice preference (ElevenLabs / OpenAI) ─────────────────────────
const SERVER_VOICE_KEY = "arx.tts.server.v1";

export interface ServerVoicePref {
  provider: "elevenlabs" | "openai";
  voiceId:  string;
}

export function getServerVoicePref(): ServerVoicePref | null {
  try {
    const v = localStorage.getItem(SERVER_VOICE_KEY);
    return v ? JSON.parse(v) as ServerVoicePref : null;
  } catch { return null; }
}

export function saveServerVoicePref(p: ServerVoicePref | null) {
  try {
    if (p) localStorage.setItem(SERVER_VOICE_KEY, JSON.stringify(p));
    else localStorage.removeItem(SERVER_VOICE_KEY);
  } catch { /* noop */ }
}

export function pickVoice(voices: SpeechSynthesisVoice[], savedName: string | null): SpeechSynthesisVoice | null {
  // Honour saved preference first
  if (savedName) {
    const saved = voices.find((v) => v.name === savedName);
    if (saved) return saved;
  }
  // Default: best soft female voice
  const preferred = [
    // Best natural US female (Chrome/Edge)
    "Microsoft Aria Online (Natural) - English (United States)",
    "Microsoft Jenny Online (Natural) - English (United States)",
    "Microsoft Sara Online (Natural) - English (United States)",
    // Best natural UK female
    "Microsoft Sonia Online (Natural) - English (United Kingdom)",
    // macOS enhanced/premium voices
    "Ava (Enhanced)",
    "Samantha (Enhanced)",
    "Karen (Enhanced)",
    "Moira (Enhanced)",
    // Fallback macOS standard (still natural enough)
    "Ava",
    "Samantha",
    "Karen",
    "Moira",
    // Google natural
    "Google US English Female",
    "Google UK English Female",
  ];
  for (const name of preferred) {
    const v = voices.find((x) => x.name === name);
    if (v) return v;
  }
  // Fallback: any English female
  return voices.find((v) => /female|woman/i.test(v.name) && /en/i.test(v.lang))
    ?? voices.find((v) => /en[-_]/i.test(v.lang))
    ?? null;
}

// Returns all available voices grouped by gender hint for the picker UI
export function getAvailableVoices(): Array<{ name: string; lang: string; genderHint: "female" | "male" | "unknown" }> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices()
    .filter((v) => {
      if (!/^en/i.test(v.lang)) return false;
      const n = v.name;
      // Keep only natural/neural/premium voices — exclude robotic TTS engines
      const isRobotic =
        /^en(?:glish)?$/i.test(n) ||           // bare "English" — always robotic
        /compact/i.test(n) ||               // macOS compact = robotic
        /premium/i.test(n) === false &&     // non-premium macOS
        /samantha|karen|moira|fiona|daniel|alex|victoria|fred|bruce|lee|tom(?:\s|$)|nora|tessa|rishi|veena|kanya/i.test(n) === false &&
        /natural|neural|online|enhanced|premium|wavenet|standard/i.test(n) === false &&
        /google|microsoft/i.test(n) === false;
      return !isRobotic;
    })
    .map((v) => {
      const lang = v.lang.toLowerCase();
      const accent =
        lang.includes("au") ? "Australian" :
        lang.includes("in") ? "Indian" :
        lang.includes("ie") ? "Irish" :
        lang.includes("za") ? "South African" :
        lang.includes("ca") ? "Canadian" :
        lang.includes("nz") ? "New Zealand" :
        lang.includes("gb") || lang.includes("uk") || /sonia|moira|daniel(?!.*us)|george(?!.*us)/i.test(v.name) ? "British" :
        /karen|fiona/i.test(v.name) ? "Australian / Scottish" :
        "American";
      const genderHint: "female" | "male" | "unknown" =
        /female|woman|girl|sonia|jenny|aria|sara|samantha|karen|moira|zira|hazel|susan|victoria|allison|ava|fiona|nicky|tessa|emma|emily|hannah|lisa|jessica|natasha|nicole|amy|catherine|claire/i.test(v.name)
          ? "female"
          : /male|man|guy|david|mark|daniel|alex|ryan|tom|george|james|oliver|liam|noah|bruce|fred|rishi|aaron|eric|junior|reed/i.test(v.name)
          ? "male"
          : "unknown";
      return { name: v.name, lang: v.lang, genderHint, accent };
    })
    .sort((a, b) => a.genderHint.localeCompare(b.genderHint) || a.accent.localeCompare(b.accent) || a.name.localeCompare(b.name));
}

// Standalone browser TTS — avoids stale closure issues
function doSpeakBrowser(clean: string, setStateFn: (s: SpeakState) => void): void {
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new window.SpeechSynthesisUtterance(clean);
    u.rate = 0.95; u.pitch = 1.05; u.volume = 1.0;
    u.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    try {
      const voices = window.speechSynthesis.getVoices();
      const picked = pickVoice(voices, getSavedVoiceName());
      if (picked) u.voice = picked;
    } catch {}
    u.onend  = () => setStateFn("idle");
    u.onerror = () => setStateFn("idle");
    setStateFn("speaking");
    window.speechSynthesis.speak(u);
  } catch { setStateFn("idle"); }
}

export function useSpeakResponses(): UseSpeakResponsesApi {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";

  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return true;
    // Default ON unless user has explicitly muted (stored "0")
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === "1";
  });
  const [state, setState] = useState<SpeakState>(supported ? "idle" : "unsupported");

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  // Server-TTS audio element currently playing, plus a monotonically increasing
  // generation id. Every speak() bumps the generation; any audio whose gen is
  // not the latest is stale and must not play (prevents two messages speaking
  // over each other / a slow older clip arriving late).
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const genRef = useRef(0);
  const stopAudio = () => {
    if (audioRef.current) {
      try { audioRef.current.pause(); audioRef.current.src = ""; } catch { /* noop */ }
      audioRef.current = null;
    }
  };
  // Phase 22S — iOS Safari watchdog. Mobile Safari frequently fails to fire
  // SpeechSynthesisUtterance.onend, leaving the UI stuck on "Speaking" and
  // (because autoListenPause watches tts.state) keeping the mic paused
  // forever. We estimate the spoken duration from the text length and force
  // a state reset if onend never arrives.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearWatchdog = () => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  };

  // ── Streaming speech state ────────────────────────────────────────────
  // Pointer into the raw streamed text marking how much has already been
  // queued for speech; the FIFO queue of sanitized sentences awaiting
  // playback; and a flag indicating a sentence is currently playing.
  const streamPtrRef = useRef(0);
  const streamQueueRef = useRef<string[]>([]);
  const streamPlayingRef = useRef(false);
  const streamLeadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamStartedRef = useRef(false);
  const clearStreamLeadTimer = () => {
    if (streamLeadTimerRef.current) { clearTimeout(streamLeadTimerRef.current); streamLeadTimerRef.current = null; }
  };
  const resetStreamRefs = () => {
    clearStreamLeadTimer();
    streamPtrRef.current = 0;
    streamQueueRef.current = [];
    streamPlayingRef.current = false;
    streamStartedRef.current = false;
  };

  const stop = useCallback(() => {
    genRef.current += 1; // invalidate any in-flight server-TTS fetch/audio
    stopAudio();
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* noop */
    }
    clearWatchdog();
    resetStreamRefs();
    utteranceRef.current = null;
    setState("idle");
  }, [supported]);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    if (typeof localStorage !== "undefined") {
      try { localStorage.setItem(STORAGE_KEY, v ? "1" : "0"); } catch { /* noop */ }
    }
    if (!v) {
      // Toggling off must immediately silence anything in flight and clear
      // the watchdog so it can't fire later and stomp a fresh utterance.
      try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
      stopAudio();
      clearWatchdog();
      resetStreamRefs();
      utteranceRef.current = null;
      setState(supported ? "idle" : "unsupported");
    }
  }, [supported]);

  const speak = useCallback((text: string) => {
    if (!supported || !enabled) return;
    const clean = sanitizeForSpeech(text);
    if (!clean) return;

    // New message → invalidate anything older and silence it immediately so a
    // newer reply never plays over (or behind) a stale one.
    const myGen = ++genRef.current;
    stopAudio();
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    clearWatchdog();

    // Try server TTS — read pref fresh every call (no closure capture)
    const serverPref = getServerVoicePref();
    if (serverPref?.voiceId && serverPref?.provider) {
      setState("speaking");
      void (async () => {
        try {
          const r = await fetch("/api/me/assistant/tts", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: clean, voice: serverPref.voiceId, provider: serverPref.provider }),
          });
          // If a newer message started while we were fetching, drop this clip.
          if (myGen !== genRef.current) return;
          if (!r.ok) throw new Error("tts_failed");
          const blob  = await r.blob();
          const url   = URL.createObjectURL(blob);
          // Re-check after the await — fetch+blob can outlast a newer speak().
          if (myGen !== genRef.current) { URL.revokeObjectURL(url); return; }
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => { URL.revokeObjectURL(url); if (myGen === genRef.current) { audioRef.current = null; setState("idle"); } };
          audio.onerror = () => { URL.revokeObjectURL(url); if (myGen === genRef.current) { audioRef.current = null; setState("idle"); } };
          await audio.play();
          return;
        } catch {
          if (myGen !== genRef.current) return;
          setState("idle");
          doSpeakBrowser(clean, setState);
        }
      })();
      return;
    }

    doSpeakBrowser(clean, setState);
  }, [supported, enabled, setState]);

  const speakBrowser = useCallback((clean: string) => { doSpeakBrowser(clean, setState); }, [setState]);

  // ── Streaming speech: play one queued sentence, then pump the next ───────
  // Plays a single sanitized sentence via server TTS (with browser fallback)
  // or browser speechSynthesis, calling onDone exactly once when finished so
  // the queue advances without overlapping audio.
  const playStreamSentence = useCallback((clean: string, myGen: number, onDone: () => void) => {
    let finished = false;
    const finish = () => { if (finished) return; finished = true; onDone(); };

    const serverPref = getServerVoicePref();
    if (serverPref?.voiceId && serverPref?.provider) {
      void (async () => {
        try {
          const r = await fetch("/api/me/assistant/tts", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: clean, voice: serverPref.voiceId, provider: serverPref.provider }),
          });
          if (myGen !== genRef.current) return; // newer turn started
          if (!r.ok) throw new Error("tts_failed");
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          if (myGen !== genRef.current) { URL.revokeObjectURL(url); return; }
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => { URL.revokeObjectURL(url); if (myGen === genRef.current) { audioRef.current = null; finish(); } };
          audio.onerror = () => { URL.revokeObjectURL(url); if (myGen === genRef.current) { audioRef.current = null; finish(); } };
          await audio.play();
        } catch {
          if (myGen !== genRef.current) return;
          // Fall back to browser speech for this sentence.
          try {
            window.speechSynthesis.cancel();
            const u = new window.SpeechSynthesisUtterance(clean);
            u.rate = 0.95; u.pitch = 1.05; u.volume = 1.0;
            u.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
            try { const picked = pickVoice(window.speechSynthesis.getVoices(), getSavedVoiceName()); if (picked) u.voice = picked; } catch { /* noop */ }
            u.onend = () => { if (myGen === genRef.current) finish(); };
            u.onerror = () => { if (myGen === genRef.current) finish(); };
            window.speechSynthesis.speak(u);
          } catch { finish(); }
        }
      })();
      return;
    }

    // Browser speechSynthesis path
    try {
      const u = new window.SpeechSynthesisUtterance(clean);
      u.rate = 0.95; u.pitch = 1.05; u.volume = 1.0;
      u.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
      try { const picked = pickVoice(window.speechSynthesis.getVoices(), getSavedVoiceName()); if (picked) u.voice = picked; } catch { /* noop */ }
      u.onend = () => { if (myGen === genRef.current) finish(); };
      u.onerror = () => { if (myGen === genRef.current) finish(); };
      window.speechSynthesis.speak(u);
      // iOS Safari sometimes never fires onend; estimate duration and force-finish.
      const estMs = Math.min(60_000, Math.max(1_500, Math.ceil(clean.length / 14) * 1000 + 1_500));
      setTimeout(() => { if (myGen === genRef.current) finish(); }, estMs);
    } catch { finish(); }
  }, []);

  // Drain the sentence queue one item at a time. A short lead delay before the
  // very first sentence of a turn gives the server a window to retract streamed
  // preamble (preamble→tool-call) before it is ever spoken aloud.
  const pumpStream = useCallback((myGen: number) => {
    if (myGen !== genRef.current) return;
    if (streamPlayingRef.current) return;
    if (streamQueueRef.current.length === 0) { if (streamStartedRef.current) setState("idle"); return; }

    const start = () => {
      if (myGen !== genRef.current) return;
      const next = streamQueueRef.current.shift();
      if (next === undefined) return;
      streamPlayingRef.current = true;
      streamStartedRef.current = true;
      setState("speaking");
      playStreamSentence(next, myGen, () => {
        streamPlayingRef.current = false;
        if (myGen !== genRef.current) return;
        pumpStream(myGen);
      });
    };

    if (!streamStartedRef.current) {
      clearStreamLeadTimer();
      streamLeadTimerRef.current = setTimeout(() => { streamLeadTimerRef.current = null; start(); }, 300);
    } else {
      start();
    }
  }, [playStreamSentence, setState]);

  const speakStreamReset = useCallback(() => {
    if (!supported || !enabled) return;
    // New turn → invalidate older audio/utterances and clear the queue.
    genRef.current += 1;
    stopAudio();
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    clearWatchdog();
    resetStreamRefs();
  }, [supported, enabled]);

  const speakStreamPush = useCallback((fullTextSoFar: string) => {
    if (!supported || !enabled) return;
    const myGen = genRef.current;
    const rest = fullTextSoFar.slice(streamPtrRef.current);
    if (!rest) return;
    const { sentences, consumed } = extractCompleteSentences(rest);
    if (consumed > 0) streamPtrRef.current += consumed;
    for (const seg of sentences) {
      const clean = sanitizeForSpeech(seg);
      if (clean) streamQueueRef.current.push(clean);
    }
    if (streamQueueRef.current.length > 0) pumpStream(myGen);
  }, [supported, enabled, pumpStream]);

  const speakStreamFlush = useCallback((fullText: string) => {
    if (!supported || !enabled) return;
    const myGen = genRef.current;
    const rest = fullText.slice(streamPtrRef.current);
    if (rest.trim()) {
      const clean = sanitizeForSpeech(rest);
      if (clean) streamQueueRef.current.push(clean);
    }
    streamPtrRef.current = fullText.length;
    if (streamQueueRef.current.length > 0) pumpStream(myGen);
  }, [supported, enabled, pumpStream]);

  const speakStreamRetract = useCallback((newLength: number) => {
    // Server retracted streamed preamble. Drop anything still queued and any
    // pending lead-delay, and rewind the pointer so the remaining text streams
    // cleanly. Already-playing audio (rare within the 300ms lead) is left to
    // finish; the queue won't re-speak the retracted span.
    clearStreamLeadTimer();
    streamQueueRef.current = [];
    if (newLength < streamPtrRef.current) streamPtrRef.current = Math.max(0, newLength);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const _speakBrowserInternal = useCallback((clean: string) => {
    try {
      // Cancel any prior utterance so we never overlap.
      window.speechSynthesis.cancel();
      const u = new window.SpeechSynthesisUtterance(clean);
      u.rate = 0.95;   // slightly slower = warmer, more natural
      u.pitch = 1.05;  // slightly higher = softer female tone
      u.volume = 1.0;
      u.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
      // Use saved voice preference or best default
      try {
        const voices = window.speechSynthesis.getVoices();
        const saved = getSavedVoiceName();
        const picked = pickVoice(voices, saved);
        if (picked) u.voice = picked;
      } catch { /* noop — use browser default */ }
      u.onend = () => {
        if (utteranceRef.current === u) {
          clearWatchdog();
          utteranceRef.current = null;
          setState("idle");
        }
      };
      u.onerror = () => {
        if (utteranceRef.current === u) {
          clearWatchdog();
          utteranceRef.current = null;
          setState("idle");
        }
      };
      utteranceRef.current = u;
      setState("speaking");
      window.speechSynthesis.speak(u);
      // Phase 22S — watchdog. Estimate ~14 chars/sec at default rate, add a
      // 4s grace period and a 90s ceiling. If onend never fires (common on
      // iOS Safari, especially after backgrounding), force the state back
      // to idle so autoListen can resume the mic.
      clearWatchdog();
      const estMs = Math.min(90_000, Math.max(2_500, Math.ceil(clean.length / 14) * 1000 + 4_000));
      watchdogRef.current = setTimeout(() => {
        if (utteranceRef.current === u) {
          try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
          utteranceRef.current = null;
          setState("idle");
        }
        watchdogRef.current = null;
      }, estMs);
    } catch {
      utteranceRef.current = null;
      setState("idle");
    }
  }, [enabled, supported]);

  // Cleanup on unmount: never let TTS outlive the component.
  useEffect(() => () => {
    clearWatchdog();
    clearStreamLeadTimer();
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
  }, []);

  return {
    enabled, setEnabled, supported, state, speak, stop,
    speakStreamReset, speakStreamPush, speakStreamFlush, speakStreamRetract,
  };
}
