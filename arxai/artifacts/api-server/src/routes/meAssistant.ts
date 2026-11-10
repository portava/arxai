// Phase 13 — ARX AI Live Assistant routes.
// SAFETY: requireUser; every conversation/message/tool call scoped by
// req.authUser.id. The assistant cannot place trades, modify connections,
// reveal secrets, or read another user's data. Streaming uses SSE.
//
// Endpoints:
//   GET  /api/me/assistant/conversations            list user's conversations
//   POST /api/me/assistant/conversations            create
//   GET  /api/me/assistant/conversations/:id        get with messages
//   GET  /api/me/assistant/conversations/:id/messages   list messages
//   POST /api/me/assistant/conversations/:id/messages   SSE stream chat reply
//   POST /api/me/assistant/conversations/:id/voice     SSE stream voice reply
//   GET  /api/me/assistant/tools                    list tool definitions
//   GET  /api/me/assistant/market-status            market provider status

import { recordIssuedProjection } from "../lib/data/chart/renderEvidence.js";
import { readOpenPositions } from "../lib/positions/openPositions.js";
import express, { Router } from "express";
import multer from "multer";

// Phase 22D — voice uploads use multipart/form-data via multer with a
// route-scoped 20 MB ceiling. Keeps global express.json() at default size,
// so the rest of the API stays protected from oversized JSON payloads.
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});
import type { Request } from "express";
import {
  db,
  arxAssistantConversationsTable,
  arxAssistantMessagesTable,
  arxAssistantToolCallsTable,
  oneClickAuditTable,
  userOneClickSettingsTable,
  eleanorCommandsTable,
  eleanorWatchInstructionsTable,
  type EleanorCommandKind,
} from "@workspace/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { parseTradeCommand } from "../lib/assistant/parseTradeCommand.js";
import type { InstantTradeIntent } from "../lib/live/instantTrade.js";
import { MAX_ACTIVE_ELEANOR_WATCHES, ownBridgePriceOf, recordAndExecuteEleanor, eleanorWatchPermissionBlock } from "../lib/assistant/eleanorExecution.js";
import { currentFeedScopeBridge } from "../lib/data/feedScope.js";
import { cancelScope, isCloseAlertAnswer, pickWatchesToCancel } from "../lib/assistant/eleanorAlertAnswers.js";
import { evaluateEleanorWatchesForUser, acknowledgeEleanorWatch, listEleanorWatches, setEleanorWatchFakeoutAuthority } from "../lib/assistant/eleanorWatchEvaluator.js";
import { isSweeperEnabled, getEleanorSweeperStatus } from "../lib/assistant/eleanorWatchSweeper.js";
import { parseMonitorState, emptyMonitorState, serializeMonitorState, setFakeoutAuthority } from "../lib/assistant/eleanorMonitorPolicy.js";
import { chatMessageLimiter, conversationCreateLimiter, tradeCommandLimiter, rateLimitBody } from "../lib/assistant/chatRateLimit.js";
import { runChatTurnLoop, type ChatMessage } from "../lib/assistant/chatTurnLoop.js";
import { analyzeChartStructure, readHigherTimeframeBias, type StructureBias } from "../lib/assistant/chartStructure.js";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { chatProviderConfigured, streamToolChat, voiceAudio } from "../lib/ai/llmGateway.js";
import {
  TOOL_DEFINITIONS, dispatchTool, classifyIntent,
  setRequestPageContext,
  detectChartReadIntent, detectTradeOptionsIntent,
} from "../lib/assistant/tools.js";
import {
  deriveAssistantEnvelope,
  assistantEnvelopeFields,
  FAIL_CLOSED_ENVELOPE,
  READ_ONLY_PAPER_ENVELOPE,
} from "../lib/assistant/derivedEnvelope.js";
import { buildSessionSystemMessages, type PageContext } from "../lib/assistant/systemPrompt.js";
import { getAssistantDisplayName } from "../lib/assistant/assistantName.js";
import { getMarketStatus } from "../lib/assistant/marketProvider.js";
import { buildEleanorContext, composeEleanorBriefing, type EleanorRole } from "../lib/assistant/eleanorContext.js";
import { resolveAssistantMarket } from "../lib/markets/assistantMarketResolver.js";
import { buildChartIntelligenceState } from "../lib/data/chart/chartIntelligence.js";
import { type ChartTimeframe } from "../lib/data/chart/timeframes.js";
import { knownPricePrecision } from "../lib/data/chart/symbolProfile.js";
import { buildEleanorChartContext, buildGatedTrustLine, gatedReadReason } from "../lib/data/chart/eleanorChartContext.js";
import { buildEleanorStructuralRead } from "../lib/assistant/eleanorStructuralReadService.js";
import { buildDecisionSnapshot, recordDecisionSnapshot } from "../lib/data/chart/chartDecisionSnapshot.js";
import { buildEleanorDraftRead, type EleanorDraftIntent } from "../lib/assistant/eleanorDraftRead.js";
import { recordEleanorReadDecision } from "../lib/chart/recordEleanorRead.js";
import { classifySymbol } from "../lib/data/marketDataRouter.js";
import { getUserAllocationView } from "../lib/live/masterBridgePool.js";
import {
  buildSetupPreview,
  setupPreviewProviderSource,
  type SetupSide,
  type SetupPreviewProviderSource,
} from "../lib/assistant/setupPreview.js";
import { scoreLiveCandidates } from "../lib/assistant/liveScanner.js";
import { evaluateScalpForSymbol } from "../lib/scalp/scalpService.js";
import {
  assembleSetupSignals,
  type SetupSignals,
} from "../lib/assistant/setupSignals.js";
import { buildAaciSnapshot } from "../lib/aaci/snapshotService.js";
import { buildAaciDecision } from "../lib/aaci/decisionService.js";
import { aaciRecommendedActionLabel, aaciCohesionTone } from "@workspace/domain/aaci";
import { scrubUserCopyDeep } from "@workspace/domain/security";
import { neutralizeFeedCopyDeep } from "../lib/honesty/feedTruthCopy.js";
import { recordSignalOnAppear } from "../lib/eleanorQuality/index.js";
import { mintRealtimeSession, getVoiceModeStatus, VOICE_NO_TOOLS_INSTRUCTION } from "../lib/assistant/realtimeSession.js";
import { gateVoiceTurn } from "../lib/assistant/voice/speechGate.js";
import { openVerifiedSpeechTurn, recordVerifiedSpeechSource } from "../lib/assistant/voice/speechLedger.js";
import { voiceCommandDecision } from "../lib/assistant/voice/voiceCommandPolicy.js";
import { computeEleanorSignalAdvisory, recordAdvisoryTrace } from "../lib/agentEcosystem/advisoryInfluence.js";
import {
  computeSurfaceGovernance,
  maybeRecordDisagreement,
  runTrafficSelection,
  toUserGovernance,
  recordGovernanceTrace,
  persistGovernanceTrace,
} from "../lib/agentEcosystem/governance.js";
import {
  loadVerifiedMemory, getConversationPendingAction, setConversationPendingAction,
  getRecentToolResults, formatMemoryForSystemPrompt, summarizeIfNeeded,
  extractPromiseFromAssistantText, pushUnresolvedAction, resolveUnresolvedAction,
  wipeAllUserMemory, setMemoryEnabled, type PendingAction,
} from "../lib/assistant/memoryStore.js";

const router = Router();

// Eleanor's REPORTED safety state is DERIVED per-user (honest both ways) — never a
// hardcoded paper-only stub that drifts from reality. The shared helper is
// fail-closed: any envelope read failure collapses to FAIL_CLOSED_ENVELOPE
// (off / locked). Advisory / reporting only — this changes what Eleanor *says*,
// never what it is *allowed to do* (order-guard chain + 16-gate Phase B dispatch
// + the explicit per-trade confirmation choreography are untouched).
async function buildPerUserEnvelope(userId: number | null | undefined) {
  return assistantEnvelopeFields(await deriveAssistantEnvelope(userId ?? null));
}

// Synchronous fail-closed envelope fields for error responses (err() can't await).
const FAIL_CLOSED_FIELDS = assistantEnvelopeFields(FAIL_CLOSED_ENVELOPE);
const MAX_TURNS_PER_REQUEST = 4;
// Shown when the tool loop produced no answer text (AICS-4).
export const EMPTY_REPLY_MESSAGE = "I ran out of steps before I could answer — please ask again, a bit more narrowly.";
// Audit A9: tool results handed to the model are bounded but stay valid JSON.
const TOOL_RESULT_MODEL_CHARS = 8000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_USER_MESSAGE_CHARS = 4000;
const MODEL = "gpt-5.4";

function err(res: import("express").Response, status: number, message: string) {
  res.status(status).json({ error: message, ...FAIL_CLOSED_FIELDS });
}

// Task #412 — Top-250 universe gate for Eleanor's READ-ONLY chart surfaces.
// Resolves the requested symbol against the approved universe. When it is NOT
// an approved market, respond with an honest, user-safe "not available" read
// (read-only envelope) and return true so the caller can stop. When ambiguous,
// surface the Top-250-scoped clarification. This is a visibility/resolution
// layer only — it never touches execution routing or any safety gate.
async function gateAssistantSymbolOr(
  res: import("express").Response,
  userId: number | null | undefined,
  symbol: string,
  timeframe: string,
): Promise<boolean> {
  const r = resolveAssistantMarket(symbol);
  if (r.status === "resolved" || r.status === "empty") return false;
  const envelope = await buildPerUserEnvelope(userId ?? null);
  const headline = r.status === "ambiguous"
    ? (r.userMessage ?? "Which market did you mean?")
    : (r.userMessage ?? "That market is not available in ARX right now.");
  res.json({
    chartRead: scrubUserCopyDeep({
      symbol,
      timeframe,
      gated: true,
      basis: "INSUFFICIENT",
      headline,
      trustLine: headline,
      blockedReason: headline,
      // READABILITY CONTRACT: the symbol-resolution gate is not a data-sufficiency
      // event, so there is no shared reasonCode to emit here.
      reasonCode: null,
      chartTruthScore: null,
      chartReadScore: null,
      hasFormingCandle: false,
      dataQuality: "insufficient",
      candidates: r.candidates,
      disclaimer: "Decision support only — confirm live readiness and risk before trading.",
    }),
    ...envelope,
    readOnlyMode: true,
  });
  return true;
}
function safe(h: (req: import("express").Request, res: import("express").Response) => Promise<void>) {
  return async (req: import("express").Request, res: import("express").Response) => {
    try { await h(req, res); }
    catch (e) {
      try { (req as { log?: { error: (...a: unknown[]) => void } }).log?.error({ err: (e as Error)?.message }, "assistant_route_failure"); } catch { /* noop */ }
      if (!res.headersSent) err(res, 500, "assistant_failed");
      else { try { res.end(); } catch { /* noop */ } }
    }
  };
}

const CreateConvBody = z.object({ title: z.string().min(1).max(200).optional() });
const PageContextBody = z.object({
  pathname: z.string().min(1).max(200),
  label: z.string().max(200).optional().nullable(),
  // Task #602 follow-on — the symbol/timeframe currently on the user's chart, so
  // a chat chart-read can default to what they're viewing. Display-only context.
  chartSymbol: z.string().max(40).optional().nullable(),
  chartTimeframe: z.string().max(12).optional().nullable(),
});
const SendMessageBody = z.object({
  content: z.string().min(1).max(MAX_USER_MESSAGE_CHARS),
  voiceMode: z.enum(["off", "listening", "speaking"]).optional(),
  pageContext: PageContextBody.optional().nullable(),
});

// ── tools list (for UI) ──────────────────────────────────────────────────
router.get("/me/assistant/tools", requireUser, async (req, res) => {
  res.json({ tools: TOOL_DEFINITIONS, count: TOOL_DEFINITIONS.length, ...(await buildPerUserEnvelope(req.authUser?.id)) });
});

// ── market provider status ───────────────────────────────────────────────
router.get("/me/assistant/market-status", requireUser, async (req, res) => {
  res.json({ ...getMarketStatus(), ...(await buildPerUserEnvelope(req.authUser?.id)) });
});

// ── voice mode status (for UI badge) ─────────────────────────────────────
router.get("/me/assistant/voice-status", requireUser, async (req, res) => {
  res.json({ ...getVoiceModeStatus(), ...(await buildPerUserEnvelope(req.authUser?.id)) });
});

// ── Phase 22H: AI provider status (no secrets) ───────────────────────────
// Reports whether the AI provider is wired server-side. The actual key
// (AI_INTEGRATIONS_OPENAI_API_KEY) is NEVER returned and never logged here.
// `connected` mirrors `configured`: we do not probe the upstream API on every
// request (avoids unnecessary token spend), so we only claim connectivity
// when the key is present and the in-process openai client was constructed.
router.get("/me/assistant/provider-status", requireUser, async (req, res) => {
  const directKey = process.env["OPENAI_API_KEY"];
  const configured = chatProviderConfigured();
  res.json({
    provider: configured ? "openai" : "none",
    configured,
    connected: configured,
    model: configured ? MODEL : null,
    streamingEnabled: configured,
    toolCallingEnabled: configured,
    realtimeWebRtcConfigured: Boolean(directKey && directKey.trim().length > 0),
    keysExposed: false as const,
    lastCheckedAt: new Date().toISOString(),
    notes: configured
      ? "AI provider is wired via Replit AI Integrations (server-only). Streaming + tool calling enabled."
      : "AI provider is not configured. Set AI_INTEGRATIONS_OPENAI_API_KEY as a server secret. The assistant will report unavailable until then.",
    ...(await buildPerUserEnvelope(req.authUser?.id)),
  });
});

// ── T023: context-aware Eleanor briefing ────────────────────────────────────
// Replaces the static repeated greeting. Builds a compact, plain-English
// briefing from REAL app state only (live bridge, MT5 snapshot for owner/
// admin, ARX allocation, market session, selected-symbol tradability, open
// positions, recent performance, connected-only news/calendar). Never
// fabricates data; never leaks internals; never gates execution.
const BriefingQuery = z.object({
  page: z.string().max(200).optional(),
  symbol: z.string().max(64).optional(),
});
router.get("/me/assistant/briefing", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const rawRole = String(req.authUser?.role ?? "USER").toUpperCase();
  const role: EleanorRole = rawRole === "OWNER" ? "OWNER" : rawRole === "ADMIN" ? "ADMIN" : "USER";
  const parsed = BriefingQuery.safeParse(req.query);
  const page = parsed.success ? (parsed.data.page ?? "/") : "/";
  const symbol = parsed.success ? (parsed.data.symbol ?? null) : null;
  const assistantName = await getAssistantDisplayName(userId);
  try {
    const ctx = await buildEleanorContext(userId, role, page, symbol);
    const briefing = composeEleanorBriefing(ctx);
    // The briefing is composed from real ARX state, so it may be read aloud
    // with its figures (the TTS route checks speech against this ledger).
    recordVerifiedSpeechSource(userId, [briefing.headline, ...briefing.lines].join("\n"));
    res.json({ briefing, ...(await buildPerUserEnvelope(userId)) });
  } catch (e) {
    try { req.log?.error({ err: (e as Error)?.message }, "eleanor_briefing_failed"); } catch { /* noop */ }
    // Honest, internals-free fallback so the panel always opens cleanly.
    res.json({
      briefing: {
        headline: `Hi — I'm ${assistantName}. I'm here when you're ready.`,
        lines: [],
        setupGuidance: null,
        suggestions: [
          { label: "Scan live setups", prompt: "Scan for high-probability live setups right now." },
          { label: "Explain my risk", prompt: "Explain my current risk limits in plain English." },
        ],
        updatedAt: new Date().toISOString(),
        mode: "ARX",
      },
      ...(await buildPerUserEnvelope(userId)),
    });
  }
}));

// ── true Realtime WebRTC session minter ──────────────────────────────────
// Returns { configured:false } when OPENAI_API_KEY is not set server-side.
// Never returns the direct OPENAI_API_KEY — only the short-lived ephemeral
// client_secret minted by OpenAI's /v1/realtime/sessions.
router.post("/me/assistant/realtime/session", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const result = await mintRealtimeSession(userId);
  res.json(result);
}));

// ── conversations ────────────────────────────────────────────────────────
router.get("/me/assistant/conversations", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select().from(arxAssistantConversationsTable)
    .where(eq(arxAssistantConversationsTable.userId, userId))
    .orderBy(desc(arxAssistantConversationsTable.updatedAt))
    .limit(50);
  res.json({ conversations: rows, isEmpty: rows.length === 0, ...(await buildPerUserEnvelope(userId)) });
}));

