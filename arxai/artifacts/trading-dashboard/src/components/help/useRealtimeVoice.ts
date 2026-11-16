// Phase 15C — ARX AI Assistant true OpenAI Realtime WebRTC client.
//
// SAFETY:
// - Mic is requested ONLY after the user explicitly starts realtime voice.
// - Browser NEVER receives the direct OPENAI_API_KEY. The backend mints a
//   short-lived ephemeral client_secret (`ek_...`) via
//   POST /api/me/assistant/realtime/session and only that ephemeral is used
//   to open the WebRTC PeerConnection with OpenAI.
// - On stop / unmount we fully release: mic tracks, peer connection, data
//   channel, remote audio element, event listeners.
// - Function calls from the voice channel are auto-replied with a paper-only
//   refusal so the assistant never fabricates data; tool execution from
//   voice is intentionally deferred to typed chat in this build.
// - Same assistant brain: the backend session is configured with the same
//   ARX_ASSISTANT_SYSTEM_PROMPT, paper_only/liveLocked safety envelope, and
//   tool catalog as typed chat. There is no separate "voice brain".

import { useCallback, useEffect, useRef, useState } from "react";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

export type RealtimeState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "muted"
  | "failed"
  | "disconnected";

export type RealtimeMode =
  | "true_webrtc_realtime_active"
  | "degraded_gpt_audio_fallback"
  | "text_only_fallback";

interface MintResponse {
  configured: boolean;
  mode: "true_webrtc_realtime" | "degraded_gpt_audio_fallback" | "text_only_fallback";
  clientSecret?: { value: string; expiresAt: number };
  model?: string;
  reason?: string;
  safety?: { liveLocked?: boolean; safetyMode?: string };
}

const REALTIME_VALID_SAFETY_MODES = new Set(["off", "simulated", "demo", "live", "paper_only"]);

/** Accept the per-user envelope the server mints; refuse only when it is
 *  missing or carries a mode the server never sends. */
export function isRealtimeSafetyEnvelopeAcceptable(
  safety: { liveLocked?: unknown; safetyMode?: unknown } | null | undefined,
): boolean {
  if (!safety || typeof safety !== "object") return false;
  if (typeof safety.safetyMode !== "string") return false;
  if (typeof safety.liveLocked !== "boolean") return false;
  return REALTIME_VALID_SAFETY_MODES.has(safety.safetyMode);
}

// ── Claim gate for realtime speech (owner ruling 2026-11-09) ────────────────
// The server mints realtime sessions with output_modalities ["text"], so the
// model never streams audio straight to the speaker. Each final answer goes to
// the server claim gate; the bubble shows the verified `display` text and only
// the gated `speech` is read aloud (through the TTS route, which gates again).
// Partial deltas are never shown: an unchecked figure is never on screen.

export const REALTIME_GATE_FAILED_DISPLAY =
  "[Withheld: the ARX verifier could not check this spoken answer, so it is not shown or read aloud.]";

/** The final assistant text of a realtime event, or null for any other event. */
export function realtimeAssistantFinalText(ev: { type?: string; text?: string; transcript?: string }): string | null {
  const t = ev.type ?? "";
  if ((t === "response.output_text.done" || t === "response.text.done") && typeof ev.text === "string") return ev.text;
  // Legacy/audio sessions: the audio transcript is still gated, never shown raw.
  if ((t === "response.output_audio_transcript.done" || t === "response.audio_transcript.done") && typeof ev.transcript === "string") return ev.transcript;
  return null;
}

export interface GatedRealtimeAnswer { display: string; speech: string; ok: boolean }

