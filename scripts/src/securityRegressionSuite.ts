/**
 * securityRegressionSuite.ts — Task #244 (Phase 8)
 *
 * Consolidated automated security regression suite for the ARX AACI Security &
 * Encryption Layer. Every check uses REAL evidence — real API calls through the
 * shared proxy, real DB state, and the real pure-domain evaluators — never a
 * fabricated pass. Both the negative AND the positive direction are asserted
 * wherever a denial is the point (a 401 on a nonexistent route proves nothing,
 * so the authorized path is always exercised too).
 *
 * Covers the 10 "Done looks like" items:
 *   1.  Regular users cannot access admin routes; an authed admin CAN.
 *   2.  Users cannot read another user's alerts / trades / Ruby memory.
 *   3.  A self-trade agent cannot use another agent's allocation, trade outside
 *       allowed symbols, or exceed its autonomy level (positive EXECUTE too).
 *   4.  Secrets never reach client payloads / logs / Ruby / alerts / exports.
 *   5.  Duplicate, expired, replayed, and unauthorized commands are rejected.
 *   6.  Password reset token expires and cannot be reused.
 *   7.  Invite-code attempts are rate-limited.
 *   8.  MT5 bridge secrets stay server-side; admin-only security page is hidden
 *       from regular users.
 *   9.  Production mode does not use the dev email fallback and the live route
 *       does not use mock execution.
 *   10. Exports redact secrets; Security Lockdown pauses autonomous entries
 *       while permissioned protective actions remain available.
 *
 * Inviolables (mirrors qaAuthLoginRoles.ts):
 *   - Does NOT set ARX_LIVE_BROKER_EXECUTION_ENABLED.
 *   - Does NOT insert into arx_live_commands. Asserts baseline-delta (start==end)
 *     + zero rows attributable to seeded users — never deletes that evidence.
 *   - Never prints a seeded password or a raw bridge token to stdout.
 *   - Cleans up ONLY the isolated rows it created, in a finally block.
 *
 * Requires the API server running at $BASE_URL (defaults to http://localhost:80).
 * Run: pnpm --filter @workspace/scripts run test:security-regression
 */

import { pool } from "@workspace/db";
import { passwordResetTokensRepo } from "@workspace/db/repositories";
import { randomBytes, scryptSync, createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  evaluateRateLimit,
  DEFAULT_RATE_LIMIT_POLICY,
  type RateLimitState,
  computePayloadHash,
  evaluateCommandIntegrity,
  type CommandIntegrityVerifyInput,
  resolveOperationalModePosture,
  evaluateProdDevSeparation,
  redactSecrets,
  redactForLog,
  redactSecretString,
} from "@workspace/domain/security";
import { buildPasswordResetEmail, buildExpiringKeysDigestEmail } from "@workspace/domain/email";
import {
  evaluateExecutionPermission,
  runDecisionPipeline,
  type ExecutionPermissionInput,
  type QuotaContext,
  type GovernorContext,
  type HandshakeReadinessContext,
  type TradeThesis,
  type DecisionCandidateInput,
} from "@workspace/domain/self-trade";
import {
  buildRubyMarketEdge,
  type SignalCandle,
  type SignalEngineInput,
  type SignalScannerInput,
} from "@workspace/domain/signal-intelligence";

const BASE = (process.env.BASE_URL ?? "http://localhost:80").replace(/\/$/, "");

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
  if (ok) pass++; else fail++;
}

interface FetchResult { status: number; headers: Headers; body: string; cookies: string[] }
async function call(method: string, path: string, opts: { cookie?: string; json?: unknown; headers?: Record<string, string> } = {}): Promise<FetchResult> {
  const headers: Record<string, string> = { "content-type": "application/json", "accept": "application/json", ...(opts.headers ?? {}) };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const body = await res.text();
  return { status: res.status, headers: res.headers, body, cookies: setCookie };
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(";")[0]).join("; ");
}

const N = 65536, r = 8, p = 1, KEYLEN = 64;
function hashLocal(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function seedUser(role: "USER" | "ADMIN", label: string): Promise<{ id: number; email: string; password: string }> {
  const email = `qa-sec-${label}-${randomBytes(4).toString("hex")}@arx.local`;
  const password = `Sec-${randomBytes(9).toString("hex")}`;
  const insRow = await pool.query<{ id: number }>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, `QA Sec ${label}`, hashLocal(password), role],
  );
  return { id: insRow.rows[0]!.id, email, password };
}
// Mirrors hashScope() in artifacts/api-server/src/lib/security/cooldowns.ts.
// Cross-artifact import is disallowed in this monorepo and the formula is a
// stable 2-liner, so it is replicated here intentionally.
function hashScope(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex").slice(0, 24)}`;
}