router.post("/me/assistant/conversations", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const rl = conversationCreateLimiter.check(String(userId));
  if (!rl.allowed) { res.status(429).set("Retry-After", String(rl.retryAfterSeconds)).json(rateLimitBody(rl)); return; }
  const parsed = CreateConvBody.safeParse(req.body);
  if (!parsed.success) { err(res, 400, "invalid_body"); return; }
  const title = parsed.data.title ?? "New chat";
  const inserted = await db.insert(arxAssistantConversationsTable)
    .values({ userId, title }).returning();
  res.status(201).json({ conversation: inserted[0], ...(await buildPerUserEnvelope(userId)) });
}));

router.get("/me/assistant/conversations/:id", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { err(res, 400, "invalid_id"); return; }
  const conv = await db.select().from(arxAssistantConversationsTable)
    .where(and(eq(arxAssistantConversationsTable.id, id), eq(arxAssistantConversationsTable.userId, userId)))
    .limit(1);
  if (conv.length === 0) { err(res, 404, "conversation_not_found"); return; }
  const messages = await db.select().from(arxAssistantMessagesTable)
    .where(and(eq(arxAssistantMessagesTable.conversationId, id), eq(arxAssistantMessagesTable.userId, userId)))
    .orderBy(asc(arxAssistantMessagesTable.createdAt))
    .limit(MAX_HISTORY_MESSAGES * 4);
  res.json({ conversation: conv[0], messages, ...(await buildPerUserEnvelope(userId)) });
}));

router.get("/me/assistant/conversations/:id/messages", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { err(res, 400, "invalid_id"); return; }
  // Per-user isolation: confirm the conversation belongs to this user
  // before listing its messages. Returns 404 (not 200 + empty) for
  // any other user's id, matching the POST handler's behavior.
  const convOwned = await db.select({ id: arxAssistantConversationsTable.id })
    .from(arxAssistantConversationsTable)
    .where(and(eq(arxAssistantConversationsTable.id, id), eq(arxAssistantConversationsTable.userId, userId)))
    .limit(1);
  if (convOwned.length === 0) { err(res, 404, "conversation_not_found"); return; }
  const messages = await db.select().from(arxAssistantMessagesTable)
    .where(and(eq(arxAssistantMessagesTable.conversationId, id), eq(arxAssistantMessagesTable.userId, userId)))
    .orderBy(asc(arxAssistantMessagesTable.createdAt))
    .limit(MAX_HISTORY_MESSAGES * 4);
  res.json({ messages, isEmpty: messages.length === 0, ...(await buildPerUserEnvelope(userId)) });
}));

// ── Eleanor Setup Reason — scanner signal explanation ───────────────────────
// Small deterministic structured explanation used by the Market Scanner
// cards (and trade modal) under the heading "Eleanor's Setup Reason".
//
// Design notes:
//  - No LLM call. The scanner has already produced reasonForTrade /
//    reasonToAvoid / bias / confidence; Eleanor just rephrases them into a
//    hedged, user-friendly micro-summary. Predictable latency, free, and
//    no chance of the model hallucinating a "guaranteed trade".
//  - Language is hedged ("looks like a possible buy setup", "may favor
//    sellers") — never guaranteed/profit-certain. See acceptance criteria
//    item 4 in the scanner trade spec.
//  - Returns the user-scoped safety envelope so callers can confirm
//    liveLocked/allowOrderExecution remain enforced.
const explainSignalSchema = z.object({
  symbol: z.string().min(1).max(64),
  timeframe: z.string().min(1).max(10).optional(),
  recommendedAction: z.string().min(1).max(20),
  bias: z.string().min(1).max(40),
  confidenceScore: z.number().min(0).max(100).optional(),
  riskScore: z.number().min(0).max(100).optional(),
  entrySniperScore: z.number().min(0).max(100).optional(),
  reasonForTrade: z.string().max(500).optional(),
  reasonToAvoid: z.string().max(500).optional(),
  setupType: z.string().max(80).optional(),
  entry: z.number().optional(),
  stopLoss: z.number().optional(),
  takeProfit: z.number().optional(),
  statusBadge: z.string().max(60).optional(),
});
// Eleanor AACI advisory block — a clean, plain-English cohesion read attached to
// Eleanor's signal/chart explanations. READ-ONLY and fail-open: any error returns
// null and Eleanor's read is unchanged. Never leaks machine codes or sub-scores.
async function buildEleanorAaciBlock(
  userId: number | null | undefined,
  symbol: string,
  timeframe: string | null | undefined,
): Promise<{
  verdict: string;
  explanation: string;
  followUps: string[];
  tone: ReturnType<typeof aaciCohesionTone>;
} | null> {
  if (!userId || userId <= 0) return null;
  try {
    const snapshot = await buildAaciSnapshot({
      userId,
      role: "user",
      symbol,
      timeframe: timeframe ?? undefined,
    });
    const decision = await buildAaciDecision({
      snapshot,
      userId,
      actorType: "eleanor",
      actionRequested: "EVALUATE",
      symbol,
      timeframe: timeframe ?? undefined,
    });
    return {
      verdict: aaciRecommendedActionLabel(decision.recommendedAction),
      explanation: decision.userFacingExplanation,
      followUps: decision.requiredFollowUps,
      tone: aaciCohesionTone(decision.recommendedAction),
    };
  } catch {
    // Advisory only — never fail Eleanor's read on an AACI hiccup.
    return null;
  }
}

router.post("/me/assistant/explain-signal", requireUser, safe(async (req, res) => {
  const parsed = explainSignalSchema.safeParse(req.body ?? {});
  if (!parsed.success) { err(res, 400, "invalid_body"); return; }
  const s = parsed.data;
  const side: "BUY" | "SELL" | "NEUTRAL" =
    s.recommendedAction.toUpperCase() === "BUY" ? "BUY" :
    s.recommendedAction.toUpperCase() === "SELL" ? "SELL" : "NEUTRAL";
  const conf = s.confidenceScore ?? 0;
  const confidenceLabel = conf >= 75 ? "High" : conf >= 50 ? "Medium" : conf >= 25 ? "Low" : "Very Low";
  const hedge = side === "BUY"
    ? "This looks like a possible buy setup."
    : side === "SELL"
    ? "This setup may favor sellers."
    : "No clear directional edge right now — consider waiting for confirmation.";
  // Build a short "why" — keep it small and clear. Source data comes from
  // the scanner; Eleanor just reshapes it.
  const whyParts: string[] = [];
  if (s.setupType) whyParts.push(s.setupType);
  if (s.reasonForTrade) whyParts.push(s.reasonForTrade);
  const why = whyParts.join(" — ").slice(0, 220) || "Scanner detected a tradable structure on the current timeframe.";
  const risk = s.reasonToAvoid
    ? s.reasonToAvoid.slice(0, 180)
    : s.stopLoss != null
    ? `Setup weakens if price closes ${side === "SELL" ? "above" : "below"} ${s.stopLoss}.`
    : "Setup weakens if momentum stalls or structure breaks against the bias.";
  const possibleTpArea = s.takeProfit != null
    ? `Around ${s.takeProfit}`
    : "Wait for the scanner to publish a target before sizing.";
  const suggestedStopArea = s.stopLoss != null
    ? `Near ${s.stopLoss}`
    : "Place beyond the most recent swing against your bias.";
  const invalidation = s.stopLoss != null
    ? `Idea invalidates ${side === "SELL" ? "above" : "below"} ${s.stopLoss}.`
    : "Idea invalidates if price closes through the opposing structure.";
  const cautions: string[] = [];
  if ((s.riskScore ?? 0) >= 70) cautions.push("Volatility risk elevated — size smaller.");
  if (conf < 50) cautions.push("Confidence is not high — wait for confirmation if momentum is weak.");
  if (s.statusBadge && /SPREAD|CHOPPY|REJECT|LOW_OPPORTUNITY/i.test(s.statusBadge)) {
    cautions.push(`Scanner flagged ${s.statusBadge.replace(/_/g, " ").toLowerCase()}.`);
  }

  // Agent Ecosystem advisory (Phase 0). Eleanor surfaces, in plain English, how the
  // desk's trusted agents weigh in on this read — and folds any agent cautions
  // (e.g. a trusted Risk agent pushing back) into the existing caution list.
  // Advisory only: it never changes liveLocked / allowOrderExecution and never
  // gates a trade. Fail-open: any error leaves Eleanor's read unchanged.
  let deskView: string | null = null;
  try {
    const advisory = await computeEleanorSignalAdvisory({
      baseScore: conf,
      direction: side,
      confidenceScore: conf,
      riskScore: s.riskScore ?? 0,
    });
    if (advisory && advisory.influencingAgentCount > 0) {
      deskView = advisory.summary;
      for (const c of advisory.cautions) if (!cautions.includes(c)) cautions.push(c);
      recordAdvisoryTrace({
        surface: "RISK", symbol: s.symbol, timeframe: s.timeframe ?? null,
        direction: side, at: new Date().toISOString(), result: advisory,
      });
      // Layer 3 governance — the Court reviews the desk's advisory read and emits
      // a bounded, PROTECTIVE plain-English outcome. Eleanor surfaces the headline +
      // any agent push-backs as cautions. Read-only: it never changes liveLocked /
      // allowOrderExecution and never gates a trade. Fail-open within this try.
      const traffic = await runTrafficSelection("ELEANOR", "LOW");
      const review = computeSurfaceGovernance({
        surface: "ELEANOR",
        direction: side,
        importance: "LOW",
        advisory,
        context: { riskScore: s.riskScore ?? 0 },
        traffic: traffic.summary,
        allowedAgentKeys: traffic.participants.map((p) => p.agentKey),
      });
      if (review && review.governanceApplied) {
        const userGov = toUserGovernance(review);
        deskView = `${userGov.headline} ${userGov.detail}`.trim();
        for (const c of userGov.cautions) if (!cautions.includes(c)) cautions.push(c);
        recordGovernanceTrace({
          surface: "ELEANOR", symbol: s.symbol, timeframe: s.timeframe ?? null,
          direction: side, at: new Date().toISOString(), review,
        });
        // Agent Court auto-wiring — record a Court learning entry on a genuine
        // disagreement (fire-and-forget) and stamp the trace. Read-only; never live.
        const disagreementCourtUsed = maybeRecordDisagreement(review, {
          symbol: s.symbol, timeframe: s.timeframe ?? "—", tradeType: "intraday",
        });
        // Durable proof (fail-soft, fire-and-forget — never blocks Eleanor's read).
        void persistGovernanceTrace({
          actionType: "ELEANOR_ANALYSIS", surface: "ELEANOR",
          userId: req.authUser?.id ?? null, role: req.authUser?.role ?? null,
          symbol: s.symbol, timeframe: s.timeframe ?? null,
          review, participants: traffic.participants,
          consideredKeys: traffic.consideredKeys, eleanorSummaryUsed: true,
          disagreementCourtUsed,
        });
      }
    }
  } catch { /* advisory + governance are best-effort; never fail Eleanor's read */ }

  // Chart Brain v2 (Task 5): record an immutable Decision Receipt + chart events
  // for this official Eleanor signal explanation. Fire-and-forget, fail-open, Slow
  // Brain. Only when a timeframe is present (a fingerprint needs one — we never
  // fabricate context).
  if (req.authUser?.id != null && s.timeframe) {
    recordEleanorReadDecision({
      userId: req.authUser.id,
      source: "eleanor_explain_signal",
      intent: "analyze",
      direction: side,
      symbol: s.symbol,
      timeframe: s.timeframe,
    });
    // Task #199 — Outcome Learning: track this Eleanor signal the moment it
    // appears, locking its "at signal" snapshot. Fire-and-forget, fail-open:
    // never block or fail Eleanor's read. OBSERVATION ONLY — places nothing.
    void recordSignalOnAppear({
      userId: req.authUser.id,
      symbol: s.symbol,
      timeframe: s.timeframe,
      direction: side,
      decision: side === "NEUTRAL" ? "observe" : "approve",
      confidenceScore: conf,
      entryPrice: s.entry ?? null,
      stopLoss: s.stopLoss ?? null,
      takeProfit: s.takeProfit ?? null,
      explanationUsed: true,
    }).catch(() => { /* outcome tracking is best-effort; never fail Eleanor's read */ });

    // Phase 3 — Chart Decision Snapshot: capture the point-in-time chart
    // state at this serious read moment (truth score, read score, gate output,
    // broker alignment, latest candle ref). Fire-and-forget, fail-open — never
    // blocks Eleanor's response. Provides a replay-honesty anchor for the read.
    void buildChartIntelligenceState(s.symbol, s.timeframe as ChartTimeframe, 300).then((intel) => {
      const verifiedCandleRef = intel.latestClosedCandle
        ? {
            openTime: intel.latestClosedCandle.openTime,
            closeTime: intel.latestClosedCandle.closeTime,
            close: intel.latestClosedCandle.close,
            isComplete: intel.latestClosedCandle.isComplete,
          }
        : null;
      const plan = s.entry != null && s.stopLoss != null && (side === "BUY" || side === "SELL")
        ? { side, entry: s.entry, sl: s.stopLoss, tp: s.takeProfit ?? null }
        : null;
      const snapshot = buildDecisionSnapshot({
        symbol: intel.symbol,
        displaySymbol: intel.displaySymbol,
        timeframe: intel.timeframe,
        chartTruthScore: intel.chartTruthScore,
        chartReadScore: intel.chartReadScore,
        gateOutput: intel.gateOutput,
        brokerAlignment: intel.brokerAlignment,
        verifiedCandleRef,
        plan,
        source: "eleanor_explain_signal",
      });
      recordDecisionSnapshot(req.authUser!.id, snapshot);
    }).catch(() => { /* snapshot capture is best-effort; never fail Eleanor's read */ });
  }
  const [envelope, aaci] = await Promise.all([
    buildPerUserEnvelope(req.authUser?.id ?? null),
    buildEleanorAaciBlock(req.authUser?.id ?? null, s.symbol, s.timeframe ?? null),
  ]);
  res.json({
    // Defence in depth — scrub any backend internals (gate codes, env names,
    // route paths, secret shapes) from the regular-user narrative.
    setupReason: scrubUserCopyDeep({
      bias: side,
      hedge,
      why,
      risk,
      invalidation,
      possibleTpArea,
      suggestedStopArea,
      confidenceLabel,
      confidenceScore: conf,
      cautions,
      deskView,
      disclaimer: "Decision support only — confirm live readiness and risk before trading.",
    }),
    ...(aaci ? { aaci } : {}),
    ...envelope,
    readOnlyMode: true,
  });
}));

// ── Eleanor chart read — structural, plain-English market-structure read ─────
// SAFETY: read-only. Computes a deterministic structural read from the REAL
// candles the chart is showing (never fabricated). Identifies higher-timeframe
// bias and gives conditional buy/sell triggers; never forces a trade when
// confidence is low. Returns the per-user safety envelope so callers confirm
// liveLocked / allowOrderExecution remain enforced.
const readChartSchema = z.object({
  symbol: z.string().min(1).max(64),
  timeframe: z.string().min(1).max(10),
  // Client-observed Level 3 feed verdict at the moment the user asked for the
  // read (true only when the chart feed is clean/confirmed). Advisory only — the
  // server still runs its own authoritative gate via buildEleanorChartContext. When
  // the client reports `false`, we additionally stamp the read as
  // `dataQuality: "insufficient"` so the caveat surfaces even if the backend
  // gate happened to pass.
  aiUsable: z.boolean().optional(),
  draft: z
    .object({
      side: z.enum(["BUY", "SELL"]),
      entry: z.number(),
      sl: z.number(),
      tp: z.number(),
    })
    .nullish(),
});
router.post("/me/assistant/read-chart", requireUser, safe(async (req, res) => {
  const parsed = readChartSchema.safeParse(req.body ?? {});
  if (!parsed.success) { err(res, 400, "invalid_body"); return; }
  const { symbol, timeframe, draft } = parsed.data;
  // Task #412 — only approved Top 250 markets are readable.
  if (await gateAssistantSymbolOr(res, req.authUser?.id ?? null, symbol, timeframe)) return;
  // Honesty: when the client's own chart feed was NOT confirmed at read-time
  // (aiUsable === false), every read this request produces must surface the
  // "insufficient" caveat — even on the verified branch.
  const clientFeedUnconfirmed = parsed.data.aiUsable === false;

  const outcome = await buildEleanorStructuralRead({
    symbol,
    timeframe,
    draft: draft ?? null,
    clientFeedUnconfirmed,
    userId: req.authUser?.id ?? null,
    assistantName: req.authUser?.id != null ? await getAssistantDisplayName(req.authUser.id) : undefined,
  });
  // Chart Brain v2 (Task 5): record an immutable Decision Receipt for an official
  // chart read. Fire-and-forget, fail-open, Slow Brain. Only the FULL and
  // STRUCTURAL_ONLY reads record a decision (INSUFFICIENT / unsupported do not),
  // preserving the inline pipeline's behavior before this extraction.
  if (outcome.shouldRecordReadDecision && req.authUser?.id != null) {
    recordEleanorReadDecision({
      userId: req.authUser.id,
      source: "chart_read",
      intent: "analyze",
      direction: outcome.recordDirection,
      symbol,
      timeframe: outcome.normalizedTimeframe ?? timeframe,
    });
  }
  // Envelope + AACI + the read-only stamp are owned by the route (not the shared
  // service), so the response shape stays identical across every read layer.
  const [envelope, aaci] = await Promise.all([
    buildPerUserEnvelope(req.authUser?.id ?? null),
    buildEleanorAaciBlock(req.authUser?.id ?? null, symbol, outcome.normalizedTimeframe ?? timeframe),
  ]);
  res.json({
    chartRead: outcome.chartRead,
    // The service's own read layer, beside chartRead, so the Scanner panel and
    // the chat tool (tools.ts forwards outcome.readLayer) share one source.
    // Display-only; the client may only use it to DOWNGRADE a missing layer.
    readLayer: outcome.readLayer,
    ...(aaci ? { aaci } : {}),
    ...envelope,
    readOnlyMode: true,
  });
}));

