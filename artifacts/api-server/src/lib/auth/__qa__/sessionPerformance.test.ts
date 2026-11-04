import { test } from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.ARX_PERF_TEST_DB === "1";

test("session polling avoids redundant writes while revocation, expiry and role changes remain immediate", { skip: !enabled }, async (t) => {
  const url = new URL(process.env.DATABASE_URL ?? "http://missing");
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Use an isolated localhost test database");
  const { pool } = await import("@workspace/db");
  const { createUserSession, findUserBySessionToken, destroyUserSession, hashToken } = await import("../userSessions.js");
  const user = await pool.query("INSERT INTO users(email, role, is_system_user) VALUES ($1, 'USER', true) RETURNING id", [`__perf_session_${Date.now()}@example.invalid`]);
  const id = user.rows[0].id as number;
  try {
    const session = await createUserSession({ userId: id });
    const original = pool.query.bind(pool);
    let writes = 0;
    // Count executed statements, not estimates from a SQL source scan.
    const spy = t.mock.method(pool, "query", (...args: any[]) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
      if (/^update "auth_user_sessions"/i.test(sql)) writes++;
      return (original as (...args: any[]) => any)(...args);
    });
    const start = performance.now();
    const reads = await Promise.all(Array.from({ length: 100 }, () => findUserBySessionToken(session.rawToken)));
    assert.ok(reads.every(u => u?.id === id));
    t.diagnostic(JSON.stringify({ requests: 100, sessionUpdates: writes, elapsedMs: performance.now() - start }));
    assert.equal(writes, 0, "recent sessions need no last-seen writes");
    spy.mock.restore();
    await pool.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [id]);
    assert.equal((await findUserBySessionToken(session.rawToken))?.role, "ADMIN");
    await pool.query("UPDATE auth_user_sessions SET last_seen_at = now() - interval '2 minutes' WHERE token_hash = $1", [hashToken(session.rawToken)]);
    await Promise.all(Array.from({ length: 20 }, () => findUserBySessionToken(session.rawToken)));
    // Wait for the nonblocking telemetry write, which uses the same pool.
    await new Promise(r => setTimeout(r, 25));
    const touched = await pool.query("SELECT last_seen_at > now() - interval '1 minute' AS recent FROM auth_user_sessions WHERE token_hash = $1", [hashToken(session.rawToken)]);
    assert.equal(touched.rows[0].recent, true);
    await destroyUserSession(session.rawToken);
    assert.equal(await findUserBySessionToken(session.rawToken), null);
    const expired = await createUserSession({ userId: id });
    await pool.query("UPDATE auth_user_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(expired.rawToken)]);
    assert.equal(await findUserBySessionToken(expired.rawToken), null);
  } finally {
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
    await pool.end();
  }
});
