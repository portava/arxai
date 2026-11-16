// Stored economic calendar coverage — News Risk page, news-risk report and
// trading readiness.
//
// Every "upcoming events" read on these surfaces comes from the
// economic_events table, which only POST /economic-events/sync fills (no
// scheduler). A configured provider says nothing about what the table holds.
// The defect this locks: with a connected provider and a never-synced (or
// days-old) table, /economic-events/upcoming returned a bare empty list (the
// page said "No upcoming events" and showed no banner), the news-risk card
// read CLEAR, and readiness PASSed "No high-impact news conflict", while the
// Economic Calendar page's live path showed NFP in 30 minutes.
//
// Only the database handle and the safety/broker/news probes are stubbed;
// the real routers run. No network.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//        src/routes/__qa__/storedCalendarCoverage.test.ts

import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const database = await import("@workspace/db");

let storedCount = 0;
let storedLatest: Date | null = null;
let windowEvents: Array<Record<string, unknown>> = [];

function rowsFor(table: unknown, projected: boolean): unknown[] {
  if (table === database.economicEventsTable) {
    return projected ? [{ n: storedCount, latest: storedLatest }] : windowEvents;
  }
  if (table === database.newsRiskReportsTable) {
    return [{
      id: 3, userId: null, symbol: "EURUSD", relatedCurrency: null, eventId: null, riskLevel: "CLEAR",
      timeUntilEventMinutes: null, tradeWarning: null, aiSummary: "No scheduled event in window.",
      inputsSnapshot: null, createdAt: new Date(),
    }];
  }
  return [];
}
function chain(rows: () => unknown[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.where = self; q.orderBy = self; q.limit = self; q.groupBy = self;
  q.then = (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve().then(rows).then(resolve, reject);
  return q;
}
const fakeDb = {
  select: (fields?: unknown) => ({ from: (t: unknown) => chain(() => rowsFor(t, fields !== undefined)) }),
  insert: () => ({
    values: (v: Record<string, unknown>) => {
      const p = Promise.resolve(undefined) as Promise<undefined> & { returning?: () => Promise<unknown[]> };
      p.returning = async () => [{ id: 1, createdAt: new Date(), ...v }];
      return p;
    },
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const switches = await import("../../lib/safety/platformSwitches.js");
mock.module("../../lib/safety/platformSwitches.js", {
  namedExports: {
    ...switches,
    platformStop: async () => ({ engaged: false, sources: [] }),
    readSafetyCorePosture: async () => ({ present: false, readable: true, operationalMode: null }),
    stopSourceEngaged: () => false,
  },
});
const brokerHealth = await import("../../lib/brokerHub/brokerHealthState.js");
mock.module("../../lib/brokerHub/brokerHealthState.js", {
  namedExports: { ...brokerHealth, readLatestBrokerHealthLog: async () => ({ status: "OK" }) },
});
const heat = await import("../../lib/heat/marketHeatProviderStatus.js");
mock.module("../../lib/heat/marketHeatProviderStatus.js", {
  namedExports: {
    ...heat,
    readNewsProvider: async () => ({ connected: false, provider: "none", itemCount: 0, highImpactCount: 0, topHeadlines: [], updatedAt: null }),
  },
});

const { default: express } = await import("express");
const { default: newsRouter } = await import("../newsCalendar.js");
const { default: readinessRouter } = await import("../tradingReadiness.js");

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { authUser: unknown }).authUser = { id: 12, role: "USER" };
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(newsRouter);
  app.use(readinessRouter);
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(res.status, 200, `${method} ${path} → ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env["ECONOMIC_CALENDAR_PROVIDER"] = "trading_economics";
  process.env["TRADING_ECONOMICS_KEY"] = "te-key-coverage-test";
  storedCount = 0;
  storedLatest = null;
  windowEvents = [];
});
process.on("exit", () => { process.env = savedEnv; });

type Coverage = { windowCovered: boolean; storedEventCount: number; coveredThrough: string | null; providerConfigured: boolean; note: string | null };

test("never-synced table with a configured provider: upcoming says the window is not covered", async () => {
  const body = await call("GET", "/economic-events/upcoming?hours=24&minImpact=MEDIUM");
  assert.deepEqual(body["events"], []);
  const cov = body["calendarCoverage"] as Coverage;
  assert.ok(cov, "calendarCoverage is reported alongside the empty list");
  assert.equal(cov.providerConfigured, true);
  assert.equal(cov.storedEventCount, 0);
  assert.equal(cov.windowCovered, false);
  assert.match(String(cov.note), /never been synced/);
});

test("a table that ends before the window: not covered, and the note names how far it runs", async () => {
  storedCount = 40;
  storedLatest = new Date(Date.now() - 2 * 86400_000);
  const body = await call("GET", "/economic-events/upcoming?hours=24&minImpact=MEDIUM");
  const cov = body["calendarCoverage"] as Coverage;
  assert.equal(cov.windowCovered, false);
  assert.equal(cov.coveredThrough, storedLatest.toISOString());
  assert.match(String(cov.note), /only runs to/);
});

test("a table that reaches past the window: covered, so an empty list is a real 'no events'", async () => {
  storedCount = 40;
  storedLatest = new Date(Date.now() + 5 * 86400_000);
  const body = await call("GET", "/economic-events/upcoming?hours=24&minImpact=MEDIUM");
  const cov = body["calendarCoverage"] as Coverage;
  assert.equal(cov.windowCovered, true);
  assert.equal(cov.note, null);
});

test("news-risk/latest carries the stored-calendar coverage so a CLEAR from an empty table is not an all-clear", async () => {
  const body = await call("GET", "/news-risk/latest?symbol=EURUSD");
  assert.equal(body["riskLevel"], "CLEAR");
  const cov = body["calendarCoverage"] as Coverage;
  assert.equal(cov.windowCovered, false);
});

test("readiness does not PASS the news checks from an empty stored calendar", async () => {
  const body = await call("POST", "/readiness/checks", {
    sessionName: "London", strategyReady: true, riskRulesConfirmed: true,
    mentalState: 4, sleepQuality: 4, stressLevel: 2, confidenceLevel: 4,
  });
  const evaluation = (body["evaluation"] ?? (body["data"] as Record<string, unknown> | undefined)?.["evaluation"]) as Record<string, unknown>;
  assert.ok(evaluation, JSON.stringify(body).slice(0, 300));
  const checklist = evaluation["checklist"] as Array<{ id: string; status: string; detail: string }>;
  const news = checklist.find((c) => c.id === "news")!;
  const market = checklist.find((c) => c.id === "market")!;
  assert.notEqual(news.status, "PASS");
  assert.match(news.detail, /Not checked/);
  assert.notEqual(market.status, "PASS");
  assert.match(market.detail, /Not checked/);
  assert.equal(evaluation["newsRiskLevel"], "UNKNOWN");
});

test("readiness still PASSes the news checks when the stored calendar covers the window and it is empty", async () => {
  storedCount = 40;
  storedLatest = new Date(Date.now() + 5 * 86400_000);
  const body = await call("POST", "/readiness/checks", {
    sessionName: "London", strategyReady: true, riskRulesConfirmed: true,
    mentalState: 4, sleepQuality: 4, stressLevel: 2, confidenceLevel: 4,
  });
  const evaluation = (body["evaluation"] ?? (body["data"] as Record<string, unknown> | undefined)?.["evaluation"]) as Record<string, unknown>;
  const checklist = evaluation["checklist"] as Array<{ id: string; status: string }>;
  assert.equal(checklist.find((c) => c.id === "news")!.status, "PASS");
  assert.equal(checklist.find((c) => c.id === "market")!.status, "PASS");
  assert.equal(evaluation["newsRiskLevel"], "NONE");
});
