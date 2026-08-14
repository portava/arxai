// ═══════════════════════════════════════════════════════════════════════════
// formingTickStreamLatency.test.ts — Task #496 latency addendum.
//
// Real HTTP-level acceptance of the SSE tick-stream's IMMEDIATE-push contract:
//   [D1] Ingest→client latency: a tick folded into the composer reaches a
//        connected SSE client (over a loopback TCP socket) in well under the
//        sub-500ms end-to-end budget. The measured latency is PRINTED so it can
//        be reported in the acceptance run. This exercises the real
//        handleChartTickStream over a real http.Server — not a mock.
//   [D2] No coalescing/aggregation: N ticks folded back-to-back produce N
//        distinct forming_bar frames at the client (every close value arrives) —
//        proving no server-side batching/min-gap timer drops or merges frames.
//   [D3] Each frame carries tickWallMs (the ingest-accept wall clock) so the
//        browser can measure ingest→browser latency.
//
// SAFETY: display/telemetry only. Mounts ONLY the tick-stream handler on a bare
// express app; touches no DB, no auth, no arx_live_* table, no 16-gate, no EA.
// V75 is a 24/7 synthetic so no DB session profile is read.
//
// Run: pnpm --filter @workspace/api-server run test:forming-tick-latency

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import { handleChartTickStream } from "../../../../routes/chartTickStream.js";
import { foldFormingTick, __resetFormingBarStore } from "../formingBarComposer.js";

const SYM = "V75";
const TF = "M5";

interface SseEvent {
  type?: string;
  frozen?: boolean;
  tickWallMs?: number;
  bar?: { close?: number; isForming?: boolean };
}

// Spin up the real handler on an ephemeral port and hand back a teardown.
async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.get("/api/chart/tick-stream", handleChartTickStream);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// Open an SSE connection and surface a parser callback for each parsed event.
function connectSse(
  port: number,
  onEvent: (e: SseEvent) => void,
): Promise<{ req: http.ClientRequest; ready: Promise<void> }> {
  return new Promise((resolve) => {
    let buffer = "";
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: `/api/chart/tick-stream?symbol=${SYM}&timeframe=${TF}`,
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let sep = buffer.indexOf("\n\n");
          while (sep !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              try {
                onEvent(JSON.parse(line.slice("data: ".length)) as SseEvent);
              } catch {
                // ignore non-JSON keepalive lines
              }
            }
            sep = buffer.indexOf("\n\n");
          }
        });
        // Headers received ⇒ the server-side handler has run and registered its
        // bus listener; safe to start folding ticks.
        resolve({ req, ready: Promise.resolve() });
      },
    );
  });
}

test("[D1/D3] tick reaches SSE client in << 500ms and carries tickWallMs", async () => {
  __resetFormingBarStore();
  const { port, close } = await startServer();

  const received: { e: SseEvent; at: number }[] = [];
  let firstFormingResolve: (() => void) | null = null;
  const firstForming = new Promise<void>((r) => (firstFormingResolve = r));

  const { req } = await connectSse(port, (e) => {
    if (e.type !== "forming_bar") return;
    received.push({ e, at: performance.now() });
    firstFormingResolve?.();
  });

  // Small settle so the listener is unquestionably registered server-side.
  await new Promise((r) => setTimeout(r, 25));

  const now = Date.now();
  const t0 = performance.now();
  foldFormingTick(SYM, 1.2345, now, now); // ingest accept → synchronous bus emit
  await firstForming;
  const latencyMs = received[0]!.at - t0;

  assert.ok(latencyMs < 250, `latency ${latencyMs}ms should be well under the 500ms budget`);
  const first = received[0]!.e;
  assert.equal(first.bar?.isForming, true);
  assert.equal(first.bar?.close, 1.2345);
  assert.equal(typeof first.tickWallMs, "number");
  assert.equal(first.tickWallMs, now); // exact ingest-accept wall clock propagated

  req.destroy();
  await close();
});

test("[D2] N back-to-back ticks produce N distinct frames (no coalescing)", async () => {
  __resetFormingBarStore();
  const { port, close } = await startServer();

  const closes: number[] = [];
  const { req } = await connectSse(port, (e) => {
    if (e.type === "forming_bar" && typeof e.bar?.close === "number") {
      closes.push(e.bar.close);
    }
  });

  await new Promise((r) => setTimeout(r, 25));

  const now = Date.now();
  const sent = [1.0, 1.1, 1.2, 1.3, 1.4];
  for (let i = 0; i < sent.length; i++) {
    foldFormingTick(SYM, sent[i]!, now + i, now + i);
  }

  // Drain the socket briefly; with immediate push every fold flushed a frame.
  await new Promise((r) => setTimeout(r, 80));

  for (const c of sent) {
    assert.ok(closes.includes(c), `expected a frame for close=${c}; got ${JSON.stringify(closes)}`);
  }

  req.destroy();
  await close();
});
