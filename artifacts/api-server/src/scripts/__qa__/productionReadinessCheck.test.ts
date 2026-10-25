// Production readiness check (Tier 1 finalization, items 9 and 10): it reports
// migrations, trading availability and ownerless rows, and changes nothing.
//
// Run: pnpm --filter @workspace/api-server run test:production-readiness-check

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { migrationChecks, ownerlessRows, tradingStatus } from "../productionReadinessCheck.js";

const snapshot = async () => (await pool.query(`SELECT * FROM global_trading_settings ORDER BY id ASC LIMIT 1`)).rows[0];
const original = await snapshot();
after(async () => {
  if (original) {
    await pool.query(`UPDATE global_trading_settings SET platform_mode = $1, demo_enabled = $2, live_enabled = $3, emergency_kill_switch = $4, kill_switch_reason = $5 WHERE id = $6`,
      [original.platform_mode, original.demo_enabled, original.live_enabled, original.emergency_kill_switch, original.kill_switch_reason, original.id]);
  }
  await pool.end();
});

test("every Tier 1 migration is detected on a migrated database", async () => {
  const m = await migrationChecks();
  assert.equal(m.length, 9);
  assert.ok(m.some(c => c.name === "2026-10-25_trade_action_request_key" && c.ok));
  assert.deepEqual(m.filter((c) => !c.ok).map((c) => c.name), []);
});

test("released switches and enabled venues read TRADING AVAILABLE; an engaged stop reads TRADING HALTED", { skip: !original && "no global_trading_settings row" }, async () => {
  await pool.query(`UPDATE global_trading_settings SET platform_mode = 'LIVE', demo_enabled = true, live_enabled = true, emergency_kill_switch = false WHERE id = $1`, [original.id]);
  const safety = (await pool.query(`SELECT kill_switch_engaged FROM safety_core ORDER BY id ASC LIMIT 1`)).rows[0];
  const open = await tradingStatus();
  assert.equal(open.verdict, safety?.kill_switch_engaged ? "TRADING HALTED" : "TRADING AVAILABLE");
  await pool.query(`UPDATE global_trading_settings SET emergency_kill_switch = true, kill_switch_reason = 'qa' WHERE id = $1`, [original.id]);
  const halted = await tradingStatus();
  assert.equal(halted.verdict, "TRADING HALTED");
  assert.match(halted.checks.find((c) => c.name === "platform emergency stop")!.detail, /ENGAGED \(qa\).*owner\/operator/);
});

test("the check itself writes nothing", async () => {
  const before = await snapshot();
  await migrationChecks(); await tradingStatus(); await ownerlessRows();
  assert.deepEqual(await snapshot(), before);
});
