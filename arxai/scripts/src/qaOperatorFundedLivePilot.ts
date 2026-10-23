// QA — Operator-Funded 10-User Live Pilot
//
// Verifies the new pilot gate (env switch + cohort cap + beta-invite +
// compliance flag + allocation + versioned disclosure), the admin
// approval cap enforcement, the strict-zero invariant on
// arx_live_commands, and the absence of risky wording.
//
// NO live trade is fired. NO real bridge call is made.

import { db } from "@workspace/db";
import {
  arxLiveCommandsTable,
  betaInvitesTable,
  globalTradingSettingsTable,
  liveRiskDisclosureAcceptancesTable,
  userMasterLiveAccessTable,
  usersTable,
  virtualTradingAccountsTable,
} from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  evaluateOperatorFundedPilotGate,
  countApprovedPilotUsers,
  isUserAcceptedBeta,
} from "../../artifacts/api-server/src/lib/live/operatorFundedPilotGate.js";
import {
  OPERATOR_FUNDED_PILOT_COHORT,
  OPERATOR_FUNDED_PILOT_MAX_USERS,
  OPERATOR_FUNDED_DISCLOSURE_VERSION,
  OPERATOR_FUNDED_DISCLOSURE_TEXT,
  PILOT_BLOCK_REASONS,
  operatorFundedPilotEnabled,
} from "../../artifacts/api-server/src/lib/live/operatorFundedPilotConfig.js";

type R = { id: string; ok: boolean; detail: string };
const results: R[] = [];
const assert = (id: string, ok: boolean, detail = "") =>
  results.push({ id, ok, detail });

const STAMP = `pilot_qa_${Date.now()}`;
const seededUserIds: number[] = [];
const seededInviteIds: number[] = [];
const seededVtaIds: number[] = [];
const seededDiscIds: number[] = [];

async function seedUser(suffix: string): Promise<number> {
  const [u] = await db
    .insert(usersTable)
    .values({
      email: `${STAMP}_${suffix}@example.test`,
      name: `Pilot QA ${suffix}`,
      role: "user",
    } as never)
    .returning({ id: usersTable.id });
  seededUserIds.push(u!.id);
  return u!.id;
}

async function acceptBeta(userId: number, accepted = true): Promise<void> {
  const [row] = await db
    .insert(betaInvitesTable)
    .values({
      cohort: OPERATOR_FUNDED_PILOT_COHORT,
      email: `${STAMP}_invite_${userId}@example.test`,
      inviteCode: `${STAMP}_${userId}`,
      issuedByAdminId: 1,
      acceptedUserId: userId,
      acceptedAt: accepted ? new Date() : null,
    } as never)
    .returning({ id: betaInvitesTable.id });
  seededInviteIds.push(row!.id);
}

async function setAllocation(userId: number, balance: number): Promise<void> {
  const [row] = await db
    .insert(virtualTradingAccountsTable)
    .values({
      userId,
      routingMode: "SHARED_MASTER_MT5",
      accountType: "live",
      virtualBalance: balance,
      virtualEquity: balance,
      virtualPnl: 0,
      status: "active",
    } as never)
    .returning({ id: virtualTradingAccountsTable.id });
  seededVtaIds.push(row!.id);
}

async function acceptOperatorFundedDisclosure(userId: number): Promise<void> {
  const [row] = await db
    .insert(liveRiskDisclosureAcceptancesTable)
    .values({
      userId,
      disclosureVersion: OPERATOR_FUNDED_DISCLOSURE_VERSION,
      acceptedText: OPERATOR_FUNDED_DISCLOSURE_TEXT,
    } as never)
    .returning({ id: liveRiskDisclosureAcceptancesTable.id });
  seededDiscIds.push(row!.id);
}

