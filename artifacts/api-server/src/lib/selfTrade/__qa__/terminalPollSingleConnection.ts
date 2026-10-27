// Child probe: an independent cold module cache and exactly one DB connection.
// The property under test is the poll path: two concurrent manual polls must
// complete over a one-connection pool, which fails only if the pickup
// transaction nests a second pool checkout (self-deadlock) or starves a waiter.
// Process bootstrap is NOT the property: a fresh process loads ~360 ESM modules
// through the tsx loader before the first poll, which costs several seconds on
// a slow host, so the poll deadline is enforced here around the polls alone and
// the parent keeps only a liveness timeout that covers bootstrap.
import assert from "node:assert/strict";
import { db, pool, mt5ConnectionTable } from "@workspace/db";
import { eq } from "drizzle-orm";
assert.equal(process.env.ARX_MANAGEMENT_TARGET_PG, "1");
assert.match(process.env.DATABASE_URL ?? "", /arx_management_target_test\?host=/);
pool.options.max = 1;
globalThis.fetch = async () => { throw new Error("External I/O forbidden"); };
const { default: router } = await import("../../../routes/mt5Live.js");
const route = router.stack.find((l: any) => l.route?.path === "/mt5/live-commands-poll")!.route!;
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
// Measured at ~55 ms on a loaded 4-vCPU host; a pool self-deadlock never completes.
const POLL_DEADLINE_MS = 5000;
const bootstrapMs = Math.round(process.uptime() * 1000);
try {
  // A deadlocked pool would also hang pool.end(), so the watchdog exits directly
  // with the diagnosis instead of leaving the parent to report a bare timeout.
  const watchdog = setTimeout(() => {
    process.stderr.write(`terminalPollSingleConnection: concurrent manual polls did not complete over a one-connection pool within ${POLL_DEADLINE_MS} ms (pool self-deadlock or starvation); bootstrapMs=${bootstrapMs}\n`);
    process.exit(1);
  }, POLL_DEADLINE_MS);
  const started = performance.now();
  const values = await Promise.all([poll(), poll()]);
  const pollsMs = Math.round(performance.now() - started);
  clearTimeout(watchdog);
  assert.deepEqual(values.map(v => v.command.commandId).sort(), ["cold-manual-1", "cold-manual-2"]);
  assert.ok(values.every(v => v.command.symbol === "Exact.Native"));
  assert.equal(pool.options.max, 1);
  process.stdout.write(JSON.stringify({ terminalPollSingleConnection: { bootstrapMs, pollsMs, pollDeadlineMs: POLL_DEADLINE_MS } }) + "\n");
} finally { await pool.end(); }
