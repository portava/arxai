import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { attachAuthUser } from "./lib/auth/middleware";
import { applyEffectiveViewMode } from "./lib/auth/effectiveViewMode";
import { startMonitor } from "./lib/intelligence/monitorWorker";
import { startRubyOutcomeWorker } from "./lib/rubyQuality/outcomeWorker";
import { perfTimer } from "./middlewares/perfTimer";
import { CANDLE_INGEST_BODY_LIMIT_BYTES } from "./lib/data/brokerCandleStore";
import { recordIngestRejection, isIngestRoute } from "./lib/data/ingestRejectionCounter";

const app: Express = express();

// Collapse accidental duplicate slashes in the request path. A bridge client
// (e.g. the MT5 EA) configured with a trailing-slash base URL emits requests
// like `//api/mt5/heartbeat`. Express does not treat `//api/...` as
// `/api/...`, so without this the request 404s before reaching the router.
// Only the path is rewritten; the query string is preserved untouched. This
// touches no auth, routing-policy, or trading surface — purely defensive URL
// hygiene so a misconfigured base URL cannot mask a real endpoint.
app.use((req, _res, next) => {
  const qIdx = req.url.indexOf("?");
  const path = qIdx === -1 ? req.url : req.url.slice(0, qIdx);
  if (path.includes("//")) {
    const query = qIdx === -1 ? "" : req.url.slice(qIdx);
    req.url = path.replace(/\/{2,}/g, "/") + query;
  }
  next();
});

