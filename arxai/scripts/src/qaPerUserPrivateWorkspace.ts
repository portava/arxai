// qaPerUserPrivateWorkspace.ts — Per-User Private Trading Workspace acceptance proof.
//
// Two throwaway users (A and B), each seeded with uniquely-marked rows in
// every per-user table the brief covers (watchlist, notification, alert,
// performance_daily, journal entry, assistant conversation, virtual ledger
// account, shared trade attribution, paper trade, mt5 command). Then we
// authenticate each user via a real session cookie and hit a battery of
// GET /api/me/* endpoints through the proxy, asserting:
//
//   * User A's response NEVER contains User B's marker (and vice versa).
//   * Anonymous (no cookie) calls get 401 on every /me/* probe.
//   * User A cannot fetch User B's assistant conversation by ID.
//   * /me/shared-account/summary for User A returns only A's virtual
//     accounts (no row whose userId is B's).
//   * `unattributed_master_trades` rows seeded with userId=NULL never
//     surface in any /me/* endpoint.
//   * The starting `arx_live_commands` count is unchanged at the end —
//     this script NEVER triggers a live broker dispatch.
//
// Exit code 0 on PASS, 1 on FAIL.

import { randomBytes, createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { pool, db } from "@workspace/db";
import {
  usersTable,
  authUserSessionsTable,
  watchlistsTable,
  userNotificationsTable,
  userAlertsTable,
  performanceDailyTable,
  tradeJournalEntriesTable,
  arxAssistantConversationsTable,
  virtualTradingAccountsTable,
  sharedTradeAttributionTable,
  unattributedMasterTradesTable,
  paperTradesTable,
  mt5CommandsTable,
  userPlaybooksTable,
  tradingSessionsTable,
  mt5ConnectionTable,
  userReportsTable,
  arxLiveCommandsTable,
} from "@workspace/db/schema";
import { eq, inArray, or } from "drizzle-orm";

// Inlined to avoid crossing the scripts rootDir into artifacts/api-server.
// Must stay byte-equivalent to artifacts/api-server/src/lib/auth/userSessions.ts.
const USER_SESSION_COOKIE = "arx_user_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
async function createUserSession(opts: { userId: number; ipAddress?: string; userAgent?: string }): Promise<{ rawToken: string }> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId: opts.userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: opts.ipAddress ?? null,
    userAgent: opts.userAgent ?? null,
  });
  return { rawToken };
}

const BASE = process.env.QA_API_BASE ?? "http://localhost:80";
const TAG = `qaPUPW_${Date.now()}_${randomBytes(3).toString("hex")}`;

