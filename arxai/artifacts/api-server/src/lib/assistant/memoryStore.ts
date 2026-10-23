// Phase 22K — ARX Assistant memory store.
// Per-user long-term memory + per-conversation pending action.
// All reads/writes are scoped by userId. Never returns another user's row.
//
// Hard caps protect from bloat / token leak:
//   ROLLING_SUMMARY_MAX = 4000 chars
//   UNRESOLVED_ACTIONS_MAX = 8 items
//   PREFERENCES_KEYS_MAX = 32
//
// What we DO NOT store:
//   - raw audio (handled in meAssistant.ts; multer.memoryStorage discards)
//   - secrets (MT5_BRIDGE_TOKEN, SESSION_SECRET, apiKeyHash, raw bridge tokens)
//   - other users' data (user_id FK + cascade)
//   - full chat history (only a compact narrative)

import {
  db, arxAssistantMemoryTable, arxAssistantConversationsTable,
  arxAssistantMessagesTable, arxAssistantToolCallsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { encryptField, readField } from "../security/encryptionAtRest.js";
import { logger } from "../logger.js";
import { recordSecurityEvent } from "../security/events.js";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

const ROLLING_SUMMARY_MAX = 4000;
const UNRESOLVED_ACTIONS_MAX = 8;
const SUMMARIZE_EVERY_N_MESSAGES = 10;
const SUMMARIZE_MIN_INTERVAL_MS = 60_000; // throttle: at most once per minute per user

// Words / fragments that strongly look like a secret. Belt-and-suspenders.
const SECRET_PATTERNS = [
  /MT5_BRIDGE_TOKEN/i,
  /SESSION_SECRET/i,
  /apiKeyHash/i,
  /sk-[a-z0-9-]{16,}/i,
  /ey[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/, // JWT-ish
];

function stripSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export interface PendingAction {
  type: string;                  // e.g. "scanner_check" | "mt5_status" | "trade_analysis" | "risk_explanation" | "generic"
  status: "open" | "in_progress" | "completed" | "failed";
  userIntent: string;            // short description of what the user asked for
  createdAt: string;             // ISO
  updatedAt: string;             // ISO
  lastAssistantPromise: string;  // the assistant sentence that promised this
  conversationId?: number;       // Phase 22K v2 — scope resolution to the conversation that created it
  requiredData?: string[];
  blockingIssue?: string | null;
  toolResult?: unknown;
  failureReason?: string | null;
}

export interface AssistantMemorySnapshot {
  rollingSummary: string | null;
  tradingStyle: Record<string, unknown> | null;
  preferences: Record<string, unknown> | null;
  unresolvedActions: PendingAction[];
  summaryUpdatedAt: string | null;
  memoryEnabled: boolean;
}

// ── Memory: get / upsert ──────────────────────────────────────────────────

export async function getMemory(userId: number): Promise<AssistantMemorySnapshot> {
  const rows = await db.select().from(arxAssistantMemoryTable)
    .where(eq(arxAssistantMemoryTable.userId, userId)).limit(1);
  const r = rows[0];
  if (!r) {
    return { rollingSummary: null, tradingStyle: null, preferences: null,
      unresolvedActions: [], summaryUpdatedAt: null, memoryEnabled: true };
  }
  return {
    // Decrypt at rest (legacy plaintext is returned verbatim by readField).
    rollingSummary: r.rollingSummary != null ? readField(r.rollingSummary).value : null,
    tradingStyle: (r.tradingStyle as Record<string, unknown> | null) ?? null,
    preferences: (r.preferences as Record<string, unknown> | null) ?? null,
    unresolvedActions: Array.isArray(r.unresolvedActions)
      ? (r.unresolvedActions as PendingAction[]).slice(0, UNRESOLVED_ACTIONS_MAX) : [],
    summaryUpdatedAt: r.summaryUpdatedAt ? new Date(r.summaryUpdatedAt).toISOString() : null,
    memoryEnabled: r.memoryEnabled !== false,
  };
}

/**
 * Verified-access boundary for assistant memory. Ruby memory is per-user and
 * MUST never be read on behalf of another user or an agent. This is an explicit
 * guard in front of {@link getMemory}: it asserts a positive numeric userId and
 * that the loaded row (if any) belongs to that user. On any mismatch it records
 * a redacted security event and denies (returns an empty snapshot) — it never
 * returns another user's row.
 *
 * `requestedByUserId` is the identity the caller is acting as; when provided it
 * must equal `userId` (no cross-user access). Defaults to `userId`.
 */
export async function loadVerifiedMemory(
  userId: number,
  requestedByUserId: number = userId,
): Promise<AssistantMemorySnapshot> {
  const empty: AssistantMemorySnapshot = {
    rollingSummary: null, tradingStyle: null, preferences: null,
    unresolvedActions: [], summaryUpdatedAt: null, memoryEnabled: true,
  };

  if (!Number.isInteger(userId) || userId <= 0) {
    logger.warn({ userId }, "assistant-memory: invalid userId rejected");
    return empty;
  }

  if (requestedByUserId !== userId) {
    void recordSecurityEvent({
      eventType: "MEMORY_CROSS_USER_ACCESS_DENIED",
      severity: "CRITICAL",
      status: "DENIED",
      actorRole: null,
      actorUserId: requestedByUserId,
      permissionKey: "assistant-memory:read",
      message: "Cross-user assistant-memory access denied.",
      metadata: { requestedByUserId, targetUserId: userId },
    }).catch((err) => {
      logger.warn({ err }, "assistant-memory: cross-user denial event record failed (non-fatal)");
    });
    return empty;
  }

  // Defence in depth: scope the read by userId AND verify ownership of the row.
  const rows = await db.select().from(arxAssistantMemoryTable)
    .where(eq(arxAssistantMemoryTable.userId, userId)).limit(1);
  const r = rows[0];
  if (r && r.userId !== userId) {
    void recordSecurityEvent({
      eventType: "MEMORY_OWNER_MISMATCH_DENIED",
      severity: "CRITICAL",
      status: "DENIED",
      actorRole: null,
      actorUserId: userId,
      permissionKey: "assistant-memory:read",
      message: "Assistant-memory owner mismatch denied.",
      metadata: { targetUserId: userId, rowUserId: r.userId },
    }).catch(() => {});
    return empty;
  }
  return getMemory(userId);
}

// User-controlled memory on/off toggle. When false, summarizeIfNeeded
// short-circuits and formatMemoryForSystemPrompt returns an empty block.
export async function setMemoryEnabled(userId: number, enabled: boolean): Promise<void> {
  await db.insert(arxAssistantMemoryTable)
    .values({ userId, memoryEnabled: enabled })
    .onConflictDoUpdate({
      target: arxAssistantMemoryTable.userId,
      set: { memoryEnabled: enabled, updatedAt: new Date() },
    });
}

async function upsertMemory(userId: number, patch: Partial<{
  rollingSummary: string | null;
  tradingStyle: Record<string, unknown> | null;
  preferences: Record<string, unknown> | null;
  unresolvedActions: PendingAction[];
  summarizedThroughMessageId: number | null;
  summaryUpdatedAt: Date | null;
}>): Promise<void> {
  const safe = { ...patch };
  if (typeof safe.rollingSummary === "string") {
    // Strip secrets + cap BEFORE encryption, then encrypt at rest. When no
    // encryption key is configured, encryptField returns plaintext verbatim
    // (honest passthrough) so legacy rows stay readable.
    safe.rollingSummary = encryptField(stripSecrets(safe.rollingSummary).slice(0, ROLLING_SUMMARY_MAX));
  }
  if (Array.isArray(safe.unresolvedActions)) {
    safe.unresolvedActions = safe.unresolvedActions.slice(0, UNRESOLVED_ACTIONS_MAX);
  }
  // Phase 22K v2 — atomic upsert to close the concurrent-first-write race
  // (architect HIGH→MEDIUM finding). The unique index on user_id is the
  // conflict target; only the columns provided in `safe` are overwritten.
  const setClause: Record<string, unknown> = { updatedAt: new Date() };
  if ("rollingSummary" in safe) setClause["rollingSummary"] = safe.rollingSummary;
  if ("tradingStyle" in safe) setClause["tradingStyle"] = safe.tradingStyle;
  if ("preferences" in safe) setClause["preferences"] = safe.preferences;
  if ("unresolvedActions" in safe) setClause["unresolvedActions"] = safe.unresolvedActions;
  if ("summarizedThroughMessageId" in safe) setClause["summarizedThroughMessageId"] = safe.summarizedThroughMessageId;
  if ("summaryUpdatedAt" in safe) setClause["summaryUpdatedAt"] = safe.summaryUpdatedAt;
  await db.insert(arxAssistantMemoryTable)
    .values({ userId, ...safe })
    .onConflictDoUpdate({ target: arxAssistantMemoryTable.userId, set: setClause });
}

// ── Pending action: per-conversation ──────────────────────────────────────

const PROMISE_PATTERNS: Array<{ type: PendingAction["type"]; re: RegExp }> = [
  { type: "scanner_check",      re: /\b(let me|i'?ll|i will|going to)\s+(check|scan|run|look at)\s+(the\s+)?(scanner|market|symbols)\b/i },
  { type: "mt5_status",         re: /\b(let me|i'?ll|i will|going to)\s+(check|verify|look at)\s+(your\s+)?(mt5|bridge|broker)\b/i },
  { type: "trade_analysis",     re: /\b(let me|i'?ll|i will|going to)\s+(analy[sz]e|review)\s+(your\s+)?(trades?|journal|history|positions?)\b/i },
  { type: "risk_explanation",   re: /\b(let me|i'?ll|i will|going to)\s+(explain|review|check)\s+(your\s+)?(risk|limits?)\b/i },
  { type: "account_lookup",     re: /\b(let me|i'?ll|i will|going to)\s+(check|look at|pull)\s+(your\s+)?(account|balance|p&l|pnl)\b/i },
];

export function extractPromiseFromAssistantText(text: string): { type: PendingAction["type"]; promiseSentence: string } | null {
  if (!text) return null;
  // Look at the first 800 chars (promises live near the top of a reply).
  const head = text.slice(0, 800);
  // Split into sentences-ish.
  const sentences = head.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    for (const p of PROMISE_PATTERNS) {
      if (p.re.test(s)) return { type: p.type, promiseSentence: s.trim().slice(0, 240) };
    }
  }
  return null;
}

export async function setConversationPendingAction(
  userId: number, conversationId: number, action: PendingAction | null,
): Promise<void> {
  await db.update(arxAssistantConversationsTable)
    .set({ pendingAction: action as unknown as Record<string, unknown> | null })
    .where(and(
      eq(arxAssistantConversationsTable.id, conversationId),
      eq(arxAssistantConversationsTable.userId, userId),
    ));
}

export async function getConversationPendingAction(
  userId: number, conversationId: number,
): Promise<PendingAction | null> {
  const rows = await db.select({ pendingAction: arxAssistantConversationsTable.pendingAction })
    .from(arxAssistantConversationsTable)
    .where(and(
      eq(arxAssistantConversationsTable.id, conversationId),
      eq(arxAssistantConversationsTable.userId, userId),
    )).limit(1);
  return (rows[0]?.pendingAction as PendingAction | null) ?? null;
}

// ── Tool result rehydration: surface last N tool results into context ────

export async function getRecentToolResults(
  userId: number, conversationId: number, limit = 5,
): Promise<Array<{ toolName: string; status: string; result: unknown; createdAt: string }>> {
  const rows = await db.select().from(arxAssistantToolCallsTable)
    .where(and(
      eq(arxAssistantToolCallsTable.userId, userId),
      eq(arxAssistantToolCallsTable.conversationId, conversationId),
    ))
    .orderBy(desc(arxAssistantToolCallsTable.createdAt))
    .limit(limit);
  return rows.reverse().map((r) => ({
    toolName: r.toolName,
    status: r.status,
    result: r.result,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── Rolling summarizer (synchronous, throttled) ───────────────────────────

const lastSummarizeAt = new Map<number, number>();

export async function summarizeIfNeeded(userId: number, conversationId: number): Promise<void> {
  // Respect per-user memory toggle. When disabled, the rolling summarizer
  // is a no-op — chat history is still persisted (so user can re-enable
  // and export) but the model context skips long-term recall.
  const snap = await getMemory(userId);
  if (snap.memoryEnabled === false) return;
  // Throttle per-user.
  const now = Date.now();
  const last = lastSummarizeAt.get(userId) ?? 0;
  if (now - last < SUMMARIZE_MIN_INTERVAL_MS) return;

  // Count messages since last summarized id.
  const memRows = await db.select({
    summarizedThroughMessageId: arxAssistantMemoryTable.summarizedThroughMessageId,
  }).from(arxAssistantMemoryTable).where(eq(arxAssistantMemoryTable.userId, userId)).limit(1);
  const lastId = memRows[0]?.summarizedThroughMessageId ?? 0;

  const recent = await db.select().from(arxAssistantMessagesTable)
    .where(and(
      eq(arxAssistantMessagesTable.userId, userId),
      eq(arxAssistantMessagesTable.conversationId, conversationId),
    ))
    .orderBy(desc(arxAssistantMessagesTable.id))
    .limit(40);
  const newOnes = recent.filter((m) => m.id > lastId);
  if (newOnes.length < SUMMARIZE_EVERY_N_MESSAGES) return;

  lastSummarizeAt.set(userId, now);

  // Build a compact transcript (oldest first) capped to 6000 chars.
  const ordered = newOnes.slice().reverse();
  const transcript = ordered.map((m) =>
    `${m.role.toUpperCase()}: ${stripSecrets(m.content || "").slice(0, 600)}`
  ).join("\n").slice(0, 6000);

  const existing = await getMemory(userId);
  const priorSummary = existing.rollingSummary ?? "";

  // Ask the LLM for a tight memory update. If this fails, do not throw —
  // memory is best-effort, never blocks the user reply (the caller already
  // returned the SSE stream when this is invoked).
  let newSummary = priorSummary;
  let tradingStyle = existing.tradingStyle ?? {};
  let preferences = existing.preferences ?? {};
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 800,
      messages: [
        { role: "system", content:
          "You maintain a compact long-term memory profile of an ARX AI user. " +
          "INPUT: a prior summary (may be empty) and a recent transcript. " +
          "OUTPUT strict JSON with keys: rollingSummary (<=2000 chars, third person, " +
          "stable facts only — preferred markets, trading style, risk appetite, " +
          "app setup progress, recurring questions, NOT live numbers, NOT secrets), " +
          "tradingStyle (object), preferences (object). " +
          "NEVER include MT5_BRIDGE_TOKEN, SESSION_SECRET, API keys, password hashes, " +
          "JWTs, full account balance, or another user's data. " +
          "If you have no new stable info, return the prior summary unchanged." },
        { role: "user", content:
          `PRIOR SUMMARY:\n${priorSummary || "(empty)"}\n\nRECENT TRANSCRIPT:\n${transcript}\n\nReturn JSON only.` },
      ],
      response_format: { type: "json_object" },
    });
    const raw = res.choices?.[0]?.message?.content ?? "";
    if (raw) {
      const parsed = JSON.parse(raw) as {
        rollingSummary?: string; tradingStyle?: Record<string, unknown>; preferences?: Record<string, unknown>;
      };
      if (typeof parsed.rollingSummary === "string") newSummary = parsed.rollingSummary;
      if (parsed.tradingStyle && typeof parsed.tradingStyle === "object") tradingStyle = parsed.tradingStyle;
      if (parsed.preferences && typeof parsed.preferences === "object") preferences = parsed.preferences;
    }
  } catch {
    return;
  }

  const newestId = ordered.length > 0 ? ordered[ordered.length - 1]!.id : lastId;
  await upsertMemory(userId, {
    rollingSummary: newSummary,
    tradingStyle,
    preferences,
    summarizedThroughMessageId: newestId,
    summaryUpdatedAt: new Date(),
  });
}

// ── Unresolved actions list management ────────────────────────────────────

export async function pushUnresolvedAction(userId: number, action: PendingAction): Promise<void> {
  const existing = await getMemory(userId);
  const next = [action, ...existing.unresolvedActions.filter((a) => a.type !== action.type)]
    .slice(0, UNRESOLVED_ACTIONS_MAX);
  await upsertMemory(userId, { unresolvedActions: next });
}

export async function resolveUnresolvedAction(
  userId: number, type: PendingAction["type"], conversationId: number,
  toolResult?: unknown, failureReason?: string,
): Promise<void> {
  // Phase 22K v2 — scope resolution to the conversation that created the
  // promise (architect HIGH finding). A scanner_check opened in conversation
  // A must NOT be auto-resolved by a scanner tool call in conversation B.
  // Legacy actions without conversationId are still resolvable (back-compat).
  const existing = await getMemory(userId);
  const next = existing.unresolvedActions.map((a) => {
    if (a.type !== type) return a;
    if (a.conversationId != null && a.conversationId !== conversationId) return a;
    return { ...a, status: failureReason ? "failed" : "completed",
      updatedAt: new Date().toISOString(),
      ...(toolResult !== undefined ? { toolResult } : {}),
      ...(failureReason ? { failureReason } : {}) } as PendingAction;
  });
  await upsertMemory(userId, { unresolvedActions: next });
}

// ── Hard wipe (Clear all ARX memory) ──────────────────────────────────────

export async function wipeAllUserMemory(userId: number): Promise<{
  conversationsDeleted: number; messagesDeleted: number; toolCallsDeleted: number; memoryDeleted: number;
}> {
  // Cascading FKs handle messages + tool_calls when conversations are deleted.
  // We still report counts for the UI confirmation.
  const convs = await db.select({ id: arxAssistantConversationsTable.id })
    .from(arxAssistantConversationsTable)
    .where(eq(arxAssistantConversationsTable.userId, userId));
  const msgs = await db.select({ id: arxAssistantMessagesTable.id })
    .from(arxAssistantMessagesTable)
    .where(eq(arxAssistantMessagesTable.userId, userId));
  const tools = await db.select({ id: arxAssistantToolCallsTable.id })
    .from(arxAssistantToolCallsTable)
    .where(eq(arxAssistantToolCallsTable.userId, userId));
  await db.delete(arxAssistantConversationsTable)
    .where(eq(arxAssistantConversationsTable.userId, userId));
  const memDel = await db.delete(arxAssistantMemoryTable)
    .where(eq(arxAssistantMemoryTable.userId, userId)).returning({ id: arxAssistantMemoryTable.id });
  return {
    conversationsDeleted: convs.length,
    messagesDeleted: msgs.length,
    toolCallsDeleted: tools.length,
    memoryDeleted: memDel.length,
  };
}

// ── Format snapshot for system-prompt injection ───────────────────────────

export function formatMemoryForSystemPrompt(
  snapshot: AssistantMemorySnapshot,
  pendingAction: PendingAction | null,
  recentToolResults: Array<{ toolName: string; status: string; result: unknown; createdAt: string }>,
): string {
  // Respect the user's memory toggle. When disabled, only surface the
  // active conversation's pending action (so an in-flight tool follow-up
  // still works) and the very recent tool results, but skip the long-term
  // rolling summary / trading style / preferences / cross-conversation
  // unresolved actions. Past chat messages remain stored for export.
  if (snapshot.memoryEnabled === false) {
    const liteParts: string[] = [`${DEFAULT_ASSISTANT_NAME} long-term memory is DISABLED by the user. Do not reference any prior conversations or saved preferences. Treat the user as a fresh session, only using what they say in this conversation.`];
    if (pendingAction) liteParts.push(`- THIS conversation has an unresolved promise: ${JSON.stringify(pendingAction).slice(0, 500)}.`);
    return liteParts.join("\n");
  }
  const parts: string[] = [`${DEFAULT_ASSISTANT_NAME} long-term memory for this user (never invent facts beyond this; if a fact is not here, say you don't have it saved):`];
  parts.push(`- rolling summary: ${snapshot.rollingSummary?.slice(0, 1200) ?? "(none yet)"}`);
  if (snapshot.tradingStyle && Object.keys(snapshot.tradingStyle).length > 0) {
    parts.push(`- trading style: ${JSON.stringify(snapshot.tradingStyle).slice(0, 500)}`);
  } else parts.push("- trading style: (none recorded)");
  if (snapshot.preferences && Object.keys(snapshot.preferences).length > 0) {
    parts.push(`- preferences: ${JSON.stringify(snapshot.preferences).slice(0, 500)}`);
  } else parts.push("- preferences: (none recorded)");
  if (snapshot.unresolvedActions.length > 0) {
    parts.push(`- open tasks across past conversations: ${JSON.stringify(snapshot.unresolvedActions.slice(0, 5)).slice(0, 800)}`);
  }
  if (pendingAction) {
    parts.push(`- THIS conversation has an unresolved promise: ${JSON.stringify(pendingAction).slice(0, 500)}. ` +
      `If the user sends a short follow-up like "?", "and?", "what happened?", "did you check?", treat it as a continuation of this promise — call the matching tool fresh, do not ask them to repeat themselves.`);
  }
  if (recentToolResults.length > 0) {
    // Phase 22K v2 — defense in depth: even though tool authors are required
    // to redact secrets, run stripSecrets() over the serialized result before
    // injecting it into the system prompt (architect MEDIUM finding).
    const compact = recentToolResults.map((t) =>
      `${t.toolName}(${t.status}): ${stripSecrets(JSON.stringify(t.result)).slice(0, 400)}`
    ).join(" | ");
    parts.push(`- recent tool results from EARLIER turns in this conversation (HISTORICAL — do not present as live unless you re-call the tool now): ${compact.slice(0, 1600)}`);
  }
  parts.push("Memory rule: live market data, scanner, MT5 status, account balance MUST come from a fresh tool call THIS turn. Memory above is for context only — never recite as if current.");
  return parts.join("\n");
}
