// Self-trade kill-switch scope matching — offline unit proofs.
//
// Pure tests of evaluateKillSwitchRows plus readKillSwitchVerdict against an
// in-memory reader (no DB, no network). Importing the module loads
// @workspace/db, whose init needs a DATABASE_URL; a loopback URL that never
// connects satisfies it and NO query is ever issued.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/selfTrade/__qa__/killSwitchScope.test.ts

process.env.DATABASE_URL ??= "postgres://nobody@127.0.0.1:1/none";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const {
  evaluateKillSwitchRows,
  readKillSwitchVerdict,
  normalizeKillRef,
  KILL_SWITCH_MALFORMED,
} = await import("../killSwitchScope.js");

type Row = { scope: string | null; scopeRef: string | null; engaged: boolean | null; reason?: string | null };
const row = (scope: string | null, scopeRef: string | null, engaged: boolean | null = true, reason: string | null = null): Row =>
  ({ scope, scopeRef, engaged, reason });
const entry = { agentKey: "alpha-fx", symbol: "EURUSD", strategy: "BREAKOUT" };

// ── Exact scope semantics (unchanged contract) ────────────────────────────
test("no rows, or only released rows, never kill", () => {
  assert.equal(evaluateKillSwitchRows([], entry).killed, false);
  assert.equal(
    evaluateKillSwitchRows(
      [row("GLOBAL", null, false), row("AGENT", "alpha-fx", false), row("SYMBOL", "EURUSD", null)],
      entry,
    ).killed,
    false,
  );
});

test("GLOBAL and NEWS always cover, whatever their scopeRef", () => {
  for (const scope of ["GLOBAL", "NEWS"]) {
    for (const ref of [null, "", "anything"]) {
      const v = evaluateKillSwitchRows([row(scope, ref)], entry);
      assert.equal(v.killed, true, `${scope} ref=${ref}`);
      assert.equal(v.scope, scope);
    }
  }
});

test("AGENT / STRATEGY / SYMBOL cover only their own ref", () => {
  assert.equal(evaluateKillSwitchRows([row("AGENT", "alpha-fx")], entry).scope, "AGENT");
  assert.equal(evaluateKillSwitchRows([row("AGENT", "beta")], entry).killed, false);
  assert.equal(evaluateKillSwitchRows([row("STRATEGY", "BREAKOUT")], entry).scope, "STRATEGY");
  assert.equal(evaluateKillSwitchRows([row("STRATEGY", "MEAN_REVERT")], entry).killed, false);
  assert.equal(evaluateKillSwitchRows([row("STRATEGY", "BREAKOUT")], { ...entry, strategy: null }).killed, false);
  assert.equal(evaluateKillSwitchRows([row("SYMBOL", "EURUSD")], entry).scope, "SYMBOL");
  assert.equal(evaluateKillSwitchRows([row("SYMBOL", "GBPUSD")], entry).killed, false);
  assert.equal(evaluateKillSwitchRows([row("SYMBOL", "EURUSD")], { ...entry, symbol: null }).killed, false);
});

test("precedence: GLOBAL > NEWS > AGENT > STRATEGY > SYMBOL", () => {
  const all = [row("SYMBOL", "EURUSD"), row("STRATEGY", "BREAKOUT"), row("AGENT", "alpha-fx"), row("NEWS", null), row("GLOBAL", null)];
  const order = ["GLOBAL", "NEWS", "AGENT", "STRATEGY", "SYMBOL"];
  for (let i = 0; i < order.length; i++) {
    const remaining = all.filter((r) => order.indexOf(r.scope!) >= i);
    // Shuffle-insensitive: reverse order gives the same winner.
    assert.equal(evaluateKillSwitchRows(remaining, entry).scope, order[i]);
    assert.equal(evaluateKillSwitchRows([...remaining].reverse(), entry).scope, order[i]);
  }
});

test("the engaged row's reason is surfaced; a default is synthesized when absent", () => {
  assert.equal(evaluateKillSwitchRows([row("AGENT", "alpha-fx", true, "desk halt")], entry).reason, "desk halt");
  assert.equal(evaluateKillSwitchRows([row("AGENT", "alpha-fx")], entry).reason, "AGENT kill switch engaged");
});

test("a broker-native symbol spelling is also checked when supplied", () => {
  const v = evaluateKillSwitchRows([row("SYMBOL", "EURUSD.r")], { ...entry, symbols: ["EURUSD.r"] });
  assert.equal(v.killed, true);
  assert.equal(evaluateKillSwitchRows([row("SYMBOL", "EURUSD")], { ...entry, symbol: null, symbols: [null, "EURUSD"] }).killed, true);
});

// ── Gap: case / whitespace mismatches (operator typed " eurusd ") ─────────
test("SYMBOL / AGENT / STRATEGY refs match regardless of case and surrounding whitespace", () => {
  for (const ref of ["eurusd", " EURUSD", "EURUSD ", "\tEurUsd\n"]) {
    assert.equal(evaluateKillSwitchRows([row("SYMBOL", ref)], entry).killed, true, `SYMBOL ${JSON.stringify(ref)}`);
  }
  assert.equal(evaluateKillSwitchRows([row("SYMBOL", "EURUSD")], { ...entry, symbol: " eurusd " }).killed, true);
  assert.equal(evaluateKillSwitchRows([row("AGENT", " ALPHA-FX ")], entry).killed, true);
  assert.equal(evaluateKillSwitchRows([row("STRATEGY", "breakout")], entry).killed, true);
});