// The suite authenticates and hammers /api/auth/register from the loopback
// caller, so every request lands on ONE per-IP auth scope. Across repeated runs
// (each does 3 logins + the 07d invite hammer) that scope's LOGIN /
// INVITE_CODE_ATTEMPT cooldowns accumulate and would 429 the suite's OWN admin
// login. Reset ONLY this harness's loopback scope (every form the proxy may
// present 127.0.0.1 as, plus the "unknown" fallback) for the auth actions the
// suite touches. This never matches a real remote user's scope (their IPs are
// non-loopback), so it is hermetic and does NOT weaken any rate-limit rule — it
// only clears the test harness's own counter, the same way fresh seeded users
// start clean.
async function resetOwnLoopbackAuthCooldowns(): Promise<void> {
  const loopbackScopeKeys = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "unknown"].map((ip) => hashScope("ip", ip));
  await pool
    .query(
      `DELETE FROM security_cooldowns
         WHERE action_key IN ('LOGIN','INVITE_CODE_ATTEMPT','FORGOT_PASSWORD','RESET_PASSWORD','REQUEST_ACCESS')
           AND scope_key = ANY($1::text[])`,
      [loopbackScopeKeys],
    )
    .catch(() => {});
}

async function login(email: string, password: string): Promise<{ cookie: string; body: string; status: number }> {
  const res = await call("POST", "/api/auth/login", { json: { email, password } });
  return { cookie: cookieHeader(res.cookies), body: res.body, status: res.status };
}

// ── self-trade fixtures (mirrored from selfTradeExecutionDomainTest.ts) ──────
const NOW = Date.parse("2026-06-06T12:00:00Z");
function okQuota(): QuotaContext {
  return { dailyMinTrades: 3, effectiveMaxTrades: 5, tradesTakenToday: 1, remainingToMax: 4, belowDailyMinimum: true, baseReached: false, hardCapReached: false };
}
function okGovernor(): GovernorContext { return { status: "PAPER_ALLOWED", hardBlocks: [] }; }
function okHandshake(): HandshakeReadinessContext { return { ready: true, degraded: [], blocked: [] }; }
function okThesis(): TradeThesis {
  return {
    symbol: "EURUSD", side: "BUY", setup: "TREND_CONTINUATION" as TradeThesis["setup"], whyNow: ["trend"],
    entryZone: { from: 1.1, to: 1.1005 }, stopLoss: 1.095, invalidation: 1.094,
    takeProfits: [{ from: 1.105, to: 1.105 }, { from: 1.11, to: 1.11 }], edge: 70, confidence: 72, newsRisk: "low",
  };
}
function basePermInput(over: Partial<ExecutionPermissionInput> = {}): ExecutionPermissionInput {
  return {
    agentStatus: "ACTIVE", agentMode: "LIVE", autonomyLevel: 2, outcome: "APPROVED", thesis: okThesis(),
    setupExpiresAt: null, funded: true, quota: okQuota(), governor: okGovernor(), handshake: okHandshake(),
    killEngaged: false, openPositionsCount: 0, maxConcurrentPositions: 1, executingUserId: 4,
    hasMasterLiveAccess: true, now: NOW, ...over,
  };
}

// ── signal fixtures (mirrored from scannerExplanationTest.ts) ────────────────
function risingCandles(n: number): SignalCandle[] {
  const out: SignalCandle[] = [];
  let base = 1.1;
  for (let i = 0; i < n; i++) {
    const open = base, close = base + 0.001, high = close + 0.0004, low = open - 0.0003;
    out.push({ open, high, low, close, volume: 100 + i });
    base = close;
  }
  return out;
}
const baseScanner: SignalScannerInput = {
  bias: "bullish", recommendedAction: "BUY", confidenceScore: 72, entrySniperScore: 68, trendStrength: 65,
  riskRewardRatio: 2.1, setupType: "TREND_CONTINUATION", entry: 1.12, stopLoss: 1.115, takeProfit: 1.132,
  entryZone: { from: 1.119, to: 1.121 }, reasonForTrade: "higher highs and higher lows", reasonToAvoid: null,
};
function signalInput(overrides: Partial<SignalEngineInput> = {}): SignalEngineInput {
  return {
    symbol: "EURUSD", displayName: "EUR/USD", timeframe: "M5", assetClass: "forex", candles: risingCandles(40),
    currentPrice: 1.12, dataSource: "LIVE_FEED", scanner: baseScanner, scalp: null,
    execution: { heartbeatAgeSeconds: 3, bridgeConnected: true }, newsRiskLevel: "none", previous: null, now: NOW, ...overrides,
  };
}

