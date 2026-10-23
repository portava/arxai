// Broker read-only ownership boundary — real DB + genuine session route proof.
//
// This test seeds two authenticated users, one snapshot/log per user, and
// ownerless legacy rows. It proves list/status/create routes are scoped to the
// authenticated owner, legacy rows are invisible, response DTOs omit userId,
// and sensitive account/provider-error fixture content is redacted.
//
// Run: pnpm --filter @workspace/api-server run test:broker-readonly-route

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { and, eq, inArray } from "drizzle-orm";
import {
  authUserSessionsTable,
  brokerReadonlyLogsTable,
  brokerReadonlySnapshotsTable,
  db,
  usersTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import brokerReadOnlyRouter from "../brokerReadOnly.js";

const EMAIL_A = "qa+broker-readonly-a@arx.test";
const EMAIL_B = "qa+broker-readonly-b@arx.test";
const SNAPSHOT_A = "bsnp_qa_owner_a";
const SNAPSHOT_B = "bsnp_qa_owner_b";
const SNAPSHOT_LEGACY = "bsnp_qa_legacy_unknown";
const CONNECTOR_A = "bcon_qa_owner_a";
const CONNECTOR_B = "bcon_qa_owner_b";
const CONNECTOR_LEGACY = "bcon_qa_legacy_unknown";
const RAW_ACCOUNT_A = "111122223333";
const RAW_ACCOUNT_B = "999988887777";
const RAW_PROVIDER_SECRET = "sk_live_PROVIDERSECRET123";

let server: Server;
let base = "";
let userAId = 0;
let userBId = 0;
let cookieA = "";
let cookieB = "";

async function deleteFixtures(): Promise<void> {
  await db.delete(brokerReadonlyLogsTable).where(
    inArray(brokerReadonlyLogsTable.connectorId, [CONNECTOR_A, CONNECTOR_B, CONNECTOR_LEGACY]),
  );
  await db.delete(brokerReadonlySnapshotsTable).where(
    inArray(brokerReadonlySnapshotsTable.snapshotId, [SNAPSHOT_A, SNAPSHOT_B, SNAPSHOT_LEGACY]),
  );

  const users = await db.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.email, [EMAIL_A, EMAIL_B]));
  for (const user of users) {
    await db.delete(brokerReadonlyLogsTable).where(eq(brokerReadonlyLogsTable.userId, user.id));
    await db.delete(brokerReadonlySnapshotsTable).where(eq(brokerReadonlySnapshotsTable.userId, user.id));
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, user.id));
    await db.delete(usersTable).where(eq(usersTable.id, user.id));
  }
}

async function seedUser(email: string, name: string): Promise<{ id: number; cookie: string }> {
  const [user] = await db.insert(usersTable)
    .values({ email, name, role: "ADMIN", isSystemUser: true })
    .returning({ id: usersTable.id });
  assert.ok(user);
  const { rawToken } = await createUserSession({ userId: user.id });
  return { id: user.id, cookie: `arx_user_session=${rawToken}` };
}

