// Edge discovery truth: a slice with no losing trade has no measurable profit
// factor, and the edge boards show the latest generation of each slice only.
//
// Locks two inaccuracies on the Edge discovery page:
//   (a) computeStats stored 999 as an "infinite" profit-factor marker; the
//       classifier accepted it against STRONG_PF and confidence() saturated on
//       it, so 30 all-winning journal rows became "STRONG EDGE", confidence
//       ~100, summary "a measurable historical edge (PF 999.00 …)".
//   (b) every POST inserted a fresh row per slice and GET /edge/strongest,
//       /weakest and /reports read every past generation, so the same slice
//       showed twice with different numbers.
//
// Runs the REAL router with @workspace/db replaced by an in-memory fake: no
// database, no broker, no network. The router is mounted on loopback.

import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

type Row = Record<string, unknown>;
const store: Record<string, Row[]> = {};
let nextId = 1;
let clock = Date.parse("2026-10-01T00:00:00Z");

function tableNamed(name: string) {
  return { __name: name, id: { name: "id" }, userId: { name: "user_id" },
    createdAt: { name: "created_at" }, confidenceScore: { name: "confidence_score" },
    expectancy: { name: "expectancy" }, edgeReportId: { name: "edge_report_id" } };
}
const tables = {
  edgeDiscoveryReportsTable: tableNamed("reports"),
  edgeWarningsTable: tableNamed("warnings"),
  tradeJournalTable: tableNamed("journal"),
  paperOrdersTable: tableNamed("paper"),
  postTradeDebriefsTable: tableNamed("debriefs"),
  vaultEventsTable: tableNamed("vault"),
};

// Chainable, awaitable select that ignores filters/order (the fake returns the
// table's rows in insertion order — the route must not rely on SQL ordering
// for correctness of what it presents).
function selectChain(rowsOf: () => Row[]): unknown {
  let rows: () => Row[] = rowsOf;
  const handler: ProxyHandler<() => void> = {
    get(_t, prop) {
      if (prop === "then") return (a: (v: unknown) => unknown, b: (e: unknown) => unknown) =>
        Promise.resolve(rows()).then(a, b);
      if (prop === "from") return (t: { __name: string }) => { rows = () => [...(store[t.__name] ?? [])]; return proxy; };
      return () => proxy;
    },
  };
  const proxy: unknown = new Proxy(() => undefined, handler);
  return proxy;
}
const fakeDb = {
  select: () => selectChain(() => []),
  insert: (t: { __name: string }) => ({
    values: (v: Row) => {
      clock += 1000;
      const row: Row = { id: nextId++, createdAt: new Date(clock), ...v };
      (store[t.__name] ??= []).push(row);
      const p = Promise.resolve([row]);
      return Object.assign(p, { returning: async () => [row], catch: p.catch.bind(p) });
    },
  }),
};

mock.module("@workspace/db", { namedExports: { db: fakeDb, ...tables } });
mock.module("../../lib/auth/middleware.js", {
  namedExports: {
    requireUser: (req: { authUser?: unknown }, _res: unknown, next: () => void) => {
      req.authUser = { id: 7 }; next();
    },
  },
});

const { default: router } = await import("../edgeDiscovery.js");

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { log: unknown }).log = { error: () => undefined }; next(); });
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

function journal(symbol: string, pnls: number[]): void {
  store["journal"] = [
    ...(store["journal"] ?? []),
    ...pnls.map((pnl) => ({ id: nextId++, userId: 7, symbol, strategy: null, direction: "BUY", emotionTag: null, pnl })),
  ];
}
async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Row> {
  const r = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, 200, `${method} ${path} → ${r.status}`);
  return (await r.json()) as Row;
}
type Report = { id: number; edgeName: string; status: string; profitFactor: number;
  confidenceScore: number; aiSummary: string; sampleSize: number; createdAt: string };

test("30 winning trades and no loss: profit factor is not measurable, never STRONG_EDGE or 'PF 999.00'", async () => {
  journal("EURUSD", Array.from({ length: 30 }, () => 10));
  const out = await call("POST", "/edge/reports", { groupBy: "symbol" });
  const [rep] = out["reports"] as Report[];
  assert.ok(rep, "a report is generated");
  assert.notEqual(rep.status, "STRONG_EDGE", "an unmeasured profit factor cannot qualify a slice as STRONG_EDGE");
  assert.doesNotMatch(rep.aiSummary, /999/, "the summary never prints the 999 marker");
  assert.match(rep.aiSummary, /no losing trade/i, "the summary says why the profit factor is unmeasured");
  assert.ok(rep.confidenceScore < 90, `confidence must not saturate on the marker (got ${rep.confidenceScore})`);
  const warns = store["warnings"] ?? [];
  assert.ok(warns.some((w) => w["warningType"] === "NO_LOSSES_RECORDED"), "a NO_LOSSES_RECORDED warning is stored");
  assert.ok(!warns.some((w) => w["warningType"] === "PROMISING_BUT_THIN"), "the marker never reads as a strong profit factor");
});

test("a legacy stored row with the 999 marker is presented with a measured-PF downgrade", async () => {
  store["reports"] = [{
    id: 900, userId: 7, edgeName: "symbol=GBPUSD", symbol: "GBPUSD", sampleSize: 40, winRate: 1,
    averageRr: 0, expectancy: 12, profitFactor: 999, confidenceScore: 100, status: "STRONG_EDGE",
    aiSummary: "GBPUSD: a measurable historical edge (PF 999.00, win rate 100%, 40 trades).",
    createdAt: new Date("2026-09-01T00:00:00Z"),
  }];
  for (const path of ["/edge/strongest", "/edge/reports"]) {
    const out = await call("GET", path);
    const [rep] = out["reports"] as Report[];
    assert.ok(rep, `${path} returns the slice`);
    assert.notEqual(rep.status, "STRONG_EDGE", `${path}: legacy marker row is not STRONG_EDGE`);
    assert.doesNotMatch(rep.aiSummary, /999/, `${path}: legacy summary is rewritten`);
    assert.ok(rep.confidenceScore < 90, `${path}: confidence recomputed without the marker`);
  }
});
