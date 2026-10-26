import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmailService, readLegacyResendSender, EmailNotConfiguredError, EmailSendError, type EmailConnector } from "../resend.js";

const input = { to: "recipient@example.test", subject: "test", html: "<p>reset-secret</p>", text: "reset-secret" };
function fake() {
  const calls: unknown[] = [];
  const connector: EmailConnector = {
    async listConnections(options) { calls.push(options); return [{ settings: { from_email: "ARX <sender@example.test>" } }]; },
    async proxy(name, path, options) { calls.push({ name, path, options }); return Response.json({ id: "mail-123" }); },
  };
  return { calls, connector };
}
test("read-only email readiness fetches metadata without secrets or sending", async () => {
  const f = fake();
  const r = await createEmailService(f.connector, {}).inspectConfiguration();
  assert.deepEqual(r, { configured: true, deliveryVerified: false, reason: "CONFIGURED_DELIVERY_UNVERIFIED" });
  assert.deepEqual(f.calls, [{ connector_names: "resend", refresh_policy: "none" }]);
  assert.ok(!JSON.stringify(r).includes("sender"));
});
test("missing connector fails even with a configured sender", async () => {
  const f = fake(); f.connector.listConnections = async () => [];
  const service = createEmailService(f.connector, { EMAIL_FROM: "sender@example.test" });
  assert.equal((await service.inspectConfiguration()).configured, false);
  await assert.rejects(service.send(input), EmailNotConfiguredError);
  assert.equal(f.calls.length, 0);
});
test("missing, malformed and injected sender addresses refuse before proxy", async () => {
  for (const sender of ["", "not-a-mailbox", "sender@example.test\r\nBcc: hidden@example.test", "ARX <sender@example.test", "sender@example.test>"]) {
    const f = fake(); f.connector.listConnections = async () => [{ settings: { from_email: sender } }];
    const service = createEmailService(f.connector, {});
    assert.equal((await service.inspectConfiguration()).reason, "SENDER_MISSING_OR_INVALID");
    await assert.rejects(service.send(input), EmailNotConfiguredError);
    assert.equal(f.calls.length, 0);
  }
});
test("proxy retains mail fields and successful acceptance requires a provider ID", async () => {
  const f = fake();
  assert.deepEqual(await createEmailService(f.connector, { EMAIL_FROM: "override@example.test" }).send({ ...input, replyTo: "reply@example.test" }), { id: "mail-123" });
  assert.deepEqual(f.calls[1], { name: "resend", path: "/emails", options: { method: "POST", body: { from: "override@example.test", ...input, reply_to: "reply@example.test" } } });
});
test("2xx empty, malformed and non-ID responses cannot log a false send", async () => {
  for (const body of ["", "not-json", "{}", '{"id":null}', '{"id":"https://secret.example/token"}', '{"id":42}']) {
    const f = fake(); f.connector.proxy = async () => new Response(body, { status: 200 });
    await assert.rejects(createEmailService(f.connector, {}).send(input), EmailSendError);
  }
});
test("provider and transport errors never propagate sensitive response text", async () => {
  const privateText = "reset-secret authorization=private-token recipient@example.test";
  for (const failure of ["lookup", "send", "reject"]) {
    const f = fake();
    if (failure === "lookup") f.connector.listConnections = async () => { throw new Error(privateText); };
    if (failure === "send") f.connector.proxy = async () => { throw new Error(privateText); };
    if (failure === "reject") f.connector.proxy = async () => new Response(privateText, { status: 403 });
    await assert.rejects(createEmailService(f.connector, {}).send(input), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.doesNotMatch(e.message, /reset-secret|private-token|recipient/);
      return true;
    });
  }
});
test("sender cache expires, configuration changes invalidate it and rejection clears it", async () => {
  const f = fake(); let now = 0; const env = { EMAIL_FROM: "first@example.test" };
  const service = createEmailService(f.connector, env, () => now);
  await service.inspectConfiguration(); await service.inspectConfiguration(); assert.equal(f.calls.length, 1);
  now = 300_001; await service.inspectConfiguration(); assert.equal(f.calls.length, 2);
  env.EMAIL_FROM = "second@example.test"; await service.inspectConfiguration(); assert.equal(f.calls.length, 3);
  f.connector.proxy = async () => new Response("no", { status: 401 });
  await assert.rejects(service.send(input));
  await service.inspectConfiguration(); assert.equal(f.calls.length, 4);
});

test("existing settings-only connections retain sender resolution without exposing settings", async () => {
  const f = fake(); let reads = 0;
  f.connector.listConnections = async () => [{ id: "configured" }];
  f.connector.readLegacySender = async () => { reads++; return "sender@example.test"; };
  assert.equal((await createEmailService(f.connector, {}).inspectConfiguration()).configured, true);
  assert.equal(reads, 1);
  await createEmailService(f.connector, { EMAIL_FROM: "override@example.test" }).inspectConfiguration();
  assert.equal(reads, 1);
  f.connector.readLegacySender = async () => { throw new Error("private-key reset-secret"); };
  await assert.rejects(createEmailService(f.connector, {}).send(input), { message: "CONNECTOR_UNAVAILABLE" });
});

test("legacy adapter extracts only sender, bounds request and redacts failures", async () => {
  const connector = { async getProxyHeaders() { return { "test-header": "fake-identity" }; } };
  const transport: typeof fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/connectors\.replit\.com\/api\/v2\/connection\?/);
    assert.ok(options?.signal);
    return Response.json({ items: [{ settings: { from_email: "sender@example.test", api_key: "private-key" } }] });
  };
  assert.equal(await readLegacyResendSender(connector, {}, transport), "sender@example.test");
  await assert.rejects(readLegacyResendSender(connector, {}, async () => { throw new Error("private-key"); }), { message: "CONNECTOR_UNAVAILABLE" });
  await assert.rejects(readLegacyResendSender(connector, { REPLIT_CONNECTORS_HOSTNAME: "host/path" }, transport), { message: "CONNECTOR_UNAVAILABLE" });
});
