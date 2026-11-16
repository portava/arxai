// Offline acceptance only. Imports no application/API runtime.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { runWithdrawal, withdrawalSelftest } from "./fibonacci-withdrawal.mjs";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const EVIDENCE = path.join(ROOT, "generated-artifacts/arx-historical-fibonacci-validation");
export const SOURCE = "e4bbba1e2bdccda166566892d0e7600a4bea8cf4";
export const BUILD = "28ccd598d091581c";
export const RATIOS = [0, 23.6, 38.2, 50, 61.8, 78.6, 100];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const rounded = value => Number(value.toPrecision(7));
export const levels = text => [...text.matchAll(/(?:^|[;\s])(\d+(?:\.\d+)?)%:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi)]
  .map(m => ({ ratio: Number(m[1]), price: Number(m[2]) }));
export function geometryLevels(geometry) {
  const drawings = geometry?.drawings?.filter(d => d.kind === "fibonacci") ?? [];
  const labels = (geometry?.strokes ?? []).filter(s => /^Fib \d+(?:\.\d+)?%$/.test(s.label ?? ""))
    .map(s => Number(s.label.slice(4, -1)));
  if (drawings.length !== 1 || labels.length !== 7 || new Set(labels).size !== 7) return [];
  const { start, end } = drawings[0];
  if (!start || !end || !Number.isFinite(start.price) || !Number.isFinite(end.price)) return [];
  return RATIOS.filter(r => labels.includes(r)).map(r => ({ ratio: r, price: start.price + (end.price - start.price) * (r / 100) }));
}
export function compareLevels(text, geometry) {
  const a = levels(text), b = geometryLevels(geometry);
  return a.length === 7 && b.length === 7 && new Set(a.map(x => x.ratio)).size === 7 &&
    RATIOS.every(r => a.filter(x => x.ratio === r).length === 1 &&
      a.find(x => x.ratio === r).price === rounded(b.find(x => x.ratio === r).price));
}
export function fixture(timeframe) {
  const primary = timeframe === "M1", step = primary ? 60 : 3600, source = "mt5_broker";
  const candles = Array.from({ length: 160 }, (_, i) => {
    const close = (primary ? 100 : 200) + Math.sin(i / (primary ? 5 : 7)) * (primary ? 4 : 9);
    return { symbol: "EURUSD", timeframe, source, sourceMode: "live",
      openTime: new Date(Date.UTC(2026, 0, 1) + i * step * 1000).toISOString(),
      closeTime: new Date(Date.UTC(2026, 0, 1) + (i + 1) * step * 1000).toISOString(),
      open: close - .1, high: close + .3, low: close - .3, close,
      priceBasis: "BID", priceBasisEvidence: { kind: "producer_declared", basis: "BID", reason: null },
      timeBasisEvidence: { kind: "original_utc", basis: "UTC", authority: "offline:utc-clock-fixture-v1", reason: null },
      isComplete: true, isFinal: true, isForming: false, qualityFlags: [] };
  });
  return { symbol: "EURUSD", displaySymbol: "EURUSD", timeframe, source, quality: "clean", aiUsable: false,
    requestedLimit: 200, candleCount: candles.length, candles,
    feedStatus: { symbol: "EURUSD", source, quality: "clean", isLive: false, stale: true, aiUsable: false,
      warning: "OFFLINE QA — synthetic qualified fixture; not provider data" },
    marketEvidence: { symbol: "EURUSD", timeframe, source, sourceIdentity: (primary ? "a" : "b").repeat(64),
      lastClosedCandleAt: candles.at(-1).closeTime } };
}
export function fixtureQualified(data) {
  const e = data.marketEvidence;
  return !!e && e.symbol === data.symbol && e.timeframe === data.timeframe &&
    e.source === data.source && e.source === data.feedStatus.source &&
    !["invalid", "empty", "unavailable"].includes(data.quality) &&
    /^[ab]{64}$/.test(e.sourceIdentity) && data.candles.length === 160 &&
    data.candles.every((c, i) => c.symbol === data.symbol && c.timeframe === data.timeframe &&
      c.source === e.source && c.sourceMode === "live" && c.isComplete && c.isFinal && !c.isForming &&
      !c.qualityFlags.length && [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
      c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) &&
      (!i || c.openTime === data.candles[i - 1].closeTime)) &&
    e.lastClosedCandleAt === data.candles.at(-1).closeTime;
}
export function omittedObservationFixture(timeframe) {
  const original = fixture(timeframe), omittedIndex = 80;
  const canonical = original.candles.map(c => ({
    time: Date.parse(c.openTime) / 1000, open: c.open, high: c.high, low: c.low, close: c.close,
  }));
  return { original, omittedIndex, omitted: canonical[omittedIndex],
    installed: canonical.filter((_, index) => index !== omittedIndex) };
}
export function omittedObservationSelftest() {
  for (const timeframe of ["M1", "H1"]) {
    const f = omittedObservationFixture(timeframe);
    assert(fixtureQualified(f.original));
    assert(f.original.candles[f.omittedIndex].isFinal && f.original.candles[f.omittedIndex].isComplete);
    assert(f.installed.length === 159 && f.installed[0].time < f.omitted.time && f.installed.at(-1).time > f.omitted.time);
    assert(!f.installed.some(c => c.time === f.omitted.time));
    assert.deepEqual(f.installed, f.original.candles.filter((_, i) => i !== f.omittedIndex).map(c => ({
      time: Date.parse(c.openTime) / 1000, open: c.open, high: c.high, low: c.low, close: c.close,
    })));
  }
  const refusal = "No new Fibonacci added: source observations omitted";
  assert.equal(freshAssistantReply({ old: [refusal], texts: [refusal] }), undefined);
  assert.equal(freshAssistantReply({ old: [refusal], texts: [refusal, refusal] }), refusal);
  assert.equal(freshAssistantReply({ old: ["Welcome to the chart assistant", refusal], texts: [refusal, refusal] }), refusal);
  return { passed: 13, omittedIndex: 80, originalCount: 160, installedCount: 159 };
}

