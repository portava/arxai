// readChartStructure chat tool — wrapper logic lock (Task #602 follow-on).
//
// The chat tool that unifies Ruby CHAT's chart read with the Scanner "Ruby Chart
// Read" panel. This test pins the tool's OWN logic — symbol resolution, the
// symbol/timeframe priority rules, and honest replies when a market can't be
// resolved — in ISOLATION from the shared structural-read service.
//
// WHY MOCK THE SERVICE:
//   buildRubyStructuralRead reaches the live market-data router, which serves
//   majors (EURUSD) non-deterministically from real providers. To lock the
//   tool's deterministic wrapper logic (what symbol + timeframe it FORWARDS, and
//   when it refuses), we replace the service with an instrumented stub that
//   records its arguments. The real service is exercised end-to-end (panel vs
//   chat parity, STRUCTURAL_ONLY withholding, INSUFFICIENT honesty) by the
//   in-process harness `rubyChatChartReadParityTest.ts`.
//
// Requires Node's experimental module-mock flag (wired into the npm script:
//   pnpm --filter @workspace/api-server run test:read-chart-structure-tool).

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Instrument the shared service seam BEFORE importing the tool ─────────────
// The specifier resolves to the SAME absolute module URL that tools.ts imports
// (`./rubyStructuralReadService.js`), so the tool picks up this stub.
const calls: Array<{ symbol: string; timeframe: string; clientFeedUnconfirmed: boolean; draft: unknown }> = [];
function resetCalls(): void {
  calls.length = 0;
}

mock.module("../rubyStructuralReadService.js", {
  namedExports: {
    buildRubyStructuralRead: async (params: {
      symbol: string;
      timeframe: string;
      clientFeedUnconfirmed?: boolean;
      draft?: unknown;
    }) => {
      calls.push({
        symbol: params.symbol,
        timeframe: params.timeframe,
        clientFeedUnconfirmed: params.clientFeedUnconfirmed === true,
        draft: params.draft ?? null,
      });
      // Echo the forwarded timeframe so the tool's `timeframe` reflects what it
      // chose (the real service normalizes; normalization is locked elsewhere).
      return {
        chartRead: { symbol: params.symbol, timeframe: params.timeframe, readLayer: "STRUCTURAL_ONLY" },
        readLayer: "STRUCTURAL_ONLY",
        normalizedTimeframe: params.timeframe,
        shouldRecordReadDecision: true,
        recordDirection: null,
        feedUnconfirmed: params.clientFeedUnconfirmed === true,
      };
    },
  },
});

const { readChartStructureTool, setRequestPageContext } = await import("../tools.js");
const { resolveAssistantMarket } = await import("../../markets/assistantMarketResolver.js");

// ── E — alias variants resolve to ONE downstream symbol ─────────────────────
test("E — V75 alias casing/whitespace variants resolve to one downstream symbol", async () => {
  const variants = ["V75", "v75", " v75 "];
  const forwarded: string[] = [];
  for (const v of variants) {
    resetCalls();
    const r = await readChartStructureTool(v, "H1");
    assert.equal(r.ok, true, `"${v}" should resolve`);
    assert.equal(calls.length, 1, `"${v}" forwards exactly one read`);
    assert.equal(calls[0]!.symbol, (r as { symbol: string }).symbol, `"${v}" forwards its resolved symbol`);
    forwarded.push((r as { symbol: string }).symbol);
  }
  for (const s of forwarded) assert.equal(s, forwarded[0], "all V75 variants forward the same symbol");
  // The resolver itself agrees and the symbol is a real, non-empty downstream form.
  const direct = resolveAssistantMarket("V75");
  assert.equal(direct.status, "resolved");
  assert.ok(direct.downstreamSymbol && direct.downstreamSymbol.length > 0);
  assert.equal(forwarded[0], direct.downstreamSymbol);
});

// ── D — timeframe priority: explicit arg > on-screen chart tf > default H1 ───
test("D — timeframe priority: explicit arg > on-screen chart tf > default H1", async () => {
  const reqKey = {};
  setRequestPageContext(reqKey, { pathname: "/scanner", chartSymbol: "EURUSD", chartTimeframe: "M15" });

  resetCalls();
  await readChartStructureTool("EURUSD", "M5", reqKey);
  assert.equal(calls[0]!.timeframe, "M5", "explicit timeframe wins over page context");

  resetCalls();
  await readChartStructureTool("EURUSD", null, reqKey);
  assert.equal(calls[0]!.timeframe, "M15", "on-screen chart timeframe used when none is typed");

  resetCalls();
  await readChartStructureTool("EURUSD", null, {});
  assert.equal(calls[0]!.timeframe, "H1", "defaults to H1 when page context has no timeframe");

  resetCalls();
  await readChartStructureTool("EURUSD", undefined);
  assert.equal(calls[0]!.timeframe, "H1", "defaults to H1 when there is no page context at all");
});

// ── symbol priority: explicit symbol > on-screen chart symbol ───────────────
test("symbol priority: explicit symbol > on-screen chart symbol; missing both is honest", async () => {
  const reqKey = {};
  setRequestPageContext(reqKey, { pathname: "/scanner", chartSymbol: "EURUSD", chartTimeframe: "M15" });

  resetCalls();
  const r1 = await readChartStructureTool("V75", "H1", reqKey);
  assert.equal(r1.ok, true);
  assert.equal(calls[0]!.symbol, resolveAssistantMarket("V75").downstreamSymbol, "typed symbol wins over the chart symbol");

  resetCalls();
  const r2 = await readChartStructureTool("", null, reqKey);
  assert.equal(r2.ok, true);
  assert.equal(calls[0]!.symbol, resolveAssistantMarket("EURUSD").downstreamSymbol, "falls back to the on-screen chart symbol");

  resetCalls();
  const r3 = await readChartStructureTool("", null, {});
  assert.equal(r3.ok, false);
  assert.equal((r3 as { error: string }).error, "missing_symbol");
  assert.equal(calls.length, 0, "no read is forwarded when there is nothing to read");
});

// ── honest on off-universe symbol — no fabricated read, service not called ───
test("honest on an off-universe symbol — no fabricated read, service not called", async () => {
  resetCalls();
  const r = await readChartStructureTool("NOTAREALMARKETXYZ", "H1");
  assert.equal(r.ok, false);
  assert.equal((r as { error: string }).error, "not_in_universe");
  assert.ok(typeof (r as { message?: string }).message === "string" && (r as { message: string }).message.length > 0);
  assert.equal(calls.length, 0, "an off-universe market never reaches the read service");
});

// ── resolved read returns the display-only shape ────────────────────────────
test("a resolved read returns the display-only shape (symbol / timeframe / readLayer / chartRead)", async () => {
  resetCalls();
  const r = await readChartStructureTool("EURUSD", "M5");
  assert.equal(r.ok, true);
  const ok = r as { symbol: string; timeframe: string; readLayer: string; chartRead: unknown; feedUnconfirmed: boolean };
  assert.equal(typeof ok.symbol, "string");
  assert.equal(ok.timeframe, "M5");
  assert.equal(ok.readLayer, "STRUCTURAL_ONLY");
  assert.ok(ok.chartRead && typeof ok.chartRead === "object");
  // Hard-lock the DISPLAY-ONLY honesty contract: the tool MUST forward the
  // explicit feedUnconfirmed flag from the service (never inferred downstream
  // from readLayer), so chat parity with the Scanner panel cannot silently drift.
  assert.equal(typeof ok.feedUnconfirmed, "boolean", "tool output carries the explicit feedUnconfirmed flag");
});
