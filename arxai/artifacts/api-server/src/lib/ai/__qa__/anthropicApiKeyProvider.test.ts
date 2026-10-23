// Task #707 — Raw Anthropic API-key provider proof (offline unit suite).
//
// Proves the "anthropic_api_key" provider is FULLY IMPLEMENTED (not a
// placeholder) and behaves identically to the managed provider through the
// shared AIProvider seam — WITHOUT a real network call. The @anthropic-ai/sdk
// module is replaced with an instrumented fake BEFORE the provider is imported,
// so we can inspect exactly what the provider does with the key, the request,
// and the per-request timeout/retry options.
//
// Categories locked here:
//   1. isConfigured() reflects the ANTHROPIC_API_KEY secret (trimmed); empty /
//      whitespace-only / missing => false (fails closed).
//   2. complete() throws PROVIDER_NOT_CONFIGURED when the key is absent.
//   3. complete() constructs the SDK client with the (trimmed) secret key —
//      i.e. it reads the key from the secret, the operator's own billing.
//   4. complete() forwards model, max_tokens, system, and messages, and honours
//      the per-request timeout + maxRetries (and the safe defaults when unset).
//   5. complete() maps the SDK response into the provider-agnostic shape
//      (text / model / provider="anthropic_api_key" / usage).
//   6. The API key is NEVER logged (no console output ever contains it).
//
// Requires Node's experimental module-mock flag (wired into the npm script:
//   pnpm --filter @workspace/api-server run test:anthropic-api-key-provider).

import { test, mock, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ── Instrumented @anthropic-ai/sdk replacement (BEFORE importing the provider).
interface CreateBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: string; content: string }[];
}
interface CreateOpts {
  timeout: number;
  maxRetries: number;
}

let lastConstructorArgs: { apiKey?: string; baseURL?: string } | null = null;
let lastCreateBody: CreateBody | null = null;
let lastCreateOpts: CreateOpts | null = null;
let nextCreateResult: unknown = null;

class FakeAnthropic {
  messages: { create: (body: CreateBody, opts: CreateOpts) => Promise<unknown> };
  constructor(args: { apiKey?: string; baseURL?: string }) {
    lastConstructorArgs = args;
    this.messages = {
      create: async (body: CreateBody, opts: CreateOpts) => {
        lastCreateBody = body;
        lastCreateOpts = opts;
        return nextCreateResult;
      },
    };
  }
}

mock.module("@anthropic-ai/sdk", { defaultExport: FakeAnthropic });

// Dynamic import AFTER the mock so the provider binds to the fake SDK.
const { AnthropicApiKeyProvider, ANTHROPIC_API_KEY_ENV } = await import(
  "../providers/anthropicApiKeyProvider.js"
);
const { DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES } = await import(
  "../providers/types.js"
);

const SAVED_KEY = process.env[ANTHROPIC_API_KEY_ENV];

function setKey(value: string | undefined): void {
  if (value === undefined) delete process.env[ANTHROPIC_API_KEY_ENV];
  else process.env[ANTHROPIC_API_KEY_ENV] = value;
}

function reset(): void {
  lastConstructorArgs = null;
  lastCreateBody = null;
  lastCreateOpts = null;
  nextCreateResult = {
    content: [{ type: "text", text: "diagnosis" }],
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 42, output_tokens: 7 },
  };
}

beforeEach(reset);
afterEach(() => setKey(SAVED_KEY));

const REQ = {
  system: "advisory contract",
  model: "claude-sonnet-4-6",
  messages: [{ role: "user" as const, content: "what broke?" }],
};

// ── 1. isConfigured reflects the secret (trimmed) ────────────────────────────
test("isConfigured is true only for a non-empty trimmed key", () => {
  const p = new AnthropicApiKeyProvider();
  setKey("sk-ant-real-key-1234567890");
  assert.equal(p.isConfigured(), true);
  setKey("   sk-ant-padded-key-9876543210   ");
  assert.equal(p.isConfigured(), true, "a key with surrounding whitespace is still configured");
  for (const blank of [undefined, "", "   ", "\n\t "]) {
    setKey(blank);
    assert.equal(p.isConfigured(), false, `blank key "${String(blank)}" must fail closed`);
  }
});