// Count occurrences, not just novel wording: two panes can refuse identically.
// Per-text counts also tolerate a disappearing welcome card.
export function freshAssistantReply({ old, texts }) {
  texts ??= [...document.querySelectorAll('[data-testid="arx-assistant-panel"] div.flex.justify-start > div')]
    .filter(b => !b.querySelector('[data-testid="eleanor-tool-indicator"]')).map(b => b.innerText);
  return texts.findLast(t => t.length > 20 && !/^(Eleanor|Eleanor) is (thinking|reviewing|working|using)/i.test(t) &&
    texts.filter(s => s === t).length > old.filter(s => s === t).length);
}

// Fault injection only, not an observer extension or an alternate calculator.
// Find the actual workbench's adapter through React's DOM ownership link.
// Fail closed if that private test seam changes. Never edit source evidence,
// observer methods, proposal callbacks, drawings, bundle bytes or return values.
export function omitInstalledObservation({ index, expected, omittedIndex }) {
  const element = document.querySelectorAll('[data-testid="chart-workbench-tools"]')[index];
  const key = element && Object.keys(element).find(k => k.startsWith("__reactFiber$"));
  let fiber = key && element[key], adapter;
  while (fiber) {
    if (fiber.memoizedProps?.adapter?.setCandles) { adapter = fiber.memoizedProps.adapter; break; }
    fiber = fiber.return;
  }
  if (!adapter || JSON.stringify(window.__arxChartQa.data(index).canonical) !== JSON.stringify(expected))
    throw Error("Negative fixture requires the exact original installed adapter window");
  if (!(omittedIndex > 0 && omittedIndex < adapter.candles.length - 1))
    throw Error("Negative fixture must omit an interior observation");
  adapter.setCandles(adapter.candles.filter((_, i) => i !== omittedIndex));
  return { seam: "actual workbench adapter.setCandles through React DOM ownership", omittedIndex };
}
export function selftest() {
  const drawing = { kind: "fibonacci", start: { time: 60, price: 104.28140441964624 }, end: { time: 120, price: 95.7040727802122 } };
  const geometry = { drawings: [drawing], strokes: RATIOS.map(r => ({ label: `Fib ${r.toFixed(1)}%`, start: { x: 10, y: 20 }, end: { x: 90, y: 20 } })) };
  const receipt = geometryLevels(geometry).map(x => `${x.ratio.toFixed(1)}%: ${rounded(x.price)}`).join("; ");
  assert(compareLevels(receipt, geometry));
  assert(compareLevels(receipt.replace("50.0%", "50%"), geometry));
  assert(!compareLevels(receipt.replace(/0.0%: [^;]+/, "0.0%: 999"), geometry));
  assert(!compareLevels(receipt.replace("50.0%", "51.0%"), geometry));
  assert(!compareLevels(`${receipt}; 0%: 104.2814`, geometry));
  assert(!compareLevels(receipt.split("; ").slice(1).join("; "), geometry));
  assert(!compareLevels(receipt, { ...geometry, drawings: [] }));
  assert(!compareLevels(receipt, { ...geometry, strokes: geometry.strokes.slice(1) }));
  for (const tf of ["M1", "H1"]) {
    const f = fixture(tf);
    assert(fixtureQualified(f));
    assert(!fixtureQualified({ ...f, marketEvidence: { ...f.marketEvidence, source: undefined } }));
  }
  return { passed: 12, ratios: RATIOS, pricePrecision: "seven significant digits; no arbitrary numeric tolerance" };
}

