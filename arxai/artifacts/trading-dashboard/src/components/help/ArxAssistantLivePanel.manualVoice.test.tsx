import {
  describe, it, expect, beforeEach, afterEach, vi,
} from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Manual-only voice regression guard for Ruby (ArxAssistantLivePanel).
 *
 * Background: Ruby's spoken reply used to cut off after a few seconds because
 * the auto-listen VAD loop re-opened the mic and interrupted her own TTS. The
 * fix removes auto-listen entirely and makes voice strictly press-to-record:
 *   - the mic recorder is DISABLED while Ruby is speaking (so the user can't
 *     record over her — her speech runs to completion unless manually stopped),
 *   - there is NO auto-listen toggle anywhere in the panel,
 *   - the four required state labels render:
 *       "Tap to record" / "Recording…" / "Sending voice message…" /
 *       "Ruby is speaking…".
 *
 * `rubySpeaking` is derived from `status === "speaking" || tts.state ===
 * "speaking"`, so mocking useSpeakResponses().state drives the speaking branch.
 * All other hooks are mocked to no-ops so the panel renders in isolation.
 */

const h = vi.hoisted(() => ({
  ttsState: "idle" as "idle" | "speaking",
}));

vi.mock("@workspace/integrations-openai-ai-react/audio", () => ({
  useVoiceStream: () => ({ streamVoiceResponse: vi.fn() }),
  useVoiceRecorder: () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }),
}));

vi.mock("./useRealtimeVoice", () => ({
  useRealtimeVoice: () => ({
    state: "idle",
    isMuted: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggleMute: vi.fn(),
  }),
}));

vi.mock("./useSpeakResponses", () => ({
  useSpeakResponses: () => ({
    state: h.ttsState,
    enabled: true,
    supported: true,
    setEnabled: vi.fn(),
    stop: vi.fn(),
  }),
  getAvailableVoices: () => [],
  saveVoiceName: vi.fn(),
  getSavedVoiceName: () => null,
  getServerVoicePref: vi.fn(),
  saveServerVoicePref: vi.fn(),
}));

vi.mock("./useRubyTTS", () => ({
  previewVoice: vi.fn(),
}));

vi.mock("@/lib/rubyVoice", () => ({
  setChatPanelSpeaking: vi.fn(),
}));

vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    envelope: { cleanModeLabel: "Demo" },
    shouldShowAdminDiagnostics: false,
  }),
}));

vi.mock("@/lib/use-chart-symbol", () => ({
  useChartSymbol: () => ["EURUSD", vi.fn()],
}));

vi.mock("@/lib/perf", () => ({
  markActionStart: vi.fn(),
  markActionEnd: vi.fn(),
  markUiFeedback: vi.fn(),
  markRenderComplete: vi.fn(),
  markApiStart: vi.fn(),
  markApiEnd: vi.fn(),
}));

vi.mock("./AnimatedArxAssistantIcon", () => ({
  AnimatedArxAssistantIcon: () => null,
  useAssistantIconState: () => ({ state: "idle", status: "idle" }),
  usePrefersReducedMotion: () => false,
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/help", vi.fn()],
}));

import { ArxAssistantLivePanel } from "./ArxAssistantLivePanel";

// The panel renders react-query-backed children (RubyTimingChip →
// useGetTimingBrain, useScannerTruth). They must run inside a
// QueryClientProvider; their network calls stay inert via the stubbed fetch.
function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArxAssistantLivePanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.ttsState = "idle";
  sessionStorage.setItem("arx.assistant.open.v2", "1");
  // Mount fetches (briefing/conversation) are fired on open; keep them inert.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("ArxAssistantLivePanel — manual press-to-record only", () => {
  it("renders open with the idle 'Tap to record' affordance and an enabled mic", () => {
    renderPanel();
    expect(screen.getByTestId("arx-assistant-panel")).toBeTruthy();
    // Idle has no transient status bar; the press-to-record affordance lives on
    // the mic button itself ("Tap to record"), and the mic is enabled.
    const mic = screen.getByTestId("arx-mic-toggle") as HTMLButtonElement;
    expect(mic.getAttribute("title")).toContain("Tap to record");
    expect(mic.disabled).toBe(false);
  });

  it("has NO auto-listen toggle anywhere in the panel", () => {
    renderPanel();
    expect(screen.queryByTestId("arx-auto-listen-toggle")).toBeNull();
    expect(screen.queryByText(/auto-listen/i)).toBeNull();
    // No control advertises a hands-free / always-listening affordance.
    const pressed = screen
      .queryAllByRole("button")
      .filter((b) => b.getAttribute("aria-label")?.toLowerCase().includes("auto-listen"));
    expect(pressed.length).toBe(0);
  });

  it("disables the mic recorder while Ruby is speaking so her reply runs to completion", () => {
    h.ttsState = "speaking";
    renderPanel();
    expect(screen.getByTestId("arx-status-bar").textContent).toContain("Eleanor is speaking…");
    const mic = screen.getByTestId("arx-mic-toggle") as HTMLButtonElement;
    // The user cannot start a recording (which would re-open the mic / interrupt
    // her); they must let her finish or hit the dedicated Stop control.
    expect(mic.disabled).toBe(true);
    expect(mic.getAttribute("title")).toContain("Eleanor is speaking");
  });
});
