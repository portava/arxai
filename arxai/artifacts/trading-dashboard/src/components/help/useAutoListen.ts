// Phase 22E — ARX AI auto-listen with browser-side voice activity detection.
//
// Wraps Web Audio API (AnalyserNode RMS) + MediaRecorder so the assistant can
// passively wait for the user to start speaking, record only the utterance,
// and stop automatically on silence — without any wake word and without
// holding the mic open in the background.
//
// Privacy invariants (enforced by the panel that owns this hook):
//   1. The hook only acquires the microphone when `active` becomes true.
//   2. The owner sets `active=false` whenever the popup is closed, so the
//      MediaStream tracks are stopped immediately.
//   3. While the AI is speaking, the owner sets `pause=true` so we never
//      record the AI's own voice (no feedback loop, no double-charging).
//   4. Permission is never re-requested on a tight loop — `onPermission`
//      surfaces "denied" once and the hook stays inert until reset.

import { useCallback, useEffect, useRef, useState } from "react";

export type AutoListenState =
  | "idle"
  | "calibrating"
  | "listening"
  | "hearing_speech"
  | "processing"
  | "paused"
  | "error";

export type MicPermission = "unknown" | "granted" | "denied";

export interface UseAutoListenArgs {
  /** Master switch — true only when popup is open + user enabled auto-listen. */
  active: boolean;
  /** True while AI is talking back; suspends the loop and drops in-flight clips. */
  pause: boolean;
  /** Receives a finished utterance for upload. */
  onClip: (blob: Blob) => Promise<void> | void;
  /** Called whenever the high-level state changes. */
  onState?: (s: AutoListenState) => void;
  /** Called with a friendly error message. */
  onError?: (msg: string) => void;
  /** Called whenever microphone permission status is observed. */
  onPermission?: (p: MicPermission) => void;
}

// VAD tuning. Conservative numbers that work across desktop + mobile mics.
const CALIBRATION_MS = 700;        // initial room-noise sample window
const SPEECH_TRIGGER_MS = 280;     // sustained loudness needed to start a clip
const SILENCE_HANGOVER_MS = 1100;  // sustained quiet needed to end a clip
const MAX_CLIP_MS = 15_000;        // hard cap per utterance
const MIN_CLIP_MS = 400;           // discard anything shorter (taps, pops)
// Threshold = max(noiseFloor * THRESH_RATIO, ABSOLUTE_FLOOR). Keeps a quiet
// room from triggering on background hiss while still catching whispers in a
// noisier room.
const THRESH_RATIO = 1.9;
const ABSOLUTE_FLOOR = 0.012;
const SILENCE_RATIO = 0.65;        // hysteresis: must drop further to "quiet"

export interface UseAutoListenResult {
  state: AutoListenState;
  micPermission: MicPermission;
  /** Request mic access on an explicit user gesture (one-shot prompt). */
  requestPermission: () => Promise<MicPermission>;
}

