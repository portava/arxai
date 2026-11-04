import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { buildFixture } from "./build.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const widths = [390, 900, 1100, 1366];
const locales = ["de", "ar", "he"];

function chromiumExecutable() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit) {
    assert.ok(existsSync(explicit), "Configured Chromium executable does not exist");
    return explicit;
  }
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  for (const entry of readdirSync("/nix/store").filter(name => /playwright-(?:browsers|chromium)/i.test(name))) {
    const root = path.join("/nix/store", entry);
    for (const version of readdirSync(root)) {
      for (const binary of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
        const candidate = path.join(root, version, binary);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error("Chromium unavailable; install the declared Playwright browser or set PLAYWRIGHT_CHROMIUM_EXECUTABLE");
}

// Exact static-file allowlist, no proxy, API routes, credentials or mutation handlers.
async function startStaticServer(buildDir) {
  const files = new Map([["/", { type: "text/html", bytes: await readFile(path.join(buildDir, "index.html")) }]]);
  for (const file of readdirSync(path.join(buildDir, "assets"))) {
    assert.match(file, /\.(?:js|css)$/);
    files.set(`/assets/${file}`, {
      type: file.endsWith(".css") ? "text/css" : "text/javascript",
      bytes: await readFile(path.join(buildDir, "assets", file)),
    });
  }
  const server = http.createServer((req, res) => {
    const asset = files.get(new URL(req.url, "http://fixture").pathname);
    if (req.method !== "GET" || !asset) { res.writeHead(403).end(); return; }
    res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-store" }).end(asset.bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, origin: `http://127.0.0.1:${server.address().port}`, files };
}

async function restrictTraffic(context, origin, files, blocked) {
  await context.route("**/*", route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "GET" && url.origin === origin && files.has(url.pathname)) return route.continue();
    blocked.push({ method: request.method(), url: request.url() });
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, socket => { blocked.push({ method: "WS", url: socket.url() }); socket.close(); });
}

async function assertGeometry(page, observations) {
  // A visible Radix sheet may still be entering from outside the viewport.
  // Measure its settled geometry, without disabling production animations.
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(document.getAnimations()
      .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {})));
  });
  const geometry = await page.evaluate(() => {
    const shown = el => el.checkVisibility({ checkVisibilityCSS: true });
    const box = el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const elements = [...document.querySelectorAll(".arx-shell-header, .arx-shell-heading h1, .arx-shell-safety-notice, [data-fixture-notice], .arx-shell-header button, .arx-shell-header select, [data-testid=badge-alert-unread-count], .arx-shell-layout-menu summary, .arx-shell-layout-popover, .arx-shell-status-strip button, .arx-shell-mobile-tray, .arx-shell-mobile-tray > *, [role=dialog], [role=dialog] button, [role=dialog] a")].filter(shown);
    const clipped = elements.flatMap(el => {
      const r = el.getBoundingClientRect();
      // Viewport-fixed Radix portals are not clipped by the normal-flow body's
      // content box. Descendants are still checked against their dialog itself.
      let ancestor = getComputedStyle(el).position === "fixed" ? null : el.parentElement;
      const failures = [];
      while (ancestor) {
        const style = getComputedStyle(ancestor), a = ancestor.getBoundingClientRect();
        if (/(hidden|clip)/.test(style.overflowX) && (r.left < a.left - 1 || r.right > a.right + 1)) failures.push(ancestor.className);
        if (/(hidden|clip)/.test(style.overflowY) && (r.top < a.top - 1 || r.bottom > a.bottom + 1)) failures.push(ancestor.className);
        if (style.position === "fixed") break;
        ancestor = ancestor.parentElement;
      }
      return failures.length ? [{ text: el.textContent, ancestors: failures }] : [];
    });
    return {
      width: innerWidth, scale: visualViewport.scale, dpr: devicePixelRatio,
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
      elements: elements.map(el => ({ name: el.getAttribute("aria-label") || el.textContent.slice(0, 100), ...box(el) })),
      contentWidths: [...document.querySelectorAll(".arx-shell-heading h1, [data-fixture-notice], .arx-shell-header-actions, .arx-shell-actions-main, .arx-shell-cockpit-controls, .arx-shell-status-strip")]
        .filter(shown).map(el => ({ name: el.className || el.textContent.slice(0, 60), scroll: el.scrollWidth, client: el.clientWidth })),
      clipped,
    };
  });
  observations?.push(geometry);
  assert.equal(geometry.scale, 1, "Browser must be at 100% zoom");
  assert.equal(geometry.dpr, 1, "Use deterministic 1× device scale");
  assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `Document overflow: ${JSON.stringify(geometry)}`);
  assert.deepEqual(geometry.clipped, [], "Clipping must not conceal overflow");
  for (const content of geometry.contentWidths) {
    assert.ok(content.scroll <= content.client + 1, `Hidden horizontal content overflow: ${JSON.stringify(content)}`);
  }
  for (const el of geometry.elements) {
    assert.ok(el.x >= -1 && el.right <= geometry.width + 1 && el.width > 0, `Off-screen element: ${JSON.stringify(el)}`);
  }
  return geometry;
}

