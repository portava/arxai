// The POLLED tick path — the only tick source a credential-free Deriv session
// has (probed live 2026-08-31: `ticks` and `ticks_history subscribe` are both
// refused InvalidSymbol, `active_symbols` is empty, but a history read returns
// the newest print).
//
// What must stay true, and why each one is a truth claim rather than a detail:
//   - the tick carries the VENUE's epoch, never a local clock, so a stalled
//     venue reads as a stale tick instead of a fresh one;
//   - an unchanged print does NOT re-notify listeners, so a frozen venue cannot
//     look busy to the forming bar, the chart tip, or the freshness ladder;
//   - a malformed or empty reply yields null and emits nothing, rather than a
//     zero, a NaN, or a guessed price.
process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";

const { getDerivWsClient } = await import("../derivWsClient.js");

type Reply = Record<string, unknown>;

/** Drive pollLatestTick against canned venue replies, capturing what it emits. */
async function drive(replies: Reply[]): Promise<{ ticks: Array<{ quote: number; epoch: number }>; results: unknown[] }> {
  const client = getDerivWsClient() as unknown as {
    request: (p: Record<string, unknown>) => Promise<Reply>;
    pollLatestTick: (s: string) => Promise<{ quote: number; epoch: number } | null>;
    onTick: (cb: (t: { symbol: string; epoch: number; quote: number }) => void) => () => void;
  };
  const original = client.request.bind(client);
  const ticks: Array<{ quote: number; epoch: number }> = [];
  const off = client.onTick((t) => ticks.push({ quote: t.quote, epoch: t.epoch }));
  const results: unknown[] = [];
  try {
    let i = 0;
    client.request = async () => replies[i++] ?? {};
    for (let n = 0; n < replies.length; n++) {
      results.push(await client.pollLatestTick(`TESTSYM_${Math.random().toString(36).slice(2, 8)}`));
    }
  } finally {
    client.request = original;
    off();
  }
  return { ticks, results };
}

const history = (price: number, epoch: number): Reply => ({ history: { prices: [price], times: [epoch] } });

test("a polled tick carries the VENUE epoch and reaches listeners", async () => {
  const { ticks, results } = await drive([history(7247.83, 1788174266)]);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0]!.quote, 7247.83);
  assert.equal(ticks[0]!.epoch, 1788174266, "the venue's own epoch must survive — not a local timestamp");
  assert.notEqual(results[0], null);
});

test("an UNCHANGED print does not re-notify — a frozen venue must not look busy", async () => {
  // Same symbol polled twice with an identical reply: the second poll still
  // returns the tick (callers may want the value) but must not emit again.
  const client = getDerivWsClient() as unknown as {
    request: (p: Record<string, unknown>) => Promise<Reply>;
    pollLatestTick: (s: string) => Promise<unknown>;
    onTick: (cb: (t: unknown) => void) => () => void;
  };
  const original = client.request.bind(client);
  let emitted = 0;
  const off = client.onTick(() => { emitted++; });
  try {
    client.request = async () => history(7100.5, 1788170000);
    const sym = "FROZEN_TEST_SYM";
    await client.pollLatestTick(sym);
    await client.pollLatestTick(sym);
    await client.pollLatestTick(sym);
  } finally {
    client.request = original;
    off();
  }
  assert.equal(emitted, 1, "an unchanged print re-notified listeners — a stalled feed would read as live");
});

test("a malformed or empty reply yields null and emits NOTHING — never a zero", async () => {
  const { ticks, results } = await drive([
    {},                                            // no history at all
    { history: { prices: [], times: [] } },        // present but empty
    { history: { prices: ["abc"], times: [1] } },  // unparseable price
    { history: { prices: [0], times: [1788170000] } }, // zero is not a price
    { history: { prices: [7200], times: [0] } },   // no usable epoch
  ]);
  assert.deepEqual(results, [null, null, null, null, null]);
  assert.equal(ticks.length, 0, "a bad reply produced a tick — that is a fabricated price");
});