// Executed inside the browser by Playwright: existing observer only.
export function projectedStrokes(index) {
  const qa = window.__arxChartQa, g = qa?.drawingGeometry(index), s = qa?.snapshot(index);
  const d = g?.drawings?.find(d => d.kind === "fibonacci");
  if (!d?.end || !s?.bounds) return null;
  return { bounds: s.bounds, strokes: g.strokes.filter(x => /^Fib \d+(?:\.\d+)?%$/.test(x.label ?? "")).map(stroke => {
    const ratio = Number(stroke.label.slice(4, -1));
    const price = d.start.price + (d.end.price - d.start.price) * ratio / 100;
    return { ...stroke, ratio, price, a: qa.anchorCoordinates(d.start.time, price, index), b: qa.anchorCoordinates(d.end.time, price, index) };
  }) };
}
export function projectionMatches(projection) {
  const rows = projection?.strokes ?? [], bounds = projection?.bounds;
  return rows.length === 7 && new Set(rows.map(x => x.ratio)).size === 7 &&
    RATIOS.every(r => rows.some(x => x.ratio === r)) && rows.every(s =>
      [s.start, s.end, s.a, s.b].every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y)) &&
      Math.abs(s.end.x - s.start.x) > 1 && Math.abs(s.end.y - s.start.y) <= .5 &&
      Math.abs(s.start.x + bounds.x - s.a.x) <= 1.5 && Math.abs(s.end.x + bounds.x - s.b.x) <= 1.5 &&
      Math.abs(s.start.y + bounds.y - s.a.y) <= 1.5 && Math.abs(s.end.y + bounds.y - s.b.y) <= 1.5);
}

