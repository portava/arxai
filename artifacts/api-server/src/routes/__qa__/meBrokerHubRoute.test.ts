// Broker Hub route proof — genuine sessions, real tenant-owned MT5 metadata.
//
// This is deliberately a GET-only harness. It proves the route projection
// cannot cross tenant boundaries, exposes no raw account/credential fields,
// and does not enqueue commands or write to the EA mailbox.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import cookieParser from "cookie-parser";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  arxSymbolSpecsTable,
  authUserSessionsTable,
  db,
  mt5CommandsTable,
  mt5ConnectionTable,
  usersTable,
} from "@workspace/db";
import { createUserSession } from "../../lib/auth/userSessions.js";
import meBrokerHubRouter from "../meBrokerHub.js";

const EMAIL_A = "qa+broker-hub-route-a@arx.test";
const EMAIL_B = "qa+broker-hub-route-b@arx.test";
const RAW_ACCOUNT_A = "111122223333";
const RAW_ACCOUNT_B = "999988887777";
const RAW_CREDENTIAL_A = "qa-secret-a-never-project";
const RAW_CREDENTIAL_B = "qa-secret-b-never-project";

let server: Server;
let base = "";
let userAId = 0;
let userBId = 0;
let connectionAId = 0;
let connectionBId = 0;
let cookieA = "";
let cookieB = "";
let commandsBefore = 0;