// ── Task #374: Eleanor/AI Setup-Preview ("draw a setup on the chart") ───────
// READ-ONLY. Produces a SETUP DRAWING (entry/SL/TP, risk/reward zones,
// invalidation, confidence, setup-type, plain-English explanation) for the
// symbol/timeframe on screen. A preview is a visual reasoning aid — it is NEVER
// an order and this endpoint can never place, modify, or close a trade. It
// reuses the SAME verified EleanorChartContext honesty gate as read-chart (no
// directional setup is drawn unless basis === "VERIFIED") and feeds the
// deterministic, pure setup-preview producer with REAL data only.
const drawSetupSchema = z.object({
  symbol: z.string().min(1).max(64),
  timeframe: z
    .enum([
      "M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30",
      "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1",
    ])
    .default("M15"),
  // The client's own Level-3 feed verdict at draw-time. When false, the read is
  // stamped insufficient so the preview refuses a confident tradeable drawing.
  aiUsable: z.boolean().optional(),
  // Optional requested side; when omitted the side is resolved from structure.
  side: z.enum(["BUY", "SELL"]).nullish(),
  draft: z
    .object({
      side: z.enum(["BUY", "SELL"]),
      entry: z.number(),
      sl: z.number(),
      tp: z.number(),
    })
    .nullish(),
});
router.post("/me/assistant/draw-setup", requireUser, safe(async (req, res) => {
  const parsed = drawSetupSchema.safeParse(req.body ?? {});
  if (!parsed.success) { err(res, 400, "invalid_body"); return; }
  const { symbol, timeframe, side, draft } = parsed.data;
  const clientFeedUnconfirmed = parsed.data.aiUsable === false;

  // Same canonical, gate-checked chart context as read-chart. Fail-safe to a
  // null context (→ INSUFFICIENT basis → the producer refuses a drawing).
  let eleanorCtx: Awaited<ReturnType<typeof buildEleanorChartContext>> | null = null;
  try {
    eleanorCtx = await buildEleanorChartContext(symbol, timeframe as ChartTimeframe, 200, { userId: req.authUser?.id });
  } catch {
    // fail-safe — handled as a gated (non-VERIFIED) read below.
  }

  const candles = eleanorCtx?.candles ?? [];
  const htfTimeframe = eleanorCtx?.htfTimeframe ?? null;
  const htfBias: StructureBias | null = readHigherTimeframeBias(eleanorCtx?.htfCandles, htfTimeframe);
  const read = analyzeChartStructure(candles, { htfBias, htfTimeframe, draft: draft ?? null, pricePrecision: knownPricePrecision(symbol) });
  if (clientFeedUnconfirmed) {
    read.dataQuality = "insufficient";
    if (!read.cautions.includes("Feed not confirmed at draw-time — limited visibility.")) {
      read.cautions = [...read.cautions, "Feed not confirmed at draw-time — limited visibility."];
    }
  }

  const basis = eleanorCtx?.basis ?? "INSUFFICIENT";
  // HONESTY (same rule as draft-read and read-chart): a gated read never shows
  // the success-path "Verified … · Live feed …" line, which is composed from
  // raw gate flags and can disagree with the feed state that set the basis.
  const trustLine = eleanorCtx && basis === "VERIFIED"
    ? eleanorCtx.trustLine
    : buildGatedTrustLine(timeframe, {
        available: eleanorCtx != null,
        stale: eleanorCtx?.state.stale ?? false,
        aiUsable: eleanorCtx?.state.aiUsable ?? false,
        basis,
        quality: eleanorCtx?.state.truthState?.quality ?? null,
        notLiveReason: eleanorCtx?.state.truthState?.notLiveReason ?? null,
      });
  // Name what is actually not confirmed (feed, candles, or the specific chart
  // check) so the refusal never says "the feed isn't confirmed" when it is.
  const blockReason = gatedReadReason(eleanorCtx);

  // Provider honesty: name the source that actually served this series. Only
  // the MetaTrader 5 broker bridge is broker-native; any other (or unreported)
  // source is composite, and the producer then never uses broker-native language.
  const assetClass = classifySymbol(symbol);
  const providerSource: SetupPreviewProviderSource = setupPreviewProviderSource(
    assetClass,
    eleanorCtx?.state.truthState.source ?? null,
  );

  // Bridge + allocation truth (per-user). Allocation is used only to decide
  // whether account-currency risk can be shown — never to fabricate a number.
  let bridge:
    | { availability: "HEALTHY" | "RECONCILING" | "UNAVAILABLE"; message: string }
    | null = null;
  let availableAllocation: number | null = null;
  try {
    const view = await getUserAllocationView(req.authUser!.id);
    bridge = { availability: view.bridgeAvailability, message: view.bridgeMessage };
    availableAllocation = view.availableAllocation;
  } catch {
    // fail-open — bridge/allocation simply unknown; producer degrades honestly.
  }

  // Task #380 — assemble the richer real signals (live scanner score + per-symbol
  // risk score, flame/run-on momentum stage, and the agent-governance outcome) so
  // the drawn setup is confidence-calibrated, momentum-aware, and governance-aware.
  // Each signal is sourced from the SAME service the scanner/Eleanor/scalp/governance
  // surfaces already use — never a new fabricated input. On any failure or genuine
  // absence we pass null, which the pure producer treats as an honest "not
  // consulted" (no fabrication). We only consult these on a VERIFIED feed: a gated
  // read refuses a drawing regardless, so there's nothing to enrich there.
  let signals: SetupSignals = {
    scannerScore: null,
    riskScore: null,
    flameStage: null,
    runOnQuality: null,
    governanceOutcome: null,
    governanceCautions: [],
  };

  if (basis === "VERIFIED" && read.dataQuality === "ok") {
    const userId = req.authUser!.id;
    // All selection/banding/mapping + fail-open wiring lives in the pure
    // assembleSetupSignals helper (Task #381 — unit-tested in setupSignals).
    // Here we only inject the production data sources:
    //   - scoreLiveCandidates: live scanner score + per-symbol risk score
    //   - evaluateScalpForSymbol: flame stage + run-on quality
    //   - runGovernance: the SAME advisory → Traffic → Court flow the Eleanor
    //     explain-signal / chart-consensus surfaces use (advisory/shadow only;
    //     it never gates a trade and never changes the safety envelope).
    signals = await assembleSetupSignals(
      {
        symbol,
        timeframe,
        requestedSide: side,
        bias: read.bias,
        confidence: read.confidence,
      },
      {
        scoreLiveCandidates,
        evaluateScalpForSymbol: () =>
          evaluateScalpForSymbol(userId, { symbol, mode: "ANY" }),
        runGovernance: async ({ side: govSide, confNum, riskNum }) => {
          const advisory = await computeEleanorSignalAdvisory({
            baseScore: confNum,
            direction: govSide,
            confidenceScore: confNum,
            riskScore: riskNum,
          });
          if (!advisory || advisory.influencingAgentCount <= 0) return null;
          const traffic = await runTrafficSelection("ELEANOR", "LOW");
          const review = computeSurfaceGovernance({
            surface: "ELEANOR",
            direction: govSide,
            importance: "LOW",
            advisory,
            context: { riskScore: riskNum },
            traffic: traffic.summary,
            allowedAgentKeys: traffic.participants.map((p) => p.agentKey),
          });
          if (!review || !review.governanceApplied) return null;
          return { outcome: review.outcome, cautions: toUserGovernance(review).cautions };
        },
      },
    );
  }

  const {
    scannerScore,
    scannerTimeframe,
    scannerTimeframeBasis,
    scannerFallbackLabel,
    riskScore,
    flameStage,
    runOnQuality,
    governanceOutcome,
    governanceCautions,
  } = signals;

  const setupPreview = buildSetupPreview({
    symbol,
    displaySymbol: symbol,
    timeframe,
    requestedSide: (side as SetupSide | null | undefined) ?? null,
    read,
    candles,
    basis,
    trustLine,
    blockReason,
    providerSource,
    bridge,
    availableAllocation,
    scannerScore,
    scannerTimeframe,
    scannerTimeframeBasis,
    scannerFallbackLabel,
    riskScore,
    flameStage,
    runOnQuality,
    governanceOutcome,
    governanceCautions,
    createdBy: "eleanor",
  });

  // Chart Brain v2: record an immutable Decision Receipt for this official read.
  // Fire-and-forget, fail-open, Slow Brain — never awaited, never on the live path.
  if (req.authUser?.id != null) {
    recordEleanorReadDecision({
      userId: req.authUser.id,
      source: "chart_read",
      intent: "analyze",
      direction: (side ?? draft?.side) ?? null,
      symbol,
      timeframe,
      // The state this drawing was built from (enriched with the user's own
      // broker quote), so the receipt records the read the user saw.
      state: eleanorCtx?.state,
    });
  }

  // Unconditionally read-only — the compile-time fail-closed envelope
  // (paper_only / liveLocked / readOnlyMode / allowOrderExecution:false). A
  // drawing can never act regardless of the caller's live-trading permissions.
  // Honesty: a setup drawn over a non-clean feed must never carry confident
  // trade language. A gated read already refuses a drawing; this neutralises any
  // residual confident phrasing whenever the feed is not VERIFIED+clean.
  const drawFeedNotClean = basis !== "VERIFIED" || read.dataQuality !== "ok";
  const setupPreviewPayload = scrubUserCopyDeep(setupPreview);
  // Render Accuracy: remember the levels issued so the chart's drawn
  // projection can be checked against exactly this payload (renderEvidence.ts).
  if (req.authUser?.id != null) recordIssuedProjection(req.authUser.id, setupPreviewPayload);
  res.json({
    setupPreview: drawFeedNotClean
      ? neutralizeFeedCopyDeep(setupPreviewPayload)
      : setupPreviewPayload,
    ...READ_ONLY_PAPER_ENVELOPE,
  });
}));

// ── Chart Brain v2 (Task 4): Eleanor Draft Read ─────────────────────────────
// READ-ONLY. Assembles a deterministic prepared Eleanor read over the cached
// Chart Intelligence State for a fixed intent. No LLM, no provider re-probe,
// no execution. Per-user gated; the state itself carries no per-user data.
const draftReadSchema = z.object({
  symbol: z.string().min(1).max(64),
  timeframe: z
    .enum([
      "M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30",
      "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1",
    ])
    .default("M5"),
  limit: z.number().int().min(1).max(5000).default(300),
  intent: z.enum([
    "analyze",
    "is-this-a-buy",
    "is-this-a-scalp",
    "why-not-now",
    "what-changes-my-mind",
    "what-invalidates",
    "hold-or-close",
    "agent-consensus",
  ]),
  draft: z
    .object({
      side: z.enum(["BUY", "SELL"]),
      entry: z.number(),
      sl: z.number(),
      tp: z.number(),
    })
    .nullish(),
});
router.post("/me/assistant/draft-read", requireUser, safe(async (req, res) => {
  const parsed = draftReadSchema.safeParse(req.body ?? {});
  if (!parsed.success) { err(res, 400, "invalid_body"); return; }
  const { symbol, timeframe, limit, intent, draft } = parsed.data;

  // Build (or reuse the 3s-cached) EleanorChartContext — the SAME canonical chart
  // source POST /me/assistant/read-chart uses — so we have an honest `basis`
  // ("VERIFIED" | "PARTIAL" | "SYNCING" | "INSUFFICIENT") alongside the
  // intelligence state. The builder degrades to an honest empty/insufficient
  // context on a dirty feed and never fabricates; a build failure is treated as
  // gate-blocked (basis !== "VERIFIED") below.
  let eleanorCtx: Awaited<ReturnType<typeof buildEleanorChartContext>> | null = null;
  try {
    eleanorCtx = await buildEleanorChartContext(symbol, timeframe as ChartTimeframe, limit, { userId: req.authUser?.id });
  } catch {
    // fail-safe — treat as gate-blocked below
  }
  const state = eleanorCtx?.state ?? (await buildChartIntelligenceState(symbol, timeframe, limit));
  const draftAssistantName = req.authUser?.id != null ? await getAssistantDisplayName(req.authUser.id) : undefined;
  const draftRead = buildEleanorDraftRead(state, intent as EleanorDraftIntent, draft ?? null, draftAssistantName);
  // HONESTY (same pattern as the read-chart gated branch): when the read is
  // gated (basis !== "VERIFIED"), never let the success-path trust line claim
  // "Verified … · Live feed …". `buildEleanorDraftRead` composes its trustLine from
  // raw Phase-3 gate flags (buildTrustLine) which can disagree with the feed
  // truth that drives `basis` — e.g. every gate flag passes but the feed is
  // delayed (state.aiUsable === false), so basis is INSUFFICIENT while the line
  // still reads "Verified … · Live feed …". Derive a feed-state-driven gated
  // line from the ACTUAL feed state instead. Advisory-only: Eleanor stays
  // read-only and this never gates execution.
  if (!eleanorCtx || eleanorCtx.basis !== "VERIFIED") {
    draftRead.trustLine = buildGatedTrustLine(timeframe, {
      available: eleanorCtx != null,
      stale: eleanorCtx?.state.stale ?? state.stale,
      aiUsable: eleanorCtx?.state.aiUsable ?? state.aiUsable,
      basis: eleanorCtx?.basis ?? "INSUFFICIENT",
      quality: (eleanorCtx?.state ?? state).truthState?.quality ?? null,
      notLiveReason: (eleanorCtx?.state ?? state).truthState?.notLiveReason ?? null,
    });
  }
  // Chart Brain v2 (Task 5): record an immutable Decision Receipt + the implied
  // chart events for this official Eleanor read. Fire-and-forget, fail-open, Slow
  // Brain — never awaited, never blocks the read, never on the live path.
  if (req.authUser?.id != null) {
    recordEleanorReadDecision({
      userId: req.authUser.id,
      source: "eleanor_draft_read",
      intent,
      draftReadIntent: intent as EleanorDraftIntent,
      direction: draft?.side ?? null,
      symbol,
      timeframe,
      limit,
      state,
    });
  }
  // Eleanor's chart-read surface is unconditionally read-only. We return the
  // compile-time fail-closed envelope (paper_only / liveLocked / readOnlyMode /
  // allowOrderExecution:false) rather than the per-user trading envelope, so the
  // contract (safetyMode enum [paper_only]) is truthful and matches the sibling
  // GET /me/chart/intelligence endpoint. Eleanor can never act regardless of the
  // caller's live-trading permissions.
  res.json({
    draftRead,
    ...READ_ONLY_PAPER_ENVELOPE,
  });
}));

// ── Phase 22K: memory inspection + user controls ─────────────────────────
// GET memory snapshot (read-only). Returns long-term summary, trading style,
// preferences, unresolved actions — all scoped to req.authUser.id.
router.get("/me/assistant/memory", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const snap = await loadVerifiedMemory(userId);
  res.json({ memory: snap, ...(await buildPerUserEnvelope(userId)) });
}));

