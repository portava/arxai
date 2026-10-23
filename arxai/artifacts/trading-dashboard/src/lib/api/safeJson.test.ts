import { describe, it, expect, vi, afterEach } from "vitest";
import { readJson, safeJson } from "./safeJson";

// safeJson / readJson must NEVER throw. Every failure mode (HTTP error, empty
// body, malformed JSON, network/abort) returns a typed { ok:false } result the
// caller can branch on — so a 502 or truncated payload can never surface as an
// uncaught SyntaxError ("Unexpected end of JSON input") to the user.

function fakeRes(opts: {
  ok: boolean;
  status: number;
  body: string;
  throwOnText?: boolean;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    text: async () => {
      if (opts.throwOnText) throw new Error("stream aborted");
      return opts.body;
    },
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("readJson", () => {
  it("parses a healthy 2xx JSON body (ok:true, no status field)", async () => {
    const r = await readJson<{ a: number }>(
      fakeRes({ ok: true, status: 200, body: '{"a":1}' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.a).toBe(1);
  });

  it("strips a UTF-8 BOM before parsing", async () => {
    const r = await readJson<{ a: number }>(
      fakeRes({ ok: true, status: 200, body: '\uFEFF{"a":2}' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.a).toBe(2);
  });

  it("classifies a 2xx EMPTY body as kind:empty (never parses it)", async () => {
    const r = await readJson(fakeRes({ ok: true, status: 200, body: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("empty");
      expect(r.status).toBe(200);
    }
  });

  it("treats a whitespace/BOM-only body as empty, not malformed", async () => {
    const r = await readJson(fakeRes({ ok: true, status: 200, body: "\uFEFF  \n" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("empty");
  });

  it("classifies a 2xx malformed body as kind:parse", async () => {
    const r = await readJson(fakeRes({ ok: true, status: 200, body: "{not json" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("parse");
  });

  it("classifies a non-2xx as kind:http and keeps a server JSON reason", async () => {
    const r = await readJson(
      fakeRes({ ok: false, status: 403, body: '{"error":"FORBIDDEN"}' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("http");
      expect(r.status).toBe(403);
      expect(r.message).toBe("FORBIDDEN");
    }
  });

  it("falls back to a bare status message on a 502 with an empty body", async () => {
    const r = await readJson(fakeRes({ ok: false, status: 502, body: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("http");
      expect(r.status).toBe(502);
      expect(r.message).toBe("HTTP 502");
    }
  });

  it("captures a body-stream read failure as kind:network", async () => {
    const r = await readJson(
      fakeRes({ ok: true, status: 200, body: "", throwOnText: true }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("network");
  });
});

describe("safeJson", () => {
  it("captures a thrown fetch (offline/abort) as kind:network with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Failed to fetch");
      }),
    );
    const r = await safeJson("/api/anything");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("network");
      expect(r.status).toBe(0);
    }
  });

  it("delegates a healthy fetch to readJson", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeRes({ ok: true, status: 200, body: '{"v":true}' })),
    );
    const r = await safeJson<{ v: boolean }>("/api/anything");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.v).toBe(true);
  });
});
