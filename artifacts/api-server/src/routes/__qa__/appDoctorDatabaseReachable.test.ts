// App Doctor health-summary: databaseReachable is the result of a real
// database ping, not the presence of DATABASE_URL.
//
// The previous handler answered `databaseReachable: true` whenever the env
// var was set, so the Status Command Center checklist showed the database as
// reachable while it was down. Here DATABASE_URL points at a closed loopback
// port (postgres://nobody@127.0.0.1:1/none): the REAL bounded `select 1`
// probe is refused locally, and the summary must not say "reachable".
// No database, broker or outside network is contacted.

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

process.env["DATABASE_URL"] ??= "postgres://nobody@127.0.0.1:1/none";
const { default: router } = await import("../appDoctor.js");

test("DATABASE_URL set but the database refuses connections: databaseReachable is false, with when it was checked", async () => {
  assert.ok(process.env["DATABASE_URL"], "the env var is present, as in the reported scenario");
  const app = express();
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const r = await fetch(`${base}/app/health-summary`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as Record<string, unknown>;
    assert.notEqual(body["databaseReachable"], true, "an unreachable database must never read as reachable");
    assert.equal(body["databaseReachable"], false);
    assert.equal(typeof body["databaseCheckedAt"], "string");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