// DELETE all ARX memory for this user. Removes conversations, messages,
// tool calls, and the long-term memory row. Cannot affect other users.
router.delete("/me/assistant/memory", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const counts = await wipeAllUserMemory(userId);
  res.json({ ok: true, ...counts, ...(await buildPerUserEnvelope(userId)) });
}));

// Eleanor memory settings — flip the per-user long-term memory toggle.
// When disabled, the rolling summarizer is a no-op AND the system prompt
// stops injecting saved memory. Past chats remain queryable / exportable.
const MemorySettingsBody = z.object({ memoryEnabled: z.boolean() });
router.patch("/me/assistant/memory/settings", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const parsed = MemorySettingsBody.safeParse(req.body);
  if (!parsed.success) { err(res, 400, "invalid_body"); return; }
  await setMemoryEnabled(userId, parsed.data.memoryEnabled);
  const snap = await loadVerifiedMemory(userId);
  res.json({ ok: true, memoryEnabled: snap.memoryEnabled, ...(await buildPerUserEnvelope(userId)) });
}));

// Export all Eleanor chat history + memory snapshot for this user as JSON.
// Per-user scoped. No secrets, no other users' rows. Returns one bundle
// for the user to download / archive locally.
router.get("/me/assistant/export", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const convs = await db.select().from(arxAssistantConversationsTable)
    .where(eq(arxAssistantConversationsTable.userId, userId))
    .orderBy(asc(arxAssistantConversationsTable.createdAt));
  const msgs = await db.select().from(arxAssistantMessagesTable)
    .where(eq(arxAssistantMessagesTable.userId, userId))
    .orderBy(asc(arxAssistantMessagesTable.createdAt));
  const memory = await loadVerifiedMemory(userId);
  const assistantName = await getAssistantDisplayName(userId);
  const exportedAt = new Date().toISOString();
  res.setHeader("Content-Disposition", `attachment; filename="eleanor-export-${userId}-${exportedAt.slice(0,10)}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.json({
    schema: "arx.eleanor.export.v1",
    assistantName,
    userId,
    exportedAt,
    memory,
    conversations: convs.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      archivedAt: c.archivedAt,
      messages: msgs
        .filter((m) => m.conversationId === c.id)
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          intent: m.intent,
          createdAt: m.createdAt,
        })),
    })),
    ...(await buildPerUserEnvelope(userId)),
  });
}));

// DELETE a single conversation (and cascade its messages/tool calls).
// Long-term memory + other conversations are preserved.
router.delete("/me/assistant/conversations/:id", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { err(res, 400, "invalid_id"); return; }
  const owned = await db.select({ id: arxAssistantConversationsTable.id })
    .from(arxAssistantConversationsTable)
    .where(and(eq(arxAssistantConversationsTable.id, id), eq(arxAssistantConversationsTable.userId, userId)))
    .limit(1);
  if (owned.length === 0) { err(res, 404, "conversation_not_found"); return; }
  await db.delete(arxAssistantConversationsTable)
    .where(and(eq(arxAssistantConversationsTable.id, id), eq(arxAssistantConversationsTable.userId, userId)));
  res.json({ ok: true, deletedId: id, ...(await buildPerUserEnvelope(userId)) });
}));

// ── streaming text chat with tool calling ────────────────────────────────
router.post("/me/assistant/conversations/:id/messages", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { err(res, 400, "invalid_id"); return; }
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) { err(res, 400, "invalid_body"); return; }
  // AI chat audit 2026-11-04 (A6): per-user token budget guard. Each message
  // can fan out into up to MAX_TURNS_PER_REQUEST model calls.
  const rl = chatMessageLimiter.check(String(userId));
  if (!rl.allowed) { res.status(429).set("Retry-After", String(rl.retryAfterSeconds)).json(rateLimitBody(rl)); return; }

  const conv = await db.select().from(arxAssistantConversationsTable)
    .where(and(eq(arxAssistantConversationsTable.id, id), eq(arxAssistantConversationsTable.userId, userId)))
    .limit(1);
  if (conv.length === 0) { err(res, 404, "conversation_not_found"); return; }

  const userText = parsed.data.content.trim();
  const intent = classifyIntent(userText);
  // Deterministic chart-read routing (Task #602 follow-up): when the user is
  // clearly asking for a single-symbol structural read we FORCE tool_choice to
  // readChartStructure on the first turn so chat surfaces the SAME structural
  // read as the Scanner panel, instead of the model drifting to the old
  // getSymbolMarketContext / getTradeMarketContext path.
  const chartReadIntent = detectChartReadIntent(userText);
  // Task: Eleanor trade-options response logic. When the trader asks for
  // options / setups / possible-entries / where-to-enter / how-to-trade we ALSO
  // force the deterministic structural read so the assistant answers off the
  // SAME chart-truth surface (honest, gate-respecting) instead of drifting to a
  // free-form market-context reply. This is display/advisory routing only — it
  // never weakens an honesty or live-execution gate.
  const tradeOptionsIntent = detectTradeOptionsIntent(userText);
  const forceStructuralRead = chartReadIntent || tradeOptionsIntent;
  const pageContext: PageContext | null = parsed.data.pageContext
    ? {
        pathname: parsed.data.pageContext.pathname,
        label: parsed.data.pageContext.label ?? null,
        chartSymbol: parsed.data.pageContext.chartSymbol ?? null,
        chartTimeframe: parsed.data.pageContext.chartTimeframe ?? null,
      }
    : null;
  setRequestPageContext(req, pageContext);

  // Persist user message immediately.
  const userInsert = await db.insert(arxAssistantMessagesTable)
    .values({ userId, conversationId: id, role: "user", content: userText, intent })
    .returning();
  const userMessageId = userInsert[0]?.id;
  try {
    (req as { log?: { info: (...a: unknown[]) => void } }).log?.info(
      {
        userId, conversationId: id, intent,
        pathname: pageContext?.pathname ?? null,
        chartSymbol: pageContext?.chartSymbol ?? null,
        chartTimeframe: pageContext?.chartTimeframe ?? null,
        chartReadIntent,
        tradeOptionsIntent,
        forcedTool: forceStructuralRead ? "readChartStructure" : null,
        len: userText.length,
      },
      "eleanor_chat_request",
    );
  } catch { /* noop */ }

  // Load recent history (user-scoped).
  const history = await db.select().from(arxAssistantMessagesTable)
    .where(and(eq(arxAssistantMessagesTable.conversationId, id), eq(arxAssistantMessagesTable.userId, userId)))
    .orderBy(desc(arxAssistantMessagesTable.createdAt))
    .limit(MAX_HISTORY_MESSAGES);
  const ordered = history.slice().reverse();

  // Open the SSE stream IMMEDIATELY so the user sees "Eleanor is thinking…"
  // within milliseconds, not after the memory/history load completes.
  // (Phase Eleanor-Speed) — previously we awaited Promise.all([memory,
  // pending, toolHistory]) BEFORE flushing headers, which gave the user
  // 1-3 seconds of silence after pressing send. Open the channel first,
  // emit safety + intent + ping right away, then load memory in parallel
  // with intent classification while the model call is still being set
  // up.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

  // Phase 22K — load long-term memory + pendingAction + recent tool results
  // (all scoped to this user / this conversation) and inject as a system
  // message so the model can answer "what did I ask earlier?", continue
  // promises, and avoid re-asking facts it already knows. Now started
  // AFTER the SSE channel is open so the user sees activity immediately.
  const EMPTY_MEMORY_SNAPSHOT = {
    rollingSummary: null, tradingStyle: null, preferences: null,
    unresolvedActions: [], summaryUpdatedAt: null, memoryEnabled: true,
  };
  const memoryLoadPromise = Promise.all([
    loadVerifiedMemory(userId),
    getConversationPendingAction(userId, id),
    getRecentToolResults(userId, id, 5),
  ]).catch(() => [EMPTY_MEMORY_SNAPSHOT, null, [] as Array<{ toolName: string; status: string; result: unknown; createdAt: string }>] as const);

  // Build OpenAI chat messages (ChatMessage: lib/assistant/chatTurnLoop.ts).

  // Phase 22F — strict canonical ARX stream contract.
  // ONLY these event types may reach the frontend:
  //   safety | intent | content | tool_call | tool_result | error | done | ping
  // Any other shape (raw provider event, unknown payload, exception
  // string) MUST be filtered here. The frontend whitelist is the
  // second line of defense; this is the first.
  // `content_clear` (Phase 22V Part-4 — Eleanor streaming fix) tells the
  // frontend to remove the last N characters from the current assistant
  // message. Used when the model streamed preamble text live and then
  // started calling tools — that preamble is dropped from the visible
  // reply, identical end-state to the old buffer-and-flush behaviour but
  // with token-by-token streaming for replies that don't call tools.
  const CANONICAL = new Set(["safety", "intent", "content", "content_clear", "tool_call", "tool_result", "reasoning", "error", "done", "ping"]);
  const send = (event: Record<string, unknown>) => {
    const t = typeof event?.type === "string" ? event.type : "";
    if (!CANONICAL.has(t)) {
      try { (req as { log?: { warn: (...a: unknown[]) => void } }).log?.warn({ type: t }, "assistant_dropped_noncanonical_event"); } catch { /* noop */ }
      return;
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Emit a fast "thinking" ping so the client knows the channel is alive
  // (and any proxy buffering is flushed) before the heavier work begins.
  send({ type: "ping", ts: Date.now() });
  send({ type: "intent", intent });

  let assistantText = "";
  let aborted = false;
  // Periodic heartbeat keeps proxies/load balancers from closing the
  // SSE connection during long tool turns. Canonical {type:"ping"} only.
  const heartbeat = setInterval(() => { if (!aborted) send({ type: "ping", ts: Date.now() }); }, 15_000);
  const cleanupStream = () => { clearInterval(heartbeat); };
  req.on("close", () => { aborted = true; cleanupStream(); });

  // Now resolve the safety envelope + memory in parallel; the SSE channel
  // is already open and pinging, so the user sees activity while these
  // finish. Cap memory load at 1500ms — Eleanor will still answer if the
  // long-term memory snapshot is slow; she just won't have it for this
  // turn. Better than blocking the whole response.
  const [safetyEnvelope, memoryTriple, chatAssistantName] = await Promise.all([
    // AICS-10: derive the SafetyEnvelope ONCE per request and hand it to every
    // tool call below (dispatchTool would otherwise re-derive it per call).
    deriveAssistantEnvelope(userId),
    Promise.race([
      memoryLoadPromise,
      new Promise<readonly [typeof EMPTY_MEMORY_SNAPSHOT, null, never[]]>((resolve) =>
        setTimeout(() => resolve([EMPTY_MEMORY_SNAPSHOT, null, []] as const), 1500),
      ),
    ]),
    getAssistantDisplayName(userId),
  ]);
  // Bail out cleanly if the client disconnected while we were loading
  // memory/envelope — no point spending tokens on an answer nobody is
  // listening for.
  if (aborted) { cleanupStream(); res.end(); return; }
  const envelope = assistantEnvelopeFields(safetyEnvelope);
  send({ type: "safety", ...envelope });
  const memSnapshot = memoryTriple[0];
  const pending = memoryTriple[1];
  const toolHistory = memoryTriple[2];
  const memoryBlock = formatMemoryForSystemPrompt(memSnapshot, pending, toolHistory);
  const messages: ChatMessage[] = [
    ...buildSessionSystemMessages(userId, pageContext, memoryBlock, envelope, chatAssistantName),
    ...ordered.map((m) => ({ role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant", content: m.content })),
  ];

  const tools = TOOL_DEFINITIONS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> },
  }));

  // The model/tool loop lives in lib/assistant/chatTurnLoop.ts so the eval
  // harness runs the same code. Every visible sentence passes the runtime claim
  // verifier (lib/assistant/grounding) before it is sent; resolveAssistantToolChoice
  // is applied per turn inside the loop with MAX_TURNS_PER_REQUEST.
  // Every content event is already verified text: record it in the speech
  // ledger so the TTS route can read this answer aloud with its checked figures.
  const recordVerifiedSpeech = openVerifiedSpeechTurn(userId);
  const loop = await runChatTurnLoop({
    model: MODEL,
    messages,
    tools,
    maxTurns: MAX_TURNS_PER_REQUEST,
    forceStructuralRead,
    userText,
    toolResultChars: TOOL_RESULT_MODEL_CHARS,
    streamChat: streamToolChat,
    dispatch: (name, parsedArgs) => dispatchTool(name, parsedArgs, userId, req, safetyEnvelope),
    send: (event) => {
      if (event?.type === "content" && typeof event.content === "string") recordVerifiedSpeech(event.content);
      send(event);
    },
    isAborted: () => aborted,
    onToolResult: async (r) => {
      try {
        (req as { log?: { info: (...a: unknown[]) => void } }).log?.info(
          { userId, conversationId: id, tool: r.name, status: r.status, durationMs: r.durationMs },
          "eleanor_tool_call",
        );
      } catch { /* noop */ }
      try {
        await db.insert(arxAssistantToolCallsTable).values({
          userId, conversationId: id, messageId: userMessageId ?? null,
          toolName: r.name, args: r.args,
          result: r.result as Record<string, unknown>, status: r.status, durationMs: r.durationMs,
        });
      } catch { /* tool log non-fatal */ }
    },
    logError: (msg, e) => {
      try { (req as { log?: { error: (...a: unknown[]) => void } }).log?.error({ err: (e as Error)?.message }, msg); } catch { /* noop */ }
    },
  });
  if (loop.status === "provider_error" || loop.status === "stream_error") {
    send({ type: "done" });
    cleanupStream();
    res.end();
    return;
  }
  assistantText = loop.assistantText;
  if (loop.findings.length > 0 || loop.verifierFailedClosed) {
    try {
      (req as { log?: { warn: (...a: unknown[]) => void } }).log?.warn(
        {
          userId, conversationId: id,
          findings: loop.findings.map((f) => ({ kind: f.kind, claim: f.claim.text, detail: f.detail.slice(0, 200) })),
          failedClosed: loop.verifierFailedClosed,
        },
        "eleanor_claims_verifier_flagged",
      );
    } catch { /* noop */ }
  }

  // AICS-4: never end on a blank bubble. The last turn runs with
  // tool_choice "none", so this only fires if the model still returned no
  // text (or a provider quirk ended the loop on tool calls).
  if (!aborted && assistantText.trim().length === 0) {
    send({ type: "error", message: EMPTY_REPLY_MESSAGE });
  }

  // Persist final assistant message
  if (assistantText.trim().length > 0) {
    try {
      await db.insert(arxAssistantMessagesTable).values({
        userId, conversationId: id, role: "assistant", content: assistantText, intent,
      });
      await db.update(arxAssistantConversationsTable)
        .set({ updatedAt: new Date(), lastIntent: intent })
        .where(and(eq(arxAssistantConversationsTable.id, id), eq(arxAssistantConversationsTable.userId, userId)));
    } catch { /* persist non-fatal */ }

    // Phase 22K — pendingAction lifecycle.
    // 1. If a tool ran THIS turn, mark its matching unresolved action resolved.
    // 2. If the assistant promised something new ("let me check the scanner"),
    //    create / refresh the pendingAction on the conversation row AND
    //    long-term unresolved list.
    try {
      const toolNamesThisTurn = new Set<string>();
      for (const m of messages) {
        if (m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls)) {
          for (const tc of (m as { tool_calls: Array<{ function: { name: string } }> }).tool_calls) {
            if (tc?.function?.name) toolNamesThisTurn.add(tc.function.name);
          }
        }
      }
      const TOOL_TO_PENDING: Record<string, PendingAction["type"]> = {
        getMarketScannerOpportunities: "scanner_check",
        getMT5BridgeStatus: "mt5_status",
        getMT5Heartbeat: "mt5_status",
        getTradeJournalSummary: "trade_analysis",
        getOpenPositions: "trade_analysis",
        getRiskLimits: "risk_explanation",
        getAccountSnapshot: "account_lookup",
      };
      for (const tn of toolNamesThisTurn) {
        const pt = TOOL_TO_PENDING[tn];
        if (pt) await resolveUnresolvedAction(userId, pt, id);
      }
      if (pending && toolNamesThisTurn.size > 0) {
        const matched = Array.from(toolNamesThisTurn).some((tn) => TOOL_TO_PENDING[tn] === pending.type);
        if (matched) await setConversationPendingAction(userId, id, null);
      }
      // 3. New promise extraction.
      const promise = extractPromiseFromAssistantText(assistantText);
      if (promise) {
        const action: PendingAction = {
          type: promise.type,
          status: toolNamesThisTurn.size > 0 ? "in_progress" : "open",
          userIntent: userText.slice(0, 240),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastAssistantPromise: promise.promiseSentence,
          conversationId: id,
        };
        await setConversationPendingAction(userId, id, action);
        await pushUnresolvedAction(userId, action);
      }
    } catch { /* memory side-effects are best-effort */ }

    // Phase 22K — fire-and-forget rolling summary update. Throttled inside.
    void summarizeIfNeeded(userId, id).catch(() => { /* best-effort */ });
  }

  send({ type: "done" });
  cleanupStream();
  res.end();
}));

// ── streaming voice (gpt-audio speech-to-speech) ─────────────────────────
// Held model audio is capped (base64 chars, ~60 s of pcm16 at 24 kHz). Past the
// cap the audio is dropped and the verified text is spoken through TTS instead.
const MAX_HELD_VOICE_AUDIO_CHARS = 4_000_000;
router.post("/me/assistant/conversations/:id/voice", requireUser, voiceUpload.single("audio"), safe(async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { err(res, 400, "invalid_id"); return; }
  const file = (req as unknown as { file?: { buffer: Buffer; size: number; mimetype: string } }).file;
  if (!file || !file.buffer || file.size === 0) { err(res, 400, "missing_audio"); return; }
  const rl = chatMessageLimiter.check(String(userId));
  if (!rl.allowed) { res.status(429).set("Retry-After", String(rl.retryAfterSeconds)).json(rateLimitBody(rl)); return; }
  const conv = await db.select().from(arxAssistantConversationsTable)
    .where(and(eq(arxAssistantConversationsTable.id, id), eq(arxAssistantConversationsTable.userId, userId)))
    .limit(1);
  if (conv.length === 0) { err(res, 404, "conversation_not_found"); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

  // Phase 22F — same strict canonical contract as the text stream.
  // The voice provider emits its own event names ("transcript",
  // "user_transcript", "audio_chunk", and any future additions). We
  // translate the ones we care about into ARX canonical events and DROP
  // every other shape. Raw provider events MUST NOT reach the browser.
  const VOICE_CANONICAL = new Set(["safety", "content", "transcript", "user_transcript", "audio_chunk", "speech_replaced", "error", "done", "ping"]);
  const sendVoice = (event: Record<string, unknown>) => {
    const t = typeof event?.type === "string" ? event.type : "";
    if (!VOICE_CANONICAL.has(t)) {
      try { (req as { log?: { warn: (...a: unknown[]) => void } }).log?.warn({ type: t }, "assistant_voice_dropped_noncanonical_event"); } catch { /* noop */ }
      return;
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  sendVoice({ type: "safety", ...(await buildPerUserEnvelope(userId)) });

  let voiceAborted = false;
  const voiceHeartbeat = setInterval(() => { if (!voiceAborted) sendVoice({ type: "ping", ts: Date.now() }); }, 15_000);
  const cleanupVoice = () => { clearInterval(voiceHeartbeat); };
  req.on("close", () => { voiceAborted = true; cleanupVoice(); });

  const audioBuffer = file.buffer;

  // Phase 22H — voice now shares the same conversation memory + system
  // prompt as text chat. Load the recent history (user-scoped, same
  // limit as the text route) and prepend the system messages so the
  // gpt-audio model sees the full thread + ARX safety + follow-up rules.
  // Phase 22K — also inject long-term memory + pendingAction + recent tool
  // results so voice has identical recall to text.
  const [voiceHistory, voiceMem, voicePending, voiceToolHistory, voiceEnvelope, voiceAssistantName] = await Promise.all([
    db.select().from(arxAssistantMessagesTable)
      .where(and(eq(arxAssistantMessagesTable.conversationId, id), eq(arxAssistantMessagesTable.userId, userId)))
      .orderBy(desc(arxAssistantMessagesTable.createdAt))
      .limit(MAX_HISTORY_MESSAGES),
    loadVerifiedMemory(userId),
    getConversationPendingAction(userId, id),
    getRecentToolResults(userId, id, 5),
    buildPerUserEnvelope(userId),
    getAssistantDisplayName(userId),
  ]);
  const voiceOrdered = voiceHistory.slice().reverse();
  const voiceMemoryBlock = formatMemoryForSystemPrompt(voiceMem, voicePending, voiceToolHistory);
  const voicePriorMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    ...buildSessionSystemMessages(userId, null, voiceMemoryBlock, voiceEnvelope, voiceAssistantName),
    // AICS-5: gpt-audio gets no tools, so the "call X first" rules above
    // cannot be followed — say so explicitly (same text as the realtime path).
    { role: "system", content: `${VOICE_NO_TOOLS_INSTRUCTION} This overrides every instruction above that tells you to call a tool.` },
    ...voiceOrdered.map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    })),
  ];

  let userTranscript = "";
  let assistantTranscript = "";
  try {
    const audio = await voiceAudio();
    const { buffer, format } = await audio.ensureCompatibleFormat(audioBuffer);
    // AC1: gpt-audio never yields the user's words, so transcribe the clip
    // first and emit it as `user_transcript` — the client shows the user
    // bubble and runs a spoken trade command through the command pre-filter.
    // A failed transcription is non-fatal: the spoken reply still streams.
    try {
      const heard = (await audio.speechToText(buffer, format)).trim();
      if (heard && !voiceAborted) {
        userTranscript = heard;
        sendVoice({ type: "user_transcript", data: heard });
      }
    } catch (e) {
      try { (req as { log?: { warn: (...a: unknown[]) => void } }).log?.warn({ err: (e as Error)?.message }, "assistant_voice_transcribe_failed"); } catch { /* noop */ }
    }
    // Claim gate for speech (owner ruling 2026-11-09): the model's audio and
    // transcript are HELD until the whole turn is generated, then the transcript
    // passes the same claims checker as text (voice has no tools, so the only
    // evidence is the user's own words). Clean turn: the held audio plays
    // unchanged. Any finding: the model audio is dropped, the bubble shows the
    // verified text, and `speech_replaced` carries the speakable text the client
    // reads through the TTS route. Trade-off: first audio waits for the full
    // reply instead of streaming (see docs/VOICE_AND_NEWS_GRADES.md).
    const heldAudio: string[] = [];
    let heldAudioChars = 0;
    let audioOverflow = false;
    const stream = await audio.voiceChatStream(buffer, "alloy", format, voicePriorMessages);
    for await (const event of stream) {
      if (voiceAborted) break;
      const ev = event as { type?: string; data?: string };
      const evType = typeof ev?.type === "string" ? ev.type : "";
      if (evType === "transcript" && typeof ev.data === "string") {
        assistantTranscript += ev.data;
      } else if (evType === "user_transcript" && typeof ev.data === "string") {
        // Only if a provider ever supplies it AND transcription above failed.
        if (!userTranscript) {
          userTranscript += ev.data;
          sendVoice({ type: "user_transcript", data: ev.data });
        }
      } else if ((evType === "audio" || evType === "audio_chunk") && typeof ev.data === "string") {
        heldAudioChars += ev.data.length;
        if (heldAudioChars > MAX_HELD_VOICE_AUDIO_CHARS) audioOverflow = true;
        else heldAudio.push(ev.data);
      } else {
        // Unknown / future provider event — log server-side, drop client-side.
        try { (req as { log?: { warn: (...a: unknown[]) => void } }).log?.warn({ type: evType }, "assistant_voice_provider_event_unmapped"); } catch { /* noop */ }
      }
    }
    if (!voiceAborted && assistantTranscript.trim()) {
      const gated = gateVoiceTurn(assistantTranscript, userTranscript);
      assistantTranscript = gated.display;
      sendVoice({ type: "transcript", data: gated.display });
      if (gated.audioMayPlay && !audioOverflow) {
        for (const chunk of heldAudio) sendVoice({ type: "audio_chunk", data: chunk });
      } else {
        sendVoice({ type: "speech_replaced", data: gated.speech, withheld: gated.withheld });
        if (gated.findings.length > 0) {
          try {
            (req as { log?: { warn: (...a: unknown[]) => void } }).log?.warn(
              { userId, conversationId: id, findings: gated.findings.map((f) => ({ kind: f.kind, claim: f.claim.text })) },
              "eleanor_voice_claims_withheld",
            );
          } catch { /* noop */ }
        }
      }
    }
  } catch (e) {
    try { (req as { log?: { error: (...a: unknown[]) => void } }).log?.error({ err: (e as Error)?.message }, "assistant_voice_failed"); } catch { /* noop */ }
    sendVoice({ type: "error", message: "voice_unavailable" });
  }

  // Persist transcripts
  try {
    if (userTranscript.trim()) {
      await db.insert(arxAssistantMessagesTable).values({
        userId, conversationId: id, role: "user", content: userTranscript, audioTranscript: userTranscript,
      });
    }
    if (assistantTranscript.trim()) {
      await db.insert(arxAssistantMessagesTable).values({
        userId, conversationId: id, role: "assistant", content: assistantTranscript, audioTranscript: assistantTranscript,
      });
      await db.update(arxAssistantConversationsTable)
        .set({ updatedAt: new Date(), voiceMode: "off" })
        .where(and(eq(arxAssistantConversationsTable.id, id), eq(arxAssistantConversationsTable.userId, userId)));

      // Phase 22K — same pendingAction extraction + summary update as text.
      try {
        const promise = extractPromiseFromAssistantText(assistantTranscript);
        if (promise) {
          const action: PendingAction = {
            type: promise.type, status: "open",
            userIntent: userTranscript.slice(0, 240),
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            lastAssistantPromise: promise.promiseSentence,
            conversationId: id,
          };
          await setConversationPendingAction(userId, id, action);
          await pushUnresolvedAction(userId, action);
        }
      } catch { /* best-effort */ }
      void summarizeIfNeeded(userId, id).catch(() => { /* best-effort */ });
    }
  } catch { /* non-fatal */ }

  sendVoice({ type: "done" });
  cleanupVoice();
  res.end();
}));

// ───────────────────────────────────────────────────────────────────────
// POST /me/assistant/instant-trade-command
//
// Eleanor AI text/voice command → instant-trade router. Frontend sends the
// raw user utterance ("buy EURUSD 0.01", "close my XAUUSD", "close all"
// "set TP on EURUSD to 1.0920"); this endpoint parses it, decides whether
// it's a CLEAR direct command or a VAGUE analysis question, and — only
// when clear — forwards through the Trade Engine one-click leg
// (`submitInstantTrade()` → `executeInstant()`) which then runs every
// existing live-trading gate (master-live access, server master switch,
// 16-gate Phase B, kill switch, max lot, daily loss, missing-SL override,
// per-user advisory lock, idempotency).
//
// VAGUE questions ("what should I trade?", "is gold bullish?") are NEVER
// executed — they return `{ok:false, classification:"VAGUE"}` so Eleanor
// answers the question instead of trading.
// ───────────────────────────────────────────────────────────────────────
// Cap on concurrent ACTIVE Eleanor watches per user — keeps the evaluator cheap
// and prevents an accidental flood of armed conditionals.
// Eleanor ledger/dispatch wrapper, price binding and watch constants live in
// lib/assistant/eleanorExecution.ts; the evaluator in lib/assistant/eleanorWatchEvaluator.ts
// (called by the sweeper worker and by POST /me/assistant/watch/evaluate).
// Arming a watch is honest by construction: it is only offered when the sweeper
// that evaluates watches is enabled in this process.
const WATCH_ARMING_ENABLED = isSweeperEnabled();
export const CHAT_EXECUTION_WIRED_IN_UI = true;
/** Default lifetime of a price watch (WATCH_AND_ENTER / WATCH_AND_CLOSE) with no stated expiry. */
export const DEFAULT_WATCH_TTL_MINUTES = 24 * 60;

export const WATCH_UNAVAILABLE_MESSAGE =
  "Conditional orders and position monitoring are switched off on this server (the watch sweeper is disabled), so I won't pretend to watch. Place the pending order yourself from the Trade Action Center, or ask me to prepare the ticket.";
export const WATCH_EVALUATION_UNAVAILABLE_SKIP_REASON = "WATCH_EVALUATION_UNAVAILABLE";

// The chat bubble text for an instant-trade-command reply.
export function commandReplyText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const k of ["message", "primaryReason", "error"] as const) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

// Wrap res.json so the first JSON reply is persisted with the user's command
// into the user's own conversation. Persistence is best-effort and never
// changes the response.
export async function attachCommandTranscript(
  res: { json: (body: unknown) => unknown },
  userId: number,
  rawConversationId: unknown,
  text: string,
): Promise<number | null> {
  const convId = Number(rawConversationId);
  if (!Number.isInteger(convId) || convId <= 0) return null;
  let owned: Array<{ id: number }> = [];
  try {
    owned = await db.select({ id: arxAssistantConversationsTable.id }).from(arxAssistantConversationsTable)
      .where(and(eq(arxAssistantConversationsTable.id, convId), eq(arxAssistantConversationsTable.userId, userId)))
      .limit(1);
  } catch { return null; }
  if (owned.length === 0) return null;
  const original = res.json.bind(res);
  let done = false;
  res.json = (payload: unknown) => {
    if (!done) {
      done = true;
      const reply = commandReplyText(payload);
      void (async () => {
        try {
          await db.insert(arxAssistantMessagesTable).values({
            userId, conversationId: convId, role: "user", content: text, intent: "trade_command",
          });
          if (reply) {
            await db.insert(arxAssistantMessagesTable).values({
              userId, conversationId: convId, role: "assistant", content: reply, intent: "trade_command",
            });
          }
          await db.update(arxAssistantConversationsTable)
            .set({ updatedAt: new Date(), lastIntent: "trade_command" })
            .where(and(eq(arxAssistantConversationsTable.id, convId), eq(arxAssistantConversationsTable.userId, userId)));
        } catch { /* best-effort */ }
      })();
    }
    return original(payload);
  };
  return convId;
}

router.post("/me/assistant/instant-trade-command", requireUser, safe(async (req, res) => {
  const userId = (req as Request & { authUser?: { id: number } }).authUser!.id;
  // Phase 5: "paper" removed from accountMode union. Legacy callers
  // sending accountMode=paper are intercepted below and rejected with
  // the canonical 400 error before the Eleanor pipeline runs.
  const { detectLegacyPaperModeRequest } = await import("../lib/safety/rejectLegacyPaperMode.js");
  const legacyPaper = detectLegacyPaperModeRequest(req.body);
  if (legacyPaper) { res.status(400).json({ ok: false, ...legacyPaper }); return; }
  const rl = tradeCommandLimiter.check(String(userId));
  if (!rl.allowed) { res.status(429).set("Retry-After", String(rl.retryAfterSeconds)).json({ ok: false, ...rateLimitBody(rl) }); return; }

  const body = (req.body ?? {}) as {
    text?: string;
    accountMode?: "live" | "demo";
    source?: "eleanor_text" | "eleanor_voice";
    confirm?: boolean;
    conversationId?: number | string;
  };
  const text = (body.text ?? "").trim();
  const source = body.source === "eleanor_voice" ? "eleanor_voice" : "eleanor_text";
  const accountMode: "live" | "demo" = body.accountMode === "demo" ? "demo" : "live";
  const assistantName = await getAssistantDisplayName(userId);
  const ipEarly = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.socket.remoteAddress ?? null;
  const uaEarly = (req.headers["user-agent"] as string | undefined) ?? null;
  if (!text) {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_TRADE_COMMAND_VAGUE_REJECTED", ip: ipEarly, userAgent: uaEarly,
      metadata: JSON.stringify({ reason: "MISSING_TEXT", source }),
    });
    res.status(400).json({ ok: false, error: "MISSING_TEXT" });
    return;
  }

  // Voice never places, changes, closes or confirms an order (owner ruling
  // 2026-11-09). Only "keep it / hold" alert answers are accepted by voice;
  // they send nothing to a broker.
  const voiceDecision = voiceCommandDecision({ source, text, confirm: body.confirm === true });
  if (!voiceDecision.allowed) {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_TRADE_COMMAND_VOICE_BLOCKED", ip: ipEarly, userAgent: uaEarly,
      metadata: JSON.stringify({ text, source, confirm: body.confirm === true }),
    });
    res.json({ ok: false, classification: voiceDecision.classification, message: voiceDecision.message });
    return;
  }

  // AC7 (additive): with a `conversationId` the user owns, the command text
  // and this route's reply are saved as messages in that conversation, so
  // they survive a reload and the analyst model sees them in history. An
  // unknown / foreign id is ignored (nothing persisted, command unaffected).
  // The confirm resend repeats the same text: store it as the confirmation,
  // not as a second copy of the command.
  await attachCommandTranscript(res, userId, body.conversationId,
    body.confirm === true ? `Confirm: ${text}` : text);

  // Pull per-user Eleanor defaults so commands like "buy EURUSD" without a
  // size can still resolve when the user has configured a default volume.
  const settingsRows = await db.select().from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, userId)).limit(1);
  const settings = settingsRows[0];
  const parseDefaults = {
    defaultSymbol: settings?.defaultAiTradeSymbol ?? settings?.defaultSymbol ?? null,
    defaultVolume: settings?.defaultAiTradeVolume ?? settings?.defaultVolume ?? null,
    defaultOrderType: settings?.defaultAiOrderType ?? settings?.defaultOrderType ?? null,
  };
  // Answer to a reversal alert, in plain words. "keep it / hold / stay in"
  // resets the unanswered-alert count on the monitor that is waiting for an
  // answer; "close it" parses as a normal CLOSE command below. Only consulted
  // when a monitor is actually awaiting an answer, so ordinary chat is untouched.
  const keepMatch = /^(?:ok(?:ay)?[,\s]*)?(?:keep(?:\s+(?:it|the\s+trade|running))?|hold(?:\s+it)?|stay\s+in|leave\s+it(?:\s+open)?|don'?t\s+close(?:\s+it)?)[.!\s]*$/i.test(text);
  if (keepMatch) {
    const awaiting = (await listEleanorWatches(userId)).filter((w) => w.monitor?.awaitingAnswer);
    if (awaiting.length === 1) {
      const ipK = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
      const uaK = (req.headers["user-agent"] as string | undefined) ?? null;
      const r = await acknowledgeEleanorWatch(userId, awaiting[0]!.id, "keep", { ip: ipK, ua: uaK, trigger: "ack" });
      res.json({
        ok: r.ok, classification: "MONITOR_ALERT_ACK_KEEP", watchId: awaiting[0]!.id,
        message: r.ok
          ? `Understood — staying in ${awaiting[0]!.symbol ?? "the trade"}. I'll keep monitoring and only start a fresh count if the reversal evidence persists.`
          : `I couldn't record that: ${(r as { error: string }).error}.`,
      });
      return;
    }
    if (awaiting.length > 1) {
      res.json({ ok: false, classification: "MONITOR_ALERT_ACK_AMBIGUOUS", message: `Several positions are waiting for your answer (${awaiting.map((w) => w.symbol).join(", ")}) — tell me which one to keep, e.g. "keep EURUSD".` });
      return;
    }
  }
  // "close it" / "close that" / "yes close" answers the alert too. Without this
  // it parsed as UNKNOWN, or as CLOSE_ONE of the default symbol, which may not
  // be the position the alert was about. Only consulted when a monitor is
  // awaiting an answer; otherwise the text parses as before.
  const closeAnswer = isCloseAlertAnswer(text);
  if (closeAnswer) {
    const awaiting = (await listEleanorWatches(userId)).filter((w) => w.monitor?.awaitingAnswer);
    if (awaiting.length === 1) {
      const ipC = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
      const uaC = (req.headers["user-agent"] as string | undefined) ?? null;
      const target = awaiting[0]!;
      const r = await acknowledgeEleanorWatch(userId, target.id, "close", { ip: ipC, ua: uaC, trigger: "ack" });
      const fired = r.ok && r.decision === "close" ? r.result.fired[0] : undefined;
      const skipped = r.ok && r.decision === "close" ? r.result.skipped[0] : undefined;
      res.json({
        ok: r.ok && !!fired && !fired.blocked, classification: "MONITOR_ALERT_ACK_CLOSE", watchId: target.id,
        message: !r.ok ? `I couldn't record that: ${r.error}.`
          : fired ? (fired.blocked ? `I tried to close ${target.symbol ?? "it"} but it did not go through: ${fired.blocked}.` : `Closing ${target.symbol ?? "the trade"} now — I sent the close to the broker and will confirm when it fills.`)
          : skipped?.reason === "POSITION_GONE" ? `Your ${target.symbol ?? ""} position is already closed.`
          : skipped ? `I couldn't close it: ${skipped.reason}.`
          : "Nothing to do.",
      });
      return;
    }
    if (awaiting.length > 1) {
      res.json({ ok: false, classification: "MONITOR_ALERT_ACK_AMBIGUOUS", message: `Several positions are waiting for your answer (${awaiting.map((w) => w.symbol).join(", ")}) — tell me which one to close, e.g. "close EURUSD".` });
      return;
    }
  }
  const keepSymbol = /^(?:keep|hold)\s+([A-Za-z0-9._#-]{3,20})[.!\s]*$/i.exec(text);
  if (keepSymbol) {
    const sym = keepSymbol[1]!.toUpperCase();
    const awaiting = (await listEleanorWatches(userId)).filter((w) => w.monitor?.awaitingAnswer && (w.symbol ?? "").toUpperCase() === sym);
    if (awaiting.length >= 1) {
      const ipK = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
      const uaK = (req.headers["user-agent"] as string | undefined) ?? null;
      const r = await acknowledgeEleanorWatch(userId, awaiting[0]!.id, "keep", { ip: ipK, ua: uaK, trigger: "ack" });
      res.json({ ok: r.ok, classification: "MONITOR_ALERT_ACK_KEEP", watchId: awaiting[0]!.id, message: r.ok ? `Understood — staying in ${sym}. I'll keep monitoring.` : `I couldn't record that: ${(r as { error: string }).error}.` });
      return;
    }
  }
  const parsed = parseTradeCommand(text, parseDefaults);

  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.socket.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;

  if (parsed.kind === "VAGUE" || parsed.kind === "UNKNOWN") {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_TRADE_COMMAND_VAGUE_REJECTED", ip, userAgent: ua,
      metadata: JSON.stringify({ text, parsed, source }),
    });
    res.json({
      ok: false, classification: parsed.kind,
      message: parsed.kind === "VAGUE"
        ? "I won't trade off a vague question — ask me to analyse it or give me a direct command (e.g. \"buy EURUSD 0.01\")."
        : "I didn't catch a clear trade command in that. Try \"buy EURUSD 0.01\" or \"close all\".",
    });
    return;
  }
  if (parsed.kind === "MISSING_VOLUME") {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_TRADE_COMMAND_VAGUE_REJECTED", ip, userAgent: ua,
      metadata: JSON.stringify({ text, reason: "MISSING_VOLUME", symbol: parsed.symbol, source }),
    });
    res.json({
      ok: false, classification: "MISSING_VOLUME",
      message: `How much ${parsed.symbol}? Tell me a lot size like 0.01.`,
    });
    return;
  }
  if (parsed.kind === "MISSING_SYMBOL") {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_TRADE_COMMAND_VAGUE_REJECTED", ip, userAgent: ua,
      metadata: JSON.stringify({ text, reason: "MISSING_SYMBOL", source }),
    });
    res.json({
      ok: false, classification: "MISSING_SYMBOL",
      message: "Which market? Say e.g. EURUSD or XAUUSD.",
    });
    return;
  }

  await db.insert(oneClickAuditTable).values({
    userId, action: "ELEANOR_TRADE_COMMAND_PARSED", ip, userAgent: ua,
    metadata: JSON.stringify({ text, parsed, source, channel: "ELEANOR_CHAT" }),
  });

  // ── Bookkeeping commands — never touch the broker ──────────────────────
  // STATUS_CHECK: honestly report what Eleanor is currently watching / pending.
  if (parsed.kind === "STATUS_CHECK") {
    let watches = await db.select().from(eleanorWatchInstructionsTable).where(and(
      eq(eleanorWatchInstructionsTable.userId, userId),
      eq(eleanorWatchInstructionsTable.status, "ACTIVE"),
    ));
    // Audit A1: with no evaluator running, an ACTIVE row is a promise nobody
    // keeps. Retire it honestly (SKIPPED + reason) and tell the user.
    let retiredWatches = 0;
    if (!WATCH_ARMING_ENABLED && watches.length > 0) {
      const retired = await db.update(eleanorWatchInstructionsTable)
        .set({ status: "SKIPPED", skipReason: WATCH_EVALUATION_UNAVAILABLE_SKIP_REASON, updatedAt: new Date() })
        .where(and(
          eq(eleanorWatchInstructionsTable.userId, userId),
          eq(eleanorWatchInstructionsTable.status, "ACTIVE"),
        )).returning({ id: eleanorWatchInstructionsTable.id });
      retiredWatches = retired.length;
      await db.insert(oneClickAuditTable).values({
        userId, action: "ELEANOR_WATCH_RETIRED_NO_EVALUATOR", ip, userAgent: ua,
        metadata: JSON.stringify({ retired: retired.map((r) => r.id), reason: WATCH_EVALUATION_UNAVAILABLE_SKIP_REASON, source }),
      });
      watches = [];
    }
    const pending = await db.select({ id: eleanorCommandsTable.id }).from(eleanorCommandsTable).where(and(
      eq(eleanorCommandsTable.userId, userId),
      inArray(eleanorCommandsTable.status, ["PENDING", "EXECUTING"]),
    ));
    res.json({
      ok: true, classification: "STATUS_CHECK",
      activeWatches: watches.map((w) => {
        const m = w.kind === "MONITOR_TRADE" ? parseMonitorState(w.riskParams) : null;
        return {
          id: w.id, kind: w.kind, symbol: w.symbol, side: w.side,
          trigger: w.triggerCondition, createdAt: w.createdAt,
          alertsAwaitingAnswer: m ? m.alertsSinceAck : 0,
        };
      }),
      pendingCommands: pending.length,
      watchEvaluationActive: WATCH_ARMING_ENABLED,
      retiredWatches,
      message: retiredWatches > 0
        ? `I'm not watching anything. ${retiredWatches} earlier watch${retiredWatches === 1 ? "" : "es"} ${retiredWatches === 1 ? "was" : "were"} never being evaluated in this build, so I've marked ${retiredWatches === 1 ? "it" : "them"} as not active — please manage ${retiredWatches === 1 ? "that order" : "those orders"} yourself.${pending.length > 0 ? ` ${pending.length} command${pending.length === 1 ? "" : "s"} in progress.` : ""}`
        : watches.length === 0 && pending.length === 0
        ? "I'm not watching anything and have nothing pending right now."
        : `I have ${watches.length} active watch${watches.length === 1 ? "" : "es"} and ${pending.length} command${pending.length === 1 ? "" : "s"} in progress.`,
    });
    return;
  }

  // CANCEL: stand down any active watches and pending commands. A pending/
  // conditional ENTRY in ARX is an ACTIVE watch (the watch evaluator fires the
  // market order at the trigger), so "cancel my pending order" stands down the
  // same rows as a generic cancel — no broker touch. CANCEL_PENDING_ORDER is the
  // same handler with explicit "pending order" copy.
  if (parsed.kind === "CANCEL" || parsed.kind === "CANCEL_PENDING_ORDER") {
    const isPending = parsed.kind === "CANCEL_PENDING_ORDER";
    // Scope (sweep 2026-11-04): "never mind" used to stand down EVERY watch,
    // monitors included, so a casual "cancel that" silently removed the
    // protection on open trades. Now: "all"/"everything" → every watch;
    // "stop monitoring …" → the most recent monitor; a pending-order cancel →
    // the pending entries (of that symbol when named); otherwise the most
    // recent non-monitor watch.
    const scope = cancelScope(text, parsed.kind);
    const activeRows = await db.select().from(eleanorWatchInstructionsTable).where(and(
      eq(eleanorWatchInstructionsTable.userId, userId),
      eq(eleanorWatchInstructionsTable.status, "ACTIVE"),
    ));
    const targets = pickWatchesToCancel(activeRows, scope, parsed.kind === "CANCEL_PENDING_ORDER" ? parsed.symbol : null);
    const cancelledWatches = targets.length === 0 ? [] : await db.update(eleanorWatchInstructionsTable)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(
        eq(eleanorWatchInstructionsTable.userId, userId),
        eq(eleanorWatchInstructionsTable.status, "ACTIVE"),
        inArray(eleanorWatchInstructionsTable.id, targets.map((w) => w.id)),
      )).returning({ id: eleanorWatchInstructionsTable.id });
    const monitorsLeft = activeRows.filter((w) => w.kind === "MONITOR_TRADE" && !cancelledWatches.some((c) => c.id === w.id));
    const cancelledCmds = await db.update(eleanorCommandsTable)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(
        eq(eleanorCommandsTable.userId, userId),
        eq(eleanorCommandsTable.status, "PENDING"),
      )).returning({ id: eleanorCommandsTable.id });
    const n = cancelledWatches.length + cancelledCmds.length;
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_PENDING_ACTION_CANCELLED", ip, userAgent: ua,
      metadata: JSON.stringify({ text, kind: parsed.kind, watches: cancelledWatches.length, watchIds: cancelledWatches.map((c) => c.id), commands: cancelledCmds.length, scope, source, channel: "ELEANOR_CHAT" }),
    });
    const monitorNote = monitorsLeft.length > 0
      ? ` Still monitoring ${monitorsLeft.map((w) => w.symbol ?? "a position").join(", ")} — say "stop monitoring" or "cancel all" to stop that too.`
      : "";
    res.json({
      ok: true, classification: parsed.kind, cancelled: n,
      message: (n === 0
        ? (isPending
          ? "No pending orders to cancel — you have no conditional entries armed right now."
          : "Nothing to cancel — I had no matching watches or pending commands.")
        : (isPending
          ? `Cancelled ${n} pending order${n === 1 ? "" : "s"}.`
          : `Stood down ${n} pending item${n === 1 ? "" : "s"}.`)) + monitorNote,
    });
    return;
  }

  // ── Honest declines / clarifications — never touch the broker ───────────
  // Trailing stop: broker-native trailing stops have no schema column and no EA
  // path in this build. Decline honestly rather than place a fixed stop and call
  // it "trailing" — that would mis-represent live risk.
  if (parsed.kind === "TRAILING_STOP_UNSUPPORTED") {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_TRADE_COMMAND_DECLINED", ip, userAgent: ua,
      metadata: JSON.stringify({ text, reason: "TRAILING_STOP_UNSUPPORTED", symbol: parsed.symbol ?? null, source, channel: "ELEANOR_CHAT" }),
    });
    res.json({
      ok: false, classification: "TRAILING_STOP_UNSUPPORTED",
      message: `I can't place a trailing stop${parsed.symbol ? ` on ${parsed.symbol}` : ""} — this account doesn't support broker-native trailing stops yet. I can set a fixed stop-loss instead, or move your stop to break-even when you're ready.`,
    });
    return;
  }

  // Risk-% sizing: I won't fabricate a lot from a percent — broker contract
  // specs aren't trusted here, so guessing could badly mis-size live money.
  // Ask the user for an exact lot instead.
  if (parsed.kind === "RISK_PERCENT_SIZING") {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_TRADE_COMMAND_NEEDS_LOT", ip, userAgent: ua,
      metadata: JSON.stringify({ text, reason: "RISK_PERCENT_SIZING", symbol: parsed.symbol, riskPercent: parsed.riskPercent, side: parsed.side, source, channel: "ELEANOR_CHAT" }),
    });
    res.json({
      ok: false, classification: "RISK_PERCENT_SIZING",
      message: `I won't guess a lot size from ${parsed.riskPercent}% — I could mis-size your risk. Tell me an exact lot (e.g. "${parsed.side.toLowerCase()} ${parsed.symbol} 0.01") and I'll take it.`,
    });
    return;
  }

  // SL/TP given as a pip/point distance — the order path takes price levels
  // only, so ask for the level rather than open without the protection.
  if (parsed.kind === "SLTP_NEEDS_PRICE") {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_TRADE_COMMAND_NEEDS_PRICE", ip, userAgent: ua,
      metadata: JSON.stringify({ text, reason: "SLTP_NEEDS_PRICE", symbol: parsed.symbol, side: parsed.side, source, channel: "ELEANOR_CHAT" }),
    });
    res.json({
      ok: false, classification: "SLTP_NEEDS_PRICE",
      message: `I can only set a stop loss / take profit as a price level, not in pips or points. Tell me the levels (e.g. "${parsed.side.toLowerCase()} ${parsed.symbol} 0.01 sl 1.0850 tp 1.0950") and I'll take it.`,
    });
    return;
  }

  // Pending entry intended but no trigger price given — ask for the price
  // rather than arm a priceless conditional entry.
  if (parsed.kind === "PENDING_NEEDS_PRICE") {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_TRADE_COMMAND_NEEDS_PRICE", ip, userAgent: ua,
      metadata: JSON.stringify({ text, reason: "PENDING_NEEDS_PRICE", symbol: parsed.symbol, side: parsed.side, pendingKind: parsed.pendingKind, source, channel: "ELEANOR_CHAT" }),
    });
    res.json({
      ok: false, classification: "PENDING_NEEDS_PRICE",
      message: `At what price should I ${parsed.side.toLowerCase()} ${parsed.symbol}? Tell me the ${parsed.pendingKind} level (e.g. "${parsed.side.toLowerCase()} ${parsed.symbol} when it hits 1.0900").`,
    });
    return;
  }

  // ── Watch / monitor — arm a single-fire conditional instruction ─────────
  // These persist an ACTIVE eleanor_watch_instructions row. The evaluator
  // (POST /me/assistant/watch/evaluate) checks live price and CAS-fires each
  // exactly once through the SAME instant-trade router. Arming touches no
  // broker — only the evaluator can dispatch, and only after all gates pass.
  if (!WATCH_ARMING_ENABLED && (parsed.kind === "WATCH_AND_ENTER" || parsed.kind === "WATCH_AND_CLOSE"
      || parsed.kind === "MONITOR_TRADE")) {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_WATCH_ARM_UNAVAILABLE", ip, userAgent: ua,
      metadata: JSON.stringify({ text, kind: parsed.kind, reason: WATCH_EVALUATION_UNAVAILABLE_SKIP_REASON, source }),
    });
    res.json({
      ok: false, classification: parsed.kind, deferred: true,
      reason: WATCH_EVALUATION_UNAVAILABLE_SKIP_REASON,
      message: WATCH_UNAVAILABLE_MESSAGE,
    });
    return;
  }
  if (parsed.kind === "WATCH_AND_ENTER" || parsed.kind === "WATCH_AND_CLOSE"
      || parsed.kind === "MONITOR_TRADE") {
    // Per-action Eleanor authorization for arming a watch/monitor. Default-deny
    // when settings are unset. Executing watches (enter/close/monitor) all
    // require AI_ASSISTED authority on top of their own per-action permission —
    // MONITOR now fires a protective close on trigger (see the evaluator), so it
    // is an executing watch too. This is an UP-FRONT guard — the evaluator still
    // re-runs every gate (incl. authority + per-action perms) through
    // executeInstant at fire time. It never relaxes a backend gate.
    // Watches run on the LIVE account only: the evaluator reads live positions
    // and instant trading refuses demo, so a demo watch could only ever fire
    // and fail. Refuse honestly at arm time (sweep 2026-11-04).
    if (accountMode !== "live") {
      await db.insert(oneClickAuditTable).values({
        userId, action: "ELEANOR_WATCH_ARM_BLOCKED", ip, userAgent: ua,
        metadata: JSON.stringify({ text, kind: parsed.kind, reason: "LIVE_ACCOUNT_ONLY", accountMode, source }),
      });
      res.json({
        ok: false, classification: "WATCH_LIVE_ONLY",
        message: `Watches run on your live account only in this build; switch to live to arm one.`,
      });
      return;
    }
    // The same permission rule the evaluator applies at fire time, including
    // the pipeline's open/close command permissions (eleanorWatchPermissionBlock).
    const armBlockReason = eleanorWatchPermissionBlock(parsed.kind, settings);
    if (armBlockReason) {
      await db.insert(oneClickAuditTable).values({
        userId, action: "ELEANOR_WATCH_ARM_BLOCKED", ip, userAgent: ua,
        metadata: JSON.stringify({ text, kind: parsed.kind, reason: armBlockReason, source }),
      });
      res.status(403).json({
        ok: false, classification: "ELEANOR_NOT_AUTHORIZED", reason: armBlockReason,
        message: armBlockReason === "ELEANOR_EXECUTION_NOT_AUTHORIZED"
          ? `Turn on ${assistantName} AI-Assisted execution before I can arm that.`
          : armBlockReason === "ELEANOR_OPEN_COMMANDS_NOT_ENABLED"
          ? `That watch would open a trade, but ${assistantName} isn't allowed to open trades in your settings — turn on open commands first.`
          : armBlockReason === "ELEANOR_CLOSE_COMMANDS_NOT_ENABLED"
          ? `That watch may close your trade, but ${assistantName} isn't allowed to close trades in your settings — turn on close commands first.`
          : `That ${assistantName} action isn't enabled in your settings.`,
      });
      return;
    }
    if (parsed.kind === "WATCH_AND_ENTER" && !(typeof parsed.volume === "number" && parsed.volume > 0)) {
      await db.insert(oneClickAuditTable).values({
        userId, action: "ELEANOR_TRADE_COMMAND_VAGUE_REJECTED", ip, userAgent: ua,
        metadata: JSON.stringify({ text, reason: "MISSING_VOLUME", symbol: parsed.symbol, kind: parsed.kind, source }),
      });
      res.json({ ok: false, classification: "MISSING_VOLUME", message: `How much ${parsed.symbol} should I ${parsed.side.toLowerCase()} when it triggers? Tell me a lot size like 0.01.` });
      return;
    }

    // Bound the number of concurrent ACTIVE watches per user.
    const active = await db.select({ id: eleanorWatchInstructionsTable.id }).from(eleanorWatchInstructionsTable)
      .where(and(
        eq(eleanorWatchInstructionsTable.userId, userId),
        eq(eleanorWatchInstructionsTable.status, "ACTIVE"),
      ));
    if (active.length >= MAX_ACTIVE_ELEANOR_WATCHES) {
      res.status(409).json({
        ok: false, classification: "TOO_MANY_WATCHES",
        message: `You already have ${active.length} active watches — cancel one before adding another.`,
      });
      return;
    }

    const symbol = parsed.kind === "MONITOR_TRADE" ? (parsed.symbol ?? null) : parsed.symbol;
    // Resolve the trigger direction at arm time (no broker touch — a quote
    // read only). If the user didn't say above/below, infer from the live
    // price relative to the level.
    let triggerCondition: { op: ">=" | "<="; price: number } | null = null;
    if (parsed.kind === "WATCH_AND_ENTER" || parsed.kind === "WATCH_AND_CLOSE") {
      const { price, direction } = parsed.trigger;
      let op: ">=" | "<=" | null = direction === "ABOVE" ? ">=" : direction === "BELOW" ? "<=" : null;
      if (op == null && symbol) {
        // Direction from the trader's OWN bridge tick only — the same feed the
        // evaluator will fire on (never a platform-wide or third-party price).
        const px = await ownBridgePriceOf(symbol, await currentFeedScopeBridge());
        if (px != null) op = price >= px ? ">=" : "<=";
      }
      triggerCondition = op != null ? { op, price } : null;
      if (triggerCondition == null) {
        res.json({ ok: false, classification: "WATCH_NEEDS_DIRECTION", message: `Should I act when ${symbol ?? "it"} goes above or below ${price}?` });
        return;
      }
    }

    // For position-managing watches, resolve the single open position now.
    let positionTicket: string | null = null;
    if (parsed.kind === "WATCH_AND_CLOSE" || parsed.kind === "MONITOR_TRADE") {
      if (!symbol) {
        res.json({ ok: false, classification: "MODIFY_NEEDS_SYMBOL", message: "Which open position should I watch?" });
        return;
      }
      const open = (await readOpenPositions({ userId, venue: "LIVE", basis: "CONFIRMED_OPEN", symbol })).map((p) => p.row);
      if (open.length === 0) {
        res.json({ ok: false, classification: "NO_OPEN_POSITION", message: `No open ${symbol} position to watch.` });
        return;
      }
      if (open.length > 1) {
        res.json({ ok: false, classification: "AMBIGUOUS_POSITION", message: `Multiple ${symbol} positions — tell me which ticket to watch.` });
        return;
      }
      positionTicket = open[0]!.brokerTicket;
    }

    // Optional expiry — only WATCH_AND_ENTER / WATCH_AND_CLOSE carry a parsed
    // expiresInMinutes. The watch evaluator sweeps past-expiry rows to EXPIRED
    // before it can fire, so a conditional entry/close that never triggers
    // doesn't linger live forever.
    // A price watch without a stated expiry lasts DEFAULT_WATCH_TTL_MINUTES
    // (sweep 2026-11-04) so a forgotten conditional entry never fires days
    // later. A monitor ends when its position is no longer open.
    const statedExpiry = (parsed.kind === "WATCH_AND_ENTER" || parsed.kind === "WATCH_AND_CLOSE")
      ? parsed.expiresInMinutes : undefined;
    const expiresInMinutes = parsed.kind === "MONITOR_TRADE" ? undefined
      : typeof statedExpiry === "number" && statedExpiry > 0 ? statedExpiry : DEFAULT_WATCH_TTL_MINUTES;
    const expiresAt = typeof expiresInMinutes === "number" && expiresInMinutes > 0
      ? new Date(Date.now() + expiresInMinutes * 60_000) : null;
    // Pending-entry wording — "limit"/"stop" phrasing describes a conditional
    // (pending) entry. ARX arms it as a watch that fires a market order at the
    // trigger, which is functionally the requested limit/stop entry.
    const pendingKind = parsed.kind === "WATCH_AND_ENTER" ? parsed.pendingKind : undefined;
    // Owner spec 2026-11-04: a monitor may carry the trader's authority for Eleanor
    // to shift SL/TP on a fakeout (bounded; see eleanorFakeoutPolicy.ts). Stored in
    // risk_params; also toggled later via POST /me/assistant/watches/:id/fakeout-authority.
    const fakeoutAuthority = parsed.kind === "MONITOR_TRADE" && parsed.fakeoutAuthority === true;
    const expirySuffix = expiresAt
      ? ` (expires in ${expiresInMinutes! >= 60 && expiresInMinutes! % 60 === 0 ? `${expiresInMinutes! / 60} h` : `${expiresInMinutes} min`} if it doesn't trigger)`
      : "";
    const armDescription = parsed.kind === "MONITOR_TRADE"
      ? `monitor your ${symbol} position: alert you on reversal evidence up to 3 times and close it if you don't answer${fakeoutAuthority ? ", and shift the stop loss / take profit on a fakeout" : ""}`
      : `${parsed.kind === "WATCH_AND_ENTER" ? `${parsed.side.toLowerCase()} ${symbol} ${parsed.volume}` : `close ${symbol}`} when it ${triggerCondition!.op === ">=" ? "reaches/exceeds" : "drops to"} ${triggerCondition!.price}${expirySuffix}`;

    // Extra-confirmation gate, same rule as an immediate command (see below):
    // arming a watch is a decision to trade later, so it is confirmed before
    // the row exists, not after it fires.
    if (settings?.eleanorRequireExtraConfirmation !== false && body.confirm !== true) {
      await db.insert(oneClickAuditTable).values({
        userId, action: "ELEANOR_TRADE_COMMAND_CONFIRM_REQUIRED", ip, userAgent: ua,
        metadata: JSON.stringify({ text, kind: parsed.kind, action: "ARM_WATCH", symbol, triggerCondition, source }),
      });
      res.json({
        ok: false, classification: parsed.kind, confirmationRequired: true,
        pendingAction: {
          kind: parsed.kind, action: "ARM_WATCH", symbol,
          volume: parsed.kind === "WATCH_AND_ENTER" && typeof parsed.volume === "number" ? parsed.volume : null,
        },
        message: `Confirm and I'll ${armDescription}. Resend with confirmation to proceed.`,
      });
      return;
    }

    const [w] = await db.insert(eleanorWatchInstructionsTable).values({
      userId, kind: parsed.kind, accountMode, source,
      symbol: symbol ?? null,
      side: parsed.kind === "WATCH_AND_ENTER" ? parsed.side : null,
      lot: parsed.kind === "WATCH_AND_ENTER" && typeof parsed.volume === "number" ? parsed.volume : null,
      // WATCH_AND_ENTER carries the SL/TP the user typed; the evaluator applies
      // them to the OPEN it fires. (MONITOR_TRADE uses this column for its own
      // monitor state — never both on one row.)
      riskParams: parsed.kind === "WATCH_AND_ENTER" && (parsed.stopLoss !== undefined || parsed.takeProfit !== undefined)
        ? JSON.stringify({
          ...(parsed.stopLoss !== undefined ? { stopLoss: parsed.stopLoss } : {}),
          ...(parsed.takeProfit !== undefined ? { takeProfit: parsed.takeProfit } : {}),
        })
        : null,
      positionTicket,
      triggerCondition: triggerCondition ? JSON.stringify(triggerCondition) : null,
      rawUserCommand: text,
      status: "ACTIVE",
      expiresAt,
      ...(fakeoutAuthority ? { riskParams: serializeMonitorState(setFakeoutAuthority(emptyMonitorState(), true)) } : {}),
    }).returning({ id: eleanorWatchInstructionsTable.id });
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_WATCH_ARMED", ip, userAgent: ua,
      metadata: JSON.stringify({ text, kind: parsed.kind, symbol, triggerCondition, positionTicket, expiresAt, pendingKind: pendingKind ?? null, fakeoutAuthority, source, channel: "ELEANOR_CHAT" }),
    });
    res.json({
      ok: true, classification: parsed.kind, watchId: w!.id,
      message: parsed.kind === "MONITOR_TRADE"
        ? `Watching your ${symbol} position (checked about every ${Math.round(getEleanorSweeperStatus().intervalMs / 1000)} s). If the idea is invalidated or price reaches your stop I close it at once. If I see a reversal building I alert you — up to 3 times; answer "keep it" or "close it". No answer after the third alert and I take the decision to close.${fakeoutAuthority ? " You also let me shift the stop loss or take profit when I see a fakeout (a spike that snaps back); each shift is bounded, announced, and confirmed by the broker." : ""}`
        : `Armed a ${pendingKind ? `${pendingKind}-style pending entry` : "conditional order"}: I'll ${parsed.kind === "WATCH_AND_ENTER" ? parsed.side?.toLowerCase() : "close"} ${symbol} when it ${triggerCondition!.op === ">=" ? "reaches/exceeds" : "drops to"} ${triggerCondition!.price}${parsed.kind === "WATCH_AND_ENTER" && parsed.stopLoss !== undefined ? `, SL ${parsed.stopLoss}` : ""}${parsed.kind === "WATCH_AND_ENTER" && parsed.takeProfit !== undefined ? `, TP ${parsed.takeProfit}` : ""}${expirySuffix}.`,
    });
    return;
  }

  // SCALP_BEST_SETUP is an autonomy-adjacent capability (find + act on the
  // strongest setup). It is intentionally NOT armed in this build — refuse
  // honestly rather than act autonomously.
  if (parsed.kind === "SCALP_BEST_SETUP") {
    res.json({
      ok: false, classification: "SCALP_BEST_SETUP", deferred: true,
      message: "Auto-scalping the best setup isn't something I'll do on my own — pick a market and give me a direct command and I'll take it.",
    });
    return;
  }

  // Map parsed command → InstantTradeIntent
  let intent: InstantTradeIntent;
  let commandKind: EleanorCommandKind;
  switch (parsed.kind) {
    case "OPEN":
      commandKind = "OPEN_TRADE";
      intent = {
        source, action: parsed.side, accountMode, symbol: parsed.symbol,
        volume: parsed.volume, orderType: parsed.orderType,
        // SL/TP typed on the command itself ("buy EURUSD 0.01 sl 1.0850 tp 1.0950").
        ...(parsed.stopLoss !== undefined ? { stopLoss: parsed.stopLoss } : {}),
        ...(parsed.takeProfit !== undefined ? { takeProfit: parsed.takeProfit } : {}),
        aiCommand: true, parsedByEleanor: true, rawUserCommand: text,
        eleanorCommandKind: "OPEN",
      };
      break;
    case "CLOSE_ONE": {
      // Resolve a single open position for that symbol; if multiple,
      // refuse and let the user disambiguate. NEVER pick one silently.
      const open = (await readOpenPositions({ userId, venue: "LIVE", basis: "UNCLOSED", symbol: parsed.symbol })).map((p) => p.row);
      if (open.length === 0) {
        await db.insert(oneClickAuditTable).values({
          userId, action: "INSTANT_CLOSE_REJECTED", ip, userAgent: ua,
          metadata: JSON.stringify({ text, reason: "NO_OPEN_POSITION", symbol: parsed.symbol, source }),
        });
        res.json({ ok: false, classification: "NO_OPEN_POSITION", message: `No open ${parsed.symbol} position to close.` });
        return;
      }
      if (open.length > 1) {
        await db.insert(oneClickAuditTable).values({
          userId, action: "INSTANT_CLOSE_REJECTED", ip, userAgent: ua,
          metadata: JSON.stringify({ text, reason: "AMBIGUOUS_POSITION", symbol: parsed.symbol, count: open.length, source }),
        });
        res.json({
          ok: false, classification: "AMBIGUOUS_POSITION",
          message: `You have ${open.length} open ${parsed.symbol} positions — tell me which ticket to close.`,
        });
        return;
      }
      commandKind = "CLOSE_TRADE";
      intent = {
        source, action: "CLOSE", accountMode, symbol: parsed.symbol,
        positionId: open[0]!.brokerTicket,
        aiCommand: true, parsedByEleanor: true, rawUserCommand: text,
        eleanorCommandKind: "CLOSE",
      };
      break;
    }
    case "PARTIAL_CLOSE": {
      // Reduce-risk: close part of a single open position. Resolves the same
      // way as CLOSE_ONE (no silent pick) but carries closeVolume so only that
      // many lots are closed via the EXISTING close primitive.
      const open = (await readOpenPositions({ userId, venue: "LIVE", basis: "UNCLOSED", symbol: parsed.symbol })).map((p) => p.row);
      if (open.length === 0) {
        await db.insert(oneClickAuditTable).values({
          userId, action: "INSTANT_CLOSE_REJECTED", ip, userAgent: ua,
          metadata: JSON.stringify({ text, reason: "NO_OPEN_POSITION", symbol: parsed.symbol, partial: true, source }),
        });
        res.json({ ok: false, classification: "NO_OPEN_POSITION", message: `No open ${parsed.symbol} position to partially close.` });
        return;
      }
      if (open.length > 1) {
        await db.insert(oneClickAuditTable).values({
          userId, action: "INSTANT_CLOSE_REJECTED", ip, userAgent: ua,
          metadata: JSON.stringify({ text, reason: "AMBIGUOUS_POSITION", symbol: parsed.symbol, count: open.length, partial: true, source }),
        });
        res.json({
          ok: false, classification: "AMBIGUOUS_POSITION",
          message: `You have ${open.length} open ${parsed.symbol} positions — tell me which ticket to trim.`,
        });
        return;
      }
      const row = open[0]!;
      // Resolve the lots to close: explicit volume wins, else fraction of the
      // position's current size, else refuse rather than guess.
      const posVol = Number(row.volume ?? 0);
      let closeVol: number | null = null;
      if (typeof parsed.volume === "number" && parsed.volume > 0) closeVol = parsed.volume;
      else if (typeof parsed.fraction === "number" && parsed.fraction > 0 && posVol > 0) {
        closeVol = Math.round(posVol * parsed.fraction * 100) / 100;
      }
      if (closeVol == null || !(closeVol > 0)) {
        res.json({ ok: false, classification: "PARTIAL_CLOSE_NEEDS_AMOUNT", message: `How much of ${parsed.symbol} should I close — e.g. "half" or "0.01"?` });
        return;
      }
      if (posVol > 0 && closeVol >= posVol) {
        // Asking to close the whole thing → treat as a full close.
        commandKind = "CLOSE_TRADE";
        intent = {
          source, action: "CLOSE", accountMode, symbol: parsed.symbol,
          positionId: row.brokerTicket,
          aiCommand: true, parsedByEleanor: true, rawUserCommand: text,
          eleanorCommandKind: "CLOSE",
        };
        break;
      }
      commandKind = "PARTIAL_CLOSE";
      intent = {
        source, action: "CLOSE", accountMode, symbol: parsed.symbol,
        positionId: row.brokerTicket, closeVolume: closeVol,
        aiCommand: true, parsedByEleanor: true, rawUserCommand: text,
        eleanorCommandKind: "PARTIAL_CLOSE",
      };
      break;
    }
    case "CLOSE_ALL":
      commandKind = "CLOSE_ALL";
      intent = {
        source, action: "CLOSE_ALL", accountMode, aiCommand: true,
        parsedByEleanor: true, rawUserCommand: text, eleanorCommandKind: "CLOSE_ALL",
      };
      break;
    case "CLOSE_ALL_SYMBOL_UNSUPPORTED":
      await db.insert(oneClickAuditTable).values({
        userId, action: "INSTANT_CLOSE_REJECTED", ip, userAgent: ua,
        metadata: JSON.stringify({ text, reason: "CLOSE_ALL_SYMBOL_UNSUPPORTED", symbol: parsed.symbol, source }),
      });
      res.json({
        ok: false, classification: "CLOSE_ALL_SYMBOL_UNSUPPORTED",
        message: `"Close all ${parsed.symbol}" isn't supported yet — say "close all" to close every open position, or close them one at a time by ticket.`,
      });
      return;
    case "CLOSE_PROFITABLE":
    case "CLOSE_LOSING":
      // Not auto-executed — defer to user; Eleanor will offer it as a list.
      await db.insert(oneClickAuditTable).values({
        userId, action: "INSTANT_CLOSE_REJECTED", ip, userAgent: ua,
        metadata: JSON.stringify({ text, reason: parsed.kind, source }),
      });
      res.json({
        ok: false, classification: parsed.kind,
        message: `Selective bulk-close (${parsed.kind === "CLOSE_PROFITABLE" ? "winners" : "losers"}) isn't auto-executed yet — close them one-by-one for now.`,
      });
      return;
    case "MODIFY": {
      const sym = parsed.positionRef.symbol;
      if (!sym) {
        await db.insert(oneClickAuditTable).values({
          userId, action: "INSTANT_EXECUTE_REJECTED", ip, userAgent: ua,
          metadata: JSON.stringify({ text, reason: "MODIFY_NEEDS_SYMBOL", source }),
        });
        res.json({ ok: false, classification: "MODIFY_NEEDS_SYMBOL", message: "Which market should I modify?" });
        return;
      }
      const open = (await readOpenPositions({ userId, venue: "LIVE", basis: "UNCLOSED", symbol: sym })).map((p) => p.row);
      if (open.length === 0) {
        await db.insert(oneClickAuditTable).values({
          userId, action: "INSTANT_EXECUTE_REJECTED", ip, userAgent: ua,
          metadata: JSON.stringify({ text, reason: "NO_OPEN_POSITION", symbol: sym, modify: true, source }),
        });
        res.json({ ok: false, classification: "NO_OPEN_POSITION", message: `No open ${sym} position to modify.` });
        return;
      }
      if (open.length > 1) {
        await db.insert(oneClickAuditTable).values({
          userId, action: "INSTANT_EXECUTE_REJECTED", ip, userAgent: ua,
          metadata: JSON.stringify({ text, reason: "AMBIGUOUS_POSITION", symbol: sym, count: open.length, modify: true, source }),
        });
        res.json({ ok: false, classification: "AMBIGUOUS_POSITION", message: `Multiple ${sym} positions — please specify the ticket.` });
        return;
      }
      const row = open[0]!;
      const newSl = parsed.newStopLoss === "BREAK_EVEN"
        ? Number(row.entryPrice)
        : (typeof parsed.newStopLoss === "number" ? parsed.newStopLoss : null);
      commandKind = "MODIFY_SL_TP";
      intent = {
        source, action: "MODIFY_SL_TP", accountMode, symbol: sym,
        positionId: row.brokerTicket,
        newStopLoss: newSl, newTakeProfit: parsed.newTakeProfit ?? null,
        aiCommand: true, parsedByEleanor: true, rawUserCommand: text,
        eleanorCommandKind: "MODIFY",
      };
      break;
    }
    case "MOVE_SL_TO_BREAKEVEN": {
      // Reduce-risk: move the stop to the entry price. Maps to the EXISTING
      // MODIFY primitive but carries the break-even command kind so the
      // dedicated break-even permission gate applies.
      const sym = parsed.positionRef.symbol;
      if (!sym) {
        res.json({ ok: false, classification: "MODIFY_NEEDS_SYMBOL", message: "Which market should I move to break-even?" });
        return;
      }
      const open = (await readOpenPositions({ userId, venue: "LIVE", basis: "UNCLOSED", symbol: sym })).map((p) => p.row);
      if (open.length === 0) {
        res.json({ ok: false, classification: "NO_OPEN_POSITION", message: `No open ${sym} position to move to break-even.` });
        return;
      }
      if (open.length > 1) {
        res.json({ ok: false, classification: "AMBIGUOUS_POSITION", message: `Multiple ${sym} positions — please specify the ticket.` });
        return;
      }
      const row = open[0]!;
      commandKind = "MOVE_SL_TO_BREAKEVEN";
      intent = {
        source, action: "MODIFY_SL_TP", accountMode, symbol: sym,
        positionId: row.brokerTicket,
        newStopLoss: Number(row.entryPrice), newTakeProfit: null,
        aiCommand: true, parsedByEleanor: true, rawUserCommand: text,
        eleanorCommandKind: "MOVE_SL_TO_BREAKEVEN",
      };
      break;
    }
    default: {
      // Exhaustiveness guard — any executable kind must be handled above.
      res.json({ ok: false, classification: "UNSUPPORTED_COMMAND", message: "I couldn't turn that into a trade action." });
      return;
    }
  }

  // Extra-confirmation gate — makes eleanorRequireExtraConfirmation FUNCTIONAL.
  // When AI-Assisted is ON and eleanorRequireExtraConfirmation is OFF, Eleanor acts on
  // an allowed user-commanded action without re-asking. When it is ON (the safe
  // default) Eleanor returns a confirmation-required response and executes nothing
  // until the caller resends with confirm:true. This is the ONLY thing the
  // confirmation setting controls — it never bypasses any backend gate; the full
  // 16-gate live pipeline still runs on the confirmed dispatch. Default-deny: a
  // missing or true setting requires confirmation.
  const requireExtraConfirm = settings?.eleanorRequireExtraConfirmation !== false;
  if (requireExtraConfirm && body.confirm !== true) {
    await db.insert(oneClickAuditTable).values({
      userId, action: "ELEANOR_TRADE_COMMAND_CONFIRM_REQUIRED", ip, userAgent: ua,
      metadata: JSON.stringify({
        text, kind: parsed.kind, action: intent.action,
        symbol: intent.symbol ?? null, source,
      }),
    });
    res.json({
      ok: false, classification: parsed.kind, confirmationRequired: true,
      pendingAction: {
        kind: parsed.kind, action: intent.action,
        symbol: intent.symbol ?? null,
        volume: typeof intent.volume === "number" ? intent.volume : null,
      },
      message: `Confirm and I'll ${intent.action.toLowerCase()}${intent.symbol ? " " + intent.symbol : ""}${typeof intent.volume === "number" ? " " + intent.volume : ""}. Resend with confirmation to proceed.`,
    });
    return;
  }

  // Record → advisory handshake → dispatch through the EXISTING router. This is
  // the ONLY execution path; the ledger never bypasses a single gate.
  const ledger = await recordAndExecuteEleanor({
    userId, intent, commandKind,
    symbol: intent.symbol ?? null, rawText: text, ip, ua, params: parsed,
  });
  if (ledger.duplicate) {
    res.status(409).json({
      ok: false, classification: "DUPLICATE_PREVENTED",
      message: `A matching ${assistantName} command is already pending — I won't send it twice.`,
    });
    return;
  }
  const result = ledger.result;
  if (result.ok) {
    // result.ok means the command was DISPATCHED to the broker — NOT that it
    // filled. Never claim "executed" before broker confirmation; the fill
    // arrives asynchronously via the command-status poll.
    const what = `${intent.action.toLowerCase()}${intent.symbol ? " " + intent.symbol : ""}${intent.volume ? " " + intent.volume : ""}`;
    res.json({
      ok: true, classification: parsed.kind, action: intent.action,
      commandId: result.commandId,
      message: `Sent your ${what} to the broker — I'll confirm here as soon as it's filled.`,
    });
    return;
  }
  res.status(result.httpStatus).json({
    ok: false, classification: parsed.kind, error: result.error,
    primaryReason: result.primaryReason ?? null,
    message: `I couldn't execute: ${result.error}.`,
  });
}));

