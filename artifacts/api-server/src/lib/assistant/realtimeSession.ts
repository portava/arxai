// ARX AI Assistant — true OpenAI Realtime WebRTC session minter.
//
// SAFETY:
// - Gated on process.env.OPENAI_API_KEY (DIRECT key, NOT the Replit AI proxy).
//   The proxy does not currently support Realtime WebRTC, so we never call it
//   from this module.
// - When OPENAI_API_KEY is unset → returns { configured:false, mode:"degraded_gpt_audio_fallback" }
//   The frontend then keeps using the existing /voice (gpt-audio) path.
// - The DIRECT api key is NEVER returned to the browser. Only the
//   short-lived `client_secret` minted by OpenAI's /v1/realtime/sessions
//   is forwarded.
// - Per-user rate-limited (in-memory) to prevent runaway cost.
// - Same DERIVED per-user safety envelope + same assistant tool allowlist +
//   same ARX system prompt as typed chat → no separate "voice brain".

import { buildArxAssistantSystemPrompt } from "./systemPrompt.js";
import { getAssistantDisplayName } from "./assistantName.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import {
  deriveAssistantEnvelope,
  assistantEnvelopeFields,
  type AssistantEnvelopeFields,
} from "./derivedEnvelope.js";
import { getMarketStatus } from "./marketProvider.js";
import { logger } from "../logger.js";

const REALTIME_MODEL = "gpt-realtime";
const SESSION_MAX_DURATION_SECONDS = 10 * 60; // 10 minutes hard cap
const RATE_LIMIT_PER_USER_PER_HOUR = 12;

// In-memory limiter is sufficient for current single-instance deployment.
// If the API ever scales horizontally, replace with a shared store (Redis).
// Map is bounded — empty user buckets are evicted, and the whole map is
// trimmed if it exceeds MAX_TRACKED_USERS.
const MAX_TRACKED_USERS = 5_000;
const _userRate = new Map<number, number[]>();
function rateAllow(userId: number): { ok: boolean; remaining: number } {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  const arr = (_userRate.get(userId) ?? []).filter((t) => t > cutoff);
  if (arr.length >= RATE_LIMIT_PER_USER_PER_HOUR) {
    if (arr.length === 0) _userRate.delete(userId); else _userRate.set(userId, arr);
    return { ok: false, remaining: 0 };
  }
  arr.push(now);
  _userRate.set(userId, arr);
  if (_userRate.size > MAX_TRACKED_USERS) {
    // Evict the oldest-touched user buckets in insertion order.
    const evictCount = _userRate.size - MAX_TRACKED_USERS;
    let i = 0;
    for (const k of _userRate.keys()) {
      if (i++ >= evictCount) break;
      _userRate.delete(k);
    }
  }
  return { ok: true, remaining: RATE_LIMIT_PER_USER_PER_HOUR - arr.length };
}

export interface RealtimeSessionResult {
  configured: boolean;
  mode: "true_webrtc_realtime" | "degraded_gpt_audio_fallback" | "text_only_fallback";
  clientSecret?: { value: string; expiresAt: number };
  model?: string;
  expiresInSeconds?: number;
  toolCount?: number;
  reason?: string;
  rateRemaining?: number;
  safety: AssistantEnvelopeFields;
}

