// Admin → Ruby Voice Settings API.
// ADMIN/OWNER only. Surfaces provider health checks, in-memory TTS
// diagnostics, and a server-side test endpoint that exercises the real
// ElevenLabs / OpenAI providers with a short fixed phrase.
//
// SAFETY:
//   - Never returns API keys. Only boolean "configured" flags.
//   - Never returns stack traces. Errors mapped to friendly codes.
//   - Diagnostics buffer is in-memory, capped at 50 entries.

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { db, userSettingsTable } from "@workspace/db";
import { listTTSDiagnostics, lastTTSDiagnostic, recordTTSDiagnostic } from "../lib/ttsDiagnostics.js";
import { logger } from "../lib/logger.js";
import {
  getVoiceAdminSettings,
  updateVoiceAdminSettings,
  modelSupportsInstructions,
  OPENAI_TTS_MODELS,
} from "../lib/voiceAdminSettings.js";
import {
  ELEVENLABS_VOICES,
  resolveDefaultElevenLabsVoiceId,
  getDefaultElevenLabsVoiceName,
} from "./meTTS.js";

const log = logger.child({ component: "adminRubyVoice" });
const router = Router();

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const sess = (req as unknown as { authUser?: { id: number; role?: string } }).authUser;
  if (!sess) { res.status(401).json({ error: "AUTH_REQUIRED" }); return null; }
  if (sess.role !== "ADMIN" && sess.role !== "OWNER") {
    res.status(403).json({ error: "FORBIDDEN", message: "Admin or Owner role required." });
    return null;
  }
  return { id: sess.id, role: sess.role as "ADMIN" | "OWNER" };
}

// ── GET /api/admin/ruby-voice/health ─────────────────────────────────────────
// Returns provider configuration status (key presence, never the key),
// admin-configured OpenAI model + style/instructions, supported model list,
// and the most recent diagnostic entry.
router.get("/admin/ruby-voice/health", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const hasOpenAI     = !!process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  const hasElevenLabs = !!process.env["ELEVENLABS_API_KEY"];
  const last = lastTTSDiagnostic();
  let admin: Awaited<ReturnType<typeof getVoiceAdminSettings>> | null = null;
  try { admin = await getVoiceAdminSettings(); } catch (e) {
    log.warn({ err: (e as Error).message }, "voice_admin_settings_load_failed");
  }
  // Bella resolution for admin diagnostics: did we find the configured
  // default voice in our known voice list? If not, surface a friendly
  // warning so the operator can correct it.
  const defaultVoiceName = getDefaultElevenLabsVoiceName();
  const defaultVoiceId   = resolveDefaultElevenLabsVoiceId();
  const bellaInList      = ELEVENLABS_VOICES.some((v) => v.id === defaultVoiceId);
  return res.json({
    ok: true,
    providers: {
      openai: {
        configured: hasOpenAI,
        status:     hasOpenAI ? "READY" : "MISSING_API_KEY",
        baseUrl:    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "https://api.openai.com/v1",
        activeModel:           admin?.openaiModel ?? "tts-1-hd",
        activeModelSupportsStyle: modelSupportsInstructions(admin?.openaiModel ?? "tts-1-hd"),
        supportedModels:       OPENAI_TTS_MODELS,
      },
      elevenlabs: {
        configured: hasElevenLabs,
        status:     hasElevenLabs ? "READY" : "MISSING_API_KEY",
        defaultVoiceName,
        defaultVoiceId,
        defaultVoiceResolved: bellaInList,
      },
      browser: {
        configured: true,
        status:     "READY",
      },
    },
    adminSettings: admin && {
      openaiModel:       admin.openaiModel,
      voiceInstructions: admin.voiceInstructions,
      updatedAt:         admin.updatedAt,
      updatedByUserId:   admin.updatedByUserId,
    },
    last,
    recent: listTTSDiagnostics(10),
  });
});

// ── GET /api/admin/ruby-voice/admin-settings ─────────────────────────────────
router.get("/admin/ruby-voice/admin-settings", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const admin = await getVoiceAdminSettings();
    return res.json({
      ok: true,
      settings: {
        openaiModel:       admin.openaiModel,
        voiceInstructions: admin.voiceInstructions,
        updatedAt:         admin.updatedAt,
        updatedByUserId:   admin.updatedByUserId,
      },
      supportedModels: OPENAI_TTS_MODELS,
    });
  } catch (e) {
    log.error({ err: (e as Error).message }, "voice_admin_settings_get_failed");
    return res.status(500).json({ ok: false, error: "VOICE_ADMIN_SETTINGS_GET_FAILED" });
  }
});

