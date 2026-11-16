// Actual Cockpit/Smart Chart production fixture; all data is synthetic and all
// writes/external/provider/broker traffic is blocked by shared-chart-setup.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const builder = path.join(repo, "scripts/scanner-qa/shared-chart-fixture/build.mjs");
const evidenceDir = path.resolve(repo, "../generated-artifacts/arx-sliding-panels");
function executable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  for (const name of readdirSync("/nix/store").filter(name => /playwright-(?:browsers|chromium)/i.test(name))) {
    for (const version of readdirSync(`/nix/store/${name}`)) {
      for (const bin of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const file = `/nix/store/${name}/${version}/${bin}`;
        if (existsSync(file)) return file;
      }
    }
  }
  throw new Error("No Chromium available");
}

test("actual desktop desk preserves plot, expanded bodies and risk text across presets", { timeout: 300_000 }, async t => {
  const built = spawnSync(process.execPath, [builder], { cwd: repo, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(built.status, 0, built.stderr);
  const marker = built.stdout.lastIndexOf('{\n  "buildId"');
  assert.ok(marker >= 0, built.stdout.slice(-1500));
  const meta = JSON.parse(built.stdout.slice(marker));
  const child = spawn(process.execPath, [builder, `--serve=${meta.buildId}`], { cwd: repo, stdio: "ignore" });
  t.after(() => child.kill("SIGTERM"));
  const origin = "http://127.0.0.1:4199";
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/arx-scanner-qa-build-info.json`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "isolated fixture server failed");
  const browser = await chromium.launch({ executablePath: executable(), headless: true, args: ["--no-sandbox"] });
  mkdirSync(evidenceDir, { recursive: true });
  let page;
  t.after(async () => {
    try {
      if (page && !page.isClosed()) {
        console.log(JSON.stringify({ terminalFixtureLog: await page.evaluate(() => window.__readFixtureLog?.() ?? null) }));
        await page.screenshot({ path: path.join(evidenceDir, "terminal-attempt.png") });
      }
    } finally { await browser.close(); }
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", error => { browserErrors.push(error.message); console.log(JSON.stringify({ browserError: error.message })); });
  const setup = vm.runInNewContext(`(${readFileSync(path.join(repo, "scripts/scanner-qa/shared-chart-setup.js"), "utf8")})`, {
    SCANNER_QA_BASE_URL: origin, SCANNER_QA_START_PATH: "/", SCANNER_QA_PRESERVE_STORAGE_ON_RELOAD: true, URL, setTimeout,
  });
  await setup(page);
  // Explicitly synthetic, non-actionable read, including an unbroken token.
  // The normal Truth gate still decides whether the card may display it.
  const longText = `OFFLINE layout fixture only. ${"Support/resistance explanation with no trading authority. ".repeat(35)} ${"long-token-".repeat(35)}`;
  await context.route("**/api/me/market-edge**", async route => {
    const fields = Object.fromEntries(["whatIsHappening","why","whyThisMarket","whyThisDirection","whyNow","timingState","entryZone","risk","whatConfirms","whatInvalidates","whatToDoNext"].map(key => [key, longText]));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      ok: true,
      signal: { symbol: "EURUSD", displayName: "EURUSD", timeframe: "M15", assetClass: "forex",
        generatedAt: "2026-01-02T12:00:00Z", dataSource: "OFFLINE_FIXTURE", hasSufficientData: false,
        bias: "NEUTRAL", direction: "NONE", regime: "RANGING", lifecycleStage: "WATCH", lifecycleReasons: [],
        confidenceBand: "LOW", edgeScore: 0, scores: { direction:0, entry:0, execution:0, risk:0, newsSafety:0, timing:0, survivability:0, overall:0, edge:0 },
        evidence: { for: [{ key: "fixture", label: longText, weight: 0 }], against: [], conflicts: [], meetsMinimum: false, netScore: 0 },
        freshness: "STALE", late: { isLate: false, doNotChase: true, reason: "Offline fixture" } },
      explanation: { headline: "Offline visual fixture — not a market read", defaultMode: "SIMPLE",
        simple: fields, advanced: fields, levels: null, bestAction: "WAIT", noTrade: { isNoTrade: true, confidence: 0, reason: "Offline only" },
        hasSufficientData: false, actionable: false, missingContext: ["No provider evidence"], disclaimer: "OFFLINE QA ONLY" },
    }) });
  });
  await page.reload();
  assert.equal(await page.evaluate(() => window.__arxScannerQaBuildId), meta.buildId);
  const results = [];
  const dock = async id => {
    const icon = page.locator(`[data-panel-rail-icon="${id}"]`);
    if (await icon.count()) {
      await icon.click();
      await page.locator(`[data-layout-panel="${id}"] .arx-panel-keep-open`).click();
    }
  };
  // Keep every case's result; assertions happen after the bounded matrix.
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    for (const preset of ["All", "Analyze", "Trade", "Review"]) {
      if (preset !== "All") {
        await page.getByRole("group", { name: "Workspace preset" }).getByRole("button", { name: preset, exact: true }).click();
      } else {
        for (const id of ["discovery","heat","clock","eleanor","risk","order","intelligence","positions","chart"]) await dock(id);
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const receipt = await page.evaluate(() => {
        const errors = [];
        const rect = element => element.getBoundingClientRect();
        const main = document.getElementById("main-content");
        const canvas = document.querySelector('[data-testid="arx-native-canvas"]');
        const engine = window.__arxChartQa?.layoutGeometry?.();
        if (!canvas || rect(canvas).height < 390 || rect(canvas).height > innerHeight * .65 + 1) errors.push("canvas outside desktop bounds");
        if (!engine || engine.plot.height < 360) errors.push(`price plot below 360px: ${engine?.plot.height}`);
        for (const panel of document.querySelectorAll(".arx-col > .arx-panel[data-collapsed='false']:not([hidden])")) {
          const body = panel.querySelector(".arx-panel-body");
          if (body && (body.clientHeight + 2 < body.scrollHeight || rect(body).height < 12)) errors.push(`${panel.id} body clipped`);
        }
        const order = document.querySelector("#workspace-order[data-collapsed='false']:not([hidden])");
        if (order) {
          const button = order.querySelector("button[aria-label^='Open reviewed order flow']");
          if (!button || rect(button).height < 30 || rect(button).bottom > rect(order).bottom + 1) errors.push("Review order clipped");
        }
        const clock = document.querySelector("#workspace-clock[data-collapsed='false']:not([hidden])");
        if (clock) {
          const times = clock.querySelectorAll(".arx-clock-compact-times b");
          if (times.length < 3 || [...times].some(time => rect(time).bottom > rect(clock).bottom + 1)) errors.push("clock times clipped");
        }
        const risk = document.querySelector("#workspace-risk[data-collapsed='false']:not([hidden]) .arx-risk-amounts");
        if (risk) {
          const spans = [...risk.children];
          for (const span of spans) if (span.scrollWidth > span.clientWidth + 1) errors.push("risk amount overflow");
          for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
            const a = rect(spans[i]), b = rect(spans[j]);
            if (Math.min(a.right,b.right) - Math.max(a.left,b.left) > 1 && Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top) > 1) errors.push("risk labels overlap");
          }
        }
        const cols = [...document.querySelectorAll(".arx-col")].map(col => rect(col));
        if (Math.max(...cols.map(col => col.bottom)) - Math.min(...cols.map(col => col.bottom)) > 2) errors.push("column fill gap");
        if (document.documentElement.scrollWidth > innerWidth + 1) errors.push("horizontal page overflow");
        return { errors, canvasHeight: canvas ? rect(canvas).height : null, pricePlotHeight: engine?.plot.height,
          mainClientHeight: main.clientHeight, mainScrollHeight: main.scrollHeight };
      });
      const result = { viewport, preset, ...receipt };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const rationaleResults = [];
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("group", { name: "Workspace preset" }).getByRole("button", { name: "Trade", exact: true }).click();
    await dock("eleanor");
    const summary = page.locator(".arx-eleanor-details > summary");
    await summary.waitFor({ state: "visible" });
    for (const open of [false, true]) {
      const details = page.locator(".arx-eleanor-details");
      if (await details.evaluate(element => element.open) !== open) await summary.click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="arx-native-canvas"]');
        const content = document.querySelector(".arx-eleanor-rationale-scroll");
        const left = document.querySelector(".arx-col-left");
        const lastLeft = [...left.querySelectorAll(":scope > .arx-panel:not([hidden])")].at(-1);
        const risk = document.getElementById("workspace-risk"), order = document.getElementById("workspace-order");
        const eleanor = document.getElementById("workspace-eleanor");
        return { canvas: canvas.getBoundingClientRect().height, plot: window.__arxChartQa.layoutGeometry().plot.height,
          rationaleHeight: content.clientHeight, rationaleScrollHeight: content.scrollHeight,
          rationaleWidth: content.clientWidth, rationaleScrollWidth: content.scrollWidth,
          leftGap: left.getBoundingClientRect().bottom - lastLeft.getBoundingClientRect().bottom,
          riskFollowsEleanor: risk.getBoundingClientRect().top >= eleanor.getBoundingClientRect().bottom - 1
            && risk.getBoundingClientRect().top - eleanor.getBoundingClientRect().bottom < 20,
          orderBodyHeight: order.querySelector(".arx-panel-body").clientHeight };
      });
      rationaleResults.push({ viewport, open, ...result });
      console.log(JSON.stringify({ rationaleCase: { viewport, open, ...result } }));
      assert.ok(result.canvas >= 390 && result.canvas <= viewport.height * .65 + 1 && result.plot >= 360);
      assert.ok(Math.abs(result.leftGap) < 2 && result.riskFollowsEleanor && result.orderBodyHeight > 30);
      if (open) {
        assert.ok(result.rationaleHeight <= 320 && result.rationaleScrollHeight > result.rationaleHeight);
        assert.ok(result.rationaleScrollWidth <= result.rationaleWidth + 1, "rationale text overflows horizontally");
      }
      for (const toggle of [page.locator("summary").filter({ hasText: "Chart evidence details" }).first(),
        page.getByRole("button", { name: "Advanced chart details", exact: true })]) {
        await toggle.click();
        const height = await page.locator('[data-testid="arx-native-canvas"]').evaluate(element => element.clientHeight);
        assert.ok(height >= 390 && height <= viewport.height * .65 + 1, "chart escaped bounds after details/settings toggle");
        await toggle.click();
      }
    }
  }
  console.log(JSON.stringify({ rationaleCases: rationaleResults.length, passed: true }));
  const slidingResults = [];
  for (const id of ["discovery","heat","clock","eleanor","risk","order","intelligence","positions","chart"]) await dock(id);
  for (const id of ["discovery","heat","clock","eleanor","risk","order","intelligence","positions","chart","chart-details"]) {
    const panel = page.locator(`[data-layout-panel="${id}"]`);
    if (await panel.getAttribute("data-panel-state") !== "closed") {
      await page.getByTestId(`layout-panel-collapse-${id}`).click();
      await panel.waitFor({ state: "hidden" });
    }
    await page.locator(`[data-panel-rail-icon="${id}"]`).click();
    assert.equal(await panel.getAttribute("role"), "dialog");
    const peek = await panel.evaluate(element => ({ edge: element.dataset.panelEdge,
      animation: getComputedStyle(element).animationName, duration: getComputedStyle(element).animationDuration,
      width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    assert.ok(peek.animation.startsWith("arx-panel-in-") && peek.duration === "0.2s", JSON.stringify(peek));
    assert.ok(peek.width > 200 && peek.height < 1080, JSON.stringify(peek));
    if (id === "order" || id === "chart-details") await page.screenshot({ path: path.join(evidenceDir, `peek-${id}.png`), animations: "disabled" });
    await page.getByTestId("panel-peek-backdrop").click({ position: { x: 5, y: 5 } });
    await panel.waitFor({ state: "hidden" });
    await page.locator(`[data-panel-rail-icon="${id}"]`).click();
    await panel.locator(".arx-panel-keep-open").click();
    await page.waitForFunction(id => document.querySelector(`[data-layout-panel="${id}"]`)?.dataset.panelState === "open", id);
    assert.equal(await page.getByTestId("panel-peek-backdrop").count(), 0);
    assert.ok(await page.evaluate(() => window.__arxChartQa.layoutGeometry().plot.height >= 360));
    slidingResults.push({ id, ...peek, closed: true, peeked: true, docked: true });
  }
  // Secondary chart tools dock into the right area, independently of the plot.
  assert.equal(await page.locator(".arx-col-right [data-layout-panel='chart-details']").count(), 1);
  await page.getByTestId("layout-panel-collapse-chart-details").click();
  await page.locator("[data-layout-panel='chart-details']").waitFor({ state: "hidden" });
  // Both centre panels can close without hiding their subsequent flyouts.
  for (const id of ["chart", "intelligence"]) {
    await page.getByTestId(`layout-panel-collapse-${id}`).click();
    await page.locator(`[data-layout-panel="${id}"]`).waitFor({ state: "hidden" });
  }
  assert.equal(await page.locator(".arx-workspace-grid").getAttribute("data-center-closed"), "true");
  await dock("chart");
  await dock("intelligence");
  assert.ok(await page.evaluate(() => window.__arxChartQa.layoutGeometry().plot.width > 300));
  await page.getByTestId("layout-panel-collapse-intelligence").click();
  await page.locator("[data-layout-panel='intelligence']").waitFor({ state: "hidden" });
  await page.locator('[data-panel-rail-icon="intelligence"]').click();
  await page.reload();
  await page.locator('[data-layout-panel="intelligence"][role="dialog"]').waitFor({ state: "visible" });
  await page.keyboard.press("Control+k");
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
    .some(element => element.getAttribute("data-layout-panel") !== "intelligence" && element.getClientRects().length));
  await page.keyboard.press("Escape");
  assert.equal(await page.locator('[data-layout-panel="intelligence"]').getAttribute("role"), "dialog", "Escape closed two modal layers");
  await page.keyboard.press("Escape");
  await page.locator('[data-layout-panel="intelligence"]').waitFor({ state: "hidden" });
  await dock("intelligence");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId("layout-panel-collapse-positions").click();
  assert.equal(await page.locator('[data-layout-panel="positions"]').getAttribute("data-panel-state"), "closed");
  await page.locator('[data-panel-rail-icon="positions"]').click();
  assert.equal(await page.locator('[data-layout-panel="positions"]').evaluate(element => getComputedStyle(element).animationName), "none");
  await page.locator('[data-layout-panel="positions"] .arx-panel-keep-open').click();
  assert.equal(await page.locator('[data-layout-panel="positions"]').getAttribute("data-panel-state"), "open");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  console.log(JSON.stringify({ slidingResults, persistedPeek: true, escape: true, reducedMotion: true }));
  const routeResults = [];
  for (const pathname of ["/market-scanner", "/my-trades"]) {
    await page.goto(`${origin}${pathname}`);
    const primary = page.locator(".arx-route-panel-area > [data-layout-panel]").first();
    await primary.waitFor({ state: "visible" });
    const id = await primary.getAttribute("data-layout-panel");
    await page.getByTestId(`layout-panel-collapse-${id}`).click();
    await primary.waitFor({ state: "hidden" });
    await page.locator(`[data-panel-rail-icon="${id}"]`).click();
    assert.equal(await primary.getAttribute("role"), "dialog");
    await primary.locator(".arx-panel-keep-open").click();
    await page.getByTestId(`layout-panel-collapse-${id}`).click();
    await primary.waitFor({ state: "hidden" });
    await page.reload();
    await page.locator(`[data-panel-rail-icon="${id}"]`).waitFor({ state: "visible" });
    assert.equal(await primary.evaluate(element => element.hidden), true);
    await dock(id);
    if (pathname === "/market-scanner") {
      await page.locator('[data-panel-rail-icon="chart-details"]').click();
      await page.locator('[data-layout-panel="chart-details"] .arx-panel-keep-open').click();
      assert.equal(await page.locator('[data-panel-details-slot] > [data-layout-panel="chart-details"]').count(), 1);
      await page.getByTestId("layout-panel-collapse-chart-details").click();
      await page.locator('[data-layout-panel="chart-details"]').waitFor({ state: "hidden" });
    }
    const routeLog = await page.evaluate(() => window.__readFixtureLog());
    assert.deepEqual(routeLog.errors, [], pathname);
    routeResults.push({ pathname, id, closed: true, peeked: true, docked: true, reloaded: true });
  }
  console.log(JSON.stringify({ routeResults }));
  await page.goto(`${origin}/`);
  await page.locator('[data-testid="arx-native-canvas"]').waitFor({ state: "visible" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("group", { name: "Workspace preset" }).getByRole("button", { name: "Trade", exact: true }).click();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const width = () => page.locator('[data-testid="arx-native-canvas"]').evaluate(element => element.clientWidth);
  const before = await width();
  await page.getByRole("button", { name: "Collapse left tools", exact: true }).click();
  await settle();
  const left = await width();
  assert.ok(left > before + 100, `left rail failed to give the chart its freed space: ${before} -> ${left}`);
  await page.getByRole("button", { name: "Collapse right tools", exact: true }).click();
  await settle();
  const both = await width();
  assert.ok(both > left + 100, `right rail failed to give the chart its freed space: ${left} -> ${both}`);
  assert.equal(await page.getByText("Emergency Stop", { exact: true }).first().isVisible(), true);
  const resizedPlot = await page.evaluate(() => window.__arxChartQa?.layoutGeometry?.()?.plot);
  assert.ok(resizedPlot && resizedPlot.width >= both - 120 && resizedPlot.height >= 360,
    `chart engine did not resize with its container: ${JSON.stringify(resizedPlot)}`);
  for (const side of ["left", "right"]) {
    const actual = await page.locator(`.arx-side-area[data-side="${side}"]`).evaluate(element => element.getBoundingClientRect().width);
    assert.equal(actual, 50, `${side} rail width`);
  }
  const screenshotDir = evidenceDir;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, "both-rails-desktop.png") });
  await page.getByRole("button", { name: "Review order", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 1, "one-click Review order did not open its existing sheet");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open Order entry", exact: true }).click();
  await page.locator('[data-layout-panel="order"] .arx-panel-keep-open').click();
  await settle();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "workspace-order");
  await page.getByRole("button", { name: "Pin Order entry", exact: true }).click();
  await page.getByRole("button", { name: "Collapse right tools", exact: true }).click();
  assert.equal(await page.locator("#workspace-order").evaluate(element => element.hidden), false, "pinned order was hidden");
  const beforeReloadLog = await page.evaluate(() => window.__readFixtureLog());
  assert.deepEqual(beforeReloadLog.errors, [], "browser errors during chart resize/review");
  await page.reload();
  await page.locator('[data-testid="arx-native-canvas"]').waitFor({ state: "visible" });
  assert.equal(await page.locator(".arx-col-left").getAttribute("data-railed"), "true", "left rail did not persist through reload");
  assert.equal(await page.locator("#workspace-order").evaluate(element => element.hidden), false, "pinned order not restored");
  const expandLeft = page.getByRole("button", { name: "Expand left tools", exact: true });
  await expandLeft.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".arx-col-left").getAttribute("data-railed"), "false", "keyboard expansion failed");
  await page.setViewportSize({ width: 390, height: 844 });
  await settle();
  assert.equal(await page.locator(".arx-side-tools").first().isVisible(), false, "desktop rail controls appeared on mobile");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "mobile horizontal overflow");
  await page.screenshot({ path: path.join(screenshotDir, "mobile-focus.png") });
  console.log(JSON.stringify({ sideRails: "passed", chartWidths: { before, left, both }, screenshots: screenshotDir }));
  const log = await page.evaluate(() => window.__readFixtureLog());
  console.log(JSON.stringify({ buildId: meta.buildId, cases: results.length, errors: log.errors, blocked: log.blocked }));
  assert.equal(results.filter(result => result.errors.length).length, 0, JSON.stringify(results.filter(result => result.errors.length)));
  assert.deepEqual(log.errors, []);
  assert.deepEqual(browserErrors, []);
  assert.ok(log.blocked.every(item => item.kind === "mutation"), JSON.stringify(log.blocked));
  assert.equal(meta.sourceUnchanged, true);
});
