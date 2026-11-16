// GET /me/timing-brain/:symbol honours ?timeframe and echoes it.
//
// Owner screenshot 2026-10-27: the 1m chart's timing chip showed an M15 grade
// because the client sent no timeframe and the route defaults to M15. The
// client now asks for the chart's timeframe and hides any read whose echoed
// `timeframe` differs. This pins the server half: a supported timeframe reaches
// the timing read unchanged and is echoed; an unsupported one (H8) silently
// falls back to M15 — which is exactly why the client must gate on the route's
// supported set and on the echo.
//
// Offline: the timing read cache and heat-alert emitter are module-mocked; the
// router is mounted on a loopback-only ephemeral port.

import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const seen: string[] = [];
mock.module("../../brain/timing/timingReadCache.js", {
  namedExports: {
    getCachedTimingRead: async (args: { symbol: string; timeframe: string }) => {
      seen.push(args.timeframe);
      return { symbol: args.symbol, timeframe: args.timeframe, timingGrade: "D", entryPermission: "WAIT_FOR_ENTRY" };
    },
  },
});
mock.module("../../lib/heat/heatAlertEmitter.js", {
  namedExports: { emitHeatAlerts: async () => undefined },
});

const { default: router } = await import("../timingBrain.js");

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authUser: { id: number } }).authUser = { id: 7 };
    next();
  });
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function get(path: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${base}${path}`);
  assert.equal(r.status, 200, `${path} → ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

test("?timeframe=M1 reaches the timing read as M1 and is echoed", async () => {
  seen.length = 0;
  const body = await get("/me/timing-brain/R_75?timeframe=M1");
  assert.deepEqual(seen, ["M1"]);
  assert.equal(body.timeframe, "M1");
});

test("no timeframe → M15 default (why the chart chip must send its own)", async () => {
  seen.length = 0;
  const body = await get("/me/timing-brain/R_75");
  assert.deepEqual(seen, ["M15"]);
  assert.equal(body.timeframe, "M15");
});

test("unsupported ?timeframe=H8 silently falls back to M15 (why the client gates on the echo)", async () => {
  seen.length = 0;
  const body = await get("/me/timing-brain/R_75?timeframe=H8");
  assert.deepEqual(seen, ["M15"]);
  assert.equal(body.timeframe, "M15");
});
