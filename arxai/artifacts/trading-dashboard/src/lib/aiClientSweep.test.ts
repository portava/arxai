import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeVoiceStreamEvent, parseVoiceStreamEvent } from "@workspace/integrations-openai-ai-react/audio";
import { isRealtimeSafetyEnvelopeAcceptable } from "@/components/help/useRealtimeVoice";
import {
  eleanorCommandAccountMode, friendlyEleanorCommandError, eleanorCommandReplyText, eleanorNotLiveReply,
} from "./eleanorCommandIntent";
import { classifyCommandStatus, pollEleanorCommandOutcome, eleanorCommandOutcomeText } from "./eleanorCommandOutcome";
import { openAssistantWithPrompt, onAssistantPrompt, chatRateLimitedText } from "./assistantPanelBus";

// AI client sweep 2026-11-04 (AC1, AC2, AC3, AC4, AC6, AC12, AC5 bus).

describe("AC1 voice stream events — server dialect + legacy names", () => {
  it("maps audio_chunk and audio to the canonical audio event", () => {
    expect(normalizeVoiceStreamEvent({ type: "audio_chunk", data: "AAA" })).toEqual({ type: "audio", data: "AAA" });
    expect(normalizeVoiceStreamEvent({ type: "audio", data: "BBB" })).toEqual({ type: "audio", data: "BBB" });
  });
  it("accepts {type:'done'} and legacy {done:true}", () => {
    expect(normalizeVoiceStreamEvent({ type: "done" })).toEqual({ done: true });
    expect(normalizeVoiceStreamEvent({ done: true })).toEqual({ done: true });
  });
  it("accepts error with message (server) and error (legacy)", () => {
    expect(normalizeVoiceStreamEvent({ type: "error", message: "voice_unavailable" })).toEqual({ type: "error", error: "voice_unavailable" });
    expect(normalizeVoiceStreamEvent({ type: "error", error: "boom" })).toEqual({ type: "error", error: "boom" });
  });
  it("passes user_transcript / transcript and drops safety / ping silently", () => {
    expect(normalizeVoiceStreamEvent({ type: "user_transcript", data: "close it" })).toEqual({ type: "user_transcript", data: "close it" });
    expect(normalizeVoiceStreamEvent({ type: "transcript", data: "ok" })).toEqual({ type: "transcript", data: "ok" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseVoiceStreamEvent(JSON.stringify({ type: "safety", safetyMode: "live" }))).toBeNull();
    expect(parseVoiceStreamEvent(JSON.stringify({ type: "ping", ts: 1 }))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("AC2 realtime safety envelope", () => {
  it("accepts every per-user mode the server sends", () => {
    for (const m of ["off", "simulated", "demo", "live", "paper_only"]) {
      expect(isRealtimeSafetyEnvelopeAcceptable({ safetyMode: m, liveLocked: m !== "live" })).toBe(true);
    }
    expect(isRealtimeSafetyEnvelopeAcceptable({ safetyMode: "live", liveLocked: false })).toBe(true);
  });
  it("refuses a missing or malformed envelope", () => {
    expect(isRealtimeSafetyEnvelopeAcceptable(undefined)).toBe(false);
    expect(isRealtimeSafetyEnvelopeAcceptable({ safetyMode: "turbo", liveLocked: true })).toBe(false);
    expect(isRealtimeSafetyEnvelopeAcceptable({ safetyMode: "demo" })).toBe(false);
  });
});

describe("AC3 account mode for the command route", () => {
  it("LIVE_SHARED counts as live even when not armed; armed counts as live", () => {
    expect(eleanorCommandAccountMode({ isLiveShared: true, isLiveArmed: false })).toBe("live");
    expect(eleanorCommandAccountMode({ isLiveShared: false, isLiveArmed: true })).toBe("live");
  });
  it("demo / loading fail closed to demo", () => {
    expect(eleanorCommandAccountMode({ isLiveShared: false, isLiveArmed: false })).toBe("demo");
    expect(eleanorCommandAccountMode({ isLoading: true, isLiveShared: true, isLiveArmed: true })).toBe("demo");
  });
  it("non-live reply is plain and names where to go", () => {
    expect(eleanorNotLiveReply("Eleanor")).toMatch(/live account only/);
    expect(eleanorNotLiveReply("Eleanor")).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
  });
});

describe("AC4 friendly refusal copy", () => {
  it("ELEANOR_OPEN_COMMANDS_NOT_ENABLED says where to turn it on", () => {
    const t = friendlyEleanorCommandError("ELEANOR_OPEN_COMMANDS_NOT_ENABLED", "Eleanor")!;
    expect(t).toMatch(/Open new trades/);
    expect(t).toMatch(/Settings/);
  });
  it("the chat reply never shows a raw code for known refusals", () => {
    const reply = eleanorCommandReplyText({ ok: false, error: "ELEANOR_OPEN_COMMANDS_NOT_ENABLED", message: "I couldn't execute: ELEANOR_OPEN_COMMANDS_NOT_ENABLED." }, "Eleanor");
    expect(reply).not.toMatch(/ELEANOR_OPEN_COMMANDS_NOT_ENABLED/);
    for (const code of ["ELEANOR_CLOSE_COMMANDS_NOT_ENABLED", "ELEANOR_MODIFY_COMMANDS_NOT_ENABLED", "LIVE_ONE_CLICK_DISABLED", "UNSUPPORTED_ACCOUNT_MODE_FOR_INSTANT_LIVE"]) {
      expect(eleanorCommandReplyText({ ok: false, error: code, message: `I couldn't execute: ${code}.` }, "Eleanor")).not.toContain(code);
    }
  });
  it("keeps the server message for ok / unknown cases and handles rate limits", () => {
    expect(eleanorCommandReplyText({ ok: true, message: "Sent." }, "Eleanor")).toBe("Sent.");
    expect(eleanorCommandReplyText({ ok: false, error: "rate_limited", retryAfterSeconds: 12 }, "Eleanor")).toMatch(/12 s/);
  });
});

describe("AC6 command follow-up", () => {
  it("classifies fills, closes and rejects honestly", () => {
    expect(classifyCommandStatus({ status: "SENT_TO_MT5_LIVE" })).toBeNull();
    expect(classifyCommandStatus({ status: "LIVE_FILLED", brokerTicket: null })).toBeNull();
    expect(classifyCommandStatus({ status: "LIVE_FILLED", brokerTicket: "9", fillPrice: 1.1 })).toMatchObject({ phase: "filled", isClose: false });
    expect(classifyCommandStatus({ status: "LIVE_FILLED", commandType: "CLOSE_LIVE_POSITION", closeConfirmed: false })).toBeNull();
    expect(classifyCommandStatus({ status: "LIVE_FILLED", commandType: "CLOSE_LIVE_POSITION", closeConfirmed: true, brokerTicket: "9" })).toMatchObject({ phase: "filled", isClose: true });
    expect(classifyCommandStatus({ status: "LIVE_REJECTED", brokerMessage: "No money" })).toMatchObject({ phase: "rejected", reason: "No money" });
  });

  it("polls until a terminal status and posts a fill line", async () => {
    const replies = [{ status: "SENT_TO_MT5_LIVE" }, { status: "LIVE_FILLED", brokerTicket: "123", fillPrice: 1.0912 }];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200 })) as unknown as typeof fetch;
    let t = 0;
    const out = await pollEleanorCommandOutcome("cmd-1", { fetchImpl, sleep: async (ms) => { t += ms; }, now: () => t });
    expect(out).toMatchObject({ phase: "filled", brokerTicket: "123" });
    expect(eleanorCommandOutcomeText(out!)).toBe("Filled at 1.0912 — ticket 123.");
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe("/api/me/live/command-status/cmd-1");
  });

  it("stops after the bounded window and says pending", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "SENT_TO_MT5_LIVE" }), { status: 200 })) as unknown as typeof fetch;
    let t = 0;
    const out = await pollEleanorCommandOutcome("cmd-2", { fetchImpl, sleep: async (ms) => { t += ms; }, now: () => t, windowMs: 5000 });
    expect(out).toEqual({ phase: "pending" });
    expect(eleanorCommandOutcomeText(out!)).toMatch(/still pending/);
  });

  it("returns null when cancelled (panel unmounted)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const out = await pollEleanorCommandOutcome("cmd-3", { fetchImpl, sleep: async () => {}, isCancelled: () => true });
    expect(out).toBeNull();
  });
});

describe("AC5 bus / AC12 copy", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it("delivers the prompt to a subscriber and unsubscribes", () => {
    const got: string[] = [];
    const off = onAssistantPrompt((t) => got.push(t));
    openAssistantWithPrompt("explain my EURUSD trade");
    off();
    openAssistantWithPrompt("ignored");
    expect(got).toEqual(["explain my EURUSD trade"]);
  });
  it("rate-limit copy uses retryAfterSeconds", () => {
    expect(chatRateLimitedText(30)).toBe("You've sent a lot of messages — try again in 30 s.");
    expect(chatRateLimitedText(null)).toMatch(/try again in a minute/);
  });
});
