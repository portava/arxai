// Per-user isolation + live-refusal guard for /api/trade-management/*.
//
// WHAT WAS WRONG
//
//   getTrade(id) was `db.select().from(tradesTable).where(eq(tradesTable.id, id))`
//   with no userId, all four mutating handlers UPDATEd by id only, and the
//   router carried no requireUser. `trades.id` is a sequential serial shared
//   across tenants, so any signed-in trader could close another trader's open
//   position, move their stop to break-even, or halve their lot by POSTing a
//   guessed integer — and because `trades.pnl` feeds /performance/summary and
//   /portfolio/exposure it falsified the victim's Realized P/L too.
//
//   Separately, /close read mt5State and threw it away (`void liveAllowed`),
//   then wrote status/pnl/closedAt and answered "Trade closed at … (mock)."
//   There is no broker adapter on this path. On a LIVE row that meant ARX
//   reported a position closed while the broker position kept running.
//
// WHY THIS IS A SOURCE SCAN
//
//   Both invariants are properties of the handler's SHAPE. A behavioural test
//   would need PostgreSQL (these handlers do nothing but read and write
//   `trades`), so it cannot run in the offline lane; and a runtime test on one
//   handler cannot prove the other three did not regress. This scan checks
//   every route declaration and every UPDATE in the file, so adding a fifth
//   unscoped action fails the build.
//
// Run: node --import tsx --test src/routes/__qa__/tradeManagementIsolation.test.ts

// Two assertions import the module to read its exported copy constants. That
// pulls in @workspace/db, which refuses to load without DATABASE_URL. This is a
// dummy pointing at a closed local port: no assertion here issues a query, and
// a handler that somehow ran would fail loudly rather than quietly pass.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(HERE, "../tradeManagement.ts");
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

const MUTATING_PATHS = [
  "/trade-management/:id/breakeven",
  "/trade-management/:id/trail",
  "/trade-management/:id/partial-close",
  "/trade-management/:id/close",
];

test("the walker actually found the routes (a silent empty scan is not a pass)", () => {
  const routes = routeDeclarations();
  assert.ok(routes.length >= 5, `expected >=5 route declarations, found ${routes.length}`);
  for (const p of MUTATING_PATHS) {
    assert.ok(routes.some((r) => r.path === p), `route ${p} not found — did it move or get renamed?`);
  }
  assert.ok(routes.some((r) => r.path === "/trade-management/:id/snapshot"));
});

test("every route on this router is behind requireUser", () => {
  for (const r of routeDeclarations()) {
    assert.match(
      r.rest,
      /\brequireUser\b/,
      `${r.verb.toUpperCase()} ${r.path} is not gated by requireUser`,
    );
  }
});

test("the row read is scoped by the authenticated userId", () => {
  // The single read helper must AND the id with the caller's userId.
  assert.match(
    CODE,
    /eq\(tradesTable\.id,\s*id\)\s*,\s*eq\(tradesTable\.userId,\s*userId\)/,
    "the trade read must filter on tradesTable.userId as well as id",
  );
  assert.match(
    CODE,
    /req\.authUser!\.id/,
    "the userId must come from req.authUser, never from the body/params/query",
  );
});

test("no query trusts a client-supplied userId", () => {
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
  assert.match(body, /eq\(tradesTable\.id,\s*id\)/, "ownedRow lost the id predicate");
  assert.match(body, /eq\(tradesTable\.userId,\s*userId\)/, "ownedRow lost the userId predicate");
  assert.match(body, /\band\(/, "ownedRow must combine both predicates with and()");
  assert.doesNotMatch(
    /function ownedRow\(([^)]*)\)/.exec(CODE)![1]!,
    /_userId/,
    "ownedRow's userId parameter is unused — the predicate cannot be scoped",
  );
});

test("every UPDATE repeats the ownership predicate", () => {
  const updates = [...CODE.matchAll(/db\.update\(tradesTable\)[\s\S]*?\.where\(([^)]*\))/g)];
  assert.ok(updates.length >= 4, `expected >=4 UPDATEs against trades, found ${updates.length}`);
  for (const u of updates) {
    assert.match(
      u[1]!,
      /ownedRow\(id,\s*userId\)/,
      `an UPDATE against trades is not scoped by owner: .where(${u[1]})`,
    );
  }
  // And the unscoped form must be gone entirely.
  assert.doesNotMatch(
    CODE,
    /\.where\(eq\(tradesTable\.id,\s*id\)\)/,
    "an id-only .where() is back — that is the cross-tenant hole",
  );
});

test("a foreign or legacy row answers 404, so ids stay non-enumerable", () => {
  assert.match(CODE, /res\.status\(404\)\.json\(\{\s*error:\s*"Trade not found"/);
  assert.doesNotMatch(CODE, /res\.status\(403\)/, "a 403 would confirm the id exists");
});

test("all four mutating actions refuse a LIVE row", () => {
  // Each mutating handler must reach refuseLive before it writes anything.
  const handlers = CODE.split(/router\.post\(/).slice(1);
  const mutating = handlers.filter((h) => MUTATING_PATHS.some((p) => h.startsWith(`"${p}"`)));
  assert.equal(mutating.length, 4, "expected exactly the four mutating POST handlers");
  for (const h of mutating) {
    const refusalAt = h.indexOf("refuseLive(res)");
    const writeAt = h.indexOf("db.update(tradesTable)");
    assert.ok(refusalAt >= 0, "a mutating handler does not call refuseLive");
    assert.ok(writeAt >= 0, "a mutating handler no longer writes — did the shape change?");
    assert.ok(refusalAt < writeAt, "refuseLive must run BEFORE the UPDATE, not after");
  }
  assert.match(CODE, /res\.status\(409\)\.json\(\{[\s\S]*?error:\s*LIVE_ACTION_REFUSAL_CODE/);
});

test("the LIVE refusal names the surface that can actually act", async () => {
  const mod = await import("../tradeManagement.js");
  assert.match(mod.LIVE_ACTION_REFUSAL_MESSAGE, /LIVE/);
  assert.match(mod.LIVE_ACTION_REFUSAL_MESSAGE, /not connected to a broker/i);
  assert.match(mod.LIVE_ACTION_REFUSAL_MESSAGE, /Live Shared/);
  // A refusal that reads like a success is worse than none.
  assert.match(mod.LIVE_ACTION_REFUSAL_MESSAGE, /Refused/);
});

test("no success message claims a broker action, and none says '(mock)'", async () => {
  assert.doesNotMatch(CODE, /\(mock\)/, "the '(mock)' parenthetical is not user-readable copy");
  const mod = await import("../tradeManagement.js");
  assert.match(mod.TRADE_MANAGEMENT_SIMULATION_NOTE, /no broker order was sent/i);
  // Every 200 body must carry the note and the machine-readable flag.
  const successBodies = [...CODE.matchAll(/res\.json\(\{\s*\n\s*success: true,([\s\S]*?)\}\);/g)];
  assert.equal(successBodies.length, 4, `expected 4 success bodies, found ${successBodies.length}`);
  for (const b of successBodies) {
    assert.match(b[1]!, /simulated: true/, "a 200 body omits simulated:true");
    assert.match(b[1]!, /TRADE_MANAGEMENT_SIMULATION_NOTE/, "a 200 message omits the simulation note");
  }
});

test("the discarded mt5State read is gone", () => {
  // Reading liveAllowed and then `void`-ing it was the tell: the handler knew
  // about live permission and ignored it.
  assert.doesNotMatch(CODE, /void liveAllowed/);
  assert.doesNotMatch(CODE, /mt5StateTable/);
});
