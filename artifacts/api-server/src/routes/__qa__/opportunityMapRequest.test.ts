// Actual HTTP route + auth gate + timeframe parsing. Market work is isolated.
import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { User } from "@workspace/db";
import type { OpportunityMapArgs } from "../../lib/signalIntelligence/opportunityMapService.js";

const calls: OpportunityMapArgs[] = [];
const realCache = await import("../../lib/signalIntelligence/opportunityMapReadCache.js");
mock.module("../../lib/signalIntelligence/opportunityMapReadCache.js", { namedExports: { ...realCache,
  getCachedOpportunityMap: async (args: OpportunityMapArgs) => { calls.push({ ...args }); return { timeframe: args.timeframe ?? "M5", universe: args.universe }; },
} });
const { default: router } = await import("../meScalp.js");
let server: Server, base: string;
before(async () => {
  const app = express();
  app.use((req, _res, next) => { if (req.headers["x-test-signed-in"] === "yes") req.authUser = { id: 1, role: "USER" } as User; next(); });
  app.use("/api", router);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", (err?: Error) => err ? reject(err) : resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/me/opportunity-map`;
});
after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});
beforeEach(() => { calls.length = 0; });
const read = (query: string) => fetch(base + query, { headers: { "x-test-signed-in": "yes" } });

test("unsupported, empty and repeated timeframes return 400 without scheduling a scan", async () => {
  for (const query of ["?timeframe=M7", "?timeframe=", "?timeframe=%20%20", "?timeframe=M5&timeframe=H1"]) {
    const response = await read(query);
    assert.equal(response.status, 400, query);
    assert.equal(typeof (await response.json() as { error: unknown }).error, "string");
  }
  assert.equal(calls.length, 0);
});

test("supported aliases are canonical before scheduling and preserve selected symbol composition input", async () => {
  for (const alias of ["M5", "5m", "m5"]) {
    const response = await read(`?marketGroup=forex&timeframe=${alias}&selectedSymbol=EURUSD`);
    assert.equal(response.status, 200); assert.equal((await response.json() as { timeframe: unknown }).timeframe, "M5");
  }
  assert.ok(calls.every((args) => args.timeframe === "M5" && args.universe === "forex" && args.selectedSymbol === "EURUSD"));
});

test("the six public groups and omitted timeframe remain supported; internal full group stays private", async () => {
  for (const group of ["all", "forex", "metals", "indices", "crypto", "synthetic"]) {
    const response = await read(`?marketGroup=${group}`);
    assert.equal(response.status, 200); assert.equal((await response.json() as { timeframe: unknown }).timeframe, "M5");
  }
  assert.equal(calls.length, 6);
  assert.equal((await read("?marketGroup=full")).status, 400);
  assert.equal(calls.length, 6);
});

test("an unsigned caller still receives 401 before any scan", async () => {
  assert.equal((await fetch(base + "?timeframe=M5")).status, 401);
  assert.equal(calls.length, 0);
});