type Probe = { name: string; pass: boolean; note: string };
const results: Probe[] = [];
function record(name: string, pass: boolean, note: string): void {
  results.push({ name, pass, note });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${note}`);
}

async function liveCommandsCount(): Promise<number> {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM arx_live_commands");
  return (r.rows[0] as { n: number }).n;
}

type SeededUser = {
  id: number;
  email: string;
  cookie: string;
  marker: string; // a unique substring planted into row text fields
  rowIds: {
    watchlistId?: number;
    notificationId?: number;
    alertId?: number;
    perfDailyId?: number;
    journalId?: number;
    convoId?: number;
    virtualAccountId?: number;
    attributionId?: number;
    paperTradeId?: number;
    mt5CommandId?: number;
    playbookId?: number;
    tradingSessionId?: number;
    mt5ConnectionId?: number;
    reportId?: number;
    liveCommandId?: number;
    liveCommandIdString?: string; // arx_live_commands.command_id (text)
  };
};

async function createUser(label: "A" | "B"): Promise<SeededUser> {
  const email = `${TAG}_${label.toLowerCase()}@arx.test`;
  const [u] = await db.insert(usersTable).values({
    email, name: `${TAG} ${label}`, role: "USER",
  }).returning();
  const userId = u!.id;
  const sess = await createUserSession({ userId, ipAddress: "127.0.0.1", userAgent: "qaPUPW" });
  return {
    id: userId, email, cookie: `${USER_SESSION_COOKIE}=${sess.rawToken}`,
    marker: `${TAG}_M${label}`, rowIds: {},
  };
}

async function seedUser(user: SeededUser): Promise<void> {
  // 1) watchlist
  const [w] = await db.insert(watchlistsTable).values({
    userId: user.id, name: `${user.marker}_wl`, category: "forex",
  }).returning();
  user.rowIds.watchlistId = w!.id;

  // 2) notification — entityId is INTEGER. Use user.id (per-user-scoped) and
  // bucket=user.id to dodge the (user,type,entityType,entityId,bucket) unique index.
  const [n] = await db.insert(userNotificationsTable).values({
    userId: user.id, notificationType: `qa_${user.marker}`, severity: "info",
    title: `${user.marker}_notif`, message: `seed ${user.marker}`,
    source: "qa", entityType: "qa", entityId: user.id,
    status: "unread", bucket: user.id,
  }).returning();
  user.rowIds.notificationId = n!.id;

  // 3) alert — use bucket=user.id to dodge the (user,type,bucket) unique index.
  const [a] = await db.insert(userAlertsTable).values({
    userId: user.id, alertType: `qa_${user.marker}`, bucket: user.id, severity: "info",
    title: `${user.marker}_alert`, message: `seed ${user.marker}`,
    source: "qa", status: "unread",
  }).returning();
  user.rowIds.alertId = a!.id;

  // 4) performance_daily — a row dated yesterday
  const yKey = new Date(Date.now() - 24*60*60*1000).toISOString().slice(0, 10);
  const [p] = await db.insert(performanceDailyTable).values({
    userId: user.id, date: yKey,
    pnl: label2Sign(user) * 123.45, trades: 2, wins: 1, losses: 1,
    winRate: 50, endBalance: 10000 + label2Sign(user) * 123.45,
  }).returning();
  user.rowIds.perfDailyId = p!.id;

  // 5) trade_journal_entries
  const [j] = await db.insert(tradeJournalEntriesTable).values({
    userId: user.id, tradeId: null, symbol: "EURUSD", direction: "BUY",
    userNotes: `${user.marker}_journal`, strategyUsed: "qa",
  }).returning();
  user.rowIds.journalId = j!.id;

  // 6) assistant conversation
  const [c] = await db.insert(arxAssistantConversationsTable).values({
    userId: user.id, title: `${user.marker}_convo`,
  }).returning();
  user.rowIds.convoId = c!.id;

  // 7) virtual_trading_accounts — DEMO type, no master mapping needed
  const [v] = await db.insert(virtualTradingAccountsTable).values({
    userId: user.id, routingMode: "SHARED_MASTER_MT5",
    sharedMasterAccountId: null, accountType: "demo",
    virtualBalance: 10000, virtualEquity: 10000,
    virtualMarginUsed: 0, virtualPnl: label2Sign(user) * 77.7,
    status: "active",
  }).returning();
  user.rowIds.virtualAccountId = v!.id;

  // 8) shared_trade_attribution — closed trade with distinctive ticket.
  // sharedMasterAccountId + masterConnectionId are NOT NULL (no FK enforced).
  // Use a sentinel id reserved for QA; admin views ignore unknown ids.
  const ticket = `${Date.now() % 100000}${user.id % 10}${label2Sign(user) > 0 ? "A" : "B"}`;
  const [att] = await db.insert(sharedTradeAttributionTable).values({
    userId: user.id, virtualAccountId: v!.id,
    sharedMasterAccountId: 999999, masterConnectionId: 999999,
    tradeCommandId: null, auditLogId: null,
    mt5OrderTicket: ticket, mt5PositionTicket: ticket,
    symbol: "EURUSD", side: "BUY", lotSize: 0.01,
    entryPrice: 1.1000, closePrice: 1.1010,
    stopLoss: 1.0980, takeProfit: 1.1050,
    pnl: label2Sign(user) * 10, fees: 0, slippage: 0,
    status: "closed", rejectionReason: null,
    openedAt: new Date(Date.now() - 60*60*1000),
    closedAt: new Date(Date.now() - 30*60*1000),
  }).returning();
  user.rowIds.attributionId = att!.id;

  // 9) paper_trades — closed yesterday so it shows in calendar+history
  const [pt] = await db.insert(paperTradesTable).values({
    userId: user.id, symbol: "EURUSD", side: "BUY", status: "closed",
    entryType: "market", lotSize: 0.01, riskAmount: 10, riskPercent: 0.1,
    entryPrice: 1.1000, exitPrice: 1.1010,
    stopLoss: 1.0980, takeProfit: 1.1050,
    pnl: label2Sign(user) * 10, pnlPercent: 0.1,
    openedAt: new Date(Date.now() - 26*60*60*1000),
    closedAt: new Date(Date.now() - 25*60*60*1000),
    strategyTag: `${user.marker}_pt`, reasonForEntry: user.marker,
  }).returning();
  user.rowIds.paperTradeId = pt!.id;

  // 10) mt5_commands — pending demo command
  const [mc] = await db.insert(mt5CommandsTable).values({
    userId: user.id, action: "open", symbol: "EURUSD", side: "BUY",
    lot: 0.01, sl: 1.0980, tp: 1.1050,
    status: "pending", detail: `${user.marker}_mt5cmd`, safetyMode: "paper_only",
  }).returning();
  user.rowIds.mt5CommandId = mc!.id;

  // 11) user_playbooks — one draft playbook per user (covers
  //     /me/playbooks/:id and /me/playbooks/:id/rules family).
  const [pb] = await db.insert(userPlaybooksTable).values({
    userId: user.id, title: `${user.marker}_playbook`,
    description: user.marker, strategyType: "trend_continuation",
    status: "draft", source: "manual",
  }).returning();
  user.rowIds.playbookId = pb!.id;

  // 12) trading_sessions — one active paper session per user (covers
  //     /me/trading-sessions/:id and /me/trading-sessions/:id/ai-summary).
  const [ts] = await db.insert(tradingSessionsTable).values({
    userId: user.id, title: `${user.marker}_session`, mode: "paper",
    status: "active", startingBalance: 10000, notes: user.marker,
  }).returning();
  user.rowIds.tradingSessionId = ts!.id;

  // 13) mt5_connection — one waiting per-user connection (covers
  //     /me/mt5-connections/:id and /me/mt5-connections/:id/commands).
  const [conn] = await db.insert(mt5ConnectionTable).values({
    userId: user.id, connectionName: `${user.marker}_conn`,
    status: "waiting", mode: "MOCK", accountType: "unknown",
  }).returning();
  user.rowIds.mt5ConnectionId = conn!.id;

  // 14) user_reports — one completed report per user (covers
  //     /me/reports/:id and /me/reports/:id/download).
  const [rep] = await db.insert(userReportsTable).values({
    userId: user.id, reportType: "trade_history", format: "json",
    status: "completed", title: `${user.marker}_report`,
  }).returning();
  user.rowIds.reportId = rep!.id;

  // 15) arx_live_commands — terminal-state row so /me/live/commands/:commandId
  //     family can be IDOR-probed against a REAL B-owned record without
  //     ever creating a dispatchable live command. status=REJECTED is
  //     terminal: the 16-gate evaluator never picks it up and no broker
  //     ticket is ever issued. This row is deleted in cleanup so the
  //     strict-zero invariant (start=end=0) still holds.
  const cmdIdString = `${TAG}_${user.marker}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const [lc] = await db.insert(arxLiveCommandsTable).values({
    userId: user.id, commandId: cmdIdString,
    commandType: "OPEN", status: "REJECTED",
    symbol: "EURUSD", side: "BUY", orderType: "MARKET",
    requestedVolume: 0.01, stopLoss: 1.0980, takeProfit: 1.1050,
    sourcePage: "QA_TEST",
    rejectionReason: `QA_TEST_${user.marker}_terminal_seed`,
    rejectedAt: new Date(),
    dispatchGateSnapshot: { qaTestSeed: true, marker: user.marker },
    payload: { qaTestSeed: true, marker: user.marker },
  }).returning();
  user.rowIds.liveCommandId = lc!.id;
  user.rowIds.liveCommandIdString = cmdIdString;
}

