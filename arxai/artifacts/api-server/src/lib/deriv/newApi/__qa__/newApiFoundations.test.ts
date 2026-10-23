// Deriv NEW API — errors, REST client, account selection, OTP (spec Phases
// 1, 2, 10, 11, 13). Deterministic: fetch is injected, no socket, no network.
//
// The properties under test are the ones that cost real diagnostic cycles:
// a credential failure must be distinguishable from a transport failure, a
// real-money account must never be selected implicitly, and neither the PAT
// nor the OTP URL may ever reach a log or an error message.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DerivNewApiError, classifyHttpStatus, isRetryableOtpFailure,
} from "../errors.js";
import {
  derivRestRequest, describeConfig, resolveNewApiConfig, DERIV_NEW_API_BASE,
} from "../restClient.js";
import {
  normalizeAccount, selectDemoAccount, isDemoAccount, isRealAccount,
  type DerivNewApiAccount,
} from "../accounts.js";
import {
  parseOtpResponse, isTicketUsable, requestOtpTicket, describeOtpUrlForLog,
  otpPath, DERIV_OTP_SAFE_AGE_MS,
} from "../otp.js";

const PAT = "pat-SUPER-SECRET-value-do-not-leak";
const CONFIG = { appId: "33mVSM4MR95zbFCS2LKxS", token: PAT };

/**
 * Returns a REAL Response, not a hand-rolled object.
 *
 * The previous fixture was `{ok, status, json}` cast to Response. It had no
 * `headers` and no `text()`, so client code touching either crashed with a
 * TypeError that surfaced as an undefined error code — and it could never have
 * caught the single-use-body-stream bug, because it had no stream. A real
 * Response also derives `ok` from the status rather than trusting a flag.
 */