// ───────────────────────────────────────────────────────────────────────
// POST /me/assistant/watch/evaluate
// Evaluate the CALLING user's ACTIVE watch instructions against live price and
// single-fire any whose trigger is met. Each fire is a CAS (ACTIVE→FIRED) so a
// watch can fire AT MOST ONCE even under concurrent polls; the winning update
// then dispatches through the SAME instant-trade router (all gates apply).
// MONITOR_TRADE is a permission-bounded monitor-and-manage engine: it builds a
// Trade Management Plan from the real position + live price (trade-health
// engine) and — ONLY when the user granted AI_ASSISTED + allowEleanorMonitor —
// CAS-fires a single protective CLOSE through the SAME router when the plan's
// trigger is met (original thesis invalidated, or price at/through the user's
// own stop). It never fabricates an exit level and never closes a healthy
// position. This is the USER-AUTHORIZED Eleanor path; the system-wide unilateral
// auto-close engine stays ALERT_ONLY.
// ───────────────────────────────────────────────────────────────────────
router.post("/me/assistant/watch/evaluate", requireUser, safe(async (req, res) => {
  const userId = (req.authUser!).id;
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.socket.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;
  const r = await evaluateEleanorWatchesForUser(userId, { ip, ua, trigger: "route" });
  res.json({ ok: true, ...r, sweeper: getEleanorSweeperStatus() });
}));

