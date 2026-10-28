// Heat replay "Key Events": "Heat rising" is reported only for an observed
// rise of >= 20 between consecutive snapshots.
//
// The previous condition `!prev || delta >= 20` fired for the first snapshot
// of every day regardless of its heat, so a cold open (heat 12, grade F) was
// listed as "Heat rising".
//
// Offline: the REAL router runs on loopback; only db.select is replaced so it
// answers with fixture snapshot rows (no database is contacted).

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@workspace/db";

type Snap = {
  id: number; symbol: string; timeframe: string; generatedAt: Date;
  heatScore: number; tradeabilityScore: number; edgeScore: number; dangerScore: number;
  trapProbability: number; roomToMove: number; timingGrade: string; entryPermission: string;
  heatState: string; moveStage: string; bestAction: string; broadFlowVerdict: string;
  newsPhase: string; dataQualityLabel: string;
};
let rows: Snap[] = [];

function chain(resolve: () => Promise<unknown>): unknown {
  const handler: ProxyHandler<() => void> = {
    get(_t, prop) {
      if (prop === "then") return (a: (v: unknown) => unknown, b: (e: unknown) => unknown) => resolve().then(a, b);
      if (prop === "catch") return (b: (e: unknown) => unknown) => resolve().catch(b);
      if (prop === "finally") return (f: () => void) => resolve().finally(f);
      return () => chain(resolve);
    },
  };
  return new Proxy(() => undefined, handler);
}
mock.method(db, "select", () => chain(async () => rows));

const { default: router } = await import("../meHeat.js");

function snap(id: number, at: string, heatScore: number): Snap {
  return {
    id, symbol: "EURUSD", timeframe: "M5", generatedAt: new Date(at), heatScore,
    tradeabilityScore: 40, edgeScore: 30, dangerScore: 20, trapProbability: 10, roomToMove: 50,
    timingGrade: "F", entryPermission: "WAIT", heatState: "COLD", moveStage: "EARLY",
    bestAction: "WAIT", broadFlowVerdict: "MIXED", newsPhase: "NONE", dataQualityLabel: "OK",
  };
}

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: { id: number } }).authUser = { id: 9 };
    next();
  });
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function events(): Promise<Array<{ type: string; at: string; heatScore: number }>> {
  const r = await fetch(`${base}/me/heat/replay?symbol=EURUSD&date=2026-10-27`);
  assert.equal(r.status, 200);
  const body = (await r.json()) as { replayEvents: Array<{ type: string; at: string; heatScore: number }> };
  return body.replayEvents;
}

test("a cold first snapshot is not reported as 'Heat rising'", async () => {
  rows = [snap(1, "2026-10-27T07:00:00Z", 12), snap(2, "2026-10-27T07:05:00Z", 14)];
  const ev = await events();
  assert.deepEqual(ev.filter((e) => e.type === "heat_rising"), []);
});

test("a measured rise of >= 20 between snapshots is still reported, at the later snapshot", async () => {
  rows = [snap(1, "2026-10-27T07:00:00Z", 12), snap(2, "2026-10-27T07:05:00Z", 40), snap(3, "2026-10-27T07:10:00Z", 45)];
  const rising = (await events()).filter((e) => e.type === "heat_rising");
  assert.equal(rising.length, 1);
  assert.equal(rising[0]!.heatScore, 40);
  assert.equal(rising[0]!.at, "2026-10-27T07:05:00.000Z");
});