async function assertDirection(page, locale, observations) {
  const direction = await page.evaluate(() => {
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const visible = selector => [...document.querySelectorAll(selector)]
      .filter(el => el.checkVisibility({ checkVisibilityCSS: true }));
    const ordered = selector => visible(selector).map(el => ({ text: el.textContent, ...rect(el) }));
    const header = document.querySelector(".arx-shell-header");
    const popover = visible(".arx-shell-layout-popover")[0];
    const badge = document.querySelector("[data-testid=badge-alert-unread-count]");
    const bell = document.querySelector("[data-testid=button-notification-bell]");
    const b = rect(badge);
    return {
      lang: document.documentElement.lang, dir: getComputedStyle(header).direction,
      portalDirections: visible("[role=dialog]").map(el => getComputedStyle(el).direction),
      header: rect(header), popover: popover ? rect(popover) : null,
      bell: rect(bell), badge: rect(badge),
      badgeOverlaps: visible(".arx-shell-header button, .arx-shell-header select, .arx-shell-layout-menu summary")
        .filter(el => el !== bell).filter(el => {
          const r = rect(el);
          return Math.min(b.right, r.right) - Math.max(b.left, r.left) > 1 &&
            Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) > 1;
        }).map(el => el.getAttribute("aria-label") || el.textContent),
      // These DOM-order siblings must read from inline-start to inline-end.
      tray: ordered(".arx-shell-mobile-tray > *"),
      mobileHeader: ordered(".arx-shell-mobile-brand, .arx-shell-heading, .arx-shell-mobile-tools"),
      mobileItems: ordered(".arx-shell-mobile-sheet-items > *"),
      layoutChoices: ordered(".arx-shell-layout-popover button"),
      dock: visible(".arx-shell-dock").map(rect),
      main: rect(document.querySelector(".arx-shell-main-column")),
    };
  });
  observations.push(direction);
  const rtl = locale !== "de";
  assert.equal(direction.lang, locale);
  assert.equal(direction.dir, rtl ? "rtl" : "ltr");
  assert.ok(direction.portalDirections.every(dir => dir === direction.dir), "Portaled sheets must inherit document direction");
  for (const group of ["tray", "mobileHeader", "mobileItems", "layoutChoices"]) {
    const items = direction[group];
    for (let i = 1; i < items.length; i++) {
      const previous = items[i - 1], current = items[i];
      if (Math.min(previous.bottom, current.bottom) <= Math.max(previous.top, current.top)) continue; // different grid rows
      assert.ok(rtl ? previous.left >= current.right - 1 : previous.right <= current.left + 1,
        `${group} must follow ${direction.dir} reading order: ${JSON.stringify(items)}`);
    }
  }
  if (direction.dock.length) {
    assert.ok(rtl ? direction.dock[0].left >= direction.main.right - 1 : direction.dock[0].right <= direction.main.left + 1,
      "Desktop dock must occupy inline-start");
  }
  if (direction.popover) {
    const mobile = page.viewportSize().width < 768;
    const edge = mobile === rtl ? "right" : "left";
    assert.ok(Math.abs(direction.popover[edge] - direction.header[edge]) <= 1,
      `Layout popover must anchor at inline-${mobile ? "start" : "end"}: ${JSON.stringify(direction)}`);
  }
  // Production badges intentionally protrude 4px above/right of the bell.
  // Require their center inside the bell and no overlap with adjacent controls.
  const { badge, bell } = direction;
  assert.deepEqual(direction.badgeOverlaps, [], "Unread badge must not overlap another header control");
  assert.ok((badge.left + badge.right) / 2 >= bell.left && (badge.left + badge.right) / 2 <= bell.right &&
    (badge.top + badge.bottom) / 2 >= bell.top && (badge.top + badge.bottom) / 2 <= bell.bottom,
  "Unread badge must stay attached to the bell");
  const badgeHit = await page.evaluate(() => {
    const badge = document.querySelector("[data-testid=badge-alert-unread-count]");
    const r = badge.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && (hit === badge || badge.contains(hit));
  });
  // A modal/popover can intentionally cover the background notification bell.
  if (!direction.portalDirections.length && !direction.popover) {
    assert.ok(badge.top >= 0 && badge.bottom <= page.viewportSize().height, "Unread badge must stay vertically in view");
    assert.ok(badgeHit, "Unread badge must not be obscured");
  }
}