/** Send one final realtime answer through the server claim gate. Fails closed. */
export async function gateRealtimeAnswer(
  text: string,
  userText: string,
  fetchFn: typeof fetch = fetch,
): Promise<GatedRealtimeAnswer> {
  try {
    const r = await fetchFn(`${BASE}/api/me/assistant/voice/speech-gate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 8000), userText: userText.slice(0, 4000) }),
    });
    if (!r.ok) return { display: REALTIME_GATE_FAILED_DISPLAY, speech: "", ok: false };
    const j = (await r.json()) as { display?: unknown; speech?: unknown };
    if (typeof j.display !== "string" || typeof j.speech !== "string") return { display: REALTIME_GATE_FAILED_DISPLAY, speech: "", ok: false };
    return { display: j.display, speech: j.speech, ok: true };
  } catch {
    return { display: REALTIME_GATE_FAILED_DISPLAY, speech: "", ok: false };
  }
}

export interface UseRealtimeVoiceOptions {
  onUserTranscript?: (text: string, isFinal: boolean) => void;
  onAssistantTranscript?: (text: string, isFinal: boolean) => void;
  /** Read the gated speech aloud (the panel routes it through the TTS hook). */
  onSpeak?: (speech: string) => void;
  onMode?: (mode: RealtimeMode, reason?: string) => void;
  onError?: (message: string) => void;
}

export interface UseRealtimeVoiceApi {
  state: RealtimeState;
  isMuted: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggleMute: () => void;
  interrupt: () => void;
}

export function useRealtimeVoice(opts: UseRealtimeVoiceOptions = {}): UseRealtimeVoiceApi {
  const [state, setState] = useState<RealtimeState>("idle");
  const [isMuted, setIsMuted] = useState(false);

  // Refs hold network/media handles so cleanup is bullet-proof.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const stoppedRef = useRef(false);
  const startGeneration=useRef(0);
  const userTranscriptBufRef = useRef("");
  const assistantTranscriptBufRef = useRef("");
  // The user's last final utterance: the only evidence a tool-less voice
  // answer can echo (same rule as typed chat).
  const lastUserTranscriptRef = useRef("");

  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; }, [opts]);

  const cleanup = useCallback(() => {
    stoppedRef.current = true;
    startGeneration.current++;
    try { dcRef.current?.close(); } catch { /* noop */ }
    dcRef.current = null;
    try { pcRef.current?.getSenders().forEach((s) => { try { s.track?.stop(); } catch { /* noop */ } }); } catch { /* noop */ }
    try { pcRef.current?.close(); } catch { /* noop */ }
    pcRef.current = null;
    if (micStreamRef.current) {
      try { micStreamRef.current.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      micStreamRef.current = null;
    }
    if (audioElRef.current) {
      try {
        audioElRef.current.pause();
        audioElRef.current.srcObject = null;
        audioElRef.current.remove();
      } catch { /* noop */ }
      audioElRef.current = null;
    }
  }, []);

  const stop = useCallback(async () => {
    cleanup();
    setState("idle");
    setIsMuted(false);
    userTranscriptBufRef.current = "";
    assistantTranscriptBufRef.current = "";
  }, [cleanup]);

  // Auto-cleanup on unmount.
  useEffect(() => () => { cleanup(); }, [cleanup]);

  const sendDc = useCallback((obj: unknown) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === "open") {
      try { dc.send(JSON.stringify(obj)); } catch { /* noop */ }
    }
  }, []);

  const interrupt = useCallback(() => {
    // Tell the model to stop speaking immediately.
    sendDc({ type: "response.cancel" });
  }, [sendDc]);

  const handleEvent = useCallback((ev: { type?: string; text?: string; transcript?: string; delta?: string; name?: string; call_id?: string; item?: { call_id?: string; name?: string } }) => {
    const t = ev.type ?? "";
    const finalText = realtimeAssistantFinalText(ev);
    if (finalText !== null) {
      assistantTranscriptBufRef.current = "";
      const heard = lastUserTranscriptRef.current;
      void gateRealtimeAnswer(finalText, heard).then((g) => {
        if (stoppedRef.current) return;
        optsRef.current.onAssistantTranscript?.(g.display, true);
        if (g.ok && g.speech.trim()) optsRef.current.onSpeak?.(g.speech);
      });
      return;
    }
    // User speech transcripts
    if (t === "conversation.item.input_audio_transcription.delta" && typeof ev.delta === "string") {
      userTranscriptBufRef.current += ev.delta;
      optsRef.current.onUserTranscript?.(userTranscriptBufRef.current, false);
    } else if (t === "conversation.item.input_audio_transcription.completed" && typeof ev.transcript === "string") {
      optsRef.current.onUserTranscript?.(ev.transcript, true);
      lastUserTranscriptRef.current = ev.transcript;
      userTranscriptBufRef.current = "";
    }
    // Assistant speech transcripts
    // Assistant deltas are buffered, never shown: the bubble only ever shows
    // the gated final text (a placeholder signals the answer is coming).
    else if ((t === "response.output_text.delta" || t === "response.text.delta" || t === "response.output_audio_transcript.delta" || t === "response.audio_transcript.delta") && typeof ev.delta === "string") {
      if (!assistantTranscriptBufRef.current) optsRef.current.onAssistantTranscript?.("", false);
      assistantTranscriptBufRef.current += ev.delta;
      setState((s) => (s === "muted" ? s : "speaking"));
    }
    // Speech start/end → listening/speaking indicator
    else if (t === "input_audio_buffer.speech_started") {
      setState((s) => (s === "muted" ? s : "listening"));
    } else if (t === "input_audio_buffer.speech_stopped") {
      // Server VAD will commit; remain in listening until response begins.
    } else if (t === "response.created") {
      setState((s) => (s === "muted" ? s : "speaking"));
    } else if (t === "response.done") {
      setState((s) => (s === "muted" ? s : "listening"));
    }
    // Function calls — voice tool execution is deferred. Auto-respond with a
    // paper-only refusal so the model never fabricates a result.
    else if (t === "response.function_call_arguments.done") {
      const callId = ev.call_id ?? ev.item?.call_id;
      if (callId) {
        sendDc({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify({
              error: "VOICE_TOOL_DISPATCH_NOT_WIRED",
              message: "Tool execution from the voice channel is not wired in this build. Ask the same question in typed chat to use the live tools. Demo-only mode and live-execution lock remain in force.",
              safetyMode: "paper_only",
              liveLocked: true,
            }),
          },
        });
        // Ask the model to continue with what it has, without inventing data.
        sendDc({ type: "response.create" });
      }
    } else if (t === "error") {
      optsRef.current.onError?.("Realtime voice channel error from provider.");
    }
  }, [sendDc]);

  const start = useCallback(async () => {
    if (state === "connecting" || state === "listening" || state === "speaking") return;
    stoppedRef.current = false;
    const owner=++startGeneration.current;
    const isCurrent=()=>owner===startGeneration.current&&!stoppedRef.current;
    setState("connecting");
    setIsMuted(false);
    userTranscriptBufRef.current = "";
    assistantTranscriptBufRef.current = "";

    // 1. Mint ephemeral session via backend (never exposes OPENAI_API_KEY).
    let mint: MintResponse;
    try {
      const r = await fetch(`${BASE}/api/me/assistant/realtime/session`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error(`mint HTTP ${r.status}`);
      mint = (await r.json()) as MintResponse;
    } catch {
      if(!isCurrent())return;
      setState("failed");
      optsRef.current.onMode?.("degraded_gpt_audio_fallback", "MINT_NETWORK_ERROR");
      optsRef.current.onError?.("Couldn't start Realtime voice session. Falling back to degraded voice / text.");
      return;
    }
    if(!isCurrent())return;
    if (mint.mode !== "true_webrtc_realtime" || !mint.clientSecret?.value) {
      setState("failed");
      optsRef.current.onMode?.(
        mint.configured ? "degraded_gpt_audio_fallback" : "text_only_fallback",
        mint.reason ?? "REALTIME_NOT_AVAILABLE",
      );
      optsRef.current.onError?.("Realtime voice not available. Use the gpt-audio mic or typed chat.");
      return;
    }
    // Fail-closed on a missing / malformed envelope only. The server sends the
    // derived per-user envelope (off | simulated | demo | live | paper_only),
    // the same contract the typed-chat SSE validator accepts. Realtime voice
    // has no order tools (tools: []), so the execution posture is irrelevant.
    if (!isRealtimeSafetyEnvelopeAcceptable(mint.safety)) {
      setState("failed");
      optsRef.current.onError?.("Safety envelope missing or mismatched — Realtime voice disabled.");
      return;
    }
    const ephemeral = mint.clientSecret.value;
    const model = mint.model ?? "gpt-realtime";

    // 2. Request mic (only now, after explicit user action).
    let micStream: MediaStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if(!isCurrent())return;
      setState("failed");
      optsRef.current.onError?.("Microphone access denied. Realtime voice unavailable — text chat still works.");
      return;
    }
    if (!isCurrent()) { micStream.getTracks().forEach((t) => t.stop()); return; }
    micStreamRef.current = micStream;

    // 3. Build PeerConnection.
    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    // Remote audio: assistant voice playback.
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    audioElRef.current = audioEl;
    pc.ontrack = (ev) => {
      if(!isCurrent())return;
      const stream = ev.streams[0];
      if (stream) {
        audioEl.srcObject = stream;
      }
    };

    // 4. Mic track.
    const track = micStream.getAudioTracks()[0];
    if (track) pc.addTrack(track, micStream);

    // 5. Data channel for events / transcripts / tool signals.
    const dc = pc.createDataChannel("oai-events");
    dcRef.current = dc;
    dc.onopen = () => {
      if(!isCurrent())return;
      // Ask provider to transcribe input audio so we can show user speech.
      sendDc({
        type: "session.update",
        session: {
          input_audio_transcription: { model: "whisper-1" },
        },
      });
    };
    dc.onmessage = (e) => {
      if(!isCurrent())return;
      try {
        const obj = JSON.parse(e.data) as Record<string, unknown>;
        handleEvent(obj as Parameters<typeof handleEvent>[0]);
      } catch { /* ignore non-JSON */ }
    };
    dc.onerror = () => {if(isCurrent())optsRef.current.onError?.("Realtime data channel error.");};

    pc.onconnectionstatechange = () => {
      if(!isCurrent())return;
      const st = pc.connectionState;
      if (st === "failed" || st === "disconnected" || st === "closed") {
        if (!stoppedRef.current) {
          setState(st === "failed" ? "failed" : "disconnected");
          optsRef.current.onMode?.("degraded_gpt_audio_fallback", `WEBRTC_${st.toUpperCase()}`);
          cleanup();
        }
      } else if (st === "connected") {
        setState((s) => (s === "muted" ? s : "listening"));
        optsRef.current.onMode?.("true_webrtc_realtime_active");
      }
    };

    // 6. SDP exchange with OpenAI Realtime GA endpoint.
    let offer: RTCSessionDescriptionInit;
    try {
      offer = await pc.createOffer();
      if(!isCurrent())return;
      await pc.setLocalDescription(offer);
    } catch {
      if(!isCurrent())return;
      setState("failed");
      optsRef.current.onError?.("Failed to create WebRTC offer.");
      cleanup();
      return;
    }
    if (!isCurrent()) return;

    let sdpResp: Response;
    try {
      // Phase 22G — bound the WebRTC handshake to 8s. Without this, an
      // unreachable provider (mobile Safari + Replit proxy edge cases,
      // captive portal, etc.) leaves the connection hanging and the UI
      // stuck on "connecting…" indefinitely. 8s matches the spec.
      sdpResp = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ephemeral}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp ?? "",
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      if(!isCurrent())return;
      setState("failed");
      optsRef.current.onMode?.("degraded_gpt_audio_fallback", "SDP_NETWORK_ERROR");
      optsRef.current.onError?.("Realtime voice handshake failed.");
      cleanup();
      return;
    }
    if(!isCurrent())return;
    if (!sdpResp.ok) {
      setState("failed");
      optsRef.current.onMode?.("degraded_gpt_audio_fallback", `SDP_HTTP_${sdpResp.status}`);
      optsRef.current.onError?.("Realtime voice handshake failed.");
      cleanup();
      return;
    }
    const answerSdp = await sdpResp.text();
    if (!isCurrent()) return;
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    } catch {
      if(!isCurrent())return;
      setState("failed");
      optsRef.current.onError?.("Failed to apply Realtime voice answer.");
      cleanup();
      return;
    }
    // connectionstatechange will move us into "listening".
  }, [state, cleanup, handleEvent, sendDc]);

  const toggleMute = useCallback(() => {
    const stream = micStreamRef.current;
    if (!stream) return;
    setIsMuted((prev) => {
      const next = !prev;
      stream.getAudioTracks().forEach((t) => { t.enabled = !next; });
      setState((s) => {
        if (next) return "muted";
        if (s === "muted") return "listening";
        return s;
      });
      return next;
    });
  }, []);

  return { state, isMuted, start, stop, toggleMute, interrupt };
}
