// Per-user isolation guard for /api/positions/* (routes/livePositions.ts).
//
// WHAT WAS WRONG
//
//   `grep -c requireUser livePositions.ts` was 0. Eight routes — GET /positions,
//   GET /positions/:id, POST /positions/sync, PATCH /positions/:id/stop-loss,
//   PATCH /positions/:id/take-profit, POST /positions/:id/close-confirmation,
//   POST /positions/:id/close and GET /positions/:id/events — read and wrote
//   `live_positions` by id alone, with no userId predicate, on a router mounted
//   unconditionally at routes/index.ts.
//
//   `live_positions.id` is a sequential serial shared across tenants, so any
//   signed-in trader could address another tenant's position by guessing an
//   integer. Unlike the same defect in tradeManagement.ts, this one REACHES A
//   BROKER: stop-loss and close call
//   `queueMt5CommandWithGate("MODIFY" | "CLOSE", { ticket: row.brokerPositionId })`,
//   so the attacker could move or REMOVE a stranger's stop at the venue and
//   close their position — and /close also writes `trades.status` and
//   `trades.pnl`, falsifying the victim's realized P/L.
//
//   POST /positions/sync additionally answered with
//   `select().from(live_positions)` — no predicate — returning every tenant's
//   positions to whoever called it.
//
// WHY THIS IS A SOURCE SCAN
//
//   The invariant is a property of the handlers' SHAPE, and every one of them
//   does nothing but read/write PostgreSQL, so a behavioural test cannot run in
//   the offline lane. A runtime test on one route also could not prove the other
//   seven had not regressed. This scan checks every route declaration and every
//   mutating query in the file, so a ninth unscoped route fails the build.
//
// Run: node --import tsx --test src/routes/__qa__/livePositionsIsolation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, "../livePositions.ts");
const RAW = readFileSync(FILE, "utf8");

/** Source with comment lines stripped — the header documents what was removed. */
const CODE = RAW.split("\n")
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  })
  .join("\n");

const ROUTE_LINE = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"\s*,\s*([^)]*)/g;

function routeDeclarations(): Array<{ verb: string; path: string; rest: string }> {
  const out: Array<{ verb: string; path: string; rest: string }> = [];
  for (const m of CODE.matchAll(ROUTE_LINE)) {
    out.push({ verb: m[1]!, path: m[2]!, rest: m[3]! });
  }
  return out;
}

const EXPECTED_ROUTES = [
  "/positions",
  "/positions/:id",
  "/positions/sync",
  "/positions/:id/stop-loss",
  "/positions/:id/take-profit",
  "/positions/:id/close-confirmation",
  "/positions/:id/close",
  "/positions/:id/events",
];

test("the walker actually found the routes (a silent empty scan is not a pass)", () => {
  const routes = routeDeclarations();
  assert.ok(routes.length >= 8, `expected >=8 route declarations, found ${routes.length}`);
  for (const p of EXPECTED_ROUTES) {
    assert.ok(routes.some((r) => r.path === p), `route ${p} not found — did it move or get renamed?`);
  }
});

test("every route on this router is behind requireUser", () => {
  for (const r of routeDeclarations()) {
    assert.match(
      r.rest,
      /\brequireUser\b/,
      `${r.verb.toUpperCase()} ${r.path} is not gated by requireUser — that was the cross-tenant hole`,
    );
  }
});

test("the server-wide reconciler is admin-gated on top of requireUser", () => {
  // /positions/sync does not act on the caller's rows at all: it rewrites the
  // user_id IS NULL mirror for the single legacy MT5 connection. A normal
  // signed-in user must not be able to drive it.
  const sync = routeDeclarations().find((r) => r.path === "/positions/sync");
  assert.ok(sync, "/positions/sync not found");
  assert.match(sync!.rest, /\brequireAdmin\b/, "/positions/sync must be ADMIN/OWNER-gated");
});

test("identity comes from the session, never from the request payload", () => {
  assert.match(
    CODE,
    /req\.authUser!\.id/,
    "the userId must come from req.authUser",
  );
  for (const pattern of [
    /req\.body[^\n]*userId/,
    /req\.query[^\n]*userId/,
    /req\.params[^\n]*userId/,
  ]) {
    assert.doesNotMatch(CODE, pattern, "identity must never come from the request payload");
  }
});

