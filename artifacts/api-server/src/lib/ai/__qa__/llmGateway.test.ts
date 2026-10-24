// The LLM gateway's own rules: a call that hangs is cut off, and provider
// status never exposes the key. Pure: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatProviderConfigured, withTimeout } from "../llmGateway.js";

test("a call slower than its timeout is rejected with a named timeout", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "trade_coach"), /llm_timeout:trade_coach/);
  assert.equal(await withTimeout(Promise.resolve("ok"), 1_000, "trade_coach"), "ok");
});

test("provider status is a boolean and never the key", () => {
  const prev = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  try {
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "sk-test-secret";
    assert.equal(chatProviderConfigured(), true);
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "  ";
    assert.equal(chatProviderConfigured(), false);
  } finally {
    if (prev === undefined) delete process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]; else process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = prev;
  }
});
