// Isolated-test setup: operator explicitly enables broker execution, restored after.
import { before, after } from "node:test";
import { db, brokerHealthStateTable } from "@workspace/db";
export function enabledBrokerControlsFixture(): void {
  let saved: Array<typeof brokerHealthStateTable.$inferSelect> = [];
  before(async () => {
    saved = await db.select().from(brokerHealthStateTable);
    await db.delete(brokerHealthStateTable);
    await db.insert(brokerHealthStateTable).values({ executionEnabled: true, maintenanceMode: false });
  });
  after(async () => {
    await db.delete(brokerHealthStateTable);
    if (saved.length) await db.insert(brokerHealthStateTable).values(saved);
  });
}
