// Child probe: an independent cold module cache and exactly one DB connection.
import assert from "node:assert/strict";
import { db, pool, mt5ConnectionTable } from "@workspace/db";
import { eq } from "drizzle-orm";
assert.equal(process.env.ARX_MANAGEMENT_TARGET_PG, "1");
assert.match(process.env.DATABASE_URL ?? "", /arx_management_target_test\?host=/);
pool.options.max = 1;
globalThis.fetch = async () => { throw new Error("External I/O forbidden"); };
const legacy = process.argv.includes("--legacy");
const { default: router } = legacy ? await import("../../../routes/mt5.js") : await import("../../../routes/mt5Live.js");
const route = router.stack.find((l: any) => l.route?.path === (legacy ? "/mt5/commands" : "/mt5/live-commands-poll"))!.route!;
const [connection] = await db.select().from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, 1));
async function poll() {
  let value: any;
  const response: any = { json(v: unknown) { value = v; return response; },
    type() { return response; }, send(v: string) { value = JSON.parse(v); return response; },
    status(n: number) { assert.equal(n, 200); return response; } };
  await route.stack.at(-1)!.handle({ mt5Connection: connection, get: () => undefined,
    log: { info() {}, warn() {}, error() {} }, headers: {}, body: {},
  } as any, response, () => {});
  return value;
}
try {
  const values = await Promise.all([poll(), poll()]);
  if (process.argv.includes("--already-picked")) {
    for (const value of values) assert.deepEqual(legacy ? value.commands : value.command, legacy ? [] : null);
  } else {
    assert.deepEqual(values.map(v => v.command.commandId).sort(), ["cold-manual-1", "cold-manual-2"]);
    assert.ok(values.every(v => v.command.symbol === "Exact.Native"));
  }
  assert.equal(pool.options.max, 1);
} finally { await pool.end(); }
