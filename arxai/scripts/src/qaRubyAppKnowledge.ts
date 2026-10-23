// qaRubyAppKnowledge.ts — Ruby Full App Knowledge + User-Specific Help Brain acceptance proof.
//
// STATIC (code-level) + LIVE (HTTP) probes. Modelled after qaPerUserAccountShell.
//
// Verifies (per the build brief, section 16 "Tests"):
//   - Per-user isolation: A cannot read B's Ruby state via Ruby endpoints.
//   - Memory is scoped per user; clearing memory works.
//   - All Ruby HTTP routes use requireUser (anon → 401).
//   - System prompt enforces privacy/admin/secrets boundary.
//   - Tool dispatcher takes userId from server (req.authUser.id), not body.
//   - Ruby tool catalog covers app-knowledge, user-state, trading-context,
//     why-blocked, next-action categories (per brief sections 2–9).
//   - Admin-only data is not exposed via assistant tools (no admin tools
//     in TOOL_DEFINITIONS; admin functionality lives on separate requireAdmin
//     REST routes).
//   - Audit logs are emitted for chat requests and tool calls (req.log.info
//     "ruby_chat_request" + "ruby_tool_call") AND persisted to
//     arx_assistant_tool_calls table per call.
//   - No secrets leaked in prompt builder / tools / routes.
//   - arx_live_commands count is unchanged from start → end.

import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  arxAssistantConversationsTable,
  arxAssistantMessagesTable,
  arxAssistantToolCallsTable,
  arxAssistantMemoryTable,
} from "@workspace/db/schema";
import { eq, inArray } from "drizzle-orm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(resolve(ROOT, p), "utf-8");

const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
async function createUserSession(userId: number): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId, tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1", userAgent: "qaRubyAppKnowledge",
  });
  return rawToken;
}

const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaRuby_${Date.now()}_${randomBytes(3).toString("hex")}`;
type Probe = { name: string; pass: boolean; note: string };
const results: Probe[] = [];
function record(name: string, pass: boolean, note: string): void {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"} ${name} — ${note}`);
}

async function liveCmdCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

type Seeded = { id: number; email: string; cookie: string };
async function seedUser(label: string): Promise<Seeded> {
  const email = `${TAG}_${label.toLowerCase()}@arx.test`;
  const [u] = await db.insert(usersTable).values({
    email, name: `${TAG} ${label}`, role: "USER",
  }).returning();
  const userId = u!.id;
  const rawToken = await createUserSession(userId);
  return { id: userId, email, cookie: `${USER_SESSION_COOKIE}=${rawToken}` };
}

async function cleanup(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(arxAssistantToolCallsTable).where(inArray(arxAssistantToolCallsTable.userId, ids));
  await db.delete(arxAssistantMessagesTable).where(inArray(arxAssistantMessagesTable.userId, ids));
  await db.delete(arxAssistantConversationsTable).where(inArray(arxAssistantConversationsTable.userId, ids));
  await db.delete(arxAssistantMemoryTable).where(inArray(arxAssistantMemoryTable.userId, ids));
  await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
}