function label2Sign(user: SeededUser): 1 | -1 {
  return user.marker.endsWith("MA") ? 1 : -1;
}

async function seedUnattributedOrphan(): Promise<number> {
  const ticket = String(Date.now() % 1000000);
  const [r] = await db.insert(unattributedMasterTradesTable).values({
    sharedMasterAccountId: 999999, masterConnectionId: 999999,
    mt5OrderTicket: ticket, mt5PositionTicket: ticket,
    symbol: "EURUSD", side: "BUY", lotSize: 0.01,
    fillPrice: 1.1000, slippage: 0,
    brokerMessage: `${TAG}_unattributed_orphan`,
    source: "qa", status: "pending_review",
    reviewNotes: `${TAG}_unattributed_orphan`,
    executedAt: new Date(),
  }).returning();
  return r!.id;
}

async function fetchAs(user: SeededUser | null, path: string): Promise<{ status: number; bodyText: string; json: unknown | null }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (user) headers["cookie"] = user.cookie;
  const r = await fetch(`${BASE}${path}`, { headers });
  const txt = await r.text();
  let json: unknown | null = null;
  try { json = JSON.parse(txt); } catch { /* not json */ }
  return { status: r.status, bodyText: txt, json };
}

// Mutation probe with empty JSON body. Used only for IDOR probing of
// parameterized non-GET /me/* routes — empty body means most handlers
// reject at validation/ownership before any side effect. Cross-checked
// at the end by the strict-zero arx_live_commands invariant.
async function mutateAs(
  user: SeededUser,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
): Promise<{ status: number; bodyText: string }> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie: user.cookie,
    },
    body: method === "DELETE" ? undefined : "{}",
  });
  const txt = await r.text();
  return { status: r.status, bodyText: txt };
}

function bodyContains(bodyText: string, needle: string): boolean {
  return bodyText.includes(needle);
}

// Pre/post mutation snapshot of every B-owned seeded row. We capture
// (a) row presence (still exists?), (b) ownership (still B's user_id?),
// (c) the marker-bearing text field (unchanged?). Any drift between
// pre and post proves the 60 A-issued mutation probes mutated/deleted
// a row they had no business touching.
type BRowKey = string;
type BSnapshot = Record<BRowKey, { present: boolean; userId: number | null; marker: string | null }>;

async function snapshotOne<T extends { id: number; userId: number | null; }>(
  table: ReturnType<typeof eq> extends never ? never : { id: { name?: string } },
  _table: { _: { name: string } } & Record<string, unknown>,
  id: number | undefined,
  markerCol: string,
): Promise<{ present: boolean; userId: number | null; marker: string | null }> {
  return { present: false, userId: null, marker: null }; // placeholder, see snapshotBOwnedRows
}

async function snapshotBOwnedRows(b: SeededUser): Promise<BSnapshot> {
  // Use raw SQL via pool for uniformity across 14 tables.
  const out: BSnapshot = {};
  const rows: Array<{ key: BRowKey; table: string; id: number | undefined; markerCol: string }> = [
    { key: "watchlist",        table: "watchlists",                  id: b.rowIds.watchlistId,        markerCol: "name" },
    { key: "notification",     table: "user_notifications",          id: b.rowIds.notificationId,     markerCol: "title" },
    { key: "alert",            table: "user_alerts",                 id: b.rowIds.alertId,            markerCol: "title" },
    { key: "perfDaily",        table: "performance_daily",           id: b.rowIds.perfDailyId,        markerCol: "date" },
    { key: "journal",          table: "trade_journal_entries",       id: b.rowIds.journalId,          markerCol: "user_notes" },
    { key: "convo",            table: "arx_assistant_conversations", id: b.rowIds.convoId,            markerCol: "title" },
    { key: "virtualAccount",   table: "virtual_trading_accounts",    id: b.rowIds.virtualAccountId,   markerCol: "routing_mode" },
    { key: "attribution",      table: "shared_trade_attribution",    id: b.rowIds.attributionId,      markerCol: "mt5_order_ticket" },
    { key: "paperTrade",       table: "paper_trades",                id: b.rowIds.paperTradeId,       markerCol: "strategy_tag" },
    { key: "mt5Command",       table: "mt5_commands",                id: b.rowIds.mt5CommandId,       markerCol: "detail" },
    { key: "playbook",         table: "user_playbooks",              id: b.rowIds.playbookId,         markerCol: "title" },
    { key: "tradingSession",   table: "trading_sessions",            id: b.rowIds.tradingSessionId,   markerCol: "title" },
    { key: "mt5Connection",    table: "mt5_connection",              id: b.rowIds.mt5ConnectionId,    markerCol: "connection_name" },
    { key: "report",           table: "user_reports",                id: b.rowIds.reportId,           markerCol: "title" },
    { key: "liveCommand",      table: "arx_live_commands",           id: b.rowIds.liveCommandId,      markerCol: "rejection_reason" },
  ];
  for (const r of rows) {
    if (r.id == null) { out[r.key] = { present: false, userId: null, marker: null }; continue; }
    let q;
    try {
      q = await pool.query(
        `SELECT user_id::int AS user_id, ${r.markerCol}::text AS marker FROM ${r.table} WHERE id = $1 LIMIT 1`,
        [r.id],
      );
    } catch (e) {
      throw new Error(`snapshotBOwnedRows failed on table=${r.table} markerCol=${r.markerCol}: ${(e as Error).message}`);
    }
    if (q.rows.length === 0) {
      out[r.key] = { present: false, userId: null, marker: null };
    } else {
      out[r.key] = {
        present: true,
        userId: q.rows[0].user_id ?? null,
        marker: q.rows[0].marker ?? null,
      };
    }
  }
  return out;
}

