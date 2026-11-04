// Synthetic DOM geometry regression using the shipped styles. No app/API,
// account data, network providers, orders, or authentication are involved.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { chromium } from "playwright";

function browserPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  for (const root of readdirSync("/nix/store").filter(name => /playwright-(?:browsers|chromium)/i.test(name))) {
    for (const version of readdirSync(`/nix/store/${root}`)) {
      for (const binary of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const file = `/nix/store/${root}/${version}/${binary}`;
        if (existsSync(file)) return file;
      }
    }
  }
  throw new Error("Chromium is required; this check must not silently skip.");
}
const css = [
  "../../artifacts/trading-dashboard/src/components/layout/arx-shell-frame.css",
  "../../artifacts/trading-dashboard/src/components/dashboard/command-workspace.css",
].map(file => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
const columns = [["discovery", "heat", "clock"], ["chart", "intelligence"], ["ruby", "risk", "order"]];
const ids = columns.flat();
const panel = id => `<section id="workspace-${id}" class="arx-panel ${id === "chart" ? "arx-chart-panel" : ""}" data-collapsed="false">
  <div class="arx-panel-head"><h2>${id}</h2><button aria-expanded="true">Collapse</button></div>
  <div class="arx-panel-body"><div style="min-height:${id === "chart" ? 200 : 42}px">Synthetic layout content only</div></div></section>`;
const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>html,body{margin:0}*{box-sizing:border-box}h1,h2{margin:0}button{font:inherit}${css}</style>
<div class="arx-shell-frame" data-variant="cockpit"><aside class="arx-shell-dock">Fixture only</aside><div class="arx-shell-main-column">
<header class="arx-shell-header"><div class="arx-shell-heading"><h1>ARX Market desk · development workspace</h1></div>
<div class="arx-shell-header-actions"><div data-cockpit-header-slot><div class="arx-shell-cockpit-controls">
<button>Analyze</button><button>Trade</button><button>Review</button><button>Refresh status and connection</button><button>System details</button>
</div></div></div></header>
<main id="main-content" class="arx-shell-content arx-root-main"><div class="arx-root-main-content"><div class="arx-dashboard-root arx-workspace"><div class="arx-workspace-body">
<section class="arx-account-strip">${["Equity", "Today's P/L", "Available margin", "Risk utilization", "Account mode"].map(label => `<div class="arx-strip-metric"><small>${label}</small><b>Unavailable</b><span>Synthetic geometry fixture</span></div>`).join("")}</section>
<div class="arx-workspace-grid">${columns.map((col, i) => `<div class="arx-col arx-col-${["left", "center", "right"][i]}">${col.map(panel).join("")}</div>`).join("")}</div>
<section class="arx-panel arx-positions"><div class="arx-panel-head">Open positions — fixture only</div><div class="arx-panel-body">No account data</div></section>
</div></div></div></main></div></div>`;

test("desktop columns fill across collapse/pin states; account labels clear opaque sticky header", { timeout: 120_000 }, async () => {
  const browser = await chromium.launch({ executablePath: browserPath(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    await context.route("**/*", route => route.abort("blockedbyclient"));
    const page = await context.newPage();
    let combinations = 0;
    for (const width of [1100, 1500, 1900]) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(html);
      const checks = await page.evaluate(({ ids }) => {
        const bounds = element => element.getBoundingClientRect();
        const errors = [];
        const header = document.querySelector("header"), strip = document.querySelector(".arx-account-strip");
        if (bounds(strip).top < bounds(header).bottom) errors.push("account strip under header");
        for (const label of strip.querySelectorAll("small")) {
          if (bounds(label).top < bounds(strip).top || bounds(label).bottom > bounds(strip).bottom) errors.push("clipped account label");
        }
        const style = getComputedStyle(header);
        if (style.position !== "sticky" || style.backgroundColor !== "rgb(5, 11, 16)" || style.flexShrink !== "0") errors.push("header not opaque/nonshrinking/sticky");
        for (let mask = 0; mask < 256; mask++) {
          ids.forEach((id, bit) => {
            const panel = document.getElementById(`workspace-${id}`);
            const collapsed = Boolean(mask & (1 << bit));
            panel.dataset.collapsed = String(collapsed);
            panel.querySelector(".arx-panel-body").hidden = collapsed;
            panel.querySelector("button").setAttribute("aria-expanded", String(!collapsed));
          });
          const grid = bounds(document.querySelector(".arx-workspace-grid"));
          for (const column of document.querySelectorAll(".arx-col")) {
            const last = bounds(column.lastElementChild);
            if (Math.abs(last.bottom - grid.bottom) > 1.5) errors.push(`mask ${mask} ${column.className} bottom gap ${grid.bottom - last.bottom}`);
            if (Math.abs(bounds(column).top - grid.top) > 1.5) errors.push(`mask ${mask} column dropped into new row`);
          }
        }
        // Pinned overrides a requested collapse in LayoutPanel (unit tested).
        // Replay that normalized DOM state after the all-collapsed combination.
        const pinned = document.getElementById("workspace-clock");
        pinned.dataset.collapsed = "false";
        pinned.querySelector(".arx-panel-body").hidden = false;
        if (Math.abs(bounds(pinned).bottom - bounds(document.querySelector(".arx-workspace-grid")).bottom) > 1.5) errors.push("pinned clock lost fill");
        return { errors, headerBottom: bounds(header).bottom, stripTop: bounds(strip).top };
      }, { ids });
      assert.deepEqual(checks.errors, [], `${width}px: ${JSON.stringify(checks)}`);
      combinations += 256;
      console.log(JSON.stringify({ width, collapseCombinations: 256, ...checks }));
    }
    // A scrolling narrow desk must keep the portal host within an opaque header.
    await page.setViewportSize({ width: 900, height: 500 });
    await page.setContent(html);
    await page.evaluate(() => window.scrollTo(0, 150));
    const scroll = await page.evaluate(() => {
      const header = document.querySelector("header").getBoundingClientRect();
      const control = document.querySelector("[data-cockpit-header-slot]").getBoundingClientRect();
      return { headerTop: header.top, controlTop: control.top, controlBottom: control.bottom, headerBottom: header.bottom };
    });
    assert.ok(scroll.headerTop >= -1 && scroll.controlTop >= scroll.headerTop && scroll.controlBottom <= scroll.headerBottom + 1, JSON.stringify(scroll));
    console.log(JSON.stringify({ passed: true, combinations, scroll }));
    await context.close();
  } finally { await browser.close(); }
});
