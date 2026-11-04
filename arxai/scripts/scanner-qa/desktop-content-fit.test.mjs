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
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const setup = vm.runInNewContext(`(${readFileSync(path.join(repo, "scripts/scanner-qa/shared-chart-setup.js"), "utf8")})`, {
    SCANNER_QA_BASE_URL: origin, SCANNER_QA_START_PATH: "/", SCANNER_QA_PRESERVE_STORAGE_ON_RELOAD: true, URL, setTimeout,
  });
  await setup(page);
  assert.equal(await page.evaluate(() => window.__arxScannerQaBuildId), meta.buildId);
  const results = [];
  // Keep every case's result; assertions happen after the bounded matrix.
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    for (const preset of ["All", "Analyze", "Trade", "Review"]) {
      if (preset !== "All") {
        await page.getByRole("group", { name: "Workspace preset" }).getByRole("button", { name: preset, exact: true }).click();
      } else {
        for (const side of ["left", "right"]) {
          const expand = page.getByRole("button", { name: `Expand ${side} tools`, exact: true });
          if (await expand.count()) await expand.click();
        }
        const collapsedIds = await page.locator(".arx-workspace button[data-testid^='layout-panel-collapse-'][aria-expanded='false']")
          .evaluateAll(buttons => buttons.map(button => button.getAttribute("data-testid")));
        for (const id of collapsedIds) await page.getByTestId(id).click();
      }
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const receipt = await page.evaluate(() => {
        const errors = [];
        const rect = element => element.getBoundingClientRect();
        const main = document.getElementById("main-content");
        const canvas = document.querySelector('[data-testid="arx-native-canvas"]');
        const engine = window.__arxChartQa?.layoutGeometry?.();
        if (!canvas || rect(canvas).height < 390) errors.push("canvas below 390px including axes");
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
  const screenshotDir = path.resolve(repo, "../generated-artifacts/arx-side-rails");
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, "both-rails-desktop.png") });
  await page.getByRole("button", { name: "Review order", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 1, "one-click Review order did not open its existing sheet");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open Order entry", exact: true }).click();
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
  assert.ok(log.blocked.every(item => item.kind === "mutation"), JSON.stringify(log.blocked));
  assert.equal(meta.sourceUnchanged, true);
});
