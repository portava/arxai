// Eleanor voice: spoken answers pass the same claims verification as text, and
// voice never places or confirms an order. Offline; scripted transcripts stand
// in for recorded gpt-audio / gpt-realtime turns (voice runs no tools, so the
// only evidence is the user's own words).
//
//   pnpm --filter @workspace/api-server run test:voice-claim-gate
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  gateSpeech,
  gateVoiceTurn,
  normalizeForSpeechMatch,
  SPOKEN_NO_EXECUTION_NOTICE,
  SPOKEN_WITHHELD_NOTICE,
} from "../voice/speechGate.js";
import {
  openVerifiedSpeechTurn,
  recordVerifiedSpeechSource,
  trustedSpeechFor,
  __resetSpeechLedgerForTests,
} from "../voice/speechLedger.js";
import { voiceCommandDecision, VOICE_EXECUTION_BLOCKED } from "../voice/voiceCommandPolicy.js";
import { verifyAnswer, VERIFIER_NOTICES, UNVERIFIED_MARK } from "../grounding/runtimeVerifier.js";
import { REALTIME_OUTPUT_MODALITIES, REALTIME_SPEECH_PATH } from "../voice/realtimeSpeechPolicy.js";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

beforeEach(() => __resetSpeechLedgerForTests());

// ── Scripted transcripts ────────────────────────────────────────────────────
interface Script {
  name: string;
  user: string;
  said: string;
  audioMayPlay: boolean;
  /** Exact expected speech when given. */
  speech?: string;
  mustNotSpeak?: string[];
  notice?: string;
}

const SCRIPTS: Script[] = [
  {
    name: "explanation with no claims plays as recorded",
    user: "what is a stop loss",
    said: "A stop loss closes your trade at a price you choose. It limits how much you can lose on one trade.",
    audioMayPlay: true,
    speech: "A stop loss closes your trade at a price you choose. It limits how much you can lose on one trade.",
  },
  {
    name: "invented live price is withheld",
    user: "where is euro dollar",
    said: "EURUSD is trading at 1.0852 right now.",
    audioMayPlay: false,
    mustNotSpeak: ["1.0852"],
    notice: SPOKEN_WITHHELD_NOTICE,
  },
  {
    name: "invented ticket is withheld",
    user: "is my trade open",
    said: "Yes, ticket 48213977 is still open.",
    audioMayPlay: false,
    mustNotSpeak: ["48213977"],
    notice: SPOKEN_WITHHELD_NOTICE,
  },
  {
    name: "invented clock time is withheld",
    user: "when does the fed speak",
    said: "The Fed chair speaks at 14:30 today.",
    audioMayPlay: false,
    mustNotSpeak: ["14:30"],
    notice: SPOKEN_WITHHELD_NOTICE,
  },
  {
    name: "claimed execution is withheld with the no-execution notice",
    user: "buy 0.5 lots of EURUSD",
    said: "Done, I bought 0.5 lots of EURUSD for you.",
    audioMayPlay: false,
    mustNotSpeak: ["I bought"],
    notice: SPOKEN_NO_EXECUTION_NOTICE,
  },
  {
    name: "uncalibrated probability is withheld",
    user: "will gold go up",
    said: "There's a 72% chance gold goes higher this week.",
    audioMayPlay: false,
    mustNotSpeak: ["72"],
    notice: SPOKEN_WITHHELD_NOTICE,
  },
  {
    name: "echoing the user's own figure is allowed",
    user: "what if I risk 2% per trade",
    said: "Risking 2% per trade means a losing streak costs more. Keep your stop loss in place.",
    audioMayPlay: true,
    speech: "Risking 2% per trade means a losing streak costs more. Keep your stop loss in place.",
  },
  {
    name: "mixed turn: only the unchecked sentence is replaced",
    user: "how is gold",
    said: "Gold has been volatile. It closed at 2391.40 yesterday. Trade smaller when it moves fast.",
    audioMayPlay: false,
    speech: `Gold has been volatile. ${SPOKEN_WITHHELD_NOTICE} Trade smaller when it moves fast.`,
    mustNotSpeak: ["2391"],
  },
];

