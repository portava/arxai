// Strategy Lab — experiments belong to the user who created them.
//
// The defect this locks: GET /strategy-lab/experiments had no auth and listed
// every row (strategy_lab_experiments has no user column), so user B — or an
// anonymous browser — saw user A's experiments, trades, net and win rate as
// experiments on their own page, with no owner shown.
//
// Without a migration, ownership is recorded in the row's settings JSON under a
// reserved key, set by the server from the session (never from the body), and
// every read and run is scoped to it.
//
// The database handle is an in-memory stub that evaluates the two predicates
// these queries use (experiment id, owner key). The real router and lab module
// run. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/strategyLabOwnership.test.ts

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const database = await import("@workspace/db");
const dialect = new PgDialect();
type Row = Record<string, unknown> & { experimentId: string; settings: Record<string, unknown>; createdAt: Date };
const rows: Row[] = [];

/** Evaluates `experiment_id = $n` and `settings->>'_ownerUserId' = $n` (ANDed) against a row. */
function matches(where: SQL | undefined, r: Row): boolean {
  if (!where) return true;
  const q = dialect.sqlToQuery(where);
  let ok = true;
  const idM = /"experiment_id" = \$(\d+)/.exec(q.sql);
  if (idM) ok = ok && r.experimentId === q.params[Number(idM[1]) - 1];
  const ownM = /->>'_ownerUserId' = \$(\d+)/.exec(q.sql);
  if (ownM) ok = ok && String(r.settings["_ownerUserId"]) === q.params[Number(ownM[1]) - 1];
  if (!idM && !ownM) throw new Error(`unexpected predicate: ${q.sql}`);
  return ok;
}

function selectChain(): Record<string, unknown> {
  let where: SQL | undefined;
  let limit = Infinity;
  const q: Record<string, unknown> = {};
  q.from = () => q;
  q.where = (w: SQL) => { where = w; return q; };
  q.orderBy = () => q;
  q.limit = (n: number) => { limit = n; return q; };
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve().then(() => rows.filter((r) => matches(where, r)).slice(0, limit)).then(resolve, reject);
  return q;
}
const fakeDb = {
  select: () => selectChain(),
  insert: () => ({ values: async (v: Record<string, unknown>) => { rows.push({ createdAt: new Date(), ...v } as Row); } }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const { default: express } = await import("express");
const { default: router } = await import("../strategyLab.js");

async function call(userId: number | null, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId != null) (req as unknown as { authUser: unknown }).authUser = { id: userId, role: "USER" };
    next();
  });
  app.use(router);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const A = 501;
const B = 502;

test("an experiment is listed only for its creator; another user and anonymous callers do not see it", async () => {
  const created = await call(A, "POST", "/strategy-lab/experiments", {
    title: "A's breakout lab", scenario_ids: ["scn_1"], settings: { minConfidence: 60, _ownerUserId: B },
  });
  assert.equal(created.status, 200);
  const id = String(created.json["experiment_id"]);

  const mine = await call(A, "GET", "/strategy-lab/experiments");
  assert.equal(mine.status, 200);
  assert.deepEqual((mine.json["experiments"] as Row[]).map((e) => e.experimentId), [id]);
  assert.equal(mine.json["scope"], "OWN");

  const other = await call(B, "GET", "/strategy-lab/experiments");
  assert.equal(other.status, 200);
  assert.deepEqual(other.json["experiments"], [], "user B does not see user A's experiment");

  const anon = await call(null, "GET", "/strategy-lab/experiments");
  assert.equal(anon.status, 401);

  const otherGet = await call(B, "GET", `/strategy-lab/experiments/${id}`);
  assert.equal(otherGet.status, 404);
  const otherRun = await call(B, "POST", `/strategy-lab/experiments/${id}/run`);
  assert.equal(otherRun.status, 404, "user B cannot run user A's experiment");
  const otherCompare = await call(B, "GET", `/strategy-lab/compare?ids=${id}`);
  assert.deepEqual(otherCompare.json["comparison"], []);
});

test("the owner is taken from the session, never from the request body", async () => {
  const before = rows.length;
  await call(A, "POST", "/strategy-lab/experiments", { title: "spoof", scenario_ids: ["scn_2"], settings: { _ownerUserId: B } });
  assert.equal(rows.length, before + 1);
  assert.equal(rows[rows.length - 1]!.settings["_ownerUserId"], A);
});

test("rows from before ownership was recorded are nobody's own", async () => {
  rows.push({ experimentId: "exp_legacy", title: "legacy", settings: {}, createdAt: new Date() } as Row);
  const mine = await call(A, "GET", "/strategy-lab/experiments");
  assert.ok(!(mine.json["experiments"] as Row[]).some((e) => e.experimentId === "exp_legacy"));
});
