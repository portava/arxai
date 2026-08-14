// Task #705 — Claude Backend Fix Agent safety lock (offline unit suite).
//
// Pins the agent's hard safety boundaries WITHOUT a database or a real model
// call. The provider factory is replaced with an instrumented fake so we can
// (a) prove the service hardwires dryRun=true / applied=false regardless of what
// the model returns, (b) prove redaction reaches the prompt, and (c) prove the
// advisory-only contract is always sent.
//
// Categories locked here:
//   1. Redaction strips keys / tokens / JWTs / connection-string creds / emails
//      / phone numbers, and redacts known-secret ENV values by name.
//   2. Size capping bounds every free-text field.
//   3. Config parsers are NARROW (only exact "true"/"false" flip a flag) and
//      fall back to safe defaults on garbage.
//   4. The service ALWAYS reports dryRun=true / applied=false — there is no
//      APPLY path, even if the model claims it applied a change.
//   5. Non-JSON model output degrades to a `raw` result, never throws.
//   6. The provider only ever receives REDACTED + CAPPED text.
//   7. Every prompt carries the STRICTLY-ADVISORY contract.
//   8. An unconfigured provider fails closed (PROVIDER_NOT_CONFIGURED).
//   9. An invalid model override falls back to the configured model.
//
// Requires Node's experimental module-mock flag (wired into the npm script:
//   pnpm --filter @workspace/api-server run test:fix-agent-safety).

import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── Instrumented provider factory (replaces the real one BEFORE service import).
interface FakeRequest {
  system: string;
  messages: { role: string; content: string }[];
  model: string;
}
let providerConfigured = true;
let nextResponseText = "{}";
let lastRequest: FakeRequest | null = null;

const fakeProvider = {
  name: "replit_managed",
  isConfigured: () => providerConfigured,
  complete: async (req: FakeRequest) => {
    lastRequest = req;
    return {
      text: nextResponseText,
      model: req.model,
      provider: "replit_managed",
      usage: { inputTokens: 11, outputTokens: 22 },
    };
  },
};

const SUPPORTED = ["replit_managed", "anthropic_api_key"];
mock.module("../providers/factory.js", {
  namedExports: {
    getAIProvider: () => fakeProvider,
    isSupportedProvider: (v: string) => SUPPORTED.includes(v),
    SUPPORTED_PROVIDERS: SUPPORTED,
  },
});

// Dynamic imports AFTER the mock so the service binds to the fake factory.
const { redactSecrets, capSize, sanitizeField, redactDeep, MAX_FIELD_CHARS } = await import(
  "../redaction.js"
);
const { getFixAgentConfig, isAllowedModel, DEFAULT_MODEL } = await import("../fixAgentConfig.js");
const { diagnose, proposePatch } = await import("../backendFixAgent.js");

function resetProvider(): void {
  providerConfigured = true;
  nextResponseText = "{}";
  lastRequest = null;
}
afterEach(resetProvider);

// ── Env snapshot/restore for the config-parser tests ────────────────────────
const CLAUDE_ENV_KEYS = [
  "CLAUDE_FIX_AGENT_ENABLED",
  "CLAUDE_FIX_AGENT_DRY_RUN",
  "CLAUDE_PROVIDER",
  "CLAUDE_MODEL",
] as const;
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of CLAUDE_ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of CLAUDE_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── 1. Redaction patterns ───────────────────────────────────────────────────
test("redaction strips API keys, tokens, JWTs, conn-string creds, emails, phones", () => {
  const dirty = [
    "key sk-ant-abc123DEF456ghi789",
    "aws AKIAIOSFODNN7EXAMPLE",
    "gh ghp_0123456789abcdefghijABCDEFG",
    "auth Bearer abcDEF123.ghiJKL456-mno",
    "jwt eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2",
    "db postgres://user:p4ssw0rd@host:5432/db",
    "email ops@example.com",
    "phone +1 (415) 555-2671",
  ].join("\n");
  const clean = redactSecrets(dirty);
  assert.ok(!clean.includes("sk-ant-abc123DEF456ghi789"), "anthropic key leaked");
  assert.ok(!clean.includes("AKIAIOSFODNN7EXAMPLE"), "aws key leaked");
  assert.ok(!clean.includes("ghp_0123456789abcdefghijABCDEFG"), "gh token leaked");
  assert.ok(!clean.includes("eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2"), "jwt leaked");
  assert.ok(!clean.includes("p4ssw0rd"), "conn-string password leaked");
  assert.ok(!clean.includes("ops@example.com"), "email leaked");
  assert.ok(!clean.includes("555-2671"), "phone leaked");
  // Connection scheme/host is preserved; only the credentials are dropped.
  assert.ok(clean.includes("postgres://"), "scheme should be preserved");
  assert.ok(clean.includes("[REDACTED]"), "redaction marker missing");
});