// GET /me/assistant/watches — the signed-in user's Eleanor watches (active by
// default) with monitor alert state, for the chat panel strip and the
// getMyWatches tool. Read-only.
router.get("/me/assistant/watches", requireUser, safe(async (req, res) => {
  const userId = (req.authUser!).id;
  const includeFinished = String(req.query["includeFinished"] ?? "") === "true";
  const watches = await listEleanorWatches(userId, { includeFinished, limit: 25 });
  res.json({ ok: true, watches, sweeper: getEleanorSweeperStatus() });
}));

// POST /me/assistant/watches/:id/ack { decision: "keep" | "close" } — the
// trader's answer to a reversal alert. "keep" resets the unanswered-alert count;
// "close" fires the close now through the same gated path.
router.post("/me/assistant/watches/:id/ack", requireUser, safe(async (req, res) => {
  const userId = (req.authUser!).id;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { err(res, 400, "invalid_id"); return; }
  const decision = (req.body as { decision?: unknown } | undefined)?.decision;
  if (decision !== "keep" && decision !== "close") { err(res, 400, "invalid_decision"); return; }
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.socket.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;
  const r = await acknowledgeEleanorWatch(userId, id, decision, { ip, ua, trigger: "ack" });
  if (!r.ok) { res.status(r.error === "WATCH_NOT_FOUND" ? 404 : 409).json(r); return; }
  const assistantName = await getAssistantDisplayName(userId);
  if (r.decision === "keep") {
    res.json({ ...r, message: `Understood — staying in. I'll keep monitoring and start a fresh count if the reversal evidence persists.` });
    return;
  }
  const fired = r.result.fired[0];
  const skipped = r.result.skipped[0];
  res.json({
    ...r,
    message: fired
      ? (fired.blocked ? `I tried to close it but a safety gate refused: ${fired.blocked}.` : `Closing now — ${assistantName} sent the close to the broker; I'll confirm when it fills.`)
      : skipped?.reason === "POSITION_GONE" ? "That position is already closed."
      : skipped ? `I couldn't close it: ${skipped.reason}.`
      : "Nothing to do.",
  });
}));

