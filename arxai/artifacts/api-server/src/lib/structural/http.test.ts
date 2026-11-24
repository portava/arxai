import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { StoredForecast } from "./service.js";
import type { reportAtiSpecialists } from "./atiSpecialistReport.js";
import type { reportAtiSpecialistCosts } from "./atiSpecialistCosts.js";
import type { reportAtiStructuralValidation } from "./atiValidationReport.js";
process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline";
const { createStructuralForecastRouter } = await import("../../routes/structuralForecasts.js");

test("HTTP forecast routes enforce authentication, symbol validation and user identity", async () => {
  let invoked = 0, user: number | undefined;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { if (user) req.authUser = { id: user } as NonNullable<typeof req.authUser>; next(); });
  app.use(createStructuralForecastRouter({
    async issue(userId, symbol) { invoked++; assert.equal(userId, 17); assert.equal(symbol, "V75"); throw new Error("secret database connection details"); },
    async history(userId) { invoked++; assert.equal(userId, 17); return []; },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/me/structural/forecasts`;
  try {
    assert.equal((await fetch(`${url}?symbol=V75`)).status, 401); assert.equal(invoked, 0);
    const opsUrl = url + "/structural-" + "a".repeat(64) + "/operations";
    assert.equal((await fetch(opsUrl)).status, 401);
    user = 17;
    assert.equal((await fetch(url + "/invalid/operations")).status, 400);
    assert.equal((await fetch(opsUrl + "?asOf=2099-01-01T00:00:00Z")).status, 400);
    assert.equal((await fetch(`${url}?symbol=NOT_A_MARKET`)).status, 400); assert.equal(invoked, 0);
    const history = await fetch(`${url}?symbol=V75`); assert.equal(history.status, 200); assert.deepEqual(await history.json(), { ok: true, forecasts: [] });
    const ati = await (await fetch(`${url}?symbol=V75&atiValidation=1&userId=999`)).json() as {
      atiValidation: ReturnType<typeof reportAtiStructuralValidation>;
    };
    assert.deepEqual(ati.atiValidation.scope, { historyLimit: 250, receiptsRead: 0, atHistoryLimit: false });
    assert.deepEqual(ati.atiValidation.cohorts, []);
    const specialists = await (await fetch(url + "?symbol=V75&atiSpecialists=1&atiSpecialistCosts=1&userId=999")).json() as {
      atiSpecialists: ReturnType<typeof reportAtiSpecialists>; atiSpecialistCosts: Awaited<ReturnType<typeof reportAtiSpecialistCosts>>;
    };
    assert.deepEqual(specialists.atiSpecialists.cohorts, []);
    assert.deepEqual(specialists.atiSpecialistCosts.cohorts, []);
    assert.equal(specialists.atiSpecialistCosts.costBasis.observedBrokerCharges, null);
    const failure = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: "V75", userId: 999 }) });
    assert.equal(failure.status, 503); assert.deepEqual(await failure.json(), { ok: false, saved: false, reason: "FORECAST_UNAVAILABLE" });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("history and same-candle reissues expose only published paper instructions", async () => {
  const archived = { id: "old", issuedAt: 1000, scores: [], forecast: {
    paperInstruction: { action: "BUY", reference: 100, stop: 99, target: 102, reason: "Breakout" },
    horizons: [{ minutes: 15, probabilities: [.6,.3,.1] }],
  }} as unknown as StoredForecast;
  const published = { ...archived, id: "issued", paperPublishedAt: 1001 };
  const app = express();
  app.use(express.json(), (req, _res, next) => { req.authUser = { id: 17 } as NonNullable<typeof req.authUser>; next(); });
  app.use(createStructuralForecastRouter({ async issue() { return archived; }, async history() { return [archived, published]; } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/me/structural/forecasts`;
  try {
    const { forecasts } = await (await fetch(url + "?symbol=V75")).json() as { forecasts: StoredForecast[] };
    assert.equal(forecasts[0]?.forecast.paperInstruction?.action, "HOLD");
    assert.deepEqual(forecasts[1], published);
    const again = await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: "V75" }) })).json() as StoredForecast;
    assert.deepEqual(again.forecast.paperInstruction, forecasts[0]?.forecast.paperInstruction);
    assert.deepEqual(again.forecast.horizons, archived.forecast.horizons);
    assert.equal(archived.forecast.paperInstruction?.action, "BUY");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