async function keyboardReachability(page, selector = ".arx-shell-frame button, .arx-shell-frame a, .arx-shell-frame select, .arx-shell-frame summary") {
  await page.locator("[data-keyboard-probe]").evaluateAll(elements => elements.forEach(el => delete el.dataset.keyboardProbe));
  const expected = await page.locator(selector).evaluateAll(elements => {
    // Radix initially autofocuses Close. Capture an actually unfocused style,
    // then let real Tab presses revisit every control (including Close).
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    let id = 0;
    return elements.filter(el => el.checkVisibility({ checkVisibilityCSS: true }) && !el.disabled && el.tabIndex >= 0).map(el => {
      el.dataset.keyboardProbe = String(id++);
      el.dataset.unfocusedShadow = getComputedStyle(el).boxShadow;
      return el.dataset.keyboardProbe;
    });
  });
  const reached = new Set();
  const receipts = [];
  // Fresh navigation starts with no focused controls; do not use locator.focus().
  for (let step = 0; step < expected.length + 3 && reached.size < expected.length; step++) {
    await page.keyboard.press("Tab");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const focused = await page.evaluate(() => {
      const el = document.activeElement, style = getComputedStyle(el), r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        id: el.dataset.keyboardProbe, label: el.getAttribute("aria-label") || el.textContent,
        focusStyle: { match: el.matches(":focus-visible"), outline: style.outline, shadow: style.boxShadow },
        visibleFocus: el.matches(":focus-visible") && (
          (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== "rgba(0, 0, 0, 0)") ||
          (style.boxShadow !== "none" && style.boxShadow !== el.dataset.unfocusedShadow)
        ),
        inside: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1,
        unobscured: !!hit && (hit === el || el.contains(hit)),
      };
    });
    if (focused.id !== undefined) {
      assert.ok(focused.visibleFocus && focused.inside && focused.unobscured, `Keyboard control not visibly reachable: ${JSON.stringify(focused)}`);
      reached.add(focused.id); receipts.push(focused);
    }
  }
  assert.deepEqual([...reached].sort(), [...expected].sort(), "Every visible shell control must be reachable by Tab");
  // A modal may start from Close; compare the complete cyclic DOM order rather
  // than assuming the initial focus position. RTL must not reverse Tab order.
  const actual = receipts.map(receipt => receipt.id);
  const start = expected.indexOf(actual[0]);
  assert.deepEqual(actual, [...expected.slice(start), ...expected.slice(0, start)],
    "Tab must visit visible controls in DOM order without skips or repeats");
  return receipts;
}