async function deleteFixtures(): Promise<void> {
  const users = await db.select({ id: usersTable.id }).from(usersTable)
    .where(inArray(usersTable.email, [EMAIL_A, EMAIL_B]));
  const userIds = users.map((user) => user.id);

  if (userIds.length > 0) {
    await db.delete(arxSymbolSpecsTable).where(inArray(arxSymbolSpecsTable.userId, userIds));
    await db.delete(authUserSessionsTable).where(inArray(authUserSessionsTable.userId, userIds));
    await db.delete(mt5ConnectionTable).where(inArray(mt5ConnectionTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
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

function request(path: string, cookie?: string): Promise<Response> {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return fetch(`${base}/api${path}`, { headers });
}

function endpoint(connectionId: number, suffix = ""): string {
  return `/me/broker-hub/connections/${connectionId}${suffix}`;
}

function assertNoSensitiveFields(body: unknown, rawAccount: string, otherRawAccount: string): void {
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(rawAccount), false, "raw account number must never be projected");
  assert.equal(serialized.includes(otherRawAccount), false, "other tenant account must never appear");
  assert.equal(serialized.includes(RAW_CREDENTIAL_A), false);
  assert.equal(serialized.includes(RAW_CREDENTIAL_B), false);
  assert.equal(serialized.includes("apiKeyHash"), false);
  assert.equal(serialized.includes("tokenLast4"), false);
  assert.equal(serialized.includes("accountNumber"), false);
}

before(async () => {
  process.env.ARX_BROKER_HUB_READONLY_ENABLED = "true";
  await deleteFixtures();

  const userA = await seedUser(EMAIL_A, "QA Broker Hub Owner A");
  const userB = await seedUser(EMAIL_B, "QA Broker Hub Owner B");
  userAId = userA.id;
  userBId = userB.id;
  cookieA = userA.cookie;
  cookieB = userB.cookie;

  const fresh = new Date();
  const stale = new Date(Date.now() - 10 * 60_000);
  const [connectionA, connectionB] = await db.insert(mt5ConnectionTable).values([
    {
      userId: userAId,
      status: "connected",
      accountNumber: RAW_ACCOUNT_A,
      brokerName: "Broker A",
      serverName: "BrokerA-Demo",
      accountCurrency: "USD",
      accountBalance: 12000,
      accountEquity: 11950,
      margin: 100,
      freeMargin: 11850,
      accountSyncedAt: fresh,
      lastHeartbeat: fresh,
      capabilities: { accountSnapshot: true },
      capabilitiesReportedAt: fresh,
      mode: "DEMO",
      accountType: "demo",
      apiKeyHash: RAW_CREDENTIAL_A,
    },
    {
      userId: userBId,
      status: "connected",
      accountNumber: RAW_ACCOUNT_B,
      brokerName: "Broker B",
      serverName: "BrokerB-Live",
      accountCurrency: "EUR",
      accountBalance: 22000,
      accountEquity: 21900,
      margin: 200,
      freeMargin: 21700,
      accountSyncedAt: fresh,
      lastHeartbeat: fresh,
      capabilities: { accountSnapshot: true },
      capabilitiesReportedAt: fresh,
      mode: "LIVE",
      accountType: "live",
      apiKeyHash: RAW_CREDENTIAL_B,
    },
  ]).returning({ id: mt5ConnectionTable.id });
  assert.ok(connectionA);
  assert.ok(connectionB);
  connectionAId = connectionA.id;
  connectionBId = connectionB.id;

  await db.insert(arxSymbolSpecsTable).values([
    {
      userId: userAId,
      bridgeConnectionId: connectionAId,
      symbol: "EURUSD",
      brokerSymbol: "EURUSD.a",
      displaySymbol: "EUR/USD A",
      tradeAllowed: true,
      digits: 5,
      point: 0.00001,
      minVolume: 0.01,
      maxVolume: 10,
      volumeStep: 0.01,
      snapshotAt: fresh,
      lastSeenAt: fresh,
      reportedAt: fresh,
      raw: { credential: RAW_CREDENTIAL_A },
    },
    {
      userId: userBId,
      bridgeConnectionId: connectionBId,
      symbol: "XAUUSD",
      brokerSymbol: "XAUUSD.b",
      displaySymbol: "Gold B",
      tradeAllowed: true,
      digits: 2,
      point: 0.01,
      minVolume: 0.1,
      maxVolume: 20,
      volumeStep: 0.1,
      snapshotAt: stale,
      lastSeenAt: stale,
      reportedAt: stale,
      raw: { credential: RAW_CREDENTIAL_B },
    },
  ]);

  const app = express();
  app.use(cookieParser());
  app.use("/api", meBrokerHubRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(mt5CommandsTable);
  commandsBefore = Number(count);
});

after(async () => {
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(mt5CommandsTable);
  assert.equal(Number(count), commandsBefore, "broker metadata GETs must not write MT5 commands");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await deleteFixtures();
  delete process.env.ARX_BROKER_HUB_READONLY_ENABLED;
});

test("each authenticated tenant sees only its own connection, account, capabilities, and discovery", async () => {
  for (const [cookie, ownId, foreignId, ownAccount, foreignAccount, ownBroker, ownSymbol] of [
    [cookieA, connectionAId, connectionBId, RAW_ACCOUNT_A, RAW_ACCOUNT_B, "Broker A", "EURUSD"] as const,
    [cookieB, connectionBId, connectionAId, RAW_ACCOUNT_B, RAW_ACCOUNT_A, "Broker B", "XAUUSD"] as const,
  ]) {
    const responses = await Promise.all([
      request(endpoint(ownId), cookie),
      request(endpoint(ownId, "/account"), cookie),
      request(endpoint(ownId, "/capabilities"), cookie),
      request(endpoint(ownId, "/instruments"), cookie),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as Array<Record<string, any>>;
    assert.equal(bodies[0].connectionId, ownId);
    assert.equal(bodies[1].brokerName, ownBroker);
    assert.equal(bodies[1].accountRefMasked.includes(ownAccount), false);
    assert.equal(bodies[3].instruments.every((instrument: { symbol: string }) => instrument.symbol === ownSymbol), true);
    for (const body of bodies) assertNoSensitiveFields(body, ownAccount, foreignAccount);

    const foreignResponses = await Promise.all([
      request(endpoint(foreignId), cookie),
      request(endpoint(foreignId, "/account"), cookie),
      request(endpoint(foreignId, "/capabilities"), cookie),
      request(endpoint(foreignId, "/instruments"), cookie),
    ]);
    assert.deepEqual(foreignResponses.map((response) => response.status), [404, 404, 404, 404]);
    for (const response of foreignResponses) {
      assert.deepEqual(await response.json(), { error: "NOT_FOUND" });
    }
  }
});

test("missing or stale EA discovery is reported as DISCOVERY_REQUIRED without leaking rows", async () => {
  const staleResponse = await request(endpoint(connectionBId, "/instruments"), cookieB);
  assert.equal(staleResponse.status, 200);
  assert.deepEqual(await staleResponse.json(), {
    venue: "MT5",
    connectionId: connectionBId,
    metadataEnabled: false,
    tradingEnabled: false,
    automationEnabled: false,
    canPlaceLiveTrade: false,
    discoveryStatus: "DISCOVERY_REQUIRED",
    instruments: [],
  });

  await db.delete(arxSymbolSpecsTable).where(and(
    eq(arxSymbolSpecsTable.userId, userBId),
    eq(arxSymbolSpecsTable.bridgeConnectionId, connectionBId),
  ));
  const missingResponse = await request(endpoint(connectionBId, "/instruments"), cookieB);
  assert.equal(missingResponse.status, 200);
  const missingBody = await missingResponse.json() as { discoveryStatus: string; instruments: unknown[] };
  assert.equal(missingBody.discoveryStatus, "DISCOVERY_REQUIRED");
  assert.deepEqual(missingBody.instruments, []);
});

test("anonymous callers cannot inspect broker metadata", async () => {
  const response = await request(endpoint(connectionAId));
  assert.equal(response.status, 401);
});