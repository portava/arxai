// Per-attempt deadlines in the market data router.
//
// The defect these guard: with no feed attached — the state a fresh install is
// in — every symbol walked the full provider chain and each hop failed only as
// fast as the underlying call happened to fail. Nothing in the router or in six
// of its seven non-WebSocket providers bounded a request. The scanner fans out
// over the approved universe at a shared concurrency of 8, so a few slow hops
// parked every worker and a scan that should say "no feed" in a fraction of a
// second took tens of seconds to say exactly the same thing.
//
// The honesty half matters as much as the speed half: a timeout is NOT the
// provider answering "no data". It is silence, and it must be recorded as
// silence so an admin reading the attempt trail can tell the two apart.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  withAttemptDeadline,
  PROVIDER_ATTEMPT_TIMEOUT_MS,
  type ProviderAttempt,
} from "../marketDataRouter.js";

type Attempt = ProviderAttempt & { candles: unknown[] };

const onTimeout = (a: ProviderAttempt): Attempt => ({ ...a, candles: [] });

describe("router attempt deadline — the wait is bounded", () => {
  test("a provider that never answers is abandoned at the deadline", async () => {
    const started = Date.now();
    // A promise that never settles is the exact shape of the failure being
    // guarded: not a rejection, not a slow success — nothing at all.
    const r = await withAttemptDeadline<Attempt>(
      "mt5_broker",
      50,
      () => new Promise<Attempt>(() => {}),
      onTimeout,
    );
    const elapsed = Date.now() - started;
    assert.equal(r.ok, false, "an unanswered provider must not read as ok");
    assert.ok(elapsed < 1_000, `the caller waited ${elapsed}ms — the deadline did not bound it`);
  });

  test("a provider answering inside the deadline is returned untouched", async () => {
    const real: Attempt = { provider: "deriv", ok: true, reason: null, candleCount: 3, ms: 1, candles: [1, 2, 3] };
    const r = await withAttemptDeadline<Attempt>("deriv", 500, async () => real, onTimeout);
    assert.equal(r, real, "a live answer must pass through by identity, not be rebuilt");
    assert.equal(r.candles.length, 3);
  });

  test("a provider that answers slowly but within the deadline still wins", async () => {
    const r = await withAttemptDeadline<Attempt>("assistant_real", 400, async () => {
      await new Promise((res) => setTimeout(res, 60));
      return { provider: "assistant_real", ok: true, reason: null, candleCount: 1, ms: 60, candles: [1] };
    }, onTimeout);
    assert.equal(r.ok, true, "a slow-but-answering provider must not be cut off early");
  });
});

describe("router attempt deadline — silence is recorded as silence", () => {
  test("the timeout reason says the provider did not respond, never that it refused", async () => {
    const r = await withAttemptDeadline<Attempt>(
      "mt5_broker",
      20,
      () => new Promise<Attempt>(() => {}),
      onTimeout,
    );
    assert.match(r.reason ?? "", /PROVIDER_TIMEOUT_MS/, "the reason must carry a machine-readable timeout code");
    assert.match(r.reason ?? "", /did not respond/i, "the reason must state that the provider did not respond");
    assert.doesNotMatch(
      r.reason ?? "",
      /no data|not available|unsupported|refus/i,
      "silence must never be reported using the vocabulary of a negative ANSWER — an admin " +
        "reading the attempt trail has to be able to tell 'we did not hear back' from 'it said no'",
    );
  });

  test("the timed-out attempt carries the provider it was waiting on", async () => {
    const r = await withAttemptDeadline<Attempt>("deriv", 20, () => new Promise<Attempt>(() => {}), onTimeout);
    assert.equal(r.provider, "deriv", "an attempt trail that loses which provider was silent is not a trail");
    assert.equal(r.candleCount, 0);
  });

  test("a rejecting provider surfaces its own failure, not a timeout", async () => {
    await assert.rejects(
      () => withAttemptDeadline<Attempt>("deriv", 500, async () => { throw new Error("UPSTREAM_401"); }, onTimeout),
      /UPSTREAM_401/,
      "a real error must propagate — masking it as a timeout would hide the actual cause",
    );
  });
});

describe("router attempt deadline — the configured bound is sane", () => {
  test("the default deadline is short enough to keep a universe scan responsive", () => {
    // The scanner runs five sequential passes over the universe at concurrency
    // 8. If a single hop could take longer than this, a no-feed scan stops
    // being a fast honest answer and becomes a hang.
    assert.ok(
      PROVIDER_ATTEMPT_TIMEOUT_MS > 0 && PROVIDER_ATTEMPT_TIMEOUT_MS <= 10_000,
      `PROVIDER_ATTEMPT_TIMEOUT_MS is ${PROVIDER_ATTEMPT_TIMEOUT_MS}ms — outside the range that keeps a scan usable`,
    );
  });
});
