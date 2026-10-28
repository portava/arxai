// POST /self-trade-ai/run-autonomous-cycle: the single-flight refusal as the
// admin card sees it, through the real router and express. runAutonomousCycle
// is a module mock driven by the test; no database, broker or bridge is used
// (a pool call is a test failure).
//
// Pins: an overlapping POST gets 409 {ok:false, error:"CYCLE_ALREADY_RUNNING",
// message} and never calls the cycle; the refusal is logged and the refused run
// is not logged as invoked; the slot is released after the first run settles,
// including after it throws (500); past CYCLE_STUCK_AFTER_MS the 409 says the
// cycle may be stuck and the refusal is logged at error level.
//
// Run: pnpm --filter @workspace/api-server run test:self-trade-lifecycle
import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://qa:qa@127.0.0.1:1/offline_never_connects";
const database = await import("@workspace/db");
mock.method(database.pool, "query", () => {
  throw new Error("Unexpected database access");
});
mock.method(database.pool, "connect", () => {
  throw new Error("Unexpected database access");
});

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const pending: Pending[] = [];
let cycleCalls = 0;
mock.module("../../lib/selfTrade/autonomousCycle.js", {
  namedExports: {
    runAutonomousCycle: () => {
      cycleCalls++;
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  },
});

const express = (await import("express")).default;
const router = (await import("../selfTradeAi.js")).default;
const { CYCLE_STUCK_AFTER_MS } = await import("../../lib/selfTrade/cycleReport.js");

const logs: { level: string; msg: string }[] = [];
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { authUser: unknown }).authUser = { id: 7, role: "ADMIN" };
  const at = (level: string) => (_fields: unknown, msg: string) => logs.push({ level, msg });
  (req as unknown as { log: unknown }).log = { warn: at("warn"), error: at("error"), info: at("info") };
  next();
});
app.use(router);
app.use((_e: unknown, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
  res.status(500).json({ ok: false, error: "INTERNAL" });
});

let server: Server;
let base: string;
before(async () => {
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

const post = () =>
  fetch(`${base}/self-trade-ai/run-autonomous-cycle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "qa single flight" }),
  });

const result = {
  cycleId: "cycle-route-qa",
  decisionsConsidered: 0,
  executed: {},
  agentsManaged: 0,
  positionsModified: 0,
  positionsClosed: 0,
  reconciled: { filled: 0, rejected: 0, closed: 0, expired: 0 },
  realizedPosted: 0,
  managementHeld: {},
  protective: { considered: 0, acted: 0, bridges: 0, elapsedMs: 0 },
};

async function waitFor(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), "condition not reached");
}

beforeEach(() => {
  pending.length = 0;
  cycleCalls = 0;
  logs.length = 0;
});

describe("POST /self-trade-ai/run-autonomous-cycle: single flight", () => {
  it("refuses an overlapping run with 409 CYCLE_ALREADY_RUNNING and logs the refusal, then frees the slot", async () => {
    const first = post();
    await waitFor(() => pending.length === 1);

    const second = await post();
    assert.equal(second.status, 409);
    const body = (await second.json()) as { ok: boolean; error: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "CYCLE_ALREADY_RUNNING");
    assert.match(body.message, /is still running on the server, so this run was not started/);
    assert.doesNotMatch(body.message, /stuck/);
    assert.equal(cycleCalls, 1);
    assert.equal(logs.filter((l) => /invoked/.test(l.msg)).length, 1, "refused run not logged as invoked");
    assert.deepEqual(
      logs.filter((l) => /refused/.test(l.msg)).map((l) => l.level),
      ["warn"],
    );

    pending[0].resolve(result);
    const ok = await first;
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { cycleId: string }).cycleId, "cycle-route-qa");

    const third = post();
    await waitFor(() => pending.length === 2);
    pending[1].resolve(result);
    assert.equal((await third).status, 200);
  });

  it("releases the slot after the running cycle throws (500)", async () => {
    const first = post();
    await waitFor(() => pending.length === 1);
    pending[0].reject(new Error("cycle blew up"));
    assert.equal((await first).status, 500);

    const next = post();
    await waitFor(() => pending.length === 2);
    assert.equal(cycleCalls, 2);
    pending[1].resolve(result);
    assert.equal((await next).status, 200);
  });

  it("says the cycle may be stuck, and logs at error level, once it has run past the ceiling", async () => {
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    try {
      const first = post();
      await waitFor(() => pending.length === 1);
      offset = CYCLE_STUCK_AFTER_MS + 60_000;
      const refused = await post();
      assert.equal(refused.status, 409);
      const body = (await refused.json()) as { error: string; message: string };
      assert.equal(body.error, "CYCLE_ALREADY_RUNNING");
      assert.match(body.message, /running unusually long \(over 10 min\) and may be stuck/);
      assert.match(body.message, /restart may be required/);
      assert.deepEqual(
        logs.filter((l) => /refused/.test(l.msg)).map((l) => l.level),
        ["error"],
      );
      pending[0].resolve(result);
      assert.equal((await first).status, 200);
    } finally {
      Date.now = realNow;
    }
  });
});
