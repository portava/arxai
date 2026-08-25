// Ruling 15 — new-mode credentials must NEVER reach the legacy transport.
//
// Deriv's new API is a different GENERATION, not a second credential format:
// legacy app ids do not work with the new APIs, and PATs do not work with
// legacy `authorize`. The old code bridged them anyway — substituting bootstrap
// app_id 1089 and sending the PAT to legacy `authorize` — which made two
// perfectly valid demo tokens present as `InvalidToken` and cost a full
// diagnostic cycle to attribute correctly.
//
// These tests pin the separation, not the spelling of any one line.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../derivWsClient.ts", import.meta.url), "utf8");

// The class is intentionally not exported; getDerivWsClient().getMode()
// delegates to detectMode(), so the classification is exercised through the
// module's real public surface.
const { getDerivWsClient, DERIV_NEW_API_NOT_IMPLEMENTED } =
  await import("../derivWsClient.js");
const detectMode = () => getDerivWsClient().getMode();

/** Run a body with a temporary env, always restoring it. */
function withEnv(env: Record<string, string | undefined>, body: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the refusal sentinel is explicit and is NOT a credential verdict", () => {
  assert.equal(DERIV_NEW_API_NOT_IMPLEMENTED, "DERIV_NEW_API_NOT_IMPLEMENTED");
  // The whole point of Ruling 15: an unimplemented transport must never be
  // reported as a rejected token.
  assert.ok(!/InvalidToken/i.test(DERIV_NEW_API_NOT_IMPLEMENTED));
});

test("alphanumeric app id + PAT is still CLASSIFIED as new mode (support is kept)", () => {
  withEnv({
    DERIV_API_MODE: "auto",
    DERIV_APP_ID: "33mVSM4MR95zbFCS2LKxS",
    DERIV_API_TOKEN: "x".repeat(68),
  }, () => {
    // Ruling 15 keeps the branch. Classification must stay correct — the
    // defect was the ROUTE, not the recognition of these credentials.
    assert.equal(detectMode(), "new");
  });
});

test("a numeric app id still selects legacy — the certification path is untouched", () => {
  withEnv({ DERIV_API_MODE: "auto", DERIV_APP_ID: "1089", DERIV_API_TOKEN: "a1-abc" }, () => {
    assert.equal(detectMode(), "legacy");
  });
  withEnv({ DERIV_API_MODE: "legacy", DERIV_APP_ID: "1089", DERIV_API_TOKEN: "a1-abc" }, () => {
    assert.equal(detectMode(), "legacy");
  });
});

test("the bootstrap-1089 compatibility shim is GONE", () => {
  // The removed shim: `const bootstrap = (... ?? "1089")` inside the new-mode
  // branch of resolveWsUrl, which then built a legacy URL from it.
  const fnStart = src.indexOf("private async resolveWsUrl");
  assert.ok(fnStart > -1, "resolveWsUrl must exist");
  const start = src.indexOf('if (mode === "new")', fnStart);
  const end = src.indexOf('if (mode === "legacy")', start);
  assert.ok(start > -1 && end > start, "both mode branches must exist");
  // Strip comments first: the explanatory comment necessarily NAMES the shim
  // it replaced, and matching prose instead of code has already produced three
  // false failures in this codebase.
  const newBranch = src.slice(start, end)
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/1089/.test(newBranch), "new mode must not substitute a bootstrap app id");
  assert.ok(!/app_id=/.test(newBranch), "new mode must not build a legacy WS URL");
  assert.match(newBranch, /return null;/, "new mode must refuse to resolve a URL");
});

test("legacy mode still resolves a URL from its own app id (no collateral damage)", () => {
  const fnStart = src.indexOf("private async resolveWsUrl");
  const start = src.indexOf('if (mode === "legacy")', fnStart);
  const legacyBranch = src.slice(start, start + 400);
  assert.match(legacyBranch, /app_id=\$\{encodeURIComponent\(legacyId\)\}/);
});

test("a PAT can never reach legacy authorize — a second barrier guards the call site", () => {
  const authorizeIdx = src.indexOf("this.request({ authorize: token })");
  assert.ok(authorizeIdx > -1, "the legacy authorize call must exist");
  // Everything guarding it, from the socket-open handler down to the call.
  const openIdx = src.indexOf('ws.on("open"');
  const guarded = src.slice(openIdx, authorizeIdx);
  assert.match(
    guarded,
    /detectMode\(\) === "new"[\s\S]*?return;/,
    "new mode must return BEFORE the legacy authorize call",
  );
});

test("the quarantine reports a transport gap, never a bad credential", () => {
  const openIdx = src.indexOf('ws.on("open"');
  const authorizeIdx = src.indexOf("this.request({ authorize: token })");
  const guarded = src.slice(openIdx, authorizeIdx);
  assert.match(guarded, /lastAuthorizeErrorCode = DERIV_NEW_API_NOT_IMPLEMENTED/);
});

test("the real new-API flow is documented as the follow-up, not silently dropped", () => {
  // Ruling 15 KEEPS this generation; the file must say what implementing it
  // actually requires, so the branch is not mistaken for dead code.
  assert.match(src, /Bearer PAT \+ Deriv-App-ID/);
  assert.match(src, /OTP/);
  assert.match(src, /Ruling 15/);
});
