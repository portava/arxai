import { test, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.NODE_ENV = "development";
process.env.APP_BASE_URL = "https://arx.example.test";
delete process.env.APP_PUBLIC_ORIGIN;
const realDb = await import("@workspace/db");
let exists = true;
let tokensCreated = 0;
let dummyCalls = 0;
const mails: Array<{ resetLink: string }> = [];
const logs: unknown[] = [];
mock.module("@workspace/db", { namedExports: {
  ...realDb,
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => exists ? [{ id: 7, email: "fixture@example.test" }] : [] }) }) }) },
  passwordResetTokensRepo: { createToken: async () => { tokensCreated++; return { rawToken: "private-reset-token", expiresAt: new Date() }; }, dummyWork: async () => { dummyCalls++; } },
  passwordResetThrottleRepo: { recordAttemptAndCheck: async () => false },
} });
mock.module("../../lib/security/cooldowns.js", { namedExports: { consumeRateLimit: async () => ({ allowed: true }), hashScope: () => "test-scope" } });
mock.module("../../lib/email/passwordResetEmail.js", { namedExports: {
  sendPasswordResetEmail: async (input: { resetLink: string }) => { mails.push(input); return { id: "mail-fixture" }; },
} });
mock.module("../../lib/systemHealth/audit.js", { namedExports: { auditEvent: async () => {} } });
const router = (await import("../auth.js")).default;

test("development forgot-password keeps reset tokens out of responses and logs", async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { info: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args) } as unknown as typeof req.log;
    next();
  });
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/forgot-password`;
  try {
    const send = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "fixture@example.test" }) });
    const found = await send(); const first = await found.json();
    assert.equal(found.status, 200); assert.equal(tokensCreated, 1);
    assert.equal(mails[0]?.resetLink, "https://arx.example.test/reset-password?token=private-reset-token");
    exists = false;
    const missing = await send();
    assert.equal(missing.status, 200); assert.deepEqual(await missing.json(), first); assert.equal(dummyCalls, 1);
    assert.doesNotMatch(JSON.stringify({ first, logs }), /private-reset-token|devResetLink|reset-password\?token/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});
