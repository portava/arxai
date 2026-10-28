// Sniper Watchlist says which open trades it actually scanned.
//
// For USER_OWNED_MT5 the route reads open positions with the literal venue
// "DEMO", so a user holding LIVE positions got "None of your open trades are
// flagged … The engine watches your trades continuously" about trades it never
// read. The response must name the scanned venue and count the LIVE open
// positions it did not evaluate, so the page can say so.
//
// Offline: the envelope and open-position reader are module-mocked; the
// router is mounted on loopback.

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const calls: Array<{ venue: string; basis?: string }> = [];
let liveRows = 2;
let liveFails = false;
mock.module("../../lib/adminTrading/safetyEnvelope.js", {
  namedExports: {
    getEnvelope: async () => ({ accountRoutingMode: "USER_OWNED_MT5", accountType: "live" }),
  },
});
mock.module("../../lib/positions/openPositions.js", {
  namedExports: {
    readOpenPositions: async (opts: { venue: string; basis?: string }) => {
      calls.push({ venue: opts.venue, basis: opts.basis });
      if (opts.venue === "LIVE") {
        if (liveFails) throw new Error("ledger down (fixture)");
        return Array.from({ length: liveRows }, (_, i) => ({ venue: "LIVE", id: 100 + i }));
      }
      return [];
    },
  },
});

const { default: router } = await import("../meTradeIntelligence.js");

let server: Server;
let base: string;
before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: { id: number } }).authUser = { id: 9 };
    (req as unknown as { log: unknown }).log = { error: () => undefined };
    next();
  });
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function get(): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}/me/sniper-watchlist`);
  assert.equal(r.status, 200);
  return (await r.json()) as Record<string, unknown>;
}

test("USER_OWNED_MT5 with live positions: the response says LIVE was not scanned and how many", async () => {
  calls.length = 0; liveRows = 2; liveFails = false;
  const body = await get();
  assert.ok(calls.some((c) => c.venue === "LIVE"), `the LIVE venue must at least be read (calls: ${JSON.stringify(calls)})`);
  assert.deepEqual(body["scannedVenues"], ["DEMO"]);
  assert.deepEqual(body["notScanned"], { venue: "LIVE", openPositions: 2 });
});

test("an unreadable LIVE ledger is reported as unknown, not zero", async () => {
  calls.length = 0; liveFails = true;
  const body = await get();
  assert.deepEqual(body["notScanned"], { venue: "LIVE", openPositions: null });
});

test("no live positions: nothing is reported as unscanned", async () => {
  calls.length = 0; liveRows = 0; liveFails = false;
  const body = await get();
  assert.deepEqual(body["notScanned"], { venue: "LIVE", openPositions: 0 });
  assert.equal(body["scannedCount"], 0);
});