function request(path: string, cookie?: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${base}/api${path}`, { ...init, headers });
}

before(async () => {
  await deleteFixtures();
  const a = await seedUser(EMAIL_A, "QA Broker Owner A");
  const b = await seedUser(EMAIL_B, "QA Broker Owner B");
  userAId = a.id;
  userBId = b.id;
  cookieA = a.cookie;
  cookieB = b.cookie;

  const commonSnapshot = {
    mode: "READ_ONLY",
    provider: "demo",
    connected: true,
    symbols: [],
    openPositions: [],
    latestQuotes: [],
    dataQuality: { status: "GOOD", latencyMs: 1, warnings: [], errors: [] },
    liveTradingAllowed: false,
    canPlaceLiveTrade: false,
  };
  await db.insert(brokerReadonlySnapshotsTable).values([
    { ...commonSnapshot, userId: userAId, snapshotId: SNAPSHOT_A, accountMasked: { accountNumber: RAW_ACCOUNT_A } },
    { ...commonSnapshot, userId: userBId, snapshotId: SNAPSHOT_B, accountMasked: { accountNumber: RAW_ACCOUNT_B } },
    { ...commonSnapshot, userId: null, snapshotId: SNAPSHOT_LEGACY, accountMasked: { accountNumber: "555566667777" } },
  ]);

  await db.insert(brokerReadonlyLogsTable).values([
    {
      userId: userAId,
      connectorId: CONNECTOR_A,
      eventType: "PROVIDER_ERROR",
      severity: "ERROR",
      message: `Provider failed with ${RAW_PROVIDER_SECRET}`,
      details: { providerError: `token ${RAW_PROVIDER_SECRET}`, accountNumber: RAW_ACCOUNT_A },
    },
    {
      userId: userBId,
      connectorId: CONNECTOR_B,
      eventType: "READ_ONLY_VERIFIED",
      severity: "INFO",
      message: "B-only diagnostic",
      details: { accountNumber: RAW_ACCOUNT_B },
    },
    {
      userId: null,
      connectorId: CONNECTOR_LEGACY,
      eventType: "READ_ONLY_VERIFIED",
      severity: "INFO",
      message: "Legacy ownerless diagnostic",
      details: {},
    },
  ]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", brokerReadOnlyRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteFixtures();
});

test("the entire broker-readonly namespace rejects anonymous callers", async () => {
  const results = await Promise.all([
    request("/broker-readonly/status"),
    request("/broker-readonly/snapshots"),
    request("/broker-readonly/logs"),
    request("/broker-readonly/demo", undefined, { method: "POST" }),
  ]);
  assert.deepEqual(results.map((r) => r.status), [401, 401, 401, 401]);
});

test("user A cannot list user B or legacy ownerless snapshots", async () => {
  const response = await request("/broker-readonly/snapshots?limit=100", cookieA);
  assert.equal(response.status, 200);
  const body = await response.json() as { snapshots: Array<Record<string, unknown>> };
  const serialized = JSON.stringify(body);
  assert.equal(body.snapshots.some((row) => row.snapshotId === SNAPSHOT_A), true);
  assert.equal(body.snapshots.some((row) => row.snapshotId === SNAPSHOT_B), false);
  assert.equal(body.snapshots.some((row) => row.snapshotId === SNAPSHOT_LEGACY), false);
  assert.equal(body.snapshots.every((row) => !("userId" in row)), true);
  assert.equal(serialized.includes(RAW_ACCOUNT_A), false, "raw account identifiers must be masked");
  assert.equal(serialized.includes(RAW_ACCOUNT_B), false, "other-user account identifiers must never appear");
});

test("user B cannot list user A or legacy ownerless snapshots", async () => {
  const response = await request("/broker-readonly/snapshots?limit=100", cookieB);
  assert.equal(response.status, 200);
  const body = await response.json() as { snapshots: Array<Record<string, unknown>> };
  assert.equal(body.snapshots.some((row) => row.snapshotId === SNAPSHOT_B), true);
  assert.equal(body.snapshots.some((row) => row.snapshotId === SNAPSHOT_A), false);
  assert.equal(body.snapshots.some((row) => row.snapshotId === SNAPSHOT_LEGACY), false);
  assert.equal(body.snapshots.every((row) => !("userId" in row)), true);
});

test("logs are owner-scoped and redacted again at the response boundary", async () => {
  const response = await request("/broker-readonly/logs?limit=500", cookieA);
  assert.equal(response.status, 200);
  const body = await response.json() as { logs: Array<Record<string, unknown>> };
  const serialized = JSON.stringify(body);
  assert.equal(body.logs.some((row) => row.connectorId === CONNECTOR_A), true);
  assert.equal(body.logs.some((row) => row.connectorId === CONNECTOR_B), false);
  assert.equal(body.logs.some((row) => row.connectorId === CONNECTOR_LEGACY), false);
  assert.equal(body.logs.every((row) => !("userId" in row)), true);
  assert.equal(serialized.includes(RAW_PROVIDER_SECRET), false);
  assert.equal(serialized.includes(RAW_ACCOUNT_A), false);
});

test("status is based only on the authenticated owner's latest snapshot", async () => {
  const [aResponse, bResponse] = await Promise.all([
    request("/broker-readonly/status", cookieA),
    request("/broker-readonly/status", cookieB),
  ]);
  assert.equal(aResponse.status, 200);
  assert.equal(bResponse.status, 200);
  const a = await aResponse.json() as { status: { lastProvider: string | null; lastConnected: boolean } };
  const b = await bResponse.json() as { status: { lastProvider: string | null; lastConnected: boolean } };
  assert.equal(a.status.lastProvider, "demo");
  assert.equal(a.status.lastConnected, true);
  assert.equal(b.status.lastProvider, "demo");
  assert.equal(b.status.lastConnected, true);
});

test("a created demo snapshot and every associated log are stamped with user A", async () => {
  const response = await request("/broker-readonly/demo", cookieA, { method: "POST" });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    snapshot: { snapshot_id?: string; connector_id: string; liveTradingAllowed: boolean; canPlaceLiveTrade: boolean };
  };
  assert.ok(body.snapshot.snapshot_id);
  assert.equal(body.snapshot.liveTradingAllowed, false);
  assert.equal(body.snapshot.canPlaceLiveTrade, false);

  const [persisted] = await db.select({
    userId: brokerReadonlySnapshotsTable.userId,
  }).from(brokerReadonlySnapshotsTable)
    .where(eq(brokerReadonlySnapshotsTable.snapshotId, body.snapshot.snapshot_id!))
    .limit(1);
  assert.equal(persisted?.userId, userAId);

  const logs = await db.select({ userId: brokerReadonlyLogsTable.userId })
    .from(brokerReadonlyLogsTable)
    .where(and(
      eq(brokerReadonlyLogsTable.connectorId, body.snapshot.connector_id),
      eq(brokerReadonlyLogsTable.userId, userAId),
    ));
  assert.ok(logs.length > 0);
  assert.equal(logs.every((row) => row.userId === userAId), true);

  const bList = await request("/broker-readonly/snapshots?limit=100", cookieB);
  const bBody = await bList.json() as { snapshots: Array<{ snapshotId: string }> };
  assert.equal(bBody.snapshots.some((row) => row.snapshotId === body.snapshot.snapshot_id), false);
});

test("effective non-operator role is denied even with a valid session", async () => {
  await db.update(usersTable).set({ role: "USER" }).where(eq(usersTable.id, userBId));
  try {
    const results = await Promise.all([
      request("/broker-readonly/status", cookieB),
      request("/broker-readonly/account", cookieB),
      request("/broker-readonly/snapshots", cookieB),
      request("/broker-readonly/logs", cookieB),
      request("/broker-readonly/demo", cookieB, { method: "POST" }),
    ]);
    assert.deepEqual(results.map((r) => r.status), [403, 403, 403, 403, 403]);
  } finally {
    await db.update(usersTable).set({ role: "ADMIN" }).where(eq(usersTable.id, userBId));
  }
});