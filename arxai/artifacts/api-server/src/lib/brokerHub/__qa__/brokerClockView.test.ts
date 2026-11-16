// GET /me/broker-clock: the order window's "Today" expiry needs the trader's
// OWN bridge broker clock offset. DB-free: a real express app, the real feed
// scope binding, a fake auth user and an in-memory offset table.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import { brokerClockView, createBrokerClockHandler } from "../brokerClockView.js";
import { fixedFeedScope, runWithFeedScope } from "../../data/feedScope.js";
import type { BrokerClockOffset } from "../brokerClockOffset.js";
import type { BrokerClockView } from "../brokerClockView.js";

const MEASURED = Date.parse("2026-11-04T09:00:00Z");
const offsets = new Map<number, BrokerClockOffset>([
  [7, { offsetMs: 2 * 3600_000, measuredAtMs: MEASURED, agreeingSamples: 3, windowSamples: 3, basis: "heartbeat" }],
  [9, { offsetMs: -5 * 3600_000, measuredAtMs: MEASURED, agreeingSamples: 3, windowSamples: 3, basis: "heartbeat" }],
]);
const getOffset = (id: number) => offsets.get(id) ?? null;

test("brokerClockView: known, unknown and no-bridge", () => {
  assert.deepEqual(brokerClockView(7, getOffset), { bridgeConnectionId: 7, brokerClockOffsetMs: 7_200_000, brokerClockOffsetMeasuredAt: "2026-11-04T09:00:00.000Z" });
  assert.deepEqual(brokerClockView(8, getOffset), { bridgeConnectionId: 8, brokerClockOffsetMs: null, brokerClockOffsetMeasuredAt: null });
  assert.deepEqual(brokerClockView(null, getOffset), { bridgeConnectionId: null, brokerClockOffsetMs: null, brokerClockOffsetMeasuredAt: null });
});

async function withApp(bridgeByUser: Record<number, number | null>, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use((req, _res, next) => {
    const uid = Number(req.header("x-user"));
    if (Number.isFinite(uid) && uid > 0) (req as unknown as { authUser: { id: number } }).authUser = { id: uid };
    runWithFeedScope(fixedFeedScope(Number.isFinite(uid) ? bridgeByUser[uid] ?? null : null, uid || null), () => next());
  });
  app.get("/me/broker-clock", createBrokerClockHandler({ getOffset }));
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.close(); }
}

test("route: each trader gets only their own bridge's offset; a query bridge is ignored", async () => {
  await withApp({ 1: 7, 2: 9, 3: null }, async (base) => {
    const a = (await (await fetch(`${base}/me/broker-clock?bridgeConnectionId=9`, { headers: { "x-user": "1" } })).json()) as BrokerClockView;
    assert.equal(a.bridgeConnectionId, 7);
    assert.equal(a.brokerClockOffsetMs, 7_200_000);
    const b = (await (await fetch(`${base}/me/broker-clock`, { headers: { "x-user": "2" } })).json()) as BrokerClockView;
    assert.equal(b.bridgeConnectionId, 9);
    assert.equal(b.brokerClockOffsetMs, -18_000_000);
    const c = (await (await fetch(`${base}/me/broker-clock?bridgeConnectionId=7`, { headers: { "x-user": "3" } })).json()) as BrokerClockView;
    assert.deepEqual(c, { bridgeConnectionId: null, brokerClockOffsetMs: null, brokerClockOffsetMeasuredAt: null });
  });
});

test("route: anonymous is refused", async () => {
  await withApp({}, async (base) => {
    const r = await fetch(`${base}/me/broker-clock`);
    assert.equal(r.status, 401);
  });
});