for (const s of SCRIPTS) {
  test(`voice transcript: ${s.name}`, () => {
    const g = gateVoiceTurn(s.said, s.user);
    assert.equal(g.audioMayPlay, s.audioMayPlay, `audioMayPlay for "${s.said}"`);
    if (s.speech !== undefined) assert.equal(g.speech, s.speech);
    for (const bad of s.mustNotSpeak ?? []) assert.ok(!g.speech.includes(bad), `"${bad}" must not be spoken: ${g.speech}`);
    if (s.notice) assert.ok(g.speech.includes(s.notice), `expected notice in: ${g.speech}`);
    // The bubble shows exactly what the text verifier would show for this turn.
    assert.equal(g.display, verifyAnswer(s.said, [], s.user).text);
    assert.equal(g.withheld > 0, !s.audioMayPlay);
  });
}

test("the displayed text of a claimed execution carries the text verifier's notice", () => {
  const g = gateVoiceTurn("Your order was filled at the market.", "buy EURUSD");
  assert.ok(g.display.includes(VERIFIER_NOTICES.EXECUTION_UNCONFIRMED));
  assert.equal(g.speech, SPOKEN_NO_EXECUTION_NOTICE);
});

test("consecutive withheld sentences collapse into one spoken notice", () => {
  const g = gateSpeech({ text: "EURUSD is 1.0852. GBPUSD is 1.2711. USDJPY is 151.20." });
  assert.equal(g.speech, SPOKEN_WITHHELD_NOTICE);
  assert.equal(g.withheld, 3);
});

// ── TTS route input: verified chat text keeps its checked figures ───────────
test("verified chat text in the ledger is spoken with its figures (markdown-insensitive)", () => {
  const userId = 7;
  const push = openVerifiedSpeechTurn(userId);
  // The chat route records each released (already verified) content delta.
  push("**EURUSD** is at 1.08523 on the ");
  push("live feed.\n");
  const g = gateSpeech({ text: "EURUSD is at 1.08523 on the live feed.", trusted: trustedSpeechFor(userId) });
  assert.equal(g.clean, true);
  assert.equal(g.speech, "EURUSD is at 1.08523 on the live feed.");
  assert.equal(g.segments[0]!.verdict, "spoken_trusted");
});

test("the same figure is withheld when it is not in this user's verified text", () => {
  recordVerifiedSpeechSource(7, "EURUSD is at 1.08523 on the live feed.");
  const other = gateSpeech({ text: "EURUSD is at 1.08523 on the live feed.", trusted: trustedSpeechFor(8) });
  assert.equal(other.clean, false);
  assert.ok(!other.speech.includes("1.08523"));
});

test("text the verifier marked or removed is never read aloud", () => {
  const marked = `It traded 1.0999${UNVERIFIED_MARK} earlier. ${VERIFIER_NOTICES.WRONG_NUMBER} Stops protect you.`;
  recordVerifiedSpeechSource(3, marked);
  const g = gateSpeech({ text: marked, trusted: trustedSpeechFor(3) });
  assert.ok(!g.speech.includes("1.0999"));
  assert.ok(!g.speech.includes("Removed by the ARX verifier"));
  assert.equal(g.speech, `${SPOKEN_WITHHELD_NOTICE} Stops protect you.`);
});

test("ledger: per-user, time-limited", () => {
  recordVerifiedSpeechSource(1, "Alpha text that was verified.", 1_000);
  assert.deepEqual(trustedSpeechFor(1, 1_000 + 60_000), ["Alpha text that was verified."]);
  assert.deepEqual(trustedSpeechFor(2, 1_000 + 60_000), []);
  assert.deepEqual(trustedSpeechFor(1, 1_000 + 31 * 60_000), [], "expired after 30 min");
});

test("normalisation strips markdown, list markers and case only", () => {
  assert.equal(normalizeForSpeechMatch("1. **Stop** at `x`  1.0820"), "stop at x 1.0820");
});

// ── Voice never places or confirms an order ─────────────────────────────────
test("voice cannot place, close or confirm an order", () => {
  for (const text of ["buy EURUSD 0.01", "close all", "close it", "sell gold 1 lot", "set TP on EURUSD to 1.0920"]) {
    const d = voiceCommandDecision({ source: "eleanor_voice", text, confirm: false });
    assert.equal(d.allowed, false, text);
    if (!d.allowed) assert.equal(d.classification, VOICE_EXECUTION_BLOCKED);
  }
  assert.equal(voiceCommandDecision({ source: "eleanor_voice", text: "buy EURUSD 0.01", confirm: true }).allowed, false, "confirm by voice");
  assert.equal(voiceCommandDecision({ source: "eleanor_voice", text: "keep it", confirm: true }).allowed, false, "no confirm resend by voice at all");
});

