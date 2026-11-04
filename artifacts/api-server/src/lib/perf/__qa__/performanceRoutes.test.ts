import { test } from "node:test";
import assert from "node:assert/strict";

test("performance routes keep real session authorization, include auth latency, and work with one DB connection", { skip: process.env.ARX_PERF_TEST_DB !== "1", timeout: 20_000 }, async () => {
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL!).hostname));
  process.env.ARX_DB_POOL_MAX = "1";
  process.env.NODE_ENV = "production";
  process.env.SESSION_SECRET = "performance-test-secret-local-fixture-only";
  const { pool } = await import("@workspace/db");
  const { default: express } = await import("express");
  const { default: cookieParser } = await import("cookie-parser");
  const { attachAuthUser } = await import("../../auth/middleware.js");
  const { createUserSession } = await import("../../auth/userSessions.js");
  const { perfTimer } = await import("../../../middlewares/perfTimer.js");
  const { default: router } = await import("../../../routes/adminPerformance.js");
  const app = express();
  app.use("/api", perfTimer);
  app.use(async (_q, _r, next) => { await new Promise(r => setTimeout(r, 15)); next(); });
  app.use(cookieParser()); app.use(attachAuthUser); app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/performance`;
  const ids: number[] = [];
  try {
    assert.equal((await fetch(`${base}/action-summary`)).status, 403);
    for (const role of ["USER", "ADMIN"]) {
      const user = await pool.query("INSERT INTO users(email,role,is_system_user) VALUES ($1,$2,true) RETURNING id", [`__perf_http_${role}_${Date.now()}@example.invalid`, role]);
      const id = user.rows[0].id as number; ids.push(id);
      const session = await createUserSession({ userId: id });
      const headers = { cookie: `arx_user_session=${session.rawToken}`, "x-security-role": "ADMIN" };
      const response = await fetch(`${base}/action-summary`, { headers });
      assert.equal(response.status, role === "ADMIN" ? 200 : 403);
      assert.ok(Number(response.headers.get("server-timing")?.split("dur=")[1]) >= 10, "timing includes pre-route work");
      if (role === "ADMIN") {
        const body = await response.json() as { runtime: { database: { total: number } }; actions: unknown[] };
        assert.equal(body.runtime.database.total, 1);
        assert.ok(Array.isArray(body.actions));
        const full = await fetch(base, { headers, signal: AbortSignal.timeout(3_000) });
        assert.equal(full.status, 200, "nested Broker Hub read must not deadlock a one-client pool");
        assert.doesNotMatch(await full.text(), /postgresql:\/\//);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    await pool.query("DELETE FROM users WHERE id = ANY($1::int[])", [ids]);
    await pool.end();
  }
});
