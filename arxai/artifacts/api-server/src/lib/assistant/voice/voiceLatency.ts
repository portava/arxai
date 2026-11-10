// Voice latency: MEASURED, not estimated.
//
// The speech claim gate (owner ruling 2026-11-09) holds voice output until the
// whole reply is checked, which delays first audio. docs/VOICE_AND_NEWS_GRADES.md
// first stated that cost as provider estimates. This module measures it on
// every real voice turn instead, per path:
//
//   gpt_audio   providerFirstAudioMs  first model audio byte after the clip is
//                                     received: when audio WOULD have started
//                                     if it streamed unchecked (the baseline)
//               providerDoneMs        the model finished the turn
//               gateMs                the claims check itself
//               firstAudioMs          ARX actually released first audio (held
//                                     chunks, or a speech_replaced hand-off)
//               addedMs               firstAudioMs - providerFirstAudioMs:
//                                     the delay the gate costs the listener
//   tts         gateMs, providerFirstByteMs (TTS provider's first audio byte),
//               firstAudioMs (first byte written to the client)
//   speech_gate gateMs (the realtime path's text check)
//
// Readings are kept per process in a bounded ring (restart = fresh). A path
// reports "unmeasured" with its N until it has MIN_SAMPLE turns, and never
// invents a number. Observation only: nothing here changes what is spoken.

export type VoicePath = "gpt_audio" | "tts" | "speech_gate";
export const VOICE_LATENCY_METRICS = [
  "providerFirstAudioMs", "providerDoneMs", "providerFirstByteMs", "gateMs", "firstAudioMs", "addedMs",
] as const;
export type VoiceLatencyMetric = (typeof VOICE_LATENCY_METRICS)[number];

export type VoiceLatencySample = Partial<Record<VoiceLatencyMetric, number>> & { withheld?: boolean };

export const VOICE_LATENCY_RING = 500;
export const VOICE_LATENCY_MIN_SAMPLE = 20;

const rings: Record<VoicePath, VoiceLatencySample[]> = { gpt_audio: [], tts: [], speech_gate: [] };

const finiteMs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function recordVoiceLatency(path: VoicePath, sample: VoiceLatencySample): void {
  const clean: VoiceLatencySample = {};
  for (const m of VOICE_LATENCY_METRICS) if (finiteMs(sample[m])) clean[m] = Math.round(sample[m]! * 10) / 10;
  if (typeof sample.withheld === "boolean") clean.withheld = sample.withheld;
  if (Object.keys(clean).length === 0) return;
  const ring = rings[path];
  ring.push(clean);
  if (ring.length > VOICE_LATENCY_RING) ring.splice(0, ring.length - VOICE_LATENCY_RING);
}

export function __resetVoiceLatencyForTests(): void {
  for (const k of Object.keys(rings) as VoicePath[]) rings[k] = [];
}

/** Nearest-rank percentile of an ascending array. */
function pct(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export interface MetricSummary { n: number; p50: number | null; p95: number | null; max: number | null; status: "measured" | "unmeasured" }
export interface PathSummary {
  path: VoicePath;
  turns: number;
  withheldTurns: number;
  metrics: Partial<Record<VoiceLatencyMetric, MetricSummary>>;
  label: string;
}

export function summarizeVoiceLatency(): { minSample: number; window: number; paths: PathSummary[] } {
  const paths = (Object.keys(rings) as VoicePath[]).map((path): PathSummary => {
    const ring = rings[path];
    const metrics: PathSummary["metrics"] = {};
    for (const m of VOICE_LATENCY_METRICS) {
      const vals = ring.map((s) => s[m]).filter(finiteMs).sort((a, b) => a - b);
      if (vals.length === 0) continue;
      const measured = vals.length >= VOICE_LATENCY_MIN_SAMPLE;
      metrics[m] = {
        n: vals.length,
        p50: measured ? pct(vals, 50) : null,
        p95: measured ? pct(vals, 95) : null,
        max: measured ? vals[vals.length - 1]! : null,
        status: measured ? "measured" : "unmeasured",
      };
    }
    const head = path === "gpt_audio" ? metrics.addedMs : path === "tts" ? metrics.firstAudioMs : metrics.gateMs;
    const what = path === "gpt_audio" ? "added delay before first audio" : path === "tts" ? "time to first audio" : "gate time";
    const label = head?.status === "measured"
      ? `${what}: p50 ${head.p50} ms, p95 ${head.p95} ms (N=${head.n})`
      : `${what}: unmeasured (N=${head?.n ?? 0}, needs ${VOICE_LATENCY_MIN_SAMPLE})`;
    return { path, turns: ring.length, withheldTurns: ring.filter((s) => s.withheld).length, metrics, label };
  });
  return { minSample: VOICE_LATENCY_MIN_SAMPLE, window: VOICE_LATENCY_RING, paths };
}

/** Monotonic milliseconds. */
export const nowMs = (): number => Number(process.hrtime.bigint() / 1000n) / 1000;
