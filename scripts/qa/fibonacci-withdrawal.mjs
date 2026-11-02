// Actual-Scanner continuation; only DOM controls and the existing read-only observer.
import assert from "node:assert/strict";
import { compareLevels } from "./fibonacci-ownership.mjs";

export function manualDrawings(state) {
  return state.geometry.drawings.filter(d => !d.id.startsWith("fib-preview-"));
}
export function previewGeometry(state) {
  const drawings = state.geometry.drawings.filter(d => d.id.startsWith("fib-preview-"));
  return { drawings, strokes: state.geometry.strokes.filter(s => drawings.some(d => d.id === s.id) && /^Fib \d+(?:\.\d+)?%$/.test(s.label ?? "")) };
}
export function withdrawalSelftest() {
  const manual = { id: "saved", kind: "fibonacci", start: { time: 1, price: 2 } };
  const preview = { id: "fib-preview-pane", kind: "fibonacci" };
  const state = { geometry: { drawings: [manual, preview], strokes: [] } };
  assert.deepEqual(manualDrawings(state), [manual]);
  assert.deepEqual(previewGeometry(state).drawings, [preview]);
  assert.equal(previewGeometry({ geometry: { drawings: [manual], strokes: [] } }).drawings.length, 0);
  return { passed: 3 };
}