// ── PUT /api/admin/ruby-voice/admin-settings ─────────────────────────────────
const PutAdminBody = z.object({
  openaiModel:       z.string().min(1).max(64).optional(),
  voiceInstructions: z.string().max(2000).optional(),
});
router.put("/admin/ruby-voice/admin-settings", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const parsed = PutAdminBody.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: "BAD_BODY" });
  try {
    const updated = await updateVoiceAdminSettings(parsed.data, admin.id);
    return res.json({
      ok: true,
      settings: {
        openaiModel:       updated.openaiModel,
        voiceInstructions: updated.voiceInstructions,
        updatedAt:         updated.updatedAt,
        updatedByUserId:   updated.updatedByUserId,
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "UNKNOWN_OPENAI_TTS_MODEL" || msg === "VOICE_INSTRUCTIONS_TOO_LONG") {
      return res.status(400).json({ ok: false, error: msg });
    }
    log.error({ err: msg }, "voice_admin_settings_put_failed");
    return res.status(500).json({ ok: false, error: "VOICE_ADMIN_SETTINGS_PUT_FAILED" });
  }
});

// ── GET /api/admin/ruby-voice/diagnostics ────────────────────────────────────
router.get("/admin/ruby-voice/diagnostics", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.max(1, Math.min(Number(req.query["limit"] ?? 20), 50));
  return res.json({ ok: true, entries: listTTSDiagnostics(limit) });
});

// ── POST /api/admin/ruby-voice/test ──────────────────────────────────────────
// Body: { provider: "openai" | "elevenlabs" | "auto", voiceId: string, phrase?: string }
// Returns audio/mpeg stream (or JSON error). Sets the same X-TTS-* headers.
router.post("/admin/ruby-voice/test", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const t0 = Date.now();

  const provider = String(req.body?.provider ?? "auto") as "openai" | "elevenlabs" | "auto";
  const voiceId  = String(req.body?.voiceId ?? "").trim();
  const phrase   = (typeof req.body?.phrase === "string" && req.body.phrase.trim().length > 0)
    ? String(req.body.phrase).slice(0, 300)
    : "Ruby voice test successful. I'm online and ready.";

  if (!["openai", "elevenlabs", "auto"].includes(provider)) {
    return res.status(400).json({ ok: false, error: "BAD_PROVIDER" });
  }
  if (!voiceId) {
    return res.status(400).json({ ok: false, error: "BAD_VOICE_ID" });
  }

  const hasElevenLabs = !!process.env["ELEVENLABS_API_KEY"];
  const hasOpenAI     = !!process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];

  const useElevenLabs =
    (provider === "elevenlabs" || provider === "auto") && hasElevenLabs;
  const useOpenAI =
    !useElevenLabs && (provider === "openai" || provider === "auto") && hasOpenAI;

  if (!useElevenLabs && !useOpenAI) {
    recordTTSDiagnostic({
      ts: new Date().toISOString(), userId: admin.id, providerAsked: provider, providerUsed: "none",
      voiceId, status: "no_provider", httpStatus: 503, mime: null, bytes: 0,
      durationMs: Date.now() - t0, fallback: false, fallbackReason: "NO_PROVIDER_CONFIGURED",
      errorCode: "NO_TTS_PROVIDER", errorMessage: "No premium TTS provider configured.",
      isTest: true,
    });
    return res.status(503).json({ ok: false, error: "NO_TTS_PROVIDER", message: "No premium provider configured." });
  }

  try {
    let upstream: globalThis.Response;
    let providerUsed: "openai" | "elevenlabs";

    if (useElevenLabs) {
      providerUsed = "elevenlabs";
      upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
        {
          method: "POST",
          headers: {
            "xi-api-key":   process.env["ELEVENLABS_API_KEY"]!,
            "Content-Type": "application/json",
            "Accept":       "audio/mpeg",
          },
          body: JSON.stringify({
            text: phrase,
            model_id: "eleven_turbo_v2_5",
            voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0.3, use_speaker_boost: true },
          }),
        }
      );
    } else {
      providerUsed = "openai";
      const openaiBase = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] ?? "https://api.openai.com/v1";
      const adminSet = await getVoiceAdminSettings().catch(() => null);
      const modelId = adminSet?.openaiModel ?? "tts-1-hd";
      const styleApplied = modelSupportsInstructions(modelId) && !!adminSet?.voiceInstructions?.trim();
      const body: Record<string, unknown> = {
        model: modelId, input: phrase, voice: voiceId, response_format: "mp3", speed: 0.95,
      };
      if (styleApplied) body["instructions"] = adminSet!.voiceInstructions;
      upstream = await fetch(`${openaiBase}/audio/speech`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]!}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      const code = upstream.status === 401 ? "INVALID_API_KEY"
                 : upstream.status === 404 ? "INVALID_VOICE_ID"
                 : upstream.status === 429 ? "QUOTA_OR_RATE_LIMIT"
                 : upstream.status >= 500   ? "PROVIDER_UNAVAILABLE"
                 : "PROVIDER_REJECTED_REQUEST";
      log.warn({ status: upstream.status, providerUsed, code }, "admin_tts_test_upstream_failed");
      recordTTSDiagnostic({
        ts: new Date().toISOString(), userId: admin.id, providerAsked: provider, providerUsed,
        voiceId, status: "error", httpStatus: upstream.status, mime: null, bytes: 0,
        durationMs: Date.now() - t0, fallback: false, fallbackReason: null,
        errorCode: code, errorMessage: `${providerUsed} rejected the request.`, isTest: true,
      });
      // Do not leak upstream error body — only return the friendly code.
      void errText;
      return res.status(502).json({ ok: false, error: code, providerUsed });
    }

    // Buffer first so X-TTS-* headers can be set before the first byte is written.
    const buf = Buffer.from(await upstream.arrayBuffer());
    const bytes = buf.byteLength;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-TTS-Provider", providerUsed);
    res.setHeader("X-TTS-Bytes", String(bytes));
    res.setHeader("X-TTS-Duration-Ms", String(Date.now() - t0));
    recordTTSDiagnostic({
      ts: new Date().toISOString(), userId: admin.id, providerAsked: provider, providerUsed,
      voiceId, status: "ok", httpStatus: 200, mime: "audio/mpeg", bytes,
      durationMs: Date.now() - t0, fallback: false, fallbackReason: null,
      errorCode: null, errorMessage: null, isTest: true,
    });
    res.write(buf);
    return res.end();
  } catch (e) {
    log.error({ err: (e as Error).message }, "admin_tts_test_failed");
    recordTTSDiagnostic({
      ts: new Date().toISOString(), userId: admin.id, providerAsked: provider, providerUsed: useElevenLabs ? "elevenlabs" : "openai",
      voiceId, status: "error", httpStatus: 500, mime: null, bytes: 0,
      durationMs: Date.now() - t0, fallback: false, fallbackReason: null,
      errorCode: "TIMED_OUT_OR_NETWORK", errorMessage: "Network or timeout error reaching provider.", isTest: true,
    });
    return res.status(500).json({ ok: false, error: "TIMED_OUT_OR_NETWORK" });
  }
});

