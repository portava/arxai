// The evidence-gate IO adapters and route, EXECUTED — not string-grepped.
//
// WHY THIS FILE EXISTS
// --------------------
// The honesty guarantee behind both held flags is "an unreadable source is a
// typed null with a reason, NEVER a confident zero". Until this suite, that
// guarantee was proven only at the pure engines, which were handed
// `records: null` / `evidence: null` directly by the test. The adapters that
// DECIDE to pass null — the two try/catch blocks that turn a database outage
// into that null — and the route that serves them had zero executed
// coverage. Softening either catch to `{ ok: true, records: [] }` would have
// rendered an outage as "sample 0 — NO PRODUCTION WRITER", the exact
// reassuring-when-unknown failure the spine forbids, with every other test
// still green.
//
// So this file runs the real adapters and the real route handlers against a
// fake `@workspace/db` whose query builder can be made to THROW, and asserts
// the outage surfaces as SOURCE_UNREADABLE with `sampleSize: null`.
//
// SAFETY: the fake db exposes `select` only. There is no insert/update/delete
// to call even by accident, and a report path that tried one would fail with
// "not a function" rather than writing anything. No press is taken anywhere:
// the route registers GETs, and the assertions below re-check that producing
// a report leaves ARX_CONFORMAL_GATE_ENABLED exactly as it found it.
//
// Run: pnpm --filter @workspace/api-server run test:evidence-gate-source-io

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import * as schema from "@workspace/db/schema";

// ── The fake database ───────────────────────────────────────────────────────
//
// Keyed by the REAL drizzle table object, so `eq(...)` / `desc(...)` in the
// adapters run against real columns and the builder chain is exercised as
// written. Only `.select()` exists.

type Behavior = { rows: unknown[] } | { throws: Error };

const behavior = new Map<unknown, Behavior>();

function setRows(table: unknown, rows: unknown[]): void {
  behavior.set(table, { rows });
}
function setThrows(table: unknown, err: Error): void {
  behavior.set(table, { throws: err });
}
function resetDb(): void {
  behavior.clear();
  setRows(schema.auditEventsTable, []);
  setRows(schema.executionPolicyPromotionsTable, []);
}

const fakeDb = {
  select(_fields?: unknown) {
    let table: unknown = null;
    const builder = {
      from(t: unknown) {
        table = t;
        return builder;
      },
      where(_w?: unknown) {
        return builder;
      },
      orderBy(_o?: unknown) {
        return builder;
      },
      limit(_n?: number): Promise<unknown[]> {
        const b = behavior.get(table);
        if (b && "throws" in b) return Promise.reject(b.throws);
        return Promise.resolve(b ? b.rows : []);
      },
    };
    return builder;
  },
};

resetDb();

mock.module("@workspace/db", {
  namedExports: { ...schema, db: fakeDb, pool: {} },
});

// Imported AFTER the mock is registered, so the adapters bind to the fake.
const { buildConformalCoverageReportFromJournal, loadConformalAdvisoryRecords } = await import(
  "../conformal/conformalCoverageSource.js"
);
const { buildPromotionReportFromJournal } = await import(
  "../execution/executionPolicyPromotionReport.js"
);
const evidenceGatesRouter = (await import("../../routes/adminEvidenceGates.js")).default;

// ── Route harness (no socket — the handlers are called directly) ────────────

interface Captured {
  statusCode: number;
  body: Record<string, unknown>;
}

function handlerFor(routePath: string): (req: Request, res: Response) => Promise<void> {
  const layer = (
    evidenceGatesRouter as unknown as {
      stack: { route?: { path: string; stack: { handle: unknown }[] } }[];
    }
  ).stack.find((l) => l.route?.path === routePath);
  assert.ok(layer?.route, `no route registered at ${routePath}`);
  return layer.route.stack[0]!.handle as (req: Request, res: Response) => Promise<void>;
}

async function callRoute(
  routePath: string,
  authUser: { id: number; role?: string } | undefined,
): Promise<Captured> {
  const captured: Captured = { statusCode: 200, body: {} };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return res;
    },
  };
  await handlerFor(routePath)(
    { authUser } as unknown as Request,
    res as unknown as Response,
  );
  return captured;
}

const CONFORMAL_PATH = "/admin/evidence-gates/conformal-coverage";
const PROMOTION_PATH = "/admin/evidence-gates/execution-policy-promotion";