export async function run(page, output, { withdrawal = false, omittedObservation = false } = {}) {
  const checks = [], receipts = [], screenshots = [], errors = [];
  let stage = "offline preflight", network, build, sourceHashes;
  const check = (pass, label, details) => { checks.push({ pass: !!pass, label, details }); assert(pass, label); };
  const read = i => page.evaluate(i => ({ snapshot: window.__arxChartQa?.snapshot(i), data: window.__arxChartQa?.data(i), geometry: window.__arxChartQa?.drawingGeometry(i) }), i);
  const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const capture = async name => { const file = path.join(output, `${name}.png`); await page.screenshot({ path: file }); screenshots.push(file); };
  const close = async () => { const panel = page.getByTestId("arx-assistant-panel"); if (await panel.isVisible()) await panel.getByRole("button", { name: "Close", exact: true }).click(); };
  async function send(text) {
    const panel = page.getByTestId("arx-assistant-panel"), bubbles = panel.locator("div.flex.justify-start > div");
    if (!await panel.isVisible()) await page.getByTestId("arx-assistant-trigger").click();
    const old = await bubbles.allInnerTexts();
    await page.evaluate(() => {
      window.__fibPriorReplies = new WeakSet(document.querySelectorAll('[data-testid="arx-assistant-panel"] div.flex.justify-start > div'));
    });
    await page.getByTestId("arx-input").fill(text);
    await page.getByTestId("arx-send").click();
    let reply;
    if (omittedObservation) {
      const fresh = await page.waitForFunction(freshAssistantReply, { old }, { timeout: 15000 });
      await frames();
      reply = await fresh.jsonValue();
      await fresh.dispose();
    } else {
      await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="arx-assistant-panel"] div.flex.justify-start > div')]
        .some(b => b.innerText.length > 20 && !window.__fibPriorReplies.has(b) && !b.querySelector('[data-testid="eleanor-tool-indicator"]') &&
          !/^(Eleanor|Eleanor) is (thinking|reviewing|working|using)/i.test(b.innerText)), null, { timeout: 15000 });
      await frames();
      reply = await page.evaluate(() => [...document.querySelectorAll('[data-testid="arx-assistant-panel"] div.flex.justify-start > div')]
        .filter(b => !window.__fibPriorReplies.has(b)).map(b => b.innerText)
        .findLast(t => t.length > 20 && !/^(Eleanor|Eleanor) is (thinking|reviewing|working|using)/i.test(t)));
    }
    receipts.push({ stage, text, reply }); return reply;
  }
  await fs.mkdir(output, { recursive: true });
  page.on("pageerror", e => errors.push(String(e)));
  try {
    check(selftest().passed === 12, "Actual parser/comparator and fixture positive/negative selftests");
    const scratch = path.join(EVIDENCE, "scratch/arxai");
    const manifest = JSON.parse(await fs.readFile(path.join(EVIDENCE, "scratch-source-manifest.json")));
    sourceHashes = {};
    for (const f of ["lib/chart-engine/chartAppliedWindow.ts", "lib/chart-engine/chartAutoFibonacci.ts", "lib/chart-engine/chartFibonacciExplanation.ts", "components/charts/ChartWorkbenchTools.tsx", "lib/chart-engine/smartChartCapture.ts"].map(f => `artifacts/trading-dashboard/src/${f}`).concat("scripts/chart-qa/witness.ts")) {
      const saved = hash(await fs.readFile(path.join(scratch, f)));
      sourceHashes[f] = { saved, current: hash(await fs.readFile(path.join(ROOT, "arxai", f))) };
      check(saved === manifest.sourceHashes[f], `Saved source hash: ${f}`, sourceHashes[f]);
    }
    check(manifest.sourceHead === SOURCE, "Saved combined source head");
    const setup = await fs.readFile(path.join(ROOT, "arxai/scripts/scanner-qa/shared-chart-setup.js"), "utf8");
    check(hash(setup) === "2da6efde889d39b4edae1378da141adb025452bf987f20009054aedbf193a78d", "Pinned shared offline boundary");
    const fixtures = { M1: fixture("M1"), H1: fixture("H1") };
    check(Object.values(fixtures).every(fixtureQualified), "Actual synthetic response envelopes satisfy source gates");
    await new Function("SCANNER_QA_HOOKS", "SCANNER_QA_BASE_URL", `return (${setup})`)({
      initialSource: "mt5_broker", initialIdentity: "a".repeat(64),
      candleMetadata: () => ({ fixtureVariant: "qualified", fixtureOnly: true }),
      candleResponse: ({ symbol, timeframe, fallback }) => symbol === "EURUSD" && fixtures[timeframe] || fallback,
    }, "http://127.0.0.1:4199")(page);
    const phone = output.includes("phone");
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 1100 });
    await page.getByTestId("scanner-chart-panel").waitFor();
    build = await page.evaluate(async () => {
      const m = await (await fetch("/arx-scanner-qa-build-info.json")).json(), bad = [];
      for (const [f, expected] of Object.entries(m.hashes)) {
        const r = await fetch(`/${f}`), bytes = await r.arrayBuffer();
        const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
        if (!r.ok || actual !== expected) bad.push(f);
      }
      return { ...m, bad, runtimeBuild: window.__arxScannerQaBuildId };
    });
    check(build.buildId === BUILD && build.runtimeBuild === BUILD && build.source.head === SOURCE &&
      build.sourceUnchanged && !build.source.status && build.productionRuntimeChecked &&
      !build.diagnosticOnly && !build.reactProfiling && !build.bad.length, "Pinned clean actual-App build; every served asset matches", { assetCount: Object.keys(build.hashes).length });
    await close();
    await page.getByRole("button", { name: "Two charts", exact: true }).click();
    await page.getByTestId("comparison-chart").waitFor();
    check(await page.getByTestId("arx-native-chart").count() === 2, "Actual two-pane Scanner layout");
    for (const [index, timeframe, role] of [[0, "M1", "primary"], [1, "H1", "comparison"]]) {
      stage = `${role}: qualified selected ownership`;
      const chart = page.getByTestId("arx-native-chart").nth(index), otherIndex = 1 - index;
      await close();
      await chart.getByTestId(`arx-native-tf-${timeframe}`).click();
      await page.waitForFunction(({ index, seconds }) => window.__arxChartQa?.snapshot(index)?.intervalSeconds === seconds &&
        window.__arxChartQa?.snapshot(index)?.barCount === 160, { index, seconds: timeframe === "M1" ? 60 : 3600 }, { timeout: 15000 });
      await chart.getByRole("button", { name: "Fit history", exact: true }).click(); await frames();
      const before = await read(index), otherBefore = await read(otherIndex), identity = fixtures[timeframe].marketEvidence.sourceIdentity;
      const log = await page.evaluate(() => window.__readFixtureLog());
      const response = log.candleResponses.findLast(r => r.timeframe === timeframe && r.sourceIdentity === identity);
      const request = log.requests.find(r => r.id === response?.requestId);
      check(!!response && request?.status === 200 && !!request.fulfilledAt && !request.cancelled &&
        JSON.stringify(response.canonical) === JSON.stringify(before.data.canonical), `${role} exact installed canonical data matches fulfilled qualified response`, { response, request });
      const activate = chart.getByTestId("chart-assistant-activate");
      if (await activate.getAttribute("aria-pressed") !== "true") await activate.click();
      const context = await chart.getByTestId("chart-assistant-pane-context").innerText();
      check(context.includes(`EURUSD · ${timeframe}`) && context.includes("Selected for local chart tools") &&
        context.includes(index ? "analysis only; primary trading unchanged" : "primary chart"), `${role} explicitly selected pane context`, context);
      const tools = chart.getByTestId("chart-workbench-tools"), toggle = tools.getByRole("button", { name: "Chart tools", exact: true });
      if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      check(await tools.getByRole("button", { name: "Objects (0)", exact: true }).count() === 1, `${role} no owned drawing before preview`);
      stage = `${role}: preview`;
      const previewReply = await send("Preview automatic Fibonacci");
      check(previewReply.includes("Prepared an unaccepted Fibonacci preview") && previewReply.includes(`selected EURUSD ${timeframe} chart`) &&
        previewReply.includes(identity) && !/primary chart/i.test(previewReply), `${role} local preview reply owns selected source`, previewReply);
      check(previewReply.includes("160 closed bars") && previewReply.includes("Prices use the chart reader") &&
        previewReply.includes("not reversal probabilities or price targets") && previewReply.includes("Time labels preserve chart source coordinates") &&
        previewReply.includes("does not independently establish their UTC clock provenance"), `${role} window, precision, non-forecast and source-clock caveats`);
      await close();
      await tools.getByRole("region", { name: "Automatic Fibonacci preview" }).waitFor({ state: "visible" });
      await frames();
      const preview = await read(index), projection = await page.evaluate(projectedStrokes, index);
      check(compareLevels(previewReply, preview.geometry), `${role} all seven semantic ratios/prices match installed anchors`, { levels: levels(previewReply), geometry: preview.geometry });
      check(projectionMatches(projection), `${role} seven rendered lines match anchor price projections`, projection);
      const drawing = preview.geometry.drawings.find(d => d.kind === "fibonacci");
      check(drawing.locked && !drawing.fibonacciOrigin &&
        before.data.canonical.some(c => c.time === drawing.start.time && (c.low === drawing.start.price || c.high === drawing.start.price)) &&
        before.data.canonical.some(c => c.time === drawing.end.time && (c.low === drawing.end.price || c.high === drawing.end.price)),
      `${role} preview anchors are original source extremes; unaccepted and locked`, drawing);
      check(await tools.getByRole("button", { name: "Objects (0)", exact: true }).count() === 1, `${role} preview does not automatically Keep`);
      await capture(`${role}-preview`);
      stage = `${role}: explicit Keep and selected manual`;
      await tools.getByRole("button", { name: "Keep and edit Fibonacci", exact: true }).click();
      const selected = tools.getByRole("button", { name: "Select drawing 1", exact: true });
      await selected.waitFor(); await frames();
      const kept = await read(index), keptDrawing = kept.geometry.drawings.find(d => d.kind === "fibonacci");
      check(await selected.getAttribute("aria-pressed") === "true" && !keptDrawing.locked &&
        keptDrawing.fibonacciOrigin?.sourceIdentity === identity &&
        JSON.stringify(keptDrawing.start) === JSON.stringify(drawing.start) && JSON.stringify(keptDrawing.end) === JSON.stringify(drawing.end),
      `${role} explicit Keep creates selected editable drawing with unchanged anchors/provenance`, keptDrawing);
      const manualReply = await send("Explain selected Fibonacci");
      check(manualReply.includes(`Selected manual Fibonacci drawing on the selected EURUSD ${timeframe} chart`) &&
        manualReply.includes(identity) && manualReply.includes("not revalidated as current advice") &&
        manualReply.includes("not independently proven UTC provenance") && compareLevels(manualReply, kept.geometry),
      `${role} selected manual explanation preserves seven numeric levels and archived provenance`, manualReply);
      await close(); await frames();
      const after = await read(index), otherAfter = await read(otherIndex);
      check(JSON.stringify(after.data.canonical) === JSON.stringify(before.data.canonical) &&
        JSON.stringify(after.geometry.drawings) === JSON.stringify(kept.geometry.drawings) &&
        await selected.getAttribute("aria-pressed") === "true", `${role} explanation changes neither drawing nor canonical candles`);
      check(JSON.stringify(otherAfter.geometry.drawings) === JSON.stringify(otherBefore.geometry.drawings) &&
        JSON.stringify(otherAfter.data.canonical) === JSON.stringify(otherBefore.data.canonical), `${role} commands leave other pane drawings and candles unchanged`);
      await capture(`${role}-kept-manual`);
      receipts.push({ role, identity, context, before, preview, kept, after, projection, otherBefore, otherAfter });
    }
    if (withdrawal) {
      check(withdrawalSelftest().passed === 3, "Withdrawal observer partition selftests");
      await runWithdrawal({ page, check, read, frames, close, send, capture, receipts, fixtures,
        setStage: next => { stage = next; } });
    }
    if (omittedObservation) {
      check(omittedObservationSelftest().passed === 13, "Negative fixtures and duplicate-refusal detection selftests");
      for (const [index, timeframe, role] of [[0, "M1", "primary"], [1, "H1", "comparison"]]) {
        stage = `${role}: omitted interior source observation`;
        await close();
        const chart = page.getByTestId("arx-native-chart").nth(index);
        const activate = chart.getByTestId("chart-assistant-activate");
        if (await activate.getAttribute("aria-pressed") !== "true") await activate.click();
        const tools = chart.getByTestId("chart-workbench-tools");
        const f = omittedObservationFixture(timeframe), original = await read(index), otherBefore = await read(1 - index);
        const log = await page.evaluate(() => window.__readFixtureLog());
        const response = log.candleResponses.findLast(r => r.timeframe === timeframe &&
          r.sourceIdentity === f.original.marketEvidence.sourceIdentity);
        const request = log.requests.find(r => r.id === response?.requestId);
        check(fixtureQualified(f.original) && request?.status === 200 && !!request.fulfilledAt && !request.cancelled &&
          JSON.stringify(response.canonical) === JSON.stringify(original.data.canonical) &&
          response.canonical.some(c => JSON.stringify(c) === JSON.stringify(f.omitted)),
        `${role} fulfilled qualified original evidence includes interior closed observation`, { response, request, omitted: f.omitted });
        check(original.geometry.drawings.length === 1 && !!original.geometry.drawings[0].fibonacciOrigin,
          `${role} negative starts with an explicitly kept drawing`);
        const injection = await page.evaluate(omitInstalledObservation, { index, expected: original.data.canonical, omittedIndex: f.omittedIndex });
        await frames();
        const mismatched = await read(index);
        check(JSON.stringify(mismatched.data.canonical) === JSON.stringify(f.installed) &&
          mismatched.snapshot.barCount === 159 && !mismatched.data.display.some(c => c.time === f.omitted.time) &&
          mismatched.data.display.length === 159 &&
          mismatched.data.canonical[0].time < f.omitted.time && mismatched.data.canonical.at(-1).time > f.omitted.time,
        `${role} existing observer proves interior omission in installed canonical and displayed window`, { injection, mismatched });
        check(JSON.stringify(mismatched.geometry.drawings) === JSON.stringify(original.geometry.drawings),
          `${role} injection does not alter kept drawings`);
        const reply = await send("Preview automatic Fibonacci");
        check(reply.includes("The displayed chart omits source observations in this window; automatic drawings are withheld.") &&
          !reply.includes("Prepared an unaccepted Fibonacci preview"),
        `${role} actual local assistant refuses specifically for omitted source observations`, reply);
        await close(); await frames();
        const after = await read(index), otherAfter = await read(1 - index);
        check(await tools.getByRole("region", { name: "Automatic Fibonacci preview" }).count() === 0 &&
          after.geometry.drawings.length === 1 &&
          JSON.stringify(after.geometry.drawings) === JSON.stringify(original.geometry.drawings) &&
          after.geometry.strokes.filter(s => /^Fib \d+(?:\.\d+)?%$/.test(s.label ?? "")).length === 7 &&
          await tools.getByRole("button", { name: "Objects (1)", exact: true }).count() === 1,
        `${role} refusal installs no automatic preview and preserves the kept drawing`);
        check(JSON.stringify(after.data) === JSON.stringify(mismatched.data) &&
          after.snapshot.dataRevision === mismatched.snapshot.dataRevision,
        `${role} refusal does not rewrite or repair installed candles`);
        check(JSON.stringify(otherAfter.data) === JSON.stringify(otherBefore.data) &&
          JSON.stringify(otherAfter.geometry.drawings) === JSON.stringify(otherBefore.geometry.drawings),
        `${role} negative command preserves the other pane candles and drawings`);
        await capture(`${role}-omitted-observation-rejected`);
        receipts.push({ negative: "omitted-interior-closed-observation", role, timeframe, originalEvidence: f.original,
          omitted: f.omitted, injection, original, mismatched, reply, after, otherBefore, otherAfter });
      }
    }
    stage = "completed ownership; offline boundary";
    network = await page.evaluate(() => window.__readFixtureLog());
    check(!errors.length && !network.errors.length, "No browser page exceptions", errors);
    check(network.requests.filter(r => r.method !== "GET").every(r => r.status === 503) &&
      network.blocked.every(x => x.kind === "mutation" && x.status === 503), "All mutations blocked; no external/WebSocket attempts", network.blocked);
    return { checks, receipts, screenshots, network, errors, build, sourceHashes, stage, unfinished: false,
      strictKnownBackgroundAllowlist: network.requests.filter(r => r.method !== "GET").every(r =>
        ["/api/me/activity-ping", "/api/me/chart/ai-alerts/scan", "/api/me/scalp/focus"].includes(r.path)),
      limitations: [...(omittedObservation ? [] : ["Omitted-observation rejection automated only; no browser negative fixture."]),
        "No performance/parity or current-checkout/provider acceptance."],
      source: SOURCE, buildId: BUILD, viewport: page.viewportSize() };
  } catch (error) {
    try { network = await page.evaluate(() => window.__readFixtureLog()); } catch {}
    try { await capture("failure"); } catch {}
    const dom = await page.content().catch(() => null);
    return { checks, receipts, screenshots, network, errors, build, sourceHashes, stage, unfinished: true, dom,
      error: String(error.stack ?? error), source: SOURCE, buildId: BUILD, viewport: page.viewportSize() };
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(selftest()));
}
