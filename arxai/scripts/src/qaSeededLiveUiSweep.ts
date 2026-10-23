// Seeded E2E harness for the LIVE_SHARED-mode UI sweep.
//
// Two modes (positional arg):
//   seed     — create tagged ADMIN + USER, attach USER to an existing
//              shared_master_accounts row via a SHARED_MASTER_MT5 VTA,
//              insert per-user LIVE arming + permission + master-live
//              approval rows so the /api/me/account-mode resolver returns
//              currentAccountMode="LIVE_SHARED", mint 1-hour sessions,
//              print cookies as JSON, persist baseline to
//              /tmp/qa-seed-dom-baseline.json.
//   cleanup  — delete every row tagged with the qaSDOM_ prefix (including
//              arming/permission/master-live-access rows for those user
//              ids), then re-verify arx_live_commands count is identical
//              to the persisted baseline.
//
// SAFETY (inviolable, enforced by hard env guard before any DB write):
//   * NODE_ENV !== "production"
//   * REPLIT_DEPLOYMENT not set
//   * QA_BASE_URL is not a *.replit.app deployment
//   * QA_ALLOW_DB_MUTATION === "true" (literal)
//   * No arx_live_commands ever inserted. Baseline persisted at seed
//     time; cleanup fails if the count differs.
//   * Cleanup is tag-scoped (escaped LIKE so '_' is literal). NEVER
//     deletes rows by user_id alone.
//   * Does NOT touch global_trading_settings (no cross-user blast).
//   * Does NOT flip ARX_LIVE_BROKER_EXECUTION_ENABLED env. The resolver
//     still classifies the user as LIVE_SHARED with cleanBlockedReason
//     attached — that is the exact state the sweep verifies.

import { randomBytes, createHash, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  userSlotAllocationTable,
  virtualTradingAccountsTable,
  sharedMasterAccountsTable,
  userTradingPermissionsTable,
  userMasterLiveAccessTable,
  arxLiveArmingTable,
} from "@workspace/db";

const BASE = process.env.QA_BASE_URL ?? "http://localhost:80";
const MODE = (process.argv[2] ?? "seed").toLowerCase();
const TAG_PREFIX = "qaSDOM_";
const SESSION_TTL_MS = 60 * 60 * 1000;
const BASELINE_FILE = "/tmp/qa-seed-dom-baseline.json";

function refuseIfUnsafe(): void {
  if (process.env.NODE_ENV === "production") {
    console.error(JSON.stringify({ ok: false, refused: "NODE_ENV_PRODUCTION" }));
    process.exit(2);
  }
  if (process.env.REPLIT_DEPLOYMENT) {
    console.error(JSON.stringify({ ok: false, refused: "REPLIT_DEPLOYMENT_DETECTED" }));
    process.exit(2);
  }
  if (/\.replit\.app/i.test(BASE)) {
    console.error(JSON.stringify({ ok: false, refused: "PROD_LIKE_URL", base: BASE }));
    process.exit(2);
  }
  if (process.env.QA_ALLOW_DB_MUTATION !== "true") {
    console.error(JSON.stringify({ ok: false, refused: "QA_ALLOW_DB_MUTATION_NOT_SET" }));
    process.exit(2);
  }
}

async function liveCmdsCount(): Promise<number> {
  const r = await db.execute(sql`SELECT COUNT(*)::int AS c FROM arx_live_commands`);
  return Number((r.rows[0] as { c: number }).c);
}

async function mkSession(userId: number): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  await db.insert(authUserSessionsTable).values({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ipAddress: "127.0.0.1",
    userAgent: "qa-seeded-dom-sweep",
  });
  return raw;
}

