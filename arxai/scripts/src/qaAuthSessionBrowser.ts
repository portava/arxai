/**
 * Real-browser regression check for a normal user's session lifecycle.
 *
 * Seeds two isolated USER accounts, signs in through the actual /login form,
 * reloads, opens /settings, verifies that server-side session revocation sends
 * the browser back to /login and clears private query data before a new sign-in,
 * then signs out and switches to the second account to verify private cached data
 * is refreshed rather than carried across accounts, including saved watchlists.
 * The test never creates a privileged user, provisions a broker, or invokes a
 * broker connection endpoint.
 */
import { randomBytes, scryptSync } from "node:crypto";
import type { Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createServer as createViteServer } from "vite";
import { pool } from "@workspace/db";

const ROOT = resolve(import.meta.dirname, "../..");
const DASHBOARD_ROOT = resolve(ROOT, "artifacts/trading-dashboard");
const PASSWORD_COST = 65_536;
const PASSWORD_BLOCK_SIZE = 8;
const PASSWORD_PARALLELISM = 1;
const PASSWORD_KEY_LENGTH = 64;
const DISABLED_BROKER_ENV = [
  "DERIV_API_TOKEN",
  "DERIV_APP_ID",
  "DERIV_ACCOUNT_ID",
  "DERIV_API_MODE",
  "DERIV_ENABLED",
  "DERIV_WS_URL",
  "MT5_BRIDGE_TOKEN",
  "MT5_ENVIRONMENT",
  "BROKER_PROVIDER",
  "LIVE_TRADING_ALLOWED",
  "ARX_DERIV_OWNER_USER_ID",
  "ARX_EXECUTION_TIER",
  "ARX_ADMIN_EMAIL",
  "ARX_ADMIN_INITIAL_PASSWORD",
  "ARX_OWNER_EMAIL",
  "OWNER_RESET_PASSWORD",
  "NEW_ADMIN_PASSWORD",
  "QA_OWNER_PASSWORD",
  "ARX_AUTH_TEST_PASSWORD",
  "VAULT_OVERRIDE_TOKEN",
  "ALPHA_VANTAGE_API_KEY",
  "BENZINGA_API_KEY",
  "FINNHUB_API_KEY",
  "FRED_API_KEY",
  "MARKETAUX_API_KEY",
  "NASDAQ_DATA_LINK_API_KEY",
  "NEWSAPI_API_KEY",
  "POLYGON_API_KEY",
] as const;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, PASSWORD_KEY_LENGTH, {
    N: PASSWORD_COST,
    r: PASSWORD_BLOCK_SIZE,
    p: PASSWORD_PARALLELISM,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${PASSWORD_COST}$${PASSWORD_BLOCK_SIZE}$${PASSWORD_PARALLELISM}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((done) => server.close(() => done()));
    throw new Error("Could not reserve a local test port.");
  }
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const fixtureSuffix = randomBytes(8).toString("hex");
  const emailA = `qa-session-a-${fixtureSuffix}@arx.local`;
  const emailB = `qa-session-b-${fixtureSuffix}@arx.local`;
  const passwordA = `Session-A-${randomBytes(12).toString("hex")}`;
  const passwordB = `Session-B-${randomBytes(12).toString("hex")}`;
  const privateNameA = `QA User A ${fixtureSuffix.slice(0, 5)}`;
  const privateNameB = `QA User B ${fixtureSuffix.slice(0, 5)}`;
  const testClientIp = `2001:db8::${fixtureSuffix}`;
  const watchlistNameA = `QA Watchlist A ${fixtureSuffix.slice(0, 5)}`;
  const watchlistNameB = `QA Watchlist B ${fixtureSuffix.slice(0, 5)}`;
  const inserted = await pool.query<{ id: number; email: string }>(
    `INSERT INTO users (email, name, password_hash, role)
     VALUES ($1, 'QA Session User A', $2, 'USER'),
            ($3, 'QA Session User B', $4, 'USER')
     RETURNING id, email`,
    [emailA, hashPassword(passwordA), emailB, hashPassword(passwordB)],
  );
  const userAId = inserted.rows.find((user) => user.email === emailA)?.id;
  const userBId = inserted.rows.find((user) => user.email === emailB)?.id;
  assert(userAId !== undefined && userBId !== undefined, "Could not create both isolated standard-user fixtures.");
  await pool.query(
    `INSERT INTO user_settings (user_id, assistant_display_name)
     VALUES ($1, $2), ($3, $4)`,
    [userAId, privateNameA, userBId, privateNameB],
  );
  await pool.query(
    `INSERT INTO watchlists (user_id, name, category)
     VALUES ($1, $2, 'Custom'), ($3, $4, 'Custom')`,
    [userAId, watchlistNameA, userBId, watchlistNameB],
  );
  // Watchlists are an approved-trader route. Keep both accounts as ordinary
  // USER roles, but give the isolated fixtures the minimal approval signal
  // required to render that route; neither account is armed for execution.
  await pool.query(
    `INSERT INTO user_trading_permissions (user_id, account_routing_override)
     VALUES ($1, 'shared_master_mt5'), ($2, 'shared_master_mt5')`,
    [userAId, userBId],
  );
  await pool.query(
    `INSERT INTO user_master_live_access (user_id, master_live_status)
     VALUES ($1, 'APPROVED'), ($2, 'APPROVED')`,
    [userAId, userBId],
  );

  const originalEnv = new Map<string, string | undefined>();
  let apiServer: Server | undefined;
  let viteServer: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  let privateAssistantSettingsRequestCount = 0;
  let watchlistsRequestCount = 0;
  let holdNextAssistantSettingsResponse = false;
  let markHeldResponseStarted: () => void = () => {};
  let releaseHeldResponse: () => void = () => {};
  let markHeldResponseHandled: () => void = () => {};
  const heldResponseStarted = new Promise<void>((resolveStarted) => {
    markHeldResponseStarted = resolveStarted;
  });
  const heldResponseRelease = new Promise<void>((resolveRelease) => {
    releaseHeldResponse = resolveRelease;
  });
  const heldResponseHandled = new Promise<void>((resolveHandled) => {
    markHeldResponseHandled = resolveHandled;
  });

  for (const name of DISABLED_BROKER_ENV) {
    originalEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  const priorExecutionFlag = process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"];
  originalEnv.set("ARX_LIVE_BROKER_EXECUTION_ENABLED", priorExecutionFlag);
  process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"] = "false";

  try {
    const apiApp = (await import("../../artifacts/api-server/src/app.js")).default;
    // Give each run an isolated rate-limit scope. The API is only bound to
    // loopback below, so trusting its single local proxy hop is test-only.
    apiApp.set("trust proxy", 1);
    const runningApiServer = await new Promise<Server>((resolveServer, reject) => {
      const server = apiApp.listen(0, "127.0.0.1", () => resolveServer(server));
      server.once("error", reject);
    });
    apiServer = runningApiServer;
    const apiAddress = runningApiServer.address();
    assert(apiAddress && typeof apiAddress !== "string", "API test server did not start.");
    const apiOrigin = `http://127.0.0.1:${apiAddress.port}`;

    const vitePort = await reservePort();
    process.env["PORT"] = String(vitePort);
    process.env["BASE_PATH"] = "/";
    viteServer = await createViteServer({
      configFile: resolve(DASHBOARD_ROOT, "vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: vitePort,
        strictPort: true,
        hmr: false,
        proxy: {
          "/api": {
            target: apiOrigin,
            changeOrigin: false,
            headers: { "x-forwarded-for": testClientIp },
          },
        },
      },
    });
    await viteServer.listen();
    const uiOrigin = `http://127.0.0.1:${vitePort}`;

    const executablePath = process.env["REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    browserContext = await browser.newContext();
    const page = await browserContext.newPage();
    const externalBrowserRequests: string[] = [];
    const requestedModules = new Set<string>();
    let blockedShellModule: string | null = null;
    let blockedShellRequests = 0;
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      requestedModules.add(requestUrl.pathname);
      if (requestUrl.origin !== uiOrigin) externalBrowserRequests.push(requestUrl.origin);
    });
    await browserContext.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin !== uiOrigin) {
        await route.abort();
        return;
      }
      if (requestUrl.pathname === blockedShellModule) {
        blockedShellRequests += 1;
        await route.abort("failed");
        return;
      }
      const method = route.request().method();
      if (requestUrl.pathname === "/api/me/assistant-settings" && method === "GET") {
        privateAssistantSettingsRequestCount += 1;
        if (holdNextAssistantSettingsResponse) {
          holdNextAssistantSettingsResponse = false;
          const response = await route.fetch();
          assert(response.status() === 200, `Held private settings request returned ${response.status()}.`);
          markHeldResponseStarted();
          try {
            await heldResponseRelease;
            await route.fulfill({ response });
          } catch {
            // Sign-out may abort the browser fetch. The response is still
            // released only after User B's settings are visible below.
            await route.abort().catch(() => {});
          } finally {
            markHeldResponseHandled();
          }
          return;
        }
      }
      if (requestUrl.pathname === "/api/watchlists" && method === "GET") {
        watchlistsRequestCount += 1;
      }
      const allowedSessionRequest =
        (requestUrl.pathname === "/api/me" && method === "GET") ||
        (requestUrl.pathname === "/api/auth/login" && method === "POST") ||
        (requestUrl.pathname === "/api/auth/user-logout" && method === "POST") ||
        (requestUrl.pathname === "/api/me/assistant-settings" && method === "GET") ||
        (requestUrl.pathname === "/api/me/account-mode" && method === "GET") ||
        (requestUrl.pathname === "/api/watchlists" && method === "GET");
      if (requestUrl.pathname.startsWith("/api/") && !allowedSessionRequest) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    await page.goto(`${uiOrigin}/login`, { waitUntil: "domcontentloaded" });
    const initialPrivateSettings = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/me/assistant-settings" && response.status() === 200,
      { timeout: 15_000 },
    );
    await page.getByTestId("input-email").fill(emailA);
    for (const module of ["/src/components/layout/AppLayout.tsx", "/src/components/onboarding/OnboardingProvider.tsx"]) {
      assert(!requestedModules.has(module), `Anonymous login eagerly loaded private shell module ${module}.`);
    }
    console.log("PASS  anonymous login defers the authenticated shell and onboarding modules");
    await page.getByTestId("input-password").fill(passwordA);
    await page.getByTestId("button-submit-login").click();
    await page.waitForURL((url) => url.pathname !== "/login", { timeout: 30_000 });
    const initialSettingsResponse = await initialPrivateSettings;
    const initialSettings = await initialSettingsResponse.json() as { displayName?: string };
    assert(
      privateAssistantSettingsRequestCount === 1,
      "The private assistant settings query did not load after sign-in.",
    );
    assert(
      initialSettings.displayName === privateNameA,
      "User A did not receive their isolated private assistant settings.",
    );

    const fetchMe = async () => page.evaluate(async () => {
      const response = await fetch("/api/me", { credentials: "include" });
      return {
        status: response.status,
        body: await response.json().catch(() => null) as { user?: { email?: string; role?: string } } | null,
      };
    });
    let me = await fetchMe();
    assert(me.status === 200, `Expected signed-in /api/me to return 200, got ${me.status}.`);
    assert(me.body?.user?.email === emailA, "The signed-in session did not resolve to standard user A.");
    assert(me.body?.user?.role === "USER", "The browser session did not use a standard USER account.");
    console.log("PASS  standard USER signs in through /login and /api/me identifies the session");

    await page.goto(`${uiOrigin}/settings`, { waitUntil: "domcontentloaded" });
    try {
      await page.locator("#main-content").getByRole("heading", { name: "Settings", exact: true }).waitFor({ timeout: 15_000 });
    } catch {
      const visibleText = await page.locator("body").innerText().catch(() => "");
      throw new Error(
        `The standard user did not reach Settings; current path is ${new URL(page.url()).pathname}. ` +
          `Visible page text: ${visibleText.slice(0, 240).replace(/\s+/g, " ")}`,
      );
    }
    assert(new URL(page.url()).pathname === "/settings", "The standard user could not stay on /settings.");
    await page.getByTestId("input-assistant-name").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      '(name) => document.querySelector(\'[data-testid="input-assistant-name"]\')?.value === name',
      privateNameA,
      { timeout: 10_000 },
    );
    const privateSettingsRequestsBeforeRevocation = privateAssistantSettingsRequestCount;
    assert(
      privateSettingsRequestsBeforeRevocation >= 1,
      "The private assistant settings query was not cached before revocation.",
    );
    console.log("PASS  standard USER can open the allowed /settings route directly");
    for (const module of ["/src/components/layout/AppLayout.tsx", "/src/components/onboarding/OnboardingProvider.tsx"]) {
      assert(requestedModules.has(module), `Authenticated Settings did not load private shell module ${module}.`);
    }

    const revokedSessions = await pool.query(
      `DELETE FROM auth_user_sessions WHERE user_id = $1`,
      [userAId],
    );
    assert((revokedSessions.rowCount ?? 0) > 0, "Could not revoke the isolated test user's session.");
    const unauthorizedIdentity = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/me" && response.status() === 401,
      { timeout: 15_000 },
    );
    // useCurrentUser intentionally revalidates every five seconds, so wait for
    // its cached identity to become stale before simulating a foreground return.
    await page.waitForTimeout(5_100);
    await page.bringToFront();
    // TanStack Query listens for visibilitychange on window.
    await page.evaluate("window.dispatchEvent(new Event('visibilitychange'))");
    await unauthorizedIdentity;
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 15_000 });
    await page.getByTestId("form-login").waitFor({ timeout: 10_000 });
    assert(
      !(await page.locator("#main-content").getByRole("heading", { name: "Settings", exact: true }).isVisible().catch(() => false)),
      "Protected Settings content remained visible after the server revoked the session.",
    );
    me = await fetchMe();
    assert(me.status === 401, `Expected revoked-session /api/me to return 401, got ${me.status}.`);
    console.log("PASS  server-side session revocation returns an open dashboard to /login");

    await page.goto(`${uiOrigin}/register`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("form-register").waitFor({ timeout: 10_000 });
    await page.goto(`${uiOrigin}/reset-password`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("form-reset-password").waitFor({ timeout: 10_000 });
    await page.goto(`${uiOrigin}/login`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("form-login").waitFor({ timeout: 10_000 });
    console.log("PASS  register and password-reset pages remain public after revocation");

    await page.getByTestId("input-email").fill(emailA);
    await page.getByTestId("input-password").fill(passwordA);
    const refreshedPrivateSettings = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/me/assistant-settings" && response.status() === 200,
      { timeout: 15_000 },
    );
    await page.getByTestId("button-submit-login").click();
    await page.waitForURL((url) => url.pathname !== "/login", { timeout: 30_000 });
    await refreshedPrivateSettings;
    await page.goto(`${uiOrigin}/settings`, { waitUntil: "domcontentloaded" });
    await page.locator("#main-content").getByRole("heading", { name: "Settings", exact: true }).waitFor({ timeout: 15_000 });
    await page.waitForFunction(
      '(name) => document.querySelector(\'[data-testid="input-assistant-name"]\')?.value === name',
      privateNameA,
      { timeout: 10_000 },
    );
    assert(
      Number(privateAssistantSettingsRequestCount) > Number(privateSettingsRequestsBeforeRevocation),
      `Expected private settings to be fetched again after re-sign-in. Requests before revocation: ${privateSettingsRequestsBeforeRevocation}; after: ${privateAssistantSettingsRequestCount}.`,
    );
    console.log("PASS  private cached settings are fetched again after revocation and subsequent sign-in");

    await page.reload({ waitUntil: "domcontentloaded" });
    me = await fetchMe();
    assert(me.status === 200 && me.body?.user?.role === "USER", "A full browser refresh did not preserve the USER session.");
    console.log("PASS  full refresh preserves the standard-user session");

    const userAWatchlistsResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/watchlists" &&
        response.request().method() === "GET" &&
        response.status() === 200,
      { timeout: 15_000 },
    );
    await page.goto(`${uiOrigin}/watchlists`, { waitUntil: "domcontentloaded" });
    const userAWatchlistsResponse = await userAWatchlistsResponsePromise;
    const userAWatchlists = await userAWatchlistsResponse.json() as { name: string }[];
    assert(
      userAWatchlists.some((watchlist) => watchlist.name === watchlistNameA) &&
        !userAWatchlists.some((watchlist) => watchlist.name === watchlistNameB),
      "User A's watchlist API response did not contain only User A's isolated saved list.",
    );
    await page.getByRole("heading", { level: 3, name: watchlistNameA, exact: true }).waitFor({ timeout: 15_000 });
    assert(
      await page.getByRole("heading", { level: 3, name: watchlistNameB, exact: true }).count() === 0,
      "User A's watchlist page displayed User B's saved list.",
    );
    const watchlistsRequestsBeforeAccountSwitch = watchlistsRequestCount;
    assert(watchlistsRequestsBeforeAccountSwitch > 0, "User A's watchlist page did not fetch its saved lists.");
    console.log("PASS  User A sees only User A's saved watchlist in the page and API response");

    await page.goto(`${uiOrigin}/settings`, { waitUntil: "domcontentloaded" });
    await page.locator("#main-content").getByRole("heading", { name: "Settings", exact: true }).waitFor({ timeout: 15_000 });
    // Hold an already-fetched User A response at the browser boundary and
    // release it only after User B has signed in and loaded their own data.
    holdNextAssistantSettingsResponse = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    await heldResponseStarted;
    console.log("PASS  held User A private settings response after the server returned it");

    await page.getByTestId("button-logout").click();
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
    const signedOut = await fetchMe();
    assert(signedOut.status === 401, `Expected signed-out /api/me to return 401, got ${signedOut.status}.`);
    console.log("PASS  sign-out invalidates /api/me");

    await page.goto(`${uiOrigin}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
    await page.getByTestId("form-login").waitFor({ timeout: 10_000 });
    console.log("PASS  direct /settings visit after sign-out redirects to /login");

    await page.getByTestId("input-email").fill(emailB);
    await page.getByTestId("input-password").fill(passwordB);
    const userBPrivateSettings = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/me/assistant-settings" && response.status() === 200,
      { timeout: 15_000 },
    );
    await page.getByTestId("button-submit-login").click();
    await page.waitForURL((url) => url.pathname !== "/login", { timeout: 30_000 });
    const userBSettingsResponse = await userBPrivateSettings;
    const userBSettings = await userBSettingsResponse.json() as { displayName?: string };
    assert(
      userBSettings.displayName === privateNameB,
      `User B received the wrong private settings value; expected ${privateNameB}, got ${userBSettings.displayName ?? "none"}.`,
    );
    await page.goto(`${uiOrigin}/settings`, { waitUntil: "domcontentloaded" });
    await page.locator("#main-content").getByRole("heading", { name: "Settings", exact: true }).waitFor({ timeout: 15_000 });
    await page.waitForFunction(
      '(name) => document.querySelector(\'[data-testid="input-assistant-name"]\')?.value === name',
      privateNameB,
      { timeout: 10_000 },
    );
    assert(
      (await page.getByTestId("input-assistant-name").inputValue()) !== privateNameA,
      "User A's cached private assistant settings remained visible after User B signed in.",
    );
    assert(
      privateAssistantSettingsRequestCount > Number(privateSettingsRequestsBeforeRevocation) + 1,
      "User B did not trigger a fresh private assistant settings request after User A signed out.",
    );
    console.log("PASS  signing in as User B fetches and displays B's private settings");

    releaseHeldResponse();
    await heldResponseHandled;
    await page.waitForTimeout(100);
    assert(
      (await page.getByTestId("input-assistant-name").inputValue()) === privateNameB,
      "User A's delayed private settings response overwrote or displayed in User B's session.",
    );
    console.log("PASS  User A's delayed private settings response cannot overwrite User B's session");

    const userBWatchlistsResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/watchlists" &&
        response.request().method() === "GET" &&
        response.status() === 200,
      { timeout: 15_000 },
    );
    await page.goto(`${uiOrigin}/watchlists`, { waitUntil: "domcontentloaded" });
    const userBWatchlistsResponse = await userBWatchlistsResponsePromise;
    const userBWatchlists = await userBWatchlistsResponse.json() as { name: string }[];
    assert(
      userBWatchlists.some((watchlist) => watchlist.name === watchlistNameB) &&
        !userBWatchlists.some((watchlist) => watchlist.name === watchlistNameA),
      "User B's fresh watchlist API response did not contain only User B's isolated saved list.",
    );
    await page.getByRole("heading", { level: 3, name: watchlistNameB, exact: true }).waitFor({ timeout: 15_000 });
    assert(
      await page.getByRole("heading", { level: 3, name: watchlistNameA, exact: true }).count() === 0,
      "User A's cached saved watchlist remained visible after User B signed in.",
    );
    assert(
      watchlistsRequestCount > watchlistsRequestsBeforeAccountSwitch,
      "User B did not trigger a fresh watchlist request after User A signed out.",
    );
    const freshUserBWatchlists = await page.evaluate(async () => {
      const response = await fetch("/api/watchlists", { credentials: "include" });
      return {
        status: response.status,
        body: await response.json().catch(() => null) as { name: string }[] | null,
      };
    });
    assert(freshUserBWatchlists.status === 200, `Expected User B's fresh /api/watchlists request to return 200, got ${freshUserBWatchlists.status}.`);
    assert(
      freshUserBWatchlists.body?.some((watchlist) => watchlist.name === watchlistNameB) &&
        !freshUserBWatchlists.body?.some((watchlist) => watchlist.name === watchlistNameA),
      "A fresh /api/watchlists response after the account switch did not contain only User B's saved list.",
    );
    console.log("PASS  User B sees only User B's saved watchlist in the page and fresh API responses");

    // Force each authenticated shell download to fail in a fresh document.
    // The real auth cookie stays valid; only the chosen module is withheld.
    for (const module of ["/src/components/layout/AppLayout.tsx", "/src/components/onboarding/OnboardingProvider.tsx"]) {
      blockedShellModule = module;
      blockedShellRequests = 0;
      await page.goto(`${uiOrigin}/settings`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("authenticated-shell-error").waitFor({ timeout: 15_000 });
      assert(blockedShellRequests > 0, `The failed-download control did not actually intercept ${module}.`);
      assert(await page.locator("#main-content").getByRole("heading", { name: "Settings", exact: true }).count() === 0,
        "Protected route content appeared beneath the failed shell.");
      const authenticatedDuringFailure = await fetchMe();
      assert(authenticatedDuringFailure.status === 200 && authenticatedDuringFailure.body?.user?.email === emailB,
        "The recovery control must exercise an authenticated shell failure, not a logged-out session.");
      blockedShellModule = null;
      await Promise.all([
        page.waitForEvent("domcontentloaded", { timeout: 30_000 }),
        page.getByTestId("button-reload-workspace").click(),
      ]);
      await page.locator("#main-content").getByRole("heading", { name: "Settings", exact: true }).waitFor({ timeout: 15_000 });
      await page.waitForFunction(
        '(name) => document.querySelector(\'[data-testid="input-assistant-name"]\')?.value === name',
        privateNameB, { timeout: 10_000 },
      );
      assert(await page.getByTestId("authenticated-shell-error").count() === 0,
        "The shell did not recover after its module became available and the user reloaded.");
      console.log(`PASS  failed ${module.split("/").pop()} download shows recovery UI and reload restores User B's workspace`);
    }

    assert(externalBrowserRequests.length === 0, "The test attempted an external browser connection.");
  } finally {
    releaseHeldResponse();
    await browserContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (viteServer) await viteServer.close().catch(() => {});
    if (apiServer) await new Promise<void>((done) => apiServer!.close(() => done()));
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const userId of [userAId, userBId]) {
      await pool.query(`DELETE FROM auth_user_sessions WHERE user_id = $1`, [userId]).catch(() => {});
      await pool.query(
        `DELETE FROM watchlist_items
         WHERE watchlist_id IN (SELECT id FROM watchlists WHERE user_id = $1)`,
        [userId],
      ).catch(() => {});
      await pool.query(`DELETE FROM watchlists WHERE user_id = $1`, [userId]).catch(() => {});
      await pool.query(`DELETE FROM user_trading_permissions WHERE user_id = $1`, [userId]).catch(() => {});
      await pool.query(`DELETE FROM user_activity_events WHERE user_id = $1`, [userId]).catch(() => {});
      await pool.query(`DELETE FROM user_master_live_access WHERE user_id = $1`, [userId]).catch(() => {});
      await pool.query(`DELETE FROM user_one_click_settings WHERE user_id = $1`, [userId]).catch(() => {});
      await pool.query(`DELETE FROM user_settings WHERE user_id = $1`, [userId]).catch(() => {});
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
    }
  }
}

main()
  .then(async () => {
    console.log("Dashboard standard-user session browser check passed.");
    await pool.end();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Dashboard session browser check failed.");
    await pool.end();
    process.exit(1);
  });