test("the ownedRow predicate itself ANDs id with userId", () => {
  // Checking only the call sites is not enough: hollowing out ownedRow's body
  // would leave every `.where(ownedRow(id, userId))` looking correct while the
  // generated SQL matched on id alone.
  const m = /function ownedRow\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(CODE);
  assert.ok(m, "ownedRow() not found — did the helper get renamed?");
  const body = m![1]!;
  assert.match(body, /eq\(livePositionsTable\.id,\s*id\)/, "ownedRow lost the id predicate");
  assert.match(body, /eq\(livePositionsTable\.userId,\s*userId\)/, "ownedRow lost the userId predicate");
  assert.match(body, /\band\(/, "ownedRow must combine both predicates with and()");
});

test("the id-addressed read is scoped, and the unscoped form is gone", () => {
  const m = /async function resolveOwned\([\s\S]*?\n\}/.exec(CODE);
  assert.ok(m, "resolveOwned() not found — did the helper get renamed?");
  assert.match(m![0], /ownedRow\(id,\s*userId\)/, "resolveOwned must read through ownedRow");
  assert.doesNotMatch(
    CODE,
    /\.where\(eq\(livePositionsTable\.id,\s*id\)\)/,
    "an id-only .where() against live_positions is back — that is the cross-tenant hole",
  );
});

test("every UPDATE against live_positions inside a handler repeats the ownership predicate", () => {
  // syncFromBroker() is excluded deliberately: it is the ADMIN-gated reconciler
  // for the user_id IS NULL mirror and its reads are already scoped by
  // isNull(userId), so it addresses rows it selected rather than a caller id.
  // NB: the anchor is built from a regex, never written as a literal
  // `router.get("…")` string — scripts/src/ci/check-route-collisions.ts scans
  // every file for that shape and would read this test as a second route
  // registration colliding with the real one.
  const anchor = CODE.search(/router\.get\(\s*"\/positions"/);
  assert.ok(anchor >= 0, "route section not found — the anchor moved");
  const handlerSection = CODE.slice(anchor);
  assert.ok(handlerSection.length > 500, "route section is implausibly short");
  const updates = [...handlerSection.matchAll(/db\.update\(livePositionsTable\)[\s\S]*?\.where\(([^;]*?)\)\s*;/g)];
  assert.ok(updates.length >= 3, `expected >=3 UPDATEs in handlers, found ${updates.length}`);
  for (const u of updates) {
    assert.match(
      u[1]!,
      /ownedRow\(id,\s*userId\)/,
      `an UPDATE against live_positions is not scoped by owner: .where(${u[1]})`,
    );
  }
});

test("the broker-reaching calls sit downstream of the ownership check", () => {
  // MODIFY (stop-loss / take-profit) and CLOSE queue a real command against
  // `row.brokerPositionId`. Each must be preceded, in its own handler, by the
  // resolveOwned() that proved the row belongs to the caller.
  const handlers = CODE.split(/router\.(?:get|post|patch)\(/).slice(1);
  const brokerHandlers = handlers.filter((h) => h.includes("queueMt5CommandWithGate("));
  assert.equal(brokerHandlers.length, 3, `expected 3 broker-reaching handlers, found ${brokerHandlers.length}`);
  for (const h of brokerHandlers) {
    const ownedAt = h.indexOf("resolveOwned(req, res)");
    const queueAt = h.indexOf("queueMt5CommandWithGate(");
    assert.ok(ownedAt >= 0, "a broker-reaching handler does not resolve ownership at all");
    assert.ok(ownedAt < queueAt, "ownership must be proven BEFORE the broker command is queued");
  }
});

test("the trade row is scoped on its own, and a dropped write is reported", () => {
  // trades is reached through a LOOSE FK on the position row, so inheriting the
  // position's ownership would be an assumption. And if the predicate matches
  // nothing, the close must not be reported as a clean success.
  assert.match(
    CODE,
    /and\(eq\(tradesTable\.id,\s*row\.tradeId\),\s*eq\(tradesTable\.userId,\s*userId\)\)/,
    "the trades UPDATE must carry its own ownership predicate",
  );
  assert.doesNotMatch(
    CODE,
    /\.where\(eq\(tradesTable\.id,\s*row\.tradeId\)\)/,
    "an id-only .where() against trades is back",
  );
  assert.match(CODE, /tradeRecordUpdated/, "the close response must report whether the trade row was written");
  assert.match(CODE, /\.returning\(\{ id: tradesTable\.id \}\)/, "the write must be observed, not assumed");
});

test("a foreign or legacy row answers 404, so ids stay non-enumerable", () => {
  const m = /async function resolveOwned\([\s\S]*?\n\}/.exec(CODE);
  assert.match(m![0], /res\.status\(404\)/, "an unowned row must answer 404");
  assert.doesNotMatch(m![0], /res\.status\(403\)/, "a 403 would confirm the id exists");
});

test("the reconciler's response is scoped to the rows it reconciled", () => {
  const m = /async function syncFromBroker\(\)[\s\S]*?\n\}/.exec(CODE);
  assert.ok(m, "syncFromBroker() not found");
  const tail = m![0].slice(m![0].lastIndexOf("const after"));
  assert.match(
    tail,
    /isNull\(livePositionsTable\.userId\)/,
    "the sync response must be scoped to the user_id IS NULL mirror it actually reconciled",
  );
});