// Mirrors artifacts/api-server/src/lib/auth/password.ts hashPassword() format
// (`scrypt$N$r$p$saltB64$hashB64`). Replicated here because scripts/ cannot
// import an artifact's internals. verifyPassword() reads N/r/p back out of the
// stored string, so the REAL /auth/login path verifies these hashes natively.
// Used ONLY to give freshly-created, randomly-named, isolated QA test users a
// known password so the LIVE-authorized browser timing harness can sign in via
// the real login flow — this is NOT an auth bypass.
function hashTestPassword(plain: string): string {
  const N = 65536, r = 8, p = 1, KEYLEN = 64;
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function newTestPassword(): string {
  return `QaLive!${randomBytes(12).toString("base64url")}`;
}

// Escape LIKE wildcards (\ % _) in a literal so it matches verbatim. The tag
// prefix ends in "_", which is a LIKE single-char wildcard — without escaping
// it the cleanup glob required two underscores and silently matched nothing.
function escapeLikeLiteral(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

async function seed(): Promise<void> {
  refuseIfUnsafe();
  const liveCmdsBefore = await liveCmdsCount();

  const tag = `${TAG_PREFIX}${Date.now()}_${randomBytes(3).toString("hex")}`;
  // Emails are stored lowercased to match the real /auth/login path, which
  // lowercases the submitted email before lookup — otherwise the mixed-case
  // TAG_PREFIX ("qaSDOM_") would never match a login attempt.
  const emailTag = tag.toLowerCase();

  const sma = await db
    .select({ id: sharedMasterAccountsTable.id })
    .from(sharedMasterAccountsTable)
    .where(eq(sharedMasterAccountsTable.isActive, true))
    .limit(1);
  const smaId = sma[0]?.id ?? null;
  if (smaId === null) {
    console.error(JSON.stringify({ ok: false, refused: "NO_ACTIVE_SHARED_MASTER" }));
    process.exit(2);
  }

  const adminPassword = newTestPassword();
  const userPassword = newTestPassword();

  const [admin] = await db
    .insert(usersTable)
    .values({
      email: `${emailTag}_admin@arx.test`,
      name: `${tag} admin`,
      role: "ADMIN",
      passwordHash: hashTestPassword(adminPassword),
    })
    .returning();

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `${emailTag}_user@arx.test`,
      name: `${tag} user`,
      role: "USER",
      passwordHash: hashTestPassword(userPassword),
    })
    .returning();

  const [vta] = await db
    .insert(virtualTradingAccountsTable)
    .values({
      userId: user.id,
      // LIVE-authorized QA fixture: the virtual account must be a LIVE account so
      // the seeded user is genuinely live-routable. routingResolver + tradeAction
      // guards BLOCK a LIVE request whenever accountType !== "live", and the user
      // readiness engine treats live-ready as accountType === "live". A "demo"
      // value here would mislabel the fixture and contradict the LIVE-only QA
      // posture. (No safety surface is weakened — the 16 live gates, kill switch,
      // allocation, freeze, per-user approval, and MT5 confirmation all still run.)
      accountType: "live",
      routingMode: "SHARED_MASTER_MT5",
      sharedMasterAccountId: smaId,
      status: "active",
      virtualBalance: 10000,
      virtualEquity: 10000,
      virtualPnl: 0,
    })
    .returning();
  const vtaId = vta.id;

  await db.insert(userSlotAllocationTable).values({
    userId: user.id,
    allocatedFunds: 1000,
    manualAllocatedFunds: 800,
    aiAllocatedFunds: 200,
    accountCurrency: "USD",
    isActive: true,
    allocationStatus: "active",
    aiAutoTradingEnabled: false,
    aiStrategyMode: "watch_only",
    assignedByUserId: admin.id,
  });

  // ── LIVE_SHARED arming (per-user only; does NOT touch global rows) ──
  await db.insert(userTradingPermissionsTable).values({
    userId: user.id,
    tradingMode: "LIVE",
    demoEnabled: true,
    liveApproved: true,
    liveEnabled: true,
    riskDisclosureAcceptedAt: new Date(),
    suspended: false,
    accountRoutingOverride: "shared_master_mt5",
    updatedByAdminId: admin.id,
  });

  await db.insert(userMasterLiveAccessTable).values({
    userId: user.id,
    approvedForMasterLive: true,
    masterLiveTradingEnabled: true,
    masterLiveApprovedBy: admin.id,
    masterLiveApprovedAt: new Date(),
    masterLiveStatus: "APPROVED",
    riskDisclosureAcceptedAt: new Date(),
    riskSettingsConfiguredAt: new Date(),
    allowedSymbols: ["EURUSD"],
    maxLot: 0.01,
    dailyLossLimitUsd: 100,
    maxOpenPositions: 1,
    maxExposurePerSymbolLots: 0.01,
    requireStopLoss: true,
    requireTakeProfit: true,
    scannerLiveEnabled: false,
  });

  await db.insert(arxLiveArmingTable).values({
    userId: user.id,
    isArmed: true,
    armedAt: new Date(),
    armedByUserId: admin.id,
    armedFromIp: "127.0.0.1",
    killSwitchAcknowledged: true,
    killSwitchEngaged: false,
    lastReadinessCheckAt: new Date(),
    lastReadinessSnapshot: { source: "qaSeededDomSweep" },
  });

  const adminCookie = await mkSession(admin.id);
  const userCookie = await mkSession(user.id);

  const liveCmdsAfterSeed = await liveCmdsCount();
  const seedDelta = liveCmdsAfterSeed - liveCmdsBefore;
  if (seedDelta !== 0) {
    console.error(JSON.stringify({
      ok: false,
      refused: "INVARIANT_VIOLATED_DURING_SEED",
      liveCmdsBefore,
      liveCmdsAfterSeed,
    }));
    process.exit(1);
  }

  writeFileSync(BASELINE_FILE, JSON.stringify({
    tag,
    liveCmdsBefore,
    liveCmdsAfterSeed,
    seedAt: new Date().toISOString(),
  }, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        tag,
        adminId: admin.id,
        userId: user.id,
        smaId,
        vtaId,
        adminEmail: admin.email,
        adminPassword,
        userEmail: user.email,
        userPassword,
        adminCookie,
        userCookie,
        liveCmdsBefore,
        liveCmdsAfterSeed,
        baselineFile: BASELINE_FILE,
        base: BASE,
        note: "Run `pnpm --filter @workspace/scripts run qa:seed-dom:cleanup` after testing.",
      },
      null,
      2,
    ),
  );
}