// POST /me/assistant/watches/:id/fakeout-authority { enabled } — the trader
// grants or withdraws Eleanor's bounded authority to shift SL/TP on a fakeout for
// one monitor (owner spec 2026-11-04). The user-level modify permission and
// AI-Assisted authority are still required at fire time.
router.post("/me/assistant/watches/:id/fakeout-authority", requireUser, safe(async (req, res) => {
  const userId = (req.authUser!).id;
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) { err(res, 400, "invalid_id"); return; }
  const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
  if (typeof enabled !== "boolean") { err(res, 400, "invalid_enabled"); return; }
  const r = await setEleanorWatchFakeoutAuthority(userId, id, enabled);
  if (!r.ok) { res.status(r.error === "WATCH_NOT_FOUND" ? 404 : 409).json(r); return; }
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;
  await db.insert(oneClickAuditTable).values({
    userId, action: enabled ? "ELEANOR_FAKEOUT_AUTHORITY_GRANTED" : "ELEANOR_FAKEOUT_AUTHORITY_WITHDRAWN", ip,
    userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
    metadata: JSON.stringify({ watchId: id, enabled }),
  });
  const assistantName = await getAssistantDisplayName(userId);
  res.json({ ...r, message: enabled
    ? `${assistantName} may now shift this position's stop loss or take profit when a fakeout is in progress — bounded, announced, broker-confirmed.`
    : `${assistantName} will only alert and close on this position; no SL/TP shifts.` });
}));

export { router as meAssistantRouter };