export function useAutoListen(args: UseAutoListenArgs): UseAutoListenResult {
  const { active, pause, onClip, onState, onError, onPermission } = args;
  const [state, setStateRaw] = useState<AutoListenState>("idle");
  const [micPermission, setMicPermissionRaw] = useState<MicPermission>("unknown");

  // Latch refs so the rAF loop reads the latest values without re-arming.
  const stateRef = useRef<AutoListenState>("idle");
  const pauseRef = useRef(pause);
  const activeRef = useRef(active);
  useEffect(() => { pauseRef.current = pause; }, [pause]);
  useEffect(() => { activeRef.current = active; }, [active]);

  const setState = useCallback((s: AutoListenState) => {
    if (stateRef.current === s) return;
    stateRef.current = s;
    setStateRaw(s);
    onState?.(s);
  }, [onState]);

  const setMicPermission = useCallback((p: MicPermission) => {
    setMicPermissionRaw((cur) => (cur === p ? cur : p));
    onPermission?.(p);
  }, [onPermission]);

  // Resources we own. Cleared on teardown.
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const recordStartRef = useRef<number>(0);
  const speechStartRef = useRef<number>(0);
  const silenceStartRef = useRef<number>(0);
  const calibrationStartRef = useRef<number>(0);
  const noiseFloorRef = useRef<number>(0);
  const noiseSamplesRef = useRef<number[]>([]);
  const isRecordingRef = useRef(false);
  const maxClipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teardown = useCallback(() => {
    if (rafRef.current != null) {
      try { cancelAnimationFrame(rafRef.current); } catch { /* noop */ }
      rafRef.current = null;
    }
    if (maxClipTimerRef.current) {
      clearTimeout(maxClipTimerRef.current);
      maxClipTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try { recorderRef.current.stop(); } catch { /* noop */ }
    }
    recorderRef.current = null;
    recorderChunksRef.current = [];
    isRecordingRef.current = false;
    if (sourceRef.current) {
      try { sourceRef.current.disconnect(); } catch { /* noop */ }
      sourceRef.current = null;
    }
    if (analyserRef.current) {
      try { analyserRef.current.disconnect(); } catch { /* noop */ }
      analyserRef.current = null;
    }
    if (audioCtxRef.current) {
      try { void audioCtxRef.current.close(); } catch { /* noop */ }
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      streamRef.current = null;
    }
  }, []);

  const pickMimeType = useCallback((): string | undefined => {
    if (typeof MediaRecorder === "undefined") return undefined;
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
    ];
    for (const c of candidates) {
      try { if (MediaRecorder.isTypeSupported(c)) return c; } catch { /* noop */ }
    }
    return undefined;
  }, []);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    if (recorderRef.current && recorderRef.current.state !== "inactive") return;
    let recorder: MediaRecorder;
    try {
      const mimeType = pickMimeType();
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      onError?.("Voice capture is not supported in this browser.");
      setState("error");
      return;
    }
    recorderChunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recorderChunksRef.current.push(e.data); };
    recorder.onstop = () => {
      const chunks = recorderChunksRef.current;
      recorderChunksRef.current = [];
      const elapsed = Date.now() - recordStartRef.current;
      isRecordingRef.current = false;
      if (maxClipTimerRef.current) { clearTimeout(maxClipTimerRef.current); maxClipTimerRef.current = null; }
      // Drop clips that are too short OR were aborted while paused.
      if (elapsed < MIN_CLIP_MS || pauseRef.current || !activeRef.current) {
        if (activeRef.current && !pauseRef.current) setState("listening");
        return;
      }
      const type = chunks[0]?.type || recorder.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      if (blob.size === 0) {
        setState("listening");
        return;
      }
      setState("processing");
      Promise.resolve(onClip(blob))
        .catch((err) => onError?.(err instanceof Error ? err.message : String(err)))
        .finally(() => {
          // After the upload returns the panel will likely flip pause=true
          // (AI speaking). Don't override that here.
          if (activeRef.current && !pauseRef.current && stateRef.current !== "hearing_speech") {
            setState("listening");
          }
        });
    };
    try { recorder.start(250); } catch {
      onError?.("Voice capture failed to start.");
      setState("error");
      return;
    }
    recorderRef.current = recorder;
    recordStartRef.current = Date.now();
    isRecordingRef.current = true;
    if (maxClipTimerRef.current) clearTimeout(maxClipTimerRef.current);
    maxClipTimerRef.current = setTimeout(() => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try { recorderRef.current.stop(); } catch { /* noop */ }
      }
    }, MAX_CLIP_MS);
  }, [onClip, onError, pickMimeType, setState]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try { recorderRef.current.stop(); } catch { /* noop */ }
    }
  }, []);

  const startEngine = useCallback(async (existingStream?: MediaStream): Promise<void> => {
    if (audioCtxRef.current) return; // already running
    let stream = existingStream;
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        setMicPermission("granted");
      } catch {
        setMicPermission("denied");
        onError?.("Microphone access is blocked. Enable it in your browser settings.");
        setState("error");
        return;
      }
    }
    streamRef.current = stream;
    const Ctx: typeof AudioContext | undefined =
      typeof window !== "undefined"
        ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctx) {
      onError?.("Voice mode is not supported in this browser.");
      setState("error");
      return;
    }
    const ctx = new Ctx();
    // iOS Safari quirk: AudioContext is created in "suspended" state and
    // must be resumed inside the user-gesture chain that led here
    // (requestPermission → getUserMedia → startEngine). Without this,
    // getFloatTimeDomainData returns silence forever and VAD never triggers,
    // so the panel shows "Listening…" but no clip is ever recorded.
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* noop — fallback handled below */ }
    }
    if (ctx.state === "suspended") {
      onError?.("Voice mode could not start audio playback. Tap the mic button to retry.");
      try { void ctx.close(); } catch { /* noop */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      streamRef.current = null;
      setState("error");
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    audioCtxRef.current = ctx;
    sourceRef.current = source;
    analyserRef.current = analyser;

    calibrationStartRef.current = Date.now();
    noiseFloorRef.current = 0;
    noiseSamplesRef.current = [];
    speechStartRef.current = 0;
    silenceStartRef.current = 0;
    setState("calibrating");

    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      const a = analyserRef.current;
      if (!a) return;
      // Compute RMS of the current frame.
      a.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
      const rms = Math.sqrt(sum / buf.length);
      const now = Date.now();

      // Calibration window — collect background noise.
      if (stateRef.current === "calibrating") {
        noiseSamplesRef.current.push(rms);
        if (now - calibrationStartRef.current >= CALIBRATION_MS) {
          const samples = noiseSamplesRef.current;
          samples.sort((x, y) => x - y);
          // Use median to ignore brief blips during calibration.
          noiseFloorRef.current = samples[Math.floor(samples.length / 2)] ?? 0;
          noiseSamplesRef.current = [];
          setState(pauseRef.current ? "paused" : "listening");
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Pause window — keep engine warm but never trigger.
      if (pauseRef.current) {
        if (isRecordingRef.current) stopRecording();
        if (stateRef.current !== "paused" && stateRef.current !== "processing") setState("paused");
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (stateRef.current === "paused") setState("listening");

      const threshold = Math.max(noiseFloorRef.current * THRESH_RATIO, ABSOLUTE_FLOOR);
      const silenceThreshold = threshold * SILENCE_RATIO;

      if (!isRecordingRef.current) {
        // Looking for speech start.
        if (rms > threshold) {
          if (speechStartRef.current === 0) speechStartRef.current = now;
          else if (now - speechStartRef.current >= SPEECH_TRIGGER_MS) {
            speechStartRef.current = 0;
            silenceStartRef.current = 0;
            setState("hearing_speech");
            startRecording();
          }
        } else {
          speechStartRef.current = 0;
        }
      } else {
        // Looking for silence end.
        if (rms < silenceThreshold) {
          if (silenceStartRef.current === 0) silenceStartRef.current = now;
          else if (now - silenceStartRef.current >= SILENCE_HANGOVER_MS) {
            silenceStartRef.current = 0;
            stopRecording();
          }
        } else {
          silenceStartRef.current = 0;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [onError, setMicPermission, setState, startRecording, stopRecording]);

  // Probe permission status passively (no prompt) when active flips on.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      try {
        // The Permissions API may not include "microphone" in all browsers
        // (Safari historically). Fall back to "unknown" and rely on the
        // explicit getUserMedia request below.
        const perms = (navigator as unknown as { permissions?: { query: (q: { name: PermissionName }) => Promise<{ state: PermissionState }> } }).permissions;
        if (perms?.query) {
          const status = await perms.query({ name: "microphone" as PermissionName });
          if (cancelled) return;
          if (status.state === "granted") setMicPermission("granted");
          else if (status.state === "denied") setMicPermission("denied");
          else setMicPermission("unknown");
        }
      } catch {
        // Permissions API unavailable; leave as "unknown".
      }
    })();
    return () => { cancelled = true; };
  }, [active, setMicPermission]);

  // Engine lifecycle. Mirrors `active` strictly.
  useEffect(() => {
    if (!active) {
      teardown();
      setState("idle");
      return;
    }
    if (micPermission === "denied") {
      setState("error");
      return;
    }
    if (micPermission !== "granted") {
      // Don't auto-prompt on every render. The owner shows a "Enable mic"
      // button which calls requestPermission() on a real user gesture.
      return;
    }
    void startEngine();
    return () => { teardown(); };
  }, [active, micPermission, startEngine, teardown, setState]);

  const requestPermission = useCallback(async (): Promise<MicPermission> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      setMicPermission("granted");
      // Hand the stream straight to the engine so we don't re-prompt.
      if (active && !audioCtxRef.current) {
        await startEngine(stream);
      } else {
        // Engine not ready yet — release this stream; lifecycle effect will
        // re-acquire when active flips on.
        try { stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      }
      return "granted";
    } catch {
      setMicPermission("denied");
      onError?.("Microphone access is blocked. Enable it in your browser settings.");
      return "denied";
    }
  }, [active, onError, setMicPermission, startEngine]);

  // Final unmount safety net.
  useEffect(() => () => { teardown(); }, [teardown]);

  return { state, micPermission, requestPermission };
}
