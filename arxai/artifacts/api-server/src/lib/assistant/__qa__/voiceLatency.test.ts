// Voice latency is MEASURED per real turn and reported with its N; below the
// minimum sample a path says "unmeasured" and shows no number.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  __resetVoiceLatencyForTests,
  recordVoiceLatency,
  summarizeVoiceLatency,
  VOICE_LATENCY_MIN_SAMPLE,
  VOICE_LATENCY_RING,
} from "../voice/voiceLatency.js";

const here = dirname(fileURLToPath(import.meta.url));
const path = (s: ReturnType<typeof summarizeVoiceLatency>, p: string) => s.paths.find((x) => x.path === p)!;

beforeEach(() => __resetVoiceLatencyForTests());

describe("voice latency measurement", () => {
  it("is unmeasured, with no number, below the minimum sample", () => {
    for (let i = 0; i < VOICE_LATENCY_MIN_SAMPLE - 1; i++) recordVoiceLatency("gpt_audio", { addedMs: 900, firstAudioMs: 1500 });
    const g = path(summarizeVoiceLatency(), "gpt_audio");
    assert.equal(g.metrics.addedMs?.status, "unmeasured");
    assert.equal(g.metrics.addedMs?.p50, null);
    assert.equal(g.metrics.addedMs?.n, VOICE_LATENCY_MIN_SAMPLE - 1);
    assert.match(g.label, /unmeasured \(N=19, needs 20\)/);
    assert.doesNotMatch(g.label, /\d+ ms/);
  });

  it("reports nearest-rank p50/p95 with N once measured", () => {
    for (let i = 1; i <= 100; i++) recordVoiceLatency("gpt_audio", { addedMs: i * 10, providerFirstAudioMs: 400, withheld: i % 10 === 0 });
    const g = path(summarizeVoiceLatency(), "gpt_audio");
    assert.deepEqual(
      { n: g.metrics.addedMs?.n, p50: g.metrics.addedMs?.p50, p95: g.metrics.addedMs?.p95, max: g.metrics.addedMs?.max, status: g.metrics.addedMs?.status },
      { n: 100, p50: 500, p95: 950, max: 1000, status: "measured" },
    );
    assert.equal(g.withheldTurns, 10);
    assert.equal(g.label, "added delay before first audio: p50 500 ms, p95 950 ms (N=100)");
  });

  it("drops non-finite or negative readings instead of counting them", () => {
    recordVoiceLatency("tts", { firstAudioMs: Number.NaN, gateMs: -1, providerFirstByteMs: Infinity });
    recordVoiceLatency("tts", { firstAudioMs: 300 });
    const t = path(summarizeVoiceLatency(), "tts");
    assert.equal(t.turns, 1);
    assert.equal(t.metrics.firstAudioMs?.n, 1);
    assert.equal(t.metrics.gateMs, undefined);
  });

  it("keeps a bounded window", () => {
    for (let i = 0; i < VOICE_LATENCY_RING + 50; i++) recordVoiceLatency("speech_gate", { gateMs: 1 });
    assert.equal(path(summarizeVoiceLatency(), "speech_gate").turns, VOICE_LATENCY_RING);
  });

  it("is wired into every voice path and served to operators only", () => {
    const assistant = readFileSync(join(here, "../../../routes/meAssistant.ts"), "utf8");
    const tts = readFileSync(join(here, "../../../routes/meTTS.ts"), "utf8");
    assert.match(assistant, /recordVoiceLatency\("gpt_audio"/);
    assert.match(assistant, /addedMs: tProviderFirstAudio === null \? undefined : tFirstAudio - tProviderFirstAudio/);
    assert.match(tts, /recordVoiceLatency\("tts"/);
    assert.match(tts, /recordVoiceLatency\("speech_gate"/);
    assert.match(tts, /router\.get\("\/admin\/voice\/latency", requireUser, requireOperator/);
    // The baseline is taken when the model's first audio arrives, before the gate runs.
    const firstAudioIdx = assistant.indexOf("if (tProviderFirstAudio === null) tProviderFirstAudio = nowMs();");
    const gateIdx = assistant.indexOf("const gated = gateVoiceTurn(assistantTranscript, userTranscript);");
    assert.ok(firstAudioIdx > 0 && gateIdx > firstAudioIdx);
  });
});