test("the provider exposes the stable key name", () => {
  assert.equal(new AnthropicApiKeyProvider().name, "anthropic_api_key");
});

// ── 2. Unconfigured provider fails closed ────────────────────────────────────
test("complete throws PROVIDER_NOT_CONFIGURED when the key is missing", async () => {
  setKey(undefined);
  await assert.rejects(
    () => new AnthropicApiKeyProvider().complete(REQ),
    /PROVIDER_NOT_CONFIGURED:anthropic_api_key/,
  );
  setKey("   ");
  await assert.rejects(
    () => new AnthropicApiKeyProvider().complete(REQ),
    /PROVIDER_NOT_CONFIGURED:anthropic_api_key/,
  );
});

// ── 3. The client is constructed with the (trimmed) secret key ───────────────
test("complete constructs the SDK client with the trimmed secret key", async () => {
  setKey("   sk-ant-padded-key-9876543210   ");
  await new AnthropicApiKeyProvider().complete(REQ);
  assert.ok(lastConstructorArgs, "SDK client was not constructed");
  assert.equal(
    lastConstructorArgs!.apiKey,
    "sk-ant-padded-key-9876543210",
    "the trimmed secret key must be passed to the SDK",
  );
});

// ── 4. Request fields + per-request timeout/retry are forwarded ──────────────
test("complete forwards model/max_tokens/system/messages and timeout/retry", async () => {
  setKey("sk-ant-real-key-1234567890");
  await new AnthropicApiKeyProvider().complete({
    ...REQ,
    maxTokens: 1234,
    timeoutMs: 45_000,
    maxRetries: 5,
  });
  assert.deepEqual(lastCreateBody, {
    model: "claude-sonnet-4-6",
    max_tokens: 1234,
    system: "advisory contract",
    messages: [{ role: "user", content: "what broke?" }],
  });
  assert.deepEqual(lastCreateOpts, { timeout: 45_000, maxRetries: 5 });
});

test("complete applies the safe defaults when maxTokens/timeout/retries are unset", async () => {
  setKey("sk-ant-real-key-1234567890");
  await new AnthropicApiKeyProvider().complete(REQ);
  assert.equal(lastCreateBody!.max_tokens, DEFAULT_MAX_TOKENS);
  assert.equal(lastCreateOpts!.timeout, DEFAULT_TIMEOUT_MS);
  assert.equal(lastCreateOpts!.maxRetries, DEFAULT_MAX_RETRIES);
});

// ── 5. Response maps into the provider-agnostic shape ────────────────────────
test("complete maps the SDK message into the provider-agnostic response", async () => {
  setKey("sk-ant-real-key-1234567890");
  nextCreateResult = {
    content: [
      { type: "text", text: "line one" },
      { type: "tool_use", id: "x" },
      { type: "text", text: "line two" },
    ],
    model: "claude-opus-4-8",
    usage: { input_tokens: 100, output_tokens: 250 },
  };
  const res = await new AnthropicApiKeyProvider().complete(REQ);
  assert.equal(res.text, "line one\n\nline two");
  assert.equal(res.model, "claude-opus-4-8");
  assert.equal(res.provider, "anthropic_api_key");
  assert.deepEqual(res.usage, { inputTokens: 100, outputTokens: 250 });
});

test("complete tolerates missing model/usage on the SDK response", async () => {
  setKey("sk-ant-real-key-1234567890");
  nextCreateResult = { content: [{ type: "text", text: "ok" }] };
  const res = await new AnthropicApiKeyProvider().complete(REQ);
  assert.equal(res.model, REQ.model, "falls back to the requested model");
  assert.deepEqual(res.usage, { inputTokens: null, outputTokens: null });
});

// ── 6. The API key is NEVER logged ───────────────────────────────────────────
test("the API key never reaches any console sink", async () => {
  const SECRET = "sk-ant-this-must-never-be-logged-0001";
  setKey(SECRET);
  const captured: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods) {
    // eslint-disable-next-line no-console
    console[m] = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  }
  try {
    await new AnthropicApiKeyProvider().complete(REQ);
  } finally {
    methods.forEach((m, i) => {
      console[m] = originals[i];
    });
  }
  for (const line of captured) {
    assert.ok(!line.includes(SECRET), "the API key leaked into a console sink");
  }
});