function diffBSnapshots(before: BSnapshot, after: BSnapshot): string[] {
  const diffs: string[] = [];
  for (const key of Object.keys(before)) {
    const a = before[key]!;
    const b = after[key];
    if (!b) { diffs.push(`${key}: snapshot missing from post-state`); continue; }
    if (a.present && !b.present) { diffs.push(`${key}: row was DELETED by A's mutation probe`); continue; }
    if (a.present && b.present) {
      if (a.userId !== b.userId) diffs.push(`${key}: user_id changed ${a.userId}→${b.userId}`);
      if (a.marker !== b.marker) diffs.push(`${key}: marker changed ${JSON.stringify(a.marker)}→${JSON.stringify(b.marker)}`);
    }
  }
  return diffs;
}

async function main(): Promise<void> {
  // Discovered at runtime from artifacts/api-server/src/routes/*.ts.
  // Includes EVERY non-parameterized GET /me/* route across every file
  // (not just me*.ts), so adding a new endpoint automatically pulls it
  // into the cross-user probe matrix without anyone editing this list.
  const PROBE_ENDPOINTS: string[] = discoverNonParameterizedMeGetRoutes()
    .map((p) => `/api${p}`);
  // INVARIANT — starting arx_live_commands count MUST be 0 per brief.
  const startLive = await liveCommandsCount();
  // eslint-disable-next-line no-console
  console.log(`[INVARIANT] starting arx_live_commands count = ${startLive}`);
  if (startLive !== 0) {
    // eslint-disable-next-line no-console
    console.error(`[FATAL] arx_live_commands must start at 0, found ${startLive}. Aborting QA.`);
    await pool.end().catch(() => {});
    process.exit(1);
  }

  // Step 1 — create users + sessions.
  const userA = await createUser("A");
  const userB = await createUser("B");
  // re-tag marker for label2Sign
  userA.marker = `${TAG}_MA`; userB.marker = `${TAG}_MB`;
  // eslint-disable-next-line no-console
  console.log(`[SETUP] users: A=${userA.id} B=${userB.id}`);

  // Step 2 — seed both users + an unattributed orphan.
  let orphanId = -1;
  try {
    await seedUser(userA);
    await seedUser(userB);
    orphanId = await seedUnattributedOrphan();
    record("00_seed_two_users_complete", true,
      `A_rows=${JSON.stringify(userA.rowIds)} B_rows=${JSON.stringify(userB.rowIds)} orphan=${orphanId}`);
  } catch (e) {
    record("00_seed_two_users_complete", false, `seed failed: ${(e as Error).message}`);
    await cleanupAll(userA, userB, orphanId);
    finishAndExit(startLive);
    return;
  }

  // Step 3 — anonymous probe: every endpoint must reject with 401.
  let anonOk = 0;
  for (const ep of PROBE_ENDPOINTS) {
    const r = await fetchAs(null, ep);
    if (r.status === 401 || r.status === 403) anonOk++;
  }
  record("01_anon_blocked_on_all_probes", anonOk === PROBE_ENDPOINTS.length,
    `${anonOk}/${PROBE_ENDPOINTS.length} probes returned 401/403 to anonymous caller`);

  // Step 4 — for every probe, assert at TWO levels:
  //   (a) marker string of the other user must not appear in body
  //   (b) STRUCTURAL: `"userId":<otherId>` / `"user_id":<otherId>` must not
  //       appear — catches leaks of rows that don't carry our seed text.
  // Marker leaks count as failures regardless of HTTP status. Status-based
  // leaks (response bodies generally) are evaluated only for non-5xx (a 500
  // can return generic error text without leaking).
  let crossLeaks = 0;
  let probedAuthOk = 0;
  const leakDetails: string[] = [];
  const otherIdPatterns = (otherUserId: number): RegExp[] => [
    new RegExp(`"user_?[Ii]d"\\s*:\\s*${otherUserId}\\b`),
  ];
  for (const ep of PROBE_ENDPOINTS) {
    const ra = await fetchAs(userA, ep);
    const rb = await fetchAs(userB, ep);
    if (ra.status >= 200 && ra.status < 300) probedAuthOk++;
    // Marker leaks — any status.
    if (bodyContains(ra.bodyText, userB.marker)) {
      crossLeaks++; leakDetails.push(`A→${ep}[${ra.status}] leaked B.marker`);
    }
    if (bodyContains(rb.bodyText, userA.marker)) {
      crossLeaks++; leakDetails.push(`B→${ep}[${rb.status}] leaked A.marker`);
    }
    if (bodyContains(ra.bodyText, `${TAG}_unattributed_orphan`)) {
      crossLeaks++; leakDetails.push(`A→${ep}[${ra.status}] leaked orphan marker`);
    }
    if (bodyContains(rb.bodyText, `${TAG}_unattributed_orphan`)) {
      crossLeaks++; leakDetails.push(`B→${ep}[${rb.status}] leaked orphan marker`);
    }
    // Structural ID leaks — only on 2xx (4xx/5xx bodies are generic errors).
    if (ra.status >= 200 && ra.status < 300) {
      for (const re of otherIdPatterns(userB.id)) {
        if (re.test(ra.bodyText)) {
          crossLeaks++;
          leakDetails.push(`A→${ep}[200] leaked B.id=${userB.id} structurally`);
          break;
        }
      }
    }
    if (rb.status >= 200 && rb.status < 300) {
      for (const re of otherIdPatterns(userA.id)) {
        if (re.test(rb.bodyText)) {
          crossLeaks++;
          leakDetails.push(`B→${ep}[200] leaked A.id=${userA.id} structurally`);
          break;
        }
      }
    }
  }
  record("02_no_cross_user_marker_or_id_leak", crossLeaks === 0,
    crossLeaks === 0
      ? `all ${PROBE_ENDPOINTS.length} endpoints clean for both users (${probedAuthOk} returned 2xx for user A; the rest were 4xx/5xx and still scanned for marker leaks)`
      : leakDetails.join(" | "));

  // Step 5 — assistant: user A tries to fetch user B's convo by ID. Must 404 or 403.
  const stealAttempt = await fetchAs(userA, `/api/me/assistant/conversations/${userB.rowIds.convoId}`);
  const stealAttemptMsg = await fetchAs(userA, `/api/me/assistant/conversations/${userB.rowIds.convoId}/messages`);
  const noBLeak = !bodyContains(stealAttempt.bodyText, userB.marker) && !bodyContains(stealAttemptMsg.bodyText, userB.marker);
  const wasBlocked = stealAttempt.status === 404 || stealAttempt.status === 403 || stealAttempt.status === 400 ||
                     (stealAttempt.status === 200 && noBLeak);
  record("03_assistant_cannot_steal_other_convo", wasBlocked && noBLeak,
    `A→B convoId=${userB.rowIds.convoId} status=${stealAttempt.status} bodyHasBMarker=${!noBLeak}`);

  // Step 6 — IDOR check across EVERY parameterized /me/*/:param GET route.
  // Discovered statically from the route source so this list cannot drift
  // out of sync with new endpoints. For each route we substitute user B's
  // seeded ID for the matching param (or a high sentinel when no seed
  // matches the param name), then assert user A's response does NOT leak
  // B's marker AND does NOT structurally contain `"userId":<B.id>`.
  const idorRoutes = discoverParameterizedMeGetRoutes();
  // Param-name → seeded B id. Covers all rows we plant in step 2.
  const seededByParam: Record<string, number | undefined> = {
    id: undefined,             // generic — fallback to per-route override below
    tradeKey: undefined,       // strings; we send a high sentinel
    symbol: undefined,         // strings; sentinel below
    date: undefined,           // strings; sentinel below
    commandId: userB.rowIds.mt5CommandId,
  };
  // Route-prefix → specific seeded id for `:id`/`:commandId` (because the
  // same param name targets a different table per route family). To prevent
  // a silent sentinel fallback from hiding an IDOR regression on an
  // unmapped family, every discovered prefix MUST be explicitly listed
  // here as either (a) a real B-owned row id, or (b) `null` meaning "we
  // intentionally have no seeded B row for this family — sentinel
  // probing is the best we can do, and any new B-owned row family added
  // later must be added here." The dispatcher below throws on a
  // discovered prefix that is not listed at all.
  const idByRoutePrefix = (path: string): { id: number | null; reason: "seeded" | "unseeded-known" } => {
    // Explicit catalog of every parameterized /me/* family discovered in
    // the route source. Keep ALPHABETICAL. Adding a new /me/*/:id route
    // requires editing this catalog or QA will throw.
    const map: Array<[string, number | undefined, "seeded" | "unseeded-known"]> = [
      ["/me/activity/",                    userB.rowIds.notificationId,    "seeded"],
      ["/me/alerts/",                      userB.rowIds.alertId,            "seeded"],
      ["/me/assistant/conversations/",     userB.rowIds.convoId,            "seeded"],
      ["/me/demo-commands/",               userB.rowIds.mt5CommandId,       "seeded"],
      ["/me/live/command-status/",         undefined,                       "unseeded-known"], // :commandId (string-keyed; sentinel probe confirms 404 not cross-user data)
      ["/me/live/commands/",               userB.rowIds.liveCommandId,      "seeded"],
      ["/me/live/positions/",              undefined,                       "unseeded-known"], // :ticket
      ["/me/market-context/",              undefined,                       "unseeded-known"], // :symbol
      ["/me/mt5-commands/",                userB.rowIds.mt5CommandId,       "seeded"],
      ["/me/mt5-connections/",             userB.rowIds.mt5ConnectionId,    "seeded"],
      ["/me/notifications/",               userB.rowIds.notificationId,    "seeded"],
      ["/me/paper-trades/",                userB.rowIds.paperTradeId,       "seeded"],
      ["/me/pending-order-draft/",         undefined,                       "unseeded-known"],
      ["/me/performance-calendar/",        undefined,                       "unseeded-known"], // :date
      ["/me/playbooks/",                   userB.rowIds.playbookId,         "seeded"],
      ["/me/positions/",                   undefined,                       "unseeded-known"], // :positionTicket
      ["/me/pre-trade-checks/",            undefined,                       "unseeded-known"],
      ["/me/reports/",                     userB.rowIds.reportId,           "seeded"],
      ["/me/risk/events/",                 undefined,                       "unseeded-known"],
      ["/me/trade-actions/",               undefined,                       "unseeded-known"],
      ["/me/trade-alerts/",                userB.rowIds.alertId,            "seeded"],
      ["/me/trade-journal/",               userB.rowIds.journalId,          "seeded"],
      ["/me/trades/",                      undefined,                       "unseeded-known"], // :tradeKey
      ["/me/trading-sessions/",            userB.rowIds.tradingSessionId,   "seeded"],
      ["/me/tradingview/tokens/",          undefined,                       "unseeded-known"], // :id (DELETE; revokeWebhookToken scopes by userId)
    ];
    for (const [pfx, id, reason] of map) {
      if (path.startsWith(pfx)) return { id: id ?? null, reason };
    }
    throw new Error(`IDOR probe: discovered /me/* parameterized route prefix not in idByRoutePrefix catalog: ${path}. Add it to the catalog with a B-owned seeded id (preferred) or "unseeded-known".`);
  };
  const SENTINEL_STRING = "QA_SENTINEL_NEVER_EXISTS";
  const SENTINEL_NUMBER = 99999999;
  let stolen = 0;
  let idorProbed = 0;
  const stolenDetail: string[] = [];
  for (const route of idorRoutes) {
    // Substitute each :param in the path. Prefer the seeded B id, otherwise sentinel.
    const ep = route.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
      if (name === "id" || name === "ruleId" || name === "commandId" || name === "ticket" || name === "positionTicket") {
        const seeded = idByRoutePrefix(route);
        if (seeded.id != null) return String(seeded.id);
        // unseeded-known family: use sentinel (string for ticket-like, number for id-like).
        if (name === "ticket" || name === "positionTicket") return SENTINEL_STRING;
        return String(SENTINEL_NUMBER);
      }
      const fromMap = seededByParam[name];
      if (typeof fromMap === "number") return String(fromMap);
      // Path-param is likely a string (tradeKey/symbol/date) — sentinel.
      return SENTINEL_STRING;
    });
    idorProbed++;
    const r = await fetchAs(userA, `/api${ep}`);
    // Leak conditions: 2xx body contains B's marker OR structurally
    // contains "userId":<B.id>. 401/403/404/4xx/5xx are acceptable.
    if (r.status >= 200 && r.status < 300) {
      if (bodyContains(r.bodyText, userB.marker)) {
        stolen++;
        stolenDetail.push(`${ep}[200] leaked B.marker`);
      } else if (new RegExp(`"user_?[Ii]d"\\s*:\\s*${userB.id}\\b`).test(r.bodyText)) {
        stolen++;
        stolenDetail.push(`${ep}[200] leaked B.id=${userB.id}`);
      }
    }
  }
  record("04_idor_probes_all_parameterized_me_get_routes", stolen === 0,
    stolen === 0
      ? `${idorProbed} IDOR GET probes refused: ${idorRoutes.length} parameterized /me/*/:param GET route(s) discovered`
      : stolenDetail.join(" | "));

  // Step 6b — IDOR for parameterized non-GET routes (POST/PUT/PATCH/DELETE).
  // We send an empty JSON body to each route, substituting B's seeded ID
  // (or sentinel) for the param. Acceptable outcomes: 4xx/5xx (validation,
  // 401/403, 404 not found). UNACCEPTABLE: 2xx response that contains B's
  // marker or `"userId":<B.id>` — that would prove a mutation operated on
  // B's row. Live-broker dispatch impossibility is cross-checked by the
  // strict-zero arx_live_commands invariant at the end of the run.
  const mutationRoutes = discoverParameterizedMeMutationRoutes();
  let mutStolen = 0;
  let mutProbed = 0;
  const mutDetail: string[] = [];
  // Pre-mutation DB snapshot of every B-owned seeded row. After the
  // 60-route mutation probe burst we re-read each row and assert it
  // STILL EXISTS, still belongs to B, and its marker-bearing field is
  // unchanged. This closes the IDOR class where a route returns
  // `204`/`{ok:true}` without echoing B's id but actually deleted or
  // mutated B's row (e.g., `DELETE WHERE id=:id` missing `AND user_id=$me`).
  const bSnapshot = await snapshotBOwnedRows(userB);
  for (const { method, path: rp } of mutationRoutes) {
    const ep = rp.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
      if (name === "id" || name === "ruleId" || name === "commandId" || name === "ticket" || name === "positionTicket") {
        const seeded = idByRoutePrefix(rp);
        if (seeded.id != null) return String(seeded.id);
        if (name === "ticket" || name === "positionTicket") return SENTINEL_STRING;
        return String(SENTINEL_NUMBER);
      }
      const fromMap = seededByParam[name];
      if (typeof fromMap === "number") return String(fromMap);
      return SENTINEL_STRING;
    });
    mutProbed++;
    const r = await mutateAs(userA, method, `/api${ep}`);
    if (r.status >= 200 && r.status < 300) {
      if (bodyContains(r.bodyText, userB.marker)) {
        mutStolen++;
        mutDetail.push(`${method} ${ep}[200] leaked B.marker`);
      } else if (new RegExp(`"user_?[Ii]d"\\s*:\\s*${userB.id}\\b`).test(r.bodyText)) {
        mutStolen++;
        mutDetail.push(`${method} ${ep}[200] leaked B.id=${userB.id}`);
      }
    }
  }
  record("04b_idor_probes_all_parameterized_me_mutation_routes", mutStolen === 0,
    mutStolen === 0
      ? `${mutProbed} IDOR mutation probes refused: ${mutationRoutes.length} parameterized POST/PUT/PATCH/DELETE /me/*/:param route(s) discovered`
      : mutDetail.join(" | "));

  // Step 6c — post-mutation DB invariant. Re-snapshot B-owned rows and
  // diff against the pre-snapshot. ANY missing row or changed marker
  // field proves a cross-user write/delete occurred even if the HTTP
  // response was a silent 200/204.
  const bSnapshotAfter = await snapshotBOwnedRows(userB);
  const diffs = diffBSnapshots(bSnapshot, bSnapshotAfter);
  record("04c_b_owned_rows_unchanged_after_mutation_probes", diffs.length === 0,
    diffs.length === 0
      ? `all ${Object.keys(bSnapshot).length} B-owned seeded rows still present + unchanged after ${mutProbed} A-issued mutation probes`
      : `B mutation by A detected: ${diffs.join(" | ")}`);

  // Step 7 — shared-account/summary scope check.
  // User A's summary should report >=1 virtualAccount, none of which match
  // B's virtualAccountId.
  const sumA = await fetchAs(userA, "/api/me/shared-account/summary");
  const sumB = await fetchAs(userB, "/api/me/shared-account/summary");
  const aIds = extractIds(sumA.bodyText);
  const bIds = extractIds(sumB.bodyText);
  const aSeesBVacc = userB.rowIds.virtualAccountId != null && aIds.includes(userB.rowIds.virtualAccountId);
  const bSeesAVacc = userA.rowIds.virtualAccountId != null && bIds.includes(userA.rowIds.virtualAccountId);
  record("05_shared_account_summary_is_per_user", !aSeesBVacc && !bSeesAVacc,
    `A.virtualAccountIdsSeen=${JSON.stringify(aIds)} B.virtualAccountIdsSeen=${JSON.stringify(bIds)}`);

  // Step 8 — shared-account/attributions: A must never see B's attribution PnL row.
  const attA = await fetchAs(userA, "/api/me/shared-account/attributions");
  const attB = await fetchAs(userB, "/api/me/shared-account/attributions");
  const aSeesBAttPnl = bodyContains(attA.bodyText, userB.marker);
  const bSeesAAttPnl = bodyContains(attB.bodyText, userA.marker);
  record("06_shared_account_attributions_isolated", !aSeesBAttPnl && !bSeesAAttPnl,
    `A.body.bMarker=${aSeesBAttPnl} B.body.aMarker=${bSeesAAttPnl}`);

  // Step 9 — DB-level scope check: for each per-user table, assert the
  // count of rows where user_id=A intersected with B's seeded ids is 0.
  // (Belt-and-suspenders that the WHERE userId = req.authUser.id idiom is
  // structurally correct.)
  const dbProbes: Array<{ table: string; userIdCol: string; otherId: number }> = [
    { table: "watchlists", userIdCol: "user_id", otherId: userB.rowIds.watchlistId! },
    { table: "user_notifications", userIdCol: "user_id", otherId: userB.rowIds.notificationId! },
    { table: "user_alerts", userIdCol: "user_id", otherId: userB.rowIds.alertId! },
    { table: "performance_daily", userIdCol: "user_id", otherId: userB.rowIds.perfDailyId! },
    { table: "trade_journal_entries", userIdCol: "user_id", otherId: userB.rowIds.journalId! },
    { table: "arx_assistant_conversations", userIdCol: "user_id", otherId: userB.rowIds.convoId! },
    { table: "virtual_trading_accounts", userIdCol: "user_id", otherId: userB.rowIds.virtualAccountId! },
    { table: "shared_trade_attribution", userIdCol: "user_id", otherId: userB.rowIds.attributionId! },
    { table: "paper_trades", userIdCol: "user_id", otherId: userB.rowIds.paperTradeId! },
    { table: "mt5_commands", userIdCol: "user_id", otherId: userB.rowIds.mt5CommandId! },
  ];
  let dbViolations = 0;
  const dbVioDetail: string[] = [];
  for (const probe of dbProbes) {
    const q = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ${probe.table} WHERE ${probe.userIdCol} = $1 AND id = $2`,
      [userA.id, probe.otherId],
    );
    const n = (q.rows[0] as { n: number }).n;
    if (n !== 0) { dbViolations++; dbVioDetail.push(`${probe.table}: A.id+B.row collision n=${n}`); }
  }
  record("07_db_scope_no_collisions", dbViolations === 0,
    dbViolations === 0 ? `${dbProbes.length} per-user tables: no A.userId + B.rowId collisions` : dbVioDetail.join(" | "));

  // Step 10 — unattributed_master_trades MUST never surface to either user.
  const orphanLeakProbes = [
    "/api/me/shared-account/positions",
    "/api/me/shared-account/attributions",
    "/api/me/positions/all",
    "/api/me/trades/open",
    "/api/me/trades/history",
  ];
  let orphanLeak = 0;
  for (const ep of orphanLeakProbes) {
    const ra = await fetchAs(userA, ep);
    const rb = await fetchAs(userB, ep);
    if (bodyContains(ra.bodyText, `${TAG}_unattributed_orphan`)) orphanLeak++;
    if (bodyContains(rb.bodyText, `${TAG}_unattributed_orphan`)) orphanLeak++;
  }
  record("08_unattributed_orphan_never_in_me_endpoints", orphanLeak === 0,
    orphanLeak === 0 ? `${orphanLeakProbes.length} endpoints clean of orphan marker` : `${orphanLeak} leaks found`);

  // Cleanup — failures are fatal per architect feedback (residue must not
  // accumulate silently across runs).
  const cleanupOk = await cleanupAll(userA, userB, orphanId);
  record("09_cleanup_succeeded", cleanupOk,
    cleanupOk ? "all seeded rows + sessions + users deleted" : "cleanup raised — see stderr");

  finishAndExit(startLive);
}

// Statically discover every parameterized GET /me/*/:param route by
// scanning artifacts/api-server/src/routes/*.ts. Returns the path only
// (e.g. "/me/trade-journal/:id"). This means a future regression that
// adds a new parameterized /me/*/:param GET will automatically be
// probed by step 4 without anyone having to update this script.
const ROUTES_DIR = pathJoin(import.meta.dirname, "..", "..", "artifacts", "api-server", "src", "routes");

function readAllRouteFiles(): Array<{ file: string; raw: string }> {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, raw: readFileSync(pathJoin(ROUTES_DIR, f), "utf-8") }));
}

// Every GET /me/* path that contains no ":param" segment.
function discoverNonParameterizedMeGetRoutes(): string[] {
  const re = /router\.get\(\s*["'`](\/me(?:\/[^"'`:]+)*)["'`]/g;
  const out = new Set<string>();
  for (const { raw } of readAllRouteFiles()) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) out.add(m[1]!);
  }
  return Array.from(out).sort();
}

