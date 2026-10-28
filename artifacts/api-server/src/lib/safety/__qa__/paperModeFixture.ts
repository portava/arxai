// Integration fixture only: callers use a disposable database and restore it.
// Booking/risk tests must explicitly arrange an executable paper posture.
import assert from "node:assert/strict";
import { db, safetyCoreTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function executablePaperFixture(): Promise<() => Promise<void>> {
  const rows = await db.select().from(safetyCoreTable);
  assert.ok(rows.length <= 1, "fixture requires unambiguous Safety Core state");
  const set = { operationalMode: "PAPER_TRADING", globalState: "NORMAL", killSwitchEngaged: false };
  if (rows[0]) {
    const old = rows[0];
    await db.update(safetyCoreTable).set(set).where(eq(safetyCoreTable.id, old.id));
    return async () => { await db.update(safetyCoreTable).set({ operationalMode: old.operationalMode, globalState: old.globalState, killSwitchEngaged: old.killSwitchEngaged }).where(eq(safetyCoreTable.id, old.id)); };
  }
  const [row] = await db.insert(safetyCoreTable).values(set).returning();
  return async () => { await db.delete(safetyCoreTable).where(eq(safetyCoreTable.id, row!.id)); };
}
