import { test, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { requireAuthOrPublic } from "../../lib/auth/globalGate.js";
import { enforceProductRoleAccess } from "../../lib/auth/productRole.js";

let ready = false;
mock.module("../../lib/startup/databaseReadiness.js", {
  namedExports: { checkDatabaseReadiness: async () => ({ status: ready ? "ready" : "unavailable", checkedAt: "2026-10-25T00:00:00.000Z" }) },
});
const router = (await import("../health.js")).default;

test("real health router separates liveness/readiness and keeps personal health authenticated", async () => {
  const app = express();
  app.use("/api", requireAuthOrPublic, enforceProductRoleAccess, router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    let response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { status: "unavailable", checkedAt: "2026-10-25T00:00:00.000Z" });
    response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, "ok");
    ready = true;
    response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, "ready");
    response = await fetch(`${base}/me/system-health`);
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error: string }).error, "AUTH_REQUIRED");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});