function fakeFetch(res: {
  ok?: boolean; status?: number; json?: unknown; body?: string;
  contentType?: string; headers?: Record<string, string>; throws?: Error;
}): typeof fetch {
  return (async (_url: string, _init?: RequestInit) => {
    if (res.throws) throw res.throws;
    const body = res.body ?? (res.json === undefined ? "" : JSON.stringify(res.json));
    return new Response(body, {
      status: res.status ?? 200,
      headers: { "content-type": res.contentType ?? "application/json", ...(res.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
}

// ── Error taxonomy (Phase 10) ───────────────────────────────────────────────

test("401 and 403 are DISTINCT — wrong token vs insufficient scope", () => {
  assert.equal(classifyHttpStatus(401), "DERIV_NEW_API_UNAUTHORIZED");
  assert.equal(classifyHttpStatus(403), "DERIV_NEW_API_INSUFFICIENT_SCOPE");
  assert.notEqual(classifyHttpStatus(401), classifyHttpStatus(403));
});

test("a protocol error is never classified as a credential failure", () => {
  assert.equal(classifyHttpStatus(500), "DERIV_NEW_API_PROTOCOL_ERROR");
  assert.equal(classifyHttpStatus(502), "DERIV_NEW_API_PROTOCOL_ERROR");
  for (const s of [500, 502, 400, 408]) {
    assert.notEqual(classifyHttpStatus(s), "DERIV_NEW_API_UNAUTHORIZED");
  }
});

test("only an expired OTP is retryable", () => {
  assert.equal(isRetryableOtpFailure("DERIV_NEW_API_OTP_EXPIRED"), true);
  for (const c of ["DERIV_NEW_API_UNAUTHORIZED", "DERIV_NEW_API_OTP_FAILED"] as const) {
    assert.equal(isRetryableOtpFailure(c), false);
  }
});

// ── REST client + secret discipline (Phase 11) ──────────────────────────────

test("the PAT never appears in a thrown error from any failure path", async () => {
  for (const scenario of [
    { ok: false, status: 401, json: { error: { code: "InvalidToken" } } },
    { ok: false, status: 403, json: { error: { code: "NoScope" } } },
    { ok: false, status: 500, json: {} },
    { throws: new Error(`network failed calling ${DERIV_NEW_API_BASE} with ${PAT}`) },
  ]) {
    await assert.rejects(
      () => derivRestRequest({ method: "GET", path: "/x", config: CONFIG, fetchImpl: fakeFetch(scenario) }),
      (err: Error) => {
        const serialized = `${err.message} ${JSON.stringify(err)} ${err.stack ?? ""}`;
        assert.ok(!serialized.includes(PAT), "the PAT must never appear in an error");
        return true;
      },
    );
  }
});

test("Deriv's enum-like code survives, its prose does not", async () => {
  await assert.rejects(
    () => derivRestRequest({
      method: "GET", path: "/x", config: CONFIG,
      fetchImpl: fakeFetch({ ok: false, status: 401, json: { error: { code: "InvalidToken", message: "secret-ish prose" } } }),
    }),
    (err: DerivNewApiError) => {
      assert.equal(err.code, "DERIV_NEW_API_UNAUTHORIZED");
      assert.equal(err.derivCode, "InvalidToken");
      assert.equal(err.httpStatus, 401);
      assert.ok(!err.message.includes("secret-ish prose"));
      return true;
    },
  );
});

test("the request carries Deriv-App-ID and Bearer auth", async () => {
  let seen: RequestInit | undefined;
  const spy = (async (_u: string, init?: RequestInit) => {
    seen = init;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  await derivRestRequest({ method: "GET", path: "/x", config: CONFIG, fetchImpl: spy });
  const headers = seen?.headers as Record<string, string>;
  assert.equal(headers["Deriv-App-ID"], CONFIG.appId);
  assert.equal(headers.Authorization, `Bearer ${PAT}`);
  assert.equal(headers["Content-Type"], "application/json");
});

test("describeConfig reports presence and metadata only — never content", () => {
  const saved = process.env["DERIV_API_TOKEN"];
  try {
    process.env["DERIV_API_TOKEN"] = PAT;
    const d = describeConfig();
    assert.equal(d.patPresent, true);
    assert.equal(d.patLength, PAT.length);
    assert.ok(!JSON.stringify(d).includes(PAT), "no field may carry the PAT itself");
  } finally {
    if (saved === undefined) delete process.env["DERIV_API_TOKEN"];
    else process.env["DERIV_API_TOKEN"] = saved;
  }
});

test("missing config is a typed refusal, not a thrown message", () => {
  const saved = { a: process.env["DERIV_APP_ID"], t: process.env["DERIV_API_TOKEN"] };
  try {
    delete process.env["DERIV_APP_ID"];
    process.env["DERIV_API_TOKEN"] = PAT;
    assert.equal(resolveNewApiConfig(), "DERIV_NEW_API_INVALID_APP_ID");
    process.env["DERIV_APP_ID"] = "abc";
    delete process.env["DERIV_API_TOKEN"];
    assert.equal(resolveNewApiConfig(), "DERIV_NEW_API_UNAUTHORIZED");
  } finally {
    if (saved.a === undefined) delete process.env["DERIV_APP_ID"]; else process.env["DERIV_APP_ID"] = saved.a;
    if (saved.t === undefined) delete process.env["DERIV_API_TOKEN"]; else process.env["DERIV_API_TOKEN"] = saved.t;
  }
});

// ── Account discovery + selection (Phase 1) ─────────────────────────────────

const demo = (over: Partial<DerivNewApiAccount> = {}): DerivNewApiAccount => ({
  accountId: "ACC-DEMO-1", accountType: "demo", currency: "USD",
  status: "active", balance: 10000, ...over,
});

test("an account with no usable identifier is skipped, never invented", () => {
  assert.equal(normalizeAccount({ currency: "USD" }), null);
  assert.equal(normalizeAccount(null), null);
  assert.equal(normalizeAccount("x"), null);
  assert.equal(normalizeAccount({ account_id: "A1" })?.accountId, "A1");
});

test("balance is null when absent — never defaulted to 0", () => {
  assert.equal(normalizeAccount({ account_id: "A1" })?.balance, null);
  assert.equal(normalizeAccount({ account_id: "A1", balance: 0 })?.balance, 0);
});

test("an UNKNOWN account type is never treated as demo", () => {
  assert.equal(isDemoAccount(demo({ accountType: null })), false);
  assert.equal(isDemoAccount(demo({ accountType: "something" })), false);
  assert.equal(isDemoAccount(demo({ accountType: "demo" })), true);
  assert.equal(isRealAccount(demo({ accountType: "real" })), true);
});

test("a real account is NEVER selected implicitly, even when it is the only one", () => {
  const r = selectDemoAccount([demo({ accountId: "R1", accountType: "real" })]);
  assert.ok(r instanceof DerivNewApiError);
  assert.equal((r as DerivNewApiError).code, "DERIV_NEW_API_NO_DEMO_ACCOUNT");
});

test("exactly one active demo is selected; two are AMBIGUOUS, not a guess", () => {
  const one = selectDemoAccount([demo()]);
  assert.ok(!(one instanceof DerivNewApiError));
  assert.equal((one as { reason: string }).reason, "SOLE_ACTIVE_DEMO");

  const two = selectDemoAccount([demo({ accountId: "D1" }), demo({ accountId: "D2" })]);
  assert.ok(two instanceof DerivNewApiError);
  assert.equal((two as DerivNewApiError).code, "DERIV_NEW_API_ACCOUNT_AMBIGUOUS");
});

test("an explicitly configured REAL account is REFUSED, not honoured", () => {
  const r = selectDemoAccount(
    [demo({ accountId: "R1", accountType: "real" })], "R1",
  );
  assert.ok(r instanceof DerivNewApiError, "explicit config is not authority to trade real money");
  assert.equal((r as DerivNewApiError).code, "DERIV_NEW_API_NO_DEMO_ACCOUNT");
});

test("explicit config wins over sole-demo inference when it IS a demo", () => {
  const sel = selectDemoAccount([demo({ accountId: "D1" }), demo({ accountId: "D2" })], "D2");
  assert.ok(!(sel instanceof DerivNewApiError));
  assert.equal((sel as { account: DerivNewApiAccount }).account.accountId, "D2");
  assert.equal((sel as { reason: string }).reason, "EXPLICIT_CONFIG");
});

// ── OTP (Phase 2) ───────────────────────────────────────────────────────────

test("the OTP path is built from the account id, not manufactured", () => {
  assert.equal(otpPath("ACC 1"), "/trading/v1/options/accounts/ACC%201/otp");
});

test("a REAL-account socket URL is refused at the last visible moment", () => {
  const r = parseOtpResponse({ ws_url: "wss://api.derivws.com/trading/v1/options/ws/real?otp=X" });
  assert.ok(r instanceof DerivNewApiError);
  assert.equal((r as DerivNewApiError).code, "DERIV_NEW_API_NO_DEMO_ACCOUNT");
});

test("a demo socket URL is accepted; a missing or non-wss URL is a PROTOCOL error", () => {
  assert.equal(
    parseOtpResponse({ ws_url: "wss://api.derivws.com/trading/v1/options/ws/demo?otp=X" }),
    "wss://api.derivws.com/trading/v1/options/ws/demo?otp=X",
  );
  for (const bad of [{}, { ws_url: "" }, { ws_url: "https://x/y" }, null]) {
    const r = parseOtpResponse(bad);
    assert.ok(r instanceof DerivNewApiError, JSON.stringify(bad));
    assert.equal((r as DerivNewApiError).code, "DERIV_NEW_API_PROTOCOL_ERROR");
  }
});

test("a ticket is single-use and ages out before the documented validity", () => {
  const t = { wsUrl: "wss://x/ws/demo?otp=1", issuedAtMs: 1_000, consumed: false };
  assert.equal(isTicketUsable(t, 1_000), true);
  assert.equal(isTicketUsable(t, 1_000 + DERIV_OTP_SAFE_AGE_MS - 1), true);
  assert.equal(isTicketUsable(t, 1_000 + DERIV_OTP_SAFE_AGE_MS), false, "must expire before Deriv's 120s");
  assert.equal(isTicketUsable({ ...t, consumed: true }, 1_000), false, "never reusable once dialled");
});

test("the OTP URL is redacted for logs — the query, which holds the OTP, is dropped", () => {
  const url = "wss://api.derivws.com/trading/v1/options/ws/demo?otp=SUPERSECRETOTP";
  const described = describeOtpUrlForLog(url);
  assert.ok(!described.includes("SUPERSECRETOTP"), "the OTP must never survive redaction");
  assert.ok(!described.includes("?"), "the query string must be dropped entirely");
  assert.match(described, /^wss:\/\/api\.derivws\.com\/trading\/v1\/options\/ws\/demo$/);
});

test("an OTP failure is not reported as a credential failure", async () => {
  await assert.rejects(
    () => requestOtpTicket({
      accountId: "D1", config: CONFIG,
      fetchImpl: fakeFetch({ ok: false, status: 500, json: {} }),
    }),
    (err: DerivNewApiError) => {
      assert.equal(err.code, "DERIV_NEW_API_OTP_FAILED");
      return true;
    },
  );
  // ...but a genuine 401 on the OTP call still reads as unauthorized.
  await assert.rejects(
    () => requestOtpTicket({
      accountId: "D1", config: CONFIG,
      fetchImpl: fakeFetch({ ok: false, status: 401, json: {} }),
    }),
    (err: DerivNewApiError) => {
      assert.equal(err.code, "DERIV_NEW_API_UNAUTHORIZED");
      return true;
    },
  );
});

// ── Credential-rejection diagnostics ────────────────────────────────────────

test("a 401 with an EMPTY body is distinguishable from an application refusal", async () => {
  // This is the exact live symptom. Deriv's application errors carry a JSON
  // error.code; a bare 401 means the request never reached the application,
  // which points at the App ID rather than the token's validity. Without the
  // body shape the two are indistinguishable and the operator has to guess.
  await assert.rejects(
    () => derivRestRequest({
      method: "GET", path: "/x", config: CONFIG,
      fetchImpl: fakeFetch({ status: 401, body: "", contentType: "text/html" }),
    }),
    (err: DerivNewApiError) => {
      assert.equal(err.code, "DERIV_NEW_API_UNAUTHORIZED");
      assert.equal(err.derivCode, null);
      assert.equal(err.bodyShape, "text/html 0B");
      return true;
    },
  );
});

test("the WWW-Authenticate enum is captured but its prose description is NOT", async () => {
  await assert.rejects(
    () => derivRestRequest({
      method: "GET", path: "/x", config: CONFIG,
      fetchImpl: fakeFetch({
        status: 401, body: "",
        headers: {
          "www-authenticate":
            'Bearer realm="deriv", error="invalid_token", error_description="token echoing REQUEST-CONTEXT here"',
        },
      }),
    }),
    (err: DerivNewApiError) => {
      assert.equal(err.authChallenge, "invalid_token");
      // error_description is prose and can echo request context — the whole
      // reason Deriv's messages are never propagated.
      const blob = `${err.message} ${JSON.stringify(err)}`;
      assert.ok(!blob.includes("REQUEST-CONTEXT"), "challenge prose leaked");
      return true;
    },
  );
});

test("a non-JSON error body no longer hides the status classification", async () => {
  // The first version called res.json() and would throw on an HTML body
  // BEFORE it could report anything. A response stream is single-use, so the
  // body is now read once as text and parsed from that string.
  await assert.rejects(
    () => derivRestRequest({
      method: "GET", path: "/x", config: CONFIG,
      fetchImpl: fakeFetch({ status: 403, body: "<html>denied</html>", contentType: "text/html" }),
    }),
    (err: DerivNewApiError) => {
      assert.equal(err.code, "DERIV_NEW_API_INSUFFICIENT_SCOPE");
      assert.equal(err.bodyShape, "text/html 19B");
      assert.ok(!err.message.includes("denied"), "venue prose leaked");
      return true;
    },
  );
});

test("authMode omits a header WITHOUT changing how headers are built", async () => {
  // The probe must not construct its own request — one place builds credential
  // headers. It selects among them.
  const sent: Array<Record<string, string>> = [];
  const spy = (async (_u: string, init?: RequestInit) => {
    sent.push((init?.headers ?? {}) as Record<string, string>);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  await derivRestRequest({ method: "GET", path: "/x", config: CONFIG, fetchImpl: spy, authMode: "app-id-only" });
  assert.ok(!("Authorization" in sent[0]!), "app-id-only must send NO credential");
  assert.equal(sent[0]!["Deriv-App-ID"], CONFIG.appId);

  await derivRestRequest({ method: "GET", path: "/x", config: CONFIG, fetchImpl: spy, authMode: "bearer-only" });
  assert.ok(!("Deriv-App-ID" in sent[1]!));
  assert.ok(sent[1]!["Authorization"]!.startsWith("Bearer "));

  await derivRestRequest({ method: "GET", path: "/x", config: CONFIG, fetchImpl: spy });
  assert.equal(sent[2]!["Deriv-App-ID"], CONFIG.appId);
  assert.ok(sent[2]!["Authorization"]!.startsWith("Bearer "));
});

test("a captured error body is REDACTED of every credential shape", async () => {
  // The body capture exists so a plain-text rejection can be read. It must not
  // become the leak the no-prose rule was protecting against.
  const hostile = [
    `token was ${PAT} and app ${CONFIG.appId}`,
    'redirect wss://x/ws/demo?otp=SECRETOTP&x=1',
    'sent Authorization: Bearer abc.def-ghi_jkl',
  ].join(" | ");
  await assert.rejects(
    () => derivRestRequest({
      method: "GET", path: "/x", config: CONFIG, captureBody: true,
      fetchImpl: fakeFetch({ status: 401, body: hostile, contentType: "text/plain" }),
    }),
    (err: DerivNewApiError) => {
      const snip = err.bodySnippet!;
      assert.ok(!snip.includes(PAT), "PAT survived redaction");
      assert.ok(!snip.includes(CONFIG.appId), "app id survived redaction");
      assert.ok(!snip.includes("SECRETOTP"), "OTP survived redaction");
      assert.ok(!/Bearer\s+abc/.test(snip), "bearer value survived redaction");
      assert.ok(snip.includes("<token:redacted>"));
      return true;
    },
  );
});

test("body capture is OPT-IN — ordinary calls still propagate no prose", async () => {
  // The production rule is unchanged: the venue's prose never reaches logs or
  // thrown errors unless a diagnostic explicitly asks for it.
  await assert.rejects(
    () => derivRestRequest({
      method: "GET", path: "/x", config: CONFIG,
      fetchImpl: fakeFetch({ status: 401, body: "internal detail", contentType: "text/plain" }),
    }),
    (err: DerivNewApiError) => {
      assert.equal(err.bodySnippet, null);
      assert.ok(!err.message.includes("internal detail"));
      return true;
    },
  );
});

test("a long body is truncated so a capture cannot become a dump", async () => {
  await assert.rejects(
    () => derivRestRequest({
      method: "GET", path: "/x", config: CONFIG, captureBody: true,
      fetchImpl: fakeFetch({ status: 401, body: "A".repeat(5000), contentType: "text/plain" }),
    }),
    (err: DerivNewApiError) => {
      assert.ok(err.bodySnippet!.length < 300, `snippet was ${err.bodySnippet!.length}B`);
      assert.ok(err.bodySnippet!.endsWith("[truncated]"));
      return true;
    },
  );
});

// ── Abort classification (the certification "timeout" investigation) ────────
//
// certify reported DERIV_NEW_API_REQUEST_TIMEOUT at rest_accounts while the
// standalone diagnosis reached the same endpoint successfully. The request
// paths are identical, so the label was the thing under suspicion — and it was
// wrong: ANY AbortError became REQUEST_TIMEOUT with the asserted message
// "no response within 15000ms", a duration never measured.

test("an abort we did NOT cause is not reported as our timeout", async () => {
  const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
  const started = Date.now();
  await assert.rejects(
    () => derivRestRequest({
      method: "GET", path: "/x", config: CONFIG,
      timeoutMs: 30_000,                       // our budget is nowhere near spent
      fetchImpl: fakeFetch({ throws: abortErr }),
    }),
    (err: DerivNewApiError) => {
      // The defect: this used to be DERIV_NEW_API_REQUEST_TIMEOUT claiming
      // "no response within 30000ms" after roughly zero milliseconds.
      assert.equal(err.code, "DERIV_NEW_API_REST_TRANSPORT_FAILED");
      assert.ok(!/no response within/.test(err.message), "fabricated a duration");
      assert.ok(err.elapsedMs !== null && err.elapsedMs < 5_000,
        `elapsed should be tiny, got ${err.elapsedMs}`);
      assert.match(err.message, /timeout had NOT fired/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000, "must fail fast, not wait out the budget");
});

test("a REAL timeout is reported as one, with a MEASURED duration", async () => {
  const hang = (async (_u: string, init?: RequestInit) => {
    // Never resolves on its own; only the abort signal ends it.
    return new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () =>
        rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  }) as unknown as typeof fetch;

  await assert.rejects(
    () => derivRestRequest({ method: "GET", path: "/x", config: CONFIG, timeoutMs: 60, fetchImpl: hang }),
    (err: DerivNewApiError) => {
      assert.equal(err.code, "DERIV_NEW_API_REQUEST_TIMEOUT");
      // Measured, not asserted: it must actually be at least the budget.
      assert.ok(err.elapsedMs !== null && err.elapsedMs >= 55, `elapsed ${err.elapsedMs}`);
      assert.match(err.message, /measured/);
      return true;
    },
  );
});

test("a REST transport failure is not labelled a WEBSOCKET connect failure", async () => {
  // It used to be. That sends an operator to inspect the socket layer for a
  // failure that happened over HTTP.
  const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  await assert.rejects(
    () => derivRestRequest({ method: "GET", path: "/x", config: CONFIG, fetchImpl: fakeFetch({ throws: dns }) }),
    (err: DerivNewApiError) => {
      assert.equal(err.code, "DERIV_NEW_API_REST_TRANSPORT_FAILED");
      assert.notEqual(err.code, "DERIV_NEW_API_WS_CONNECT_FAILED");
      // The errno is enum-like and is the single most useful field here.
      assert.equal(err.causeCode, "TypeError/ENOTFOUND");
      assert.ok(!err.message.includes("fetch failed"), "venue/runtime prose leaked");
      return true;
    },
  );
});

test("the timeout covers the BODY read, not just the headers", async () => {
  // The timer used to be cleared as soon as headers arrived, leaving the body
  // read unguarded — a stalled body then hung FOREVER rather than timing out.
  const stalledBody = (async (_u: string, init?: RequestInit) => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"accounts":'));
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        // never closes
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const started = Date.now();
  await assert.rejects(
    () => derivRestRequest({ method: "GET", path: "/x", config: CONFIG, timeoutMs: 80, fetchImpl: stalledBody }),
    (err: DerivNewApiError) => {
      assert.equal(err.code, "DERIV_NEW_API_REQUEST_TIMEOUT");
      assert.match(err.message, /reading the body/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000, "a stalled body must not hang");
});

test("timing is reported on success AND failure, durations only", async () => {
  const seen: unknown[] = [];
  const res = await derivRestRequest({
    method: "GET", path: "/x", config: CONFIG,
    fetchImpl: fakeFetch({ status: 200, json: { accounts: [] } }),
    onTiming: (t) => seen.push(t),
  });
  assert.ok(res.timing.totalMs !== null);
  assert.equal(seen.length, 1);
  // Timing must never become a channel for anything but numbers.
  const blob = JSON.stringify(seen[0]);
  assert.ok(!blob.includes(PAT) && !blob.includes(CONFIG.appId), "timing leaked a credential");
  assert.ok(/^\{("(fetchMs|bodyMs|totalMs)":(\d+|null),?)+\}$/.test(blob), `unexpected timing shape ${blob}`);

  await assert.rejects(() => derivRestRequest({
    method: "GET", path: "/x", config: CONFIG,
    fetchImpl: fakeFetch({ status: 500, body: "boom" }),
    onTiming: (t) => seen.push(t),
  }));
  assert.equal(seen.length, 2, "timing must be reported on the failure path too");
});

test("resolveNewApiConfig REFUSES a legacy-format App ID for the new API", () => {
  const prev = process.env["DERIV_APP_ID"];
  const prevTok = process.env["DERIV_API_TOKEN"];
  try {
    process.env["DERIV_APP_ID"] = "1089";
    process.env["DERIV_API_TOKEN"] = "fixture-not-a-real-token";
    assert.equal(resolveNewApiConfig(), "DERIV_NEW_API_INVALID_APP_ID");
    // The diagnose command must still be able to examine a broken config —
    // refusing there would disable the tool that identifies the breakage.
    const permissive = resolveNewApiConfig({ allowIncoherent: true });
    assert.equal(typeof permissive, "object");
    assert.equal((permissive as { appId: string }).appId, "1089");
  } finally {
    if (prev === undefined) delete process.env["DERIV_APP_ID"]; else process.env["DERIV_APP_ID"] = prev;
    if (prevTok === undefined) delete process.env["DERIV_API_TOKEN"]; else process.env["DERIV_API_TOKEN"] = prevTok;
  }
});

// ── OTP response shape (the live step-5 PROTOCOL_ERROR) ────────────────────

test("the OTP URL is read from Deriv's DOCUMENTED nested shape { data: { url } }", () => {
  // The live failure. The parser searched only the top level, so a perfectly
  // valid Deriv response was rejected as a protocol error. Deriv's own example
  // does `const { data } = await response.json()` then `data.url`.
  const real = { data: { url: "wss://api.derivws.com/trading/v1/options/ws/demo?otp=abc123xyz789" } };
  const parsed = parseOtpResponse(real);
  assert.equal(typeof parsed, "string");
  assert.match(parsed as string, /\/ws\/demo/);
});

test("the flat shape still parses — the nesting is documented only by example", () => {
  // Pinning exclusively to the nested form would be its own guess.
  const flat = { ws_url: "wss://api.derivws.com/trading/v1/options/ws/demo?otp=x" };
  assert.equal(typeof parseOtpResponse(flat), "string");
});

test("a REAL-account socket is refused even when NESTED", () => {
  // The refusal must not be defeated by the shape that actually arrives.
  const real = { data: { url: "wss://api.derivws.com/trading/v1/options/ws/real?otp=x" } };
  const r = parseOtpResponse(real);
  assert.ok(r instanceof DerivNewApiError);
  assert.equal((r as DerivNewApiError).code, "DERIV_NEW_API_NO_DEMO_ACCOUNT");
});

test("an unrecognised OTP shape reports the KEYS it saw, never the values", () => {
  // Without this the next schema change is another blind round trip. Key names
  // are structural; a value here would be the OTP itself.
  const r = parseOtpResponse({ data: { socket: "wss://x?otp=SECRET" }, meta: 1 });
  assert.ok(r instanceof DerivNewApiError);
  const d = (r as DerivNewApiError).detail!;
  assert.match(d, /top-level keys: data,meta/);
  assert.match(d, /data keys: socket/);
  assert.ok(!d.includes("SECRET"), "an OTP value leaked into the diagnostic");
  assert.ok(!d.includes("wss://"), "a URL value leaked into the diagnostic");
});
