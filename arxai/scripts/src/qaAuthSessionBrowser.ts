/**
 * Real-browser regression check for a normal user's session lifecycle.
 *
 * Seeds one isolated USER account, signs in through the actual /login form,
 * reloads, opens /settings, signs out, and confirms /api/me is unauthorized
 * before directly revisiting /settings. The test never creates a privileged
 * user, provisions a broker, or invokes a broker connection endpoint.
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
  const email = `qa-session-${randomBytes(8).toString("hex")}@arx.local`;
  const password = `Session-${randomBytes(12).toString("hex")}`;
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO users (email, name, password_hash, role)
     VALUES ($1, 'QA Session User', $2, 'USER')
     RETURNING id`,
    [email, hashPassword(password)],
  );
  const userId = inserted.rows[0]?.id;
  assert(userId !== undefined, "Could not create the isolated standard-user fixture.");

  const originalEnv = new Map<string, string | undefined>();
  let apiServer: Server | undefined;
  let viteServer: Awaited<ReturnType<typeof createViteServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserContext: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;

  for (const name of DISABLED_BROKER_ENV) {
    originalEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  const priorExecutionFlag = process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"];
  originalEnv.set("ARX_LIVE_BROKER_EXECUTION_ENABLED", priorExecutionFlag);
  process.env["ARX_LIVE_BROKER_EXECUTION_ENABLED"] = "false";

  try {
    const apiApp = (await import("../../artifacts/api-server/src/app.js")).default;
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
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.origin !== uiOrigin) externalBrowserRequests.push(requestUrl.origin);
    });
    await browserContext.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin !== uiOrigin) {
        await route.abort();
        return;
      }
      const method = route.request().method();
      const allowedSessionRequest =
        (requestUrl.pathname === "/api/me" && method === "GET") ||
        (requestUrl.pathname === "/api/auth/login" && method === "POST") ||
        (requestUrl.pathname === "/api/auth/user-logout" && method === "POST");
      if (requestUrl.pathname.startsWith("/api/") && !allowedSessionRequest) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });

    await page.goto(`${uiOrigin}/login`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("input-email").fill(email);
    await page.getByTestId("input-password").fill(password);
    await page.getByTestId("button-submit-login").click();
    await page.waitForURL((url) => url.pathname !== "/login", { timeout: 30_000 });

    const fetchMe = async () => page.evaluate(async () => {
      const response = await fetch("/api/me", { credentials: "include" });
      return {
        status: response.status,
        body: await response.json().catch(() => null) as { user?: { email?: string; role?: string } } | null,
      };
    });
    let me = await fetchMe();
    assert(me.status === 200, `Expected signed-in /api/me to return 200, got ${me.status}.`);
    assert(me.body?.user?.email === email, "The signed-in session did not resolve to the standard test user.");
    assert(me.body?.user?.role === "USER", "The browser session did not use a standard USER account.");
    console.log("PASS  standard USER signs in through /login and /api/me identifies the session");

    await page.reload({ waitUntil: "domcontentloaded" });
    me = await fetchMe();
    assert(me.status === 200 && me.body?.user?.role === "USER", "A full browser refresh did not preserve the USER session.");
    console.log("PASS  full refresh preserves the standard-user session");

    await page.goto(`${uiOrigin}/settings`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByRole("heading", { name: "Settings", exact: true }).waitFor({ timeout: 15_000 });
    } catch {
      const visibleText = await page.locator("body").innerText().catch(() => "");
      throw new Error(
        `The standard user did not reach Settings; current path is ${new URL(page.url()).pathname}. ` +
          `Visible page text: ${visibleText.slice(0, 240).replace(/\s+/g, " ")}`,
      );
    }
    assert(new URL(page.url()).pathname === "/settings", "The standard user could not stay on /settings.");
    console.log("PASS  standard USER can open the allowed /settings route directly");

    await page.getByTestId("button-logout").click();
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
    const signedOut = await fetchMe();
    assert(signedOut.status === 401, `Expected signed-out /api/me to return 401, got ${signedOut.status}.`);
    console.log("PASS  sign-out invalidates /api/me");

    await page.goto(`${uiOrigin}/settings`, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname === "/login", { timeout: 30_000 });
    await page.getByTestId("form-login").waitFor({ timeout: 10_000 });
    console.log("PASS  direct /settings visit after sign-out redirects to /login");

    assert(externalBrowserRequests.length === 0, "The test attempted an external browser connection.");
  } finally {
    await browserContext?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (viteServer) await viteServer.close().catch(() => {});
    if (apiServer) await new Promise<void>((done) => apiServer!.close(() => done()));
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await pool.query(`DELETE FROM auth_user_sessions WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM user_activity_events WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM user_master_live_access WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM user_one_click_settings WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
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