// ── POST /api/admin/ruby-voice/reset-all-to-bella ────────────────────────────
// Resets every user's Ruby voice preferences to the system-wide default
// (ElevenLabs / Bella) and turns speak-responses + auto-play back on.
// Admin/Owner only. Returns the number of rows updated.
//
// SAFETY:
//   - requireAdmin gate enforced.
//   - Never returns user IDs, emails, or voice IDs of individual users.
//   - Writes are bulk UPDATE only; no per-user data is read or returned.
router.post("/admin/ruby-voice/reset-all-to-bella", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  try {
    const provider = "elevenlabs" as const;
    const voiceId  = resolveDefaultElevenLabsVoiceId();
    const voiceName = getDefaultElevenLabsVoiceName();
    const result = await db
      .update(userSettingsTable)
      .set({
        rubyVoiceEnabled:    true,
        rubySpeakResponses:  true,
        rubyBrowserFallback: true,
        rubyTtsProvider:     provider,
        rubyTtsVoiceId:      voiceId,
        updatedAt:           new Date(),
      });
    const rowCountRaw = (result as { rowCount?: number | null }).rowCount;
    const rowsUpdated = typeof rowCountRaw === "number" ? rowCountRaw : 0;
    log.info({ adminId: admin.id, rowsUpdated, voiceName }, "ruby_voice_reset_all_to_bella");
    return res.json({ ok: true, rowsUpdated, provider, voiceName });
  } catch (e) {
    log.error({ err: (e as Error).message }, "ruby_voice_reset_all_to_bella_failed");
    return res.status(500).json({ ok: false, error: "RESET_ALL_FAILED" });
  }
});

export default router;