async function cleanup(): Promise<void> {
  refuseIfUnsafe();
  const liveCmdsNow = await liveCmdsCount();

  let persistedBaseline: number | null = null;
  if (existsSync(BASELINE_FILE)) {
    try {
      const j = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
      persistedBaseline = typeof j.liveCmdsBefore === "number" ? j.liveCmdsBefore : null;
    } catch {
      // ignore — treat as no baseline
    }
  }

  // Match every harness-created user: <TAG_PREFIX><tag>_(admin|user)@arx.test.
  // TAG_PREFIX ends in "_" (a LIKE wildcard) so it MUST be escaped, otherwise
  // the glob requires two underscores and silently matches nothing — which is
  // exactly why historical qaSDOM_ rows accumulated.
  // ILIKE (case-insensitive) so we catch BOTH legacy mixed-case rows and the
  // new lowercased emails. Pattern lowercased + escaped (TAG_PREFIX ends in "_").
  const likePattern = `${escapeLikeLiteral(TAG_PREFIX.toLowerCase())}%@arx.test`;
  const orphans = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(sql`${usersTable.email} ILIKE ${likePattern} ESCAPE '\\'`);
  const ids = orphans.map((u) => u.id);
  // Dry-run-style visibility BEFORE any delete (stderr keeps stdout JSON clean).
  console.error(JSON.stringify({
    stage: "cleanup-preview",
    likePattern,
    matchedUsers: ids.length,
    sampleEmails: orphans.slice(0, 8).map((o) => o.email),
  }));

  // Child-row cleanup is DYNAMIC. Real browser QA (opening the trade modal,
  // Ruby, navigating) writes rows into many per-user tables beyond the seed's
  // own inserts (e.g. user_one_click_settings). A hardcoded child list silently
  // rots, and the final `DELETE users` then fails on an unexpected FK. So we
  // discover EVERY public table that has a `user_id` column and delete the test
  // users' rows from each — except an audit/evidence denylist that must never be
  // auto-deleted. arx_live_commands is the load-bearing invariant: it HAS a
  // user_id column but seeded test users never write to it (seedDelta === 0), so
  // excluding it is both safe and required. Deletes run in retry passes so
  // inter-child FKs (e.g. assistant messages → conversations) resolve regardless
  // of discovery order. No safety surface is touched — these are test users only.
  const AUDIT_DENYLIST = new Set<string>([
    "arx_live_commands",
    "arx_live_positions",
    "arx_live_test_cycles",
    "trade_command_audit_log",
    "one_click_audit",
    "security_access_logs",
    "broker_health_logs",
    "user_readiness_audit",
    "ai_decision_log",
    "learning_events",
    "execution_confirmations",
  ]);
  // Belt-and-suspenders beyond the explicit denylist: protect any table whose NAME
  // matches trading-safety evidence patterns, so a future/renamed evidence table is
  // preserved by DEFAULT rather than silently purged. Over-protecting an empty table
  // is a harmless no-op (no rows → nothing to delete → no FK block); the only failure
  // mode is a protected table that actually holds test rows, which we treat as
  // fail-closed (abort, never auto-delete evidence) below.
  const EVIDENCE_PATTERN =
    /(^|_)(audit|log|logs|event|events|command|commands|position|positions|decision|decisions|violation|violations|disclosure|acceptance|acceptances|reservation|reservations)(_|$)/;
  // Known benign, high-volume UI tables that EVERY logged-in QA user writes. These
  // match the evidence pattern by name only; they are not safety evidence, so they
  // are explicitly approved for purge or cleanup of a normal QA user could never
  // complete.
  const PURGE_APPROVED_DESPITE_PATTERN = new Set<string>([
    "user_activity_events",
    "user_activity",
    "user_activity_timeline",
  ]);
  const isProtected = (t: string): boolean =>
    AUDIT_DENYLIST.has(t) ||
    (EVIDENCE_PATTERN.test(t) && !PURGE_APPROVED_DESPITE_PATTERN.has(t));
  // Every discovered name must be a plain SQL identifier before we interpolate it
  // (defence-in-depth even though the source is the trusted information_schema).
  const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

  const deletedByTable: Record<string, number> = {};
  let residualTables: string[] = [];
  if (ids.length > 0) {
    // Build an explicit parameterised IN-list. Interpolating a JS array directly
    // (e.g. ANY(${ids})) makes drizzle emit `($1, $2, ...)`, which is a row
    // expression — invalid for ANY and fragile for IN. sql.join is deterministic.
    const idList = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );

    const colsRes = await db.execute(
      sql`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id'`,
    );
    const allUserIdTables = (colsRes.rows as Array<{ table_name: string }>).map(
      (r) => r.table_name,
    );
    const unsafe = allUserIdTables.filter((t) => !SAFE_IDENT.test(t));
    if (unsafe.length > 0) {
      console.error(
        JSON.stringify({ ok: false, refused: "UNSAFE_TABLE_IDENTIFIER", unsafe }),
      );
      process.exit(2);
    }

    // Fail-CLOSED on evidence: if any protected table actually holds rows for the
    // test users, abort before deleting ANYTHING. Never auto-delete safety
    // evidence; never half-clean. The operator reviews and handles manually (or
    // adds a genuinely-benign table to PURGE_APPROVED_DESPITE_PATTERN).
    const protectedTables = allUserIdTables.filter(isProtected);
    const protectedWithTestRows: string[] = [];
    for (const t of protectedTables) {
      const c = await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM ${sql.raw(`"${t}"`)} WHERE user_id IN (${idList})`,
      );
      const n = Number((c.rows[0] as { c: number }).c);
      if (n > 0) protectedWithTestRows.push(`${t}(${n})`);
    }
    if (protectedWithTestRows.length > 0) {
      console.error(
        JSON.stringify({
          ok: false,
          refused: "PROTECTED_EVIDENCE_HAS_TEST_ROWS",
          protectedWithTestRows,
          hint: "These tables are treated as safety evidence and are never auto-deleted. Review and handle manually, or add a genuinely-benign table to PURGE_APPROVED_DESPITE_PATTERN.",
        }),
      );
      process.exit(1);
    }

    const userIdTables = allUserIdTables.filter((t) => !isProtected(t));
    let remaining = [...userIdTables];
    for (let pass = 0; pass < 8 && remaining.length > 0; pass++) {
      const next: string[] = [];
      for (const t of remaining) {
        try {
          const r = await db.execute(
            sql`DELETE FROM ${sql.raw(`"${t}"`)} WHERE user_id IN (${idList})`,
          );
          deletedByTable[t] =
            (deletedByTable[t] ?? 0) +
            ((r as unknown as { rowCount?: number }).rowCount ?? 0);
        } catch {
          // FK dependency not cleared yet — retry on a later pass.
          next.push(t);
        }
      }
      if (next.length === remaining.length) {
        // No progress this pass — stop and surface the residue.
        remaining = next;
        break;
      }
      remaining = next;
    }
    residualTables = remaining;
    if (residualTables.length > 0) {
      console.error(
        JSON.stringify({ stage: "cleanup-residual-tables", residualTables }),
      );
    }

    await db.execute(sql`DELETE FROM users WHERE id IN (${idList})`);
  }

  const liveCmdsAfter = await liveCmdsCount();
  const baselineForCompare = persistedBaseline ?? liveCmdsNow;
  const invariantOk = liveCmdsAfter === baselineForCompare;

  const cleanupComplete = residualTables.length === 0;
  console.log(
    JSON.stringify({
      ok: invariantOk && cleanupComplete,
      deletedUsers: ids.length,
      deletedByTable,
      residualTables,
      persistedBaseline,
      liveCmdsBeforeCleanup: liveCmdsNow,
      liveCmdsAfter,
    }),
  );

  if (existsSync(BASELINE_FILE)) unlinkSync(BASELINE_FILE);

  if (!invariantOk) {
    console.error(
      `INVARIANT FAIL: arx_live_commands count changed during seeded sweep window. baseline=${baselineForCompare} after=${liveCmdsAfter}`,
    );
    process.exit(1);
  }
  if (!cleanupComplete) {
    console.error(
      `CLEANUP INCOMPLETE: residual user_id tables blocked deletion: ${residualTables.join(", ")}`,
    );
    process.exit(1);
  }
}

(async () => {
  if (MODE === "cleanup") await cleanup();
  else if (MODE === "seed") await seed();
  else {
    console.error(`Unknown mode: ${MODE}. Use 'seed' or 'cleanup'.`);
    process.exit(2);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