export async function runWithdrawal({ page, check, read, frames, close, send, capture, receipts, setStage, fixtures }) {
  const storage = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => /drawing/i.test(k)).sort().map(k => [k, localStorage.getItem(k)])));
  for (const [index, timeframe, role] of [[0, "M1", "primary"], [1, "H1", "comparison"]]) {
    const chart = page.getByTestId("arx-native-chart").nth(index);
    const tools = chart.getByTestId("chart-workbench-tools");
    const region = tools.getByRole("region", { name: "Automatic Fibonacci preview" });
    const activate = async () => {
      await close();
      const button = chart.getByTestId("chart-assistant-activate");
      if (await button.getAttribute("aria-pressed") !== "true") await button.click();
    };
    const before = await read(index), otherBefore = await read(1 - index), saved = await storage();
    const unchanged = async label => {
      const after = await read(index), other = await read(1 - index);
      check(JSON.stringify(manualDrawings(after)) === JSON.stringify(manualDrawings(before)) &&
        JSON.stringify(await storage()) === JSON.stringify(saved), `${role} ${label}: saved annotations byte-identical`, { before: manualDrawings(before), after: manualDrawings(after) });
      check(JSON.stringify(other.geometry.drawings) === JSON.stringify(otherBefore.geometry.drawings) &&
        JSON.stringify(other.data.canonical) === JSON.stringify(otherBefore.data.canonical), `${role} ${label}: other pane untouched`);
      return after;
    };
    const positive = async label => {
      await activate();
      const reply = await send("Preview automatic Fibonacci");
      await close();
      await region.waitFor({ state: "visible" }); await frames();
      const state = await read(index);
      check(reply.includes("Prepared an unaccepted Fibonacci preview") && reply.includes(fixtures[timeframe].marketEvidence.sourceIdentity) &&
        compareLevels(reply, previewGeometry(state)), `${role} ${label}: positive source-owned seven-level preview`, { reply, state });
      return state;
    };
    setStage(`${role}: visible closed-window replacement`);
    await chart.getByRole("button", { name: "Fit history", exact: true }).click(); await frames();
    const preview = await positive("before window change");
    await tools.getByRole("button", { name: "Zoom in chart", exact: true }).click();
    await region.waitFor({ state: "hidden" }); await frames();
    const windowAfter = await read(index);
    check(JSON.stringify(windowAfter.snapshot.range) !== JSON.stringify(preview.snapshot.range) &&
      !previewGeometry(windowAfter).drawings.length &&
      JSON.stringify(windowAfter.data.canonical) === JSON.stringify(before.data.canonical),
    `${role} changed visible window removes preview, not source candles`, { preview: preview.snapshot, after: windowAfter });
    const withdrawn = await send("Explain Fibonacci preview");
    check(withdrawn.includes("There is no current Fibonacci preview") && !withdrawn.includes("0.0%:"),
      `${role} old window cannot produce a current preview explanation`, withdrawn);
    await close(); await unchanged("window withdrawal");
    await capture(`${role}-window-withdrawn`);

    setStage(`${role}: source identity replacement and delayed Keep`);
    await chart.getByRole("button", { name: "Fit history", exact: true }).click(); await frames();
    const sourcePreview = await positive("before identity change");
    // Hold a real DOM send before React receives it. Local Fibonacci dispatch is
    // synchronous, so there is no invented remote/in-flight model response here.
    await page.getByTestId("arx-assistant-trigger").click();
    await page.getByTestId("arx-input").fill("Keep Fibonacci");
    await page.evaluate(() => {
      const button = document.querySelector('[data-testid="arx-send"]');
      window.__heldFibSend = { held: false, released: false, text: document.querySelector('[data-testid="arx-input"]').value };
      button.addEventListener("click", event => {
        event.preventDefault(); event.stopImmediatePropagation();
        window.__heldFibSend.held = true;
      }, { capture: true, once: true });
    });
    await page.getByTestId("arx-send").click();
    check(await page.evaluate(() => window.__heldFibSend.held), `${role} delayed Keep held before local dispatch`);
    await close();
    const oldIdentity = fixtures[timeframe].marketEvidence.sourceIdentity;
    fixtures[timeframe] = structuredClone(fixtures[timeframe]);
    fixtures[timeframe].marketEvidence.sourceIdentity = (index ? "d" : "c").repeat(64);
    // Ordinary query refresh consumes the changed synthetic response. The
    // observer remains read-only, with identical timestamps/OHLC in both sources.
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(async ({ timeframe, identity }) => {
      const log = await window.__readFixtureLog();
      return log.candleResponses.some(r => r.timeframe === timeframe && r.sourceIdentity === identity &&
        log.requests.some(q => q.id === r.requestId && q.fulfilledAt && !q.cancelled));
    }, { timeframe, identity: fixtures[timeframe].marketEvidence.sourceIdentity }, { timeout: 20000 });
    await region.waitFor({ state: "hidden" }); await frames();
    const sourceAfter = await unchanged("identity withdrawal");
    check(!previewGeometry(sourceAfter).drawings.length &&
      JSON.stringify(sourceAfter.data.canonical) === JSON.stringify(sourcePreview.data.canonical) &&
      await chart.getByTestId("chart-assistant-activate").getAttribute("aria-pressed") !== "true",
    `${role} fulfilled identity replacement withdraws preview and selected pane`, { oldIdentity, identity: fixtures[timeframe].marketEvidence.sourceIdentity, sourceAfter });
    const heldText = await page.evaluate(() => window.__heldFibSend.text);
    check(heldText === "Keep Fibonacci", `${role} delayed command retains original text`);
    const delayedReply = await send(heldText);
    await page.evaluate(() => { window.__heldFibSend.released = true; });
    check(/Select a ready|source changed|Select the current chart/.test(delayedReply) &&
      !delayedReply.includes("Fibonacci kept"), `${role} released delayed Keep cannot target replaced or fallback pane`, delayedReply);
    await close(); await unchanged("delayed Keep");
    await activate();
    const currentReply = await send("Explain Fibonacci preview");
    check(currentReply.includes("There is no current Fibonacci preview") && !currentReply.includes(oldIdentity),
      `${role} reselected new source cannot explain old preview`, currentReply);
    await close(); await unchanged("new-source explanation");
    await capture(`${role}-source-withdrawn`);
    receipts.push({ kind: "withdrawal", role, oldIdentity, newIdentity: fixtures[timeframe].marketEvidence.sourceIdentity,
      before, preview, windowAfter, withdrawn, sourcePreview, sourceAfter, delayedReply, currentReply,
      savedStorage: saved, otherBefore, otherAfter: await read(1 - index), after: await read(index) });
  }
}