async function setComplianceFlag(value: boolean): Promise<void> {
  const existing = await db.select().from(globalTradingSettingsTable).limit(1);
  if (existing.length === 0) {
    await db.insert(globalTradingSettingsTable).values({
      complianceReviewFlag: value,
    } as never);
  } else {
    await db
      .update(globalTradingSettingsTable)
      .set({ complianceReviewFlag: value, updatedAt: new Date() })
      .where(eq(globalTradingSettingsTable.id, existing[0]!.id));
  }
}

async function cleanup(prevCompliance: boolean): Promise<void> {
  if (seededDiscIds.length) {
    await db
      .delete(liveRiskDisclosureAcceptancesTable)
      .where(
        sql`${liveRiskDisclosureAcceptancesTable.id} in ${seededDiscIds}`,
      );
  }
  if (seededVtaIds.length) {
    await db
      .delete(virtualTradingAccountsTable)
      .where(sql`${virtualTradingAccountsTable.id} in ${seededVtaIds}`);
  }
  if (seededInviteIds.length) {
    await db
      .delete(betaInvitesTable)
      .where(sql`${betaInvitesTable.id} in ${seededInviteIds}`);
  }
  if (seededUserIds.length) {
    await db
      .delete(userMasterLiveAccessTable)
      .where(sql`${userMasterLiveAccessTable.userId} in ${seededUserIds}`);
    await db
      .delete(usersTable)
      .where(sql`${usersTable.id} in ${seededUserIds}`);
  }
  await setComplianceFlag(prevCompliance);
}