test("normalization never widens to a different instrument (no suffix guessing)", () => {
  assert.equal(evaluateKillSwitchRows([row("SYMBOL", "EURUSD")], { ...entry, symbol: "EURUSD.r" }).killed, false);
  assert.equal(evaluateKillSwitchRows([row("SYMBOL", "EUR")], entry).killed, false);
  assert.equal(normalizeKillRef("  "), null);
  assert.equal(normalizeKillRef(42 as unknown as string), null);
});

// ── Gap: malformed engaged rows must fail CLOSED ──────────────────────────
test("an engaged row with an unknown or mis-cased scope blocks every entry (fail closed)", () => {
  for (const scope of ["global", " GLOBAL ", "news"]) {
    const v = evaluateKillSwitchRows([row(scope, null)], entry);
    assert.equal(v.killed, true, `scope ${JSON.stringify(scope)}`);
    assert.ok(v.scope === "GLOBAL" || v.scope === "NEWS");
  }
  for (const scope of ["BOGUS", "", null, "SYMBOLS"]) {
    const v = evaluateKillSwitchRows([row(scope, "EURUSD")], { agentKey: "zeta", symbol: "XAUUSD" });
    assert.equal(v.killed, true, `scope ${JSON.stringify(scope)}`);
    assert.equal(v.scope, KILL_SWITCH_MALFORMED);
    assert.match(v.reason ?? "", /fail closed/);
  }
});

test("an engaged targeted scope with an empty scopeRef blocks every entry (fail closed)", () => {
  for (const scope of ["AGENT", "STRATEGY", "SYMBOL"]) {
    for (const ref of [null, "", "   "]) {
      const v = evaluateKillSwitchRows([row(scope, ref)], { agentKey: "zeta", symbol: "XAUUSD", strategy: null });
      assert.equal(v.killed, true, `${scope} ref=${JSON.stringify(ref)}`);
      assert.equal(v.scope, KILL_SWITCH_MALFORMED);
    }
  }
});

test("a malformed row that is NOT engaged is ignored", () => {
  assert.equal(evaluateKillSwitchRows([row("BOGUS", null, false), row("AGENT", null, false)], entry).killed, false);
});

test("precedence: GLOBAL and NEWS outrank MALFORMED, which outranks targeted scopes", () => {
  assert.equal(evaluateKillSwitchRows([row("BOGUS", null), row("GLOBAL", null)], entry).scope, "GLOBAL");
  assert.equal(evaluateKillSwitchRows([row("BOGUS", null), row("NEWS", null)], entry).scope, "NEWS");
  assert.equal(evaluateKillSwitchRows([row("AGENT", "alpha-fx"), row("BOGUS", null)], entry).scope, KILL_SWITCH_MALFORMED);
});

test("MONOTONE: adding any row never turns a kill into a pass (2,000 generated cases)", () => {
  const scopes = ["GLOBAL", "NEWS", "AGENT", "STRATEGY", "SYMBOL", "global", "BOGUS", null];
  const refs = [null, "", " ", "alpha-fx", "ALPHA-FX", "EURUSD", "eurusd ", "BREAKOUT", "other"];
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 2000; i++) {
    const rows: Row[] = Array.from({ length: 1 + rnd(4) }, () => row(scopes[rnd(scopes.length)]!, refs[rnd(refs.length)]!, rnd(3) !== 0));
    const base = evaluateKillSwitchRows(rows, entry);
    const extra = row(scopes[rnd(scopes.length)]!, refs[rnd(refs.length)]!, rnd(2) === 0);
    const more = evaluateKillSwitchRows([...rows, extra], entry);
    if (base.killed) assert.equal(more.killed, true, JSON.stringify({ rows, extra }));
  }
});

// ── Reader: timestamps never release; read errors propagate ───────────────
function fakeReader(result: unknown[] | Error) {
  const calls: string[] = [];
  return {
    calls,
    select(_cols?: unknown) {
      calls.push("select");
      return {
        from(_t: unknown) {
          calls.push("from");
          return {
            async where(_w: unknown) {
              calls.push("where");
              if (result instanceof Error) throw result;
              return result;
            },
          };
        },
      };
    },
  };
}

test("future-dated / released-at timestamps do not release an engaged switch", async () => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  const reader = fakeReader([
    { scope: "AGENT", scopeRef: "alpha-fx", engaged: true, reason: null, engagedAt: future, releasedAt: past, updatedAt: past },
  ]);
  const v = await readKillSwitchVerdict(entry, reader as never);
  assert.equal(v.killed, true);
  assert.deepEqual(reader.calls, ["select", "from", "where"]);
});

test("a read error is never swallowed into a pass", async () => {
  await assert.rejects(
    readKillSwitchVerdict(entry, fakeReader(new Error("connection terminated")) as never),
    /connection terminated/,
  );
});

test("assertAgentNotKilled delegates to the shared matcher (no second copy of the rules)", () => {
  const src = readFileSync(fileURLToPath(new URL("../killSwitchGate.ts", import.meta.url)), "utf8");
  assert.match(src, /return readKillSwitchVerdict\(input\)/);
  assert.doesNotMatch(src, /case "SYMBOL"/);
});