// SESSION_SECRET signs every arx_user_session cookie. In production a missing
// value must be fatal (like PORT in index.ts) — falling back to a literal that
// is published in the repo would let anyone forge signed session cookies. The
// dev fallback survives only outside production so local/test workflows keep
// working without secrets provisioned.
const sessionSecret = process.env["SESSION_SECRET"];
if (!sessionSecret && String(process.env["NODE_ENV"] ?? "").toLowerCase() === "production") {
  throw new Error(
    "SESSION_SECRET must be set in production — refusing to sign session cookies with the known dev fallback.",
  );
}
app.use(cookieParser(sessionSecret ?? "dev-fallback-secret-do-not-use-in-prod"));
// Per-user identity: attaches req.authUser when the arx_user_session cookie
// is valid. Routes that require auth wrap themselves with `requireUser`;
// public routes simply check `req.authUser` if they want to personalize.
app.use(attachAuthUser);
// Effective view-mode: when an admin-capable user has toggled into "user"
// view-mode on the frontend (X-Arx-View-Mode: user header), downgrade
// `req.authUser.role` to "USER" so every `requireAdmin` check naturally
// returns 403. Real DB role is NOT mutated. No-op for non-admins.
app.use(applyEffectiveViewMode);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// CORS posture: the dashboard calls the API same-origin (relative /api base),
// and the MT5 EA uses WebRequest (no browser, CORS not involved), so production
// needs NO cross-origin surface by default. A wildcard `cors()` in production
// invites credential-bearing cross-site calls. Behavior:
//   - production: CORS headers only for origins explicitly listed in
//     ARX_CORS_ALLOWED_ORIGINS (comma-separated); unset ⇒ no CORS at all.
//   - dev/test: permissive (unchanged) so local cross-port workflows keep working.
const corsAllowlist = (process.env["ARX_CORS_ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
if (String(process.env["NODE_ENV"] ?? "").toLowerCase() === "production") {
  if (corsAllowlist.length > 0) {
    app.use(cors({ origin: corsAllowlist, credentials: true }));
  }
  // No allowlist ⇒ same-origin only: mount no CORS middleware.
} else {
  app.use(cors());
}
// ── EA bridge body parsing ──────────────────────────────────────────────────
// EA-facing bridge POSTs carry arrays that blow past the default 100kb JSON
// ceiling and were failing with 413 (entity.too.large):
//   - ENUMERATE_SYMBOLS result (POST /mt5/command-result) — up to the EA's
//     600-symbol cap, each with full per-symbol broker specs;
//   - position / pending snapshots — many open/pending orders.
// A 413 is doubly harmful: the symbol directory never ingests AND the rejected
// request leaves un-read bytes on the keep-alive socket, which mis-frames the
// NEXT request on that connection (the EA's heartbeat / pending push) so it
// surfaces as a cascading 502. Fix: parse every EA bridge endpoint that can
// carry an array with a generous BOUNDED limit BEFORE the global parser claims
// the stream (once it sets req._body the global express.json() below skips
// re-parsing). 25mb safely fits a full Deriv enumeration without dropping a
// single symbol, while staying bounded against abuse. The `verify` hook records
// the raw body size for payload-size telemetry. Scoped per-path on purpose —
// every non-bridge endpoint (incl. public auth routes) keeps the conservative
// global default below. Read/record only; touches no trading/auth/routing gate.
const captureBodySize = (req: express.Request, _res: express.Response, buf: Buffer): void => {
  (req as express.Request & { _rawBodyBytes?: number })._rawBodyBytes = buf?.length ?? 0;
};
// Cheap pre-parse gate: every EA bridge endpoint REQUIRES a per-user bridge
// token header. Reject the obvious unauthenticated case (no/empty header)
// BEFORE parsing a body that may be up to 25mb, so the raised limit can't be
// abused as a pre-auth body-parse resource sink. Presence-only — the real
// constant-time token validation still runs downstream in bridgeAuthPerUserOnly.
// Response shape matches that middleware exactly so the EA sees no behaviour
// change. Touches no trading/routing surface.
const requireBridgeTokenHeader: express.RequestHandler = (req, res, next) => {
  const tok = req.header("X-MT5-Bridge-Token");
  if (typeof tok !== "string" || tok.trim() === "") {
    res.status(401).json({ error: "Invalid MT5 bridge token.", code: "TOKEN_MISSING" });
    return;
  }
  next();
};
const bridgeJson = express.json({ limit: "25mb", verify: captureBodySize });
const bridgeJsonSmall = express.json({ limit: "1mb", verify: captureBodySize });
for (const p of [
  "/api/mt5/command-result",
  "/api/mt5/positions-snapshot",
  "/api/mt5/pending-snapshot",
  "/api/mt5/sync-positions-per-user",
  "/api/mt5/sync-positions",
  "/api/mt5/sync-symbol-specs",
  // Task #371 — Bridge v2 broker-truth EVENT ingest (batched snapshots/events
  // can be sizeable; share the larger bridgeJson limit + token-header gate).
  "/api/bridge/v2/ingest",
]) {
  app.use(p, requireBridgeTokenHeader, bridgeJson);
}
// Heartbeat / sync-account bodies are small, but still size-logged and bounded a
// little above the default in case the capabilities/eaInputs block grows.
app.use("/api/mt5/heartbeat", requireBridgeTokenHeader, bridgeJsonSmall);
app.use("/api/mt5/sync-account", requireBridgeTokenHeader, bridgeJsonSmall);
// Task #500 — durable broker-candle BATCH ingest. A full legitimate batch is up
// to 5000 bars at the barSchema shape (~1.5mb worst case), which blows past the
// conservative global express.json() default and was being bounced at the parser
// with 413 BEFORE the handler ran — silently dropping ~12% of EA batches so
// higher-timeframe durable rows (H1/H4/H8) filled in sparsely. Parse this one
// route with a dedicated BOUNDED limit sized to the worst legitimate batch plus
// margin (CANDLE_INGEST_BODY_LIMIT_BYTES). Same token-header pre-gate + body-size
// capture as the other bridge endpoints. The global default below is unchanged.
const bridgeJsonCandleIngest = express.json({ limit: CANDLE_INGEST_BODY_LIMIT_BYTES, verify: captureBodySize });
app.use("/api/mt5/candles/ingest", requireBridgeTokenHeader, bridgeJsonCandleIngest);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Bridge payload-size telemetry — one structured line per EA POST so an
// oversized enumeration/snapshot is observable instead of silently 413ing.
// Logged AFTER parsing so the size is recorded on success too. No-op for GETs
// and any request without a captured body.
app.use("/api/mt5", (req, _res, next) => {
  const bytes = (req as express.Request & { _rawBodyBytes?: number })._rawBodyBytes;
  if (typeof bytes === "number" && bytes > 0) {
    req.log?.info(
      { event: "mt5_payload_size", path: req.path, method: req.method, bytes },
      "MT5 bridge payload size",
    );
  }
  next();
});

// PART A — perf instrumentation. Mounted as the first /api middleware so
// the timer's res.on("finish") sees every API response (including 4xx/5xx
// from downstream handlers). Records into the perfRecorder ring buffer
// readable only by ADMIN/OWNER via /api/admin/performance/recent-actions.
app.use("/api", perfTimer);
app.use("/api", router);

// UX4 — start the background trade-monitor worker (paper-only, read-mostly).
startMonitor();

// Task #199 — start the Ruby Quality outcome-resolution worker (observation
// only: resolves recorded signal outcomes from real evidence + appends
// self-reviews; never touches any execution path).
startRubyOutcomeWorker();

// ── Phase 22D — JSON-only error handler ───────────────────────────────
// Guarantees the frontend never receives an HTML stack trace. Catches
// body-parser PayloadTooLargeError (413), maps common upstream failures
// to friendly codes, and hides everything else behind a generic message.
app.use(
  (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const e = err as { type?: string; status?: number; statusCode?: number; message?: string; name?: string; code?: string };
    // Phase 22D — multer file-size violations don't carry a status code; map
    // them to 413 so the unified JSON 413 branch picks them up.
    const isMulterTooLarge = e?.name === "MulterError" && e?.code === "LIMIT_FILE_SIZE";
    const status = isMulterTooLarge ? 413 : (e?.status ?? e?.statusCode ?? 500);
    try {
      (req as { log?: { error: (...a: unknown[]) => void } }).log?.error(
        { err: e?.message, name: e?.name, type: e?.type, status },
        "api_error",
      );
    } catch { /* noop */ }
    if (res.headersSent) { try { res.end(); } catch { /* noop */ } return; }
    const isVoice = req.path.includes("/assistant/") && req.path.endsWith("/voice");
    // Body-parser rejections (413 too-large, 400 malformed) happen BEFORE the
    // request body is drained. On a keep-alive connection the un-read bytes
    // would mis-frame the NEXT request on that socket — which is exactly how an
    // oversized EA command-result turns the following heartbeat/pending push
    // into a cascading 502. Force the socket closed so the client (and the
    // upstream proxy) opens a fresh connection instead of reusing a poisoned one.
    // Only body-parser-class rejections leave the request undrained, so only
    // those need the socket forced closed. A generic application-thrown 400 has
    // a fully-read body and must NOT close the keep-alive connection.
    const isParserReject = e?.type === "entity.too.large" || e?.type === "entity.parse.failed";
    const closeSocketOnBadBody = () => { try { res.setHeader("Connection", "close"); } catch { /* noop */ } };
    // Task #500 — make body-parser rejections on an EA ingest route LOUD and
    // counted. A 413/parse-failure here means the batch never reached the
    // handler and the bars were silently dropped at the parser. Log at WARN with
    // the route + content-length and bump an in-memory counter the admin Market
    // Data diagnostics reads back, so a feed quietly losing batches is
    // impossible to miss. Telemetry only — the 413/400 response shape and the
    // socket-close-on-bad-body behaviour below are unchanged.
    if (isParserReject && isIngestRoute(req.path)) {
      const clHeader = req.headers["content-length"];
      const parsedCl = typeof clHeader === "string" ? Number(clHeader) : NaN;
      const contentLength = Number.isFinite(parsedCl) ? parsedCl : null;
      recordIngestRejection(req.path, { contentLength, reason: e?.type ?? null });
      try {
        (req as { log?: { warn: (...a: unknown[]) => void } }).log?.warn(
          { event: "ingest_body_rejected", route: req.path, type: e?.type, status, contentLength },
          "ingest body-parser rejection",
        );
      } catch { /* noop */ }
    }
    if (e?.type === "entity.too.large" || status === 413) {
      if (isParserReject || status === 413) closeSocketOnBadBody();
      res.status(413).json({
        ok: false,
        error: isVoice ? "VOICE_TOO_LARGE" : "PAYLOAD_TOO_LARGE",
        message: isVoice
          ? "Voice clip is too long. Please try a shorter message."
          : "Request body is too large.",
      });
      return;
    }
    if (e?.type === "entity.parse.failed" || status === 400) {
      if (isParserReject) closeSocketOnBadBody();
      res.status(400).json({ ok: false, error: "BAD_REQUEST", message: "Invalid request." });
      return;
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({
      ok: false,
      error: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again.",
    });
  },
);

export default app;
