// Phase 22V Part 4 — regression test for the
// "approved but BLOCKED (toggle off / disclosure missing)" UX surface on
// GET /api/me/master-live/access.
//
// Before Part 4 the response would fall back to defaultTradingMode="PAPER"
// and riskTemplateName=null until the user passed the full 16-gate
// evaluation. After Part 4 these surface as soon as the user is
// admin-approved, while blockReasons still tells the UI what is pending.
//
// Hits the RUNNING API server through the shared proxy at localhost:80.
// Does NOT touch arx_live_commands.
import { db, usersTable, riskTemplatesTable, userMasterLiveAccessTable, masterLiveAccessAuditTable, arxLiveCommandsTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { hashPassword } from "../../artifacts/api-server/src/lib/auth/password";

const TEMPLATE_NAME = "Approved Shared Bridge Default";
const BASE = "http://localhost:80";
const PASSWORD = "Phase22V4ApprovedBlocked!";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
}

function parseSetCookie(setCookie: string[] | string | null): string {
  const arr = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return arr.map((c) => c.split(";")[0]).join("; ");
}

async function main() {
  const liveBefore = Number(
    (await db.select({ n: sql<number>`COUNT(*)::int` }).from(arxLiveCommandsTable))[0]?.n ?? 0,
  );

  let tpl = (await db.select({ id: riskTemplatesTable.id, name: riskTemplatesTable.name })
    .from(riskTemplatesTable).where(eq(riskTemplatesTable.name, TEMPLATE_NAME)).limit(1))[0];
  if (!tpl) {
    const survivor = (await db.select({ id: usersTable.id }).from(usersTable).limit(1))[0];
    if (!survivor) throw new Error("no surviving user to own template");
    const [t] = await db.insert(riskTemplatesTable).values({
      name: TEMPLATE_NAME, description: "QA seed",
      payload: { maxLotSize: 0.01, takeProfitRequired: true, stopLossRequired: true },
      createdBy: survivor.id,
    }).returning({ id: riskTemplatesTable.id, name: riskTemplatesTable.name });
    tpl = t!;
  }

  const email = `qa-22v4-blocked-${Date.now()}@arx.test`;
  const [user] = await db.insert(usersTable).values({
    email, role: "USER", passwordHash: hashPassword(PASSWORD), name: "QA Blocked",
  }).returning();

  try {
    await db.insert(userMasterLiveAccessTable).values({
      userId: user!.id,
      approvedForMasterLive: true,
      masterLiveTradingEnabled: false,     // <-- toggle OFF
      masterLiveStatus: "APPROVED",
      maxLot: 0.01,
      dailyLossLimitUsd: 10,
      maxOpenPositions: 1,
      allowedSymbols: ["EURUSD"],
      requireStopLoss: true,
      requireTakeProfit: true,
      assignedRiskTemplateId: tpl.id,
      defaultExecutionRoute: "SHARED_MASTER_MT5",
      // riskDisclosureAcceptedAt left null -> USER_MISSING_RISK_DISCLOSURE
      riskSettingsConfiguredAt: new Date(),
    });

    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    record("login-200", loginRes.status === 200, `got ${loginRes.status}`);
    const cookie = parseSetCookie(loginRes.headers.getSetCookie?.() ?? loginRes.headers.get("set-cookie"));

    const accessRes = await fetch(`${BASE}/api/me/master-live/access`, {
      headers: { Cookie: cookie },
    });
    record("access-200", accessRes.status === 200, `got ${accessRes.status}`);
    const body = await accessRes.json() as Record<string, unknown> & {
      blockReasons?: string[];
    };

    record("ok-true", body.ok === true);
    record("status-APPROVED", body.status === "APPROVED", `got ${body.status}`);
    record("canTrade-false", body.canTrade === false);
    record("defaultTradingMode-LIVE_SHARED_BRIDGE",
      body.defaultTradingMode === "LIVE_SHARED_BRIDGE",
      `got ${body.defaultTradingMode}`);
    record("riskTemplateName-friendly",
      body.riskTemplateName === TEMPLATE_NAME,
      `got ${body.riskTemplateName}`);
    record("blockReasons-contains-toggle-off",
      Array.isArray(body.blockReasons)
        && body.blockReasons.includes("USER_MASTER_LIVE_TOGGLE_OFF"),
      `got ${JSON.stringify(body.blockReasons)}`);
    const bodyStr = JSON.stringify(body);
    record("no-raw-env-leak",
      !bodyStr.includes("ARX_LIVE_BROKER_EXECUTION_ENABLED")
      && !bodyStr.includes("MT5_BRIDGE_TOKEN"));

    const liveAfter = Number(
      (await db.select({ n: sql<number>`COUNT(*)::int` }).from(arxLiveCommandsTable))[0]?.n ?? 0,
    );
    record("arx_live_commands-unchanged", liveAfter === liveBefore,
      `before=${liveBefore} after=${liveAfter}`);
  } finally {
    await db.delete(userMasterLiveAccessTable).where(eq(userMasterLiveAccessTable.userId, user!.id));
    await db.delete(masterLiveAccessAuditTable).where(eq(masterLiveAccessAuditTable.targetUserId, user!.id));
    await db.delete(usersTable).where(inArray(usersTable.id, [user!.id]));
  }

  const passed = results.filter((x) => x.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${results.length} approved-blocked surface checks passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
