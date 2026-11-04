import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, renderHook, act, fireEvent, waitFor } from "@testing-library/react";

// AI client sweep 2026-11-04 — surfaces outside the panel:
//   AC1  useVoiceStream consumes the server's real event names end to end
//   AC4  the settings card offers Open / Close / Change SL/TP switches
//   AC5  the position side card's "Ask" opens the chat panel instead of
//        parsing an SSE stream as JSON

const playback = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  clear: vi.fn(),
  pushAudio: vi.fn(),
  signalComplete: vi.fn(),
  state: "idle",
}));
vi.mock("../../../../../lib/integrations-openai-ai-react/src/audio/useAudioPlayback", () => ({
  useAudioPlayback: () => playback,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetMeOneClickStatus: () => ({ data: null, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/components/positions/PositionMiniChart", () => ({ PositionMiniChart: () => null }));

import { useVoiceStream } from "@workspace/integrations-openai-ai-react/audio";
import { OneClickToggleCard } from "@/components/mt5/OneClickToggleCard";
import { PositionSideCard, type UnifiedPosition } from "@/components/positions/PositionSideCard";
import { ASSISTANT_PROMPT_EVENT } from "@/lib/assistantPanelBus";

function sseResponse(events: unknown[], { withDone = true } = {}) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (withDone ? `data: ${JSON.stringify({ type: "done" })}\n\n` : "");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AC1 useVoiceStream — server dialect", () => {
  it("plays audio_chunk, reports user_transcript and completes on {type:'done'}", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      { type: "safety", safetyMode: "live", liveLocked: false },
      { type: "user_transcript", data: "close it" },
      { type: "transcript", data: "Okay." },
      { type: "audio_chunk", data: "QUJD" },
      { type: "ping", ts: 1 },
    ])));
    const onUserTranscript = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceStream({ workletPath: "/w.js", onUserTranscript, onComplete, onError }));
    await act(async () => { await result.current.streamVoiceResponse("/voice", new Blob(["x"], { type: "audio/webm" })); });
    expect(onUserTranscript).toHaveBeenCalledWith("close it");
    expect(playback.pushAudio).toHaveBeenCalledWith("QUJD");
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("Okay.");
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces {type:'error', message} through onError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([{ type: "error", message: "voice_unavailable" }], { withDone: false })));
    const onError = vi.fn();
    const { result } = renderHook(() => useVoiceStream({ workletPath: "/w.js", onError }));
    await act(async () => {
      await expect(result.current.streamVoiceResponse("/voice", new Blob(["x"]))).rejects.toThrow("voice_unavailable");
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("still completes when the stream closes without a done event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([{ type: "transcript", data: "Hi" }], { withDone: false })));
    const onComplete = vi.fn();
    const { result } = renderHook(() => useVoiceStream({ workletPath: "/w.js", onComplete }));
    await act(async () => { await result.current.streamVoiceResponse("/voice", new Blob(["x"])); });
    expect(onComplete).toHaveBeenCalledWith("Hi");
  });
});

describe("AC4 settings card — command permissions", () => {
  it("shows Open / Close / Change SL/TP switches under AI-Assisted and saves them", async () => {
    const puts: Record<string, unknown>[] = [];
    const settings = {
      demoOneClickEnabled: false, liveOneClickEnabled: false, maxLotPerClick: null, updatedAt: null,
      canEnableLive: true, canEnableLiveBlockedReason: null,
      rubyExecutionAuthority: "AI_ASSISTED", rubyRequireExtraConfirmation: true,
      allowRubyOpenCommands: false, allowRubyCloseCommands: false, allowRubyModifyCommands: false,
    };
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        puts.push(JSON.parse(String(init!.body)));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(settings), { status: 200 });
    }));
    render(<OneClickToggleCard />);
    const open = await screen.findByTestId("switch-ruby-allowRubyOpenCommands");
    expect(screen.getByTestId("switch-ruby-allowRubyCloseCommands")).toBeTruthy();
    expect(screen.getByTestId("switch-ruby-allowRubyModifyCommands")).toBeTruthy();
    // defaults stay OFF
    expect(open.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(open);
    await waitFor(() => expect(puts).toContainEqual({ allowRubyOpenCommands: true }));
  });
});

describe("AC5 position side card — Ask", () => {
  it("opens the chat panel with the trade context and makes no conversation calls", () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ candles: [], feedStatus: null }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const got: string[] = [];
    const listener = (e: Event) => got.push((e as CustomEvent<{ text: string }>).detail.text);
    window.addEventListener(ASSISTANT_PROMPT_EVENT, listener);
    const p: UnifiedPosition = {
      scope: "live", brokerTicket: "555", symbol: "EURUSD", side: "BUY", lotSize: 0.1,
      entryPrice: 1.1, currentPrice: 1.101, stopLoss: 1.099, takeProfit: 1.103, floatingPnl: 10,
      openedAt: new Date().toISOString(), sourceCommandId: null, accountMode: "LIVE", source: "MT5_LIVE_BRIDGE",
    } as UnifiedPosition;
    render(<PositionSideCard position={p} />);
    fireEvent.click(screen.getByTestId("btn-ask-ruby"));
    window.removeEventListener(ASSISTANT_PROMPT_EVENT, listener);
    expect(got.length).toBe(1);
    expect(got[0]).toMatch(/EURUSD/);
    expect(got[0]).toMatch(/ticket 555/);
    expect(f.mock.calls.some((c) => String(c[0]).includes("/assistant/conversations"))).toBe(false);
  });
});
