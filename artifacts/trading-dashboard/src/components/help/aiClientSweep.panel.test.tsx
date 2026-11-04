import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// AI client sweep 2026-11-04 — panel-level checks:
//   AC1  voice bubble never stays on "Transcribing…" after completion
//   AC5  "Ask <name>" bus opens the panel with the question typed in
//   AC8  a spoken command goes through the gated command route (ruby_voice)
//   AC11 empty-state copy
//   AC12 chat 429 shows the retry time, not "Assistant error (429)."

type VoiceOpts = {
  onUserTranscript?: (t: string) => void;
  onComplete?: (t: string) => void;
};
const h = vi.hoisted(() => ({ voiceOpts: null as VoiceOpts | null }));

vi.mock("@workspace/integrations-openai-ai-react/audio", () => ({
  useVoiceStream: (opts: VoiceOpts) => { h.voiceOpts = opts; return { streamVoiceResponse: vi.fn() }; },
  useVoiceRecorder: () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }),
}));
vi.mock("./useRealtimeVoice", () => ({
  useRealtimeVoice: () => ({ state: "idle", isMuted: false, start: vi.fn(), stop: vi.fn(), toggleMute: vi.fn() }),
}));
vi.mock("./useSpeakResponses", () => ({
  useSpeakResponses: () => ({
    state: "idle", enabled: false, supported: true, setEnabled: vi.fn(), stop: vi.fn(),
    speak: vi.fn(), speakStreamReset: vi.fn(), speakStreamPush: vi.fn(), speakStreamFlush: vi.fn(), speakStreamRetract: vi.fn(),
  }),
  getAvailableVoices: () => [],
  saveVoiceName: vi.fn(),
  getSavedVoiceName: () => null,
  getServerVoicePref: vi.fn(),
  saveServerVoicePref: vi.fn(),
}));
vi.mock("./useRubyTTS", () => ({ previewVoice: vi.fn() }));
vi.mock("@/lib/rubyVoice", () => ({ setChatPanelSpeaking: vi.fn() }));
vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    envelope: { cleanModeLabel: "Live" },
    shouldShowAdminDiagnostics: false,
    isLoading: false, isLiveShared: true, isLiveArmed: false,
  }),
}));
vi.mock("@/lib/use-chart-symbol", () => ({ useChartSymbol: () => ["EURUSD", vi.fn()] }));
vi.mock("@/hooks/useScannerReadGate", () => ({
  useScannerReadGate: () => ({ truth: null, level: null, isFull: false, downgraded: true, reason: null }),
}));
vi.mock("@/lib/perf", () => ({
  markActionStart: vi.fn(), markActionEnd: vi.fn(), markUiFeedback: vi.fn(),
  markRenderComplete: vi.fn(), markApiStart: vi.fn(), markApiEnd: vi.fn(),
}));
vi.mock("./AnimatedArxAssistantIcon", () => ({
  AnimatedArxAssistantIcon: () => null,
  useAssistantIconState: () => ({ state: "idle", status: "idle" }),
  usePrefersReducedMotion: () => false,
}));
vi.mock("wouter", () => ({ useLocation: () => ["/help", vi.fn()] }));

import { ArxAssistantLivePanel } from "./ArxAssistantLivePanel";
import { openAssistantWithPrompt } from "@/lib/assistantPanelBus";

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function installFetch() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: Record<string, unknown> | null = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
    calls.push({ url, method, body });
    if (url.endsWith("/api/me/assistant/conversations") && method === "GET") {
      return json({ conversations: [{ id: 7, title: "Live chat", archivedAt: null }] });
    }
    if (url.endsWith("/api/me/assistant/conversations/7") && method === "GET") {
      return json({ conversation: { id: 7, title: "Live chat" }, messages: [] });
    }
    if (url.endsWith("/api/me/assistant/conversations/7/messages")) {
      return json({ error: "rate_limited", retryAfterSeconds: 42 }, 429, { "Retry-After": "42" });
    }
    if (url.endsWith("/api/me/assistant/instant-trade-command")) {
      return json({ ok: false, classification: "CLOSE", error: "RUBY_CLOSE_COMMANDS_NOT_ENABLED", message: "I couldn't execute: RUBY_CLOSE_COMMANDS_NOT_ENABLED." }, 403);
    }
    return json({});
  }));
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ArxAssistantLivePanel /></QueryClientProvider>);
}

beforeEach(() => {
  h.voiceOpts = null;
  sessionStorage.setItem("arx.assistant.open.v2", "1");
  installFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("ArxAssistantLivePanel — AI client sweep", () => {
  it("AC11: empty state names the speaker icon below and doesn't promise 'never without confirmation'", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText(/speaker icon below/)).toBeTruthy());
    expect(screen.queryByText(/never place a trade without your confirmation/)).toBeNull();
    expect(screen.getByText(/only trade on your direct command/)).toBeTruthy();
  });

  it("AC8: a spoken command goes to the command route as ruby_voice with the live account mode", async () => {
    renderPanel();
    expect(h.voiceOpts).toBeTruthy();
    // Voice can only be sent once the conversation is loaded.
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/conversations/7"))).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    act(() => { h.voiceOpts!.onUserTranscript!("close it"); });
    await act(async () => { h.voiceOpts!.onComplete!(""); });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/instant-trade-command"))).toBe(true));
    const cmd = calls.find((c) => c.url.endsWith("/instant-trade-command"))!;
    expect(cmd.body).toMatchObject({ text: "close it", source: "ruby_voice", accountMode: "live" });
    // AC4: the refusal reads as a sentence, not the raw code.
    await waitFor(() => expect(screen.getByText(/isn't allowed to close trades yet/)).toBeTruthy());
    expect(screen.queryByText(/RUBY_CLOSE_COMMANDS_NOT_ENABLED/)).toBeNull();
    // the spoken words appear once as the user's bubble
    expect(screen.getAllByText("close it").length).toBe(1);
  });

  it("AC1: with no transcript, completion settles the voice bubble instead of 'Transcribing…' forever", async () => {
    renderPanel();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/conversations/7"))).toBe(true));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { h.voiceOpts!.onComplete!(""); });
    expect(screen.queryByTestId("arx-voice-transcribing")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/instant-trade-command"))).toBe(false);
  });

  it("AC5: openAssistantWithPrompt types the question into the panel input", async () => {
    renderPanel();
    act(() => { openAssistantWithPrompt("How is my EURUSD trade doing?"); });
    const input = screen.getByTestId("arx-input") as HTMLInputElement;
    expect(input.value).toBe("How is my EURUSD trade doing?");
  });

  it("AC12: a 429 from the chat route shows the retry time", async () => {
    renderPanel();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/conversations/7"))).toBe(true));
    // let the conversation state settle
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const input = screen.getByTestId("arx-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "what's my risk today" } });
    fireEvent.click(screen.getByTestId("arx-send"));
    await waitFor(() => expect(screen.getByText(/try again in 42 s/)).toBeTruthy());
    expect(screen.queryByText(/Assistant error \(429\)/)).toBeNull();
  });
});
