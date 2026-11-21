import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePublicOrigin } from "../publicOrigin.js";

test("reset links honor the launcher's APP_BASE_URL and explicit public origin", () => {
  assert.equal(resolvePublicOrigin({ NODE_ENV: "production", APP_BASE_URL: "https://arx.example.test/" }), "https://arx.example.test");
  assert.equal(resolvePublicOrigin({ NODE_ENV: "production", APP_PUBLIC_ORIGIN: "https://public.example.test/", APP_BASE_URL: "https://base.example.test" }), "https://public.example.test");
  assert.equal(resolvePublicOrigin({ NODE_ENV: "production", REPLIT_DOMAINS: "arx.example.test,second.example.test" }), "https://arx.example.test");
});
test("production cannot send reset links to localhost or a development preview", () => {
  for (const value of ["", "http://arx.example.test", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://preview.replit.dev", "https://app.localhost"]) {
    assert.throws(() => resolvePublicOrigin({ NODE_ENV: "production", APP_BASE_URL: value }), /PUBLIC_ORIGIN_NOT_CONFIGURED/);
  }
  assert.throws(() => resolvePublicOrigin({ NODE_ENV: "production", REPLIT_DEV_DOMAIN: "preview.replit.dev" }), /PUBLIC_ORIGIN_NOT_CONFIGURED/);
});
test("invalid configured origins fail closed and never expose their value", () => {
  for (const value of ["https://user:secret@arx.example.test", "https://arx.example.test/path", "https://arx.example.test/?token=secret", "javascript:secret", "https://arx.example.test/#secret"]) {
    assert.throws(() => resolvePublicOrigin({ NODE_ENV: "production", APP_PUBLIC_ORIGIN: value, REPLIT_DOMAINS: "valid.example.test" }), e => {
      assert.equal((e as Error).message, "PUBLIC_ORIGIN_NOT_CONFIGURED"); return true;
    });
  }
});
test("development retains explicit local and Replit preview fallbacks", () => {
  assert.equal(resolvePublicOrigin({ NODE_ENV: "development" }), "http://localhost");
  assert.equal(resolvePublicOrigin({ NODE_ENV: "test", REPLIT_DEV_DOMAIN: "preview.replit.dev" }), "https://preview.replit.dev");
  assert.equal(resolvePublicOrigin({ NODE_ENV: "development", APP_PUBLIC_ORIGIN: "http://localhost:24210/" }), "http://localhost:24210");
});

test("local-only reset links use the exact listening origin", () => {
  const local = { NODE_ENV: "production", ARX_LOOPBACK_ONLY: "true", PORT: "48121", APP_BASE_URL: "http://127.0.0.1:48121" };
  assert.equal(resolvePublicOrigin(local), local.APP_BASE_URL);
  assert.throws(() => resolvePublicOrigin({ ...local, APP_PUBLIC_ORIGIN: "https://remote.example" }));
  assert.throws(() => resolvePublicOrigin({ ...local, PORT: "48122" }));
});