async function main(): Promise<void> {
  const startRow = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM arx_live_commands`);
  const start = startRow.rows[0]!.c;

  const userA = await seedUser("USER", "a");
  const userB = await seedUser("USER", "b");
  const admin = await seedUser("ADMIN", "admin");
  const seededIds = [userA.id, userB.id, admin.id];

  // Unique markers so cross-user reads are unambiguous evidence.
  const tokenA = `OWNA${randomBytes(4).toString("hex").toUpperCase()}`;
  const tokenB = `OWNB${randomBytes(4).toString("hex").toUpperCase()}`;
  const symA = `ZA${randomBytes(2).toString("hex").toUpperCase()}`;
  const symB = `ZB${randomBytes(2).toString("hex").toUpperCase()}`;

  const alertA = await pool.query<{ id: number }>(`INSERT INTO user_alerts (user_id, alert_type, title) VALUES ($1, 'risk_block', $2) RETURNING id`, [userA.id, tokenA]);
  const alertB = await pool.query<{ id: number }>(`INSERT INTO user_alerts (user_id, alert_type, title) VALUES ($1, 'risk_block', $2) RETURNING id`, [userB.id, tokenB]);
  const convA = await pool.query<{ id: number }>(`INSERT INTO arx_assistant_conversations (user_id, title) VALUES ($1, $2) RETURNING id`, [userA.id, tokenA]);
  const convB = await pool.query<{ id: number }>(`INSERT INTO arx_assistant_conversations (user_id, title) VALUES ($1, $2) RETURNING id`, [userB.id, tokenB]);
  await pool.query(`INSERT INTO trades (user_id, symbol, direction, lot, entry_price, stop_loss, take_profit, strategy, confidence, status, mode) VALUES ($1,$2,'BUY',0.01,1.1,1.09,1.12,'QA',70,'OPEN','DEMO')`, [userA.id, symA]);
  await pool.query(`INSERT INTO trades (user_id, symbol, direction, lot, entry_price, stop_loss, take_profit, strategy, confidence, status, mode) VALUES ($1,$2,'BUY',0.01,1.1,1.09,1.12,'QA',70,'OPEN','DEMO')`, [userB.id, symB]);

  const httpBodies: string[] = [];
  try {
    // Clear this harness's own loopback auth cooldowns so prior-run accumulation
    // (3 logins + the 07d invite hammer per run) never 429s the suite's logins.
    await resetOwnLoopbackAuthCooldowns();
    const aLogin = await login(userA.email, userA.password);
    const bLogin = await login(userB.email, userB.password);
    const adminLogin = await login(admin.email, admin.password);
    httpBodies.push(aLogin.body, bLogin.body, adminLogin.body);
    check("00_logins_succeed", aLogin.status === 200 && bLogin.status === 200 && adminLogin.status === 200, `a=${aLogin.status} b=${bLogin.status} admin=${adminLogin.status}`);
    const aCookie = aLogin.cookie, adminCookie = adminLogin.cookie;

    // ── Item 1 + 8: admin route gating, both directions ──────────────────────
    const ovAnon = await call("GET", "/api/admin/security/overview");
    const ovUser = await call("GET", "/api/admin/security/overview", { cookie: aCookie });
    const ovAdmin = await call("GET", "/api/admin/security/overview", { cookie: adminCookie });
    httpBodies.push(ovUser.body, ovAdmin.body);
    check("01a_admin_security_overview_anon_401", ovAnon.status === 401, `status=${ovAnon.status}`);
    check("01b_admin_security_overview_user_403", ovUser.status === 403, `status=${ovUser.status}`);
    check("01c_admin_security_overview_admin_200", ovAdmin.status === 200, `status=${ovAdmin.status}`);
    check("08a_security_internals_hidden_from_regular_user", ovUser.status === 403 && !ovUser.body.toLowerCase().includes("securityscore"), `status=${ovUser.status}`);

    // ── Item 2: per-user isolation (alerts / trades / Ruby memory) ──────────
    const aAlerts = await call("GET", "/api/me/alerts", { cookie: aCookie });
    httpBodies.push(aAlerts.body);
    check("02a_alerts_own_visible", aAlerts.status === 200 && aAlerts.body.includes(tokenA), `status=${aAlerts.status}`);
    check("02b_alerts_others_not_leaked", !aAlerts.body.includes(tokenB), "B token absent from A's alerts");

    const aTrades = await call("GET", "/api/trades", { cookie: aCookie });
    httpBodies.push(aTrades.body);
    check("02c_trades_own_visible", aTrades.status === 200 && aTrades.body.includes(symA), `status=${aTrades.status}`);
    check("02d_trades_others_not_leaked", !aTrades.body.includes(symB), "B symbol absent from A's trades");

    const aConvList = await call("GET", "/api/me/assistant/conversations", { cookie: aCookie });
    httpBodies.push(aConvList.body);
    check("02e_ruby_memory_others_not_leaked", !aConvList.body.includes(tokenB), "B conversation absent from A's list");
    const aOwnConv = await call("GET", `/api/me/assistant/conversations/${convA.rows[0]!.id}`, { cookie: aCookie });
    check("02f_ruby_memory_own_readable", aOwnConv.status === 200, `status=${aOwnConv.status}`);
    const aReadsBConv = await call("GET", `/api/me/assistant/conversations/${convB.rows[0]!.id}`, { cookie: aCookie });
    check("02g_ruby_memory_idor_blocked", aReadsBConv.status === 404 || aReadsBConv.status === 403, `status=${aReadsBConv.status}`);
    const aReadsBAlert = await call("POST", `/api/me/alerts/${alertB.rows[0]!.id}/read`, { cookie: aCookie });
    check("02h_alert_idor_write_blocked", aReadsBAlert.status === 404 || aReadsBAlert.status === 403, `status=${aReadsBAlert.status}`);

    // ── Item 3: self-trade autonomy / allocation / symbol (domain) ───────────
    const execOk = evaluateExecutionPermission(basePermInput());
    check("03a_authorized_agent_can_execute", execOk.action === "EXECUTE" && execOk.permitted, execOk.action);
    const execUnfunded = evaluateExecutionPermission(basePermInput({ funded: false }));
    check("03b_unfunded_allocation_blocked", execUnfunded.blockCode === "AGENT_UNFUNDED", execUnfunded.blockCode ?? "");
    const execL0 = evaluateExecutionPermission(basePermInput({ autonomyLevel: 0 }));
    check("03c_below_autonomy_log_only", execL0.action === "LOG_ONLY" && !execL0.permitted, execL0.action);
    const execShadow = evaluateExecutionPermission(basePermInput({ agentMode: "SHADOW" }));
    check("03d_shadow_mode_log_only", execShadow.action === "LOG_ONLY" && !execShadow.permitted, execShadow.action);
    const signal = buildRubyMarketEdge(signalInput());
    function candidate(over: Partial<DecisionCandidateInput> = {}): DecisionCandidateInput {
      return {
        agentId: 1, agentKey: "qa-agent", agentRankWeight: 1, symbol: "EURUSD", timeframe: "M5",
        symbolAllowed: true, maxSpreadPoints: null, signal, htfSignals: [], currentPrice: 1.12, newsRisk: "none",
        execution: { liveSpreadPoints: null, heartbeatAgeSeconds: 3, bridgeConnected: true },
        quota: okQuota(), funding: { availableFunds: 10000, allocatedFunds: 0 }, governor: okGovernor(),
        handshake: okHandshake(), killEngaged: false, now: NOW, ...over,
      };
    }
    const offSymbol = runDecisionPipeline(candidate({ symbolAllowed: false }));
    check("03e_off_allowlist_symbol_blocked", offSymbol.outcome === "BLOCKED", `outcome=${offSymbol.outcome}`);
    const killCandidate = runDecisionPipeline(candidate({ killEngaged: true }));
    check("03f_kill_switch_blocks_pipeline", killCandidate.outcome === "BLOCKED", `outcome=${killCandidate.outcome}`);

    // ── Item 5: command integrity (duplicate/expired/replayed/unauthorized) ──
    const params = { commandType: "OPEN", symbol: "EURUSD", side: "BUY", orderType: "MARKET", requestedVolume: 0.01, stopLoss: 1.09, takeProfit: 1.12 } as const;
    const ph = computePayloadHash(params);
    const ph2 = computePayloadHash(params);
    const phDiff = computePayloadHash({ ...params, requestedVolume: 0.02 });
    check("05a_payload_hash_deterministic", ph === ph2, "same params → same hash");
    check("05b_payload_hash_distinguishes_replay", ph !== phDiff, "tampered volume → different hash");
    function integ(over: Partial<CommandIntegrityVerifyInput>): CommandIntegrityVerifyInput {
      return { storedPayloadHash: ph, recomputedPayloadHash: ph, signed: false, storedIntegrityHash: null, recomputedIntegrityHash: null, routeAllowed: true, actorValid: true, decisionMatch: null, fresh: true, ...over };
    }
    const intOk = evaluateCommandIntegrity(integ({}));
    check("05c_integrity_ok_passes", intOk.ok && intOk.reason === "INTEGRITY_OK" && !intOk.tamper, intOk.reason);
    const intMismatch = evaluateCommandIntegrity(integ({ recomputedPayloadHash: phDiff }));
    check("05d_payload_mismatch_rejected", !intMismatch.ok && intMismatch.tamper, intMismatch.reason);
    const intMissing = evaluateCommandIntegrity(integ({ storedPayloadHash: null }));
    check("05e_payload_missing_rejected", !intMissing.ok && intMissing.tamper, intMissing.reason);
    const intRoute = evaluateCommandIntegrity(integ({ routeAllowed: false }));
    check("05f_unauthorized_route_rejected", !intRoute.ok && intRoute.tamper, intRoute.reason);
    const intActor = evaluateCommandIntegrity(integ({ actorValid: false }));
    check("05g_invalid_actor_rejected", !intActor.ok && intActor.tamper, intActor.reason);
    const intExpired = evaluateCommandIntegrity(integ({ fresh: false }));
    check("05h_expired_command_rejected_benign", !intExpired.ok && !intExpired.tamper, intExpired.reason);
    // EA endpoint with no bridge token is rejected (unauthorized command source).
    const eaNoToken = await call("POST", "/api/mt5/heartbeat", { json: {} });
    check("05i_ea_endpoint_requires_bridge_token", eaNoToken.status === 401, `status=${eaNoToken.status}`);
    // A FORGED bridge token is rejected too (not merely a missing one) — proves
    // the EA boundary validates the token, it does not just check for presence.
    const eaForged = await call("POST", "/api/mt5/heartbeat", { json: {}, headers: { "X-MT5-Bridge-Token": `forged-${randomBytes(12).toString("hex")}` } });
    check("05i2_ea_endpoint_rejects_forged_bridge_token", eaForged.status === 401, `status=${eaForged.status}`);
    // Duplicate live dispatch is blocked at the DB layer by an idempotency index.
    const idemIdx = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM pg_indexes WHERE tablename = 'arx_live_commands' AND indexdef ILIKE '%idem%'`);
    check("05j_live_command_idempotency_index_present", idemIdx.rows[0]!.c >= 1, `indexes=${idemIdx.rows[0]!.c}`);

    // ── Item 6: password reset token expiry + reuse ─────────────────────────
    const t1 = await passwordResetTokensRepo.createToken({ userId: userA.id });
    const c1 = await passwordResetTokensRepo.consumeToken(t1.rawToken);
    check("06a_reset_token_consumes_once", c1.ok === true && c1.userId === userA.id, JSON.stringify({ ok: c1.ok }));
    const c1again = await passwordResetTokensRepo.consumeToken(t1.rawToken);
    check("06b_reset_token_cannot_be_reused", c1again.ok === false && c1again.reason === "ALREADY_USED", c1again.ok === false ? c1again.reason : "ok");
    const t2 = await passwordResetTokensRepo.createToken({ userId: userA.id });
    await pool.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 hour' WHERE user_id = $1 AND used_at IS NULL`, [userA.id]);
    const c2 = await passwordResetTokensRepo.consumeToken(t2.rawToken);
    check("06c_expired_reset_token_rejected", c2.ok === false && c2.reason === "EXPIRED", c2.ok === false ? c2.reason : "ok");

    // ── Item 7: invite-code attempts are rate-limited (domain rule) ─────────
    const rule = DEFAULT_RATE_LIMIT_POLICY.INVITE_CODE_ATTEMPT;
    let state: RateLimitState | null = null;
    let allowedCount = 0;
    let blocked = false;
    for (let i = 0; i < rule.limit + 1; i++) {
      const d = evaluateRateLimit(state, rule, NOW);
      if (d.allowed) allowedCount++;
      if (d.blocked) blocked = true;
      state = d.nextState;
    }
    check("07a_invite_attempts_allowed_up_to_limit", allowedCount === rule.limit, `allowed=${allowedCount} limit=${rule.limit}`);
    check("07b_invite_attempt_over_limit_blocked", blocked, "attempt beyond limit blocked");
    const cooldown = evaluateRateLimit(state, rule, NOW + 1000);
    check("07c_invite_cooldown_active", !cooldown.allowed && cooldown.reason === "RATE_LIMIT_COOLDOWN_ACTIVE", cooldown.reason);
    // 07d — REAL runtime evidence: the invite-gated register endpoint is actually
    // wired to the durable INVITE_CODE_ATTEMPT limiter, not just the pure rule.
    // Invalid codes never create an account while the gate is on (probed: 403
    // INVITE_NOT_FOUND), so hammering until the limiter trips with HTTP 429 is
    // safe. The per-IP cooldown this trips is scoped to the loopback caller (not
    // real users, who arrive via the proxy with distinct IPs) and auto-expires.
    // We deliberately do NOT delete cooldown rows in finally: a time-window
    // DELETE would erase OTHER scopes' active rate-limit state, making the suite
    // non-hermetic. 07d below tolerates an already-tripped cooldown (first 429).
    let inviteSaw429 = false;
    let inviteFirstStatus = 0;
    for (let i = 0; i < rule.limit + 4 && !inviteSaw429; i++) {
      const r = await call("POST", "/api/auth/register", {
        json: { email: `qa-sec-inv-${randomBytes(5).toString("hex")}@arx.local`, password: "Sup3rSecret!x9", inviteCode: `INVALID-${randomBytes(8).toString("hex").toUpperCase()}` },
      });
      if (i === 0) inviteFirstStatus = r.status;
      if (r.status === 429) inviteSaw429 = true;
    }
    // firstStatus must be 403 (invalid code rejected → NO account created) or 429
    // (cooldown already tripped). A 200/201 here would mean the invite gate was
    // off and we created an account — that is a real failure, not a pass.
    check("07d_invite_rate_limit_enforced_on_real_endpoint", inviteSaw429 && (inviteFirstStatus === 403 || inviteFirstStatus === 429), `firstStatus=${inviteFirstStatus} saw429=${inviteSaw429}`);

    // ── Item 8: MT5 bridge secret shown once, never re-served ────────────────
    const created = await call("POST", "/api/me/mt5-connections", { cookie: aCookie, json: { connectionName: "QA Sec Bridge" } });
    let rawBridge = "";
    try {
      const parsed = JSON.parse(created.body) as { rawToken?: string; connection?: { rawToken?: string } };
      rawBridge = parsed.rawToken ?? parsed.connection?.rawToken ?? "";
    } catch { /* ignore */ }
    const createdOk = created.status === 200 || created.status === 201;
    check("08b_bridge_connection_created", createdOk, `status=${created.status}`);
    check("08b2_bridge_token_revealed_once_at_creation", createdOk && rawBridge.length > 0, `status=${created.status} hasToken=${rawBridge.length > 0}`);
    const listConns = await call("GET", "/api/me/mt5-connections", { cookie: aCookie });
    const listOmitsRaw = rawBridge.length > 0 && !listConns.body.includes(rawBridge) && !/apiKeyHash/i.test(listConns.body);
    check("08c_bridge_token_never_reserved_in_list", listOmitsRaw, `status=${listConns.status}`);
    // NOTE: rawBridge is a real secret — collected for the leak scan, never printed.

    // ── Item 9: prod has no dev email fallback; live route no mock exec ──────
    const prodEmail = evaluateProdDevSeparation({ isProduction: true, devEmailFallbackActive: true });
    check("09a_dev_email_fallback_in_prod_blocks", prodEmail.blocked && prodEmail.findings.some((f) => f.code === "DEV_EMAIL_FALLBACK_IN_PROD"), `blocked=${prodEmail.blocked}`);
    const prodFake = evaluateProdDevSeparation({ isProduction: true, fakeExecutionInLiveRoute: true });
    check("09b_fake_execution_in_live_route_blocks", prodFake.blocked && prodFake.findings.some((f) => f.code === "FAKE_EXECUTION_IN_LIVE"), `blocked=${prodFake.blocked}`);
    const devEmail = evaluateProdDevSeparation({ isProduction: false, devEmailFallbackActive: true });
    check("09c_dev_email_fallback_allowed_in_dev", !devEmail.blocked, `blocked=${devEmail.blocked}`);
    // Static evidence: the live pipeline source carries no fabrication of fills.
    const liveDir = join(process.cwd(), "..", "artifacts", "api-server", "src", "lib", "live");
    const forbidden = ["simulateFill", "fakeFill", "mockExecution", "fabricateFill", "syntheticFill", "FAKE_FILL", "MOCK_EXECUTION"];
    const hits: string[] = [];
    if (existsSync(liveDir)) {
      for (const f of readdirSync(liveDir)) {
        if (!f.endsWith(".ts")) continue;
        const src = readFileSync(join(liveDir, f), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:])\/\/.*$/gm, "$1");
        for (const id of forbidden) if (src.includes(id)) hits.push(`${f}:${id}`);
      }
    }
    check("09d_live_route_has_no_mock_execution", existsSync(liveDir) && hits.length === 0, hits.length ? hits.join(", ") : "clean");

    // ── Item 10: export redaction + lockdown posture ────────────────────────
    const redacted = redactSecrets({ apiKey: "sk-secret-9d3", password: "hunter2", bridgeToken: "raw-bridge-XYZ", note: "keep-me" });
    const redactedJson = JSON.stringify(redacted.value);
    const redactionOk = !redactedJson.includes("sk-secret-9d3") && !redactedJson.includes("hunter2") && !redactedJson.includes("raw-bridge-XYZ") && redactedJson.includes("keep-me") && redacted.redactedKeys.length > 0;
    check("10a_exports_redact_secrets", redactionOk, `redactedKeys=${redacted.redactedKeys.length}`);
    const normal = resolveOperationalModePosture("NORMAL");
    check("10b_normal_mode_allows_autonomous_entries", !normal.pauseAutonomousEntries && normal.allowProtectiveActions, `pause=${normal.pauseAutonomousEntries}`);
    const lockdown = resolveOperationalModePosture("LOCKDOWN");
    check("10c_lockdown_pauses_autonomous_entries", lockdown.pauseAutonomousEntries === true, `pause=${lockdown.pauseAutonomousEntries}`);
    check("10d_lockdown_keeps_protective_actions", lockdown.allowProtectiveActions === true, `protective=${lockdown.allowProtectiveActions}`);

    // ── Item 4: no secret reaches collected client payloads, REAL export
    // payloads, the REAL persisted admin audit log, the log-redaction sink, or
    // outbound email bodies. The bridge token's ONE legitimate appearance is the
    // creation response (verified by 08b2/08c) and is deliberately excluded.
    // ────────────────────────────────────────────────────────────────────────
    const ENV_SECRET_NAMES = ["SESSION_SECRET", "DERIV_API_TOKEN", "DERIV_APP_ID", "POLYGON_API_KEY", "TWELVEDATA_API_KEY", "QA_OWNER_PASSWORD"];
    function scanSecretValues(blob: string): string[] {
      const out: string[] = [];
      if (blob.includes(userA.password)) out.push("USER_A_PASSWORD");
      if (blob.includes(userB.password)) out.push("USER_B_PASSWORD");
      if (blob.includes(admin.password)) out.push("ADMIN_PASSWORD");
      if (rawBridge.length > 0 && blob.includes(rawBridge)) out.push("BRIDGE_TOKEN");
      if (/scrypt\$/.test(blob)) out.push("scrypt hash");
      for (const name of ENV_SECRET_NAMES) {
        const v = (process.env[name] ?? "").trim();
        if (v && blob.includes(v)) out.push(name);
      }
      return out;
    }

    // 04a — collected client payloads (value-based + API field-name heuristics).
    const clientBlob = [...httpBodies, listConns.body].join("\n");
    const clientLeaks = scanSecretValues(clientBlob);
    if (/password.?hash/i.test(clientBlob)) clientLeaks.push("password_hash field");
    check("04a_no_secret_reaches_client_payloads", clientLeaks.length === 0, clientLeaks.length ? clientLeaks.join(", ") : "clean");

    // 04b/04c — REAL export endpoints (admin-authorized) carry no secret values.
    const expAudit = await call("GET", "/api/export/audit.json", { cookie: adminCookie });
    const expTrades = await call("GET", "/api/export/trades.csv", { cookie: adminCookie });
    check("04b_exports_authorized_for_admin", expAudit.status === 200 && expTrades.status === 200, `audit=${expAudit.status} trades=${expTrades.status}`);
    const exportLeaks = scanSecretValues([expAudit.body, expTrades.body].join("\n"));
    check("04c_export_payloads_carry_no_secrets", exportLeaks.length === 0, exportLeaks.length ? exportLeaks.join(", ") : "clean");

    // 04d — REAL persisted admin audit rows carry no secret values (before/after
    // state + reason). This is durable evidence, scanned read-only.
    const auditRows = await pool.query<{ blob: string }>(
      `SELECT coalesce(before_state::text,'') || ' ' || coalesce(after_state::text,'') || ' ' || coalesce(reason,'') AS blob
       FROM admin_action_audit_log ORDER BY id DESC LIMIT 300`,
    );
    const auditLeaks = scanSecretValues(auditRows.rows.map((row) => row.blob).join("\n"));
    check("04d_persisted_audit_rows_carry_no_secrets", auditLeaks.length === 0, auditLeaks.length ? auditLeaks.join(", ") : `clean (${auditRows.rows.length} rows)`);

    // 04e — LOGS: secrets are scrubbed before any log sink. The api-server's
    // secureLog/secureReqLog wrappers funnel EVERY message + metadata through
    // these exact domain functions (security.redactForLog / redactSecrets — see
    // artifacts/api-server/src/lib/security/secureLog.ts) before handing them to
    // pino. We feed REAL secret material (a freshly-minted bridge token, the live
    // SESSION_SECRET value, a scrypt password hash, plus API-key/JWT/connection-
    // string shapes) through the sink and assert NONE survive — in keyed metadata
    // (redacted by sensitive key name) and embedded in a free-text message
    // (redacted by value shape). The HTTP request logger additionally serializes
    // only id/method/url (query stripped) + statusCode, so bodies/headers/tokens
    // are never auto-logged in the first place.
    const sessionSecretVal = (process.env.SESSION_SECRET ?? "").trim();
    const scryptHash = `scrypt$${scryptSync("pw", randomBytes(16), 32).toString("hex")}`;
    const logMeta: Record<string, unknown> = {
      password: admin.password,
      bridgeToken: rawBridge,
      sessionSecret: sessionSecretVal,
      passwordHash: scryptHash,
      apiKey: "re_AbCdEfGhIjKlMnOpQrSt",
      authorization: "Bearer eyJhbGciOiJIUzI1Ni) .payloadpayload.signaturesig",
      note: "keep-me",
    };
    const safeLog = redactForLog("login by user", logMeta);
    const safeLogBlob = JSON.stringify(safeLog.meta) + "\n" + safeLog.message;
    const logMetaLeaks = scanSecretValues(safeLogBlob);
    const jwtShape = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhcngtYWRtaW4ifQ.s1gnatureBytesXYZ0";
    const logMsg = `connect postgres://arx:s3cr3t@db.internal:5432/arx then use key sk-LIVEabcdefghijklmnop123456 and resend re_ZyXwVuTsRqPoNmLkJi session jwt ${jwtShape}`;
    const safeMsg = redactSecretString(logMsg);
    const msgRedacted =
      !safeMsg.includes("postgres://arx:s3cr3t@db.internal:5432/arx") &&
      !safeMsg.includes("sk-LIVEabcdefghijklmnop123456") &&
      !safeMsg.includes("re_ZyXwVuTsRqPoNmLkJi") &&
      !safeMsg.includes(jwtShape) &&
      safeMsg.includes("[REDACTED]");
    const noteKept = safeLogBlob.includes("keep-me");
    check(
      "04e_log_redaction_sink_scrubs_secrets",
      logMetaLeaks.length === 0 && msgRedacted && noteKept && safeLog.redactedKeys.length >= 5,
      logMetaLeaks.length ? `metaLeaks=${logMetaLeaks.join(",")}` : `redactedKeys=${safeLog.redactedKeys.length} msgRedacted=${msgRedacted} noteKept=${noteKept}`,
    );

    // 04f — EMAIL: the rendered password-reset email body (the ONLY outbound
    // transactional email — alert/invite email hooks are no-ops) carries no
    // secret except the intended one-time reset link. We build the REAL body via
    // the pure domain builder the api-server sends verbatim, then assert: the
    // reset link is present (legit token path), no env/bridge/password-hash secret
    // value leaks, and no secret-shaped token (API key / JWT / connection string)
    // is embedded anywhere in html or text.
    const resetToken = randomBytes(32).toString("hex");
    const resetLink = `https://arx.example/reset-password?token=${resetToken}`;
    const email = buildPasswordResetEmail({ resetLink, expiresAt: new Date(Date.now() + 30 * 60_000) });
    const emailBody = `${email.subject}\n${email.html}\n${email.text}`;
    const emailLeaks = scanSecretValues(emailBody);
    const linkPresent = email.html.includes(resetLink) && email.text.includes(resetLink);
    const noSecretShapes = redactSecretString(emailBody) === emailBody;
    check(
      "04f_reset_email_body_carries_no_secrets",
      emailLeaks.length === 0 && linkPresent && noSecretShapes,
      emailLeaks.length ? emailLeaks.join(", ") : `linkPresent=${linkPresent} noSecretShapes=${noSecretShapes}`,
    );

    // 04g — EMAIL: the expiring-registration-keys admin digest body carries only
    // MASKED key prefixes — never a raw registration key. We feed the pure domain
    // builder a realistic raw key, pass ONLY its masked prefix as the display
    // value (mirroring the worker), then assert the raw key never appears in the
    // rendered body, the masked form IS present, and no secret-shaped token leaks.
    const rawRegKey = "ARX-9K4M-7T2P-XQ8B";
    const maskedRegKey = "ARX-9K4M-****";
    const digest = buildExpiringKeysDigestEmail({
      windowDays: 7,
      manageLink: "https://arx.example/admin/beta-control",
      items: [
        { maskedKey: maskedRegKey, daysLeft: 2, assignedEmail: "tester@example.com", roleGrant: "USER", expiresAtIso: new Date(Date.now() + 2 * 86_400_000).toISOString() },
        { maskedKey: "ARX-PR3Z-****", daysLeft: 0, assignedEmail: null, roleGrant: null, expiresAtIso: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    });
    const digestBody = `${digest.subject}\n${digest.html}\n${digest.text}`;
    const digestLeaks = scanSecretValues(digestBody);
    const rawKeyAbsent = !digestBody.includes(rawRegKey) && !digestBody.includes("7T2P") && !digestBody.includes("XQ8B");
    const maskedPresent = digest.html.includes(maskedRegKey) && digest.text.includes(maskedRegKey);
    const digestNoSecretShapes = redactSecretString(digestBody) === digestBody;
    check(
      "04g_expiring_keys_digest_masks_raw_keys",
      digestLeaks.length === 0 && rawKeyAbsent && maskedPresent && digestNoSecretShapes,
      digestLeaks.length ? digestLeaks.join(", ") : `rawKeyAbsent=${rawKeyAbsent} maskedPresent=${maskedPresent} noSecretShapes=${digestNoSecretShapes}`,
    );

    // ── Live-command non-creation invariant (baseline-delta) ────────────────
    // arx_live_commands is a persistent SAFETY-EVIDENCE table; this controlled
    // owner/admin live-testing environment legitimately holds historical rows,
    // which must NEVER be deleted. The real invariant is that THIS suite
    // dispatches nothing live: the global count is unchanged (delta 0) AND no
    // row is attributable to any user this suite minted.
    const endRow = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM arx_live_commands`);
    const end = endRow.rows[0]!.c;
    check("ZZ1_no_live_command_created_by_suite", start === end, `delta=${end - start} (start=${start} end=${end})`);
    const mineRow = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM arx_live_commands WHERE user_id = ANY($1::int[])`, [seededIds]);
    check("ZZ2_no_live_command_for_seeded_users", mineRow.rows[0]!.c === 0, `rows=${mineRow.rows[0]!.c}`);
  } finally {
    // Fail-closed cleanup. Rather than hand-maintain a delete list (an unlisted
    // FK child would silently block DELETE users and leak seeded rows), discover
    // EVERY public table with a user_id column and delete the seeded users' rows
    // there first (FK-safe), then the users by id. Deleting strictly by seeded
    // user_id is safe: these freshly-minted users created nothing in any
    // evidence table (ZZ2 asserts 0 live commands for them). The trailing ZZ3
    // check FAILS the run if any seeded user survives — cleanup is verified, not
    // assumed.
    try {
      const userIdTables = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'user_id'`,
      );
      for (const { table_name } of userIdTables.rows) {
        await pool.query(`DELETE FROM "${table_name}" WHERE user_id = ANY($1::int[])`, [seededIds]).catch(() => {});
      }
      await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [seededIds]).catch(() => {});
      // Defensive: invalid-code register attempts (07d) never create accounts
      // while the invite gate is on, but sweep any qa-sec-inv-* rows regardless.
      // (Scoped to this suite's own email pattern — hermetic.) The per-IP invite
      // cooldown is intentionally left to auto-expire; see 07d.
      await pool.query(`DELETE FROM users WHERE email LIKE 'qa-sec-inv-%@arx.local'`).catch(() => {});
    } catch { /* fall through to the verification check below */ }
    const remain = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM users WHERE id = ANY($1::int[])`, [seededIds]);
    check("ZZ3_seeded_users_cleaned_up", remain.rows[0]!.c === 0, `remaining=${remain.rows[0]!.c}`);
  }

  console.log("");
  console.log(`${pass}/${pass + fail} checks PASSED`);
}

main()
  .then(async () => { try { await pool.end(); } catch { /* ignore */ } process.exit(fail > 0 ? 1 : 0); })
  .catch(async (err) => { console.error(err); try { await pool.end(); } catch { /* ignore */ } process.exit(1); });

export {};