export async function mintRealtimeSession(userId: number): Promise<RealtimeSessionResult> {
  // Honest, per-user safety envelope (fail-closed). Voice reports the exact same
  // derived state as typed chat — never a hardcoded paper-only stub.
  const safety = assistantEnvelopeFields(await deriveAssistantEnvelope(userId));
  const directKey = process.env["OPENAI_API_KEY"];
  if (!directKey || directKey.trim().length === 0) {
    return {
      configured: false,
      mode: "degraded_gpt_audio_fallback",
      reason: "OPENAI_API_KEY is not configured server-side. True WebRTC Realtime requires a direct OpenAI key (the Replit AI Integrations proxy does not support Realtime). Falling back to gpt-audio degraded voice.",
      safety,
    };
  }
  const rate = rateAllow(userId);
  if (!rate.ok) {
    return {
      configured: true,
      mode: "degraded_gpt_audio_fallback",
      reason: "Realtime voice rate limit reached for this hour. Falling back to degraded voice / text.",
      rateRemaining: 0,
      safety,
    };
  }

  const market = getMarketStatus();
  const assistantName = await getAssistantDisplayName(userId);
  const sessionInstructions = [
    buildArxAssistantSystemPrompt(assistantName),
    `Voice mode is active. Per-user-isolated session for user id ${userId}.`,
    `Market data provider connected: ${market.connected ? "yes" : "no"}. If not connected, never fabricate quotes.`,
    `Trading mode is admin-controlled per user. Every order goes through the backend guard chain and may be rejected. Call getTradingMode before answering execution questions; never claim to have placed a trade unless requestDemoOrder / requestLiveOrder returned a QUEUED status.`,
  ].join("\n\n");

  const realtimeTools = TOOL_DEFINITIONS.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  let resp: Response;
  try {
    // OpenAI Realtime GA endpoint (the previous /v1/realtime/sessions Beta API
    // was retired with code "beta_api_shape_disabled"). Mints an ephemeral
    // client secret the browser uses to open a WebRTC peer connection to
    // https://api.openai.com/v1/realtime?model=...
    resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${directKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          instructions: sessionInstructions,
          tools: realtimeTools,
          tool_choice: "auto",
          audio: {
            output: { voice: "alloy" },
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // Log internal exception detail server-side; return only a stable code to the client.
    logger.error({ err: (e as Error)?.message }, "realtime_mint_network_error");
    return {
      configured: true,
      mode: "degraded_gpt_audio_fallback",
      reason: "REALTIME_PROVIDER_UNREACHABLE",
      safety,
    };
  }
  if (!resp.ok) {
    let upstreamBody = "";
    try { upstreamBody = (await resp.text()).slice(0, 500); } catch { /* ignore */ }
    // Server-only diagnostic. Body is OpenAI's error envelope (never contains our key).
    logger.error({ status: resp.status, upstreamBody }, "realtime_mint_bad_status");
    return {
      configured: true,
      mode: "degraded_gpt_audio_fallback",
      reason: "REALTIME_PROVIDER_REJECTED",
      safety,
    };
  }
  // GA shape: { value: "ek_...", expires_at: <unix>, session: { model, ... } }
  // Legacy Beta shape (kept as fallback parser): { client_secret: { value, expires_at }, model }
  let json: {
    value?: string;
    expires_at?: number;
    session?: { model?: string };
    client_secret?: { value: string; expires_at: number };
    model?: string;
  };
  try { json = (await resp.json()) as typeof json; }
  catch {
    return { configured: true, mode: "degraded_gpt_audio_fallback", reason: "REALTIME_INVALID_RESPONSE", safety };
  }
  const csValue = json.value ?? json.client_secret?.value;
  const csExpires = json.expires_at ?? json.client_secret?.expires_at;
  if (!csValue || typeof csExpires !== "number") {
    return { configured: true, mode: "degraded_gpt_audio_fallback", reason: "REALTIME_NO_CLIENT_SECRET", safety };
  }

  return {
    configured: true,
    mode: "true_webrtc_realtime",
    clientSecret: { value: csValue, expiresAt: csExpires },
    model: json.session?.model ?? json.model ?? REALTIME_MODEL,
    expiresInSeconds: SESSION_MAX_DURATION_SECONDS,
    toolCount: realtimeTools.length,
    rateRemaining: rate.remaining,
    safety,
  };
}

export function getVoiceModeStatus(): {
  realtimeConfigured: boolean;
  currentMode: "true_webrtc_realtime_available" | "degraded_gpt_audio" | "text_only";
  notes: string;
} {
  const directKey = process.env["OPENAI_API_KEY"];
  if (directKey && directKey.trim().length > 0) {
    return {
      realtimeConfigured: true,
      currentMode: "true_webrtc_realtime_available",
      notes: "Direct OPENAI_API_KEY detected. True WebRTC Realtime can be activated per session. Degraded gpt-audio remains as fallback.",
    };
  }
  return {
    realtimeConfigured: false,
    currentMode: "degraded_gpt_audio",
    notes: "Direct OPENAI_API_KEY not set. Voice runs in degraded gpt-audio mode through the Replit AI Integrations proxy. Set OPENAI_API_KEY to enable true WebRTC Realtime.",
  };
}
