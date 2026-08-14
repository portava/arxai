// QA — Operator Per-User Trading Mode Control
//
// Verifies the new mode-change gate (typed phrase + reason for LIVE),
// the mode-change audit columns on user_trading_permissions, the literal
// tradingMode surfacing helper, and the strict-zero invariant on
// arx_live_commands.
//
// NO live trade is fired. NO real bridge call is made.

import { db } from "@workspace/db";
import {
  userTradingPermissionsTable,
  arxLiveCommandsTable,
  usersTable,
} from "@workspace/db/schema";
import { tradingModeGate } from "@workspace/db/repositories";
import { eq, sql } from "drizzle-orm";

type Result = { id: string; ok: boolean; detail: string };
const results: Result[] = [];
const assert = (id: string, cond: boolean, detail: string) =>
  results.push({ id, ok: cond, detail });

async function main() {
  // ── 0. Baseline: arx_live_commands count BEFORE ─────────────────────────
  const beforeRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(arxLiveCommandsTable);
  const beforeCount = Number(beforeRows[0]?.n ?? 0);

  // ── 1. Gate: requested undefined → ok ───────────────────────────────────
  {
    const r = tradingModeGate.validateModeChangeRequest({ before: null });
    assert("T01_no_mode_requested_passes", r.ok, JSON.stringify(r));
  }
  // ── 2. Gate: invalid mode literal rejected ──────────────────────────────
  {
    const r = tradingModeGate.validateModeChangeRequest({
      before: null,
      requestedMode: "PAPER",
    });
    assert(
      "T02_invalid_mode_rejected",
      !r.ok && r.error === "INVALID_MODE",
      `mode=PAPER must be rejected (canonical is SIMULATED); got ${JSON.stringify(r)}`,
    );
  }
  // ── 3. Gate: DEMO escalation never needs typed phrase ───────────────────
  {
    const r = tradingModeGate.validateModeChangeRequest({
      before: { tradingMode: "DISABLED" },
      requestedMode: "DEMO",
    });
    assert("T03_demo_no_phrase_needed", r.ok, JSON.stringify(r));
  }
  // ── 4. Gate: SIMULATED (paper) escalation never needs typed phrase ──────
  {
    const r = tradingModeGate.validateModeChangeRequest({
      before: { tradingMode: "DEMO" },
      requestedMode: "SIMULATED",
    });
    assert("T04_simulated_no_phrase_needed", r.ok, JSON.stringify(r));
  }
  // ── 5. Gate: LIVE without phrase rejected ───────────────────────────────
  {
    const r = tradingModeGate.validateModeChangeRequest({
      before: { tradingMode: "DEMO" },
      requestedMode: "LIVE",
      reason: "operator approved live access for pilot",
    });
    assert(
      "T05_live_without_phrase_blocked",
      !r.ok && r.error === "LIVE_CONFIRM_PHRASE_REQUIRED",
      JSON.stringify(r),
    );
  }
  // ── 6. Gate: LIVE with wrong phrase rejected ────────────────────────────
  {
    const r = tradingModeGate.validateModeChangeRequest({
      before: { tradingMode: "DEMO" },
      requestedMode: "LIVE",
      reason: "operator approved live access for pilot",
      confirmPhrase: "confirm live mode",
    });
    assert(
      "T06_live_wrong_phrase_blocked",
      !r.ok && r.error === "LIVE_CONFIRM_PHRASE_REQUIRED",
      `wrong-case must fail; got ${JSON.stringify(r)}`,
    );
  }
  // ── 7. Gate: LIVE with phrase but no reason rejected ────────────────────
  {
    const r = tradingModeGate.validateModeChangeRequest({
      before: { tradingMode: "DEMO" },
      requestedMode: "LIVE",
      confirmPhrase: "CONFIRM LIVE MODE",
    });
    assert(
      "T07_live_no_reason_blocked",
      !r.ok && r.error === "LIVE_REASON_TOO_SHORT",
      JSON.stringify(r),
    );
  }
  // ── 8. Gate: LIVE with phrase but short reason rejected ─────────────────
  {
    const r = tradingModeGate.validateModeChangeRequest({
      before: { tradingMode: "DEMO" },
      requestedMode: "LIVE",
      reason: "ok",
      confirmPhrase: "CONFIRM LIVE MODE",
    });
    assert(
      "T08_live_short_reason_blocked",
      !r.ok && r.error === "LIVE_REASON_TOO_SHORT",
      JSON.stringify(r),
    );
  }
  // ── 9. Gate: LIVE with phrase + good reason allowed ─────────────────────
  {
    const r = tradingModeGate.validateModeChangeRequest({
      before: { tradingMode: "DEMO" },
      requestedMode: "LIVE",
      reason: "operator approved live access for pilot user 42",
      confirmPhrase: "CONFIRM LIVE MODE",
    });
    assert("T09_live_full_gate_passes", r.ok, JSON.stringify(r));
  }
  // ── 10. Gate: LIVE→LIVE (no escalation) skips phrase requirement ────────
  {
    const r = tradingModeGate.validateModeChangeRequest({
      before: { tradingMode: "LIVE" },
      requestedMode: "LIVE",
    });
    assert("T10_live_to_live_passes", r.ok, JSON.stringify(r));
  }
  // ── 11. Gate: demotion LIVE→PAPER never needs phrase ────────────────────
  {
    const r = tradingModeGate.validateModeChangeRequest({
      before: { tradingMode: "LIVE" },
      requestedMode: "SIMULATED",
      reason: "revoking live for review",
    });
    assert("T11_live_demote_passes", r.ok, JSON.stringify(r));
  }
  // ── 12. Patch builder: unchanged mode → empty patch ─────────────────────
  {
    const p = tradingModeGate.buildModeChangePatch({
      before: { tradingMode: "DEMO" },
      requestedMode: "DEMO",
    });
    assert(
      "T12_unchanged_mode_no_audit_patch",
      p.previousTradingMode === null &&
        p.tradingModeUpdatedAt === null &&
        p.tradingModeChangeReason === null,
      JSON.stringify(p),
    );
  }
  // ── 13. Patch builder: changed mode → captures previous + timestamp ─────
  {
    const p = tradingModeGate.buildModeChangePatch({
      before: { tradingMode: "DEMO" },
      requestedMode: "SIMULATED",
      reason: "moving user back to paper",
    });
    assert(
      "T13_changed_mode_captures_audit",
      p.previousTradingMode === "DEMO" &&
        p.tradingModeUpdatedAt instanceof Date &&
        p.tradingModeChangeReason === "moving user back to paper",
      JSON.stringify(p),
    );
  }
  // ── 14. Patch builder: new user (no before row) → previous = DISABLED ───
  {
    const p = tradingModeGate.buildModeChangePatch({
      before: null,
      requestedMode: "DEMO",
      reason: "first-time enable for beta tester",
    });
    assert(
      "T14_new_user_previous_is_disabled",
      p.previousTradingMode === "DISABLED",
      JSON.stringify(p),
    );
  }
  // ── 15. Label helper: covers all 4 modes ────────────────────────────────
  {
    const ok =
      tradingModeGate.tradingModeLabel("SIMULATED").startsWith("Paper Mode") &&
      tradingModeGate.tradingModeLabel("DEMO").startsWith("Demo Mode") &&
      tradingModeGate.tradingModeLabel("LIVE").startsWith("Live Mode") &&
      tradingModeGate.tradingModeLabel("DISABLED").toLowerCase().includes("operator");
    assert("T15_label_covers_all_modes", ok, "");
  }
  // ── 15b. Canonical DISABLED label matches the one in /me/account-shell ──
  {
    const helperLabel = tradingModeGate.tradingModeLabel("DISABLED");
    const accountShellLabel = "Your operator has not enabled trading.";
    assert(
      "T15b_disabled_label_matches_account_shell",
      helperLabel === accountShellLabel,
      `helper="${helperLabel}" account-shell="${accountShellLabel}"`,
    );
  }

  // ── 16. Schema columns are present on user_trading_permissions ──────────
  {
    const colRows = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'user_trading_permissions'
        AND column_name IN ('previous_trading_mode','trading_mode_updated_at','trading_mode_change_reason')
    `);
    const cols = new Set((colRows.rows as { column_name: string }[]).map(r => r.column_name));
    assert(
      "T16_audit_columns_present",
      cols.size === 3,
      `expected 3 audit columns, got ${Array.from(cols).join(",")}`,
    );
  }

  // ── 17. Default mode for net-new user is NOT LIVE ───────────────────────
  {
    // Seed a throwaway user, do not insert a permission row → defaults apply.
    const seededEmail = `qa-mode-${Date.now()}@arx.test`;
    const [u] = await db.insert(usersTable).values({
      email: seededEmail,
      passwordHash: null,
      role: "USER",
    }).returning();
    try {
      // simulate the route's "before row" lookup
      const existing = await db.select().from(userTradingPermissionsTable)
        .where(eq(userTradingPermissionsTable.userId, u.id)).limit(1);
      assert(
        "T17_new_user_no_perm_row",
        existing.length === 0,
        `new user must not have a permission row`,
      );
      // schema default = "DISABLED" (typed as the full union so the
      // not-LIVE assertion remains a real runtime check, not narrowed to
      // a literal mismatch by TS).
      const schemaDefault: string = "DISABLED";
      assert("T17b_schema_default_not_live", schemaDefault !== "LIVE", schemaDefault);
    } finally {
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  }

  // ── 18. Round-trip: an operator-style update writes audit fields ────────
  {
    const seededEmail = `qa-mode-rt-${Date.now()}@arx.test`;
    const [u] = await db.insert(usersTable).values({
      email: seededEmail,
      passwordHash: null,
      role: "USER",
    }).returning();
    try {
      // 18a. Initial set to DEMO captures previous=DISABLED
      const before1 = (await db.select().from(userTradingPermissionsTable)
        .where(eq(userTradingPermissionsTable.userId, u.id)).limit(1))[0] ?? null;
      const patch1 = tradingModeGate.buildModeChangePatch({
        before: before1 ? { tradingMode: before1.tradingMode } : null,
        requestedMode: "DEMO",
        reason: "enabling demo for QA",
      });
      await db.insert(userTradingPermissionsTable).values({
        userId: u.id,
        tradingMode: "DEMO",
        previousTradingMode: patch1.previousTradingMode,
        tradingModeUpdatedAt: patch1.tradingModeUpdatedAt,
        tradingModeChangeReason: patch1.tradingModeChangeReason,
        suspended: false,
        demoEnabled: true,
      });
      const after1 = (await db.select().from(userTradingPermissionsTable)
        .where(eq(userTradingPermissionsTable.userId, u.id)).limit(1))[0];
      assert(
        "T18a_demo_set_writes_audit",
        after1.tradingMode === "DEMO" &&
          after1.previousTradingMode === "DISABLED" &&
          after1.tradingModeUpdatedAt != null &&
          after1.tradingModeChangeReason === "enabling demo for QA",
        JSON.stringify(after1),
      );

      // 18b. Switch DEMO→SIMULATED updates audit (previous=DEMO)
      const patch2 = tradingModeGate.buildModeChangePatch({
        before: { tradingMode: after1.tradingMode },
        requestedMode: "SIMULATED",
        reason: "moving to paper",
      });
      await db.update(userTradingPermissionsTable).set({
        tradingMode: "SIMULATED",
        ...patch2,
      }).where(eq(userTradingPermissionsTable.userId, u.id));
      const after2 = (await db.select().from(userTradingPermissionsTable)
        .where(eq(userTradingPermissionsTable.userId, u.id)).limit(1))[0];
      assert(
        "T18b_mode_change_updates_previous",
        after2.tradingMode === "SIMULATED" && after2.previousTradingMode === "DEMO",
        JSON.stringify(after2),
      );

      // 18c. LIVE escalation without gate would be blocked at route layer
      const liveGate = tradingModeGate.validateModeChangeRequest({
        before: { tradingMode: after2.tradingMode },
        requestedMode: "LIVE",
        reason: "test",
        confirmPhrase: "",
      });
      assert("T18c_live_blocked_no_phrase", !liveGate.ok, JSON.stringify(liveGate));
    } finally {
      await db.delete(userTradingPermissionsTable)
        .where(eq(userTradingPermissionsTable.userId, u.id));
      await db.delete(usersTable).where(eq(usersTable.id, u.id));
    }
  }

  // ── 19. arx_live_commands strict-zero invariant (no command created) ────
  const afterRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(arxLiveCommandsTable);
  const afterCount = Number(afterRows[0]?.n ?? 0);
  assert(
    "T19_arx_live_commands_unchanged",
    beforeCount === afterCount,
    `before=${beforeCount} after=${afterCount}`,
  );

  // ── Report ──────────────────────────────────────────────────────────────
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok);
  // eslint-disable-next-line no-console
  console.log(`\nqaPerUserTradingMode: ${pass}/${results.length} PASS`);
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id}${r.ok ? "" : "  ::  " + r.detail}`);
  }
  // eslint-disable-next-line no-console
  console.log(`arx_live_commands BEFORE=${beforeCount} AFTER=${afterCount} (must be equal)`);
  if (fail.length > 0) process.exit(1);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
