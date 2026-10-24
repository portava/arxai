import assert from "node:assert/strict";
import {
  READ_MODEL,
  checkSingleOpenPositionView,
  evaluate,
  scanFile,
  type FileScan,
  type OpenReadAllowance,
  type OperatorReadAllowance,
} from "./check-single-open-position-view.js";

let n = 0;
const reads = (source: string, expected: number, key = "lib/strategy.ts") => {
  n++;
  assert.equal(scanFile(key, source).openReads, expected, source);
};
const rejects = (source: string, key = "lib/strategy.ts") => {
  n++;
  assert.ok(scanFile(key, source).violations.length > 0, source);
};

// Raw open-position reads are counted, however the open predicate is spelt.
reads("await livePositionLedger.read({ where: openLiveExposureCondition(userId) })", 1);
reads("await livePositionLedger.select({ id: live.id }, { where: and(eq(live.userId, u), isNull(live.closedAt)) })", 1);
reads('await demoPositionLedger.read({ where: and(eq(demo.userId, u), eq(demo.status, "OPEN")) })', 1);
reads('await demoPositionLedger.select({ t: d.brokerPositionId }, { where: and(eq(d.userId, u), ne(d.status, "CLOSED")) })', 1);
reads("const open = isNull(livePositionColumns.closedAt);\nawait livePositionLedger.select(cols, { where: and(open, eq(c.userId, u)) });", 1);
reads("const scope = openLiveExposureCondition(u);\nawait ledger.livePositionLedger.read({ where: scope });", 1);
reads("await livePositionLedger.read({ where: sql`closed_at IS NULL and user_id = ${u}` })", 1);
// Historical, closed, single-row and reconciled-only reads are not open reads.
reads("await livePositionLedger.read({ where: and(eq(c.userId, u), isNotNull(c.closedAt)) })", 0);
reads("await livePositionLedger.read({ where: and(eq(c.id, id), eq(c.userId, u)), limit: 1 })", 0);
reads("await livePositionLedger.select({ s: sum }, { where: and(eq(c.userId, u), isNotNull(c.closedAt), isNull(c.reconcileState)) })", 0);
reads('await demoPositionLedger.read({ where: eq(d.status, "CLOSED") })', 0);
reads("await readOpenPositions({ userId, venue: \"LIVE\" }); // the read model", 0);
reads('await selectLiveOpenPositions({ id: c.id }, { userId, basis: "UNCLOSED" });', 0);
reads('await selectDemoOpenPositions(demoPositionColumns, { userId, basis: "CONFIRMED_OPEN", confirmedTicket: true });', 0);
reads("const x = isNull(tradesTable.closedAt); await db.select().from(tradesTable).where(x);", 0);
// The read model and the ledger are the implementation, not consumers.
reads("await livePositionLedger.read({ where: openLiveExposureCondition(userId) })", 0, READ_MODEL);
reads("await livePositionLedger.read({ where: isNull(arxLivePositionsTable.closedAt) })", 0, "lib/positions/ledger.ts");
// Aliasing a raw ledger would hide calls from the count.
rejects('import { livePositionLedger as positions } from "../positions/ledger.js";');
rejects("const { livePositionLedger: l } = await import(\"../positions/ledger.js\");");
rejects("const l = demoPositionLedger;");
rejects("const { read } = livePositionLedger;");
n++;
assert.deepEqual(scanFile("lib/x.ts", 'import { livePositionLedger, livePositionColumns as c } from "./positions/ledger.js";').violations, []);

// Cross-user read-model functions are detected (import, call or namespace access); aliasing is rejected.
const usesAll = (source: string, expected: boolean) => {
  n++;
  assert.equal(scanFile("lib/strategy.ts", source).allUsersReads === true, expected, source);
};
usesAll('import { selectLiveOpenPositionsForAllUsers } from "../positions/openPositions.js";\nawait selectLiveOpenPositionsForAllUsers(cols, { basis: "UNCLOSED" });', true);
usesAll('import * as op from "../positions/openPositions.js";\nawait op.selectDemoOpenPositionsForAllUsers(cols);', true);
usesAll('await selectLiveOpenPositions(cols, { userId, basis: "EXPOSURE" });', false);
usesAll('await readOpenPositions({ userId, venue: "ALL" });', false);
rejects('import { selectLiveOpenPositionsForAllUsers as everyone } from "../positions/openPositions.js";');
n++;
assert.deepEqual(scanFile("lib/x.ts", 'import { selectLiveOpenPositionsForAllUsers } from "./positions/openPositions.js";').violations, []);

// Allowlist accounting: unlisted, above the count, stale count, missing file, no reason.
const scan = (openReads: number): FileScan => ({ openReads, violations: [] });
const allow = (openReads: number, reason = "producer"): OpenReadAllowance => ({ openReads, category: "BROKER_TRUTH", reason });
const exists = () => false;
const ev = (scans: Record<string, FileScan>, list: Record<string, OpenReadAllowance>) => evaluate(scans, list, exists);
n++; assert.equal(ev({ "lib/a.ts": scan(1) }, {}).length, 1);
n++; assert.match(ev({ "lib/a.ts": scan(3) }, { "lib/a.ts": allow(2) })[0]!, /permits 2/);
n++; assert.match(ev({ "lib/a.ts": scan(1) }, { "lib/a.ts": allow(2) })[0]!, /stale allowlist entry/);
n++; assert.match(ev({ "lib/a.ts": scan(0) }, { "lib/a.ts": allow(1) })[0]!, /remove the entry/);
n++; assert.match(ev({}, { "lib/gone.ts": allow(1) })[0]!, /no longer exists/);
n++; assert.match(ev({ "lib/a.ts": scan(1) }, { "lib/a.ts": allow(1, " ") })[0]!, /needs a reason/);
n++; assert.deepEqual(ev({ "lib/a.ts": scan(2), "lib/b.ts": scan(0) }, { "lib/a.ts": allow(2) }), []);

// Operator-wide readers: unlisted use, stale (no use / missing file), no reason, clean.
const op = (reason = "operator view"): OperatorReadAllowance => ({ reason });
const all: FileScan = { openReads: 0, violations: [], allUsersReads: true };
const evOp = (scans: Record<string, FileScan>, readers: Record<string, OperatorReadAllowance>) =>
  evaluate(scans, {}, exists, readers);
n++; assert.match(evOp({ "lib/a.ts": all }, {})[0]!, /not in OPERATOR_WIDE_READERS/);
n++; assert.match(evOp({ "lib/a.ts": scan(0) }, { "lib/a.ts": op() })[0]!, /stale OPERATOR_WIDE_READERS entry .*no longer uses/);
n++; assert.match(evOp({}, { "lib/gone.ts": op() })[0]!, /stale OPERATOR_WIDE_READERS entry .*no longer exists/);
n++; assert.match(evOp({ "lib/a.ts": all }, { "lib/a.ts": op(" ") })[0]!, /needs a reason/);
n++; assert.deepEqual(evOp({ "lib/a.ts": all, "lib/b.ts": scan(0) }, { "lib/a.ts": op() }), []);

// The real tree passes.
const real = checkSingleOpenPositionView();
assert.ok(real.ok, real.violations.join("\n"));
console.log(`single-open-position-view: ${n} fixtures passed; repository clean`);
