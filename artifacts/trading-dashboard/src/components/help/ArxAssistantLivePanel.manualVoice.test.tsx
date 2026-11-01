import { registerChartFibonacciAssistant } from "@/lib/chart-engine/chartFibonacciAssistant";
import { registerChartStudyAssistant } from "@/lib/chart-engine/chartStudyAssistant";
import {
  describe, it, expect, beforeEach, afterEach, vi,
} from "vitest";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";
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
import { AssistantDockProvider, AssistantDockSlot } from "./AssistantDock";

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
  it("routes Fibonacci curiosity locally to its chart owner without sending a remote message",()=>{
    const handler=vi.fn(()=>"Prepared an unaccepted Fibonacci preview. Exact 50% level: 15.");
    const release=registerChartFibonacciAssistant(handler);
    try {
      renderPanel();vi.mocked(fetch).mockClear();
      fireEvent.change(screen.getByTestId("arx-input"),{target:{value:"What does Fibonacci show me about this chart?"}});
      fireEvent.click(screen.getByTestId("arx-send"));
      expect(handler).toHaveBeenCalledWith({action:"explain"});expect(screen.getByText(/Exact 50% level: 15/)).toBeTruthy();
      expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).includes("/messages"))).toBe(false);
    }finally{release();}
  });
  it("does not send unsupported Fibonacci orders to the model or drawing owner",()=>{
    const handler=vi.fn();const release=registerChartFibonacciAssistant(handler);
    try {
      renderPanel();vi.mocked(fetch).mockClear();
      fireEvent.change(screen.getByTestId("arx-input"),{target:{value:"Show Fibonacci then buy EURUSD"}});
      fireEvent.click(screen.getByTestId("arx-send"));
      expect(handler).not.toHaveBeenCalled();expect(screen.getByText(/Chart not changed. Fibonacci requests support/)).toBeTruthy();
      expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).includes("/messages"))).toBe(false);
    }finally{release();}
  });
  it("routes chart curiosity through the mounted chart without a remote model request", () => {
    const handler=vi.fn(()=>"Applied RSI (14). Actual chart observation RSI: 61.");
    const release=registerChartStudyAssistant(handler);
    try {
      renderPanel();
      vi.mocked(fetch).mockClear();
      fireEvent.change(screen.getByTestId("arx-input"),{target:{value:"What does RSI tell me about this chart?"}});
      fireEvent.click(screen.getByTestId("arx-send"));
      expect(handler).toHaveBeenCalledWith({kind:"rsi",action:"show",period:undefined});
      expect(screen.getByText(/Actual chart observation RSI: 61/)).toBeTruthy();
      expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).includes("/messages"))).toBe(false);
    } finally { release(); }
  });

  it("keeps the same open conversation panel when the chart launcher docks and undocks",()=>{
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    const App=({chart}:{chart:boolean})=><QueryClientProvider client={client}><AssistantDockProvider>{chart&&<AssistantDockSlot/>}<ArxAssistantLivePanel/></AssistantDockProvider></QueryClientProvider>;
    const view=render(<App chart={false}/>);
    const panel=screen.getByTestId('arx-assistant-panel');
    const input=screen.getByTestId('arx-input') as HTMLInputElement;
    fireEvent.change(input,{target:{value:'Unsent chart question'}});
    view.rerender(<App chart/>);
    expect(screen.getByTestId('chart-assistant-dock').contains(screen.getByTestId('arx-assistant-trigger'))).toBe(true);
    expect(screen.getByTestId('arx-assistant-panel')).toBe(panel);
    expect(input.value).toBe('Unsent chart question');
    view.rerender(<App chart={false}/>);
    expect(screen.getByTestId('arx-assistant-panel')).toBe(panel);
    expect(screen.getAllByTestId('arx-assistant-trigger')).toHaveLength(1);
    expect(screen.getByTestId('arx-assistant-trigger').getAttribute('data-placement')).toBe('floating');
    expect(input.value).toBe('Unsent chart question');
  });
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