test("redaction scrubs known-secret ENV values by name", () => {
  const NAME = "QA_FIXAGENT_FAKE_SECRET_TOKEN";
  const VALUE = "zzz-unusual-secret-format-987654";
  process.env[NAME] = VALUE;
  try {
    const out = redactSecrets(`leaking ${VALUE} inline`);
    assert.ok(!out.includes(VALUE), "env secret value leaked");
    assert.ok(out.includes(`[REDACTED:${NAME}]`), "env value not redacted by name");
  } finally {
    delete process.env[NAME];
  }
});

test("redactDeep redacts nested strings while preserving structure", () => {
  const out = redactDeep({ a: "email me@x.io", b: [{ c: "sk-ant-secretvalue123456" }], n: 5 }) as {
    a: string;
    b: { c: string }[];
    n: number;
  };
  assert.ok(!out.a.includes("me@x.io"));
  assert.ok(!out.b[0].c.includes("sk-ant-secretvalue123456"));
  assert.equal(out.n, 5);
});

// ── 2. Size capping ─────────────────────────────────────────────────────────
test("capSize bounds long text with a truncation marker; short text is untouched", () => {
  const short = "small";
  assert.equal(capSize(short), short);
  const long = "x".repeat(MAX_FIELD_CHARS + 5000);
  const capped = capSize(long);
  assert.ok(capped.length <= MAX_FIELD_CHARS + 64, "capped string exceeds budget");
  assert.ok(capped.includes("TRUNCATED"), "truncation marker missing");
});

test("sanitizeField redacts then caps; non-strings become empty string", () => {
  assert.equal(sanitizeField(undefined), "");
  assert.equal(sanitizeField(null), "");
  const out = sanitizeField("contact ops@example.com " + "y".repeat(MAX_FIELD_CHARS + 100));
  assert.ok(!out.includes("ops@example.com"), "email survived sanitize");
  assert.ok(out.length <= MAX_FIELD_CHARS + 64, "sanitize did not cap");
});

// ── 3. Narrow config parsers ────────────────────────────────────────────────
test("config: enabled flips ONLY on exact true; dryRun off ONLY on exact false", () => {
  withEnv({ CLAUDE_FIX_AGENT_ENABLED: "true" }, () =>
    assert.equal(getFixAgentConfig().enabled, true),
  );
  withEnv({ CLAUDE_FIX_AGENT_ENABLED: " TRUE " }, () =>
    assert.equal(getFixAgentConfig().enabled, true),
  );
  for (const bad of ["1", "yes", "on", "True!", ""]) {
    withEnv({ CLAUDE_FIX_AGENT_ENABLED: bad }, () =>
      assert.equal(getFixAgentConfig().enabled, false, `enabled flipped on "${bad}"`),
    );
  }
  // dryRun defaults ON; only exact false turns it off.
  withEnv({ CLAUDE_FIX_AGENT_DRY_RUN: undefined }, () =>
    assert.equal(getFixAgentConfig().dryRun, true),
  );
  withEnv({ CLAUDE_FIX_AGENT_DRY_RUN: "false" }, () =>
    assert.equal(getFixAgentConfig().dryRun, false),
  );
  for (const stillDry of ["0", "no", "off", "FALSE!"]) {
    withEnv({ CLAUDE_FIX_AGENT_DRY_RUN: stillDry }, () =>
      assert.equal(getFixAgentConfig().dryRun, true, `dryRun turned off on "${stillDry}"`),
    );
  }
});

test("config: provider/model fall back to safe defaults on unknown values", () => {
  withEnv({ CLAUDE_PROVIDER: "totally_unknown", CLAUDE_MODEL: "gpt-4" }, () => {
    const cfg = getFixAgentConfig();
    assert.equal(cfg.provider, "replit_managed");
    assert.equal(cfg.model, DEFAULT_MODEL);
  });
  withEnv({ CLAUDE_PROVIDER: "anthropic_api_key", CLAUDE_MODEL: "claude-opus-4-8" }, () => {
    const cfg = getFixAgentConfig();
    assert.equal(cfg.provider, "anthropic_api_key");
    assert.equal(cfg.model, "claude-opus-4-8");
  });
  assert.equal(isAllowedModel("claude-sonnet-4-6"), true);
  assert.equal(isAllowedModel("claude-3-5-sonnet-latest"), false);
});