test("voice may only acknowledge an alert with keep/hold (sends nothing to a broker)", () => {
  for (const text of ["keep it", "hold", "okay, keep the trade", "keep EURUSD"]) {
    assert.equal(voiceCommandDecision({ source: "eleanor_voice", text, confirm: false }).allowed, true, text);
  }
});

test("typed commands are unaffected", () => {
  assert.equal(voiceCommandDecision({ source: "eleanor_text", text: "buy EURUSD 0.01", confirm: true }).allowed, true);
});

// ── Production wiring (source-level) ────────────────────────────────────────
test("gpt-audio route holds model audio until the transcript is gated", () => {
  const route = src("../../../routes/meAssistant.ts");
  const start = route.indexOf('router.post("/me/assistant/conversations/:id/voice"');
  const end = route.indexOf("router.post(", start + 10);
  const voice = route.slice(start, end);
  const loopStart = voice.indexOf("for await (const event of stream)");
  const gateAt = voice.indexOf("gateVoiceTurn(assistantTranscript, userTranscript)");
  assert.ok(loopStart > 0 && gateAt > loopStart, "gate runs after the stream completes");
  const loop = voice.slice(loopStart, gateAt);
  assert.ok(!/sendVoice\(\{ type: "audio_chunk"/.test(loop), "no audio is sent while the model is still generating");
  assert.ok(!/sendVoice\(\{ type: "transcript"/.test(loop), "no unchecked transcript is shown while streaming");
  assert.match(voice.slice(gateAt), /if \(gated\.audioMayPlay && !audioOverflow\)/);
  assert.match(voice.slice(gateAt), /type: "speech_replaced"/);
  assert.match(route, /VOICE_CANONICAL = new Set\(\[[^\]]*"speech_replaced"/);
});

test("instant-trade route checks the voice policy before parsing any command", () => {
  const route = src("../../../routes/meAssistant.ts");
  const start = route.indexOf('router.post("/me/assistant/instant-trade-command"');
  const body = route.slice(start);
  const policy = body.indexOf("voiceCommandDecision(");
  assert.ok(policy > 0);
  for (const later of ["listEleanorWatches(", "acknowledgeEleanorWatch(", "parseTradeCommand(text"]) {
    assert.ok(body.indexOf(later) > policy, `${later} runs after the voice policy`);
  }
});

test("chat route records verified content in the speech ledger", () => {
  const route = src("../../../routes/meAssistant.ts");
  assert.match(route, /openVerifiedSpeechTurn\(userId\)/);
  assert.match(route, /event\?\.type === "content" && typeof event\.content === "string"\) recordVerifiedSpeech\(event\.content\)/);
});

test("TTS route gates the text before any provider synthesizes it", () => {
  const tts = src("../../../routes/meTTS.ts");
  const gate = tts.indexOf("gateSpeech({ text: sanitized");
  assert.ok(gate > 0);
  assert.ok(tts.indexOf("text-to-speech/") > gate, "ElevenLabs call after the gate");
  assert.ok(tts.indexOf("/audio/speech") > gate, "OpenAI tts-1-hd call after the gate");
  assert.match(tts, /const text = gated\.speech;/);
});

test("realtime never streams model audio: text out, gated, then TTS", () => {
  assert.deepEqual([...REALTIME_OUTPUT_MODALITIES], ["text"]);
  assert.equal(REALTIME_SPEECH_PATH, "verified_text_then_tts");
  const rt = src("../realtimeSession.ts");
  assert.match(rt, /output_modalities: \[\.\.\.REALTIME_OUTPUT_MODALITIES\]/);
  assert.ok(!/output: \{ voice:/.test(rt), "no model audio output is configured");
});

// ── Cost of the gate itself (measured; provider latency is not measurable offline) ──
test("gate cost: a 2,000-char spoken turn is checked in well under a frame", () => {
  const sentence = "Gold has been volatile this week and spreads can widen around news. ";
  const said = sentence.repeat(Math.ceil(2000 / sentence.length)).slice(0, 2000);
  const times: number[] = [];
  for (let i = 0; i < 25; i++) {
    const t0 = performance.now();
    gateVoiceTurn(said, "how is gold");
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  process.stdout.write(`[voice-claim-gate] gateVoiceTurn median ${median.toFixed(2)} ms over 25 runs (2,000 chars)\n`);
  assert.ok(median < 50, `median ${median} ms`);
});