function renderChartPanel(chart=true){
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 const App=({showChart}:{showChart:boolean})=><QueryClientProvider client={client}><AssistantDockProvider>{showChart&&<div data-testid="arx-native-chart"><AssistantDockSlot/><div data-testid="arx-native-canvas"/><button data-testid="chart-control">Inspect chart</button></div>}<ArxAssistantLivePanel/></AssistantDockProvider></QueryClientProvider>;
 return {...render(<App showChart={chart}/>),App};
}
describe("mobile chart conversation layout",()=>{
 it("starts compact only for a narrow chart and preserves draft, history and explicit expansion",()=>{
  vi.stubGlobal("innerWidth",390);vi.stubGlobal("innerHeight",844);
  const release=registerChartStudyAssistant(()=>"Actual chart study receipt");
  try{
   renderChartPanel();const panel=screen.getByTestId("arx-assistant-panel"),input=screen.getByTestId("arx-input") as HTMLInputElement;
   expect(panel.getAttribute("data-chart-layout")).toBe("compact");expect(parseFloat(panel.style.height)).toBeLessThanOrEqual(340);
   fireEvent.change(input,{target:{value:"show RSI"}});fireEvent.click(screen.getByTestId("arx-send"));
   expect(screen.getByText("Actual chart study receipt")).toBeTruthy();expect(screen.getByText("show RSI").closest('[data-chart-chat-hidden]')?.getAttribute('hidden')).toBe('');
   fireEvent.change(input,{target:{value:"unsent draft"}});const expand=screen.getByRole("button",{name:"Expand conversation"});expand.focus();fireEvent.click(expand);
   expect(screen.getByTestId("arx-input")).toBe(input);expect(input.value).toBe("unsent draft");expect(document.activeElement).toBe(expand);expect(panel.getAttribute("data-chart-layout")).toBe("expanded");
   expect(screen.getByText("show RSI").closest('[hidden]')).toBeNull();
   fireEvent.change(input,{target:{value:"show RSI"}});fireEvent.click(screen.getByTestId("arx-send"));expect(panel.getAttribute("data-chart-layout")).toBe("expanded");
   fireEvent.click(screen.getByRole("button",{name:"Keep chart visible"}));expect(panel.getAttribute("data-chart-layout")).toBe("compact");
  }finally{release();}
 });
 it("bounds keyboard resizing without losing the active input or hiding speaking Stop",()=>{
  vi.stubGlobal("innerWidth",390);vi.stubGlobal("innerHeight",844);h.ttsState="speaking";
  const viewport=Object.assign(new EventTarget(),{width:390,height:844,offsetTop:0,offsetLeft:0});vi.stubGlobal("visualViewport",viewport);
  renderChartPanel();const panel=screen.getByTestId("arx-assistant-panel"),input=screen.getByTestId("arx-input") as HTMLInputElement;
  input.focus();fireEvent.change(input,{target:{value:"kept while resizing"}});
  Object.assign(viewport,{height:280,offsetTop:72});act(()=>viewport.dispatchEvent(new Event("resize")));
  expect(parseFloat(panel.style.top)).toBeGreaterThanOrEqual(72);expect(parseFloat(panel.style.top)+parseFloat(panel.style.height)).toBeLessThanOrEqual(352);
  expect(document.activeElement).toBe(input);expect(input.value).toBe("kept while resizing");expect(screen.getByRole("button",{name:"Stop speaking"})).toBeTruthy();expect(screen.getByRole("button",{name:"Close",exact:true})).toBeTruthy();
 });
 it("permits chart interaction alongside the compact panel and Escape returns focus to its launcher",()=>{
  vi.stubGlobal("innerWidth",390);vi.stubGlobal("innerHeight",844);renderChartPanel();
  fireEvent.mouseDown(screen.getByTestId("chart-control"));expect(screen.getByTestId("arx-assistant-panel")).toBeTruthy();
  fireEvent.keyDown(screen.getByTestId("arx-input"),{key:"Escape"});expect(screen.queryByTestId("arx-assistant-panel")).toBeNull();expect(document.activeElement).toBe(screen.getByTestId("arx-assistant-trigger"));
 });
 it("leaves desktop and undocked layouts unchanged, and preserves input across chart docking",()=>{
  vi.stubGlobal("innerWidth",1024);vi.stubGlobal("innerHeight",900);const view=renderChartPanel();const panel=screen.getByTestId("arx-assistant-panel"),input=screen.getByTestId("arx-input") as HTMLInputElement;
  expect(panel.getAttribute("data-chart-layout")).toBe("standard");expect(screen.queryByRole("button",{name:"Expand conversation"})).toBeNull();
  fireEvent.change(input,{target:{value:"draft survives"}});vi.stubGlobal("innerWidth",390);fireEvent(window,new Event("resize"));expect(panel.getAttribute("data-chart-layout")).toBe("compact");
  view.rerender(<view.App showChart={false}/>);expect(screen.getByTestId("arx-assistant-panel")).toBe(panel);expect(panel.getAttribute("data-chart-layout")).toBe("standard");expect(input.value).toBe("draft survives");
 });
 it("moves focus to expansion when optional voice controls disappear during narrow resize",()=>{
  vi.stubGlobal("innerWidth",1024);vi.stubGlobal("innerHeight",900);renderChartPanel();screen.getByRole("button",{name:"Choose voice"}).focus();
  vi.stubGlobal("innerWidth",390);act(()=>{window.dispatchEvent(new Event("resize"));(document.activeElement as HTMLElement).blur();});expect(document.activeElement).toBe(screen.getByRole("button",{name:"Expand conversation"}));
 });
 it("delayed open focus never steals an already focused input",()=>{
  vi.useFakeTimers();vi.stubGlobal("innerWidth",390);vi.stubGlobal("innerHeight",844);
  try{renderChartPanel();const input=screen.getByTestId("arx-input");input.focus();fireEvent.change(input,{target:{value:"already typing"}});act(()=>vi.advanceTimersByTime(150));expect(document.activeElement).toBe(input);expect((input as HTMLInputElement).value).toBe("already typing");}finally{vi.useRealTimers();}
 });

 it("keeps normal outside dismissal for the explicitly expanded chart conversation",()=>{
  vi.stubGlobal("innerWidth",390);vi.stubGlobal("innerHeight",844);renderChartPanel();fireEvent.click(screen.getByRole("button",{name:"Expand conversation"}));fireEvent.mouseDown(screen.getByTestId("chart-control"));expect(screen.queryByTestId("arx-assistant-panel")).toBeNull();
 });

 it("recovers focus when a new compact receipt hides the formerly focused message",()=>{
  vi.stubGlobal("innerWidth",390);vi.stubGlobal("innerHeight",844);const release=registerChartStudyAssistant(()=>"Actual rendered study observation. ".repeat(30));
  try{renderChartPanel();fireEvent.change(screen.getByTestId("arx-input"),{target:{value:"show RSI"}});fireEvent.click(screen.getByTestId("arx-send"));screen.getByRole("button",{name:"Show more",exact:true}).focus();fireEvent.change(screen.getByTestId("arx-input"),{target:{value:"show RSI"}});fireEvent.click(screen.getByTestId("arx-send"));expect(document.activeElement).toBe(screen.getByRole("button",{name:"Expand conversation"}));}finally{release();}
 });

 it("reveals an obscured primary plot once on deliberate compact opening, not on replies or viewport changes",()=>{
  vi.useFakeTimers();vi.stubGlobal("innerWidth",390);vi.stubGlobal("innerHeight",844);sessionStorage.setItem("arx.assistant.open.v2","0");
  const original=HTMLElement.prototype.getBoundingClientRect;
  const rect=vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(){const id=this.getAttribute("data-testid");return id==="arx-native-canvas"?{top:484,bottom:844,left:0,right:390,width:390,height:360} as DOMRect:id==="arx-assistant-panel"?{top:426,bottom:764,left:8,right:382,width:374,height:338} as DOMRect:original.call(this);});
  const release=registerChartStudyAssistant(()=>"Rendered RSI receipt");
  try{renderChartPanel();const plot=screen.getByTestId("arx-native-canvas"),reveal=vi.fn();plot.scrollIntoView=reveal;
   fireEvent.click(screen.getByTestId("arx-assistant-trigger"));act(()=>vi.advanceTimersByTime(30));expect(reveal).toHaveBeenCalledOnce();expect(reveal).toHaveBeenCalledWith({block:"center",inline:"nearest",behavior:"instant"});
   fireEvent.change(screen.getByTestId("arx-input"),{target:{value:"show RSI"}});fireEvent.click(screen.getByTestId("arx-send"));fireEvent(window,new Event("resize"));act(()=>vi.advanceTimersByTime(30));expect(reveal).toHaveBeenCalledOnce();
   fireEvent.click(screen.getByRole("button",{name:"Expand conversation"}));fireEvent.click(screen.getByRole("button",{name:"Keep chart visible"}));act(()=>vi.advanceTimersByTime(30));expect(reveal).toHaveBeenCalledTimes(2);
  }finally{release();rect.mockRestore();vi.useRealTimers();}
 });
 for(const scenario of ["already visible","short viewport","restored session"] as const)it(`does not move chart for ${scenario}`,()=>{
  vi.useFakeTimers();vi.stubGlobal("innerWidth",390);vi.stubGlobal("innerHeight",scenario==="short viewport"?280:844);sessionStorage.setItem("arx.assistant.open.v2",scenario==="restored session"?"1":"0");
  const rect=vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(){return this.getAttribute("data-testid")==="arx-native-canvas"?{top:scenario==="already visible"?80:484,bottom:844,left:0,right:390,width:390,height:360} as DOMRect:{top:426,bottom:764,left:8,right:382,width:374,height:338} as DOMRect;});
  try{renderChartPanel();const reveal=vi.fn();screen.getByTestId("arx-native-canvas").scrollIntoView=reveal;if(scenario!=="restored session")fireEvent.click(screen.getByTestId("arx-assistant-trigger"));act(()=>vi.advanceTimersByTime(30));expect(reveal).not.toHaveBeenCalled();}finally{rect.mockRestore();vi.useRealTimers();}
 });

 it("cancels a queued reveal when the selected chart undocks before the next frame",()=>{
  vi.useFakeTimers();vi.stubGlobal("innerWidth",390);vi.stubGlobal("innerHeight",844);sessionStorage.setItem("arx.assistant.open.v2","0");
  try{const view=renderChartPanel();const reveal=vi.fn();screen.getByTestId("arx-native-canvas").scrollIntoView=reveal;fireEvent.click(screen.getByTestId("arx-assistant-trigger"));view.rerender(<view.App showChart={false}/>);act(()=>vi.advanceTimersByTime(30));expect(reveal).not.toHaveBeenCalled();view.rerender(<view.App showChart={true}/>);const nextReveal=vi.fn();screen.getByTestId("arx-native-canvas").scrollIntoView=nextReveal;act(()=>vi.advanceTimersByTime(30));expect(nextReveal).not.toHaveBeenCalled();}finally{vi.useRealTimers();}
 });

 it("uses the current narrow viewport when opening after a closed desktop-to-phone resize",()=>{
  vi.useFakeTimers();vi.stubGlobal("innerWidth",1024);vi.stubGlobal("innerHeight",844);
  const rect=vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(){return this.getAttribute("data-testid")==="arx-native-canvas"?{top:484,bottom:844,left:0,right:390,width:390,height:360} as DOMRect:{top:426,bottom:764,left:8,right:382,width:374,height:338} as DOMRect;});
  try{renderChartPanel();fireEvent.click(screen.getByRole("button",{name:"Close",exact:true}));vi.stubGlobal("innerWidth",390);fireEvent(window,new Event("resize"));const reveal=vi.fn();screen.getByTestId("arx-native-canvas").scrollIntoView=reveal;fireEvent.click(screen.getByTestId("arx-assistant-trigger"));act(()=>vi.advanceTimersByTime(30));expect(screen.getByTestId("arx-assistant-panel").getAttribute("data-chart-layout")).toBe("compact");expect(reveal).toHaveBeenCalledOnce();}finally{rect.mockRestore();vi.useRealTimers();}
 });

});
