// Typed, never-throwing JSON reader for raw fetch() responses on read-only
// scanner / health / smart-layer surfaces. Mirrors the hardened custom-fetch
// mutator semantics (lib/api-client-react/src/custom-fetch.ts) so a 502, an
// empty body, or a truncated payload degrades into a typed result the caller
// can branch on — instead of an uncaught SyntaxError ("Unexpected end of JSON
// input") bubbling up to the user.
//
// READ-ONLY: this helper only reads a Response the caller already fetched. It
// never fabricates data — on any failure it returns { ok: false } with a
// machine-usable `kind` + `status`, and the caller picks the honest degraded
// copy. No execution / gate / permission concern touches this file.

export type SafeJsonFailureKind = "http" | "empty" | "parse" | "network";

export type SafeJsonResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: number;
      kind: SafeJsonFailureKind;
      message: string;
    };

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// Read a Response the caller already obtained from fetch(). Never throws.
export async function readJson<T>(res: Response): Promise<SafeJsonResult<T>> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return {
      ok: false,
      status: res.status || 0,
      kind: "network",
      message: e instanceof Error ? e.message : "Failed to read response body",
    };
  }

  const body = stripBom(text).trim();

  // res.ok first: a non-2xx is an HTTP failure regardless of body shape. If the
  // server sent a JSON { error | message } envelope, keep its reason for the
  // operator console; otherwise fall back to a bare status code. Either way the
  // raw detail stays in `message` — the UI shows its own friendly copy.
  if (!res.ok) {
    let serverMsg: string | null = null;
    if (body) {
      try {
        const parsed = JSON.parse(body) as {
          error?: unknown;
          message?: unknown;
        };
        serverMsg =
          (typeof parsed.error === "string" && parsed.error) ||
          (typeof parsed.message === "string" && parsed.message) ||
          null;
      } catch {
        /* non-JSON error body — fall back to the status code */
      }
    }
    return {
      ok: false,
      status: res.status,
      kind: "http",
      message: serverMsg ?? `HTTP ${res.status}`,
    };
  }

  // 2xx with an empty body — e.g. a proxy answered 200 with nothing, or the
  // payload was truncated. Honest "empty" instead of a thrown parse error.
  if (!body) {
    return {
      ok: false,
      status: res.status,
      kind: "empty",
      message: "Empty response body",
    };
  }

  // JSON.parse runs ONLY on a non-empty body, so the only way to reach the
  // catch is genuinely malformed JSON (kind:"parse").
  try {
    return { ok: true, data: JSON.parse(body) as T };
  } catch (e) {
    return {
      ok: false,
      status: res.status,
      kind: "parse",
      message: e instanceof Error ? e.message : "Malformed JSON",
    };
  }
}

// Convenience wrapper: fetch + readJson in one call. A thrown fetch (DNS
// failure, abort, offline, or a hard 502 with a dropped connection) is captured
// as a typed kind:"network" result instead of a rejected promise.
export async function safeJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<SafeJsonResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (e) {
    return {
      ok: false,
      status: 0,
      kind: "network",
      message: e instanceof Error ? e.message : "Network request failed",
    };
  }
  return readJson<T>(res);
}
