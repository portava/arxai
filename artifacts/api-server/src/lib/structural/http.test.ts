import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
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
    user = 17;
    assert.equal((await fetch(`${url}?symbol=NOT_A_MARKET`)).status, 400); assert.equal(invoked, 0);
    const history = await fetch(`${url}?symbol=V75`); assert.equal(history.status, 200); assert.deepEqual(await history.json(), { ok: true, forecasts: [] });
    const failure = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: "V75", userId: 999 }) });
    assert.equal(failure.status, 503); assert.deepEqual(await failure.json(), { ok: false, saved: false, reason: "FORECAST_UNAVAILABLE" });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