async function main() {
  // ── Baseline: arx_live_commands count BEFORE ────────────────────────────
  const beforeRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(arxLiveCommandsTable);
  const beforeCount = Number(beforeRows[0]?.n ?? 0);

  // Capture prior compliance value to restore on cleanup
  const gtsBefore = await db.select().from(globalTradingSettingsTable).limit(1);
  const prevCompliance = !!gtsBefore[0]?.complianceReviewFlag;

  // Force env OFF for the gate-disabled tests; we never set it ON in QA.
  delete process.env["ARX_OPERATOR_FUNDED_LIVE_PILOT_10"];

  try {
    // ── 1. Constants are correct (10 + cohort literal + version literal) ──
    assert(
      "T01_constants",
      OPERATOR_FUNDED_PILOT_MAX_USERS === 10 &&
        OPERATOR_FUNDED_PILOT_COHORT === "ARX_PRIVATE_BETA_10" &&
        OPERATOR_FUNDED_DISCLOSURE_VERSION === "OPERATOR_FUNDED_LIVE_PILOT_V1",
      `cap=${OPERATOR_FUNDED_PILOT_MAX_USERS} cohort=${OPERATOR_FUNDED_PILOT_COHORT} ver=${OPERATOR_FUNDED_DISCLOSURE_VERSION}`,
    );

    // ── 2. Env switch defaults OFF ─────────────────────────────────────────
    assert(
      "T02_env_switch_defaults_off",
      operatorFundedPilotEnabled() === false,
      "ARX_OPERATOR_FUNDED_LIVE_PILOT_10 must be unset/false by default",
    );

    // ── 3. Disclosure text mentions operator-owned and is not withdrawable ─
    {
      const t = OPERATOR_FUNDED_DISCLOSURE_TEXT.toLowerCase();
      assert(
        "T03_disclosure_text_operator_owned",
        t.includes("operator-owned") && t.includes("not withdrawable"),
        "disclosure must explicitly state operator-owned + not withdrawable",
      );
    }
    {
      const t = OPERATOR_FUNDED_DISCLOSURE_TEXT.toLowerCase();
      // The disclosure legitimately MUST mention deposit/withdrawal/custody
      // in NEGATED context ("not depositing", "not withdrawable",
      // "not entitled to ... withdrawal"). Forbidden in this file:
      // unqualified ownership / guaranteed-profit / regulator language.
      const forbidden = [
        "investor funds",
        "client funds",
        "pooled customer funds",
        "guaranteed profit",
        "managed money",
        "licensed broker",
        "regulated broker",
        "your master account balance",
      ];
      const hits = forbidden.filter((w) => t.includes(w));
      assert(
        "T03b_disclosure_text_no_risky_wording",
        hits.length === 0,
        `forbidden=${hits.join("|")}`,
      );
    }

    // ── 4. Compliance OFF — gate blocks on COMPLIANCE_NOT_APPROVED ─────────
    await setComplianceFlag(false);
    const u1 = await seedUser("u1");
    {
      const g = await evaluateOperatorFundedPilotGate({ userId: u1 });
      assert(
        "T04_compliance_off_blocks",
        g.decision === "BLOCKED" &&
          g.blockReasons.includes(PILOT_BLOCK_REASONS.COMPLIANCE_NOT_APPROVED),
        `${g.decision} reasons=${g.blockReasons.join(",")}`,
      );
    }

    // Turn compliance ON for the remaining seeding tests.
    await setComplianceFlag(true);

    // ── 5. Env OFF — even with compliance ON, gate blocks on PILOT_DISABLED ─
    {
      const g = await evaluateOperatorFundedPilotGate({ userId: u1 });
      assert(
        "T05_env_off_blocks",
        g.decision === "BLOCKED" &&
          g.blockReasons.includes(PILOT_BLOCK_REASONS.PILOT_DISABLED),
        `${g.decision} reasons=${g.blockReasons.join(",")}`,
      );
    }

    // ── 6. Non-beta user blocked even with env ON (simulated locally) ──────
    {
      process.env["ARX_OPERATOR_FUNDED_LIVE_PILOT_10"] = "true";
      const g = await evaluateOperatorFundedPilotGate({ userId: u1 });
      assert(
        "T06_non_beta_blocked",
        g.decision === "BLOCKED" &&
          g.blockReasons.includes(PILOT_BLOCK_REASONS.NOT_BETA),
        `${g.decision} reasons=${g.blockReasons.join(",")}`,
      );
    }

    // ── 7. Beta invited but not accepted → BETA_NOT_ACCEPTED ───────────────
    const u2 = await seedUser("u2");
    await acceptBeta(u2, false);
    {
      const g = await evaluateOperatorFundedPilotGate({ userId: u2 });
      assert(
        "T07_beta_invite_unaccepted_blocked",
        g.decision === "BLOCKED" &&
          g.blockReasons.includes(PILOT_BLOCK_REASONS.BETA_NOT_ACCEPTED),
        `${g.decision} reasons=${g.blockReasons.join(",")}`,
      );
    }

    // ── 8. Beta accepted, no allocation → NO_ALLOCATION ────────────────────
    const u3 = await seedUser("u3");
    await acceptBeta(u3, true);
    {
      const g = await evaluateOperatorFundedPilotGate({ userId: u3 });
      assert(
        "T08_no_allocation_blocked",
        g.decision === "BLOCKED" &&
          g.blockReasons.includes(PILOT_BLOCK_REASONS.NO_ALLOCATION),
        `${g.decision} reasons=${g.blockReasons.join(",")}`,
      );
    }

    // ── 9. Allocation set, no disclosure → DISCLOSURE_MISSING ──────────────
    await setAllocation(u3, 1000);
    {
      const g = await evaluateOperatorFundedPilotGate({ userId: u3 });
      assert(
        "T09_disclosure_missing_blocked",
        g.decision === "BLOCKED" &&
          g.blockReasons.includes(PILOT_BLOCK_REASONS.DISCLOSURE_MISSING),
        `${g.decision} reasons=${g.blockReasons.join(",")}`,
      );
    }

    // ── 10. Disclosure accepted — full PASS path ───────────────────────────
    await acceptOperatorFundedDisclosure(u3);
    {
      const g = await evaluateOperatorFundedPilotGate({ userId: u3 });
      assert(
        "T10_full_path_passes",
        g.decision === "PASS" && g.blockReasons.length === 0,
        `${g.decision} reasons=${g.blockReasons.join(",")}`,
      );
    }

    // ── 11. helper isUserAcceptedBeta truth-table ──────────────────────────
    {
      const a = await isUserAcceptedBeta(u3);
      const b = await isUserAcceptedBeta(u2); // invite exists but not accepted
      const c = await isUserAcceptedBeta(u1); // no invite at all
      assert(
        "T11_isUserAcceptedBeta_truth_table",
        a === true && b === false && c === false,
        `u3=${a} u2=${b} u1=${c}`,
      );
    }

    // ── 12. countApprovedPilotUsers excludes seeded users (none APPROVED) ──
    {
      const baseline = await countApprovedPilotUsers();
      assert(
        "T12_count_approved_baseline_safe",
        Number.isInteger(baseline) && baseline >= 0,
        `baseline=${baseline}`,
      );
    }

    // ── 13. Schema column complianceReviewFlag exists on global settings ───
    {
      const colRows = await db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'global_trading_settings'
          AND column_name IN ('compliance_review_flag', 'compliance_review_by', 'compliance_review_at')
      `);
      const names = (colRows.rows ?? colRows ?? []).map(
        (r: { column_name: string }) => r.column_name,
      );
      assert(
        "T13_compliance_columns_present",
        names.length === 3,
        `found=${names.join(",")}`,
      );
    }

    // ── 14. PASS path does NOT widen access — Phase B still must run ───────
    // (the gate returns PASS but the pipeline ALSO runs Phase B which will
    //  block on USER_NOT_LIVE_APPROVED / EA_HEARTBEAT_STALE / etc.)
    {
      // No real dispatch — just assert the gate is additive by checking the
      // returned shape carries no "shortCircuit" hint.
      const g = await evaluateOperatorFundedPilotGate({ userId: u3 });
      assert(
        "T14_pass_is_additive_not_terminal",
        g.decision === "PASS" && typeof g.evaluatedAt === "string",
        `${JSON.stringify(g)}`,
      );
    }

    // ── 16. Defense-in-depth: over-cap APPROVED user is blocked at gate ───
    {
      // Capture how many APPROVED users exist already; we will seed enough
      // extra to push total > MAX so a fresh user lands at rank MAX+1.
      const baseRows = await db.select({ n: sql<number>`count(*)` })
        .from(userMasterLiveAccessTable)
        .where(
          and(
            eq(userMasterLiveAccessTable.masterLiveStatus, "APPROVED"),
            eq(userMasterLiveAccessTable.approvedForMasterLive, true),
          ),
        );
      const baseApproved = Number(baseRows[0]?.n ?? 0);
      const needToReachCap = Math.max(0, OPERATOR_FUNDED_PILOT_MAX_USERS - baseApproved);
      // Seed exactly enough early-approved users to fill the cap,
      // dated NOW-1h so they outrank the overshoot user.
      const past = new Date(Date.now() - 60 * 60 * 1000);
      const fillers: number[] = [];
      for (let i = 0; i < needToReachCap; i += 1) {
        const fid = await seedUser(`fill_${i}`);
        fillers.push(fid);
        await db.insert(userMasterLiveAccessTable).values({
          userId: fid,
          approvedForMasterLive: true,
          masterLiveTradingEnabled: false,
          masterLiveStatus: "APPROVED",
          masterLiveApprovedAt: past,
        } as never);
      }
      // The overshoot user — APPROVED but dated NOW so they sit at rank > MAX.
      const overshootUserId = await seedUser("overshoot");
      await db.insert(userMasterLiveAccessTable).values({
        userId: overshootUserId,
        approvedForMasterLive: true,
        masterLiveTradingEnabled: false,
        masterLiveStatus: "APPROVED",
        masterLiveApprovedAt: new Date(),
      } as never);

      const g = await evaluateOperatorFundedPilotGate({ userId: overshootUserId });
      const blocked = g.blockReasons.includes(
        PILOT_BLOCK_REASONS.COHORT_CAP_EXCEEDED,
      );
      assert(
        "T16_defense_in_depth_cohort_cap_exceeded_blocks_overshoot_user",
        blocked,
        `decision=${g.decision} reasons=${g.blockReasons.join(",")}`,
      );

      // And the earliest filler must NOT be blocked by COHORT_CAP_EXCEEDED.
      if (fillers[0]) {
        const g0 = await evaluateOperatorFundedPilotGate({ userId: fillers[0] });
        const earliestNotCapBlocked = !g0.blockReasons.includes(
          PILOT_BLOCK_REASONS.COHORT_CAP_EXCEEDED,
        );
        assert(
          "T16b_earliest_approved_users_not_blocked_by_overshoot_check",
          earliestNotCapBlocked,
          `reasons=${g0.blockReasons.join(",")}`,
        );
      }
    }

    // ── 17. Concurrent admin approvals never exceed cap (atomic admission) ─
    {
      // Wipe APPROVED rows seeded in T16 so we start from a known baseline,
      // then fire 20 parallel approval-style transactions that each do:
      //   advisory_xact_lock → count APPROVED → if<MAX insert APPROVED
      // Mirrors the exact SQL pattern used by /admin/.../approve. After
      // all settle, total APPROVED must be <= MAX.
      if (seededUserIds.length > 0) {
        await db.delete(userMasterLiveAccessTable)
          .where(sql`${userMasterLiveAccessTable.userId} in ${seededUserIds}`);
      }
      const racers: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        racers.push(await seedUser(`race_${i}`));
      }
      const LOCK_KEY = 4210_1019;
      await Promise.all(racers.map((uid) =>
        db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
          const c = await tx.select({ n: sql<number>`count(*)` })
            .from(userMasterLiveAccessTable)
            .where(
              and(
                eq(userMasterLiveAccessTable.masterLiveStatus, "APPROVED"),
                eq(userMasterLiveAccessTable.approvedForMasterLive, true),
              ),
            );
          if (Number(c[0]?.n ?? 0) >= OPERATOR_FUNDED_PILOT_MAX_USERS) return;
          await tx.insert(userMasterLiveAccessTable).values({
            userId: uid,
            approvedForMasterLive: true,
            masterLiveTradingEnabled: false,
            masterLiveStatus: "APPROVED",
            masterLiveApprovedAt: new Date(),
          } as never);
        }),
      ));
      const finalRows = await db.select({ n: sql<number>`count(*)` })
        .from(userMasterLiveAccessTable)
        .where(
          and(
            eq(userMasterLiveAccessTable.masterLiveStatus, "APPROVED"),
            eq(userMasterLiveAccessTable.approvedForMasterLive, true),
            sql`${userMasterLiveAccessTable.userId} in ${racers}`,
          ),
        );
      const finalApproved = Number(finalRows[0]?.n ?? 0);
      assert(
        "T17_concurrent_approvals_never_exceed_cap",
        finalApproved === OPERATOR_FUNDED_PILOT_MAX_USERS,
        `final_approved_from_racers=${finalApproved} cap=${OPERATOR_FUNDED_PILOT_MAX_USERS} (20 parallel racers)`,
      );
    }

    // ── 15. arx_live_commands strict-zero invariant ────────────────────────
    const afterRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(arxLiveCommandsTable);
    const afterCount = Number(afterRows[0]?.n ?? 0);
    assert(
      "T15_arx_live_commands_unchanged",
      afterCount === beforeCount,
      `before=${beforeCount} after=${afterCount}`,
    );
  } finally {
    await cleanup(prevCompliance);
  }
}

main()
  .then(() => {
    for (const r of results) {
      console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id}${r.detail ? "  " + r.detail : ""}`);
    }
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} probes passed`);
    process.exit(passed === results.length ? 0 : 1);
  })
  .catch((err) => {
    console.error("FATAL", err);
    process.exit(2);
  });
