// Ruby TTS Route — server-side text-to-speech.
//
// POST /api/me/assistant/tts
// Body: { text: string, voice: string, provider?: "openai" | "elevenlabs" }
// Returns: audio/mpeg stream
//
// Provider priority:
//   1. ElevenLabs if ELEVENLABS_API_KEY set and provider="elevenlabs" or default
//   2. OpenAI TTS if AI_INTEGRATIONS_OPENAI_API_KEY set
//   3. 503 with clear message if neither configured
//
// SAFETY:
//   - requireUser on all routes
//   - Text sanitized server-side before TTS (strips markdown, secrets)
//   - Max 2000 chars per request to control cost
//   - Never logs the text content (privacy)

import { Router } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ component: "ttsRoute" });
const router = Router();

// ── OpenAI voices ─────────────────────────────────────────────────────────────
export const OPENAI_VOICES = [
  { id: "nova",    label: "Nova",    gender: "female", accent: "American",  note: "Warm, natural, expressive" },
  { id: "shimmer", label: "Shimmer", gender: "female", accent: "American",  note: "Soft, calm, soothing" },
  { id: "alloy",   label: "Alloy",   gender: "female", accent: "American",  note: "Clear, neutral, professional" },
  { id: "echo",    label: "Echo",    gender: "male",   accent: "American",  note: "Warm, conversational" },
  { id: "fable",   label: "Fable",   gender: "male",   accent: "British",   note: "Expressive, storytelling" },
  { id: "onyx",    label: "Onyx",    gender: "male",   accent: "American",  note: "Deep, authoritative" },
] as const;