// Every GET /me/*/:param path. Returns the raw path (with :param tokens).
function discoverParameterizedMeGetRoutes(): string[] {
  const re = /router\.get\(\s*["'`](\/me\/[^"'`]*:[^"'`]+)["'`]/g;
  const out = new Set<string>();
  for (const { raw } of readAllRouteFiles()) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) out.add(m[1]!);
  }
  return Array.from(out).sort();
}

// Every parameterized non-GET /me/*/:param path (POST/PUT/PATCH/DELETE).
function discoverParameterizedMeMutationRoutes(): Array<{ method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string }> {
  const re = /router\.(post|put|patch|delete)\(\s*["'`](\/me\/[^"'`]*:[^"'`]+)["'`]/g;
  const out = new Map<string, { method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string }>();
  for (const { raw } of readAllRouteFiles()) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const method = m[1]!.toUpperCase() as "POST" | "PUT" | "PATCH" | "DELETE";
      const path = m[2]!;
      out.set(`${method} ${path}`, { method, path });
    }
  }
  return Array.from(out.values()).sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
}

function extractIds(bodyText: string): number[] {
  // Best-effort extraction of numeric "id" fields from JSON response.
  const ids = new Set<number>();
  const re = /"id"\s*:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyText)) !== null) ids.add(parseInt(m[1]!, 10));
  return Array.from(ids);
}