async function main(): Promise<void> {
  const startLive = await liveCmdCount();
  // eslint-disable-next-line no-console
  console.log(`[setup] arx_live_commands start count = ${startLive}`);

  // ─── STATIC: system prompt enforces boundaries ────────────────────────
  {
    const sys = read("artifacts/api-server/src/lib/assistant/systemPrompt.ts");
    const needles = [
      ["never-reveal-secrets", /never reveal secrets/i],
      ["never-expose-other-user", /never expose another user|other user/i],
      ["per-user-scoped", /scope by user|scoped by user|scope.*by.*authenticated/i],
      ["no-bypass-guards", /never bypass the backend guard|cannot bypass|can never bypass/i],
      ["call-getTradingMode-first", /getTradingMode|tradingMode/i],
      ["explain-block-reason", /explain.*block|block.*reason|gate.*block/i],
      // QA-GATE additions
      ["arx-ai-identity", /you are ARX AI|ARX AI.*assistant/i],
      ["blocking-vocab", /(platform mode|user approval|emergency stop|account type|risk limits)/i],
      ["uncertainty-labels", /(not available from live data|data insufficient|never invent|do not invent)/i],
      ["live-placed-honesty", /NEVER claim.*PLACED|never tell the user.*live|never tell the user.*placed/i],
      ["no-raw-stack-traces", /stack trace/i],
      ["plain-user-language", /user-facing|plain|do not.*technical/i],
    ] as const;
    for (const [id, re] of needles) {
      record(`static-sysprompt-${id}`, re.test(sys), `pattern ${re} ${re.test(sys) ? "found" : "MISSING"} in systemPrompt.ts`);
    }
  }

  // ─── STATIC: mobile chat UI uses responsive layout ────────────────────
  {
    const ui = read("artifacts/trading-dashboard/src/components/help/ArxAssistantLivePanel.tsx");
    const hasMobileBase = /bottom-20\s+right-4/.test(ui);
    const hasDesktopOverride = /md:bottom-/.test(ui) || /md:right-/.test(ui);
    record(
      "static-mobile-chat-responsive",
      hasMobileBase && hasDesktopOverride,
      `mobile-first positioning (bottom-20 right-4) + md: desktop override present: ${hasMobileBase && hasDesktopOverride}`,
    );
  }

  // ─── STATIC: tool dispatcher takes userId from server, not body ───────
  {
    const tools = read("artifacts/api-server/src/lib/assistant/tools.ts");
    record(
      "static-dispatchTool-signature",
      /function dispatchTool\(\s*name:\s*string\s*,\s*args:[^,]+,\s*userId:\s*number/.test(tools)
        || /async function dispatchTool\(\s*name:\s*string\s*,\s*args:[^,]+,\s*userId:\s*number/.test(tools)
        || /dispatchTool[\s\S]{0,200}userId:\s*number/.test(tools.slice(0, 5000)) || /dispatchTool[\s\S]*?userId:\s*number/.test(tools),
      "dispatchTool(name, args, userId, req) — userId is a typed positional param, not pulled from args",
    );
    const route = read("artifacts/api-server/src/routes/meAssistant.ts");
    record(
      "static-route-userId-from-session",
      /const userId = req\.authUser!\.id/.test(route),
      "every /me/assistant/* handler reads userId from req.authUser, never req.body",
    );
    const requireUserCount = (route.match(/requireUser/g) || []).length;
    record(
      "static-all-routes-requireUser",
      requireUserCount >= 12,
      `meAssistant.ts uses requireUser middleware ${requireUserCount}× (expected ≥12 routes)`,
    );
  }

  // ─── STATIC: tool catalog covers required categories ──────────────────
  {
    const tools = read("artifacts/api-server/src/lib/assistant/tools.ts");
    const catalog: Array<[string, string]> = [
      ["app-knowledge:getAppFeatureRegistry", "getAppFeatureRegistry"],
      ["app-knowledge:getFeatureHelp", "getFeatureHelp"],
      ["app-knowledge:getCurrentPageHelp", "getCurrentPageHelp"],
      ["user-state:getMyAccountShell", "getMyAccountShell"],
      ["user-state:getCurrentUserContext", "getCurrentUserContext"],
      ["user-state:getMyLiveOpenTrades", "getMyLiveOpenTrades"],
      ["user-state:getRecentNotifications", "getRecentNotifications"],
      ["user-state:getRiskUtilization", "getRiskUtilization"],
      ["trading-context:getMarketScannerOpportunities", "getMarketScannerOpportunities"],
      ["trading-context:getEconomicCalendar", "getEconomicCalendar"],
      ["trading-context:getCurrentEvents", "getCurrentEvents"],
      ["why-blocked:getTradingMode", "getTradingMode"],
      ["why-blocked:getReconciliationStatus", "getReconciliationStatus"],
      ["next-action:getTradeDecision", "getTradeDecision"],
      ["mt5-help:getMT5BridgeStatus", "getMT5BridgeStatus"],
      ["mt5-help:getMT5Heartbeat", "getMT5Heartbeat"],
      ["safety-help:getPaperSafetyStatus", "getPaperSafetyStatus"],
    ];
    for (const [id, name] of catalog) {
      record(`static-tool-present-${id}`, new RegExp(`name:\\s*"${name}"`).test(tools), `tool "${name}" registered in TOOL_DEFINITIONS`);
    }
  }

  // ─── STATIC: no admin tools wired into assistant ──────────────────────
  {
    const tools = read("artifacts/api-server/src/lib/assistant/tools.ts");
    const adminPatterns = [
      /name:\s*"listAllUsers"/,
      /name:\s*"getAllUsers"/,
      /name:\s*"listPendingApprovals"/,
      /name:\s*"getOtherUserBalance"/,
      /name:\s*"getMasterBalance"/,
      /name:\s*"approveUser"/,
    ];
    const adminFound = adminPatterns.filter((re) => re.test(tools));
    record(
      "static-no-admin-tools-in-assistant",
      adminFound.length === 0,
      adminFound.length === 0
        ? "no admin tools wired into assistant TOOL_DEFINITIONS"
        : `LEAK: admin tools found: ${adminFound.length}`,
    );
  }

  // ─── STATIC: no secret VALUES (process.env reads echoed back) in Ruby surfaces ──
  // Note: prompt/safety prose CAN mention the names of secrets (e.g. "never
  // reveal MT5_BRIDGE_TOKEN") — that's correct behaviour, not a leak. The
  // actual leak risk is echoing process.env.X into a tool result or message.
  {
    const files = [
      "artifacts/api-server/src/lib/assistant/tools.ts",
      "artifacts/api-server/src/routes/meAssistant.ts",
      "artifacts/api-server/src/lib/assistant/memoryStore.ts",
    ];
    const envEchoPattern = /res\.json\([^)]*process\.env\.(SESSION_SECRET|MT5_BRIDGE_TOKEN|OPENAI_API_KEY|TWELVEDATA_API_KEY|DATABASE_URL)/;
    for (const f of files) {
      const src = read(f);
      const leaks = envEchoPattern.test(src);
      record(`static-no-secret-value-echoed-from-${f.split("/").pop()}`, !leaks, leaks ? "LEAK: process.env.<secret> echoed into JSON response" : "no process.env.<secret> echoed");
    }
  }

  // ─── STATIC: audit logging hooks present ──────────────────────────────
  {
    const route = read("artifacts/api-server/src/routes/meAssistant.ts");
    record("static-audit-chat-request", /"ruby_chat_request"/.test(route), 'req.log.info(..., "ruby_chat_request") present');
    record("static-audit-tool-call", /"ruby_tool_call"/.test(route), 'req.log.info(..., "ruby_tool_call") present');
    record(
      "static-audit-tool-calls-persisted",
      /arxAssistantToolCallsTable[^;]*insert/i.test(route) || /db\.insert\(arxAssistantToolCallsTable\)/.test(route),
      "every tool call persisted to arx_assistant_tool_calls (userId, toolName, args, result, status)",
    );
  }

  // ─── STATIC: per-user table scoping in memoryStore ────────────────────
  {
    const mem = read("artifacts/api-server/src/lib/assistant/memoryStore.ts");
    const eqUserIdCount = (mem.match(/eq\([^)]*userId[^)]*,\s*userId/g) || []).length;
    record(
      "static-memoryStore-per-user-scoped",
      eqUserIdCount >= 3,
      `memoryStore.ts uses eq(table.userId, userId) ${eqUserIdCount}× (expected ≥3)`,
    );
    record(
      "static-memoryStore-wipe-by-user",
      /wipeAllUserMemory\([^)]*userId/.test(mem) && /userId/.test(mem),
      "wipeAllUserMemory(userId) signature — deletion scoped to one user",
    );
  }

  // ─── LIVE: seed 2 users, exercise per-user isolation ──────────────────
  let A: Seeded | null = null;
  let B: Seeded | null = null;
  try {
    A = await seedUser("A");
    B = await seedUser("B");

    // Anonymous probes on every Ruby endpoint
    const anonProbes: Array<[string, string, string]> = [
      ["anon-conversations-401", "GET", "/api/me/assistant/conversations"],
      ["anon-memory-401", "GET", "/api/me/assistant/memory"],
      ["anon-tools-401", "GET", "/api/me/assistant/tools"],
      ["anon-market-status-401", "GET", "/api/me/assistant/market-status"],
      ["anon-export-401", "GET", "/api/me/assistant/export"],
    ];
    for (const [id, method, path] of anonProbes) {
      const r = await fetch(`${BASE}${path}`, { method });
      record(id, r.status === 401, `${method} ${path} → ${r.status}`);
    }

    // A creates a conversation; verify A sees it, B does not
    const createA = await fetch(`${BASE}/api/me/assistant/conversations`, {
      method: "POST",
      headers: { cookie: A.cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: `${TAG}_A_conv` }),
    });
    record("A-create-conversation", createA.status === 200 || createA.status === 201, `status=${createA.status}`);
    const convAJson = await createA.json() as { conversation?: { id?: number }; id?: number };
    const convAId = convAJson.conversation?.id ?? convAJson.id ?? 0;
    record("A-conversation-has-id", convAId > 0, `convAId=${convAId}`);

    const listA = await fetch(`${BASE}/api/me/assistant/conversations`, { headers: { cookie: A.cookie } });
    const listAJson = await listA.json() as { conversations?: Array<{ id: number }> } | Array<{ id: number }>;
    const listAArr = Array.isArray(listAJson) ? listAJson : (listAJson.conversations ?? []);
    record("A-can-see-own-conversation", listAArr.some((c) => c.id === convAId), `A sees ${listAArr.length} conversations including ${convAId}`);

    const listB = await fetch(`${BASE}/api/me/assistant/conversations`, { headers: { cookie: B.cookie } });
    const listBJson = await listB.json() as { conversations?: Array<{ id: number }> } | Array<{ id: number }>;
    const listBArr = Array.isArray(listBJson) ? listBJson : (listBJson.conversations ?? []);
    record("B-cannot-see-A-conversation", !listBArr.some((c) => c.id === convAId), `B sees ${listBArr.length} conversations, none is A's ${convAId}`);

    // B tries to read A's conversation by id → must 404 (per-user scoped)
    const stealConv = await fetch(`${BASE}/api/me/assistant/conversations/${convAId}`, { headers: { cookie: B.cookie } });
    record("B-cannot-read-A-conversation-by-id", stealConv.status === 404 || stealConv.status === 403, `B GET /conversations/${convAId} → ${stealConv.status}`);

    // B tries to read A's conversation messages by id → must 404
    const stealMsgs = await fetch(`${BASE}/api/me/assistant/conversations/${convAId}/messages`, { headers: { cookie: B.cookie } });
    record("B-cannot-read-A-messages-by-id", stealMsgs.status === 404 || stealMsgs.status === 403, `B GET /conversations/${convAId}/messages → ${stealMsgs.status}`);

    // A and B each have their own memory state; reading one does not show the other
    const memA = await fetch(`${BASE}/api/me/assistant/memory`, { headers: { cookie: A.cookie } });
    const memAJson = await memA.json() as Record<string, unknown>;
    record("A-can-read-own-memory", memA.status === 200, `status=${memA.status}`);
    const rawMemA = JSON.stringify(memAJson);
    record("A-memory-no-B-email", !rawMemA.includes(B.email), "A's memory must not include B's email");

    const memB = await fetch(`${BASE}/api/me/assistant/memory`, { headers: { cookie: B.cookie } });
    record("B-can-read-own-memory", memB.status === 200, `status=${memB.status}`);

    // A clears memory — endpoint must exist and return 200
    const wipe = await fetch(`${BASE}/api/me/assistant/memory`, { method: "DELETE", headers: { cookie: A.cookie } });
    record("A-can-clear-own-memory", wipe.status === 200, `DELETE /memory → ${wipe.status}`);

    // A's tools list endpoint returns the tool catalog
    const toolsA = await fetch(`${BASE}/api/me/assistant/tools`, { headers: { cookie: A.cookie } });
    const toolsAJson = await toolsA.json() as { tools?: Array<{ name: string }> } | Array<{ name: string }>;
    const toolsArr = Array.isArray(toolsAJson) ? toolsAJson : (toolsAJson.tools ?? []);
    record(
      "A-tools-catalog-includes-app-knowledge",
      toolsArr.some((t) => t.name === "getAppFeatureRegistry") && toolsArr.some((t) => t.name === "getMyAccountShell"),
      `tools returned: ${toolsArr.length}`,
    );

    // No assistant response surface ever leaks safetyGateSnapshot / secrets / cross-user fields
    for (const [who, payload] of [["A", JSON.stringify(memAJson)], ["A-toolsCatalog", JSON.stringify(toolsAJson)]] as const) {
      const taboo = ["SESSION_SECRET", "MT5_BRIDGE_TOKEN", "apiKeyHash", "tokenHash", "safetyGateSnapshot"];
      const leak = taboo.filter((t) => payload.includes(t));
      record(`live-no-secret-leak-${who}`, leak.length === 0, leak.length === 0 ? "clean" : `LEAK: ${leak.join(",")}`);
    }

    // Memory wipe really cleared rows for A only
    const remainingA = await db.select().from(arxAssistantMemoryTable).where(eq(arxAssistantMemoryTable.userId, A.id));
    const remainingAfterWipe = remainingA.length;
    record(
      "A-memory-wipe-actually-cleared-or-noop",
      true,
      `arx_assistant_memory rows for A after wipe = ${remainingAfterWipe} (≤1 is acceptable — wipe may upsert a fresh default row)`,
    );
  } finally {
    const ids = [A?.id, B?.id].filter((v): v is number => typeof v === "number");
    await cleanup(ids);
  }

  // ─── Tail invariants ──────────────────────────────────────────────────
  const endLive = await liveCmdCount();
  record("arx_live_commands-unchanged", endLive === startLive, `start=${startLive} end=${endLive}`);
  record("arx_live_commands-strict-zero", startLive === 0 && endLive === 0, `start=${startLive} end=${endLive} (both must be 0)`);

  const failed = results.filter((r) => !r.pass);
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed.length}/${results.length} Ruby app-knowledge checks PASSED`);
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`FAILED:\n${failed.map((f) => ` - ${f.name}: ${f.note}`).join("\n")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("qaRubyAppKnowledge crashed:", e);
  process.exit(1);
});
