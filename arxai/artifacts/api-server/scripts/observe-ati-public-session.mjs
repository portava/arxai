// Finite, read-only diagnostic for the sealed renewal transport. Emit JSONL to stdout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import WebSocket from "ws";

const [sourceRoot] = process.argv.slice(2);
assert.ok(sourceRoot && process.argv.length === 3);
const transport = resolve(sourceRoot, "artifacts/api-server/src/lib/data/providers/derivPublicDataClient.ts");
const plan = JSON.parse(readFileSync(new URL("../../../docs/structural-evidence/ati-specialists-v1/forward-renewal-plan.json", import.meta.url)));
const digest = createHash("sha256").update(readFileSync(transport)).digest("hex");
assert.equal(digest, plan.transportSha256);
const { DerivPublicDataClient, DERIV_PUBLIC_DATA_URL } = await import(pathToFileURL(transport));
assert.equal(DERIV_PUBLIC_DATA_URL, "wss://api.derivws.com/trading/v1/options/ws/public");
const start = Date.now(), end = start + 65 * 60_000;
function record(event, data = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
}
let connections = 0, ticks = 0, lastEpoch = null, stopRequested = false;
let current;
function socket(url) {
  assert.equal(url, DERIV_PUBLIC_DATA_URL);
  const number = ++connections, createdAt = Date.now();
  const state = { number, firstEpoch: null, lastEpoch: null, pingReplies: 0, discoveryReplies: 0, ticks: 0 };
  current = state;
  class ObservedSocket extends WebSocket {
    terminate() {
      record("LOCAL_TERMINATE", { number, stopRequested });
      return super.terminate();
    }
  }
  const ws = new ObservedSocket(url, { maxPayload: 2 * 1024 * 1024 });
  ws.on("open", () => record("SOCKET_OPEN", { number }));
  ws.on("message", raw => {
    let packet;
    try { packet = JSON.parse(raw.toString()); } catch { return; }
    if (packet.msg_type === "ping" && !packet.error) state.pingReplies++;
    if (packet.msg_type === "active_symbols" && !packet.error) state.discoveryReplies++;
    if (packet.error) record("PUBLIC_API_ERROR", { number, type: packet.msg_type ?? null, code: packet.error.code ?? null });
  });
  ws.on("error", err => record("SOCKET_ERROR", { number, code: err.code ?? null }));
  ws.on("close", (code, reason) => record("SOCKET_CLOSE", { ...state, code,
    reason: reason.toString("utf8").slice(0,256), ageMs: Date.now() - createdAt, stopRequested }));
  return ws;
}
record("START", { study: "V75_PUBLIC_SESSION_CONTINUITY", transportSha256: digest, endsAt: new Date(end).toISOString(),
  symbol: "R_75", executionAuthority: "NONE" });
const client = new DerivPublicDataClient([{ symbol: "V75", derivId: "R_75", displayName: "Volatility 75 Index" }],
  { enabled: () => true, socket });
client.onTick(tick => {
  if (tick.symbol !== "R_75") return;
  if (current.firstEpoch == null) {
    current.firstEpoch = tick.epoch;
    record("FIRST_RELEASE", { number: current.number, epoch: tick.epoch, priorEpoch: lastEpoch });
  }
  if (lastEpoch != null && tick.epoch - lastEpoch !== 2)
    record("CADENCE_CHANGE", { number: current.number, priorEpoch: lastEpoch, epoch: tick.epoch });
  current.lastEpoch = lastEpoch = tick.epoch;
  current.ticks++;
  ticks++;
});
const progress = setInterval(() => record("CHECKPOINT", { ...current, ticksAllSessions: ticks }), 60_000);
try {
  await client.subscribeTicks("R_75").catch(e => record("INITIAL_SUBSCRIPTION_ERROR", { code: e.message }));
  await wait(Math.max(0, end - Date.now()));
} finally {
  clearInterval(progress);
  stopRequested = true;
  client.stop();
  record("END", { connections, ticks, lastEpoch });
}