// ── ElevenLabs default voices (well-known IDs from their free voice library) ─
export const ELEVENLABS_VOICES = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel",  gender: "female", accent: "American", note: "Calm, warm, natural" },
  { id: "AZnzlk1XvdvUeBnXmlld", label: "Domi",    gender: "female", accent: "American", note: "Confident, expressive" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella",   gender: "female", accent: "American", note: "Soft, gentle, friendly" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni",  gender: "male",   accent: "American", note: "Well-rounded, natural" },
  { id: "VR6AewLTigWG4xSOukaG", label: "Arnold",  gender: "male",   accent: "American", note: "Crisp, authoritative" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam",    gender: "male",   accent: "American", note: "Deep, narrative" },
  { id: "yoZ06aMxZJJ28mfd3POQ", label: "Sam",     gender: "male",   accent: "American", note: "Raspy, intense" },
  { id: "jBpfuIE2acCO8z3wKNLl", label: "Gigi",    gender: "female", accent: "American", note: "Childlike, playful" },
  { id: "jsCqWAovK2LkecY7zXl4", label: "Freya",   gender: "female", accent: "American", note: "Natural, expressive" },
  { id: "oWAxZDx7w5VEj9dCyTzz", label: "Grace",   gender: "female", accent: "Southern American", note: "Soft, warm" },
  { id: "z9fAnlkpzviPz146aGWa", label: "Glinda",  gender: "female", accent: "American", note: "Warm, witchy" },
  { id: "ThT5KcBeYPX3keUQqHPh", label: "Dorothy", gender: "female", accent: "British",  note: "Natural British female" },
  { id: "N2lVS1w4EtoT3dr4eOWO", label: "Callum",  gender: "male",   accent: "Transatlantic", note: "Deep, intense" },
  { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda", gender: "female", accent: "American", note: "Warm, friendly" },
] as const;

// ── Text sanitizer for TTS ─────────────────────────────────────────────────────
function sanitizeForTTS(input: string): string {
  let s = input;
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`[^`]*`/g, " ");
  s = s.replace(/https?:\/\/\S+/gi, " ");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1");
  s = s.replace(/_{1,3}([^_]+)_{1,3}/g, "$1");
  s = s.replace(/^\s*[-*•]\s+/gm, " ");
  s = s.replace(/^\s*\d+\.\s+/gm, " ");
  s = s.replace(/\|/g, " ");
  s = s.replace(/\b[A-Za-z0-9+/_-]{32,}\b/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > 2000) s = s.slice(0, 2000);
  return s;
}

// ── GET /api/me/assistant/tts/voices ─────────────────────────────────────────
router.get("/me/assistant/tts/voices", requireUser, (_req, res) => {
  const hasOpenAI     = !!(process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]);
  const hasElevenLabs = !!(process.env["ELEVENLABS_API_KEY"]);

  return res.json({
    ok: true,
    providers: {
      openai:      { available: hasOpenAI,     voices: hasOpenAI     ? OPENAI_VOICES     : [] },
      elevenlabs:  { available: hasElevenLabs, voices: hasElevenLabs ? ELEVENLABS_VOICES : [] },
    },
    defaultProvider: hasElevenLabs ? "elevenlabs" : hasOpenAI ? "openai" : "browser",
    defaultVoice:    hasElevenLabs ? "EXAVITQu4vr4xnSDxMaL" : "nova", // Bella default
  });
});

// ── POST /api/me/assistant/tts ────────────────────────────────────────────────
const TTSBody = z.object({
  text:     z.string().min(1).max(3000),
  voice:    z.string().min(1).max(100),
  provider: z.enum(["openai", "elevenlabs", "auto"]).optional().default("auto"),
});

router.post("/me/assistant/tts", requireUser, async (req, res) => {
  const parsed = TTSBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY" });
  }

  const { voice, provider } = parsed.data;
  const text = sanitizeForTTS(parsed.data.text);

  if (!text) {
    return res.status(400).json({ ok: false, error: "EMPTY_TEXT" });
  }

  const hasElevenLabs = !!(process.env["ELEVENLABS_API_KEY"]);
  const hasOpenAI     = !!(process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]);

  // Choose provider
  const useElevenLabs =
    (provider === "elevenlabs" || provider === "auto") && hasElevenLabs;
  const useOpenAI =
    !useElevenLabs && (provider === "openai" || provider === "auto") && hasOpenAI;

  if (!useElevenLabs && !useOpenAI) {
    return res.status(503).json({
      ok: false,
      error: "NO_TTS_PROVIDER",
      message: "No TTS provider configured. Add ELEVENLABS_API_KEY or ensure AI_INTEGRATIONS_OPENAI_API_KEY is set.",
    });
  }

  try {
    if (useElevenLabs) {
      const apiKey = process.env["ELEVENLABS_API_KEY"]!;
      const voiceId = voice;

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
        {
          method: "POST",
          headers: {
            "xi-api-key":   apiKey,
            "Content-Type": "application/json",
            "Accept":       "audio/mpeg",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_turbo_v2_5",   // fastest + natural
            voice_settings: {
              stability:        0.5,
              similarity_boost: 0.85,
              style:            0.3,
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        log.warn({ status: response.status, voice }, "elevenlabs_tts_failed");
        return res.status(502).json({ ok: false, error: "ELEVENLABS_ERROR", message: errText.slice(0, 200) });
      }

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      // Stream the audio directly to the client
      const reader = response.body?.getReader();
      if (!reader) {
        return res.status(502).json({ ok: false, error: "NO_STREAM" });
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      return res.end();
    }

    if (useOpenAI) {
      const openaiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]!;
      const openaiBase = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";

      const response = await fetch(`${openaiBase}/audio/speech`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openaiKey}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          model:           "tts-1-hd",   // higher quality than tts-1
          input:           text,
          voice:           voice as "nova" | "shimmer" | "alloy" | "echo" | "fable" | "onyx",
          response_format: "mp3",
          speed:           0.95,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        log.warn({ status: response.status, voice }, "openai_tts_failed");
        return res.status(502).json({ ok: false, error: "OPENAI_TTS_ERROR", message: errText.slice(0, 200) });
      }

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      const reader = response.body?.getReader();
      if (!reader) return res.status(502).json({ ok: false, error: "NO_STREAM" });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      return res.end();
    }

    // Neither provider branch executed (should be unreachable given the guard
    // above) — return explicitly so all code paths return a value.
    return res.status(503).json({ ok: false, error: "NO_TTS_PROVIDER" });
  } catch (e) {
    log.error({ err: (e as Error).message }, "tts_route_failed");
    return res.status(500).json({ ok: false, error: "TTS_FAILED", message: "TTS request failed." });
  }
});

// ── Default-voice helpers (imported by adminRubyVoice.ts) ───────────────────
const DEFAULT_ELEVENLABS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"; // Bella
const DEFAULT_ELEVENLABS_VOICE_NAME = "Bella";

// The default ElevenLabs voice id ARX uses when a user has no explicit choice.
export function resolveDefaultElevenLabsVoiceId(): string {
  const override = (process.env["ELEVENLABS_DEFAULT_VOICE_ID"] ?? "").trim();
  return override || DEFAULT_ELEVENLABS_VOICE_ID;
}

// Human-readable name for the default voice (for admin display).
export function getDefaultElevenLabsVoiceName(): string {
  const id = resolveDefaultElevenLabsVoiceId();
  const match = ELEVENLABS_VOICES.find((v) => v.id === id);
  return match?.label ?? DEFAULT_ELEVENLABS_VOICE_NAME;
}

export default router;