test("shared shell long-content and RTL browser regression", { timeout: 480_000 }, async t => {
  const parent = path.join(workspace, "generated-artifacts/shell-header");
  await mkdir(parent, { recursive: true });
  const evidence = await mkdtemp(path.join(parent, "run-"));
  const buildDir = path.join(evidence, "build");
  await buildFixture(buildDir);
  const { server, origin, files } = await startStaticServer(buildDir);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
  t.after(() => browser.close());
  console.log(`Shell evidence: ${path.relative(workspace, evidence)}`);

  await t.test("network containment rejects external reads, local API reads, mutations and WebSockets", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const blocked = [];
    try {
      await restrictTraffic(context, origin, files, blocked);
      const page = await context.newPage();
      page.setDefaultTimeout(3_000);
      await page.goto(origin);
      await page.evaluate(async () => {
        await Promise.all([
          fetch("https://example.invalid/forbidden"),
          fetch("/api/forbidden"),
          fetch("/", { method: "POST", body: "fixture-only" }),
        ].map(p => p.catch(() => null)));
        await new Promise(resolve => {
          const ws = new WebSocket(`ws://${location.host}/forbidden`);
          ws.onclose = resolve; ws.onerror = resolve;
        });
      });
      assert.deepEqual(blocked.map(r => r.method).sort(), ["GET", "GET", "POST", "WS"]);
      assert.equal((await fetch(`${origin}/api/forbidden`)).status, 403);
      assert.equal((await fetch(origin, { method: "POST" })).status, 403);
      await writeFile(path.join(evidence, "network-containment.json"), JSON.stringify(blocked, null, 2));
    } finally { await context.close(); }
  });

  const results = [];
  for (const locale of locales) for (const width of widths) for (const variant of ["page", "cockpit"]) for (const dock of ["expanded", "compact"]) {
    const name = `${locale}-${variant}-${dock}-${width}`;
    await t.test(name, async () => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, serviceWorkers: "block", reducedMotion: "reduce" });
      const blocked = [], errors = [];
      const page = await context.newPage();
      const receipt = { locale, width, variant, dock, observations: [], direction: [] };
      try {
        await restrictTraffic(context, origin, files, blocked);
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${origin}/?variant=${variant}&dock=${dock}&count=999&locale=${locale}`);
        await page.getByRole("heading", { level: 1 }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator("[data-fixture-notice]").count(), 3);
        assert.equal(await page.getByTestId("badge-alert-unread-count").textContent(), "9+");
        await assertGeometry(page, receipt.observations);
        await assertDirection(page, locale, receipt.direction);
        receipt.keyboard = await keyboardReachability(page);
        await page.screenshot({ path: path.join(evidence, `${name}-keyboard-focus.png`) });
        await page.getByLabel("Fixture account", { exact: true }).selectOption({ index: 1 });
        assert.equal(await page.getByTestId("fixture-action").textContent(), "account");
        for (const action of ["emergency", "review"]) {
          await page.locator(`[data-fixture-action=${action}]`).click();
          assert.equal(await page.getByTestId("fixture-action").textContent(), action);
        }
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        assert.equal(await page.getByTestId("fixture-action").textContent(), "signout");
        await page.getByLabel("Open layout menu", { exact: true }).click();
        await assertGeometry(page, receipt.observations);
        await assertDirection(page, locale, receipt.direction);
        await page.screenshot({ path: path.join(evidence, `${name}-layout.png`) });
        receipt.layoutKeyboard = await keyboardReachability(page, ".arx-shell-layout-popover button");
        await page.getByRole("button", { name: dock === "expanded" ? "Compact" : "Expanded", exact: true }).click();
        await page.getByLabel("Open layout menu", { exact: true }).click();
        await page.getByTestId(width < 768 ? "button-shell-tray-tools" : "button-shell-all-tools").click();
        await page.getByRole("dialog").waitFor();
        await assertGeometry(page, receipt.observations);
        await assertDirection(page, locale, receipt.direction);
        receipt.toolsKeyboard = await keyboardReachability(page, "[role=dialog] button");
        await page.screenshot({ path: path.join(evidence, `${name}-tools-focus.png`) });
        await page.getByRole("button", { name: "Fixture risk information" }).click();
        assert.equal(await page.getByTestId("fixture-action").textContent(), "tools");
        if (width < 768) {
          await page.getByLabel("Open mobile tools", { exact: true }).click();
          await page.getByRole("dialog").waitFor();
          await assertGeometry(page, receipt.observations);
          await assertDirection(page, locale, receipt.direction);
          receipt.mobileKeyboard = await keyboardReachability(page, "[role=dialog] button, [role=dialog] a");
          await page.screenshot({ path: path.join(evidence, `${name}-mobile-focus.png`) });
          await page.keyboard.press("Escape");
          await page.getByRole("dialog").waitFor({ state: "hidden" });
        }
        await page.getByTestId("button-notification-bell").click();
        await page.getByRole("button", { name: "Close fixture alerts" }).click();
        assert.deepEqual(blocked, [], "The normal fixture must attempt no external/API/mutating traffic");
        assert.deepEqual(errors, [], "No browser runtime errors");
        results.push({ name, status: "passed" });
      } catch (error) {
        results.push({ name, status: "failed", error: error.stack });
        throw error;
      } finally {
        await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true });
        await writeFile(path.join(evidence, `${name}.json`), JSON.stringify({ receipt, blocked, errors }, null, 2));
        await writeFile(path.join(evidence, `${name}.html`), await page.content());
        await writeFile(path.join(evidence, "results.json"), JSON.stringify(results, null, 2));
        await context.close();
      }
    });
  }
  await t.test("real notification badge handles zero, singular and capped counts", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const blocked = [];
    try {
      await restrictTraffic(context, origin, files, blocked);
      const page = await context.newPage();
      for (const count of [0, 1, 9, 999]) {
        await page.goto(`${origin}/?count=${count}`);
        await page.getByTestId("button-notification-bell").waitFor();
        assert.match(await page.getByTestId("button-notification-bell").getAttribute("aria-label"), new RegExp(`^${count} unread alert${count === 1 ? "," : "s,"}`));
        if (count === 0) assert.equal(await page.getByTestId("badge-alert-unread-count").count(), 0);
        else assert.equal(await page.getByTestId("badge-alert-unread-count").textContent(), count > 9 ? "9+" : String(count));
      }
      assert.deepEqual(blocked, []);
    } finally { await context.close(); }
  });
});
