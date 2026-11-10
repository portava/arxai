// Client half of the voice claim gate: marked/removed text is never read aloud
// (even by browser speechSynthesis), and realtime answers are shown/spoken only
// after the server gate, failing closed.
import { describe, expect, it, vi } from "vitest";
import { dropUnverifiedForSpeech, sanitizeForSpeech, SPOKEN_WITHHELD_NOTICE_CLIENT } from "./useSpeakResponses";
import { gateRealtimeAnswer, realtimeAssistantFinalText, REALTIME_GATE_FAILED_DISPLAY } from "./useRealtimeVoice";
import { eventProvenanceText } from "@/pages/economic-calendar";

describe("speech never reads verifier-marked text", () => {
  it("drops a sentence with an [unverified] figure and keeps the rest", () => {
    const out = dropUnverifiedForSpeech("Gold is volatile. It traded 2391.40 [unverified] earlier. Trade smaller.");
    expect(out).toBe(`Gold is volatile. ${SPOKEN_WITHHELD_NOTICE_CLIENT} Trade smaller.`);
    expect(out).not.toContain("2391");
  });
  it("drops removed-sentence notices and the verifier footer", () => {
    const out = sanitizeForSpeech("[Removed by the ARX verifier: no executed result came back from ARX this turn, so I can't say the order executed.]\n\n_ARX verifier: 1 claim in this answer could not be matched._");
    expect(out).not.toMatch(/verifier|executed/i);
  });
  it("leaves clean text untouched", () => {
    expect(dropUnverifiedForSpeech("A stop loss limits risk.")).toBe("A stop loss limits risk.");
  });
});

describe("realtime answers pass the server gate before display or speech", () => {
  it("recognises final text events (GA and legacy) and nothing else", () => {
    expect(realtimeAssistantFinalText({ type: "response.output_text.done", text: "hi" })).toBe("hi");
    expect(realtimeAssistantFinalText({ type: "response.audio_transcript.done", transcript: "yo" })).toBe("yo");
    expect(realtimeAssistantFinalText({ type: "response.output_text.delta" })).toBeNull();
  });
  it("returns the gated display and speech", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ display: "EURUSD is 1.0852 [unverified].", speech: "withheld" }), { status: 200 }));
    const g = await gateRealtimeAnswer("EURUSD is 1.0852.", "where is eurusd", fetchFn as unknown as typeof fetch);
    expect(g).toEqual({ display: "EURUSD is 1.0852 [unverified].", speech: "withheld", ok: true });
    expect(String(fetchFn.mock.calls[0]![0])).toContain("/api/me/assistant/voice/speech-gate");
  });
  it("fails closed: nothing shown or spoken when the gate is unreachable", async () => {
    const down = vi.fn(async () => { throw new Error("offline"); });
    expect(await gateRealtimeAnswer("EURUSD is 1.0852.", "", down as unknown as typeof fetch)).toEqual({ display: REALTIME_GATE_FAILED_DISPLAY, speech: "", ok: false });
    const bad = vi.fn(async () => new Response("{}", { status: 500 }));
    expect((await gateRealtimeAnswer("x", "", bad as unknown as typeof fetch)).ok).toBe(false);
  });
});

describe("economic calendar rows name source, fetch time and freshness", () => {
  it("labels a fresh event with its source and UTC fetch time", () => {
    const p = eventProvenanceText("FRED", "2026-03-05T10:00:00.000Z", "LIVE");
    expect(p).toEqual({ text: "Source: FRED · fetched 2026-03-05 10:00 UTC", stale: false });
  });
  it("labels stale and unknown fetches as Stale", () => {
    expect(eventProvenanceText("Trading Economics", "2026-03-05T10:00:00.000Z", "STALE").stale).toBe(true);
    expect(eventProvenanceText("FRED", null, null)).toEqual({ text: "Source: FRED · fetch time not recorded · Stale", stale: true });
  });
});