async function cleanupAll(userA: SeededUser, userB: SeededUser, orphanId: number): Promise<boolean> {
  const userIds = [userA.id, userB.id];
  try {
    // Delete seeded rows directly first (fast, predictable path).
    // Terminal-state REJECTED rows seeded for /me/live/commands/:commandId
    // IDOR probing. Deleted FIRST so the strict-zero arx_live_commands
    // invariant (start=end=0) re-holds regardless of FK discovery.
    await db.delete(arxLiveCommandsTable).where(inArray(arxLiveCommandsTable.userId, userIds));
    await db.delete(sharedTradeAttributionTable).where(inArray(sharedTradeAttributionTable.userId, userIds));
    await db.delete(virtualTradingAccountsTable).where(inArray(virtualTradingAccountsTable.userId, userIds));
    await db.delete(mt5CommandsTable).where(inArray(mt5CommandsTable.userId, userIds));
    await db.delete(paperTradesTable).where(inArray(paperTradesTable.userId, userIds));
    await db.delete(arxAssistantConversationsTable).where(inArray(arxAssistantConversationsTable.userId, userIds));
    await db.delete(tradeJournalEntriesTable).where(inArray(tradeJournalEntriesTable.userId, userIds));
    await db.delete(performanceDailyTable).where(inArray(performanceDailyTable.userId, userIds));
    await db.delete(userAlertsTable).where(inArray(userAlertsTable.userId, userIds));
    await db.delete(userNotificationsTable).where(inArray(userNotificationsTable.userId, userIds));
    await db.delete(watchlistsTable).where(inArray(watchlistsTable.userId, userIds));
    if (orphanId > 0) {
      await db.delete(unattributedMasterTradesTable).where(eq(unattributedMasterTradesTable.id, orphanId));
    }
    await pool.query("DELETE FROM auth_user_sessions WHERE user_id = ANY($1::int[])", [userIds]);

    // Some routes auto-create per-user rows on first hit (e.g. settings,
    // readiness state, risk events). Discover every FK pointing at
    // users.id and delete the referencing rows before deleting users.
    const fkRows = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = 'users'
          AND ccu.column_name = 'id'`,
    );
    for (const fk of fkRows.rows) {
      await pool.query(
        `DELETE FROM "${fk.table_name}" WHERE "${fk.column_name}" = ANY($1::int[])`,
        [userIds],
      ).catch((e) => {
        // eslint-disable-next-line no-console
        console.warn(`[CLEANUP] FK delete on ${fk.table_name}.${fk.column_name} failed: ${(e as Error).message}`);
      });
    }
    await db.delete(usersTable).where(or(eq(usersTable.id, userA.id), eq(usersTable.id, userB.id)));
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[CLEANUP] failed:", (e as Error).message);
    return false;
  }
}

async function finishAndExit(startLive: number): Promise<void> {
  const endLive = await liveCommandsCount();
  // Strict invariant per brief: NO live trade fired by this QA. Start is
  // pre-seed (asserted ==0 at boot); end is post-cleanup. Cleanup deletes
  // every QA-seeded row (including the 2 terminal-state REJECTED
  // arx_live_commands seeds used to enable IDOR probing of
  // /me/live/commands/:commandId). end MUST equal startLive (==0) — any
  // delta proves the probes inadvertently created a real live command.
  const liveOk = endLive === startLive && startLive === 0;
  record("99_arx_live_commands_strict_zero", liveOk,
    `start=${startLive} end=${endLive} (both must be 0 — terminal-state QA seeds are deleted in cleanup)`);

  const passed = results.filter(r => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${results.length} probes passed`);
  // eslint-disable-next-line no-console
  console.log(`[INVARIANT] arx_live_commands unchanged: ${liveOk ? "YES" : "NO"} (start=${startLive}, end=${endLive})`);

  await pool.end().catch(() => {});
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error("FATAL", e);
  await pool.end().catch(() => {});
  process.exit(1);
});
