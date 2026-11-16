import { describe, expect, it } from "vitest";
import { looksLikeEleanorCommand, eleanorCommandHandled } from "./eleanorCommandIntent";

describe("looksLikeEleanorCommand — only direct commands and alert replies go to Eleanor's command route", () => {
  it.each([
    "buy EURUSD 0.01",
    "Sell XAUUSD 0.1",
    "close my EURUSD",
    "close all",
    "buy EURUSD 0.01 when it reaches 1.0950",
    "monitor my EURUSD",
    "watch my gold trade",
    "cancel my watches",
    "move my stop to breakeven",
    "status",
    "keep it",
    "Keep EURUSD",
    "hold",
    "close it now",
    "ok, buy eurusd 0.01",
    "eleanor, sell gold 0.05",
  ])("command: %s", (t) => expect(looksLikeEleanorCommand(t)).toBe(true));

  it.each([
    "should I buy EURUSD?",
    "what do you think about closing gold?",
    "is my EURUSD trade healthy",
    "why did you close my trade",
    "how do I set a stop loss",
    "explain the chart",
    "the market is selling off hard today and I am worried about my positions in gold and silver, what is your read of the structure and the higher timeframe bias right now please",
    "",
  ])("not a command: %s", (t) => expect(looksLikeEleanorCommand(t)).toBe(false));
});

describe("eleanorCommandHandled — VAGUE/UNKNOWN and transport errors fall through to chat", () => {
  it("handled when the server classified a command", () => {
    expect(eleanorCommandHandled({ ok: false, classification: "OPEN", confirmationRequired: true } as never)).toBe(true);
    expect(eleanorCommandHandled({ ok: true, classification: "STATUS_CHECK" })).toBe(true);
    expect(eleanorCommandHandled({ ok: false, classification: "ELEANOR_NOT_AUTHORIZED" })).toBe(true);
    expect(eleanorCommandHandled({ ok: false, error: "rate_limited" })).toBe(true);
  });
  it("not handled for VAGUE / UNKNOWN / HTTP failures", () => {
    expect(eleanorCommandHandled({ ok: false, classification: "VAGUE" })).toBe(false);
    expect(eleanorCommandHandled({ ok: false, classification: "UNKNOWN" })).toBe(false);
    expect(eleanorCommandHandled({ ok: false, error: "HTTP_502" })).toBe(false);
    expect(eleanorCommandHandled(null)).toBe(false);
  });
});
