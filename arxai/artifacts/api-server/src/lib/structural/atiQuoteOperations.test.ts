import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { StoredForecast } from "./service.js";
import type { AtiDerivQuoteFrame } from "../data/atiDerivQuotes.js";

test("the public quote monitor identifies exactly the observed outage and respects historical cutoffs", async () => {
  process.env.DATABASE_URL ??= "postgres://localhost:1/offline";
  const { diagnoseAtiQuoteStream } = await import("./atiQuoteOperations.js");
  const file = new URL(
    "../../../../../docs/structural-evidence/ati-specialists-v1/forward-smoke.json.gz",
    import.meta.url,
  );
  const data: { row: StoredForecast & { recordedAt: number }; frames: AtiDerivQuoteFrame[] }[] = JSON.parse(
    gunzipSync(await readFile(file)).toString(),
  );
  const [absent, present] = data;
  assert.ok(absent && present);
  const end = present.row.forecast.asOf + 905_000;
  const load = async () => present.frames;
  const full = await diagnoseAtiQuoteStream(present.row, end, load);
  assert.equal(full?.state, "IMPAIRED");
  const gap = {
    afterEpoch: Date.parse("2026-11-24T06:01:50Z") / 1000,
    resumedEpoch: Date.parse("2026-11-24T06:02:22Z") / 1000,
    missingTicks: 15,
  };
  assert.deepEqual(full?.timeline?.gaps, [gap]);
  const historical = await diagnoseAtiQuoteStream(present.row, gap.afterEpoch * 1000 + 500, load);
  assert.equal(historical?.state, "COLLECTING");
  assert.equal(historical?.timeline?.overdueTailTicks, 0);
  const during = await diagnoseAtiQuoteStream(present.row, gap.afterEpoch * 1000 + 15_000, load);
  assert.equal(during?.state, "IMPAIRED");
  assert.deepEqual(during?.timeline?.gaps, []);
  assert.equal(during?.timeline?.overdueTailTicks, 6);
  const deadline = gap.afterEpoch * 1000 + 5000;
  const beforeDeadline = await diagnoseAtiQuoteStream(present.row, deadline - 1, load);
  assert.equal(beforeDeadline?.timeline?.interruption, null);
  const atDeadline = await diagnoseAtiQuoteStream(present.row, deadline, load, async (last, cutoff) => {
    assert.equal(last.epoch, gap.afterEpoch);
    assert.equal(cutoff, deadline);
    return null;
  });
  assert.equal(atDeadline?.timeline?.interruption?.firstOverdueAt, deadline);
  assert.equal(atDeadline?.timeline?.interruption?.firstOtherPublicRelease, null);
  const other = { streamId: "037ca701-352b-44cb-b3f6-ab35f8fee6cd", epoch: gap.afterEpoch + 2,
    releasedAt: deadline - 1 };
  const elsewhere = await diagnoseAtiQuoteStream(present.row, deadline, load, async () => other);
  assert.deepEqual(elsewhere?.timeline?.interruption?.firstOtherPublicRelease, other);
  assert.ok(elsewhere?.timeline && atDeadline?.timeline);
  assert.equal(elsewhere.priceReplay, atDeadline.priceReplay);
  assert.equal(elsewhere?.state, "IMPAIRED");
  const corrupted = structuredClone(present.frames);
  corrupted[8]!.streamId = "other";
  assert.equal(
    (await diagnoseAtiQuoteStream(present.row, end, async () => corrupted))?.state,
    "ANCHOR_UNVERIFIED",
  );
  const never = async () => {
    throw new Error("unexpected quote read");
  };
  assert.equal((await diagnoseAtiQuoteStream(absent.row, end, never))?.state, "NO_ISSUANCE_QUOTE");
  assert.equal(await diagnoseAtiQuoteStream(present.row, present.row.issuedAt - 1, never), null);
});