// ── 1. THE CENTRAL GUARANTEE, END TO END: outage ≠ zero ─────────────────────

test("a database outage renders as SOURCE_UNREADABLE with sampleSize null — never sample 0", async () => {
  resetDb();
  setThrows(schema.auditEventsTable, new Error("ECONNREFUSED 127.0.0.1:5432"));

  const report = await buildConformalCoverageReportFromJournal(Date.UTC(2026, 7, 29));

  assert.equal(report.verdict, "SOURCE_UNREADABLE");
  assert.equal(report.sampleSize, null, "an outage rendered as a sample — the spine forbids it");
  assert.equal(report.feed.rowsRead, null);
  assert.match(report.feed.sourceError ?? "", /ECONNREFUSED/);
  assert.equal(report.barMet, false);
  assert.equal(report.ownerPress.available, false);
  assert.equal(report.coverage.empirical, null);
  // And the verdict is NOT the reassuring "nothing there, no writer" reading.
  assert.doesNotMatch(report.verdictReason, /no labeled advisory predictions/);
});

test("the adapter's failure is a TYPED null with a reason, not an empty array", async () => {
  resetDb();
  setThrows(schema.auditEventsTable, new Error("relation does not exist"));
  const failed = await loadConformalAdvisoryRecords();
  assert.equal(failed.ok, false);
  assert.ok(!("records" in failed), "a failed read must not carry a records array at all");
  assert.match(failed.reason, /journal read failed/);
  assert.match(failed.reason, /relation does not exist/);

  // The success shape is genuinely different — an empty feed reads fine.
  resetDb();
  const empty = await loadConformalAdvisoryRecords();
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.ok && empty.records, []);
  assert.equal(empty.ok && empty.rowsSeen, 0);
});

test("an outage on the shadow journal renders as SOURCE_UNREADABLE too", async () => {
  resetDb();
  setThrows(schema.auditEventsTable, new Error("connection terminated unexpectedly"));

  const report = await buildPromotionReportFromJournal(Date.UTC(2026, 7, 29));

  assert.equal(report.verdict, "SOURCE_UNREADABLE");
  assert.equal(report.sampleSize, null);
  assert.equal(report.feed.rowsRead, null);
  assert.match(report.feed.sourceError ?? "", /connection terminated/);
  assert.equal(report.fillQuality.qualifyingCount, null);
  assert.equal(report.ownerPress.available, false);
});

test("an unreadable LADDER row is null, and does not fake a SHADOW status", async () => {
  resetDb();
  setThrows(schema.executionPolicyPromotionsTable, new Error("42P01 missing table"));

  const report = await buildPromotionReportFromJournal(Date.UTC(2026, 7, 29));

  assert.equal(report.promotion.currentStatus, null, "'could not look' is not 'SHADOW'");
  assert.match(report.promotion.statusReadError ?? "", /table does not exist|missing table/);
  // The journal itself read fine, so the sample is an honest 0, not null.
  assert.equal(report.sampleSize, 0);
  assert.equal(report.verdict, "INSUFFICIENT_HISTORY");
});

// ── 2. A READABLE, EMPTY FEED IS A DIFFERENT FACT ───────────────────────────

test("an empty-but-readable feed reads INSUFFICIENT_HISTORY at a sample of 0", async () => {
  resetDb();
  const report = await buildConformalCoverageReportFromJournal(Date.UTC(2026, 7, 29));
  assert.equal(report.verdict, "INSUFFICIENT_HISTORY");
  assert.equal(report.sampleSize, 0, "a clean read of an empty feed IS a sample of 0");
  assert.equal(report.feed.rowsRead, 0);
  assert.equal(report.feed.sourceError, null);
  assert.equal(report.feed.writerWired, false);
  assert.match(report.verdictReason, /will not accumulate on its own/);
});

test("the adapter parses real journal payloads and excludes the unreadable ones", async () => {
  resetDb();
  setRows(schema.auditEventsTable, [
    { payload: { predicted: 1, actual: 1.2, predictedAt: "2026-08-01T00:00:00.000Z" } },
    { payload: { predicted: 2, actual: 2.1, predictedAt: "2026-08-02T00:00:00.000Z" } },
    { payload: { predicted: 3 } }, // no outcome yet — excluded, never guessed
    { payload: null }, // unreadable — excluded, never guessed
  ]);

  const loaded = await loadConformalAdvisoryRecords();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.ok && loaded.rowsSeen, 4);
  assert.equal(loaded.ok && loaded.records.length, 2);
  assert.equal(loaded.ok && loaded.unreadableRows, 2);

  const report = await buildConformalCoverageReportFromJournal(Date.UTC(2026, 7, 29));
  assert.equal(report.sampleSize, 2, "sampleSize counts the READABLE records");
  assert.equal(report.feed.unreadableRows, 2);
  assert.equal(report.verdict, "INSUFFICIENT_HISTORY");
  assert.equal(report.coverage.empirical, null, "2 records must not produce a coverage number");
  assert.ok(report.window, "a real sample must state the window it spans");
});

