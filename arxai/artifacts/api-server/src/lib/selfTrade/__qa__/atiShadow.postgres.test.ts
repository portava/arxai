import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import type { AtiMt5QuoteOrigin } from "../../data/atiMt5QuoteOrigin.js";
import type { AtiDerivQuoteOrigin } from "../../data/atiDerivQuotes.js";

const url = process.env.ARX_ATI_TEST_DATABASE_URL;

test("ATI Shadow stores one immutable paired read per bar and isolates owners and sources", { skip: !url }, async (t) => {
  assert.ok(url);
  const connection = new URL(url);
  assert.equal(connection.pathname, "/arx_ati_shadow_test");
  assert.equal(connection.username, "arx_qa");
  assert.match(connection.searchParams.get("host") ?? "", /\/arx-ati-shadow-[^/]+\/socket$/);
  process.env.DATABASE_URL = url;
  const migrations = await Promise.all(["2026-11-23_ati_shadow_observations", "2026-11-23_ati_shadow_outcomes",
    "2026-11-24_ati_measured_shadow_costs", "2026-11-24_ati_trading_memory", "2026-11-24_ati_research_lab",
    "2026-11-24_ati_deriv_quote_archive"].map((name) =>
    readFile(new URL(`../../../../../../lib/db/migrations/${name}.sql`, import.meta.url), "utf8")));

  const base = Math.floor(Date.now() / 300_000) * 300_000;
  let slot = base;
  let sourceIdentity = "source-one";
  let dataSource = "LIVE_FEED";
  let quoteOffset = -1;
  let derivQuoteOrigin: AtiDerivQuoteOrigin | null | undefined;
  let counterargumentCase: "REDUCE" | "VETO" | "CHASE" | "WAIT_ZONE" | "BASELINE_WAIT" | null = null;
  let regimeCase: "TRENDING" | "RANGING" | null = null;
  let mt5QuoteOrigin: AtiMt5QuoteOrigin | null = {
    receiptId: 1, streamKey: "EURUSD", bridgeConnectionId: 11, accountBinding: "1".repeat(64), historyIdentity: "2".repeat(64),
    mode: "LIVE", brokerSymbol: "EURUSD", brokerTickAtMs: base,
  };
  let readCount = 0;
  mock.module("../decisionEngine.js", { namedExports: {
    canObserveSelfTradeAgent: async (owner: number, agent: number, symbol: string) => owner === 1 && agent === 3 && symbol === "V75",
    observeSelfTradeCandidate: async (ownerId: number, agentId: number, symbol: string) => {
      readCount++;
      if (ownerId !== 1 || agentId !== 3 || !["EURUSD", "V75"].includes(symbol)) return null;
      return {
        evaluatedAt: slot + 1_000,
        candidate: {
          setup: "TREND_CONTINUATION", outcome: counterargumentCase === "BASELINE_WAIT" ? "WAIT"
            : counterargumentCase || regimeCase ? "APPROVED" : "APPROVED_REDUCED",
          reason: "Higher timeframe opposes.", checks: [{
            key: "mtf_alignment", label: "Higher timeframe alignment", status: "WARN", detail: "Higher timeframe opposes.", blocking: false,
          }],
          side: "BUY",
          setupExpiresAt: new Date(slot + 15_000).toISOString(),
          thesis: { side: "BUY", entryZone: counterargumentCase === "CHASE" ? { from: 1.0999, to: 1.1 }
            : counterargumentCase === "WAIT_ZONE" ? { from: 1.1002, to: 1.1004 } : { from: 1.1, to: 1.1001 }, stopLoss: 1.099,
            takeProfits: [{ from: 1.102 }] },
        },
        observation: {
          input: { signal: {
            dataSource, hasSufficientData: true, generatedAt: new Date(slot + 500).toISOString(),
            regime: regimeCase ?? "TREND", direction: "BUY", bias: "BULLISH", lifecycleStage: "ENTRY_READY", session: { session: "LONDON" },
            earlyTrend: { blind: false, momentum: counterargumentCase === "REDUCE" ? "COMPRESSING" : "STEADY",
              pressure: counterargumentCase === "REDUCE" ? "FADING" : "BUILDING_BULLISH", structure: "HH_HL" },
            fakeout: counterargumentCase === "VETO" ? { detected: true, kind: "BULL_TRAP" } : { detected: false, kind: "NONE" },
            late: { isLate: false, doNotChase: false, reason: null },
            marketEvidence: { symbol, timeframe: "M5", source: symbol === "V75" ? "deriv_public" : "mt5_broker", sourceIdentity,
              userId: ownerId, lastClosedCandleAt: new Date(slot).toISOString() },
          } },
          chartConfirmation: { allowed: true, reason: null },
          boundQuote: { bid: 1.1, ask: 1.1001, observedAt: new Date(slot + 1_000 + quoteOffset).toISOString() },
          mt5QuoteOrigin: symbol === "EURUSD" ? mt5QuoteOrigin : null,
          ...(symbol === "V75" && derivQuoteOrigin !== undefined ? { derivQuoteOrigin } : {}),
        },
      };
    },
  } });

  const { pool } = await import("@workspace/db");
  try {
    await pool.query("CREATE TABLE users (id integer PRIMARY KEY); INSERT INTO users (id) VALUES (1), (2)");
    for (const migration of migrations) await pool.query(migration);
    await pool.query(`
      CREATE TABLE arx_live_commands (id integer PRIMARY KEY, command_id text, bridge_connection_id integer,
        user_id integer, command_type text, sent_to_mt5_at timestamptz, status text, symbol text, side text,
        payload jsonb, broker_ticket text, executed_volume double precision, fill_price double precision,
        requested_volume double precision, self_trade_decision_id integer, self_trade_agent_id integer);
      CREATE TABLE self_trade_decisions (id integer PRIMARY KEY, agent_id integer, symbol text, side text, score_breakdown jsonb);
      CREATE TABLE execution_events (command_id integer, event_type text, source text, sequence_no integer, payload jsonb,
        received_at timestamptz DEFAULT now(), occurred_at timestamptz DEFAULT now());
      CREATE TABLE mt5_demo_commands (command_id text PRIMARY KEY, bridge_connection_id integer, sent_at timestamp,
        status text, user_id integer, command_type text, routed_via_master boolean, payload jsonb, broker_order_id text,
        fill_volume double precision, fill_price double precision, broker_raw_result jsonb, broker_ticket text, terminal_at timestamp);
      CREATE TABLE security_events (metadata jsonb, actor_user_id integer, event_type text, status text, created_at timestamptz);
      CREATE TABLE bridge_v2_events (id serial PRIMARY KEY, user_id integer, bridge_connection_id integer,
        protocol_version integer, message_type text, stream_key text, sequence bigint, idempotency_key text, ea_version text,
        sequence_verdict text, gap_size integer DEFAULT 0, duplicate_dropped boolean DEFAULT false, accepted boolean,
        reject_reason text, lifecycle_state text, ea_created_at_epoch_ms bigint, server_received_at_epoch_ms bigint,
        transport_latency_ms integer, freshness_verdict text, payload jsonb, created_at timestamptz DEFAULT now(),
        UNIQUE (user_id, idempotency_key));
      CREATE TABLE bridge_v2_stream_state (id serial PRIMARY KEY, user_id integer, bridge_connection_id integer,
        message_type text, stream_key text, last_sequence bigint, last_idempotency_key text, last_event_at timestamptz,
        last_ea_created_at_epoch_ms bigint, total_accepted bigint DEFAULT 0, total_duplicates bigint DEFAULT 0,
        total_gaps bigint DEFAULT 0, total_missed bigint DEFAULT 0, total_resets bigint DEFAULT 0, total_rejected bigint DEFAULT 0,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE (user_id, bridge_connection_id, message_type, stream_key));
    `);
    await pool.query(await readFile(new URL("../../../../../../lib/db/migrations/2026-11-24_ati_deal_history_receipts.sql", import.meta.url), "utf8"));
    await pool.query(await readFile(new URL("../../../../../../lib/db/migrations/2026-11-24_ati_tick_replay.sql", import.meta.url), "utf8"));
    const { startAtiShadowRun, appendAtiShadowObservation, readAtiShadowRun, gradeAtiShadowRun } = await import("../atiShadow.js");
    const pilot = { symbol: "EURUSD", setup: "TREND_CONTINUATION", durationMinutes: 45 } as const;
    assert.equal(await startAtiShadowRun(2, 3, pilot), null);
    const started = await startAtiShadowRun(1, 3, pilot);
    assert.ok(started);
    const { runId } = started;
    const before = readCount;
    assert.equal(await readAtiShadowRun(2, 3, runId), null);
    assert.equal((await appendAtiShadowObservation(2, 3, runId)).status, "NOT_FOUND");
    assert.equal((await appendAtiShadowObservation(1, 4, runId)).status, "NOT_FOUND");
    assert.equal(readCount, before, "wrong scope never triggers a market read");

    assert.equal((await appendAtiShadowObservation(1, 3, runId)).status, "ALREADY_OBSERVED");
    slot += 300_000;
    const concurrent = await Promise.all([
      appendAtiShadowObservation(1, 3, runId), appendAtiShadowObservation(1, 3, runId),
    ]);
    assert.deepEqual(concurrent.map((result) => result.status).sort(), ["ALREADY_OBSERVED", "RECORDED"]);

    sourceIdentity = "source-two";
    const changed = await appendAtiShadowObservation(1, 3, runId);
    assert.equal("coverage" in changed ? changed.coverage : null, "SOURCE_CHANGED");
    slot += 300_000;
    dataSource = "SIMULATOR";
    const synthetic = await appendAtiShadowObservation(1, 3, runId);
    assert.equal("coverage" in synthetic ? synthetic.coverage : null, "NO_OBSERVED_FEED");
    slot += 300_000;
    dataSource = "LIVE_FEED";
    sourceIdentity = "source-one";
    quoteOffset = 1;
    const future = await appendAtiShadowObservation(1, 3, runId);
    assert.equal("coverage" in future ? future.coverage : null, "NO_OBSERVED_FEED");

    const restarted = await import(new URL("../atiShadow.ts?restart", import.meta.url).href);
    const report = await restarted.readAtiShadowRun(1, 3, runId);
    assert.deepEqual(report?.counts, {
      observations: 5, paired: 2, different: 2, noObservedFeed: 2, sourceChanged: 1, ungraded: 2, unresolved: 0,
    });
    assert.equal(report?.executionAuthority, "NONE");
    assert.equal(report?.executionCosts.live.commandCount, 0);
    assert.equal(report?.executionCosts.demo.commandCount, 0);
    assert.deepEqual(report?.observations[0]?.chartConfirmation, { allowed: true, reason: null });
    assert.equal(report?.observations[0]?.baselineOutcome, "APPROVED_REDUCED");
    assert.equal(report?.observations[0]?.challengerOutcome, "WAIT");
    assert.ok(Math.abs(report?.observations[0]?.decisionQuote?.spreadPriceUnits - 0.0001) < 1e-12);
    assert.ok(report?.observations.filter((row: { coverage: string; decisionQuote: unknown }) =>
      row.coverage !== "OBSERVED").every((row: { decisionQuote: unknown }) => row.decisionQuote === null));
    assert.equal("evidence" in report.observations[0], false, "raw account-dependent inputs stay out of the report");

    slot = base - 300_000;
    quoteOffset = -1;
    const deriv = await startAtiShadowRun(1, 3, {
      ...pilot, symbol: "V75", assumedCosts: { adverseSlippagePerFillPriceUnits: 0.0001, feePerFillPriceUnits: 0.00005 },
    });
    assert.ok(deriv);
    const { publicPaperBrackets } = await import("../../tradeEngine/publicPaperBrackets.js");
    function tick(offset: number, bid: number, ask: number) {
      publicPaperBrackets.observe({ symbol: "R_75", epoch: (slot + offset) / 1000, quote: bid, bid, ask });
    }
    tick(1000, 1.105, 1.1051); // available at decision time, cannot fill the entry
    assert.equal((await gradeAtiShadowRun(1, 3, deriv.runId))?.pending, 1);
    tick(2000, 1.1000, 1.1001);
    tick(4000, 1.1029, 1.1030);
    assert.equal(await gradeAtiShadowRun(2, 3, deriv.runId), null);
    const results = await Promise.all([gradeAtiShadowRun(1, 3, deriv.runId), gradeAtiShadowRun(1, 3, deriv.runId)]);
    assert.equal(results.reduce((total, value) => total + (value?.recorded ?? 0), 0), 1);
    const settled = await restarted.readAtiShadowRun(1, 3, deriv.runId);
    const fill = settled?.observations[0]?.grade;
    assert.equal(fill?.state, "SIMULATED_FILL");
    assert.equal(fill.entry, 1.1001);
    assert.equal(fill.exit, 1.1029);
    assert.equal(fill.exitObservedAt, slot + 4000);
    assert.equal(fill.observedPath?.samples, 2);
    assert.ok(Math.abs(fill.observedPath!.adverse!.signedPriceUnits + 0.0001) < 1e-12);
    assert.ok(Math.abs(fill.quoteSidePnl.baselineR - (0.0028 / 0.0011) * 0.5) < 1e-10);
    assert.ok(Math.abs(fill.pnlWithAssumedCosts.baselineR - (0.0025 / 0.0011) * 0.5) < 1e-10);
    assert.equal(fill.pnlWithAssumedCosts.challengerR, 0);
    assert.equal(settled?.simulations.withAssumedCosts.winnersSkipped, 1);
    assert.equal(settled?.simulations.withAssumedCosts.challenger.expectancyR, null);
    assert.equal(settled?.counts.ungraded, 0);

    const { recordPublicDerivQuote, flushAtiDerivQuotes } = await import("../../data/atiDerivQuotes.js");
    const { ATI_DERIV_ARCHIVE_GRADE_VERSION } = await import("../atiShadowGrading.js");
    slot = base - 24 * 60 * 60_000;
    quoteOffset = 0;
    const streamId = randomUUID();
    let derivClockAt = slot + 1_000;
    const derivClock = mock.method(Date, "now", () => derivClockAt);
    const frame = (stream: string, offset: number, bid: number, ask: number, receivedOffset = offset, releasedOffset = offset) => {
      recordPublicDerivQuote({ symbol: "R_75", epoch: (slot + offset) / 1000, quote: bid, bid, ask },
        stream, slot + receivedOffset, slot + releasedOffset);
    };
    let archivedDerivId: string;
    let guardianPilotId: string;
    try {
      derivQuoteOrigin = { streamId, symbol: "R_75", epoch: (slot + 1000) / 1000 };
      frame(streamId, 1000, 1.1, 1.1001);
      const archivedDeriv = await startAtiShadowRun(1, 3, { ...pilot, symbol: "V75",
        assumedCosts: { adverseSlippagePerFillPriceUnits: 0.01, feePerFillPriceUnits: 0.01 } });
      assert.ok(archivedDeriv);
      archivedDerivId = archivedDeriv.runId;
      const { guardianComparisonPolicy } = await import("../atiGuardian.js");
      const guardianPilot = await startAtiShadowRun(1, 3, { ...pilot, symbol: "V75", challengerVersion: guardianComparisonPolicy.version,
        assumedCosts: { adverseSlippagePerFillPriceUnits: 0.01, feePerFillPriceUnits: 0.01 } });
      assert.ok(guardianPilot);
      guardianPilotId = guardianPilot.runId;
      frame(streamId, 2000, 1.1, 1.1001);
      frame(streamId, 4000, 1.1029, 1.103, 3900, 4100);
      derivClockAt = slot + 4050;
      assert.equal((await gradeAtiShadowRun(1, 3, archivedDerivId))?.pending, 1, "staged exit stays invisible before release");
      await flushAtiDerivQuotes();
      derivClockAt = slot + 4300;
      assert.equal((await restarted.gradeAtiShadowRun(1, 3, archivedDerivId))?.recorded, 1);
      const archivedReport = await restarted.readAtiShadowRun(1, 3, archivedDerivId);
      const grade = archivedReport?.observations[0]?.grade;
      assert.ok(grade?.state === "SIMULATED_FILL" && grade.derivReplay);
      assert.equal(archivedReport?.observations[0]?.gradeVersion, ATI_DERIV_ARCHIVE_GRADE_VERSION);
      assert.equal(grade.exitObservedAt, slot + 4100);
      assert.equal(grade.derivReplay.samples, 2);
      assert.equal(JSON.stringify(archivedReport).includes(streamId), false);
      const { readAtiGuardianComparison } = await import("../atiGuardianReport.js");
      const key = archivedReport!.observations[0]!.observationKey;
      const afterRecording = new Date(new Date().getTime() + 1_000);
      const compare = (owner: number) => readAtiGuardianComparison(owner, 3, archivedDerivId, key, afterRecording);
      assert.equal(await compare(2), null);
      assert.equal(await readAtiGuardianComparison(1, 3, archivedDerivId, key, new Date(slot)), null);
      const management = await compare(1);
      assert.ok(management && "samples" in management && management.state === "SETTLED_PAIR");
      assert.equal(management.pairedDeltaR, 0);
      assert.equal(management.samples, 2);
      assert.equal(management.baseline.exit?.price, grade.exit);
      assert.deepEqual(await compare(1), management);
      assert.equal((await restarted.gradeAtiShadowRun(1, 3, guardianPilotId))?.recorded, 1);
      const managedRun = await readAtiShadowRun(1, 3, guardianPilotId);
      const managedGrade = managedRun?.observations[0]?.grade;
      assert.ok(managedGrade?.state === "GUARDIAN_COMPARISON" && managedGrade.status === "SETTLED_PAIR");
      assert.equal(managedGrade.sampleHash, management.sampleHash);
      assert.equal(managedGrade.archivePrefixHash, grade.derivReplay.tapeHash);
      assert.equal(managedRun?.guardianCoverage?.eligible, 1);
      assert.equal(managedRun?.simulations.withAssumedCosts?.settledPairs, 1);

      slot += 300_000;
      derivClockAt = slot + 1000;
      derivQuoteOrigin = { streamId, symbol: "R_75", epoch: (slot + 1000) / 1000 };
      frame(streamId, 1000, 1.1, 1.1001);
      const disconnected = await startAtiShadowRun(1, 3, { ...pilot, symbol: "V75" });
      assert.ok(disconnected);
      frame(streamId, 2000, 1.1, 1.1001);
      frame(randomUUID(), 4000, 1.103, 1.1031);
      derivClockAt = slot + 60 * 60_000 + 1100;
      assert.equal((await gradeAtiShadowRun(1, 3, disconnected.runId))?.recorded, 1);
      const disconnectedReport = await readAtiShadowRun(1, 3, disconnected.runId);
      assert.deepEqual(disconnectedReport?.observations[0]?.grade, { state: "UNRESOLVED", reason: "QUOTE_HISTORY_INCOMPLETE" });
      derivQuoteOrigin = null;
      derivClockAt = slot + 1000;
      const unbound = await startAtiShadowRun(1, 3, { ...pilot, symbol: "V75" });
      assert.ok(unbound);
      derivClockAt += 1000;
      assert.equal((await gradeAtiShadowRun(1, 3, unbound.runId))?.recorded, 1);
      assert.deepEqual((await readAtiShadowRun(1, 3, unbound.runId))?.observations[0]?.grade,
        { state: "UNRESOLVED", reason: "DERIV_REPLAY_ORIGIN_UNVERIFIED" });
    } finally {
      derivClock.mock.restore();
      derivQuoteOrigin = undefined;
      quoteOffset = -1;
      slot = base - 300_000;
    }

    const unsupported = await startAtiShadowRun(1, 3, pilot);
    assert.ok(unsupported);
    await pool.query("UPDATE ati_shadow_observations SET evidence = evidence - 'mt5QuoteOrigin' WHERE run_id = $1", [unsupported.runId]);
    assert.equal((await gradeAtiShadowRun(1, 3, unsupported.runId))?.recorded, 1);
    const ungraded = await readAtiShadowRun(1, 3, unsupported.runId);
    assert.deepEqual(ungraded?.observations[0]?.grade, { state: "UNRESOLVED", reason: "MT5_REPLAY_ORIGIN_UNVERIFIED" });
    assert.equal(ungraded?.counts?.unresolved, 1);
    assert.equal(ungraded?.simulations.quoteSideOnly.pairedDifferenceR, null);

    const { atiCostReceiptFromResult } = await import("../../mt5/atiCostEvidence.js");
    const fillTime = slot + 3000;
    const bridge = { accountNumber: "432100", serverName: "Fixture-Broker", accountType: "real" };
    const costWire = {
      version: 1, mode: "LIVE", accountLogin: bridge.accountNumber, serverName: bridge.serverName,
      order: "801", deal: "901", symbol: "EURUSD", side: "BUY", volume: 0.02,
      price: 1.1003, brokerFilledAtMs: fillTime,
      submissionQuote: { bid: 1.1000, ask: 1.1002, brokerTickAtMs: fillTime - 10 },
      currency: "USD", commission: 0, fee: -0.04, swap: null,
    };
    const resultWire = {
      resultEvidenceVersion: 1, resultKind: "ENTRY", tradeCallSucceeded: true, mt5Retcode: 10009,
      resultOrder: "801", resultDeal: "901", resultVolume: 0.02, resultPrice: 1.1003,
    };
    const liveCost = atiCostReceiptFromResult({ ...resultWire, atiExecutionCostV1: costWire }, bridge, "LIVE");
    assert.ok(liveCost);
    assert.equal("accountLogin" in liveCost, false);
    assert.equal(atiCostReceiptFromResult({ ...resultWire, resultDeal: "900", atiExecutionCostV1: costWire }, bridge, "LIVE"), null);
    assert.equal(atiCostReceiptFromResult({ ...resultWire, atiExecutionCostV1: costWire }, { ...bridge, serverName: "Other-Server" }, "LIVE"), null);
    const stamp = new Date(slot + 2000);
    const decision = {
      mode: "LIVE", ownerId: 1, bridgeConnectionId: 11, accountBinding: liveCost.accountBinding,
      brokerSymbol: "EURUSD", bid: 1.0999, ask: 1.1000, brokerTickAtMs: fillTime - 1800,
      observedAtMs: slot + 1200, decidedAtMs: slot + 1500,
    };
    for (const [id, agentId, costQuote] of [
      [1, 3, decision],
      [5, 3, { ...decision, decidedAtMs: +stamp + 1 }],
      [6, 3, { ...decision, accountBinding: "0".repeat(64) }],
      [7, 9, decision],
    ] as const) {
      await pool.query("INSERT INTO self_trade_decisions VALUES ($1,$2,'EURUSD','BUY',$3)", [
        id, agentId, { atiDecisionQuoteV1: costQuote },
      ]);
    }
    for (const [id, ownerId, order] of [
      [1, 1, "801"], [2, 1, "802"], [3, 2, "801"], [4, 1, "801"],
      [5, 1, "805"], [6, 1, "806"], [7, 1, "807"],
    ] as const) {
      const deal = id >= 5 ? `90${id}` : liveCost.deal;
      await pool.query(`INSERT INTO arx_live_commands VALUES
        ($1,$2,11,$3,'PLACE_LIVE_MARKET_ORDER',$4,'LIVE_FILLED','EURUSD','BUY','{}',$5,0.02,1.1003,0.02,$1,3)`,
      [id, `live-${id}`, ownerId, stamp, order]);
      await pool.query("INSERT INTO execution_events VALUES ($1,'DISPATCH_SENT','arx',1,$2)", [id, {
        commandId: `live-${id}`, bridgeConnectionId: 11, atiAccountBinding: liveCost.accountBinding,
      }]);
      await pool.query("INSERT INTO execution_events VALUES ($1,'RESULT_LIVE_FILLED','ea',2,$2)", [id, {
        applied: true, commandId: `live-${id}`, reportingBridgeConnectionId: 11,
        atiCostEvidence: id >= 5 ? { ...liveCost, order, deal } : liveCost,
        terminalResultEvidence: id >= 5 ? { ...resultWire, resultOrder: order, resultDeal: deal } : resultWire,
      }]);
    }
    await pool.query("INSERT INTO execution_events VALUES (4,'LATE_RESULT_RETAINED','ea',3,$1)", [{
      reportedOutcome: "LIVE_FILLED", brokerTicket: "801", fillPrice: 1.1004, executedVolume: 0.02,
    }]);
    const demoCost = atiCostReceiptFromResult({
      ...resultWire, atiExecutionCostV1: { ...costWire, mode: "DEMO", submissionQuote: null, commission: null },
    }, { ...bridge, accountType: "demo" }, "DEMO");
    assert.ok(demoCost);
    await pool.query(`INSERT INTO mt5_demo_commands VALUES ('demo-1',22,$1,'FILLED_DEMO',1,
      'PLACE_MARKET_ORDER',false,'{"symbol":"EURUSD","side":"BUY","lotSize":0.02}',NULL,0.02,1.1003,$2,NULL)`,
    [stamp.toISOString(), { ...resultWire, atiCostEvidence: demoCost }]);
    await pool.query("INSERT INTO security_events VALUES ($1,1,'DEMO_DISPATCH_SENT','ALLOWED',$2)", [{
      commandId: "demo-1", bridgeConnectionId: 22, atiAccountBinding: demoCost.accountBinding,
    }, stamp]);

    const costs = (await readAtiShadowRun(1, 3, unsupported.runId))?.executionCosts;
    assert.ok(costs);
    assert.equal(costs?.live.commandCount, 6, "the other owner's command stays out of the report");
    assert.equal(costs?.live.reconciledDealCount, 4);
    assert.deepEqual(costs?.live.coverage, { spread: 4, slippage: 4, movementBeforeSubmission: 1, commission: 4, fees: 4, swap: 0 });
    const reportedCommand = costs?.live.results.find((row) => row.commandId === "live-1");
    assert.equal(reportedCommand?.decisionBenchmarkSource, "LINKED_DECISION_RECORD");
    const sample = reportedCommand.result;
    assert.equal(sample?.state, "OBSERVED_BROKER_DEAL");
    assert.ok(Math.abs(sample.spreadPriceUnits! - 0.0002) < 1e-12);
    assert.ok(Math.abs(sample.adverseSlippagePriceUnits! - 0.0001) < 1e-12);
    assert.deepEqual(sample.charges, { currency: "USD", commission: 0, fee: -0.04, swap: null });
    assert.ok(Math.abs(sample.adverseMovementBeforeSubmissionPriceUnits! - 0.0002) < 1e-12);
    assert.deepEqual(sample.decisionQuote, {
      bid: decision.bid, ask: decision.ask, brokerTickAtMs: decision.brokerTickAtMs,
      observedAtMs: decision.observedAtMs, decidedAtMs: decision.decidedAtMs,
    });
    for (const id of [5, 6, 7]) {
      const rejectedQuote: (typeof costs.live.results)[number]["result"] | undefined =
        costs.live.results.find((row) => row.commandId === `live-${id}`)?.result;
      assert.equal(rejectedQuote?.state, "OBSERVED_BROKER_DEAL");
      assert.equal(rejectedQuote.decisionQuote, null);
      assert.equal(rejectedQuote.adverseMovementBeforeSubmissionPriceUnits, null);
    }
    assert.deepEqual(costs?.live.results.find((row) => row.commandId === "live-2")?.result,
      { state: "UNRESOLVED", reason: "COMMAND_DEAL_MISMATCH" });
    assert.deepEqual(costs?.live.results.find((row) => row.commandId === "live-4")?.result,
      { state: "UNRESOLVED", reason: "CONFLICTING_FILL_REPORTS" });
    assert.equal(costs?.demo.commandCount, 1);
    assert.equal(costs?.demo.reconciledDealCount, 1, JSON.stringify(costs?.demo.results[0]?.result));
    assert.deepEqual(costs?.demo.coverage, { spread: 0, slippage: 0, movementBeforeSubmission: 0, commission: 0, fees: 1, swap: 0 });
    const demoSample = costs?.demo.results[0]?.result;
    assert.equal(demoSample?.state, "OBSERVED_BROKER_DEAL");
    assert.equal(demoSample.spreadPriceUnits, null);
    assert.equal(demoSample.adverseSlippagePriceUnits, null);
    assert.equal(demoSample.charges?.commission, null);

    const closeWire = {
      ...costWire, leg: "EXIT", order: "821", deal: "921", side: "SELL", volume: 0.01, price: 1.0999,
      positionTicket: "9007199254740993", positionId: "8007199254740993", swap: -0.15,
    };
    const closeResult = {
      ...resultWire, resultKind: "CLOSE", mt5Retcode: 10010, positionTicket: closeWire.positionTicket,
      resultOrder: closeWire.order, resultDeal: closeWire.deal, resultVolume: closeWire.volume, resultPrice: closeWire.price,
    };
    assert.equal(atiCostReceiptFromResult({ ...closeResult, mt5PositionTicket: "10", atiExecutionCostV1: closeWire }, bridge, "LIVE"), null);
    assert.equal(atiCostReceiptFromResult({ ...closeResult, atiExecutionCostV1: { ...closeWire, positionId: undefined } }, bridge, "LIVE"), null);
    for (const [id, order, deal, target, executedVolume] of [
      [21, "821", "921", closeWire.positionTicket, 0.01],
      [22, "822", "922", "9007199254740994", 0.01],
      [23, "823", "923", closeWire.positionTicket, 0.02],
      [24, "824", "924", closeWire.positionTicket, 0.01],
      [25, "824", "924", closeWire.positionTicket, 0.01],
    ] as const) {
      const terminal = { ...closeResult, resultOrder: order, resultDeal: deal };
      const receipt = atiCostReceiptFromResult({ ...terminal, atiExecutionCostV1: { ...closeWire, order, deal } }, bridge, "LIVE");
      assert.ok(receipt);
      await pool.query(`INSERT INTO arx_live_commands VALUES
        ($1,$2,11,1,'CLOSE_LIVE_POSITION',$3,'LIVE_PARTIALLY_FILLED','EURUSD','BUY',$4,$5,$6,1.0999,0.02,1,3)`,
      [id, `live-${id}`, stamp, { brokerTicket: target }, closeWire.positionTicket, executedVolume]);
      await pool.query("INSERT INTO execution_events VALUES ($1,'DISPATCH_SENT','arx',1,$2), ($1,'RESULT_LIVE_PARTIALLY_FILLED','ea',2,$3)", [
        id, { commandId: `live-${id}`, bridgeConnectionId: 11, atiAccountBinding: receipt.accountBinding },
        { applied: true, commandId: `live-${id}`, reportingBridgeConnectionId: 11, atiCostEvidence: receipt, terminalResultEvidence: terminal },
      ]);
    }
    const demoClose = atiCostReceiptFromResult({
      ...closeResult, atiExecutionCostV1: { ...closeWire, mode: "DEMO" },
    }, { ...bridge, accountType: "demo" }, "DEMO");
    assert.ok(demoClose);
    await pool.query(`INSERT INTO mt5_demo_commands VALUES ('demo-close',22,$1,'FILLED_DEMO',1,
      'CLOSE_POSITION',false,$2,NULL,0.01,1.0999,$3,$4)`, [stamp.toISOString(),
      { symbol: "EURUSD", side: "BUY", lotSize: 0.02, ticket: closeWire.positionTicket },
      { ...closeResult, atiCostEvidence: demoClose }, closeWire.positionTicket]);
    await pool.query("INSERT INTO security_events VALUES ($1,1,'DEMO_DISPATCH_SENT','ALLOWED',$2)", [{
      commandId: "demo-close", bridgeConnectionId: 22, atiAccountBinding: demoClose.accountBinding,
    }, stamp]);

    const withExits = (await readAtiShadowRun(1, 3, unsupported.runId))?.executionCosts;
    assert.ok(withExits);
    assert.deepEqual(withExits.live.exits, { commandCount: 5, reconciledDealCount: 1 });
    assert.deepEqual(withExits.demo.exits, { commandCount: 1, reconciledDealCount: 1 });
    assert.equal(withExits.brokerTriggeredExits.live.distinctDeals, 0);
    const exit = withExits.live.results.find((row) => row.commandId === "live-21")?.result;
    assert.equal(exit?.state, "OBSERVED_BROKER_DEAL");
    assert.equal(exit.leg, "EXIT");
    assert.equal(exit.positionTicket, closeWire.positionTicket);
    assert.equal(exit.positionId, closeWire.positionId);
    assert.equal(exit.order, closeWire.order);
    assert.equal(exit.deal, closeWire.deal);
    assert.equal(exit.side, "SELL");
    assert.equal(exit.volume, 0.01);
    assert.equal(exit.remainingRequestedVolume, 0.01);
    assert.equal(exit.charges?.swap, -0.15);
    assert.ok(Math.abs(exit.adverseSlippagePriceUnits! - 0.0001) < 1e-12);
    assert.equal(exit.adverseMovementBeforeSubmissionPriceUnits, null);
    const rejected = withExits.live.results.filter((row) => ["live-22", "live-23", "live-24", "live-25"].includes(row.commandId));
    assert.deepEqual(rejected.map((row) => row.result), ["COMMAND_POSITION_MISMATCH", "COMMAND_DEAL_MISMATCH",
      "DEAL_CLAIMED_BY_MULTIPLE_COMMANDS", "DEAL_CLAIMED_BY_MULTIPLE_COMMANDS"].map((reason) => ({ state: "UNRESOLVED", reason })));

    const { ingestBridgeV2Message } = await import("../../bridgeV2/ingest.js");
    const historyPayload = {
      dealTicket: "931", positionTicket: closeWire.positionId, symbol: "EURUSD", side: "SELL", volume: 0.01,
      price: 1.0999, profit: -2, commission: 0, swap: null, closedAtEpochMs: fillTime + 7_200_000,
      atiTriggeredExit: {
        version: 1, trigger: "STOP_LOSS", orderTicket: "831", positionId: closeWire.positionId, triggerPrice: 1.1,
        currency: "USD", fee: -0.02,
        order: { ticket: "831", positionId: closeWire.positionId, symbol: "EURUSD", trigger: "STOP_LOSS", side: "SELL", initialVolume: 0.02 },
        account: { login: bridge.accountNumber, server: bridge.serverName, mode: "LIVE" },
      },
    } as const;
    const sequences = new Map<number, number>();
    async function ingestHistory(payload: unknown, opts: { owner?: number; bridgeId?: number; receivedAt?: number;
      mode?: "LIVE" | "DEMO"; binding?: string } = {}) {
      const id = opts.bridgeId ?? 11;
      const at = opts.receivedAt ?? fillTime + 20;
      const sequence = sequences.get(id) ?? 0;
      sequences.set(id, sequence + 1);
      const result = await ingestBridgeV2Message({
        userId: opts.owner ?? 1, bridgeConnectionId: id, serverReceivedAtEpochMs: at,
        atiAccount: { binding: opts.binding ?? liveCost!.accountBinding, mode: opts.mode ?? "LIVE" },
        raw: { protocolVersion: 2, messageType: "DEAL_HISTORY", streamKey: "ati-protective-exits-v1", sequence,
          idempotencyKey: `fixture-exit-${id}-${sequence}`, eaCreatedAtEpochMs: at - 10, eaVersion: "fixture", payload },
      });
      assert.equal(result.accepted, true, JSON.stringify(result));
    }
    function withHistoryOrder(dealTicket: string, orderTicket: string, volume = 0.01) {
      return { ...historyPayload, dealTicket, volume, atiTriggeredExit: { ...historyPayload.atiTriggeredExit, orderTicket,
        order: { ...historyPayload.atiTriggeredExit.order, ticket: orderTicket } } };
    }
    await ingestHistory(historyPayload);
    await ingestHistory(historyPayload); // Same broker deal, distinct transport receipt.
    await ingestHistory({ ...historyPayload, dealTicket: "932" }); // Second execution of the same 0.02-lot order.
    const enriched = withHistoryOrder("933", "833");
    await ingestHistory({ ...enriched, atiTriggeredExit: { ...enriched.atiTriggeredExit, order: null } });
    await ingestHistory(enriched, { receivedAt: fillTime + 21 });
    const missing = withHistoryOrder("934", "834");
    await ingestHistory({ ...missing, atiTriggeredExit: { ...missing.atiTriggeredExit, order: null } });
    await ingestHistory(withHistoryOrder("935", "835"));
    await ingestHistory({ ...withHistoryOrder("935", "835"), price: 1.0997 });
    const mismatch = withHistoryOrder("936", "836");
    await ingestHistory({ ...mismatch, atiTriggeredExit: { ...mismatch.atiTriggeredExit,
      order: { ...mismatch.atiTriggeredExit.order, positionId: "66" } } });
    await ingestHistory(withHistoryOrder("937", "837", 0.015));
    await ingestHistory(withHistoryOrder("938", "837", 0.01));
    await ingestHistory({ ...historyPayload, dealTicket: "939", atiTriggeredExit: { ...historyPayload.atiTriggeredExit,
      account: { ...historyPayload.atiTriggeredExit.account, server: "Wrong-Server" } } });
    await ingestHistory({ ...historyPayload, dealTicket: "940" }, { owner: 2, bridgeId: 31 });
    await ingestHistory({ ...historyPayload, dealTicket: "941" }, { receivedAt: +unsupported.endsAt });
    await ingestHistory({ ...historyPayload, side: "BUY", price: 1.0998,
      atiTriggeredExit: { ...historyPayload.atiTriggeredExit, trigger: "TAKE_PROFIT", fee: null,
        account: { ...historyPayload.atiTriggeredExit.account, mode: "DEMO" },
        order: { ...historyPayload.atiTriggeredExit.order, side: "BUY", trigger: "TAKE_PROFIT" } } }, { bridgeId: 22, mode: "DEMO" });

    const brokerExits = (await readAtiShadowRun(1, 3, unsupported.runId))?.executionCosts.brokerTriggeredExits;
    assert.ok(brokerExits);
    assert.equal(brokerExits.scope, "OWNER_INSTRUMENT_RECEIPT_WINDOW");
    assert.equal(brokerExits.historyRowsWithoutVerifiedAccount, 1);
    assert.equal(brokerExits.duplicateReceipts, 3);
    assert.equal(brokerExits.live.distinctDeals, 8);
    assert.equal(brokerExits.live.reconciledDeals, 3);
    const enrichedExit = brokerExits.live.results.find((row) => row.deal === "933");
    assert.equal(enrichedExit?.receivedAtMs, fillTime + 20);
    assert.equal(enrichedExit?.evidenceReceivedAtMs, fillTime + 21);
    assert.deepEqual(brokerExits.live.coverage, { movementFromTrigger: 3, commission: 3, fees: 3, swap: 0 });
    const brokerExit = brokerExits.live.results[0]?.result;
    assert.equal(brokerExit?.state, "OBSERVED_BROKER_TRIGGERED_EXIT");
    assert.equal(brokerExit?.brokerFilledAtMs, fillTime + 7_200_000, "broker clock is retained without using it as UTC");
    assert.ok(Math.abs(brokerExit.adverseMovementFromTriggerPriceUnits! - 0.0001) < 1e-12);
    assert.deepEqual(brokerExit.charges, { currency: "USD", commission: 0, fee: -0.02, swap: null });
    assert.deepEqual(brokerExits.live.results.slice(3).map((row) => row.result), [
      "BROKER_ORDER_HISTORY_UNAVAILABLE", "CONFLICTING_BROKER_DEAL_RECEIPTS", "BROKER_ORDER_DEAL_MISMATCH",
      "CONFLICTING_ORDER_VOLUME_OR_IDENTITY", "CONFLICTING_ORDER_VOLUME_OR_IDENTITY",
    ].map((reason) => ({ state: "UNRESOLVED", reason })));
    assert.equal(brokerExits.demo.reconciledDeals, 1);
    assert.equal(brokerExits.demo.results[0]?.trigger, "TAKE_PROFIT");
    const demoExit = brokerExits.demo.results[0]?.result;
    assert.equal(demoExit?.state, "OBSERVED_BROKER_TRIGGERED_EXIT");
    assert.ok(Math.abs(demoExit.adverseMovementFromTriggerPriceUnits! + 0.0002) < 1e-12);
    const trace = await pool.query("SELECT payload FROM bridge_v2_events WHERE user_id = 1");
    assert.ok(trace.rows.every((row) => !JSON.stringify(row.payload).includes(bridge.accountNumber)));
    assert.equal(JSON.stringify(brokerExits).includes(liveCost.accountBinding), false);

    await t.test("native position history joins exact entry, commanded partial close and protective exit", async () => {
      const { readAtiExecutionCosts } = await import("../atiExecutionCosts.js");
      const symbol = "EURCHF", positionId = "990001", positionTicket = "999001";
      const read = (owner = 1, from = stamp, until = new Date(+stamp + 60_000)) => readAtiExecutionCosts(owner, symbol, from, until);
      const { entrySnapshotHash } = await import("../entryAuthority.js");
      const version = { engine: "SELF_TRADE_FLEET_DECISION", build: { sourceState: "clean", revision: "a".repeat(40) },
        decisionSettingsHash: "c".repeat(64) };
      const admissionSnapshot = { version: 1, agent: { id: 3, agentKey: "atlas", ownerType: "USER", ownerId: 1 },
        settings: { agentId: 3 }, ledger: { agentId: 3 }, order: { symbol, side: "BUY", volume: 0.03 },
        decision: { id: 7001, agentId: 3, agentKey: "atlas", setupType: "TREND_CONTINUATION", timeframe: "M5", symbol,
          side: "BUY", outcome: "APPROVED", evaluatedAt: new Date(+stamp-1).toISOString(), scoreBreakdown: { atiFleetDecisionV1: version, atiDecisionQuoteV1: { ...decision, brokerSymbol: symbol } } } };
      const envelope = { version: 1, executionId: 19, snapshotHash: entrySnapshotHash(admissionSnapshot) };
      const draft = { agentOwnership: { selfTradeAgentId: 3, selfTradeDecisionId: 7001 }, agentAdmissionV1: envelope };
      await pool.query("CREATE TABLE self_trade_agent_executions (id integer PRIMARY KEY, agent_id integer, decision_id integer, executing_user_id integer, command_id text, mode text, management_state jsonb)");
      await pool.query("INSERT INTO self_trade_agent_executions VALUES (19,3,7001,1,'round-trip-7001','LIVE',$1)",
        [{ entryAdmissionV1: admissionSnapshot }]);
      await pool.query("INSERT INTO self_trade_decisions VALUES (7001,3,$1,'BUY',$2)", [symbol,
        { atiDecisionQuoteV1: { ...decision, brokerSymbol: symbol } }]);
      for (const [id, leg, order, deal, volume] of [
        [7001, "ENTRY", "10101", "10201", 0.03], [7002, "EXIT", "10102", "10202", 0.01],
      ] as const) {
        const commandId = `round-trip-${id}`;
        const isExit = leg === "EXIT";
        const terminal = { ...resultWire, resultKind: isExit ? "CLOSE" : "ENTRY", resultOrder: order,
          resultDeal: deal, resultVolume: volume, ...(isExit ? { positionTicket } : {}) };
        const cost = atiCostReceiptFromResult({ ...terminal, atiExecutionCostV1: { ...costWire, leg, symbol, order, deal,
          positionId, side: isExit ? "SELL" : "BUY", volume, brokerFilledAtMs: fillTime + id,
          ...(isExit ? { positionTicket } : {}) } }, bridge, "LIVE");
        assert.ok(cost);
        await pool.query(`INSERT INTO arx_live_commands VALUES
          ($1,$2,11,1,$3,$4,'LIVE_FILLED',$5,'BUY',$6,$7,$8,1.1003,$8,$9,3)`,
          [id, commandId, isExit ? "CLOSE_LIVE_POSITION" : "PLACE_LIVE_MARKET_ORDER", new Date(+stamp + (isExit ? 2 : 0)), symbol,
           isExit ? { brokerTicket: positionTicket } : draft, isExit ? positionTicket : order, volume, isExit ? null : id]);
        await pool.query("INSERT INTO execution_events VALUES ($1,'DISPATCH_SENT','arx',1,$2,$4,$4), ($1,'RESULT_LIVE_FILLED','ea',2,$3,$5,$5)",
          [id, { commandId, bridgeConnectionId: 11, atiAccountBinding: cost.accountBinding, ...(isExit ? {} : { atiAdmission: envelope }) },
            { commandId, applied: true, reportingBridgeConnectionId: 11, terminalResultEvidence: terminal, atiCostEvidence: cost,
              brokerTicket: isExit ? positionTicket : order, fillPrice: cost.price, executedVolume: volume, finalStatus: "LIVE_FILLED" },
            new Date(+stamp + (isExit ? 2 : 0)), new Date(fillTime + id)]);
      }
      const protective = { ...historyPayload, positionTicket: positionId, dealTicket: "10203", symbol, volume: 0.02,
        closedAtEpochMs: fillTime + 7003, atiTriggeredExit: { ...historyPayload.atiTriggeredExit, orderTicket: "10103", positionId,
          order: { ...historyPayload.atiTriggeredExit.order, ticket: "10103", symbol, positionId } } };
      await ingestHistory(protective);
      const partial = (await read()).live.roundTrips;
      assert.deepEqual(partial.positions[0]?.gaps, ["NO_CLOSED_POSITION_HISTORY"]);
      await ingestHistory({ ...protective, atiTriggeredExit: { ...protective.atiTriggeredExit,
        closedPositionDealTickets: ["10203","10201","10202"] } });
      const beforeDispatch = await readAtiExecutionCosts(1, symbol, stamp, new Date(+stamp + 60_000), new Date(+stamp - 1));
      assert.equal(beforeDispatch.live.commandCount, 0);
      const beforeReceipt = await readAtiExecutionCosts(1, symbol, stamp, new Date(+stamp + 60_000), new Date(fillTime));
      assert.equal(beforeReceipt.live.commandCount, 2);
      assert.equal(beforeReceipt.live.reconciledDealCount, 0);
      assert.ok(beforeReceipt.live.results.every(row => row.status === "UNVERIFIED_AS_OF_DECISION"));
      const early = await read(1, stamp, new Date(fillTime + 100));
      assert.equal(early.live.roundTrips.reconciled, 0, "late command receipts cannot price an earlier cutoff");
      const complete = await read(1, new Date(+stamp + 1)); // entry dispatched before the window
      assert.equal(complete.live.commandCount, 1);
      assert.equal(complete.live.roundTrips.reconciled, 1);
      assert.equal(complete.demo.roundTrips.reconciled, 0);
      const position = complete.live.roundTrips.positions[0];
      assert.equal(position?.state, "OBSERVED_BROKER_ROUND_TRIP");
      assert.equal(position.attribution, "VERIFIED_ENTRY_STRATEGY");
      const [cohort] = complete.live.roundTrips.byEntryStrategy;
      assert.equal(cohort?.strategy.setup, "TREND_CONTINUATION");
      assert.equal(cohort?.strategy.revision, version.build.revision);
      assert.deepEqual(cohort?.positionKeys, [position.positionKey]);
      assert.equal(cohort.commandSlippage.coveredFills, 2);
      assert.equal(cohort.decisionToFill.totalFills, 1);
      assert.equal(cohort.triggerMovement.coveredFills, 1);
      assert.deepEqual(cohort.signedDealCharges[0]?.swap, { coveredPositions: 0, signedCashOnCoveredPositions: null });
      assert.deepEqual(cohort.signedDealCharges[0]?.fee, { coveredPositions: 1, signedCashOnCoveredPositions: -0.1 });
      const { atiEntryStrategy, atiDispatchAdmission, atiVerifiedAdmission } = await import("../atiStrategyOrigin.js");
      const command = { commandId: "round-trip-7001", agentId: 3, decisionId: 7001, side: "BUY",
        symbol, requestedVolume: 0.03, payload: draft, sentAt: stamp };
      const execution = { id: 19, agentId: 3, decisionId: 7001, executingUserId: 1, commandId: command.commandId,
        mode: "LIVE", admissionSnapshot };
      const origin = (receipt: unknown, history = execution, cmd = command, owner = 1, binding = liveCost.accountBinding) =>
        atiEntryStrategy(atiVerifiedAdmission(owner, cmd, receipt, history), binding);
      assert.deepEqual(atiDispatchAdmission(draft), envelope);
      assert.equal(origin(envelope)?.cohortKey, cohort.cohortKey);
      assert.notEqual(origin(envelope, execution, command, 1, "0".repeat(64))?.cohortKey, cohort.cohortKey);
      assert.equal(origin(envelope, execution, command, 2), null);
      assert.equal(origin(envelope, { ...execution, mode: "DEMO" }), null);
      assert.equal(origin(null), null);
      assert.equal(origin({ ...envelope, snapshotHash: "f".repeat(64) }), null);
      assert.equal(origin(envelope, execution, { ...command, decisionId: 7010 }), null);
      assert.equal(origin(envelope, execution, { ...command, symbol: symbol + ".pro" }), null);
      assert.equal(origin(envelope, execution, { ...command, sentAt: new Date(+stamp - 20) }), null);
      for (const versionGap of [{ ...version, build: { ...version.build, sourceState: "modified" } },
        { ...version, build: { revision: null, sourceState: "unknown" } }, { ...version, engine: "self-trade-source-bound-v1" }]) {
        const snap = { ...admissionSnapshot, decision: { ...admissionSnapshot.decision, scoreBreakdown: { atiFleetDecisionV1: versionGap } } };
        const claim = { ...envelope, snapshotHash: entrySnapshotHash(snap) };
        assert.equal(atiEntryStrategy(atiVerifiedAdmission(1, { ...command, payload: { ...draft, agentAdmissionV1: claim } },
          claim, { ...execution, admissionSnapshot: snap }), liveCost.accountBinding), null);
      }

      await pool.query("UPDATE self_trade_decisions SET score_breakdown=score_breakdown || $1::jsonb WHERE id=7001",
        [{ atiFleetDecisionV1: { ...version, engine: "UNRELATED_CHALLENGER" }, atiDecisionQuoteV1: null }]);
      assert.equal((await read()).live.results.find(row => row.commandId === "round-trip-7001")?.decisionBenchmarkSource,
        "VERIFIED_ENTRY_ADMISSION");
      assert.equal(cohort.decisionToFill.coveredFills, 1);
      assert.deepEqual((await read()).live.roundTrips.byEntryStrategy[0], cohort, "the frozen decision benchmark survives a later edit");
      await pool.query("UPDATE self_trade_agent_executions SET management_state=$1 WHERE id=19", [{ entryAdmissionV1: {
        ...admissionSnapshot, decision: { ...admissionSnapshot.decision, setupType: "REVERSAL" } } }]);
      // A valid quote in the decision table must not rescue a broken admission.
      await pool.query("UPDATE self_trade_decisions SET score_breakdown=score_breakdown || $1::jsonb WHERE id=7001",
        [{ atiDecisionQuoteV1: { ...decision, brokerSymbol: symbol } }]);
      const disputedCosts = await read();
      const disputedEntry = disputedCosts.live.results.find(row => row.commandId === "round-trip-7001");
      assert.equal(disputedEntry?.result.state, "OBSERVED_BROKER_DEAL");
      assert.equal(disputedEntry.result.adverseMovementBeforeSubmissionPriceUnits, null);
      assert.equal(disputedEntry.decisionBenchmarkSource, null);
      const disputed = disputedCosts.live.roundTrips;
      assert.equal(disputed.reconciled, 1, "broker quantities remain independently substantiated");
      assert.deepEqual(disputed.byEntryStrategy, []);
      assert.equal(disputed.positions[0]?.attribution, "ENTRY_STRATEGY_UNVERIFIED");
      await pool.query("UPDATE self_trade_agent_executions SET management_state=$1 WHERE id=19", [{ entryAdmissionV1: admissionSnapshot }]);
      assert.deepEqual(position.deals.map(row => [row.order, row.deal, row.volume]),
        [["10101","10201",0.03],["10102","10202",0.01],["10103","10203",0.02]]);
      const entryBenchmark = position.deals[0]?.benchmark, exitBenchmark = position.deals[2]?.benchmark;
      assert.equal(entryBenchmark?.source, "COMMAND_QUOTES");
      assert.ok(Math.abs(entryBenchmark.submissionSpreadPriceUnits! - 0.0002) < 1e-12);
      assert.ok(Math.abs(entryBenchmark.adverseSlippagePriceUnits! - 0.0001) < 1e-12);
      assert.ok(Math.abs(entryBenchmark.decisionSpreadPriceUnits! - 0.0001) < 1e-12);
      assert.ok(Math.abs(entryBenchmark.adverseMovementBeforeSubmissionPriceUnits! - 0.0002) < 1e-12);
      assert.ok(Math.abs(entryBenchmark.adverseFillVsDecisionMidPriceUnits! -
        (entryBenchmark.decisionSpreadPriceUnits! / 2 + entryBenchmark.adverseMovementBeforeSubmissionPriceUnits! +
        entryBenchmark.adverseSlippagePriceUnits!)) < 1e-12);
      const closeBenchmark = position.deals[1]?.benchmark;
      assert.equal(closeBenchmark?.source, "COMMAND_QUOTES");
      assert.equal(closeBenchmark.adverseFillVsDecisionMidPriceUnits, null);
      assert.equal(exitBenchmark?.source, "BROKER_TRIGGER");
      assert.ok(Math.abs(exitBenchmark.adverseMovementFromTriggerPriceUnits! - 0.0001) < 1e-12);
      assert.deepEqual(position.charges, { currency: "USD", commission: 0, fee: -0.1, swap: null });
      assert.ok(!JSON.stringify(complete).includes(liveCost.accountBinding));
      assert.deepEqual((await read(2)).live.roundTrips.positions, []);
      const unrelatedUnverified = { ...protective, dealTicket: "10404", symbol: "GBPCHF",
        atiTriggeredExit: { ...protective.atiTriggeredExit, order: null, orderTicket: "10304" } };
      const { nativeAccountBinding } = await import("../../brokerHub/nativeAccountReport.js");
      const otherBinding = nativeAccountBinding(bridge.accountNumber, "Unrelated-Demo-Server");
      assert.ok(otherBinding);
      await ingestHistory({ ...unrelatedUnverified, atiTriggeredExit: { ...unrelatedUnverified.atiTriggeredExit,
        account: { ...unrelatedUnverified.atiTriggeredExit.account, server: "Unrelated-Demo-Server" } } }, { binding: otherBinding });
      assert.equal((await read()).live.roundTrips.reconciled, 1);
      const later = new Date(+stamp + 70_000);
      await ingestHistory(unrelatedUnverified, { receivedAt: +later });
      assert.equal((await read()).live.roundTrips.reconciled, 1, "an unpublished conflict cannot change the old cutoff");
      assert.ok((await read(1, stamp, new Date(+later + 1))).live.roundTrips.positions[0]?.gaps.includes("UNRESOLVED_POSITION_RECEIPT"));
      await ingestHistory({ ...protective, atiTriggeredExit: { ...protective.atiTriggeredExit,
        closedPositionDealTickets: ["10201","10202","10203","10204"] } });
      assert.equal((await read()).live.roundTrips.reconciled, 0, "conflicting history invalidates the round trip");
    });

    const brokerSymbol = "EURUSD.pro";
    const aliasResult = { ...resultWire, resultOrder: "850", resultDeal: "950" };
    const aliasCost = atiCostReceiptFromResult({ ...aliasResult, atiExecutionCostV1: {
      ...costWire, order: "850", deal: "950", symbol: brokerSymbol,
    } }, bridge, "LIVE");
    const otherServer = "Fixture-Second-Broker";
    const otherCost = atiCostReceiptFromResult({ ...resultWire, atiExecutionCostV1: { ...costWire, serverName: otherServer } },
      { ...bridge, serverName: otherServer }, "LIVE");
    assert.ok(aliasCost && otherCost);
    await pool.query(`INSERT INTO arx_live_commands VALUES
      (41,'native-alias',11,1,'PLACE_LIVE_MARKET_ORDER',$1,'LIVE_FILLED',$2,'BUY',$3,'850',0.02,1.1003,0.02,NULL,NULL)`,
    [stamp, brokerSymbol, { selfTradeSymbolBinding: { requestedSymbol: "EURUSD" } }]);
    await pool.query("INSERT INTO execution_events VALUES (41,'DISPATCH_SENT','arx',1,$1), (41,'RESULT_LIVE_FILLED','ea',2,$2)", [
      { commandId: "native-alias", bridgeConnectionId: 11, atiAccountBinding: aliasCost.accountBinding },
      { applied: true, commandId: "native-alias", reportingBridgeConnectionId: 11, atiCostEvidence: aliasCost, terminalResultEvidence: aliasResult },
    ]);
    const alias = withHistoryOrder("942", "842");
    const nativeHistory = { ...alias, symbol: brokerSymbol, atiTriggeredExit: { ...alias.atiTriggeredExit,
      order: { ...alias.atiTriggeredExit.order, symbol: brokerSymbol } } };
    await ingestHistory(nativeHistory);
    await ingestHistory({ ...nativeHistory, dealTicket: "943", atiTriggeredExit: { ...nativeHistory.atiTriggeredExit,
      account: { ...nativeHistory.atiTriggeredExit.account, server: otherServer } } }, { bridgeId: 44, binding: otherCost.accountBinding });
    const nativeResults = (await readAtiShadowRun(1, 3, unsupported.runId))?.executionCosts.brokerTriggeredExits.live.results;
    assert.equal(nativeResults?.find((row) => row.deal === "942")?.result.state, "OBSERVED_BROKER_TRIGGERED_EXIT");
    assert.equal(nativeResults?.some((row) => row.deal === "943"), false, "an alias witnessed on another account does not match");

    slot = base - 600_000;
    const { brokerHistoryIdentity } = await import("../../data/brokerHistoryPolicy.js");
    const { routeCandles, routeQuote } = await import("../../data/marketDataRouter.js");
    const { captureAtiMt5QuoteOrigin } = await import("../../data/atiMt5QuoteOrigin.js");
    const { __resetMt5ProviderStore } = await import("../../data/providers/mt5Provider.js");
    const historyIdentity = brokerHistoryIdentity({ ...bridge, userId: 1, bridgeConnectionId: 11, clockBasis: "broker_server" });
    const atiAccount = { binding: liveCost.accountBinding, mode: "LIVE", historyIdentity } as const;
    const claim = { login: bridge.accountNumber, server: bridge.serverName, mode: "LIVE" } as const;
    const brokerOffset = 7_200_000;
    let clockAt = slot + 1_000;
    const clock = mock.method(Date, "now", () => clockAt);
    const tickStream = "EURUSD";
    try {
      async function postTick(sequence: number, captureOffset: number, receiveOffset: number, bid: number, ask: number,
        brokerOffsetMs = captureOffset + brokerOffset - 10, owner = 1, bridgeId = 11) {
        const result = await ingestBridgeV2Message({
          userId: owner, bridgeConnectionId: bridgeId, serverReceivedAtEpochMs: slot + receiveOffset, atiAccount,
          raw: { protocolVersion: 2, messageType: "TICK", streamKey: tickStream, sequence,
            idempotencyKey: `ati-replay-fixture-${owner}-${sequence}`, eaCreatedAtEpochMs: slot + captureOffset, eaVersion: "fixture",
            payload: { symbol: "EURUSD", brokerSymbol: "EURUSD", bid, ask, brokerTimeEpochMs: slot + brokerOffsetMs, atiAccount: claim } },
        });
        assert.equal(result.accepted, true, JSON.stringify(result));
      }
      __resetMt5ProviderStore();
      await postTick(0, 100, 110, 1.0999, 1.10);
      await postTick(1, 999, 999, 1.10, 1.1001);
      const candle = await ingestBridgeV2Message({
        userId: 1, bridgeConnectionId: 11, serverReceivedAtEpochMs: slot + 999, atiAccount,
        raw: { protocolVersion: 2, messageType: "CANDLE", streamKey: "EURUSD|M5", sequence: 0,
          idempotencyKey: "ati-replay-candle-fixture", eaCreatedAtEpochMs: slot + 999, eaVersion: "fixture",
          payload: { symbol: "EURUSD", brokerSymbol: "EURUSD", timeframe: "M5", openTimeEpochMs: slot + brokerOffset - 300_000,
            open: 1.1, high: 1.11, low: 1.09, close: 1.1, volume: 30, isClosed: true, atiAccount: claim } },
      });
      assert.equal(candle.accepted, true);
      const routedCandles = await routeCandles("EURUSD", "M5", 1, { bridgeConnectionId: 11 });
      const routedQuote = await routeQuote("EURUSD", { mt5Writer: { bridgeConnectionId: 11 } });
      mt5QuoteOrigin = captureAtiMt5QuoteOrigin(routedCandles, routedQuote, 1);
      assert.ok(mt5QuoteOrigin, JSON.stringify(routedCandles.provenance));
      assert.equal(captureAtiMt5QuoteOrigin(routedCandles, routedQuote, 2), null);
      assert.equal(captureAtiMt5QuoteOrigin({ ...routedCandles, candles: routedCandles.candles.map((candle) => ({ ...candle })) }, routedQuote, 1), null);

      const priorDispatch = new Date(slot - 2000);
      const priorReceipt = new Date(slot - 1000);
      const valuation = { tickSize: 0.00001, profitTickValue: 1, lossTickValue: 2 };
      const historicalWire = { ...costWire, brokerFilledAtMs: slot - 1100 + brokerOffset,
        submissionQuote: { bid: 1.10, ask: 1.1002, brokerTickAtMs: slot - 1200 + brokerOffset },
        commission: -0.12, fee: -0.04, tickValuation: valuation };
      async function historicalCommand(id: number, wire: Record<string, unknown>, opts: {
        receipt?: Date; occurred?: Date; owner?: number; bridgeId?: number; server?: string;
      } = {}) {
        const isExit = wire.leg === "EXIT";
        const positionTicket = isExit ? wire.positionTicket : null;
        const terminal = {
          ...resultWire, resultKind: isExit ? "CLOSE" : "ENTRY", resultOrder: wire.order, resultDeal: wire.deal,
          resultPrice: wire.price, resultVolume: wire.volume, ...(positionTicket ? { positionTicket } : {}),
        };
        const identity = { ...bridge, serverName: opts.server ?? bridge.serverName };
        const normalized = atiCostReceiptFromResult({ ...terminal, atiExecutionCostV1: { ...wire, serverName: identity.serverName } }, identity, "LIVE");
        assert.ok(normalized);
        const bridgeId = opts.bridgeId ?? 11;
        const commandId = `history-${id}`;
        const ticket = positionTicket ?? wire.order;
        await pool.query(`INSERT INTO arx_live_commands VALUES
          ($1,$2,$3,$4,$5,$6,'LIVE_FILLED',$7,'BUY',$8,$9,0.02,1.104,0.02,NULL,NULL)`, [
          id, commandId, bridgeId, opts.owner ?? 1, isExit ? "CLOSE_LIVE_POSITION" : "PLACE_LIVE_MARKET_ORDER",
          priorDispatch, wire.symbol, isExit ? { brokerTicket: positionTicket } : {}, ticket,
        ]);
        await pool.query(`INSERT INTO execution_events VALUES
          ($1,'DISPATCH_SENT','arx',1,$2,$3,$3), ($1,'RESULT_LIVE_FILLED','ea',2,$4,$5,$6)`, [
          id, { commandId, bridgeConnectionId: bridgeId, atiAccountBinding: normalized.accountBinding }, priorDispatch,
          { applied: true, commandId, finalStatus: "LIVE_FILLED", reportingBridgeConnectionId: bridgeId, brokerTicket: ticket,
            fillPrice: wire.price, executedVolume: wire.volume, terminalResultEvidence: terminal, atiCostEvidence: normalized },
          opts.receipt ?? priorReceipt, opts.occurred ?? opts.receipt ?? priorReceipt,
        ]);
      }
      await historicalCommand(51, { ...historicalWire, order: "851", deal: "951" });
      await historicalCommand(52, { ...historicalWire, order: "852", deal: "952", price: 1.1005, tickValuation: undefined });
      await historicalCommand(53, { ...historicalWire, order: "853", deal: "953", leg: "EXIT", side: "SELL",
        positionTicket: closeWire.positionTicket, positionId: closeWire.positionId, price: 1.0999, commission: 0, fee: 0.02 });
      await historicalCommand(54, { ...historicalWire, order: "854", deal: "954", price: 1.102 }, { receipt: new Date(clockAt + 1) });
      await historicalCommand(55, { ...historicalWire, order: "855", deal: "955" }, { receipt: new Date(clockAt) });
      await historicalCommand(56, { ...historicalWire, order: "856", deal: "956" }, { owner: 2, bridgeId: 12 });
      await historicalCommand(57, { ...historicalWire, order: "857", deal: "957" }, { server: otherServer });
      await historicalCommand(58, { ...historicalWire, order: "858", deal: "958" }, { bridgeId: 15 });
      await historicalCommand(59, { ...historicalWire, order: "859", deal: "959", symbol: "EURUSD.pro" });
      await historicalCommand(60, { ...historicalWire, order: "860", deal: "960" }, { occurred: new Date(clockAt + 1) });
      const { readAtiLiveMemoryCosts } = await import("../atiExecutionCosts.js");
      const memoryIds = ["history-51", "history-54", "history-56", "history-60"];
      const memoryAt = () => readAtiLiveMemoryCosts(1, memoryIds, new Date(clockAt));
      const recorded = await memoryAt();
      assert.equal(recorded.get("history-51")?.state, "OBSERVED_BROKER_DEAL");
      assert.equal(recorded.get("history-54")?.state, "UNRESOLVED", "result had not arrived");
      assert.equal(recorded.get("history-60")?.state, "UNRESOLVED", "result occurrence was after cutoff");
      assert.equal(recorded.has("history-56"), false, "other owner's command");
      await pool.query("UPDATE arx_live_commands SET fill_price=400 WHERE id=51");
      assert.deepEqual(await memoryAt(), recorded, "a later command-row change cannot rewrite the earlier cost receipt");
      await pool.query("UPDATE arx_live_commands SET fill_price=1.104 WHERE id=51");
      const demoHistoricalWire = { ...historicalWire, mode: "DEMO", order: "871", deal: "971" };
      const demoTerminal = { ...resultWire, resultOrder: "871", resultDeal: "971" };
      const demoHistorical = atiCostReceiptFromResult({ ...demoTerminal, atiExecutionCostV1: demoHistoricalWire },
        { ...bridge, accountType: "demo" }, "DEMO");
      assert.ok(demoHistorical);
      await pool.query(`INSERT INTO mt5_demo_commands VALUES ('demo-history',22,$1,'FILLED_DEMO',1,
        'PLACE_MARKET_ORDER',false,'{"symbol":"EURUSD","side":"BUY","lotSize":0.02}',NULL,0.02,1.1003,$2,NULL,$3)`,
      [priorDispatch.toISOString(), { ...demoTerminal, atiCostEvidence: demoHistorical }, priorReceipt.toISOString()]);
      await pool.query("INSERT INTO security_events VALUES ($1,1,'DEMO_DISPATCH_SENT','ALLOWED',$2)", [{
        commandId: "demo-history", bridgeConnectionId: 22, atiAccountBinding: demoHistorical.accountBinding,
      }, priorDispatch]);
      const { readAtiHistoricalCostSamples } = await import("../atiExecutionCosts.js");
      assert.deepEqual((await readAtiHistoricalCostSamples(1, "EURUSD", { ...mt5QuoteOrigin, mode: "DEMO", bridgeConnectionId: 22 },
        new Date(clockAt))).map(({ commandId }) => commandId), ["demo-history"]);

      const mt5 = await startAtiShadowRun(1, 3, pilot);
      assert.ok(mt5);
      const { readAtiExecutionOperations, assessAtiDispatches } = await import("../atiExecutionOperations.js");
      const { readAtiDispatchWindow } = await import("../atiExecutionCosts.js");
      const observationKey = "bar:" + slot;
      // Reproduce the durable record time in this historical test clock.
      await pool.query("UPDATE ati_shadow_observations SET recorded_at=observed_at WHERE run_id=$1", [mt5.runId]);
      const { readAtiCaptureOperations } = await import("../atiCaptureOperations.js");
      const capture = await readAtiCaptureOperations(1,3,mt5.runId,new Date(clockAt));
      assert.ok(capture);
      assert.deepEqual(capture.slots.map(s => s.state),["OBSERVED"]);
      assert.deepEqual(capture.grading.overdueObservationKeys,[]);
      const closed = await readAtiCaptureOperations(1,3,mt5.runId,new Date(clockAt+3600000));
      assert.ok(closed);
      assert.deepEqual(closed.grading.overdueObservationKeys,[observationKey]);
      assert.equal(closed.missingCompletedSlots,closed.slots.length - 1);
      assert.equal(await readAtiCaptureOperations(2,3,mt5.runId,new Date(clockAt)),null);
      assert.equal(await readAtiCaptureOperations(1,4,mt5.runId,new Date(clockAt)),null);
      const ops = await readAtiExecutionOperations(1,3,mt5.runId,observationKey,new Date(clockAt));
      assert.ok(ops?.execution && ops.feed);
      assert.equal(ops.mode, "LIVE");
      const own = ops.execution.commands.filter(c => c.commandId.startsWith("history-"));
      assert.deepEqual(own.map(c => c.commandId), ["history-51","history-52","history-53","history-54","history-55","history-60"]);
      const pending = own.find(c => c.commandId === "history-55")!;
      assert.deepEqual([pending.state,pending.availableAt,pending.status], ["AWAITING_RESULT",null,"UNVERIFIED_AS_OF_DECISION"]);
      assert.equal(ops.feed.state, "FRESH");
      const repeatedTick = await pool.query(`INSERT INTO bridge_v2_events (user_id,bridge_connection_id,protocol_version,
        message_type,stream_key,sequence,idempotency_key,sequence_verdict,gap_size,accepted,ea_created_at_epoch_ms,
        server_received_at_epoch_ms,payload) SELECT user_id,bridge_connection_id,protocol_version,message_type,stream_key,
        sequence+4,'ops-frozen-tick','GAP',3,true,$2::bigint,$2::bigint,payload FROM bridge_v2_events WHERE id=$1 RETURNING id`,
        [ops.feed.latest!.id,clockAt+60000]);
      try {
        const frozen = await readAtiExecutionOperations(1,3,mt5.runId,observationKey,new Date(clockAt+60001));
        assert.ok(frozen?.feed);
        assert.equal(frozen.feed.state,"FRESH");
        assert.equal(frozen.feed.brokerClockState,"REPEATED_TIMESTAMP");
        assert.ok(frozen.feed.repeatedForMs! >= 60000);
        assert.equal(frozen.feed.missingSequences,3);
        const historic = await readAtiExecutionOperations(1,3,mt5.runId,observationKey,new Date(clockAt));
        assert.deepEqual(historic,ops);
      } finally { await pool.query("DELETE FROM bridge_v2_events WHERE id=$1",[repeatedTick.rows[0].id]); }
      assert.equal(await readAtiExecutionOperations(2,3,mt5.runId,observationKey,new Date(clockAt)), null);
      assert.equal(await readAtiExecutionOperations(1,4,mt5.runId,observationKey,new Date(clockAt)), null);
      assert.equal(await readAtiExecutionOperations(1,3,mt5.runId,observationKey,new Date(clockAt-1)), null);
      const mt5OpsDemo = {...mt5QuoteOrigin,mode:"DEMO" as const, bridgeConnectionId:22};
      const demoPending = await readAtiDispatchWindow(1,mt5OpsDemo,priorDispatch,new Date(+priorReceipt));
      assert.equal(demoPending.find(c => c.commandId === "demo-history")?.availableAt, null);
      assert.equal(demoPending.find(c => c.commandId === "demo-history")?.result.state,"UNRESOLVED");
      const demoReported = await readAtiDispatchWindow(1,mt5OpsDemo,priorDispatch,new Date(clockAt));
      assert.deepEqual(demoReported.map(c => c.commandId),["demo-history"]);
      const fresh = await readAtiDispatchWindow(1,mt5QuoteOrigin,priorDispatch,new Date(clockAt));
      const first = fresh.find(c => c.commandId === "history-51")!;
      assert.equal(first.result.state,"OBSERVED_BROKER_DEAL");
      const deal = first.result;
      const priorSet = Array.from({length:10}, (_,i) => ({...first, result:{...deal,deal:String(80000+i)}}));
      const recentSet = priorSet.map((r,i) => ({...r,availableAt:clockAt+120000,result:{...r.result,deal:String(81000+i),spreadPriceUnits:.003}}));
      const drift = assessAtiDispatches(priorSet,recentSet,clockAt+180000);
      const spreadMetric = drift.costDrift[0]!.metrics.find(m => m.metric === "spread");
      assert.equal(spreadMetric?.status,"COST_INCREASE");
      assert.equal(drift.costDrift[0]!.metrics.find(m => m.metric === "swap")?.status,"INSUFFICIENT_EVIDENCE");
      assert.equal(drift.commands[0]!.state,"DELAYED_RESULT");
      assert.equal(assessAtiDispatches([], [{...first,availableAt:null}],clockAt+180000).commands[0]!.state,"RESULT_OVERDUE");
      const ack = assessAtiDispatches([],[{...first,status:"LIVE_ACKNOWLEDGED",
        result:{state:"UNRESOLVED",reason:"COMMAND_OUTCOME_UNRESOLVED"}}],clockAt+180000).commands[0]!;
      assert.equal(ack.fillState,"ACKNOWLEDGED_FILL_OVERDUE");
      assert.equal(ack.fillEvidenceDelayMs,null);
      const repeated = assessAtiDispatches(priorSet,[priorSet[0]!],clockAt);
      assert.equal(repeated.reconciledDeals,0);
      assert.equal(repeated.commands[0]!.dealEvidence,"DEAL_CLAIMED_ACROSS_WINDOWS");
      const initialProfile = (await readAtiShadowRun(1, 3, mt5.runId))?.measuredCostProfile;
      assert.ok(initialProfile);
      assert.equal(initialProfile.availableBeforeMs, slot + 1000);
      assert.deepEqual(initialProfile.samples.map(({ commandId }) => commandId), ["history-51", "history-52", "history-53"]);
      assert.equal(initialProfile.samples[1]?.fee, null, "missing conversion remains unknown");
      assert.equal(initialProfile.samples[2]?.commission, 0, "a reported zero remains zero");
      assert.ok(Math.abs(initialProfile.samples[2]!.fee! + 0.00001) < 1e-12, "a credit uses the profit tick value");
      assert.equal(initialProfile.entry.BUY.slippage.sampleCount, 2);
      assert.equal(initialProfile.entry.BUY.slippageCommissionAndFee.sampleCount, 1);
      const { measuredRoundTripCosts, selectAtiMeasuredCosts } = await import("../atiMeasuredCosts.js");
      assert.ok(mt5QuoteOrigin);
      const profileAt = initialProfile.availableBeforeMs;
      assert.equal(selectAtiMeasuredCosts(initialProfile, mt5QuoteOrigin, initialProfile.sourceIdentity, profileAt), initialProfile);
      assert.equal(selectAtiMeasuredCosts(initialProfile, { ...mt5QuoteOrigin, brokerSymbol: "EURUSD.other" },
        initialProfile.sourceIdentity, profileAt), null, "a different native contract cannot reuse measured costs");
      assert.equal(selectAtiMeasuredCosts(initialProfile, mt5QuoteOrigin, initialProfile.sourceIdentity, profileAt - 1), null);
      assert.deepEqual(measuredRoundTripCosts(initialProfile, "SELL"), { slippage: null, slippageCommissionAndFee: null });

      const origin = mt5QuoteOrigin;
      mt5QuoteOrigin = null;
      const waitingForFeed = await startAtiShadowRun(1, 3, pilot);
      assert.ok(waitingForFeed);
      assert.equal((await readAtiShadowRun(1, 3, waitingForFeed.runId))?.measuredCostProfile, null);
      mt5QuoteOrigin = origin;
      const captured = await Promise.all([
        appendAtiShadowObservation(1, 3, waitingForFeed.runId), appendAtiShadowObservation(1, 3, waitingForFeed.runId),
      ]);
      assert.deepEqual(captured.map((result) => result.status).sort(), ["ALREADY_OBSERVED", "RECORDED"]);
      const afterFeed = await readAtiShadowRun(1, 3, waitingForFeed.runId);
      assert.deepEqual(afterFeed?.measuredCostProfile, initialProfile);
      await pool.query("UPDATE ati_shadow_observations SET recorded_at=$2::timestamptz + CASE WHEN coverage='OBSERVED' THEN interval '2 seconds' ELSE interval '0 seconds' END WHERE run_id=$1",
        [waitingForFeed.runId, new Date(slot + 1000)]);
      const beforeAnchor = await readAtiShadowRun(1, 3, waitingForFeed.runId, new Date(slot + 2000));
      assert.ok(beforeAnchor);
      assert.equal(beforeAnchor.measuredCostProfile, null);
      assert.equal(beforeAnchor.observations.some(row => row.coverage === "OBSERVED"), false);
      assert.deepEqual((await readAtiShadowRun(1, 3, waitingForFeed.runId, new Date(slot + 3000)))?.measuredCostProfile, initialProfile);

      await pool.query("INSERT INTO execution_events VALUES (51,'LATE_RESULT_RETAINED','ea',3,$1,$2,$2)", [{
        reportedOutcome: "LIVE_FILLED", brokerTicket: "851", fillPrice: 1.105, executedVolume: 0.02,
      }, new Date(clockAt + 2)]);
      assert.deepEqual((await readAtiHistoricalCostSamples(1, "EURUSD", origin, new Date(clockAt)))
        .map(({ commandId }) => commandId).sort(), ["history-51", "history-52", "history-53"]);
      await postTick(2, 1000, 1050, 1.1050, 1.1051); // At the decision time, received later.
      await postTick(3, 1100, 1150, 1.1050, 1.1051, 1000 + brokerOffset - 10); // Repost of the same pre-decision quote.
      await postTick(4, 1800, 1810, 1.1000, 1.1002);
      await postTick(5, 4000, 4010, 1.1029, 1.1030); // Durable but beyond the first grading cutoff.
      await postTick(0, 2200, 2210, 1.0980, 1.0981, undefined, 2, 12);
      clockAt = slot + 3000;
      assert.equal((await gradeAtiShadowRun(1, 3, mt5.runId))?.pending, 1);
      assert.equal(await gradeAtiShadowRun(2, 3, mt5.runId), null);

      __resetMt5ProviderStore();
      clockAt = slot + 4100;
      assert.equal((await restarted.gradeAtiShadowRun(1, 3, mt5.runId))?.recorded, 1);
      const mt5Report = await readAtiShadowRun(1, 3, mt5.runId);
      const replay = mt5Report?.observations[0]?.grade;
      assert.equal(replay?.state, "SIMULATED_FILL");
      assert.equal(replay.quoteSource, "mt5_broker");
      assert.equal(replay.entry, 1.1002);
      assert.equal(replay.exit, 1.1029);
      assert.equal(replay.exitReason, "TARGET");
      assert.equal(replay.mt5Replay?.source, "SAMPLED_MT5_BID_ASK");
      assert.equal(replay.mt5Replay?.decisionReceiptId, mt5QuoteOrigin.receiptId);
      assert.equal(replay.mt5Replay?.entryObservedAt, slot + 1810);
      assert.equal(replay.mt5Replay?.samples, 2);
      assert.equal(replay.mt5Replay?.mode, "LIVE");
      assert.deepEqual(mt5Report?.measuredCostProfile, initialProfile, "late receipt and contradiction cannot rewrite the frozen profile");
      assert.ok(Math.abs(replay.pnlWithMeasuredSlippage!.baselineR - ((0.0027 - 0.0003) / 0.0012) * 0.5) < 1e-12);
      assert.ok(Math.abs(replay.pnlWithMeasuredCosts!.baselineR - ((0.0027 - 0.00023) / 0.0012) * 0.5) < 1e-12);
      assert.equal(replay.pnlWithMeasuredCosts?.challengerR, 0);
      const { readAtiGuardianComparison } = await import("../atiGuardianReport.js");
      const guardianKey = mt5Report!.observations[0]!.observationKey;
      const guardianCutoff = new Date(Math.max(new Date().getTime(), clockAt) + 1000);
      assert.equal(await readAtiGuardianComparison(2, 3, mt5.runId, guardianKey, guardianCutoff), null);
      const comparison = await readAtiGuardianComparison(1, 3, mt5.runId, guardianKey, guardianCutoff);
      assert.ok(comparison && "samples" in comparison && comparison.state === "SETTLED_PAIR");
      assert.equal(comparison.mode, "LIVE");
      assert.equal(comparison.baseline.exit?.measuredNetR, replay.pnlWithMeasuredCosts!.baselineR);
      assert.equal(comparison.pairedDeltaR, 0);
      assert.equal(mt5Report?.simulations.withMeasuredCosts?.settledPairs, 1);
      assert.equal(mt5Report?.simulations.withMeasuredCosts?.challenger.settledTrades, 0);
      assert.equal(JSON.stringify(mt5Report).includes(historyIdentity), false);
      assert.equal((await gradeAtiShadowRun(1, 3, mt5.runId))?.recorded, 0);

      const { loadAtiMt5ReplayQuotes, gradeAtiMt5Replay } = await import("../atiMt5QuoteReplay.js");
      const archive = await loadAtiMt5ReplayQuotes(1, mt5QuoteOrigin, slot + 1000, clockAt);
      const frozenQuote = { bid: 1.10, ask: 1.1001, observedAt: new Date(slot + 999).toISOString() };
      const plan = { action: "BUY", reference: 1.1001, stop: 1.099, target: 1.102, reason: "Fixture" } as const;
      const gradeArchive = (rows: typeof archive) => gradeAtiMt5Replay(rows, mt5QuoteOrigin!, frozenQuote, "EURUSD", plan,
        slot + 1000, clockAt, slot + 15000);
      assert.equal(gradeArchive(archive.filter((row) => row.sequence !== 4)).state, "UNVERIFIED", "a dropped sample blocks replay");
      assert.equal(gradeArchive(archive.map((row) => row.sequence === 4 ? { ...row, verdict: "RESET" } : row)).state, "UNVERIFIED");
      assert.equal(gradeArchive(archive.map((row) => row.sequence === 4
        ? { ...row, payload: { ...(row.payload as object), atiAccountMode: "DEMO" } } : row)).state, "UNVERIFIED");
      assert.equal(gradeArchive(archive.map((row) => row.sequence === 4
        ? { ...row, payload: { ...(row.payload as object), atiHistoryIdentity: "f".repeat(64) } } : row)).state, "UNVERIFIED");
      assert.equal(gradeAtiMt5Replay(archive, mt5QuoteOrigin, frozenQuote, "EURUSD", plan,
        slot + 1000, clockAt, slot + 1800).state, "SKIPPED", "a quote received after expiry cannot open the simulation");
      const last = archive.find((row) => row.sequence === 5);
      assert.ok(last && last.capturedAt != null && last.receivedAt != null);
      const timingArchive = [...archive.map((row) => row.id === last.id ? { ...row,
        payload: { ...(row.payload as object), bid: 1.1003, ask: 1.1004 } } : row), {
        ...last, id: last.id + 1000000, sequence: 6, capturedAt: last.capturedAt + 1500, receivedAt: last.receivedAt + 1500,
        payload: { ...(last.payload as { brokerTimeEpochMs: number }), brokerTimeEpochMs: slot + 5500 + brokerOffset },
      }];
      const waited = gradeAtiMt5Replay(timingArchive, mt5QuoteOrigin, frozenQuote, "EURUSD", plan, slot + 1000, slot + 5600,
        slot + 15000, { band: { from: 1.1003, to: 1.1005 } });
      assert.equal(waited.state, "TARGET");
      assert.equal(waited.entry, 1.1004);
      assert.equal(waited.replay?.entryReceiptId, last.id);
      assert.equal(gradeAtiMt5Replay(timingArchive.filter((row) => row.sequence !== 4), mt5QuoteOrigin, frozenQuote, "EURUSD", plan,
        slot + 1000, slot + 5600, slot + 15000, { band: { from: 1.1003, to: 1.1005 } }).state, "UNVERIFIED");
      const { gradeAtiShadowPair } = await import("../atiShadowGrading.js");
      const frozen = await pool.query<{ evidence: { baseline: import("@workspace/domain/self-trade").DecisionCandidate } }>(
        "SELECT evidence FROM ati_shadow_observations WHERE run_id = $1", [mt5.runId]);
      const baseline = frozen.rows[0]!.evidence.baseline;
      assert.ok(baseline.thesis);
      const band = { from: 1.1003, to: 1.1005 };
      const realCostReplay = gradeAtiShadowPair({ source: "mt5_broker", symbol: "EURUSD", observedAt: slot + 1000,
        baseline: { ...baseline, thesis: { ...baseline.thesis, entryZone: band } }, challengerOutcome: "WAIT",
        assumedCosts: null, measuredCosts: initialProfile, retestPlan: { band, expiresAtMs: slot + 15000, sizeRatio: 0.5 },
        mt5Replay: { origin, quote: frozenQuote, rows: timingArchive },
      }, slot + 5600);
      assert.ok(realCostReplay?.state === "RETEST_COMPARISON" && realCostReplay.challenger.state === "SIMULATED_FILL");
      const measuredRetest = realCostReplay.challenger;
      assert.equal(measuredRetest.returns.assumedR, null);
      assert.ok(Math.abs(measuredRetest.returns.measuredR! -
        (1.1029 - 1.1004 - 0.00023) / realCostReplay.plannedRiskPriceUnits * 0.5) < 1e-12);
    } finally {
      clock.mock.restore();
    }

    const { readAtiShadowMemory } = await import("../atiTradingMemory.js");
    const asOf = new Date();
    const memory = await readAtiShadowMemory(1, 3, { asOf, limit: 50, symbol: "EURUSD" });
    const remembered = memory.episodes.find((row) => row.outcome.state === "SIMULATED_FILL");
    assert.ok(remembered?.outcome.availableAt);
    const gradeCutoff = new Date(Date.parse(remembered.outcome.availableAt) - 1);
    const priorShadowReport = await readAtiShadowRun(1, 3, remembered.runId, gradeCutoff);
    assert.equal(priorShadowReport?.observations.find(row => row.observationKey === remembered.observationKey)?.grade, null);
    const afterGrade = await readAtiShadowRun(1, 3, remembered.runId, asOf);
    assert.equal(afterGrade?.observations.find(row => row.observationKey === remembered.observationKey)?.grade?.state, "SIMULATED_FILL");
    assert.deepEqual(await restarted.readAtiShadowRun(1, 3, remembered.runId, gradeCutoff), priorShadowReport);
    assert.equal(await readAtiShadowRun(2, 3, remembered.runId, asOf), null);
    assert.equal(remembered.source, "SHADOW");
    assert.equal(remembered.feedMode, "LIVE", "the feed mode does not turn a simulation into an observed execution");
    assert.equal(remembered.marketContext?.regime, "TREND");
    assert.equal(remembered.expected.plan?.stopLoss, 1.099);
    assert.equal(remembered.outcome.excursions?.samples, 2);
    assert.ok(Math.abs(remembered.outcome.excursions!.maxFavorablePriceUnits - 0.0027) < 1e-12);
    assert.ok(Math.abs(remembered.outcome.excursions!.maxAdversePriceUnits + 0.0002) < 1e-12);
    assert.equal(memory.warningOutcomes.cohorts.find((row) => row.warning === "mtf_alignment")?.wins, 1);
    const earlier = await readAtiShadowMemory(1, 3, { asOf: new Date(Date.parse(remembered.outcome.availableAt) - 1), limit: 50 });
    const beforeGrade = earlier.episodes.find((row) => row.runId === remembered.runId);
    assert.equal(beforeGrade?.outcome.state, "AWAITING_GRADE");
    assert.equal(beforeGrade?.outcome.replay, null);
    assert.equal(earlier.warningOutcomes.cohorts.some((row) => row.symbol === "EURUSD"), false);
    assert.deepEqual((await readAtiShadowMemory(2, 3, { asOf, limit: 50 })).episodes, []);
    const page1 = await readAtiShadowMemory(1, 3, { asOf, limit: 1, symbol: "EURUSD" });
    assert.ok(page1.nextCursor);
    const page2 = await readAtiShadowMemory(1, 3, { asOf, limit: 1, symbol: "EURUSD" }, page1.nextCursor);
    assert.deepEqual([page1.episodes[0], page2.episodes[0]], memory.episodes.slice(0, 2));
    assert.equal(JSON.stringify(memory).includes(liveCost.accountBinding), false);

    await t.test("versioned Counterargument keeps the baseline separate and freezes entry timing", async () => {
      const { ATI_COUNTERARGUMENT_CHALLENGER, assessAtiCounterargument } = await import("../atiCounterargument.js");
      const { readAtiCounterargumentHistory } = await import("../atiTradingMemory.js");
      assert.ok(remembered.sourceIdentity);
      const historyScope = { asOf, beforeBar: asOf, sourceIdentity: remembered.sourceIdentity, setup: remembered.setup,
        symbol: remembered.symbol, timeframe: remembered.timeframe, baselineVersion: remembered.baselineVersion, side: "BUY" as const };
      const own = await readAtiCounterargumentHistory(1, 3, historyScope);
      assert.ok(own.observations.some((row) => row.runId === remembered.runId));
      assert.deepEqual((await readAtiCounterargumentHistory(2, 3, historyScope)).observations, []);
      assert.deepEqual((await readAtiCounterargumentHistory(1, 3, { ...historyScope, sourceIdentity: "different-account" })).observations, []);
      const early = new Date(Date.parse(remembered.outcome.availableAt!) - 1);
      assert.equal((await readAtiCounterargumentHistory(1, 3, { ...historyScope, asOf: early })).observations
        .some((row) => row.runId === remembered.runId), false);

      const previousSlot = slot;
      const previousSource = sourceIdentity;
      slot = base - 12 * 60 * 60_000;
      sourceIdentity = "counterargument-v75-fixture";
      quoteOffset = 0;
      const challengeStream = randomUUID();
      let challengeNow = slot + 1000;
      const challengeClock = mock.method(Date, "now", () => challengeNow);
      function openCase(next: typeof counterargumentCase) {
        counterargumentCase = next;
        challengeNow = slot + 1000;
        derivQuoteOrigin = { streamId: challengeStream, symbol: "R_75", epoch: (slot + 1000) / 1000 };
        frame(challengeStream, 1000, 1.1, 1.1001);
      }
      try {
        openCase("REDUCE");
        const run = await startAtiShadowRun(1, 3, { ...pilot, symbol: "V75", challengerVersion: ATI_COUNTERARGUMENT_CHALLENGER,
          assumedCosts: { adverseSlippagePerFillPriceUnits: 0.0001, feePerFillPriceUnits: 0.00005 } });
        assert.ok(run);
        assert.equal(run.challengerVersion, ATI_COUNTERARGUMENT_CHALLENGER);
        frame(challengeStream, 2000, 1.1, 1.1001);
        frame(challengeStream, 4000, 1.1029, 1.1030);
        challengeNow = slot + 4300;
        assert.equal((await restarted.gradeAtiShadowRun(1, 3, run.runId))?.recorded, 1);
        const first = (await readAtiShadowRun(1, 3, run.runId))?.observations[0];
        assert.equal(first?.baselineOutcome, "APPROVED");
        assert.equal(first?.challengerOutcome, "APPROVED_REDUCED");
        assert.equal(first?.counterargument?.timing.state, "AT_ENTRY");
        assert.equal(first?.counterargument?.concerns[0]?.code, "WEAKENING_MOMENTUM");
        assert.ok(first?.counterargument?.evidenceGaps.includes("DIRECTIONAL_HIGHER_TIMEFRAME_UNAVAILABLE"));
        const reduced = first?.grade;
        assert.ok(reduced?.state === "SIMULATED_FILL" && reduced.pnlWithAssumedCosts);
        assert.equal(reduced.baselineSizeRatio, 1);
        assert.equal(reduced.challengerSizeRatio, 0.5);
        assert.equal(reduced.pnlWithAssumedCosts.challengerR, reduced.pnlWithAssumedCosts.baselineR / 2);
        assert.equal(reduced.quoteSidePnl.challengerR, reduced.quoteSidePnl.baselineR / 2);
        const witness = await pool.query<{ evidence: { baseline: import("@workspace/domain/self-trade").DecisionCandidate;
          input: import("@workspace/domain/self-trade").DecisionCandidateInput; quote: { bid: number; ask: number; observedAt: string } } }>(
          "SELECT evidence FROM ati_shadow_observations WHERE run_id = $1", [run.runId]);
        const frozen = witness.rows[0]!.evidence;
        const decidedAt = slot + 1000;
        const adverse = { basis: "PRIOR_OWNER_SHADOW_QUOTE_SIDE_R", lossCount: 12, meanR: -1,
          observations: Array.from({ length: 12 }, (_, i) => ({ runId: randomUUID(), observationKey: `bar:${i}`, baselineR: -1 })) } as const;
        const challenged = assessAtiCounterargument(frozen.baseline, frozen.input, frozen.quote, 1, decidedAt,
          { ...adverse, observations: [...adverse.observations] });
        assert.equal(challenged.decision, "WAIT", "two observed cautions defer the entry");
        assert.ok(challenged.concerns.some(({ code }) => code === "ADVERSE_PRIOR_OUTCOMES"));
        const futureQuote = assessAtiCounterargument(frozen.baseline, frozen.input,
          { ...frozen.quote, observedAt: new Date(decidedAt + 1).toISOString() }, 1, decidedAt, null);
        assert.equal(futureQuote.timing.state, "UNVERIFIED");
        assert.equal(futureQuote.decision, "WAIT");
        const throughStop = assessAtiCounterargument(frozen.baseline, frozen.input, { ...frozen.quote, bid: 1.099 }, 1, decidedAt, null);
        assert.equal(throughStop.decision, "VETO");
        assert.ok(throughStop.concerns.some(({ code }) => code === "BRACKET_ALREADY_INVALID"));

        for (const entry of [
          { scenario: "VETO", outcome: "BLOCKED", code: "OPPOSING_LIQUIDITY_TRAP", timing: "AT_ENTRY" },
          { scenario: "CHASE", outcome: "WAIT", code: "DO_NOT_CHASE", timing: "DO_NOT_CHASE" },
          { scenario: "WAIT_ZONE", outcome: "WAIT", code: "WAIT_FOR_ZONE", timing: "WAIT_FOR_ZONE" },
          { scenario: "BASELINE_WAIT", outcome: "WAIT", code: null, timing: null },
        ] as const) {
          slot += 300_000;
          openCase(entry.scenario);
          assert.equal((await appendAtiShadowObservation(1, 3, run.runId)).status, "RECORDED");
          type ReportObservation = NonNullable<Awaited<ReturnType<typeof readAtiShadowRun>>>["observations"][number];
          const latest: ReportObservation | undefined = (await readAtiShadowRun(1, 3, run.runId))?.observations.at(-1);
          assert.equal(latest?.challengerOutcome, entry.outcome);
          assert.equal(latest?.counterargument?.timing.state ?? null, entry.timing);
          if (entry.code) assert.ok(latest?.counterargument?.concerns.some(({ code }) => code === entry.code));
        }
        assert.equal(await readAtiShadowRun(2, 3, run.runId), null);
      } finally {
        challengeClock.mock.restore();
        counterargumentCase = null;
        derivQuoteOrigin = undefined;
        quoteOffset = -1;
        slot = previousSlot;
        sourceIdentity = previousSource;
        await flushAtiDerivQuotes();
      }
    });

    let retestShadowId: string;
    await t.test("entry timing grades two independent archived legs and separates expiry from a missing path", async () => {
      const { ATI_RETEST_CHALLENGER } = await import("../atiCounterargument.js");
      const snapshot = { slot, sourceIdentity, quoteOffset };
      slot = base - 18 * 60 * 60_000;
      sourceIdentity = "retest-deriv-fixture";
      quoteOffset = 0;
      const retestStream = randomUUID();
      let now = slot + 1000;
      const clock = mock.method(Date, "now", () => now);
      function openCase(scenario: "CHASE" | "WAIT_ZONE") {
        counterargumentCase = scenario;
        now = slot + 1000;
        derivQuoteOrigin = { streamId: retestStream, symbol: "R_75", epoch: now / 1000 };
        frame(retestStream, 1000, 1.1, 1.1001);
      }
      try {
        openCase("CHASE");
        const run = await startAtiShadowRun(1, 3, { ...pilot, symbol: "V75", challengerVersion: ATI_RETEST_CHALLENGER,
          assumedCosts: { adverseSlippagePerFillPriceUnits: 0.00001, feePerFillPriceUnits: 0.000005 } });
        assert.ok(run);
        retestShadowId = run.runId;
        frame(retestStream, 2000, 1.1001, 1.1002);
        frame(retestStream, 4000, 1.09994, 1.1, 3900, 4100);
        frame(retestStream, 6000, 1.1029, 1.103);
        now = slot + 4050;
        assert.equal((await gradeAtiShadowRun(1, 3, run.runId))?.pending, 1, "a staged retest remains unavailable before release");
        now = slot + 6100;
        assert.equal((await restarted.gradeAtiShadowRun(1, 3, run.runId))?.recorded, 1);
        const first = (await readAtiShadowRun(1, 3, run.runId))?.observations[0];
        const pair = first?.grade;
        assert.ok(pair?.state === "RETEST_COMPARISON" && pair.baseline.state === "SIMULATED_FILL" && pair.challenger.state === "SIMULATED_FILL");
        assert.equal(first?.challengerOutcome, "WAIT");
        assert.equal(first?.retestPlan?.expiresAtMs, slot + 15000);
        assert.equal(pair.baseline.entry, 1.1002);
        assert.equal(pair.baseline.entryDelayMs, 1000);
        assert.equal(pair.challenger.entry, 1.1);
        assert.equal(pair.challenger.entryDelayMs, 3100);
        assert.notEqual(pair.baseline.tapeHash, "", "both legs carry archived path proof");
        assert.ok(Math.abs(pair.challenger.returns.assumedR! - (1.1029 - 1.1 - 0.00003) / pair.plannedRiskPriceUnits) < 1e-12);

        slot += 300_000;
        openCase("WAIT_ZONE");
        assert.equal((await appendAtiShadowObservation(1, 3, run.runId)).status, "RECORDED");
        for (let offset = 2000; offset <= 16000; offset += 2000) frame(retestStream, offset, 1.1, 1.1001);
        frame(retestStream, 18000, 1.1029, 1.103);
        now = slot + 18100;
        assert.equal((await gradeAtiShadowRun(1, 3, run.runId))?.recorded, 1);
        const expired = (await readAtiShadowRun(1, 3, run.runId))?.observations[1]?.grade;
        assert.ok(expired?.state === "RETEST_COMPARISON" && expired.challenger.state === "NO_FILL");
        assert.equal(expired.challenger.reason, "ENTRY_WINDOW_EXPIRED");
        assert.equal(expired.challenger.atMs, slot + 16000);

        slot += 300_000;
        openCase("CHASE");
        assert.equal((await appendAtiShadowObservation(1, 3, run.runId)).status, "RECORDED");
        frame(retestStream, 2000, 1.1019, 1.1021); // Baseline's executable buy is already past target.
        frame(retestStream, 4000, 1.09994, 1.1);
        frame(retestStream, 6000, 1.1029, 1.103);
        now = slot + 6100;
        assert.equal((await gradeAtiShadowRun(1, 3, run.runId))?.recorded, 1);
        const deferredOnly = (await readAtiShadowRun(1, 3, run.runId))?.observations[2]?.grade;
        assert.ok(deferredOnly?.state === "RETEST_COMPARISON" && deferredOnly.baseline.state === "NO_FILL" &&
          deferredOnly.challenger.state === "SIMULATED_FILL");
        assert.equal(deferredOnly.baseline.reason, "FIRST_QUOTE_NOT_EXECUTABLE");

        slot += 300_000;
        openCase("CHASE");
        assert.equal((await appendAtiShadowObservation(1, 3, run.runId)).status, "RECORDED");
        frame(retestStream, 2000, 1.1019, 1.1021);
        frame(retestStream, 6000, 1.09994, 1.1); // Missing scheduled quote before the apparent retest.
        frame(retestStream, 8000, 1.1029, 1.103);
        now = slot + 60 * 60_000 + 1001;
        assert.equal((await gradeAtiShadowRun(1, 3, run.runId))?.recorded, 1);
        const report = await readAtiShadowRun(1, 3, run.runId);
        const unknown = report?.observations[3]?.grade;
        assert.ok(unknown?.state === "RETEST_COMPARISON" && unknown.challenger.state === "UNRESOLVED");
        assert.equal(unknown.challenger.reason, "QUOTE_HISTORY_INCOMPLETE");
        assert.equal(unknown.baseline.state, "NO_FILL");
        assert.equal(report?.retestCoverage?.planned, 4);
        assert.equal(report?.retestCoverage?.challengerFills, 2);
        assert.equal(report?.retestCoverage?.challengerNoFills, 1);
        assert.equal(report?.simulations.withAssumedCosts?.settledPairs, 3);
        assert.equal(report?.simulations.withAssumedCosts?.baseline.settledTrades, 2);
        assert.equal(report?.simulations.withAssumedCosts?.challenger.settledTrades, 2);
        assert.equal(await readAtiShadowRun(2, 3, run.runId), null);
      } finally {
        clock.mock.restore();
        slot = snapshot.slot;
        sourceIdentity = snapshot.sourceIdentity;
        quoteOffset = snapshot.quoteOffset;
        derivQuoteOrigin = undefined;
        counterargumentCase = null;
        await flushAtiDerivQuotes();
      }
    });

    let regimeShadowId: string;
    await t.test("regime policy records eligible and non-entry bars under one instrument and source", async () => {
      const { ATI_REGIME_INSTRUMENT_CHALLENGER } = await import("../atiRegimeInstrument.js");
      const snapshot = { slot, sourceIdentity, quoteOffset };
      slot = base - 15 * 60 * 60_000;
      sourceIdentity = "regime-deriv-fixture";
      quoteOffset = 0;
      const regimeStream = randomUUID();
      let now = slot + 1000;
      const clock = mock.method(Date, "now", () => now);
      function observe(regime: "TRENDING" | "RANGING", wait = false) {
        regimeCase = regime;
        counterargumentCase = wait ? "BASELINE_WAIT" : null;
        now = slot + 1000;
        derivQuoteOrigin = { streamId: regimeStream, symbol: "R_75", epoch: now / 1000 };
        frame(regimeStream, 1000, 1.1, 1.1001);
      }
      async function settle(runId: string) {
        frame(regimeStream, 2000, 1.1, 1.1001);
        frame(regimeStream, 4000, 1.1029, 1.103);
        now = slot + 4100;
        assert.equal((await restarted.gradeAtiShadowRun(1, 3, runId))?.recorded, 1);
      }
      try {
        observe("TRENDING");
        const run = await startAtiShadowRun(1, 3, { ...pilot, symbol: "V75", challengerVersion: ATI_REGIME_INSTRUMENT_CHALLENGER,
          assumedCosts: { adverseSlippagePerFillPriceUnits: 0.00001, feePerFillPriceUnits: 0.000005 } });
        assert.ok(run);
        regimeShadowId = run.runId;
        await settle(run.runId);

        slot += 300_000;
        observe("RANGING");
        assert.equal((await appendAtiShadowObservation(1, 3, run.runId)).status, "RECORDED");
        await settle(run.runId);
        slot += 300_000;
        observe("TRENDING", true);
        assert.equal((await appendAtiShadowObservation(1, 3, run.runId)).status, "RECORDED");

        slot += 600_000;
        observe("TRENDING");
        assert.equal((await appendAtiShadowObservation(1, 3, run.runId)).status, "RECORDED");
        await settle(run.runId);

        const report = await readAtiShadowRun(1, 3, run.runId);
        assert.ok(report?.regimeReport);
        assert.equal(report.observations[0]?.challengerOutcome, "APPROVED");
        assert.equal(report.observations[1]?.baselineOutcome, "APPROVED");
        assert.equal(report.observations[1]?.challengerOutcome, "WAIT");
        assert.ok(report.observations[1]?.regimeAssessment?.reasons.includes("SETUP_OUTSIDE_REGIME"));
        assert.equal(report.observations[2]?.baselineOutcome, "WAIT");
        assert.equal(report.observations[2]?.regimeAssessment?.regime, "TRENDING");
        const trending = report.regimeReport.cohorts.find((r) => r.regime === "TRENDING");
        const ranging = report.regimeReport.cohorts.find((r) => r.regime === "RANGING");
        assert.equal(trending?.observedBars, 3);
        assert.equal(trending?.withAssumedCosts?.settledPairs, 2);
        assert.equal(ranging?.withAssumedCosts?.winnersSkipped, 1);
        assert.equal(report.regimeReport.transitions.byFromRegime.find((r) => r.from === "TRENDING")?.sample, 1);
        assert.equal(report.regimeReport.transitions.byFromRegime.find((r) => r.from === "RANGING")?.sample, 1);
        assert.equal(report.regimeReport.transitions.byFromRegime.find((r) => r.from === "TRENDING")?.to
          .find((r) => r.regime === "RANGING")?.probability, null);
        assert.equal(await readAtiShadowRun(2, 3, run.runId), null);
      } finally {
        clock.mock.restore();
        slot = snapshot.slot;
        sourceIdentity = snapshot.sourceIdentity;
        quoteOffset = snapshot.quoteOffset;
        derivQuoteOrigin = undefined;
        counterargumentCase = null;
        regimeCase = null;
        await flushAtiDerivQuotes();
      }
    });

    await t.test("Research Lab seals one prospective, owner-bound holdout and verifies its replay", async () => {
      const { registerAtiResearch, readAtiResearch, listAtiResearch, sealAtiResearch, replayAtiResearchObservation } =
        await import("../atiResearchLab.js");
      const { ATI_WALK_FORWARD_VERSION, canonicalResearch, evaluateAtiResearch, researchRegistration, researchPhases, atiResearchInput } =
        await import("../atiResearchModel.js");
      const { atiShadowDefinition, ATI_SHADOW_GRADE_VERSION } = await import("../atiShadowGrading.js");
      const { db, atiShadowRunsTable: runs, atiResearchStudiesTable: studies, atiResearchSealsTable: seals,
        atiShadowObservationsTable: observations, atiShadowOutcomesTable: outcomes } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      await pool.query(`
        CREATE TABLE self_trade_agents (id integer PRIMARY KEY, owner_type text, owner_id integer);
        CREATE TABLE self_trade_agent_settings (agent_id integer PRIMARY KEY, allowed_symbols jsonb);
        INSERT INTO self_trade_agents VALUES (3, 'USER', 1);
        INSERT INTO self_trade_agent_settings VALUES (3, '["EURUSD","V75"]');
      `);
      const bar = atiShadowDefinition.barMs;
      const phaseLength = 24 * bar;
      function specFor(start: number, market: import("../atiResearchModel.js").AtiResearchInput["market"]) {
        return atiResearchInput.parse({
          requestId: randomUUID(), symbol: market.source === "mt5_broker" ? "EURUSD" : "V75", setup: "TREND_CONTINUATION",
          hypothesis: "Skipping entries with opposing higher timeframe improves net paired returns.",
          market, startsAtMs: start, developmentEndsAtMs: start + phaseLength,
          validationEndsAtMs: start + 2 * phaseLength, holdoutEndsAtMs: start + 3 * phaseLength,
          costs: { basis: "ASSUMED", assumptions: { adverseSlippagePerFillPriceUnits: 0.01, feePerFillPriceUnits: 0.01 } },
          criteria: { minCaptureFraction: 0.1, minSettledFraction: 0.5, minSettledPairs: 2,
            minChangedPairs: 1, minMeanImprovementR: 0.2, maxDrawdownIncreaseR: 0, extraStressCostRPerRoundTrip: 0.2 },
        });
      }
      const { ATI_FLEET_BASELINE, ATI_FLEET_SCOPE } = await import("../atiFleetDefinition.js");
      const { activeAtiFleetRuns } = await import("../atiFleetShadow.js");
      const nextBar = Math.ceil(Date.now() / bar) * bar + bar;
      const prospective = specFor(nextBar, { source: "mt5_broker", mode: "DEMO" });
      const fleetSpec = { ...specFor(nextBar + 12 * 86_400_000, { source: "deriv_public", mode: null }), baselineVersion: ATI_FLEET_BASELINE } as const;
      assert.equal(atiResearchInput.safeParse({ ...fleetSpec, symbol: "EURUSD" }).success, false);
      assert.equal(atiResearchInput.safeParse({ ...fleetSpec, market: { source: "mt5_broker", mode: "LIVE" } }).success, false);
      assert.equal(atiResearchInput.safeParse({ ...fleetSpec, challengerVersion: "guardian-early-breakeven-v1" }).success, false);
      const nativeRegistration = await registerAtiResearch(1, 3, fleetSpec);
      assert.ok(nativeRegistration.status === "REGISTERED");
      const nativeRegistrationId = nativeRegistration.registration.runId;
      assert.equal(nativeRegistration.registration.definition.baselineVersion, ATI_FLEET_BASELINE);
      assert.equal((await appendAtiShadowObservation(1, 3, nativeRegistrationId, "RESEARCH")).status, "PASSIVE_FLEET_CAPTURE");
      assert.equal((await activeAtiFleetRuns(1, fleetSpec.startsAtMs)).some(r => r.id === nativeRegistrationId), true);
      assert.equal((await activeAtiFleetRuns(2, fleetSpec.startsAtMs)).some(r => r.id === nativeRegistrationId), false);
      assert.equal((await activeAtiFleetRuns(1, fleetSpec.holdoutEndsAtMs)).some(r => r.id === nativeRegistrationId), false);
      assert.equal(await readAtiShadowRun(1, 3, nativeRegistrationId), null);
      const before = readCount;
      assert.equal((await registerAtiResearch(2, 3, prospective)).status, "AGENT_UNAVAILABLE");
      const concurrent = await Promise.all([registerAtiResearch(1, 3, prospective), registerAtiResearch(1, 3, prospective)]);
      assert.deepEqual(concurrent.map((x) => x.status).sort(), ["ALREADY_REGISTERED", "REGISTERED"]);
      const registered = concurrent.find((x) => x.status === "REGISTERED");
      assert.ok(registered && registered.status === "REGISTERED");
      const researchId = registered.registration.runId;
      assert.equal((await registerAtiResearch(1, 3, { ...prospective, hypothesis: "Changed criteria and interpretation." })).status, "REQUEST_CONFLICT");
      assert.equal((await registerAtiResearch(1, 3, { ...prospective, requestId: randomUUID() })).status, "OVERLAPPING_STUDY");
      const { ATI_COUNTERARGUMENT_CHALLENGER, atiCounterargumentPolicy } = await import("../atiCounterargument.js");
      const registeredChallenge = await registerAtiResearch(1, 3, { ...prospective, requestId: randomUUID(),
        market: { source: "mt5_broker", mode: "LIVE" }, challengerVersion: ATI_COUNTERARGUMENT_CHALLENGER });
      assert.ok(registeredChallenge.status === "REGISTERED");
      assert.equal(registeredChallenge.registration.definition.challengerVersion, ATI_COUNTERARGUMENT_CHALLENGER);
      assert.deepEqual(registeredChallenge.registration.counterargumentPolicy, atiCounterargumentPolicy);
      assert.equal((await registerAtiResearch(1, 3, specFor(nextBar - 24 * 60 * 60_000, prospective.market))).status, "START_MUST_BE_FUTURE");
      assert.deepEqual(await listAtiResearch(2, 3, 10), []);
      assert.equal(await readAtiResearch(2, 3, researchId), null);
      assert.equal(await readAtiResearch(1, 4, researchId), null);
      assert.equal((await readAtiResearch(1, 3, researchId))?.status, "REGISTERED");
      assert.equal((await replayAtiResearchObservation(1, 3, researchId, "bar:unreleased"))?.status, "STUDY_NOT_SEALED");
      assert.equal((await sealAtiResearch(1, 3, researchId))?.status, "GRADE_WINDOW_OPEN");
      assert.equal(await readAtiShadowRun(1, 3, researchId), null);
      assert.equal(await gradeAtiShadowRun(1, 3, researchId), null);
      assert.equal((await appendAtiShadowObservation(1, 3, researchId)).status, "NOT_FOUND");
      assert.equal((await appendAtiShadowObservation(1, 3, researchId, "RESEARCH")).status, "NOT_STARTED");
      assert.equal(readCount, before);

      const previousSlot = slot;
      const previousOrigin = mt5QuoteOrigin;
      slot = nextBar;
      const captureClock = mock.method(Date, "now", () => slot + 1_000);
      try {
        const captured = await appendAtiShadowObservation(1, 3, researchId, "RESEARCH");
        assert.equal(captured.status, "RECORDED");
        if (captured.status === "RECORDED") assert.equal(captured.coverage, "SOURCE_CHANGED", "LIVE evidence cannot seed a DEMO study");
        assert.equal((await readAtiShadowMemory(1, 3, { asOf: new Date(slot + 2_000), limit: 50 })).episodes
          .some((row) => row.runId === researchId), false);
        assert.ok(mt5QuoteOrigin);
        mt5QuoteOrigin = { ...mt5QuoteOrigin, mode: "DEMO" };
        slot += bar;
        const matched = await appendAtiShadowObservation(1, 3, researchId, "RESEARCH");
        assert.equal(matched.status, "RECORDED");
        if (matched.status === "RECORDED") assert.equal(matched.coverage, "OBSERVED");
        slot += bar;
        assert.equal((await gradeAtiShadowRun(1, 3, researchId, "RESEARCH"))?.recorded, 1);
        assert.equal((await gradeAtiShadowRun(1, 3, researchId, "RESEARCH"))?.recorded, 0);
        assert.equal((await readAtiResearch(1, 3, researchId))?.status, "REGISTERED");
      } finally {
        captureClock.mock.restore();
        slot = previousSlot;
        mt5QuoteOrigin = previousOrigin;
      }

      // Simulate a complete past schedule on this disposable database. The public
      // registration service above separately verifies that past starts are refused.
      const spec = specFor(nextBar - 24 * 60 * 60_000, { source: "deriv_public", mode: null });
      assert.equal(spec.costs.basis, "ASSUMED");
      const historicalId = randomUUID();
      const build = { revision: "e".repeat(40), sourceState: "clean" } as const;
      const registration = researchRegistration(historicalId, 1, 3, spec.startsAtMs - bar, spec, build);
      const receipt = canonicalResearch(registration);
      const setup = spec.setup;
      await db.insert(runs).values({ id: historicalId, ownerId: 1, agentId: 3, symbol: spec.symbol, setup,
        timeframe: atiShadowDefinition.timeframe, baselineVersion: atiShadowDefinition.baselineVersion,
        challengerVersion: atiShadowDefinition.challengerVersion, researchSource: spec.market.source,
        startedAt: new Date(spec.startsAtMs), endsAt: new Date(spec.holdoutEndsAtMs),
        assumedCosts: spec.costs.basis === "ASSUMED" ? spec.costs.assumptions : null });
      await db.insert(studies).values({ runId: historicalId, ownerId: 1, agentId: 3, requestId: spec.requestId,
        registration: receipt.canonical, registrationHash: receipt.hash, registeredAt: new Date(registration.registeredAtMs) });
      async function fixturePair(at: number, baselineR: number, skipped: boolean, labelAt = at + 8_000, addGrade = true) {
        const observationKey = `bar:${at}`;
        await db.insert(observations).values({ runId: historicalId, observationKey, observedAt: new Date(at),
          recordedAt: new Date(at + 1), sourceIdentity: "deriv-prospective-cohort", coverage: "OBSERVED", setup,
          baselineOutcome: "APPROVED", challengerOutcome: skipped ? "WAIT" : "APPROVED",
          evidence: { researchBuild: build, decisionSettingsHash: "d".repeat(64) } });
        const pnl = { baselineR, challengerR: skipped ? 0 : baselineR };
        const grade = { runId: historicalId, observationKey, evaluatedAt: new Date(labelAt - 1), recordedAt: new Date(labelAt),
          gradeVersion: ATI_SHADOW_GRADE_VERSION, evidence: { state: "SIMULATED_FILL", exitObservedAt: at + 4_000,
            baselineSizeRatio: 1, challengerSizeRatio: skipped ? 0 : 1, quoteSidePnl: pnl, pnlWithAssumedCosts: pnl,
            quoteSource: "deriv_public", entry: 100, exit: baselineR < 0 ? 99 : 101, exitReason: baselineR < 0 ? "STOP" : "TARGET",
            riskPriceUnits: 1, researchBuild: build } };
        if (addGrade) await db.insert(outcomes).values(grade);
        return grade;
      }
      for (const phase of researchPhases(spec)) {
        await fixturePair(phase.startMs + 1000, -1, true);
        await fixturePair(phase.startMs + bar + 1000, 1, false);
      }
      await fixturePair(spec.developmentEndsAtMs - bar + 1000, 20, true, spec.developmentEndsAtMs + bar);
      await fixturePair(spec.developmentEndsAtMs + 2 * bar + 1000, 20, true, spec.validationEndsAtMs + bar);
      const arrivedAfterCutoff = await fixturePair(spec.validationEndsAtMs + 2 * bar + 1000, 20, true, registration.gradeCutoffMs + 100, false);
      assert.equal((await readAtiResearch(1, 3, historicalId))?.status, "REGISTERED");
      const sealing = await Promise.all([sealAtiResearch(1, 3, historicalId), sealAtiResearch(1, 3, historicalId)]);
      const sealed = sealing[0];
      assert.ok(sealed?.status === "SEALED");
      assert.deepEqual(sealing[1], sealed);
      assert.equal(sealed.result.verdict, "FORWARD_REVIEW_REQUIRED");
      const { readAtiReplication } = await import("../atiResearchLab.js");
      const openReview = await readAtiReplication(1, 3, researchId, true);
      assert.ok(openReview && openReview.gaps.includes("BUILD_UNVERIFIED"));
      assert.deepEqual(openReview.archiveReplay, { primary: null, forward: null });
      const initial = await readAtiReplication(1,3,historicalId);
      assert.deepEqual(initial?.gaps,["NO_DESIGNATED_FORWARD_STUDY"]);
      assert.equal(await readAtiReplication(2,3,historicalId),null);
      const linkedSpec = (shift:number) => ({...spec,requestId:randomUUID(), startsAtMs:spec.startsAtMs+shift,
        developmentEndsAtMs:spec.developmentEndsAtMs+shift,validationEndsAtMs:spec.validationEndsAtMs+shift,
        holdoutEndsAtMs:spec.holdoutEndsAtMs+shift,replicates:{runId:historicalId,datasetHash:sealed.datasetHash,resultHash:sealed.resultHash}});
      const follow = linkedSpec(3*86_400_000);
      const previousBuild = Object.getOwnPropertyDescriptor(globalThis,"__ARX_BUILD_IDENTITY__");
      Object.defineProperty(globalThis,"__ARX_BUILD_IDENTITY__",{value:build,configurable:true});
      try {
        const badHash = {...follow,replicates:{...follow.replicates,datasetHash:"0".repeat(64)}};
        assert.equal((await registerAtiResearch(1,3,badHash)).status,"REPLICATION_IDENTITY_MISMATCH");
        assert.equal((await registerAtiResearch(1,3,{...follow,setup:"REVERSAL"})).status,"REPLICATION_IDENTITY_MISMATCH");
        assert.equal((await registerAtiResearch(1,3,{...follow,criteria:{...follow.criteria,minChangedPairs:99}})).status,"REPLICATION_IDENTITY_MISMATCH");
        assert.equal((await registerAtiResearch(1,3,follow)).status,"REGISTERED");
        assert.equal((await registerAtiResearch(1,3,follow)).status,"ALREADY_REGISTERED");
        assert.equal((await registerAtiResearch(1,3,linkedSpec(5*86_400_000))).status,"REPLICATION_ALREADY_DESIGNATED");
        const pending = await readAtiReplication(1,3,historicalId);
        assert.deepEqual(pending?.gaps,["FORWARD_UNSEALED"]);
        assert.equal(pending?.forward?.sealed,null);
      } finally {
        if(previousBuild) Object.defineProperty(globalThis,"__ARX_BUILD_IDENTITY__",previousBuild);
        else Reflect.deleteProperty(globalThis,"__ARX_BUILD_IDENTITY__");
      }

      // Emulate previously archived, chronologically sealed pairs in this disposable DB.
      // The reader must verify both canonical datasets and recompute each verdict.
      const originalDataset = sealed.dataset;
      type ReplicationLink = NonNullable<typeof spec.replicates>;
      async function archivedStudy(daysBefore: number, link?: ReplicationLink, adverse = false, settings = "d".repeat(64)) {
        const shift = -daysBefore * 86_400_000;
        const fixed = { ...specFor(spec.startsAtMs + shift, spec.market), ...(link ? { replicates: link } : {}) };
        const runId = randomUUID();
        const reg = researchRegistration(runId, 1, 3, fixed.startsAtMs - bar, fixed, build);
        const regReceipt = canonicalResearch(reg);
        const data = { ...originalDataset, registrationHash: regReceipt.hash, decisionSettingsHash: settings,
          observations: originalDataset.observations.map(row => {
            const e = row.evidence, fill = e?.fill;
            return { ...row, observationKey: `bar:${row.observedAtMs + shift}`, decisionSettingsHash: settings,
              observedAtMs: row.observedAtMs + shift, recordedAtMs: row.recordedAtMs == null ? null : row.recordedAtMs + shift,
              evidence: e ? { ...e, evaluatedAtMs: e.evaluatedAtMs + shift, recordedAtMs: e.recordedAtMs + shift,
                fill: fill ? { ...fill, exitObservedAt: fill.exitObservedAt + shift,
                  ...(adverse && row.observedAtMs >= spec.validationEndsAtMs
                    ? { pnlWithAssumedCosts: { baselineR: 1, challengerR: 0 } } : {}) } : null } : null };
          }) };
        const dataReceipt = canonicalResearch(data);
        const result = evaluateAtiResearch(reg, data), resultHash = canonicalResearch(result).hash;
        await db.insert(runs).values({ id: runId, ownerId: 1, agentId: 3, symbol: fixed.symbol, setup: fixed.setup,
          timeframe: reg.definition.timeframe, baselineVersion: reg.definition.baselineVersion,
          challengerVersion: reg.definition.challengerVersion, researchSource: fixed.market.source, researchMode: fixed.market.mode,
          startedAt: new Date(fixed.startsAtMs), endsAt: new Date(fixed.holdoutEndsAtMs),
          assumedCosts: fixed.costs.basis === "ASSUMED" ? fixed.costs.assumptions : null });
        await db.insert(studies).values({ runId, ownerId: 1, agentId: 3, requestId: fixed.requestId,
          registration: regReceipt.canonical, registrationHash: regReceipt.hash, registeredAt: new Date(reg.registeredAtMs) });
        await db.insert(seals).values({ runId, dataset: dataReceipt.canonical, datasetHash: dataReceipt.hash, resultHash,
          verdict: result.verdict, sealedAt: new Date(reg.gradeCutoffMs + 1) });
        return { runId, datasetHash: dataReceipt.hash, resultHash };
      }
      for (const [index, scenario] of ["passed", "negative primary", "negative forward", "other settings"].entries()) {
        const daysBefore = 10 + index * 3;
        const primary = await archivedStudy(daysBefore, undefined, scenario === "negative primary");
        await archivedStudy(daysBefore - 1, primary, scenario === "negative forward", (scenario === "other settings" ? "a" : "d").repeat(64));
        const report = await readAtiReplication(1, 3, primary.runId);
        assert.ok(report?.forward?.sealed);
        if (scenario === "passed") {
          const checked = await readAtiReplication(1, 3, primary.runId, true);
          assert.equal(checked?.status, "FORWARD_EVIDENCE_INCOMPLETE");
          assert.deepEqual(checked.gaps, ["PRIMARY_REPLAY_INCOMPLETE", "FORWARD_REPLAY_INCOMPLETE"]);
          assert.ok(checked.archiveReplay?.primary?.required && checked.archiveReplay.forward?.required);
          assert.ok(checked.archiveReplay.primary.receipts.every(r => r.status === "NO_ARCHIVE_PROOF"));
          assert.equal(checked.archiveReplay.forward.reproduced, 0);
        }
        assert.equal(report.scope, "SEALED_SHADOW_STUDY_COMPARISON");
        assert.deepEqual(report.comparison, {
          agentId: 3, decisionScope: "SOURCE_BOUND_SINGLE_AGENT_BEFORE_FLEET_SUPERVISION",
          symbol: "V75", setup: "TREND_CONTINUATION", timeframe: "M5",
          baselineVersion: "self-trade-source-bound-v1", challengerVersion: "skip-timeframe-conflict-v1",
          market: { source: "deriv_public", mode: null }, costs: spec.costs,
        });
        assert.equal(report.primary.sealed?.sourceIdentity, originalDataset.sourceIdentity);
        assert.equal(report.primary.sealed?.decisionSettingsHash, "d".repeat(64));
        assert.equal(report.forward.sealed.decisionSettingsHash, (scenario === "other settings" ? "a" : "d").repeat(64));
        assert.equal(report.executionAuthority, "NONE");
        assert.equal(report.status, scenario === "passed" ? "ARCHIVE_REPLAY_REQUIRED" : "FORWARD_EVIDENCE_INCOMPLETE");
        assert.deepEqual(report.gaps, scenario === "passed" ? [] : [scenario === "negative primary" ? "PRIMARY_REJECTED"
          : scenario === "negative forward" ? "FORWARD_REJECTED" : "SOURCE_OR_SETTINGS_MISMATCH"]);
      }

      assert.equal(sealed.result.phases[0]?.exclusions.boundaryPurge, 1);
      assert.equal(sealed.result.phases[1]?.exclusions.unavailableLabels, 1);
      assert.equal(sealed.result.phases[2]?.exclusions.unavailableLabels, 1);
      assert.equal(sealed.result.phases[2]?.base.settledPairs, 2);
      assert.equal(sealed.result.phases[2]?.meanDeltaR, 0.5);
      assert.equal(sealed.result.phases[2]?.stressedMeanDeltaR, 0.6);
      assert.equal(sealed.result.phases[2]?.simulatedTail.baseline, null);
      assert.equal(sealed.result.executionAuthority, "NONE");
      const rejected = evaluateAtiResearch(sealed.registration, { ...sealed.dataset,
        observations: sealed.dataset.observations.map((row) => row.observedAtMs >= spec.validationEndsAtMs && row.evidence?.fill
          ? { ...row, evidence: { ...row.evidence, fill: { ...row.evidence.fill, pnlWithAssumedCosts: { baselineR: 1, challengerR: 0 } } } } : row),
      });
      assert.equal(rejected.verdict, "REJECTED");
      const changedSettings = evaluateAtiResearch(sealed.registration, { ...sealed.dataset,
        observations: sealed.dataset.observations.map((row) => row.observedAtMs >= spec.validationEndsAtMs
          ? { ...row, decisionSettingsHash: "f".repeat(64) } : row),
      });
      assert.equal(changedSettings.verdict, "INSUFFICIENT_EVIDENCE");
      assert.ok(changedSettings.phases[2]?.evidenceGaps.includes("UNVERIFIED_OR_CHANGED_DECISION_SETTINGS"));
      await db.insert(outcomes).values(arrivedAfterCutoff);
      assert.deepEqual(await readAtiResearch(1, 3, historicalId), sealed, "a late broker label cannot rewrite the held-out result");
      assert.equal((await replayAtiResearchObservation(1, 3, historicalId, sealed.dataset.observations[0]!.observationKey))?.status,
        "NO_ARCHIVE_PROOF", "Deriv in-memory outcomes do not claim an archived bid/ask replay");

      const walkSpec = atiResearchInput.parse({ ...spec, validationEndsAtMs: spec.validationEndsAtMs + phaseLength,
        holdoutEndsAtMs: spec.holdoutEndsAtMs + phaseLength, walkForward: { folds: 2, embargoBars: 1, minPassingFolds: 2 } });
      const walkRegistration = researchRegistration(randomUUID(), 1, 3, registration.registeredAtMs, walkSpec, build);
      const [fold1, fold2] = walkRegistration.folds ?? [];
      assert.ok(fold1 && fold2);
      assert.equal(fold1.priorDecisionEndMs + 13 * bar, fold1.testStartMs);
      assert.equal(fold1.priorLabelCutoffMs + bar, fold1.testStartMs);
      assert.equal(fold1.testEndMs, fold2.testStartMs);
      assert.equal(fold2.testEndMs, walkSpec.validationEndsAtMs);
      const seeds = sealed.dataset.observations.filter((row) => row.observedAtMs < spec.startsAtMs + 2 * bar);
      const walkRows = [walkSpec.startsAtMs, fold1.testStartMs, fold2.testStartMs, walkSpec.validationEndsAtMs].flatMap((start) =>
        seeds.map((row) => {
          const shift = start - spec.startsAtMs;
          const evidence = row.evidence!;
          return { ...row, observationKey: `bar:${row.observedAtMs + shift}`, observedAtMs: row.observedAtMs + shift,
            recordedAtMs: row.recordedAtMs! + shift, evidence: { ...evidence, evaluatedAtMs: evidence.evaluatedAtMs + shift,
              recordedAtMs: evidence.recordedAtMs + shift, fill: { ...evidence.fill!, exitObservedAt: evidence.fill!.exitObservedAt + shift } } };
        }));
      const walkData = { ...sealed.dataset, registrationHash: canonicalResearch(walkRegistration).hash, observations: walkRows };
      const walkReplayKeys = new Set<string>();
      const walkRun = evaluateAtiResearch(walkRegistration, walkData, walkReplayKeys);
      assert.deepEqual([...walkReplayKeys].sort(), walkRows.filter(row => row.observedAtMs >= fold1.testStartMs)
        .map(row => row.observationKey).sort());
      assert.ok(walkRun.runnerVersion === ATI_WALK_FORWARD_VERSION);
      assert.equal(walkRun.verdict, "FORWARD_REVIEW_REQUIRED");
      assert.equal(walkRun.walkForward?.passingFolds, 2);
      assert.equal(walkRun.walkForward?.folds[1]?.prior.settledPairs, 4);
      const lateFoldLabel = evaluateAtiResearch(walkRegistration, { ...walkData, observations: walkRows.map((row) =>
        row.observedAtMs === fold1.testStartMs + 1000 ? { ...row, evidence: { ...row.evidence, recordedAtMs: fold1.testEndMs } } : row) });
      assert.ok(lateFoldLabel.runnerVersion === ATI_WALK_FORWARD_VERSION);
      assert.equal(lateFoldLabel.verdict, "INSUFFICIENT_EVIDENCE", "a validation aggregate cannot mask a thin fold");
      assert.equal(lateFoldLabel.walkForward?.folds[0]?.test.exclusions.unavailableLabels, 1);
      const failedHoldout = evaluateAtiResearch(walkRegistration, { ...walkData, observations: walkRows.map((row) =>
        row.observedAtMs >= walkSpec.validationEndsAtMs ? { ...row,
          evidence: { ...row.evidence, fill: { ...row.evidence.fill, pnlWithAssumedCosts: { baselineR: 1, challengerR: 0 } } } } : row) });
      assert.ok(failedHoldout.runnerVersion === ATI_WALK_FORWARD_VERSION);
      assert.equal(failedHoldout.verdict, "REJECTED");
      assert.deepEqual(failedHoldout.walkForward, walkRun.walkForward, "the final holdout cannot change an earlier fold");

      const { atiMt5QuoteOrigin } = await import("../../data/atiMt5QuoteOrigin.js");
      const { loadAtiMt5ReplayQuotes } = await import("../atiMt5QuoteReplay.js");
      const { gradeAtiShadowPair, ATI_MT5_GRADE_VERSION } = await import("../atiShadowGrading.js");
      const [witness] = await db.select().from(observations).where(eq(observations.runId, remembered.runId));
      assert.ok(witness);
      const facts = witness.evidence as { baseline: import("@workspace/domain/self-trade").DecisionCandidate;
        mt5QuoteOrigin: unknown; quote: { bid: number; ask: number; observedAt: string } };
      const previous = atiMt5QuoteOrigin.parse(facts.mt5QuoteOrigin);
      const oldDecisionAt = +witness.observedAt;
      const oldGradeAt = remembered.outcome.replay!.exitObservedAt + 200;
      const archive = await loadAtiMt5ReplayQuotes(1, previous, oldDecisionAt, oldGradeAt);
      assert.ok(archive.length >= 4);
      const archiveSpec = atiResearchInput.parse({ ...walkSpec, requestId: randomUUID(), symbol: "EURUSD", market: { source: "mt5_broker", mode: "LIVE" },
        costs: { basis: "ASSUMED", assumptions: { adverseSlippagePerFillPriceUnits: 0.00001, feePerFillPriceUnits: 0.000005 } } });
      assert.equal(archiveSpec.costs.basis, "ASSUMED");
      const archiveId = randomUUID();
      const archiveRegistration = researchRegistration(archiveId, 1, 3, registration.registeredAtMs, archiveSpec, build);
      const archiveReceipt = canonicalResearch(archiveRegistration);
      await db.insert(runs).values({ id: archiveId, ownerId: 1, agentId: 3, symbol: archiveSpec.symbol, setup,
        timeframe: atiShadowDefinition.timeframe, baselineVersion: atiShadowDefinition.baselineVersion,
        challengerVersion: atiShadowDefinition.challengerVersion, researchSource: "mt5_broker", researchMode: "LIVE",
        startedAt: new Date(archiveSpec.startsAtMs), endsAt: new Date(archiveSpec.holdoutEndsAtMs),
        assumedCosts: archiveSpec.costs.assumptions });
      await db.insert(studies).values({ runId: archiveId, ownerId: 1, agentId: 3, requestId: archiveSpec.requestId,
        registration: archiveReceipt.canonical, registrationHash: archiveReceipt.hash, registeredAt: new Date(archiveRegistration.registeredAtMs) });
      const decisionAt = archiveSpec.validationEndsAtMs + 1000;
      const shift = decisionAt - oldDecisionAt;
      const fixtureBridge = 41;
      const receiptIds = new Map<number, number>();
      for (const item of archive) {
        const payload = item.payload as { brokerTimeEpochMs: number };
        const inserted = await pool.query<{ id: number }>(`
          INSERT INTO bridge_v2_events(user_id,bridge_connection_id,protocol_version,message_type,stream_key,sequence,idempotency_key,
            sequence_verdict,accepted,ea_created_at_epoch_ms,server_received_at_epoch_ms,payload)
          VALUES(1,$1,2,'TICK',$2,$3,$4,$5,true,$6,$7,$8) RETURNING id`, [
          fixtureBridge, previous.streamKey, item.sequence, `research-archive-${item.id}`, item.verdict,
          item.capturedAt! + shift, item.receivedAt! + shift, { ...payload, brokerTimeEpochMs: payload.brokerTimeEpochMs + shift },
        ]);
        receiptIds.set(item.id, inserted.rows[0]!.id);
      }
      const mt5Origin = { ...previous, bridgeConnectionId: fixtureBridge,
        receiptId: receiptIds.get(previous.receiptId)!, brokerTickAtMs: previous.brokerTickAtMs + shift };
      const decisionQuote = { ...facts.quote, observedAt: new Date(Date.parse(facts.quote.observedAt) + shift).toISOString() };
      const baselinePlan = { ...facts.baseline, setupExpiresAt: new Date(Date.parse(facts.baseline.setupExpiresAt!) + shift).toISOString() };
      const gradeAt = oldGradeAt + shift;
      const simulated = gradeAtiShadowPair({ source: "mt5_broker", symbol: archiveSpec.symbol, observedAt: decisionAt,
        baseline: baselinePlan, challengerOutcome: witness.challengerOutcome, assumedCosts: archiveSpec.costs.assumptions,
        mt5Replay: { origin: mt5Origin, quote: decisionQuote, rows: await loadAtiMt5ReplayQuotes(1, mt5Origin, decisionAt, gradeAt) },
      }, gradeAt);
      assert.ok(simulated?.state === "SIMULATED_FILL" && simulated.mt5Replay?.tapeHash);
      const archiveKey = `bar:${decisionAt}`;
      await db.insert(observations).values({ runId: archiveId, observationKey: archiveKey, observedAt: new Date(decisionAt),
        recordedAt: new Date(decisionAt + 1), sourceIdentity: "mt5-research-cohort", coverage: "OBSERVED", setup,
        baselineOutcome: baselinePlan.outcome, challengerOutcome: witness.challengerOutcome,
        evidence: { researchBuild: build, decisionSettingsHash: "d".repeat(64), baseline: baselinePlan, quote: decisionQuote, mt5QuoteOrigin: mt5Origin } });
      await db.insert(outcomes).values({ runId: archiveId, observationKey: archiveKey, gradeVersion: ATI_MT5_GRADE_VERSION,
        evaluatedAt: new Date(gradeAt), recordedAt: new Date(gradeAt + 1), evidence: { ...simulated, researchBuild: build } });
      assert.equal((await replayAtiResearchObservation(1, 3, archiveId, archiveKey))?.status, "STUDY_NOT_SEALED");
      const archiveSeal = await sealAtiResearch(1, 3, archiveId);
      assert.ok(archiveSeal?.status === "SEALED");
      assert.ok(archiveSeal.dataset.observations[0]?.mt5ReplayProof);
      const reproduced = await replayAtiResearchObservation(1, 3, archiveId, archiveKey);
      assert.ok(reproduced?.status === "REPRODUCED");
      assert.deepEqual(reproduced.grade, simulated);
      assert.equal(await replayAtiResearchObservation(2, 3, archiveId, archiveKey), null);
      await pool.query("UPDATE bridge_v2_events SET server_received_at_epoch_ms = server_received_at_epoch_ms + 1 WHERE id = $1",
        [receiptIds.get(archive[0]!.id)]);
      assert.equal((await replayAtiResearchObservation(1, 3, archiveId, archiveKey))?.status, "ARCHIVE_MISMATCH",
        "changes to a non-fill receipt alter the replay proof");
      await pool.query("DELETE FROM bridge_v2_events WHERE bridge_connection_id = $1 AND user_id = 1", [fixtureBridge]);
      assert.equal((await replayAtiResearchObservation(1, 3, archiveId, archiveKey))?.status, "ARCHIVE_UNAVAILABLE");
      assert.deepEqual(await readAtiResearch(1, 3, archiveId), archiveSeal, "archive changes cannot rewrite the sealed dataset");

      const [derivObservation] = await db.select().from(observations).where(eq(observations.runId, archivedDerivId));
      const [derivOutcome] = await db.select().from(outcomes).where(eq(outcomes.runId, archivedDerivId));
      assert.ok(derivObservation && derivOutcome);
      const derivStartMs = Math.floor(+derivObservation.observedAt / bar) * bar - bar;
      const derivShift = derivStartMs - walkSpec.startsAtMs;
      const derivSpec = atiResearchInput.parse({ ...walkSpec, requestId: randomUUID(), startsAtMs: derivStartMs,
        developmentEndsAtMs: walkSpec.developmentEndsAtMs + derivShift, validationEndsAtMs: walkSpec.validationEndsAtMs + derivShift,
        holdoutEndsAtMs: walkSpec.holdoutEndsAtMs + derivShift });
      assert.equal(derivSpec.costs.basis, "ASSUMED");
      const derivStudyId = randomUUID();
      const derivRegistration = researchRegistration(derivStudyId, 1, 3, derivSpec.startsAtMs - 1000, derivSpec, build);
      const derivReceipt = canonicalResearch(derivRegistration);
      await db.insert(runs).values({ id: derivStudyId, ownerId: 1, agentId: 3, symbol: derivSpec.symbol, setup,
        timeframe: atiShadowDefinition.timeframe, baselineVersion: atiShadowDefinition.baselineVersion,
        challengerVersion: atiShadowDefinition.challengerVersion, researchSource: "deriv_public",
        startedAt: new Date(derivSpec.startsAtMs), endsAt: new Date(derivSpec.holdoutEndsAtMs), assumedCosts: derivSpec.costs.assumptions });
      await db.insert(studies).values({ runId: derivStudyId, ownerId: 1, agentId: 3, requestId: derivSpec.requestId,
        registration: derivReceipt.canonical, registrationHash: derivReceipt.hash, registeredAt: new Date(derivRegistration.registeredAtMs) });
      await db.insert(observations).values({ ...derivObservation, runId: derivStudyId, recordedAt: new Date(+derivObservation.observedAt + 1),
        evidence: { ...(derivObservation.evidence as object), researchBuild: build, decisionSettingsHash: "d".repeat(64) } });
      await db.insert(outcomes).values({ ...derivOutcome, runId: derivStudyId, recordedAt: new Date(+derivOutcome.evaluatedAt + 1),
        evidence: { ...(derivOutcome.evidence as object), researchBuild: build } });
      const derivSeal = await sealAtiResearch(1, 3, derivStudyId);
      assert.ok(derivSeal?.status === "SEALED" && derivSeal.dataset.observations[0]?.derivReplayProof);
      const replayDeriv = () => replayAtiResearchObservation(1, 3, derivStudyId, derivObservation.observationKey);
      const derivReproduced = await replayDeriv();
      assert.equal(derivReproduced?.status, "REPRODUCED");
      assert.equal(await replayAtiResearchObservation(2, 3, derivStudyId, derivObservation.observationKey), null);
      // The disposable database supplies independent, disjoint quote paths for both registered studies.
      const { atiDerivQuoteFramesTable: frames } = await import("@workspace/db");
      const { loadAtiDerivReplayQuotes } = await import("../atiDerivQuoteReplay.js");
      const { sql } = await import("drizzle-orm");
      async function replaceTestSeal(runId: string, fields: Partial<typeof seals.$inferInsert>) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`ALTER TABLE ati_research_seals DISABLE TRIGGER ati_research_seals_no_change`);
          await tx.update(seals).set(fields).where(eq(seals.runId, runId));
          await tx.execute(sql`ALTER TABLE ati_research_seals ENABLE TRIGGER ati_research_seals_no_change`);
        });
      }
      let nextDecisionId = 123_000;
      async function studyWithQuoteArchive(start: number, replicates?: ReplicationLink, options: { omitConflictWarning?: boolean; fleet?: boolean } = {}) {
        const assumptions = { adverseSlippagePerFillPriceUnits: 0.00001, feePerFillPriceUnits: 0.000005 };
        const fixed = { ...specFor(start, { source: "deriv_public", mode: null }),
          ...(options.fleet ? { baselineVersion: ATI_FLEET_BASELINE } as const : {}),
          costs: { basis: "ASSUMED" as const, assumptions }, ...(replicates ? { replicates } : {}) };
        const runId = randomUUID();
        const reg = researchRegistration(runId, 1, 3, start - bar, fixed, build);
        const receipt = canonicalResearch(reg);
        await db.insert(runs).values({ id: runId, ownerId: 1, agentId: 3, symbol: fixed.symbol, setup,
          timeframe: reg.definition.timeframe, baselineVersion: reg.definition.baselineVersion, challengerVersion: reg.definition.challengerVersion,
          researchSource: fixed.market.source, researchMode: fixed.market.mode, startedAt: new Date(start),
          endsAt: new Date(fixed.holdoutEndsAtMs), assumedCosts: assumptions });
        await db.insert(studies).values({ runId, ownerId: 1, agentId: 3, requestId: fixed.requestId,
          registration: receipt.canonical, registrationHash: receipt.hash, registeredAt: new Date(reg.registeredAtMs) });
        for (const phaseStart of [fixed.developmentEndsAtMs, fixed.validationEndsAtMs]) {
          for (const [index, exitBid] of [1.0989, 1.1029].entries()) {
            const barAt = phaseStart + index * bar, at = barAt + 1000;
            const origin = { streamId: randomUUID(), symbol: "R_75" as const, epoch: at / 1000 };
            const quote = { observedAt: new Date(at).toISOString(), bid: 1.1, ask: 1.1001 };
            const baseline = { ...facts.baseline, outcome: "APPROVED" as const, checks: index || options.omitConflictWarning ? [] : facts.baseline.checks,
              agentId: 3, agentKey: "fleet-test", symbol: fixed.symbol, timeframe: "M5" as const, conflictState: "NONE" as const,
              setupExpiresAt: new Date(at + 15_000).toISOString() };
            const challenger = index ? "APPROVED" : "WAIT";
            const evaluateAt = at + 3000, observationKey = `bar:${barAt}`;
            const tape = [quote.bid, quote.bid, exitBid].map((bid, tick) => {
              const offset = [0, 1, 3][tick]!;
              return { ...origin, epoch: origin.epoch + offset, receivedAt: at + offset * 1000,
                releasedAt: at + offset * 1000, bid, ask: tick === 2 ? bid + 0.0001 : quote.ask };
            });
            await db.insert(frames).values(tape);
            const grade = gradeAtiShadowPair({ observedAt: at, source: "deriv_public", symbol: fixed.symbol,
              baseline, challengerOutcome: challenger, assumedCosts: assumptions,
              derivReplay: { origin, quote, rows: await loadAtiDerivReplayQuotes(origin, evaluateAt) } }, evaluateAt);
            assert.ok(grade?.state === "SIMULATED_FILL" && grade.derivReplay?.tapeHash);
            const fleetReceipt = { decisionId: ++nextDecisionId, cycleId: randomUUID(), cycleStartedAt: at - 1,
              version: { engine: "SELF_TRADE_FLEET_DECISION", build, decisionSettingsHash: "d".repeat(64) } };
            if (options.fleet) {
              await pool.query(`INSERT INTO self_trade_decisions (id, agent_id, symbol, side, score_breakdown, cycle_id, agent_key,
                timeframe, setup_type, outcome, reason, handshakes, thesis, conflict_state, setup_expires_at, evaluated_at, created_at)
                VALUES ($1,3,'V75','BUY',$2,$3,'fleet-test','M5',$4,$5,$6,$7,$8,'NONE',$9,$10,$10)`, [
                fleetReceipt.decisionId, { atiFleetDecisionV1: fleetReceipt.version }, fleetReceipt.cycleId, setup, baseline.outcome,
                baseline.reason, JSON.stringify(baseline.checks), baseline.thesis, baseline.setupExpiresAt, new Date(at - 1)]);
            }
            await db.insert(observations).values({ runId, observationKey, observedAt: new Date(at), recordedAt: new Date(at + 1),
              sourceIdentity: "deriv-archive-comparison", coverage: "OBSERVED", setup, baselineOutcome: baseline.outcome,
              challengerOutcome: challenger, evidence: { researchBuild: build, decisionSettingsHash: "d".repeat(64),
                baseline, quote, derivQuoteOrigin: origin, ...(options.fleet ? { fleetReceipt, fleetPriceOrigin: origin,
                  input: { signal: { marketEvidence: { source: "deriv_public", sourceIdentity: "deriv-archive-comparison" } } } } : {}) } });
            await db.insert(outcomes).values({ runId, observationKey, gradeVersion: ATI_DERIV_ARCHIVE_GRADE_VERSION,
              evaluatedAt: new Date(evaluateAt), recordedAt: new Date(evaluateAt + 1), evidence: { ...grade, researchBuild: build } });
          }
        }
        const result = await sealAtiResearch(1, 3, runId);
        assert.ok(result?.status === "SEALED");
        assert.equal(result.result.verdict, "FORWARD_REVIEW_REQUIRED");
        return { runId, ...result };
      }
      await pool.query(`ALTER TABLE self_trade_decisions ADD cycle_id text, ADD agent_key text, ADD timeframe text,
        ADD setup_type text, ADD outcome text, ADD reason text, ADD handshakes jsonb, ADD thesis jsonb, ADD owner_agent_key text,
        ADD conflict_state text, ADD setup_expires_at timestamptz, ADD evaluated_at timestamptz, ADD created_at timestamptz`);
      const nativePrimary = await studyWithQuoteArchive(base - 31 * 86_400_000, undefined, { fleet: true });
      await replaceTestSeal(nativePrimary.runId, { sealedAt: new Date(nativePrimary.registration.gradeCutoffMs + 1) });
      const nativeLink = { runId: nativePrimary.runId, datasetHash: nativePrimary.datasetHash, resultHash: nativePrimary.resultHash };
      const nativeForward = await studyWithQuoteArchive(base - 30 * 86_400_000, nativeLink, { fleet: true });
      const nativeAudit = await readAtiReplication(1, 3, nativePrimary.runId, true);
      assert.equal(nativeAudit?.status, "PASSED_REGISTERED_FORWARD_COMPARISON");
      assert.equal(nativeAudit.comparison.decisionScope, ATI_FLEET_SCOPE);
      assert.equal(nativeAudit.archiveReplay?.forward?.reproduced, 4);
      assert.equal((await registerAtiResearch(1, 3, { ...specFor(nextBar + 16 * 86_400_000, fleetSpec.market),
        costs: nativeForward.registration.spec.costs, replicates: nativeLink })).status, "REPLICATION_IDENTITY_MISMATCH");
      const certified = nativeForward.dataset.observations[0]!;
      const nativeDecisionId = certified.fleetDecision?.decisionId;
      assert.ok(nativeDecisionId);
      await pool.query("UPDATE self_trade_decisions SET outcome='ASSIGNED_TO_ANOTHER' WHERE id=$1", [nativeDecisionId]);
      assert.equal((await replayAtiResearchObservation(1, 3, nativeForward.runId, certified.observationKey))?.status, "FLEET_DECISION_UNVERIFIED");
      const disputed = await readAtiReplication(1, 3, nativePrimary.runId, true);
      assert.deepEqual(disputed?.gaps, ["FORWARD_REPLAY_INCOMPLETE"]);
      assert.equal(disputed?.archiveReplay?.forward?.reproduced, 3);
      const tapePrimary = await studyWithQuoteArchive(base - 7 * 86_400_000);
      await replaceTestSeal(tapePrimary.runId, { sealedAt: new Date(tapePrimary.registration.gradeCutoffMs + 1) });
      const tapeForward = await studyWithQuoteArchive(base - 6 * 86_400_000, {
        runId: tapePrimary.runId, datasetHash: tapePrimary.datasetHash, resultHash: tapePrimary.resultHash });
      assert.equal((await readAtiReplication(1, 3, tapePrimary.runId))?.status, "ARCHIVE_REPLAY_REQUIRED");
      const verified = await readAtiReplication(1, 3, tapePrimary.runId, true);
      assert.equal(verified?.status, "PASSED_REGISTERED_FORWARD_COMPARISON");
      for (const audit of [verified.archiveReplay?.primary, verified.archiveReplay?.forward]) {
        assert.ok(audit?.complete);
        assert.equal(audit.required, 4);
        assert.equal(audit.reproduced, 4);
        assert.equal(audit.sourceDatasetHash, audit.datasetHash);
      }
      assert.deepEqual((await readAtiReplication(1, 3, tapePrimary.runId, true))?.archiveReplay, verified.archiveReplay);
      const wrongVeto = await studyWithQuoteArchive(base - 5 * 86_400_000, undefined, { omitConflictWarning: true });
      const vetoAudit = (await readAtiReplication(1, 3, wrongVeto.runId, true))?.archiveReplay?.primary;
      assert.equal(vetoAudit?.sourceDatasetHash, wrongVeto.datasetHash);
      assert.equal(vetoAudit?.reproduced, 2);
      assert.equal(vetoAudit?.receipts.filter(r => r.status === "CHALLENGER_DECISION_MISMATCH").length, 2);
      assert.equal(vetoAudit?.complete, false);
      // Rehash a changed return in a counterfeit fixture. The quote tape and stored raw-grade witness stay identical.
      const altered = structuredClone(tapeForward.dataset);
      const first = altered.observations[0]!;
      assert.ok(first.evidence?.fill?.pnlWithAssumedCosts);
      first.evidence.fill.pnlWithAssumedCosts.challengerR += 0.5;
      const alteredReceipt = canonicalResearch(altered);
      const alteredResult = evaluateAtiResearch(tapeForward.registration, altered);
      assert.equal(alteredResult.verdict, "FORWARD_REVIEW_REQUIRED");
      await replaceTestSeal(tapeForward.runId, { dataset: alteredReceipt.canonical, datasetHash: alteredReceipt.hash,
        resultHash: canonicalResearch(alteredResult).hash, verdict: alteredResult.verdict });
      assert.equal((await replayAtiResearchObservation(1, 3, tapeForward.runId, first.observationKey))?.status, "ARCHIVE_MISMATCH");
      const changed = await readAtiReplication(1, 3, tapePrimary.runId, true);
      assert.deepEqual(changed?.gaps, ["FORWARD_REPLAY_INCOMPLETE"]);
      assert.equal(changed?.archiveReplay?.forward?.reproduced, 3);
      assert.equal(changed?.archiveReplay?.forward?.sourceDatasetHash, tapeForward.datasetHash);
      assert.equal(changed?.status, "FORWARD_EVIDENCE_INCOMPLETE");
      await replaceTestSeal(tapeForward.runId, { dataset: canonicalResearch(tapeForward.dataset).canonical,
        datasetHash: tapeForward.datasetHash, resultHash: tapeForward.resultHash, verdict: tapeForward.result.verdict });
      // A missing capture changes the denominator even if every remaining fill replays.
      const lateObservation = { runId: tapeForward.runId, observationKey: "gap:late-receipt",
        observedAt: new Date(tapeForward.registration.spec.startsAtMs), recordedAt: new Date(tapeForward.registration.gradeCutoffMs + 1),
        coverage: "NO_OBSERVED_FEED", setup, baselineOutcome: "WAIT", challengerOutcome: "UNOBSERVED", evidence: {} };
      await db.insert(observations).values(lateObservation);
      assert.deepEqual((await readAtiReplication(1, 3, tapePrimary.runId, true))?.archiveReplay, verified.archiveReplay);
      await db.insert(observations).values({ ...lateObservation, observationKey: "gap:omitted-at-cutoff",
        recordedAt: new Date(tapeForward.registration.spec.startsAtMs + 1) });
      const omitted = await readAtiReplication(1, 3, tapePrimary.runId, true);
      assert.deepEqual(omitted?.gaps, ["FORWARD_REPLAY_INCOMPLETE"]);
      assert.equal(omitted?.archiveReplay?.forward?.reproduced, 4);
      assert.notEqual(omitted?.archiveReplay?.forward?.sourceDatasetHash, tapeForward.datasetHash);
      const { guardianComparisonPolicy } = await import("../atiGuardian.js");
      const guardianSpec = atiResearchInput.parse({ ...derivSpec, challengerVersion: guardianComparisonPolicy.version, requestId: randomUUID(),
        costs: { basis: "ASSUMED", assumptions: { adverseSlippagePerFillPriceUnits: 0.01, feePerFillPriceUnits: 0.01 } } });
      const guardianStudy = randomUUID();
      const greg = researchRegistration(guardianStudy, 1, 3, guardianSpec.startsAtMs - 1000, guardianSpec, build);
      const grec = canonicalResearch(greg);
      assert.equal(greg.guardianPolicy?.challengerBreakEvenR, 0.75);
      await db.insert(runs).values({ id: guardianStudy, ownerId: 1, agentId: 3, symbol: guardianSpec.symbol, setup,
        timeframe: atiShadowDefinition.timeframe, baselineVersion: atiShadowDefinition.baselineVersion,
        challengerVersion: guardianComparisonPolicy.version, researchSource: "deriv_public",
        startedAt: new Date(guardianSpec.startsAtMs), endsAt: new Date(guardianSpec.holdoutEndsAtMs), assumedCosts: {adverseSlippagePerFillPriceUnits: 0.01, feePerFillPriceUnits: 0.01} });
      await db.insert(studies).values({ runId: guardianStudy, ownerId: 1, agentId: 3, requestId: guardianSpec.requestId,
        registration: grec.canonical, registrationHash: grec.hash, registeredAt: new Date(greg.registeredAtMs) });
      const [grow] = await db.select().from(observations).where(eq(observations.runId, guardianPilotId));
      const [gout] = await db.select().from(outcomes).where(eq(outcomes.runId, guardianPilotId));
      assert.ok(grow && gout);
      await db.insert(observations).values({ ...grow, runId: guardianStudy, recordedAt: new Date(+grow.observedAt + 1),
        evidence: { ...(grow.evidence as object), researchBuild: build, decisionSettingsHash: "d".repeat(64) } });
      await db.insert(outcomes).values({ ...gout, runId: guardianStudy, recordedAt: new Date(+gout.evaluatedAt + 1),
        evidence: { ...(gout.evidence as object), researchBuild: build } });
      const reproduceGuardian = () => replayAtiResearchObservation(1, 3, guardianStudy, grow.observationKey);
      assert.equal((await reproduceGuardian())?.status, "STUDY_NOT_SEALED");
      assert.equal(await readAtiShadowRun(1, 3, guardianStudy), null);
      const gseal = await sealAtiResearch(1, 3, guardianStudy);
      assert.ok(gseal?.status === "SEALED" && gseal.dataset.observations[0]?.derivReplayProof);
      assert.equal(gseal.result.phases[0]?.guardianCoverage?.settledPairs, 1);
      assert.equal(gseal.result.phases[0]?.base.settledPairs, 1);
      assert.equal(gseal.result.verdict, "INSUFFICIENT_EVIDENCE");
      const alteredGuardianDataset = structuredClone(gseal.dataset);
      alteredGuardianDataset.observations[0]!.evidence!.guardian!.challenger.exit!.assumedNetR = 99;
      const alteredPhase = evaluateAtiResearch(greg, alteredGuardianDataset).phases[0]!;
      assert.equal(alteredPhase.base.settledPairs, 0);
      assert.ok(alteredPhase.evidenceGaps.includes("GUARDIAN_RECEIPT_UNAVAILABLE_OR_CONFLICTING"));
      assert.equal((await reproduceGuardian())?.status, "REPRODUCED");
      assert.equal(await replayAtiResearchObservation(2, 3, guardianStudy, grow.observationKey), null);
      await pool.query("UPDATE ati_deriv_quote_frames SET received_at_ms = received_at_ms - 1 WHERE stream_id = $1 AND epoch = $2",
        [streamId, +derivObservation.observedAt / 1000]);
      assert.equal((await replayDeriv())?.status, "ARCHIVE_MISMATCH");
      assert.deepEqual(await readAtiResearch(1, 3, derivStudyId), derivSeal);
      assert.equal((await reproduceGuardian())?.status, "ARCHIVE_MISMATCH");
      assert.deepEqual(await readAtiResearch(1, 3, guardianStudy), gseal);

      const { ATI_RETEST_CHALLENGER } = await import("../atiCounterargument.js");
      const retestRows = (await db.select().from(observations).where(eq(observations.runId, retestShadowId)))
        .sort((a, b) => +a.observedAt - +b.observedAt);
      const retestGrades = await db.select().from(outcomes).where(eq(outcomes.runId, retestShadowId));
      assert.equal(retestRows.length, 4);
      assert.equal(retestGrades.length, 4);
      const retestStart = Math.floor(+retestRows[0]!.observedAt / bar) * bar - phaseLength;
      const retestShift = retestStart - walkSpec.startsAtMs;
      const retestSpec = atiResearchInput.parse({ ...walkSpec, requestId: randomUUID(), startsAtMs: retestStart,
        developmentEndsAtMs: walkSpec.developmentEndsAtMs + retestShift, validationEndsAtMs: walkSpec.validationEndsAtMs + retestShift,
        holdoutEndsAtMs: walkSpec.holdoutEndsAtMs + retestShift, challengerVersion: ATI_RETEST_CHALLENGER,
        costs: { basis: "ASSUMED", assumptions: { adverseSlippagePerFillPriceUnits: 0.00001, feePerFillPriceUnits: 0.000005 } } });
      assert.equal(retestSpec.costs.basis, "ASSUMED");
      const retestStudyId = randomUUID();
      const retestRegistration = researchRegistration(retestStudyId, 1, 3, retestStart - 1000, retestSpec, build);
      const retestReceipt = canonicalResearch(retestRegistration);
      await db.insert(runs).values({ id: retestStudyId, ownerId: 1, agentId: 3, symbol: retestSpec.symbol, setup,
        timeframe: atiShadowDefinition.timeframe, baselineVersion: atiShadowDefinition.baselineVersion,
        challengerVersion: ATI_RETEST_CHALLENGER, researchSource: "deriv_public",
        startedAt: new Date(retestSpec.startsAtMs), endsAt: new Date(retestSpec.holdoutEndsAtMs), assumedCosts: retestSpec.costs.assumptions });
      await db.insert(studies).values({ runId: retestStudyId, ownerId: 1, agentId: 3, requestId: retestSpec.requestId,
        registration: retestReceipt.canonical, registrationHash: retestReceipt.hash, registeredAt: new Date(retestRegistration.registeredAtMs) });
      await db.insert(observations).values(retestRows.map((row) => ({ ...row, runId: retestStudyId, recordedAt: new Date(+row.observedAt + 1),
        evidence: { ...(row.evidence as object), researchBuild: build, decisionSettingsHash: "d".repeat(64) } })));
      await db.insert(outcomes).values(retestGrades.map((row) => ({ ...row, runId: retestStudyId, recordedAt: new Date(+row.evaluatedAt + 1),
        evidence: { ...(row.evidence as object), researchBuild: build } })));
      const sealedRetests = await sealAtiResearch(1, 3, retestStudyId);
      assert.ok(sealedRetests?.status === "SEALED");
      assert.equal(sealedRetests.result.phases[1]?.base.settledPairs, 3);
      assert.equal(sealedRetests.result.phases[1]?.retestCoverage?.noFills, 1);
      assert.equal(sealedRetests.result.phases[1]?.retestCoverage?.unresolved, 1);
      const replayKey = retestRows[0]!.observationKey;
      const replayedRetest = await replayAtiResearchObservation(1, 3, retestStudyId, replayKey);
      assert.equal(replayedRetest?.status, "REPRODUCED");
      assert.equal(await replayAtiResearchObservation(2, 3, retestStudyId, replayKey), null);
      await pool.query("UPDATE ati_shadow_observations SET evidence = evidence - 'retestPlan' WHERE run_id = $1 AND observation_key = $2",
        [retestStudyId, replayKey]);
      assert.equal((await replayAtiResearchObservation(1, 3, retestStudyId, replayKey))?.status, "ARCHIVE_MISMATCH");
      assert.deepEqual(await readAtiResearch(1, 3, retestStudyId), sealedRetests);

      const { ATI_REGIME_INSTRUMENT_CHALLENGER, atiInstrumentProfile } = await import("../atiRegimeInstrument.js");
      const regimeRows = (await db.select().from(observations).where(eq(observations.runId, regimeShadowId)))
        .sort((a, b) => +a.observedAt - +b.observedAt);
      const regimeGrades = await db.select().from(outcomes).where(eq(outcomes.runId, regimeShadowId));
      assert.equal(regimeRows.length, 4);
      assert.equal(regimeGrades.length, 3);
      const regimeStart = Math.floor(+regimeRows[0]!.observedAt / bar) * bar - phaseLength;
      const regimeShift = regimeStart - walkSpec.startsAtMs;
      const regimeSpec = atiResearchInput.parse({ ...walkSpec, requestId: randomUUID(), startsAtMs: regimeStart,
        developmentEndsAtMs: walkSpec.developmentEndsAtMs + regimeShift, validationEndsAtMs: walkSpec.validationEndsAtMs + regimeShift,
        holdoutEndsAtMs: walkSpec.holdoutEndsAtMs + regimeShift, challengerVersion: ATI_REGIME_INSTRUMENT_CHALLENGER,
        costs: { basis: "ASSUMED", assumptions: { adverseSlippagePerFillPriceUnits: 0.00001, feePerFillPriceUnits: 0.000005 } } });
      assert.equal(regimeSpec.costs.basis, "ASSUMED");
      const regimeStudyId = randomUUID();
      const regimeRegistration = researchRegistration(regimeStudyId, 1, 3, regimeStart - 1000, regimeSpec, build);
      assert.deepEqual(regimeRegistration.instrumentProfile, atiInstrumentProfile("V75"));
      const regimeReceipt = canonicalResearch(regimeRegistration);
      await db.insert(runs).values({ id: regimeStudyId, ownerId: 1, agentId: 3, symbol: regimeSpec.symbol, setup,
        timeframe: atiShadowDefinition.timeframe, baselineVersion: atiShadowDefinition.baselineVersion,
        challengerVersion: ATI_REGIME_INSTRUMENT_CHALLENGER, researchSource: "deriv_public",
        startedAt: new Date(regimeSpec.startsAtMs), endsAt: new Date(regimeSpec.holdoutEndsAtMs), assumedCosts: regimeSpec.costs.assumptions });
      await db.insert(studies).values({ runId: regimeStudyId, ownerId: 1, agentId: 3, requestId: regimeSpec.requestId,
        registration: regimeReceipt.canonical, registrationHash: regimeReceipt.hash, registeredAt: new Date(regimeRegistration.registeredAtMs) });
      await db.insert(observations).values(regimeRows.map((row) => ({ ...row, runId: regimeStudyId, recordedAt: new Date(+row.observedAt + 1),
        evidence: { ...(row.evidence as object), researchBuild: build, decisionSettingsHash: "d".repeat(64) } })));
      await db.insert(outcomes).values(regimeGrades.map((row) => ({ ...row, runId: regimeStudyId, recordedAt: new Date(+row.evaluatedAt + 1),
        evidence: { ...(row.evidence as object), researchBuild: build } })));
      const sealedRegimes = await sealAtiResearch(1, 3, regimeStudyId);
      assert.ok(sealedRegimes?.status === "SEALED");
      const validationRegimes = sealedRegimes.result.phases[1]?.regimeReport;
      assert.equal(validationRegimes?.cohorts.find((r) => r.regime === "TRENDING")?.metrics.settledPairs, 2);
      assert.equal(validationRegimes?.cohorts.find((r) => r.regime === "RANGING")?.metrics.winnersSkipped, 1);
      assert.equal(validationRegimes?.cohorts.find((r) => r.regime === "RANGING")?.measured, false);
      assert.equal(validationRegimes?.transitionValidation?.eligibleTransitions, 2);
      assert.equal(validationRegimes?.transitionValidation?.scoredTransitions, 0, "validation cannot supply its own development sample");
      assert.equal(validationRegimes?.transitionValidation?.modelBrier, null);
      assert.equal(sealedRegimes.result.phases[2]?.regimeReport?.cohorts.find((r) => r.regime === "TRENDING")?.observedBars, 0);
      assert.equal(sealedRegimes.result.verdict, "INSUFFICIENT_EVIDENCE", "measured validation bars cannot fill a holdout gap");

      const differentInstrument = evaluateAtiResearch(sealedRegimes.registration, { ...sealedRegimes.dataset,
        observations: sealedRegimes.dataset.observations.map((row, index) => index === 0 && row.regimeAssessment
          ? { ...row, regimeAssessment: { ...row.regimeAssessment, instrument: atiInstrumentProfile("V75_1S") } } : row),
      });
      assert.equal(differentInstrument.phases[1]?.base.settledPairs, 2);
      assert.ok(differentInstrument.phases[1]?.evidenceGaps.includes("REGIME_RECEIPT_UNAVAILABLE_OR_CONFLICTING"));
      const regimeKey = regimeRows[0]!.observationKey;
      assert.equal((await replayAtiResearchObservation(1, 3, regimeStudyId, regimeKey))?.status, "REPRODUCED");
      await pool.query("UPDATE ati_shadow_observations SET evidence = evidence - 'regimeAssessment' WHERE run_id = $1 AND observation_key = $2",
        [regimeStudyId, regimeKey]);
      assert.equal((await replayAtiResearchObservation(1, 3, regimeStudyId, regimeKey))?.status, "ARCHIVE_MISMATCH");
      assert.deepEqual(await readAtiResearch(1, 3, regimeStudyId), sealedRegimes);
      assert.equal(await readAtiShadowRun(1, 3, historicalId), null);
      assert.equal(await readAtiResearch(2, 3, historicalId), null);
      assert.equal((await listAtiResearch(1, 3, 10)).find((row) => row.registration.runId === historicalId)?.seal?.resultHash, sealed.resultHash);
      await assert.rejects(pool.query("UPDATE ati_shadow_runs SET research_source = NULL WHERE id = $1", [historicalId]),
        /ATI research run definition is immutable/);
      await assert.rejects(pool.query("UPDATE ati_research_seals SET dataset = dataset || ' ' WHERE run_id = $1", [historicalId]),
        /ATI research evidence is append-only/);
      await assert.rejects(pool.query("DELETE FROM ati_research_studies WHERE run_id = $1", [historicalId]),
        /ATI research evidence is append-only/);
      await pool.query("ALTER TABLE ati_research_seals DISABLE TRIGGER ati_research_seals_no_change");
      await db.update(seals).set({ dataset: `${canonicalResearch(sealed.dataset).canonical} ` }).where(eq(seals.runId, historicalId));
      await pool.query("ALTER TABLE ati_research_seals ENABLE TRIGGER ati_research_seals_no_change");
      await assert.rejects(readAtiResearch(1, 3, historicalId), /ATI_RESEARCH_EVIDENCE_INTEGRITY/);
      await pool.query("DELETE FROM users WHERE id = 1");
      assert.equal(await readAtiResearch(1, 3, historicalId), null, "account deletion retains the existing ownership cascade");
    });

    await t.test("owner fleet observations follow committed supervisor decisions, input origins and actual cost coverage", async () => {
      const { ATI_FLEET_BASELINE, activeAtiFleetRuns, fleetInputGap } = await import("../atiFleetShadow.js");
      const { recordAtiFleetObservation } = await import("../atiShadow.js");
      const { observeSelfTradeCandidate } = await import("../decisionEngine.js");
      const { db } = await import("@workspace/db");
      await pool.query("INSERT INTO users (id) VALUES (1)");
      counterargumentCase = null; regimeCase = null;
      const nativePilot = { ...pilot, symbol: "V75", baselineVersion: ATI_FLEET_BASELINE } as const;
      slot = Math.ceil(Date.now() / 300_000) * 300_000;
      let clockAt = slot + 500;
      const clock = mock.method(Date, "now", () => clockAt);
      try {
        dataSource = "LIVE_FEED"; sourceIdentity = "fleet-paper"; quoteOffset = 0;
        const native = await startAtiShadowRun(1, 3, nativePilot);
        assert.ok(native);
        assert.equal(await startAtiShadowRun(2, 3, nativePilot), null);
        assert.equal((await appendAtiShadowObservation(1, 3, native.runId)).status, "PASSIVE_FLEET_CAPTURE");
        const [run] = await activeAtiFleetRuns(1, clockAt);
        assert.ok(run && run.id === native.runId);
        assert.equal((await activeAtiFleetRuns(2, clockAt)).length, 0);
        assert.equal((await readAtiShadowRun(1, 3, native.runId))?.counts.observations, 0);
        const version = { engine: "SELF_TRADE_FLEET_DECISION" as const,
          build: { revision: "a".repeat(40), sourceState: "clean" as const }, decisionSettingsHash: "d".repeat(64) };
        const stream = randomUUID();
        async function nativeInputs() {
          derivQuoteOrigin = { streamId: stream, symbol: "R_75", epoch: slot / 1000 + 1 };
          frame(stream, 1000, 1.1, 1.1001);
          const raw = (await observeSelfTradeCandidate(1, 3, "V75"))!;
          const input = { ...raw.observation.input, agentId: 3, symbol: "V75", currentPrice: 1.10005, htfSignals: [] };
          const captured = { observation: { ...raw.observation, input }, priceOrigin: derivQuoteOrigin };
          const candidate = { ...raw.candidate, symbol: "V75", agentId: 3, timeframe: "M5" };
          return { captured, candidate };
        }
        const first = await nativeInputs();
        const receipt = { cycleStartedAt: clockAt, cycleId: "controlled-fleet-1", decisionId: 123, version };
        clockAt = slot + 1000;
        // A failed native transaction rolls the nested observation back with it.
        await assert.rejects(db.transaction(async tx => {
          await recordAtiFleetObservation(run, first.candidate, first.captured, clockAt, receipt, tx);
          throw Error("controlled rollback");
        }), /controlled rollback/);
        assert.equal((await readAtiShadowRun(1, 3, native.runId))?.counts.observations, 0);
        const save = () => recordAtiFleetObservation(run, first.candidate, first.captured, clockAt, receipt, db);
        const writes = await Promise.all([save(), save()]);
        assert.deepEqual(writes.map(w => w?.status).sort(), ["ALREADY_OBSERVED", "RECORDED"]);
        const before = await readAtiShadowRun(1, 3, native.runId, new Date(clockAt - 1));
        assert.equal(before?.counts.observations, 0);
        const priceMismatch = { ...first.captured, priceOrigin: { ...first.captured.priceOrigin, streamId: randomUUID() } };
        assert.equal(fleetInputGap(priceMismatch, 1, clockAt), "FLEET_PRICE_ORIGIN_UNVERIFIED");
        assert.equal(fleetInputGap(first.captured, 2, clockAt), "PRIMARY_FEED_UNVERIFIED");
        const mixed = { ...first.captured.observation.input, htfSignals: [first.captured.observation.input.signal] };
        assert.equal(fleetInputGap({ ...first.captured, observation: { ...first.captured.observation, input: mixed } }, 1, clockAt),
          "HIGHER_TIMEFRAME_FEED_UNVERIFIED");
        frame(stream, 2000, 1.1, 1.1001);
        frame(stream, 4000, 1.103, 1.1031);
        clockAt = slot + 5000;
        await gradeAtiShadowRun(1, 3, native.runId);
        slot += 300_000;
        const second = await nativeInputs();
        clockAt = slot + 1000;
        const { resolveSupervisor } = await import("@workspace/domain/self-trade");
        const [contested] = resolveSupervisor([
          { ...second.candidate, agentKey: "pilot", rankScore: 60 },
          { ...second.candidate, agentId: 4, agentKey: "other", rankScore: 95 },
        ]).candidates;
        assert.equal(contested?.outcome, "ASSIGNED_TO_ANOTHER");
        const other = { ...receipt, cycleStartedAt: clockAt, decisionId: 124, cycleId: "controlled-fleet-2",
          version: { ...version, decisionSettingsHash: "e".repeat(64) } };
        await recordAtiFleetObservation(run, contested, second.captured, clockAt, other, db);
        slot += 300_000;
        const third = await nativeInputs();
        clockAt = slot + 1000;
        await recordAtiFleetObservation(run, third.candidate, { ...third.captured, priceOrigin: null }, clockAt,
          { ...receipt, decisionId: 125, cycleStartedAt: clockAt, cycleId: "controlled-fleet-3" }, db);
        const report = await readAtiShadowRun(1, 3, native.runId);
        assert.ok(report);
        assert.equal(report.fleetCohorts?.length, 2);
        assert.equal(report.fleetCohorts[0]?.changedDecisions, 1);
        assert.equal(report.fleetCohorts[1]?.eligibleEntries, 0);
        assert.equal(report.observations[0]?.grade?.state, "SIMULATED_FILL", JSON.stringify(report.observations[0]?.grade));
        assert.equal(report.observations[0]?.challengerOutcome, "WAIT");
        assert.equal(report.observations[1]?.challengerOutcome, "ASSIGNED_TO_ANOTHER");
        assert.equal(report.observations[2]?.coverage, "NO_OBSERVED_FEED");
        assert.equal(report.observations[2]?.challengerOutcome, "UNOBSERVED");
        assert.equal(report.counts.paired, 2);
        assert.equal(JSON.stringify(report).includes(stream), false);
        assert.equal(await readAtiShadowRun(2, 3, native.runId), null);
        const { readAtiReplication } = await import("../atiResearchLab.js");
        assert.equal(await readAtiReplication(1, 3, native.runId), null, "a fleet pilot cannot satisfy a registered forward study");
      } finally {
        clock.mock.restore();
      }
    });
  } finally {
    await pool.end();
  }
});
