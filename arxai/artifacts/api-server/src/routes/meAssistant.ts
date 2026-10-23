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
  db, arxAssistantConversationsTable, arxAssistantMessagesTable, arxAssistantToolCallsTable,
  oneClickAuditTable, userOneClickSettingsTable, arxLivePositionsTable,
  rubyCommandsTable, rubyWatchInstructionsTable, type RubyCommandKind,
} from "@workspace/db";
import { and, asc, desc, eq, isNull, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { parseTradeCommand } from "../lib/assistant/parseTradeCommand.js";
import { executeInstant, type InstantTradeIntent, type InstantTradeResult } from "../lib/live/instantTrade.js";
import { runHandshake } from "../lib/handshake/coordinator.js";
import { classifyTradeHealth, computeSlDistance, type OpenPositionInput } from "@workspace/domain/trade-health";
import { getMarketData } from "../lib/data/dataManager.js";
import {
  analyzeChartStructure, quickTrend, higherTimeframeOf, type StructureBias,
} from "../lib/assistant/chartStructure.js";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import { isUniqueViolation } from "../lib/pgError.js";
import { openai } from "@workspace/integrations-openai-ai-server";
import {
  TOOL_DEFINITIONS, dispatchTool, classifyIntent,
  setRequestPageContext,
  detectChartReadIntent, detectTradeOptionsIntent, resolveAssistantToolChoice,
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
import { buildRubyContext, composeRubyBriefing, type RubyRole } from "../lib/assistant/rubyContext.js";
import { resolveAssistantMarket } from "../lib/markets/assistantMarketResolver.js";
import {
  buildChartIntelligenceState,
  getCachedIntelligenceContext,
} from "../lib/data/chart/chartIntelligence.js";
import { type ChartTimeframe } from "../lib/data/chart/timeframes.js";
import { buildRubyChartContext, buildGatedTrustLine } from "../lib/data/chart/rubyChartContext.js";
import { buildRubyStructuralRead } from "../lib/assistant/rubyStructuralReadService.js";
import { buildDecisionSnapshot, recordDecisionSnapshot } from "../lib/data/chart/chartDecisionSnapshot.js";
import { buildRubyDraftRead, type RubyDraftIntent } from "../lib/assistant/rubyDraftRead.js";
import { recordRubyReadDecision } from "../lib/chart/recordRubyRead.js";
import { classifySymbol } from "../lib/data/marketDataRouter.js";
import { getUserAllocationView } from "../lib/live/masterBridgePool.js";
import {
  buildSetupPreview,
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
import { recordSignalOnAppear } from "../lib/rubyQuality/index.js";
import { mintRealtimeSession, getVoiceModeStatus } from "../lib/assistant/realtimeSession.js";
import { computeRubySignalAdvisory, recordAdvisoryTrace } from "../lib/agentEcosystem/advisoryInfluence.js";
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

// Ruby's REPORTED safety state is DERIVED per-user (honest both ways) — never a
// hardcoded paper-only stub that drifts from reality. The shared helper is
// fail-closed: any envelope read failure collapses to FAIL_CLOSED_ENVELOPE
// (off / locked). Advisory / reporting only — this changes what Ruby *says*,
// never what it is *allowed to do* (order-guard chain + 16-gate Phase B dispatch
// + the explicit per-trade confirmation choreography are untouched).
async function buildPerUserEnvelope(userId: number | null | undefined) {
  return assistantEnvelopeFields(await deriveAssistantEnvelope(userId ?? null));
}

// Synchronous fail-closed envelope fields for error responses (err() can't await).
const FAIL_CLOSED_FIELDS = assistantEnvelopeFields(FAIL_CLOSED_ENVELOPE);
const MAX_TURNS_PER_REQUEST = 4;
const MAX_HISTORY_MESSAGES = 20;
const MAX_USER_MESSAGE_CHARS = 4000;
const MODEL = "gpt-5.4";

function err(res: import("express").Response, status: number, message: string) {
  res.status(status).json({ error: message, ...FAIL_CLOSED_FIELDS });
}

// Task #412 — Top-250 universe gate for Ruby's READ-ONLY chart surfaces.
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
  const proxyKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  const directKey = process.env["OPENAI_API_KEY"];
  const configured = Boolean(proxyKey && proxyKey.trim().length > 0);
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

// ── T023: context-aware Ruby briefing ────────────────────────────────────
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
  const role: RubyRole = rawRole === "OWNER" ? "OWNER" : rawRole === "ADMIN" ? "ADMIN" : "USER";
  const parsed = BriefingQuery.safeParse(req.query);
  const page = parsed.success ? (parsed.data.page ?? "/") : "/";
  const symbol = parsed.success ? (parsed.data.symbol ?? null) : null;
  const assistantName = await getAssistantDisplayName(userId);
  try {
    const ctx = await buildRubyContext(userId, role, page, symbol);
    const briefing = composeRubyBriefing(ctx);
    res.json({ briefing, ...(await buildPerUserEnvelope(userId)) });
  } catch (e) {
    try { req.log?.error({ err: (e as Error)?.message }, "ruby_briefing_failed"); } catch { /* noop */ }
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

// ── Ruby Setup Reason — scanner signal explanation ───────────────────────
// Small deterministic structured explanation used by the Market Scanner
// cards (and trade modal) under the heading "Ruby's Setup Reason".
//
// Design notes:
//  - No LLM call. The scanner has already produced reasonForTrade /
//    reasonToAvoid / bias / confidence; Ruby just rephrases them into a
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
// Ruby AACI advisory block — a clean, plain-English cohesion read attached to
// Ruby's signal/chart explanations. READ-ONLY and fail-open: any error returns
// null and Ruby's read is unchanged. Never leaks machine codes or sub-scores.
async function buildRubyAaciBlock(
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
      actorType: "ruby",
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
    // Advisory only — never fail Ruby's read on an AACI hiccup.
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
  // the scanner; Ruby just reshapes it.
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
  if (s.statusBadge && /SPREAD|CHOPPY|REJECT/i.test(s.statusBadge)) {
    cautions.push(`Scanner flagged ${s.statusBadge.replace(/_/g, " ").toLowerCase()}.`);
  }

  // Agent Ecosystem advisory (Phase 0). Ruby surfaces, in plain English, how the
  // desk's trusted agents weigh in on this read — and folds any agent cautions
  // (e.g. a trusted Risk agent pushing back) into the existing caution list.
  // Advisory only: it never changes liveLocked / allowOrderExecution and never
  // gates a trade. Fail-open: any error leaves Ruby's read unchanged.
  let deskView: string | null = null;
  try {
    const advisory = await computeRubySignalAdvisory({
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
      // a bounded, PROTECTIVE plain-English outcome. Ruby surfaces the headline +
      // any agent push-backs as cautions. Read-only: it never changes liveLocked /
      // allowOrderExecution and never gates a trade. Fail-open within this try.
      const traffic = await runTrafficSelection("RUBY", "LOW");
      const review = computeSurfaceGovernance({
        surface: "RUBY",
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
          surface: "RUBY", symbol: s.symbol, timeframe: s.timeframe ?? null,
          direction: side, at: new Date().toISOString(), review,
        });
        // Agent Court auto-wiring — record a Court learning entry on a genuine
        // disagreement (fire-and-forget) and stamp the trace. Read-only; never live.
        const disagreementCourtUsed = maybeRecordDisagreement(review, {
          symbol: s.symbol, timeframe: s.timeframe ?? "—", tradeType: "intraday",
        });
        // Durable proof (fail-soft, fire-and-forget — never blocks Ruby's read).
        void persistGovernanceTrace({
          actionType: "RUBY_ANALYSIS", surface: "RUBY",
          userId: req.authUser?.id ?? null, role: req.authUser?.role ?? null,
          symbol: s.symbol, timeframe: s.timeframe ?? null,
          review, participants: traffic.participants,
          consideredKeys: traffic.consideredKeys, rubySummaryUsed: true,
          disagreementCourtUsed,
        });
      }
    }
  } catch { /* advisory + governance are best-effort; never fail Ruby's read */ }

  // Chart Brain v2 (Task 5): record an immutable Decision Receipt + chart events
  // for this official Ruby signal explanation. Fire-and-forget, fail-open, Slow
  // Brain. Only when a timeframe is present (a fingerprint needs one — we never
  // fabricate context).
  if (req.authUser?.id != null && s.timeframe) {
    recordRubyReadDecision({
      userId: req.authUser.id,
      source: "ruby_explain_signal",
      intent: "analyze",
      direction: side,
      symbol: s.symbol,
      timeframe: s.timeframe,
    });
    // Task #199 — Outcome Learning: track this Ruby signal the moment it
    // appears, locking its "at signal" snapshot. Fire-and-forget, fail-open:
    // never block or fail Ruby's read. OBSERVATION ONLY — places nothing.
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
    }).catch(() => { /* outcome tracking is best-effort; never fail Ruby's read */ });

    // Phase 3 — Chart Decision Snapshot: capture the point-in-time chart
    // state at this serious read moment (truth score, read score, gate output,
    // broker alignment, latest candle ref). Fire-and-forget, fail-open — never
    // blocks Ruby's response. Provides a replay-honesty anchor for the read.
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
        source: "ruby_explain_signal",
      });
      recordDecisionSnapshot(req.authUser!.id, snapshot);
    }).catch(() => { /* snapshot capture is best-effort; never fail Ruby's read */ });
  }
  const [envelope, aaci] = await Promise.all([
    buildPerUserEnvelope(req.authUser?.id ?? null),
    buildRubyAaciBlock(req.authUser?.id ?? null, s.symbol, s.timeframe ?? null),
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

// ── Ruby chart read — structural, plain-English market-structure read ─────
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
  // server still runs its own authoritative gate via buildRubyChartContext. When
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

  const outcome = await buildRubyStructuralRead({
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
    recordRubyReadDecision({
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
    buildRubyAaciBlock(req.authUser?.id ?? null, symbol, outcome.normalizedTimeframe ?? timeframe),
  ]);
  res.json({
    chartRead: outcome.chartRead,
    ...(aaci ? { aaci } : {}),
    ...envelope,
    readOnlyMode: true,
  });
}));

// ── Task #374: Ruby/AI Setup-Preview ("draw a setup on the chart") ───────
// READ-ONLY. Produces a SETUP DRAWING (entry/SL/TP, risk/reward zones,
// invalidation, confidence, setup-type, plain-English explanation) for the
// symbol/timeframe on screen. A preview is a visual reasoning aid — it is NEVER
// an order and this endpoint can never place, modify, or close a trade. It
// reuses the SAME verified RubyChartContext honesty gate as read-chart (no
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
  let rubyCtx: Awaited<ReturnType<typeof buildRubyChartContext>> | null = null;
  try {
    rubyCtx = await buildRubyChartContext(symbol, timeframe as ChartTimeframe, 200);
  } catch {
    // fail-safe — handled as a gated (non-VERIFIED) read below.
  }

  const candles = rubyCtx?.candles ?? [];
  let htfBias: StructureBias = "No clear edge";
  if ((rubyCtx?.htfCandles.length ?? 0) >= 10) htfBias = quickTrend(rubyCtx!.htfCandles);
  const read = analyzeChartStructure(candles, { htfBias, draft: draft ?? null });
  if (clientFeedUnconfirmed) {
    read.dataQuality = "insufficient";
    if (!read.cautions.includes("Feed not confirmed at draw-time — limited visibility.")) {
      read.cautions = [...read.cautions, "Feed not confirmed at draw-time — limited visibility."];
    }
  }

  const basis = rubyCtx?.basis ?? "INSUFFICIENT";
  const trustLine = rubyCtx?.trustLine ?? `${timeframe} candles syncing`;
  const blockReason = rubyCtx?.blockReason ?? null;

  // Provider honesty: no broker-native quote feed is active yet
  // (MT5_BROKER_FEED_NOT_ACTIVE), so every current feed is a composite /
  // synthetic source — the producer must never use broker-native language.
  const assetClass = classifySymbol(symbol);
  const providerSource: SetupPreviewProviderSource = {
    assetClass,
    composite: true,
    label: assetClass === "synthetic" ? "synthetic index" : "composite market-data",
  };

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
  // Each signal is sourced from the SAME service the scanner/Ruby/scalp/governance
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
    //   - runGovernance: the SAME advisory → Traffic → Court flow the Ruby
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
          const advisory = await computeRubySignalAdvisory({
            baseScore: confNum,
            direction: govSide,
            confidenceScore: confNum,
            riskScore: riskNum,
          });
          if (!advisory || advisory.influencingAgentCount <= 0) return null;
          const traffic = await runTrafficSelection("RUBY", "LOW");
          const review = computeSurfaceGovernance({
            surface: "RUBY",
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
    riskScore,
    flameStage,
    runOnQuality,
    governanceOutcome,
    governanceCautions,
    createdBy: "ruby",
  });

  // Chart Brain v2: record an immutable Decision Receipt for this official read.
  // Fire-and-forget, fail-open, Slow Brain — never awaited, never on the live path.
  if (req.authUser?.id != null) {
    recordRubyReadDecision({
      userId: req.authUser.id,
      source: "chart_read",
      intent: "analyze",
      direction: (side ?? draft?.side) ?? null,
      symbol,
      timeframe,
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
  res.json({
    setupPreview: drawFeedNotClean
      ? neutralizeFeedCopyDeep(setupPreviewPayload)
      : setupPreviewPayload,
    ...READ_ONLY_PAPER_ENVELOPE,
  });
}));

// ── Chart Brain v2 (Task 4): Ruby Draft Read ─────────────────────────────
// READ-ONLY. Assembles a deterministic prepared Ruby read over the cached
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

  // Build (or reuse the 3s-cached) RubyChartContext — the SAME canonical chart
  // source POST /me/assistant/read-chart uses — so we have an honest `basis`
  // ("VERIFIED" | "PARTIAL" | "SYNCING" | "INSUFFICIENT") alongside the
  // intelligence state. The builder degrades to an honest empty/insufficient
  // context on a dirty feed and never fabricates; a build failure is treated as
  // gate-blocked (basis !== "VERIFIED") below.
  let rubyCtx: Awaited<ReturnType<typeof buildRubyChartContext>> | null = null;
  try {
    rubyCtx = await buildRubyChartContext(symbol, timeframe as ChartTimeframe, limit);
  } catch {
    // fail-safe — treat as gate-blocked below
  }
  const state = rubyCtx?.state ?? (await buildChartIntelligenceState(symbol, timeframe, limit));
  const draftAssistantName = req.authUser?.id != null ? await getAssistantDisplayName(req.authUser.id) : undefined;
  const draftRead = buildRubyDraftRead(state, intent as RubyDraftIntent, draft ?? null, draftAssistantName);
  // HONESTY (same pattern as the read-chart gated branch): when the read is
  // gated (basis !== "VERIFIED"), never let the success-path trust line claim
  // "Verified … · Live feed …". `buildRubyDraftRead` composes its trustLine from
  // raw Phase-3 gate flags (buildTrustLine) which can disagree with the feed
  // truth that drives `basis` — e.g. every gate flag passes but the feed is
  // delayed (state.aiUsable === false), so basis is INSUFFICIENT while the line
  // still reads "Verified … · Live feed …". Derive a feed-state-driven gated
  // line from the ACTUAL feed state instead. Advisory-only: Ruby stays
  // read-only and this never gates execution.
  if (!rubyCtx || rubyCtx.basis !== "VERIFIED") {
    draftRead.trustLine = buildGatedTrustLine(timeframe, {
      available: rubyCtx != null,
      stale: rubyCtx?.state.stale ?? state.stale,
      aiUsable: rubyCtx?.state.aiUsable ?? state.aiUsable,
      basis: rubyCtx?.basis ?? "INSUFFICIENT",
    });
  }
  // Chart Brain v2 (Task 5): record an immutable Decision Receipt + the implied
  // chart events for this official Ruby read. Fire-and-forget, fail-open, Slow
  // Brain — never awaited, never blocks the read, never on the live path.
  if (req.authUser?.id != null) {
    recordRubyReadDecision({
      userId: req.authUser.id,
      source: "ruby_draft_read",
      intent,
      draftReadIntent: intent as RubyDraftIntent,
      direction: draft?.side ?? null,
      symbol,
      timeframe,
      limit,
      state,
    });
  }
  // Ruby's chart-read surface is unconditionally read-only. We return the
  // compile-time fail-closed envelope (paper_only / liveLocked / readOnlyMode /
  // allowOrderExecution:false) rather than the per-user trading envelope, so the
  // contract (safetyMode enum [paper_only]) is truthful and matches the sibling
  // GET /me/chart/intelligence endpoint. Ruby can never act regardless of the
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

// Ruby memory settings — flip the per-user long-term memory toggle.
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

// Export all Ruby chat history + memory snapshot for this user as JSON.
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
  res.setHeader("Content-Disposition", `attachment; filename="ruby-export-${userId}-${exportedAt.slice(0,10)}.json"`);
  res.setHeader("Content-Type", "application/json");
  res.json({
    schema: "arx.ruby.export.v1",
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
      "ruby_chat_request",
    );
  } catch { /* noop */ }

  // Load recent history (user-scoped).
  const history = await db.select().from(arxAssistantMessagesTable)
    .where(and(eq(arxAssistantMessagesTable.conversationId, id), eq(arxAssistantMessagesTable.userId, userId)))
    .orderBy(desc(arxAssistantMessagesTable.createdAt))
    .limit(MAX_HISTORY_MESSAGES);
  const ordered = history.slice().reverse();

  // Open the SSE stream IMMEDIATELY so the user sees "Ruby is thinking…"
  // within milliseconds, not after the memory/history load completes.
  // (Phase Ruby-Speed) — previously we awaited Promise.all([memory,
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

  // Build OpenAI chat messages.
  type ChatMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
    | { role: "tool"; content: string; tool_call_id: string };

  // Phase 22F — strict canonical ARX stream contract.
  // ONLY these event types may reach the frontend:
  //   safety | intent | content | tool_call | tool_result | error | done | ping
  // Any other shape (raw provider event, unknown payload, exception
  // string) MUST be filtered here. The frontend whitelist is the
  // second line of defense; this is the first.
  // `content_clear` (Phase 22V Part-4 — Ruby streaming fix) tells the
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
  // finish. Cap memory load at 1500ms — Ruby will still answer if the
  // long-term memory snapshot is slow; she just won't have it for this
  // turn. Better than blocking the whole response.
  const [envelope, memoryTriple, chatAssistantName] = await Promise.all([
    buildPerUserEnvelope(userId),
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

  for (let turn = 0; turn < MAX_TURNS_PER_REQUEST; turn++) {
    if (aborted) break;
    let stream: AsyncIterable<{ choices: Array<{ delta: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> }>;
    try {
      stream = await openai.chat.completions.create({
        model: MODEL,
        max_completion_tokens: 8192,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: messages as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: tools as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tool_choice: resolveAssistantToolChoice(turn, forceStructuralRead) as any,
        stream: true,
      }) as unknown as AsyncIterable<{ choices: Array<{ delta: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> }>;
    } catch (e) {
      try { (req as { log?: { error: (...a: unknown[]) => void } }).log?.error({ err: (e as Error)?.message }, "assistant_openai_failed"); } catch { /* noop */ }
      send({ type: "error", message: "AI provider unavailable. Please try again in a moment." });
      send({ type: "done" });
      cleanupStream();
      res.end();
      return;
    }

    let turnContent = "";
    const toolCallsAcc: Record<number, { id: string; name: string; args: string }> = {};
    let finishReason: string | null = null;
    // Phase 22V Part-4 — live token streaming with deferred preamble drop.
    //
    // We now flush `delta.content` to the client as it arrives so users see
    // Ruby's reply build up token-by-token (natural typewriter feel)
    // instead of receiving the whole answer in one paste-block at the end
    // of the turn. We also track the running per-turn char count so that
    // IF this turn turns out to be preamble (i.e. tool_calls followed),
    // we can emit `content_clear` with the exact number of characters to
    // strip from the visible message — preserving the original Phase 22S2
    // invariant that preamble never reaches the final visible reply or
    // TTS, while still giving the user immediate feedback.

    // Phase 22F — wrap the consumer loop so a mid-stream provider
    // exception (network blip, malformed chunk, abort) becomes a clean
    // canonical ARX error instead of crashing the request and letting
    // Express send an HTML error page through the SSE socket.
    try {
      for await (const chunk of stream) {
        if (aborted) break;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (delta.content) {
          // Phase 22V Part-4 — stream live AND track for a possible drop.
          turnContent += delta.content;
          send({ type: "content", content: delta.content });
        }
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: tc.id ?? `call_${idx}`, name: "", args: "" };
            if (tc.id) toolCallsAcc[idx].id = tc.id;
            if (tc.function?.name) toolCallsAcc[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCallsAcc[idx].args += tc.function.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (e) {
      try { (req as { log?: { error: (...a: unknown[]) => void } }).log?.error({ err: (e as Error)?.message }, "assistant_stream_consume_failed"); } catch { /* noop */ }
      // Phase 22V Part-4 — if we already streamed any preamble live for
      // this turn, strip it from the client before sending `done` so the
      // TTS path won't speak a partial/preamble fragment. Same invariant
      // as the tool-calls branch: nothing the user sees or hears should
      // be a mid-turn fragment that the model never finalised.
      if (turnContent.length > 0) {
        send({ type: "content_clear", chars: turnContent.length });
      }
      send({ type: "error", message: "AI stream interrupted. Please try again." });
      send({ type: "done" });
      cleanupStream();
      res.end();
      return;
    }

    if (aborted) break;

    const calls = Object.values(toolCallsAcc).filter((c) => c.name);
    if (calls.length === 0) {
      // Phase 22V Part-4 — final turn. Content was already streamed live
      // above; just commit it to `assistantText` for persistence + TTS.
      if (turnContent) assistantText += turnContent;
      // Plain text reply done.
      break;
    }

    // Phase 22V Part-4 — this turn produced tool_calls. Any text it also
    // produced was preamble streamed live above ("Let's check the
    // scanner..."). Tell the client to strip exactly those characters
    // from the visible message before we send tool events; the model
    // still sees its own narration in `turnContent` (passed back as the
    // assistant message in history) so its reasoning is preserved across
    // turns, and the user never sees / hears the preamble.
    if (turnContent.length > 0) {
      send({ type: "content_clear", chars: turnContent.length });
    }
    messages.push({
      role: "assistant",
      content: turnContent || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
    });

    // Execute each tool; report progress; append tool results.
    for (const c of calls) {
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {}; } catch { parsedArgs = {}; }
      send({ type: "tool_call", name: c.name });
      const t0 = Date.now();
      let result: unknown;
      let status = "ok";
      try {
        result = await dispatchTool(c.name, parsedArgs, userId, req);
      } catch (e) {
        status = "error";
        result = { error: "tool_failed", name: c.name, message: (e as Error)?.message ?? "unknown" };
      }
      const ms = Date.now() - t0;
      send({ type: "tool_result", name: c.name, status, durationMs: ms });
      // Surface the SAME honesty-gated structural read the Scanner Ruby Chart
      // Read uses so the chat can render the ONE standardized, always-visible
      // Ruby Reasoning Block. This forwards ONLY the structured read object the
      // tool already produced (display tier `readLayer` + `chartRead`) — never
      // fabricated prose, never an execution signal. The client builds the block
      // from this via buildReasoningFromChartRead; a gated/insufficient read
      // therefore renders WAIT/conditional with the limit stated, never a faked
      // direction or level.
      if (c.name === "readChartStructure" && status === "ok" && result && typeof result === "object") {
        const r = result as { chartRead?: Record<string, unknown>; readLayer?: string; feedUnconfirmed?: boolean };
        const read = r.chartRead;
        if (read && typeof read === "object") {
          const sym = typeof read.symbol === "string" ? read.symbol : "";
          const tf = typeof read.timeframe === "string" ? read.timeframe : "";
          send({
            type: "reasoning",
            read,
            symbol: sym,
            timeframe: tf,
            readLayer: typeof r.readLayer === "string" ? r.readLayer : "INSUFFICIENT",
            // DISPLAY-ONLY: mirror the Scanner panel's INDEPENDENT feed-not-confirmed
            // signal so the chat reasoning block can flag an unconfirmed feed even on
            // a STRUCTURAL_ONLY read (where readLayer alone can't tell the two apart).
            feedUnconfirmed: r.feedUnconfirmed === true,
          });
        }
      }
      try {
        (req as { log?: { info: (...a: unknown[]) => void } }).log?.info(
          { userId, conversationId: id, tool: c.name, status, durationMs: ms },
          "ruby_tool_call",
        );
      } catch { /* noop */ }
      try {
        await db.insert(arxAssistantToolCallsTable).values({
          userId, conversationId: id, messageId: userMessageId ?? null,
          toolName: c.name, args: parsedArgs as Record<string, unknown>,
          result: result as Record<string, unknown>, status, durationMs: ms,
        });
      } catch { /* tool log non-fatal */ }
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(result).slice(0, 8000) });
    }

    if (finishReason && finishReason !== "tool_calls") break;
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
router.post("/me/assistant/conversations/:id/voice", requireUser, voiceUpload.single("audio"), safe(async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { err(res, 400, "invalid_id"); return; }
  const file = (req as unknown as { file?: { buffer: Buffer; size: number; mimetype: string } }).file;
  if (!file || !file.buffer || file.size === 0) { err(res, 400, "missing_audio"); return; }
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
  const VOICE_CANONICAL = new Set(["safety", "content", "transcript", "user_transcript", "audio_chunk", "error", "done", "ping"]);
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
    ...voiceOrdered.map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    })),
  ];

  let userTranscript = "";
  let assistantTranscript = "";
  try {
    const audio = await import("@workspace/integrations-openai-ai-server/audio");
    const { buffer, format } = await audio.ensureCompatibleFormat(audioBuffer);
    const stream = await audio.voiceChatStream(buffer, "alloy", format, voicePriorMessages);
    for await (const event of stream) {
      if (voiceAborted) break;
      const ev = event as { type?: string; data?: string };
      const evType = typeof ev?.type === "string" ? ev.type : "";
      if (evType === "transcript" && typeof ev.data === "string") {
        assistantTranscript += ev.data;
        sendVoice({ type: "transcript", data: ev.data });
      } else if (evType === "user_transcript" && typeof ev.data === "string") {
        userTranscript += ev.data;
        sendVoice({ type: "user_transcript", data: ev.data });
      } else if (evType === "audio_chunk" && typeof ev.data === "string") {
        // Pass through base64 audio chunk, no transformation. Frontend
        // already understands this canonical shape.
        sendVoice({ type: "audio_chunk", data: ev.data });
      } else {
        // Unknown / future provider event — log server-side, drop client-side.
        try { (req as { log?: { warn: (...a: unknown[]) => void } }).log?.warn({ type: evType }, "assistant_voice_provider_event_unmapped"); } catch { /* noop */ }
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
// Ruby AI text/voice command → instant-trade router. Frontend sends the
// raw user utterance ("buy EURUSD 0.01", "close my XAUUSD", "close all"
// "set TP on EURUSD to 1.0920"); this endpoint parses it, decides whether
// it's a CLEAR direct command or a VAGUE analysis question, and — only
// when clear — forwards through `executeInstant()` which then runs every
// existing live-trading gate (master-live access, server master switch,
// 16-gate Phase B, kill switch, max lot, daily loss, missing-SL override,
// per-user advisory lock, idempotency).
//
// VAGUE questions ("what should I trade?", "is gold bullish?") are NEVER
// executed — they return `{ok:false, classification:"VAGUE"}` so Ruby
// answers the question instead of trading.
// ───────────────────────────────────────────────────────────────────────
// Cap on concurrent ACTIVE Ruby watches per user — keeps the evaluator cheap
// and prevents an accidental flood of armed conditionals.
const MAX_ACTIVE_RUBY_WATCHES = 10;
// Watch-and-enter "late" tolerance: if the trigger level is reached but price
// has already run beyond it by more than this fraction, the setup has moved on
// and the watch is skipped rather than chasing a worse fill.
const LATE_ENTRY_TOLERANCE = 0.003;

// Latest validated close for a symbol (read-only quote). Returns null on any
// empty/insufficient feed — never fabricates a price.
async function currentPriceOf(symbol: string): Promise<number | null> {
  try {
    const candles = await getMarketData(symbol, "1m", 2);
    const last = candles[candles.length - 1];
    const px = last ? Number(last.close) : NaN;
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch { return null; }
}

// Build a dedupe fingerprint for a Ruby command. Two semantically-identical
// commands (same kind/symbol/side/size/level) produce the same fingerprint, so
// the partial-unique in-flight index refuses an accidental repeat while the
// first is still PENDING/EXECUTING.
function rubyFingerprint(commandKind: string, intent: InstantTradeIntent): string {
  return [
    commandKind,
    (intent.symbol ?? "").toUpperCase(),
    intent.action,
    intent.volume ?? "",
    intent.positionId ?? "",
    intent.newStopLoss ?? "",
    intent.newTakeProfit ?? "",
    intent.closeVolume ?? "",
  ].join("|");
}

// Record a Ruby command in the ledger, run the advisory RUBY_EXECUTION
// handshake, dispatch through the EXISTING instant-trade router, and link the
// outcome back onto the ledger row. There is NO second execution path — this
// only WRAPS executeInstant with idempotency + evidence + an advisory check.
async function recordAndExecuteRuby(args: {
  userId: number;
  intent: InstantTradeIntent;
  commandKind: RubyCommandKind;
  symbol: string | null;
  rawText: string;
  ip: string | null;
  ua: string | null;
  params: unknown;
}): Promise<
  | { duplicate: true }
  | { duplicate: false; commandRowId: number; result: InstantTradeResult; handshakeStatus: string }
> {
  const { userId, intent, commandKind, symbol, rawText, ip, ua, params } = args;
  const fingerprint = rubyFingerprint(commandKind, intent);
  const idempotencyKey = randomUUID();
  // OPEN rows carry action "OPEN_TRADE" so the per-Ruby daily-trade cap (which
  // counts OPEN_TRADE rows) sees them; other kinds store the live action.
  const ledgerAction = commandKind === "OPEN_TRADE" ? "OPEN_TRADE" : intent.action;

  let commandRowId: number;
  try {
    const [row] = await db.insert(rubyCommandsTable).values({
      userId,
      accountMode: intent.accountMode,
      source: intent.source,
      commandKind,
      symbol: symbol ?? null,
      action: ledgerAction,
      params: params != null ? JSON.stringify(params) : null,
      rawUserCommand: rawText,
      fingerprint,
      idempotencyKey,
      status: "PENDING",
    }).returning({ id: rubyCommandsTable.id });
    commandRowId = row!.id;
  } catch (err) {
    // 23505 = unique violation on the in-flight partial index → a matching
    // command is already pending. Refuse the duplicate honestly. The insert
    // above uses the top-level `db` (never a tx executor), so the 23505 is not
    // wrapped today; isUniqueViolation walks the cause chain anyway so this stays
    // correct if the insert is ever moved inside db.transaction(...).
    if (isUniqueViolation(err)) return { duplicate: true };
    throw err;
  }

  // Advisory cross-layer readiness check. Fails open to UNKNOWN; NEVER a gate.
  let handshakeStatus = "UNKNOWN";
  try {
    const hs = await runHandshake("RUBY_EXECUTION", { context: { userId } });
    handshakeStatus = hs.aggregateStatus;
  } catch { /* advisory only */ }

  await db.update(rubyCommandsTable)
    .set({ status: "EXECUTING", handshakeStatus, updatedAt: new Date() })
    .where(eq(rubyCommandsTable.id, commandRowId));

  const result = await executeInstant({ userId, intent, ip, ua });

  if (result.ok) {
    await db.update(rubyCommandsTable).set({
      status: "COMPLETED",
      liveCommandId: result.commandId ?? null,
      resultDetail: result.detail != null ? JSON.stringify(result.detail).slice(0, 2000) : null,
      updatedAt: new Date(),
    }).where(eq(rubyCommandsTable.id, commandRowId));
  } else {
    // A gate refusal (httpStatus < 500) is BLOCKED evidence; a server/pipeline
    // error is FAILED. Both keep the row as permanent evidence.
    const blocked = result.httpStatus < 500;
    await db.update(rubyCommandsTable).set({
      status: blocked ? "BLOCKED" : "FAILED",
      blockReason: blocked ? (result.primaryReason ?? result.error) : null,
      errorReason: blocked ? null : result.error,
      updatedAt: new Date(),
    }).where(eq(rubyCommandsTable.id, commandRowId));
  }

  return { duplicate: false, commandRowId, result, handshakeStatus };
}

router.post("/me/assistant/instant-trade-command", requireUser, safe(async (req, res) => {
  const userId = (req as Request & { authUser?: { id: number } }).authUser!.id;
  // Phase 5: "paper" removed from accountMode union. Legacy callers
  // sending accountMode=paper are intercepted below and rejected with
  // the canonical 400 error before the Ruby pipeline runs.
  const { detectLegacyPaperModeRequest } = await import("../lib/safety/rejectLegacyPaperMode.js");
  const legacyPaper = detectLegacyPaperModeRequest(req.body);
  if (legacyPaper) { res.status(400).json({ ok: false, ...legacyPaper }); return; }

  const body = (req.body ?? {}) as {
    text?: string;
    accountMode?: "live" | "demo";
    source?: "ruby_text" | "ruby_voice";
    confirm?: boolean;
  };
  const text = (body.text ?? "").trim();
  const source = body.source === "ruby_voice" ? "ruby_voice" : "ruby_text";
  const accountMode: "live" | "demo" = body.accountMode === "demo" ? "demo" : "live";
  const assistantName = await getAssistantDisplayName(userId);
  const ipEarly = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.socket.remoteAddress ?? null;
  const uaEarly = (req.headers["user-agent"] as string | undefined) ?? null;
  if (!text) {
    await db.insert(oneClickAuditTable).values({
      userId, action: "RUBY_TRADE_COMMAND_VAGUE_REJECTED", ip: ipEarly, userAgent: uaEarly,
      metadata: JSON.stringify({ reason: "MISSING_TEXT", source }),
    });
    res.status(400).json({ ok: false, error: "MISSING_TEXT" });
    return;
  }

  // Pull per-user Ruby defaults so commands like "buy EURUSD" without a
  // size can still resolve when the user has configured a default volume.
  const settingsRows = await db.select().from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, userId)).limit(1);
  const settings = settingsRows[0];
  const parseDefaults = {
    defaultSymbol: settings?.defaultAiTradeSymbol ?? settings?.defaultSymbol ?? null,
    defaultVolume: settings?.defaultAiTradeVolume ?? settings?.defaultVolume ?? null,
    defaultOrderType: settings?.defaultAiOrderType ?? settings?.defaultOrderType ?? null,
  };
  const parsed = parseTradeCommand(text, parseDefaults);

  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.socket.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;

  if (parsed.kind === "VAGUE" || parsed.kind === "UNKNOWN") {
    await db.insert(oneClickAuditTable).values({
      userId, action: "RUBY_TRADE_COMMAND_VAGUE_REJECTED", ip, userAgent: ua,
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
      userId, action: "RUBY_TRADE_COMMAND_VAGUE_REJECTED", ip, userAgent: ua,
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
      userId, action: "RUBY_TRADE_COMMAND_VAGUE_REJECTED", ip, userAgent: ua,
      metadata: JSON.stringify({ text, reason: "MISSING_SYMBOL", source }),
    });
    res.json({
      ok: false, classification: "MISSING_SYMBOL",
      message: "Which market? Say e.g. EURUSD or XAUUSD.",
    });
    return;
  }

  await db.insert(oneClickAuditTable).values({
    userId, action: "RUBY_TRADE_COMMAND_PARSED", ip, userAgent: ua,
    metadata: JSON.stringify({ text, parsed, source, channel: "ELEANOR_CHAT" }),
  });

  // ── Bookkeeping commands — never touch the broker ──────────────────────
  // STATUS_CHECK: honestly report what Ruby is currently watching / pending.
  if (parsed.kind === "STATUS_CHECK") {
    const watches = await db.select().from(rubyWatchInstructionsTable).where(and(
      eq(rubyWatchInstructionsTable.userId, userId),
      eq(rubyWatchInstructionsTable.status, "ACTIVE"),
    ));
    const pending = await db.select({ id: rubyCommandsTable.id }).from(rubyCommandsTable).where(and(
      eq(rubyCommandsTable.userId, userId),
      inArray(rubyCommandsTable.status, ["PENDING", "EXECUTING"]),
    ));
    res.json({
      ok: true, classification: "STATUS_CHECK",
      activeWatches: watches.map((w) => ({
        kind: w.kind, symbol: w.symbol, side: w.side,
        trigger: w.triggerCondition, createdAt: w.createdAt,
      })),
      pendingCommands: pending.length,
      message: watches.length === 0 && pending.length === 0
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
    const cancelledWatches = await db.update(rubyWatchInstructionsTable)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(
        eq(rubyWatchInstructionsTable.userId, userId),
        eq(rubyWatchInstructionsTable.status, "ACTIVE"),
      )).returning({ id: rubyWatchInstructionsTable.id });
    const cancelledCmds = await db.update(rubyCommandsTable)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(and(
        eq(rubyCommandsTable.userId, userId),
        eq(rubyCommandsTable.status, "PENDING"),
      )).returning({ id: rubyCommandsTable.id });
    const n = cancelledWatches.length + cancelledCmds.length;
    await db.insert(oneClickAuditTable).values({
      userId, action: "RUBY_PENDING_ACTION_CANCELLED", ip, userAgent: ua,
      metadata: JSON.stringify({ text, kind: parsed.kind, watches: cancelledWatches.length, commands: cancelledCmds.length, source, channel: "ELEANOR_CHAT" }),
    });
    res.json({
      ok: true, classification: parsed.kind, cancelled: n,
      message: n === 0
        ? (isPending
          ? "No pending orders to cancel — you have no conditional entries armed right now."
          : "Nothing to cancel — I had no active watches or pending commands.")
        : (isPending
          ? `Cancelled ${n} pending order${n === 1 ? "" : "s"}.`
          : `Stood down ${n} pending item${n === 1 ? "" : "s"}.`),
    });
    return;
  }

  // ── Honest declines / clarifications — never touch the broker ───────────
  // Trailing stop: broker-native trailing stops have no schema column and no EA
  // path in this build. Decline honestly rather than place a fixed stop and call
  // it "trailing" — that would mis-represent live risk.
  if (parsed.kind === "TRAILING_STOP_UNSUPPORTED") {
    await db.insert(oneClickAuditTable).values({
      userId, action: "RUBY_TRADE_COMMAND_DECLINED", ip, userAgent: ua,
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
      userId, action: "RUBY_TRADE_COMMAND_NEEDS_LOT", ip, userAgent: ua,
      metadata: JSON.stringify({ text, reason: "RISK_PERCENT_SIZING", symbol: parsed.symbol, riskPercent: parsed.riskPercent, side: parsed.side, source, channel: "ELEANOR_CHAT" }),
    });
    res.json({
      ok: false, classification: "RISK_PERCENT_SIZING",
      message: `I won't guess a lot size from ${parsed.riskPercent}% — I could mis-size your risk. Tell me an exact lot (e.g. "${parsed.side.toLowerCase()} ${parsed.symbol} 0.01") and I'll take it.`,
    });
    return;
  }

  // Pending entry intended but no trigger price given — ask for the price
  // rather than arm a priceless conditional entry.
  if (parsed.kind === "PENDING_NEEDS_PRICE") {
    await db.insert(oneClickAuditTable).values({
      userId, action: "RUBY_TRADE_COMMAND_NEEDS_PRICE", ip, userAgent: ua,
      metadata: JSON.stringify({ text, reason: "PENDING_NEEDS_PRICE", symbol: parsed.symbol, side: parsed.side, pendingKind: parsed.pendingKind, source, channel: "ELEANOR_CHAT" }),
    });
    res.json({
      ok: false, classification: "PENDING_NEEDS_PRICE",
      message: `At what price should I ${parsed.side.toLowerCase()} ${parsed.symbol}? Tell me the ${parsed.pendingKind} level (e.g. "${parsed.side.toLowerCase()} ${parsed.symbol} when it hits 1.0900").`,
    });
    return;
  }

  // ── Watch / monitor — arm a single-fire conditional instruction ─────────
  // These persist an ACTIVE ruby_watch_instructions row. The evaluator
  // (POST /me/assistant/watch/evaluate) checks live price and CAS-fires each
  // exactly once through the SAME instant-trade router. Arming touches no
  // broker — only the evaluator can dispatch, and only after all gates pass.
  if (parsed.kind === "WATCH_AND_ENTER" || parsed.kind === "WATCH_AND_CLOSE"
      || parsed.kind === "MONITOR_TRADE") {
    // Per-action Ruby authorization for arming a watch/monitor. Default-deny
    // when settings are unset. Executing watches (enter/close/monitor) all
    // require AI_ASSISTED authority on top of their own per-action permission —
    // MONITOR now fires a protective close on trigger (see the evaluator), so it
    // is an executing watch too. This is an UP-FRONT guard — the evaluator still
    // re-runs every gate (incl. authority + per-action perms) through
    // executeInstant at fire time. It never relaxes a backend gate.
    const armAuthority = (settings?.rubyExecutionAuthority ?? "OFF").trim().toUpperCase();
    const armPermOk =
      parsed.kind === "WATCH_AND_ENTER" ? settings?.allowRubyWatchEnter === true
      : parsed.kind === "WATCH_AND_CLOSE" ? settings?.allowRubyWatchClose === true
      : settings?.allowRubyMonitor === true;
    const armNeedsExecAuthority = parsed.kind === "WATCH_AND_ENTER"
      || parsed.kind === "WATCH_AND_CLOSE" || parsed.kind === "MONITOR_TRADE";
    const armBlockReason = !armPermOk
      ? (parsed.kind === "WATCH_AND_ENTER" ? "RUBY_WATCH_ENTER_NOT_ENABLED"
        : parsed.kind === "WATCH_AND_CLOSE" ? "RUBY_WATCH_CLOSE_NOT_ENABLED"
        : "RUBY_MONITOR_NOT_ENABLED")
      : (armNeedsExecAuthority && armAuthority !== "AI_ASSISTED") ? "RUBY_TRADING_NOT_ENABLED"
      : null;
    if (armBlockReason) {
      await db.insert(oneClickAuditTable).values({
        userId, action: "RUBY_WATCH_ARM_BLOCKED", ip, userAgent: ua,
        metadata: JSON.stringify({ text, kind: parsed.kind, reason: armBlockReason, source }),
      });
      res.status(403).json({
        ok: false, classification: "RUBY_NOT_AUTHORIZED",
        message: armNeedsExecAuthority && armAuthority !== "AI_ASSISTED" && armPermOk
          ? `Turn on ${assistantName} AI-Assisted execution before I can arm that.`
          : `That ${assistantName} action isn't enabled in your settings.`,
      });
      return;
    }

    // Bound the number of concurrent ACTIVE watches per user.
    const active = await db.select({ id: rubyWatchInstructionsTable.id }).from(rubyWatchInstructionsTable)
      .where(and(
        eq(rubyWatchInstructionsTable.userId, userId),
        eq(rubyWatchInstructionsTable.status, "ACTIVE"),
      ));
    if (active.length >= MAX_ACTIVE_RUBY_WATCHES) {
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
        const px = await currentPriceOf(symbol);
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
      const open = await db.select().from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, userId),
        eq(arxLivePositionsTable.symbol, symbol),
        isNull(arxLivePositionsTable.closedAt),
      ));
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
    const expiresInMinutes = (parsed.kind === "WATCH_AND_ENTER" || parsed.kind === "WATCH_AND_CLOSE")
      ? parsed.expiresInMinutes : undefined;
    const expiresAt = typeof expiresInMinutes === "number" && expiresInMinutes > 0
      ? new Date(Date.now() + expiresInMinutes * 60_000) : null;
    // Pending-entry wording — "limit"/"stop" phrasing describes a conditional
    // (pending) entry. ARX arms it as a watch that fires a market order at the
    // trigger, which is functionally the requested limit/stop entry.
    const pendingKind = parsed.kind === "WATCH_AND_ENTER" ? parsed.pendingKind : undefined;
    const [w] = await db.insert(rubyWatchInstructionsTable).values({
      userId, kind: parsed.kind, accountMode, source,
      symbol: symbol ?? null,
      side: parsed.kind === "WATCH_AND_ENTER" ? parsed.side : null,
      lot: parsed.kind === "WATCH_AND_ENTER" && typeof parsed.volume === "number" ? parsed.volume : null,
      positionTicket,
      triggerCondition: triggerCondition ? JSON.stringify(triggerCondition) : null,
      rawUserCommand: text,
      status: "ACTIVE",
      expiresAt,
    }).returning({ id: rubyWatchInstructionsTable.id });
    await db.insert(oneClickAuditTable).values({
      userId, action: "RUBY_WATCH_ARMED", ip, userAgent: ua,
      metadata: JSON.stringify({ text, kind: parsed.kind, symbol, triggerCondition, positionTicket, expiresAt, pendingKind: pendingKind ?? null, source, channel: "ELEANOR_CHAT" }),
    });
    const expirySuffix = expiresAt
      ? ` (expires in ${expiresInMinutes} min if it doesn't trigger)`
      : "";
    res.json({
      ok: true, classification: parsed.kind, watchId: w!.id,
      message: parsed.kind === "MONITOR_TRADE"
        ? `Watching your ${symbol} position — if its idea is invalidated or price reaches your stop I'll close it to protect you; otherwise I'll leave it running.`
        : `Armed a ${pendingKind ? `${pendingKind}-style pending entry` : "conditional order"}: I'll ${parsed.kind === "WATCH_AND_ENTER" ? parsed.side?.toLowerCase() : "close"} ${symbol} when it ${triggerCondition!.op === ">=" ? "reaches/exceeds" : "drops to"} ${triggerCondition!.price}${expirySuffix}.`,
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
  let commandKind: RubyCommandKind;
  switch (parsed.kind) {
    case "OPEN":
      commandKind = "OPEN_TRADE";
      intent = {
        source, action: parsed.side, accountMode, symbol: parsed.symbol,
        volume: parsed.volume, orderType: parsed.orderType,
        aiCommand: true, parsedByRuby: true, rawUserCommand: text,
        rubyCommandKind: "OPEN",
      };
      break;
    case "CLOSE_ONE": {
      // Resolve a single open position for that symbol; if multiple,
      // refuse and let the user disambiguate. NEVER pick one silently.
      const open = await db.select().from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, userId),
        eq(arxLivePositionsTable.symbol, parsed.symbol),
        isNull(arxLivePositionsTable.closedAt),
      ));
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
        aiCommand: true, parsedByRuby: true, rawUserCommand: text,
        rubyCommandKind: "CLOSE",
      };
      break;
    }
    case "PARTIAL_CLOSE": {
      // Reduce-risk: close part of a single open position. Resolves the same
      // way as CLOSE_ONE (no silent pick) but carries closeVolume so only that
      // many lots are closed via the EXISTING close primitive.
      const open = await db.select().from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, userId),
        eq(arxLivePositionsTable.symbol, parsed.symbol),
        isNull(arxLivePositionsTable.closedAt),
      ));
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
          aiCommand: true, parsedByRuby: true, rawUserCommand: text,
          rubyCommandKind: "CLOSE",
        };
        break;
      }
      commandKind = "PARTIAL_CLOSE";
      intent = {
        source, action: "CLOSE", accountMode, symbol: parsed.symbol,
        positionId: row.brokerTicket, closeVolume: closeVol,
        aiCommand: true, parsedByRuby: true, rawUserCommand: text,
        rubyCommandKind: "PARTIAL_CLOSE",
      };
      break;
    }
    case "CLOSE_ALL":
      commandKind = "CLOSE_ALL";
      intent = {
        source, action: "CLOSE_ALL", accountMode, aiCommand: true,
        parsedByRuby: true, rawUserCommand: text, rubyCommandKind: "CLOSE_ALL",
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
      // Not auto-executed — defer to user; Ruby will offer it as a list.
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
      const open = await db.select().from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, userId),
        eq(arxLivePositionsTable.symbol, sym),
        isNull(arxLivePositionsTable.closedAt),
      ));
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
        aiCommand: true, parsedByRuby: true, rawUserCommand: text,
        rubyCommandKind: "MODIFY",
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
      const open = await db.select().from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, userId),
        eq(arxLivePositionsTable.symbol, sym),
        isNull(arxLivePositionsTable.closedAt),
      ));
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
        aiCommand: true, parsedByRuby: true, rawUserCommand: text,
        rubyCommandKind: "MOVE_SL_TO_BREAKEVEN",
      };
      break;
    }
    default: {
      // Exhaustiveness guard — any executable kind must be handled above.
      res.json({ ok: false, classification: "UNSUPPORTED_COMMAND", message: "I couldn't turn that into a trade action." });
      return;
    }
  }

  // Extra-confirmation gate — makes rubyRequireExtraConfirmation FUNCTIONAL.
  // When AI-Assisted is ON and rubyRequireExtraConfirmation is OFF, Ruby acts on
  // an allowed user-commanded action without re-asking. When it is ON (the safe
  // default) Ruby returns a confirmation-required response and executes nothing
  // until the caller resends with confirm:true. This is the ONLY thing the
  // confirmation setting controls — it never bypasses any backend gate; the full
  // 16-gate live pipeline still runs on the confirmed dispatch. Default-deny: a
  // missing or true setting requires confirmation.
  const requireExtraConfirm = settings?.rubyRequireExtraConfirmation !== false;
  if (requireExtraConfirm && body.confirm !== true) {
    await db.insert(oneClickAuditTable).values({
      userId, action: "RUBY_TRADE_COMMAND_CONFIRM_REQUIRED", ip, userAgent: ua,
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
  const ledger = await recordAndExecuteRuby({
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
// engine) and — ONLY when the user granted AI_ASSISTED + allowRubyMonitor —
// CAS-fires a single protective CLOSE through the SAME router when the plan's
// trigger is met (original thesis invalidated, or price at/through the user's
// own stop). It never fabricates an exit level and never closes a healthy
// position. This is the USER-AUTHORIZED Ruby path; the system-wide unilateral
// auto-close engine stays ALERT_ONLY.
// ───────────────────────────────────────────────────────────────────────
router.post("/me/assistant/watch/evaluate", requireUser, safe(async (req, res) => {
  const userId = (req.authUser!).id;
  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim()
    ?? req.socket.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;

  const active = await db.select().from(rubyWatchInstructionsTable).where(and(
    eq(rubyWatchInstructionsTable.userId, userId),
    eq(rubyWatchInstructionsTable.status, "ACTIVE"),
  ));

  const fired: Array<{ watchId: number; commandId?: string; blocked?: string }> = [];
  const skipped: Array<{ watchId: number; reason: string }> = [];

  // Re-read the CURRENT settings so watch permissions/authority are enforced at
  // FIRE-time, not only at arm-time. If a user/admin revokes watch-enter,
  // watch-close, or drops authority below AI_ASSISTED after a watch was armed,
  // the armed intent must NOT fire — default-deny, same posture as arm-time.
  const evalSettingsRows = await db.select().from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, userId)).limit(1);
  const evalSettings = evalSettingsRows[0];
  const evalAuthority = (evalSettings?.rubyExecutionAuthority ?? "OFF").trim().toUpperCase();

  for (const w of active) {
    // Expiry first.
    if (w.expiresAt && w.expiresAt.getTime() <= Date.now()) {
      await db.update(rubyWatchInstructionsTable)
        .set({ status: "EXPIRED", updatedAt: new Date() })
        .where(and(eq(rubyWatchInstructionsTable.id, w.id), eq(rubyWatchInstructionsTable.status, "ACTIVE")));
      skipped.push({ watchId: w.id, reason: "EXPIRED" });
      continue;
    }

    // MONITOR_TRADE — permission-bounded monitor-and-manage. Build a Trade
    // Management Plan from the real position + live price and fire a single
    // protective CLOSE when the trade is invalidated or price is at/through the
    // user's own stop. Permission + authority are re-checked at fire-time below.
    if (w.kind === "MONITOR_TRADE") {
      if (!w.symbol) continue;
      const openRows = await db.select().from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, userId),
        eq(arxLivePositionsTable.symbol, w.symbol),
        isNull(arxLivePositionsTable.closedAt),
      ));
      const row = w.positionTicket
        ? openRows.find((o) => o.brokerTicket === w.positionTicket)
        : (openRows.length === 1 ? openRows[0] : undefined);
      if (!row) {
        await db.update(rubyWatchInstructionsTable)
          .set({ status: "SKIPPED", skipReason: "POSITION_GONE", updatedAt: new Date() })
          .where(and(eq(rubyWatchInstructionsTable.id, w.id), eq(rubyWatchInstructionsTable.status, "ACTIVE")));
        skipped.push({ watchId: w.id, reason: "POSITION_GONE" });
        continue;
      }
      const mpx = await currentPriceOf(w.symbol);
      if (mpx == null) { skipped.push({ watchId: w.id, reason: "NO_PRICE" }); continue; }
      const monSide: "BUY" | "SELL" =
        ["SELL", "SHORT"].includes(String(row.side).trim().toUpperCase()) ? "SELL" : "BUY";
      const posInput: OpenPositionInput = {
        ticket: row.brokerTicket, symbol: w.symbol, side: monSide,
        lotSize: Number(row.volume ?? 0),
        entryPrice: Number.isFinite(Number(row.entryPrice)) ? Number(row.entryPrice) : null,
        currentPrice: mpx,
        stopLoss: row.stopLoss == null ? null : Number(row.stopLoss),
        takeProfit: row.takeProfit == null ? null : Number(row.takeProfit),
        floatingPnl: row.floatingPl == null ? null : Number(row.floatingPl),
        openedAtMs: row.openedAt ? row.openedAt.getTime() : null,
        priceAgeMs: null,
        accountMode: w.accountMode === "demo" ? "DEMO" : "LIVE",
      };
      // Trade Management Plan: protective exit ONLY on hard evidence — the
      // original thesis invalidated, or price at/through the user's own stop.
      // A healthy/weakening trade keeps running (no fabricated exit level).
      const { state } = classifyTradeHealth(posInput, null);
      const sl = computeSlDistance(posInput);
      const atOrThroughStop = sl.known && sl.bufferRemainingPct != null && sl.bufferRemainingPct <= 0;
      const protectiveExit = state === "invalidated" || atOrThroughStop;
      if (!protectiveExit) continue; // still monitoring — nothing to manage yet

      // Fire-time permission/authority gate (default-deny), same posture as the
      // other executing watches.
      const monRevoked =
        evalAuthority !== "AI_ASSISTED"
          ? "RUBY_EXECUTION_NOT_AUTHORIZED"
          : evalSettings?.allowRubyMonitor !== true
            ? "RUBY_MONITOR_NOT_ENABLED"
            : null;
      if (monRevoked) {
        await db.update(rubyWatchInstructionsTable)
          .set({ status: "SKIPPED", skipReason: monRevoked, updatedAt: new Date() })
          .where(and(eq(rubyWatchInstructionsTable.id, w.id), eq(rubyWatchInstructionsTable.status, "ACTIVE")));
        skipped.push({ watchId: w.id, reason: monRevoked });
        continue;
      }

      // CAS single-fire: only the update that flips ACTIVE→FIRED may dispatch.
      const monClaim = await db.update(rubyWatchInstructionsTable)
        .set({ status: "FIRED", firedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(rubyWatchInstructionsTable.id, w.id), eq(rubyWatchInstructionsTable.status, "ACTIVE")))
        .returning({ id: rubyWatchInstructionsTable.id });
      if (monClaim.length === 0) continue; // lost the race — another poll fired it

      const monIntent: InstantTradeIntent = {
        source: w.source as InstantTradeIntent["source"], action: "CLOSE",
        accountMode: w.accountMode === "demo" ? "demo" : "live", symbol: w.symbol,
        positionId: row.brokerTicket, aiCommand: true, parsedByRuby: true,
        rawUserCommand: w.rawUserCommand, rubyCommandKind: "CLOSE",
      };
      const monLedger = await recordAndExecuteRuby({
        userId, intent: monIntent, commandKind: "CLOSE_TRADE", symbol: w.symbol,
        rawText: w.rawUserCommand ?? `[monitor ${w.id}]`, ip, ua,
        params: { watchId: w.id, managed: true, healthState: state, firedPrice: mpx },
      });
      if (monLedger.duplicate) { skipped.push({ watchId: w.id, reason: "DUPLICATE_PREVENTED" }); continue; }
      await db.update(rubyWatchInstructionsTable)
        .set({ firedCommandId: monLedger.result.ok ? (monLedger.result.commandId ?? null) : null, updatedAt: new Date() })
        .where(eq(rubyWatchInstructionsTable.id, w.id));
      fired.push({
        watchId: w.id,
        commandId: monLedger.result.ok ? monLedger.result.commandId : undefined,
        blocked: monLedger.result.ok ? undefined : (monLedger.result.primaryReason ?? monLedger.result.error),
      });
      continue;
    }

    if (!w.symbol || !w.triggerCondition) continue;

    let cond: { op: ">=" | "<="; price: number };
    try { cond = JSON.parse(w.triggerCondition); } catch { continue; }
    const px = await currentPriceOf(w.symbol);
    if (px == null) continue; // honest skip — no fabricated price
    const met = cond.op === ">=" ? px >= cond.price : px <= cond.price;
    if (!met) continue;

    // LATE skip (watch-and-enter): the entry level was reached but price has
    // already run beyond it by more than a small tolerance — the setup has moved
    // on, so skip rather than chase a worse fill. (Cost/slippage and any spread
    // danger are additionally enforced downstream by the instant-trade preflight
    // + the 16-gate dispatch; there is no fabricated news gate here.)
    if (w.kind === "WATCH_AND_ENTER" && cond.price !== 0) {
      const overshoot = Math.abs(px - cond.price) / Math.abs(cond.price);
      if (overshoot > LATE_ENTRY_TOLERANCE) {
        await db.update(rubyWatchInstructionsTable)
          .set({ status: "SKIPPED", skipReason: "LATE_SETUP_MOVED", updatedAt: new Date() })
          .where(and(eq(rubyWatchInstructionsTable.id, w.id), eq(rubyWatchInstructionsTable.status, "ACTIVE")));
        skipped.push({ watchId: w.id, reason: "LATE_SETUP_MOVED" });
        continue;
      }
    }

    // Fire-time permission/authority gate (default-deny). A watch armed earlier
    // must NOT fire if the relevant permission was revoked or authority dropped
    // below AI_ASSISTED in the meantime. Mark SKIPPED with an honest reason and
    // void the armed intent — never silently fire on stale permission.
    const permRevoked =
      evalAuthority !== "AI_ASSISTED"
        ? "RUBY_EXECUTION_NOT_AUTHORIZED"
        : w.kind === "WATCH_AND_ENTER" && evalSettings?.allowRubyWatchEnter !== true
          ? "RUBY_WATCH_ENTER_NOT_ENABLED"
          : w.kind === "WATCH_AND_CLOSE" && evalSettings?.allowRubyWatchClose !== true
            ? "RUBY_WATCH_CLOSE_NOT_ENABLED"
            : null;
    if (permRevoked) {
      await db.update(rubyWatchInstructionsTable)
        .set({ status: "SKIPPED", skipReason: permRevoked, updatedAt: new Date() })
        .where(and(eq(rubyWatchInstructionsTable.id, w.id), eq(rubyWatchInstructionsTable.status, "ACTIVE")));
      skipped.push({ watchId: w.id, reason: permRevoked });
      continue;
    }

    // CAS single-fire: only the update that flips ACTIVE→FIRED may dispatch.
    const claim = await db.update(rubyWatchInstructionsTable)
      .set({ status: "FIRED", firedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(rubyWatchInstructionsTable.id, w.id), eq(rubyWatchInstructionsTable.status, "ACTIVE")))
      .returning({ id: rubyWatchInstructionsTable.id });
    if (claim.length === 0) continue; // lost the race — another poll fired it

    // Build the intent for the underlying instant-trade command.
    let intent: InstantTradeIntent;
    let commandKind: RubyCommandKind;
    if (w.kind === "WATCH_AND_ENTER") {
      intent = {
        source: w.source as InstantTradeIntent["source"], action: w.side === "SELL" ? "SELL" : "BUY",
        accountMode: w.accountMode === "demo" ? "demo" : "live", symbol: w.symbol,
        volume: w.lot ?? undefined, aiCommand: true, parsedByRuby: true,
        rawUserCommand: w.rawUserCommand, rubyCommandKind: "OPEN",
      };
      commandKind = "OPEN_TRADE";
    } else {
      // WATCH_AND_CLOSE — confirm the position still exists.
      const open = await db.select().from(arxLivePositionsTable).where(and(
        eq(arxLivePositionsTable.userId, userId),
        eq(arxLivePositionsTable.symbol, w.symbol),
        isNull(arxLivePositionsTable.closedAt),
      ));
      const row = w.positionTicket
        ? open.find((o) => o.brokerTicket === w.positionTicket)
        : (open.length === 1 ? open[0] : undefined);
      if (!row) {
        await db.update(rubyWatchInstructionsTable)
          .set({ status: "SKIPPED", skipReason: "POSITION_GONE", updatedAt: new Date() })
          .where(eq(rubyWatchInstructionsTable.id, w.id));
        skipped.push({ watchId: w.id, reason: "POSITION_GONE" });
        continue;
      }
      intent = {
        source: w.source as InstantTradeIntent["source"], action: "CLOSE",
        accountMode: w.accountMode === "demo" ? "demo" : "live", symbol: w.symbol,
        positionId: row.brokerTicket, aiCommand: true, parsedByRuby: true,
        rawUserCommand: w.rawUserCommand, rubyCommandKind: "CLOSE",
      };
      commandKind = "CLOSE_TRADE";
    }

    const ledger = await recordAndExecuteRuby({
      userId, intent, commandKind, symbol: w.symbol,
      rawText: w.rawUserCommand ?? `[watch ${w.id}]`, ip, ua,
      params: { watchId: w.id, trigger: cond, firedPrice: px },
    });
    if (ledger.duplicate) {
      skipped.push({ watchId: w.id, reason: "DUPLICATE_PREVENTED" });
      continue;
    }
    await db.update(rubyWatchInstructionsTable)
      .set({ firedCommandId: ledger.result.ok ? (ledger.result.commandId ?? null) : null, updatedAt: new Date() })
      .where(eq(rubyWatchInstructionsTable.id, w.id));
    fired.push({
      watchId: w.id,
      commandId: ledger.result.ok ? ledger.result.commandId : undefined,
      blocked: ledger.result.ok ? undefined : (ledger.result.primaryReason ?? ledger.result.error),
    });
  }

  res.json({ ok: true, evaluated: active.length, fired, skipped });
}));

export { router as meAssistantRouter };