// ── 3. THE ROUTE IS ADMIN-GATED — executed, not grepped ─────────────────────

test("anonymous callers get 401 and no report body", async () => {
  resetDb();
  for (const p of [CONFORMAL_PATH, PROMOTION_PATH]) {
    const r = await callRoute(p, undefined);
    assert.equal(r.statusCode, 401, `${p} did not refuse an anonymous caller`);
    assert.equal(r.body.error, "AUTH_REQUIRED");
    assert.equal(r.body.report, undefined, "a refused call leaked a report");
  }
});

test("a signed-in NON-admin gets 403 and no report body", async () => {
  resetDb();
  for (const p of [CONFORMAL_PATH, PROMOTION_PATH]) {
    const r = await callRoute(p, { id: 7, role: "USER" });
    assert.equal(r.statusCode, 403, `${p} served a non-admin`);
    assert.equal(r.body.error, "ADMIN_REQUIRED");
    assert.equal(r.body.report, undefined);
  }
  // A session with no role at all is not an admin either.
  const noRole = await callRoute(CONFORMAL_PATH, { id: 7 });
  assert.equal(noRole.statusCode, 403);
});

test("ADMIN and OWNER are served a read-only report", async () => {
  resetDb();
  for (const role of ["ADMIN", "OWNER"]) {
    for (const p of [CONFORMAL_PATH, PROMOTION_PATH]) {
      const r = await callRoute(p, { id: 1, role });
      assert.equal(r.statusCode, 200, `${role} was refused ${p}`);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.readOnly, true);
      const report = r.body.report as { readOnly: boolean; verdict: string; barMet: boolean };
      assert.equal(report.readOnly, true);
      assert.equal(report.verdict, "INSUFFICIENT_HISTORY");
      assert.equal(report.barMet, false);
    }
  }
});

test("an outage reaches the admin as SOURCE_UNREADABLE, not as a 200 with sample 0", async () => {
  resetDb();
  setThrows(schema.auditEventsTable, new Error("ECONNREFUSED"));
  const r = await callRoute(CONFORMAL_PATH, { id: 1, role: "ADMIN" });
  assert.equal(r.statusCode, 200);
  const report = r.body.report as { verdict: string; sampleSize: number | null };
  assert.equal(report.verdict, "SOURCE_UNREADABLE");
  assert.equal(report.sampleSize, null);
});

test("the route registers exactly two GETs and no press", () => {
  const stack = (
    evidenceGatesRouter as unknown as {
      stack: { route?: { path: string; methods?: Record<string, boolean>; stack: unknown[] } }[];
    }
  ).stack;
  const paths = stack.map((l) => l.route?.path).filter(Boolean).sort();
  assert.deepEqual(paths, [CONFORMAL_PATH, PROMOTION_PATH].sort());
  for (const l of stack) {
    const methods = Object.keys(
      (l.route as unknown as { methods?: Record<string, boolean> }).methods ?? {},
    );
    assert.deepEqual(methods, ["get"], `${l.route?.path} registers more than GET`);
  }
});

// ── 4. NO PRESS IS TAKEN BY LOOKING ─────────────────────────────────────────

test("serving either report leaves the conformal flag exactly as it was", async () => {
  resetDb();
  const before = process.env["ARX_CONFORMAL_GATE_ENABLED"];
  await callRoute(CONFORMAL_PATH, { id: 1, role: "OWNER" });
  await callRoute(PROMOTION_PATH, { id: 1, role: "OWNER" });
  assert.equal(process.env["ARX_CONFORMAL_GATE_ENABLED"], before, "serving a report touched the env");
});

test("the fake db proves the adapters only ever SELECT", () => {
  // If any adapter reached for a write, it would have thrown here rather than
  // silently succeeding: the fake exposes no other verb.
  assert.deepEqual(Object.keys(fakeDb), ["select"]);
});
