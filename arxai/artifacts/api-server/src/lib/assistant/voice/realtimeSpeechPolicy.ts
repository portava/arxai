// Realtime voice speech path (pure constants; no DB/provider imports).
//
// The model's realtime audio would stream browser<->OpenAI and could never be
// checked before it plays, so realtime sessions answer in TEXT only. The browser
// sends each final answer to POST /me/assistant/voice/speech-gate (same claims
// checker as typed chat) and reads the gated speech through the TTS route.

/** Realtime never emits model audio: text out, verified, then TTS. */
export const REALTIME_OUTPUT_MODALITIES = ["text"] as const;
export const REALTIME_SPEECH_PATH = "verified_text_then_tts" as const;