// ── 4. dryRun/applied hardwired — there is NO apply path ─────────────────────
test("proposePatch reports dryRun=true / applied=false even if the model claims otherwise", async () => {
  nextResponseText = JSON.stringify({
    summary: "patch",
    rationale: "because",
    proposedChanges: [{ file: "a.ts", description: "d", diff: "@@ -1 +1 @@" }],
    risks: ["r"],
    testSuggestions: ["t"],
    // Adversarial: the model tries to assert it already applied the change.
    dryRun: false,
    applied: true,
  });
  const { result } = await proposePatch({ errorText: "boom" });
  assert.equal(result.dryRun, true, "dryRun must be hardwired true");
  assert.equal(result.applied, false, "applied must be hardwired false");
  assert.equal(result.proposedChanges.length, 1);
});

// ── 5. Non-JSON output degrades to raw, never throws ─────────────────────────
test("diagnose degrades to a raw result on non-JSON output", async () => {
  nextResponseText = "I cannot return JSON, here is prose only.";
  const { result } = await diagnose({ errorText: "boom" });
  assert.equal(result.raw, true);
  assert.equal(result.severity, "unknown");
  assert.equal(result.confidence, "unknown");
});

test("diagnose maps structured JSON fields and clamps unknown enums", async () => {
  nextResponseText = JSON.stringify({
    summary: "root cause X",
    severity: "high",
    likelyCauses: ["a", "b"],
    affectedAreas: ["api_routes"],
    suggestedChecks: ["check logs"],
    confidence: "medium",
  });
  const { result } = await diagnose({ errorText: "boom", area: "api_routes" });
  assert.equal(result.raw, false);
  assert.equal(result.severity, "high");
  assert.equal(result.confidence, "medium");
  assert.deepEqual(result.likelyCauses, ["a", "b"]);
});

// ── 6. Provider only ever receives redacted + capped text ────────────────────
test("the model only ever receives REDACTED input", async () => {
  nextResponseText = "{}";
  await diagnose({
    errorText: "DB error for ops@example.com using postgres://u:s3cr3t@h/db",
    contextText: "token sk-ant-anothersecret1234567",
    logsText: "x".repeat(MAX_FIELD_CHARS + 9000),
  });
  assert.ok(lastRequest, "provider was not called");
  const sent = lastRequest!.messages.map((m) => m.content).join("\n");
  assert.ok(!sent.includes("ops@example.com"), "email reached the model");
  assert.ok(!sent.includes("s3cr3t"), "conn-string secret reached the model");
  assert.ok(!sent.includes("sk-ant-anothersecret1234567"), "api key reached the model");
  assert.ok(sent.includes("TRUNCATED"), "oversized logs were not capped before sending");
});

// ── 7. The advisory-only contract is always present ──────────────────────────
test("every prompt carries the strictly-advisory safety contract", async () => {
  nextResponseText = "{}";
  await diagnose({ errorText: "boom" });
  const sys = lastRequest!.system;
  assert.ok(/STRICTLY ADVISORY/i.test(sys), "missing advisory declaration");
  assert.ok(/NEVER place, approve, modify, or cancel any trade/i.test(sys), "missing trade ban");
  assert.ok(/override, weaken, or bypass any risk gate or the kill switch/i.test(sys), "missing gate ban");
});

// ── 8. Unconfigured provider fails closed ────────────────────────────────────
test("an unconfigured provider fails closed (PROVIDER_NOT_CONFIGURED)", async () => {
  providerConfigured = false;
  await assert.rejects(() => diagnose({ errorText: "boom" }), /PROVIDER_NOT_CONFIGURED/);
});

// ── 9. Invalid model override falls back to the configured model ──────────────
test("an invalid model override falls back to the configured model", async () => {
  nextResponseText = "{}";
  const { meta } = await diagnose({ errorText: "boom", model: "evil-model-x" });
  assert.ok(["claude-sonnet-4-6", "claude-opus-4-8"].includes(meta.model), "bad model not rejected");
  const ok = await diagnose({ errorText: "boom", model: "claude-opus-4-8" });
  assert.equal(ok.meta.model, "claude-opus-4-8");
});
