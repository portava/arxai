// Locks the safety contract of the dev-only scanner outage injection:
//  1. In a dev/test env (NODE_ENV !== production) it can be armed/disarmed.
//  2. It is HARD-GATED to non-production — arming is a no-op when production and
//     ALLOW_DEV_AUTH is unset, so it can never affect a real user.
//  3. ALLOW_DEV_AUTH=true re-enables it in production (controlled testing only).
//
// The gate reads process.env at call-time, so we can mutate the env between
// assertions within a single process and restore it after each case.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isScannerOutageInjectionAllowed,
  isScannerOutageArmed,
  setScannerOutageArmed,
} from "../devScannerOutage.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const keys = ["NODE_ENV", "ALLOW_DEV_AUTH"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    // Leave the flag disarmed so cases don't bleed into each other.
    setScannerOutageArmed(false);
  }
}

test("arms and disarms in a dev/test environment", () => {
  withEnv({ NODE_ENV: "test" }, () => {
    assert.equal(isScannerOutageInjectionAllowed(), true);
    assert.equal(isScannerOutageArmed(), false);

    assert.equal(setScannerOutageArmed(true), true);
    assert.equal(isScannerOutageArmed(), true);

    assert.equal(setScannerOutageArmed(false), false);
    assert.equal(isScannerOutageArmed(), false);
  });
});

test("is inert in production (arming is a no-op, injection not allowed)", () => {
  withEnv({ NODE_ENV: "production", ALLOW_DEV_AUTH: undefined }, () => {
    assert.equal(isScannerOutageInjectionAllowed(), false);
    assert.equal(setScannerOutageArmed(true), false);
    assert.equal(isScannerOutageArmed(), false);
  });
});

test("re-enables injection in production only when ALLOW_DEV_AUTH=true", () => {
  withEnv({ NODE_ENV: "production", ALLOW_DEV_AUTH: "true" }, () => {
    assert.equal(isScannerOutageInjectionAllowed(), true);
    assert.equal(setScannerOutageArmed(true), true);
    assert.equal(isScannerOutageArmed(), true);
  });
});

test("an armed flag stops firing if the env flips back to production", () => {
  // Arm in dev, then prove the call-time gate suppresses it under production.
  withEnv({ NODE_ENV: "test" }, () => {
    setScannerOutageArmed(true);
    assert.equal(isScannerOutageArmed(), true);
  });
  withEnv({ NODE_ENV: "production", ALLOW_DEV_AUTH: undefined }, () => {
    assert.equal(isScannerOutageArmed(), false);
  });
});
