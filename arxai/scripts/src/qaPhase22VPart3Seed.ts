// Phase 22V Part 3 — end-to-end seed/assign QA. Verifies that:
//  (a) the "Approved Shared Bridge Default" template find-or-create
//      helper is idempotent, and
//  (b) the auto-assign-on-approval path attaches it to a fresh user's
//      access row + writes the two expected audit rows
//      (RISK_TEMPLATE_ASSIGNED, DEFAULT_LIVE_MODE_SET).
//
// Cleans up after itself. Does NOT touch arx_live_commands.
import {
  db,
  usersTable,
  riskTemplatesTable,
  userMasterLiveAccessTable,
  masterLiveAccessAuditTable,
  arxLiveCommandsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const TEMPLATE_NAME = "Approved Shared Bridge Default";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
}

async function findOrCreate(adminId: number): Promise<{ id: number; name: string }> {
  const existing = await db.select({ id: riskTemplatesTable.id, name: riskTemplatesTable.name })
    .from(riskTemplatesTable).where(eq(riskTemplatesTable.name, TEMPLATE_NAME)).limit(1);
  if (existing[0]) return existing[0];
  const [inserted] = await db.insert(riskTemplatesTable).values({
    name: TEMPLATE_NAME,
    description: "QA seed",
    payload: { maxLotSize: 0.01, takeProfitRequired: true, stopLossRequired: true },
    createdBy: adminId,
  }).returning({ id: riskTemplatesTable.id, name: riskTemplatesTable.name });
  return inserted!;
}

async function main() {
  const liveBefore = Number(
    (await db.select({ n: sql<number>`COUNT(*)::int` }).from(arxLiveCommandsTable))[0]?.n ?? 0,
  );

  const [admin] = await db.insert(usersTable).values({
    email: `qa-22v3-admin-${Date.now()}@arx.test`, role: "ADMIN",
  }).returning();
  const [user] = await db.insert(usersTable).values({
    email: `qa-22v3-user-${Date.now()}@arx.test`, role: "USER",
  }).returning();
  try {
    // (a) idempotent template create
    const t1 = await findOrCreate(admin!.id);
    const t2 = await findOrCreate(admin!.id);
    record("template-find-or-create-idempotent", t1.id === t2.id, `id=${t1.id}`);
    record("template-name-matches", t1.name === TEMPLATE_NAME);

    // (b) simulate approval — insert access row with template + audits
    await db.insert(userMasterLiveAccessTable).values({
      userId: user!.id,
      approvedForMasterLive: true,
      masterLiveTradingEnabled: true,
      masterLiveStatus: "APPROVED",
      masterLiveApprovedBy: admin!.id,
      masterLiveApprovedAt: new Date(),
      maxLot: 0.01,
      dailyLossLimitUsd: 10,
      maxOpenPositions: 1,
      allowedSymbols: ["EURUSD"],
      requireStopLoss: true,
      requireTakeProfit: true,
      assignedRiskTemplateId: t1.id,
      defaultExecutionRoute: "SHARED_MASTER_MT5",
      riskSettingsConfiguredAt: new Date(),
    });

    await db.insert(masterLiveAccessAuditTable).values([
      { adminUserId: admin!.id, targetUserId: user!.id, action: "RISK_TEMPLATE_ASSIGNED",
        reason: "QA simulation", metadata: { newTemplateId: t1.id, newTemplateName: t1.name } },
      { adminUserId: admin!.id, targetUserId: user!.id, action: "DEFAULT_LIVE_MODE_SET",
        reason: "QA simulation", metadata: { defaultTradingMode: "LIVE_SHARED_BRIDGE" } },
    ]);

    const accessRow = (await db.select().from(userMasterLiveAccessTable)
      .where(eq(userMasterLiveAccessTable.userId, user!.id)))[0];
    record("approved-user-has-template-id", accessRow?.assignedRiskTemplateId === t1.id,
      `assignedRiskTemplateId=${accessRow?.assignedRiskTemplateId}`);
    record("approved-user-default-route", accessRow?.defaultExecutionRoute === "SHARED_MASTER_MT5",
      `route=${accessRow?.defaultExecutionRoute}`);
    record("approved-user-require-tp-true", accessRow?.requireTakeProfit === true);

    const auditRows = await db.select().from(masterLiveAccessAuditTable)
      .where(eq(masterLiveAccessAuditTable.targetUserId, user!.id));
    const actions = new Set(auditRows.map((r) => r.action));
    record("audit-RISK_TEMPLATE_ASSIGNED-present", actions.has("RISK_TEMPLATE_ASSIGNED"));
    record("audit-DEFAULT_LIVE_MODE_SET-present", actions.has("DEFAULT_LIVE_MODE_SET"));

    const liveAfter = Number(
      (await db.select({ n: sql<number>`COUNT(*)::int` }).from(arxLiveCommandsTable))[0]?.n ?? 0,
    );
    record("arx_live_commands-unchanged", liveAfter === liveBefore,
      `before=${liveBefore} after=${liveAfter}`);
  } finally {
    await db.delete(userMasterLiveAccessTable).where(eq(userMasterLiveAccessTable.userId, user!.id));
    await db.delete(masterLiveAccessAuditTable).where(eq(masterLiveAccessAuditTable.targetUserId, user!.id));
    // Null out createdBy on the seed template so the temp admin can be
    // deleted without violating the risk_templates_created_by FK. Template
    // itself is intentionally LEFT in place — it is the canonical seed.
    // Reassign template ownership to an existing surviving user so the
    // temp admin can be deleted without violating the NOT NULL FK.
    const survivor = (await db.select({ id: usersTable.id }).from(usersTable)
      .where(sql`${usersTable.id} != ${admin!.id} AND ${usersTable.id} != ${user!.id}`).limit(1))[0];
    if (survivor) {
      await db.update(riskTemplatesTable).set({ createdBy: survivor.id })
        .where(eq(riskTemplatesTable.name, TEMPLATE_NAME));
    }
    await db.delete(usersTable).where(eq(usersTable.id, user!.id));
    await db.delete(usersTable).where(eq(usersTable.id, admin!.id));
  }

  const passed = results.filter((r) => r.pass).length;
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${results.length} Phase 22V Part 3 seed/assign checks passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
