import {useLayoutEffect} from "react";
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
  voiceStream:vi.fn(async()=>{}),voiceCallbacks:null as any,ttsStop:vi.fn(),streamReset:vi.fn(),streamPush:vi.fn(),streamFlush:vi.fn(),cancelVoice:vi.fn(),recordStart:vi.fn(async()=>{}),recordStop:vi.fn(async()=>new Blob()),realtimeStart:vi.fn(),realtimeStop:vi.fn(),speak:vi.fn(),
}));

vi.mock("@workspace/integrations-openai-ai-react/audio", () => ({
  useVoiceStream: (callbacks:any) => {h.voiceCallbacks=callbacks;return { streamVoiceResponse:h.voiceStream,cancelVoiceResponse:h.cancelVoice };},
  useVoiceRecorder: () => ({ startRecording:h.recordStart, stopRecording:h.recordStop }),
}));

vi.mock("./useRealtimeVoice", () => ({
  useRealtimeVoice: () => ({
    state: "idle",
    isMuted: false,
    start: h.realtimeStart,
    stop: h.realtimeStop,
    toggleMute: vi.fn(),
  }),
}));

vi.mock("./useSpeakResponses", () => ({
  useSpeakResponses: () => ({
    state: h.ttsState,
    enabled: true,
    speak:h.speak,
    supported: true,
    setEnabled: vi.fn(),
    stop: h.ttsStop,
    speakStreamReset:h.streamReset,speakStreamPush:h.streamPush,speakStreamFlush:h.streamFlush,
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
  useSearch: () => "",
}));

import { ArxAssistantLivePanel } from "./ArxAssistantLivePanel";
import { AssistantDockProvider, AssistantDockSlot, useAssistantChartPane } from "./AssistantDock";

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
  h.ttsState = "idle";h.cancelVoice.mockClear();h.voiceStream.mockReset();h.voiceStream.mockResolvedValue(undefined);h.recordStart.mockReset();h.recordStart.mockResolvedValue(undefined);h.recordStop.mockReset();h.recordStop.mockResolvedValue(new Blob());h.realtimeStart.mockClear();h.realtimeStop.mockClear();h.speak.mockClear();h.ttsStop.mockClear();h.streamReset.mockClear();h.streamPush.mockClear();h.streamFlush.mockClear();
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

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
describe("initial history versus immediate local chart turns",()=>{
 it("merges deferred history once without replacing a current local chart turn",async()=>{
  const body=deferred<any>(),bodyStarted=vi.fn();
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
   if(String(url).endsWith('/conversations')&&!init?.method)return Response.json({conversations:[{id:7,title:'Saved'}]});
   if(String(url).endsWith('/conversations/7'))return {ok:true,json:()=>{bodyStarted();return body.promise;}} as Response;
   return Response.json({});
  });
  const release=registerChartStudyAssistant(()=>"Actual immediate RSI observation");
  try{renderPanel();await act(async()=>{});expect(bodyStarted).toHaveBeenCalledOnce();
   fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'show RSI'}});fireEvent.click(screen.getByTestId('arx-send'));
   expect(screen.getByText('Actual immediate RSI observation')).toBeTruthy();
   await act(async()=>body.resolve({conversation:{id:7,title:'Saved'},messages:[{id:40,role:'user',content:'Earlier saved question'},{id:40,role:'user',content:'Earlier saved question'}]}));
   expect(screen.getAllByText('Actual immediate RSI observation')).toHaveLength(1);expect(screen.getAllByText('show RSI')).toHaveLength(1);expect(screen.getAllByText('Earlier saved question')).toHaveLength(1);
   expect(vi.mocked(fetch).mock.calls.some(([url,init])=>String(url).endsWith('/messages')&&init?.method==='POST')).toBe(false);
  }finally{release();}
 });
 for(const phase of ['list','detail'] as const)it(`ignores a stale ${phase} JSON body after New chat has selected another conversation`,async()=>{
  const body=deferred<any>(),bodyStarted=vi.fn();
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
   const path=String(url);
   if(path.endsWith('/conversations')&&init?.method==='POST')return Response.json({conversation:{id:21,title:'New'}});
   if(path.endsWith('/conversations')&&!init?.method)return phase==='list'?{ok:true,json:()=>{bodyStarted();return body.promise;}} as Response:Response.json({conversations:[{id:7,title:'Old'}]});
   if(path.endsWith('/conversations/7'))return {ok:true,json:()=>{bodyStarted();return body.promise;}} as Response;
   if(path.endsWith('/messages'))return new Response('',{status:503});
   return Response.json({});
  });
  renderPanel();await act(async()=>{});expect(bodyStarted).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByTestId('arx-menu-button'));await act(async()=>fireEvent.click(screen.getByTestId('arx-menu-new-chat')));
  await act(async()=>body.resolve(phase==='list'?{conversations:[{id:7,title:'Old'}]}:{conversation:{id:7,title:'Old'},messages:[{id:8,role:'assistant',content:'Stale other conversation'}]}));
  expect(screen.queryByText('Stale other conversation')).toBeNull();
  if(phase==='list')expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).endsWith('/conversations/7'))).toBe(false);
  fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'Hello assistant'}});await act(async()=>fireEvent.click(screen.getByTestId('arx-send')));
  expect(vi.mocked(fetch).mock.calls.filter(([url,init])=>String(url).endsWith('/messages')&&init?.method==='POST').map(([url])=>String(url))).toEqual(['/api/me/assistant/conversations/21/messages']);
 });
 it("invalidates old hydration as soon as New chat is requested, before its POST resolves",async()=>{
  const oldBody=deferred<any>(),newChat=deferred<Response>();
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
   if(String(url).endsWith('/conversations')&&init?.method==='POST')return newChat.promise;
   if(String(url).endsWith('/conversations'))return Response.json({conversations:[{id:7,title:'Old'}]});
   if(String(url).endsWith('/conversations/7'))return {ok:true,json:()=>oldBody.promise} as Response;
   return Response.json({});
  });
  renderPanel();await act(async()=>{});fireEvent.click(screen.getByTestId('arx-menu-button'));fireEvent.click(screen.getByTestId('arx-menu-new-chat'));
  await act(async()=>oldBody.resolve({conversation:{id:7,title:'Old'},messages:[{id:8,role:'assistant',content:'Wrong pending history'}]}));
  expect(screen.queryByText('Wrong pending history')).toBeNull();
  await act(async()=>newChat.resolve(Response.json({conversation:{id:21,title:'New'}})));
 });
 it("retries unfinished history after reopen without a fallback POST and discards the old body",async()=>{
  const oldBody=deferred<any>();let lists=0;
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
   if(String(url).endsWith('/conversations')&&!init?.method)return Response.json({conversations:[{id:++lists===1?7:9,title:'Saved'}]});
   if(String(url).endsWith('/conversations/7'))return {ok:true,json:()=>oldBody.promise} as Response;
   if(String(url).endsWith('/conversations/9'))return Response.json({conversation:{id:9,title:'Current saved'},messages:[{id:19,role:'assistant',content:'Current saved history'}]});
   return Response.json({});
  });
  const release=registerChartStudyAssistant(()=>"Current reopened RSI receipt");
  try{renderPanel();await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Close',exact:true}));await act(async()=>fireEvent.click(screen.getByTestId('arx-assistant-trigger')));
   fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'show RSI'}});fireEvent.click(screen.getByTestId('arx-send'));
   await act(async()=>oldBody.resolve({conversation:{id:7,title:'Old'},messages:[{id:8,role:'assistant',content:'Closed session history'}]}));
   expect(screen.queryByText('Closed session history')).toBeNull();expect(screen.getAllByText('Current reopened RSI receipt')).toHaveLength(1);expect(screen.getAllByText('Current saved history')).toHaveLength(1);
   expect(lists).toBe(2);expect(vi.mocked(fetch).mock.calls.some(([url,init])=>String(url).endsWith('/conversations')&&init?.method==='POST')).toBe(false);
  }finally{release();}
 });
 it("keeps remote sends gated on conversation readiness and uses the resumed identity after hydration",async()=>{
  const body=deferred<any>();
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
   if(String(url).endsWith('/conversations')&&!init?.method)return Response.json({conversations:[{id:7,title:'Saved'}]});
   if(String(url).endsWith('/conversations/7'))return {ok:true,json:()=>body.promise} as Response;
   if(String(url).endsWith('/messages'))return new Response('',{status:503});
   return Response.json({});
  });
  renderPanel();await act(async()=>{});fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'Hello assistant'}});fireEvent.click(screen.getByTestId('arx-send'));
  expect(screen.getByText(/Chat session not ready yet/)).toBeTruthy();expect(vi.mocked(fetch).mock.calls.some(([url])=>String(url).endsWith('/messages'))).toBe(false);
  await act(async()=>body.resolve({conversation:{id:7,title:'Saved'},messages:[]}));await act(async()=>fireEvent.click(screen.getByTestId('arx-send')));
  expect(vi.mocked(fetch).mock.calls.filter(([url,init])=>String(url).endsWith('/messages')&&init?.method==='POST').map(([url])=>String(url))).toEqual(['/api/me/assistant/conversations/7/messages']);
 });

 it("does not bootstrap over a pending New chat after reopen and keeps post-intent local turns",async()=>{
  const oldBody=deferred<any>(),newChat=deferred<Response>();
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
   if(String(url).endsWith('/conversations')&&init?.method==='POST')return newChat.promise;
   if(String(url).endsWith('/conversations'))return Response.json({conversations:[{id:7,title:'Old'}]});
   if(String(url).endsWith('/conversations/7'))return {ok:true,json:()=>oldBody.promise} as Response;
   return Response.json({});
  });
  const release=registerChartStudyAssistant(()=>"New intent RSI receipt");
  try{renderPanel();await act(async()=>{});fireEvent.click(screen.getByTestId('arx-menu-button'));fireEvent.click(screen.getByTestId('arx-menu-new-chat'));
   fireEvent.click(screen.getByRole('button',{name:'Close',exact:true}));await act(async()=>fireEvent.click(screen.getByTestId('arx-assistant-trigger')));
   fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'show RSI'}});fireEvent.click(screen.getByTestId('arx-send'));
   expect(vi.mocked(fetch).mock.calls.filter(([url,init])=>String(url).endsWith('/conversations')&&init?.method==='POST')).toHaveLength(1);
   await act(async()=>newChat.resolve(Response.json({conversation:{id:21,title:'New'}})));
   expect(screen.getAllByText('New intent RSI receipt')).toHaveLength(1);
   await act(async()=>oldBody.resolve({conversation:{id:7,title:'Old'},messages:[{id:8,role:'assistant',content:'Wrong pending history'}]}));expect(screen.queryByText('Wrong pending history')).toBeNull();
  }finally{release();}
 });

 it("retains new local turns across same-millisecond chat replacement without keeping old turns",async()=>{
  const replacement=deferred<Response>(),briefing=deferred<Response>(),clock=vi.spyOn(Date,'now').mockReturnValue(1770000000000);let calls=0;
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
   if(String(url).endsWith('/conversations')&&init?.method==='POST')return replacement.promise;
   if(String(url).includes('/briefing?'))return briefing.promise;
   if(String(url).endsWith('/conversations'))return Response.json({conversations:[{id:7,title:'Saved'}]});
   if(String(url).endsWith('/conversations/7'))return Response.json({conversation:{id:7,title:'Saved'},messages:[]});
   return Response.json({});
  });
  const release=registerChartStudyAssistant(()=>++calls===1?'Old local observation':'New local observation');
  try{renderPanel();await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Refresh briefing'}));fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'show RSI'}});fireEvent.click(screen.getByTestId('arx-send'));
   fireEvent.click(screen.getByTestId('arx-menu-button'));fireEvent.click(screen.getByTestId('arx-menu-new-chat'));
   fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'show RSI'}});fireEvent.click(screen.getByTestId('arx-send'));
   await act(async()=>briefing.resolve(Response.json({briefing:{headline:'Late old briefing',lines:[],suggestions:[],updatedAt:'2026-01-01'}})));expect(screen.getByText('Late old briefing')).toBeTruthy();
   await act(async()=>replacement.resolve(Response.json({conversation:{id:21,title:'New'}})));
   expect(screen.queryByText('Late old briefing')).toBeNull();
   expect(screen.queryByText('Old local observation')).toBeNull();expect(screen.getAllByText('New local observation')).toHaveLength(1);
  }finally{release();clock.mockRestore();}
 });
 it("failed New chat preserves current turns and the previous remote conversation",async()=>{
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
   if(String(url).endsWith('/conversations')&&init?.method==='POST')return Response.json({error:'unavailable'},{status:503});
   if(String(url).endsWith('/conversations'))return Response.json({conversations:[{id:7,title:'Saved'}]});
   if(String(url).endsWith('/conversations/7'))return Response.json({conversation:{id:7,title:'Saved'},messages:[{id:9,role:'assistant',content:'Retained saved turn'}]});
   if(String(url).endsWith('/messages'))return new Response('',{status:503});return Response.json({});
  });
  renderPanel();await act(async()=>{});fireEvent.click(screen.getByTestId('arx-menu-button'));await act(async()=>fireEvent.click(screen.getByTestId('arx-menu-new-chat')));
  expect(screen.getByText('Could not start a new chat. Please try again.')).toBeTruthy();expect(screen.getByText('Retained saved turn')).toBeTruthy();
  fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'Hello assistant'}});await act(async()=>fireEvent.click(screen.getByTestId('arx-send')));
  expect(vi.mocked(fetch).mock.calls.filter(([url,init])=>String(url).endsWith('/messages')&&init?.method==='POST').map(([url])=>String(url))).toEqual(['/api/me/assistant/conversations/7/messages']);
 });

 it("shares one pending fallback creation across close and reopen when no history exists",async()=>{
  const created=deferred<Response>();
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
   if(String(url).endsWith('/conversations')&&init?.method==='POST')return created.promise;
   if(String(url).endsWith('/conversations'))return Response.json({conversations:[]});
   if(String(url).endsWith('/messages'))return new Response('',{status:503});return Response.json({});
  });
  renderPanel();await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Close',exact:true}));await act(async()=>fireEvent.click(screen.getByTestId('arx-assistant-trigger')));
  expect(vi.mocked(fetch).mock.calls.filter(([url,init])=>String(url).endsWith('/conversations')&&init?.method==='POST')).toHaveLength(1);
  await act(async()=>created.resolve(Response.json({conversation:{id:31,title:'Live chat'}})));
  fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'Hello assistant'}});await act(async()=>fireEvent.click(screen.getByTestId('arx-send')));
  expect(vi.mocked(fetch).mock.calls.filter(([url,init])=>String(url).endsWith('/messages')&&init?.method==='POST').map(([url])=>String(url))).toEqual(['/api/me/assistant/conversations/31/messages']);
 });

});

function ScopedPane({symbol,primary=false}:{symbol:string;primary?:boolean}){
 const pane=useAssistantChartPane({symbol,timeframe:'M15',source:'offline-source',contextKey:symbol,ready:true,analysisOnly:!primary});
 useLayoutEffect(()=>pane.active?registerChartStudyAssistant(()=>pane.isCurrent()?`Local ${symbol} observation`:'held'):undefined,[pane.active,pane.isCurrent,symbol]);
 return <section data-testid={`pane-${symbol}`}><button onClick={pane.activate}>Activate {symbol}</button>{primary?<AssistantDockSlot assistantEnabled={pane.active}/>:pane.active?<AssistantDockSlot assistantOnly/>:null}</section>;
}
function renderScopedPanel(){const client=new QueryClient({defaultOptions:{queries:{retry:false}}});return render(<QueryClientProvider client={client}><AssistantDockProvider><ScopedPane symbol="EURUSD" primary/><ScopedPane symbol="AAPL"/><ArxAssistantLivePanel/></AssistantDockProvider></QueryClientProvider>);}
describe('analysis comparison assistant boundaries',()=>{
 it('applies local tools to selected comparison but holds general text, microphone, realtime and briefing',async()=>{
  vi.useFakeTimers();vi.mocked(fetch).mockImplementation(async(url,init)=>String(url).endsWith('/voice-status')?Response.json({realtimeConfigured:true}):String(url).endsWith('/conversations')&&init?.method==='POST'?Response.json({conversation:{id:7,title:'Chat'}}):Response.json({}));
  try{renderScopedPanel();await act(async()=>{});fireEvent.click(screen.getByText('Activate AAPL'));await act(async()=>vi.advanceTimersByTime(650));
   expect(screen.getByTestId('assistant-selected-chart').textContent).toContain('AAPL · M15');expect((screen.getByTestId('arx-mic-toggle') as HTMLButtonElement).disabled).toBe(true);expect((screen.getByTestId('arx-realtime-start') as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole('button',{name:'Refresh briefing'}) as HTMLButtonElement).disabled).toBe(true);
   fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'show RSI'}});fireEvent.click(screen.getByTestId('arx-send'));expect(screen.getByText('Local AAPL observation')).toBeTruthy();
   fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'Tell me what to trade'}});fireEvent.click(screen.getByTestId('arx-send'));expect(screen.getByText(/selected analysis chart supports local chart tools only/)).toBeTruthy();
   expect(vi.mocked(fetch).mock.calls.some(([url])=>/\/messages$|\/voice$|\/realtime\/session$|\/briefing\?/.test(String(url)))).toBe(false);expect(h.cancelVoice).toHaveBeenCalled();expect(h.realtimeStop).toHaveBeenCalled();expect(h.speak).not.toHaveBeenCalled();
  }finally{vi.useRealTimers();}
 });
 it('drops a deferred primary briefing body after the comparison becomes selected',async()=>{
  const body=deferred<any>();vi.mocked(fetch).mockImplementation(async(url,init)=>String(url).includes('/briefing?')?{ok:true,json:()=>body.promise} as Response:String(url).endsWith('/conversations')&&init?.method==='POST'?Response.json({conversation:{id:7,title:'Chat'}}):Response.json({}));
  renderScopedPanel();await act(async()=>{});fireEvent.click(screen.getByRole('button',{name:'Refresh briefing'}));fireEvent.click(screen.getByText('Activate AAPL'));
  await act(async()=>body.resolve({briefing:{headline:'Wrong EURUSD briefing',lines:[],suggestions:[],updatedAt:'2026-01-01'}}));expect(screen.queryByText('Wrong EURUSD briefing')).toBeNull();expect(h.speak).not.toHaveBeenCalled();
 });
 it('drops microphone permission resolved after selecting the comparison without starting recorder',async()=>{
  const permission=deferred<MediaStream>(),stop=vi.fn();const original=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn(()=>permission.promise)}});
  try{renderScopedPanel();fireEvent.click(screen.getByTestId('arx-mic-toggle'));fireEvent.click(screen.getByText('Activate AAPL'));await act(async()=>permission.resolve({getTracks:()=>[{stop}]} as unknown as MediaStream));expect(stop).toHaveBeenCalledOnce();expect(h.recordStart).not.toHaveBeenCalled();}finally{if(original)Object.defineProperty(navigator,'mediaDevices',original);else delete (navigator as any).mediaDevices;}
 });
 it('stops active primary speech and discards late SSE content/done while allowing immediate local tools',async()=>{
  let stream!:ReadableStreamDefaultController<Uint8Array>;const encoder=new TextEncoder();const body=new ReadableStream<Uint8Array>({start(controller){stream=controller;}});
  vi.mocked(fetch).mockImplementation(async(url,init)=>String(url).endsWith('/messages')?new Response(body):String(url).endsWith('/conversations')&&init?.method==='POST'?Response.json({conversation:{id:7,title:'Chat'}}):Response.json({}));
  renderScopedPanel();await act(async()=>{});fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'General primary question'}});await act(async()=>fireEvent.click(screen.getByTestId('arx-send')));
  await act(async()=>stream.enqueue(encoder.encode('data: {"type":"content","content":"Primary reply started."}\n\n')));expect(h.streamPush).toHaveBeenCalledWith('Primary reply started.');const stops=h.ttsStop.mock.calls.length;
  fireEvent.click(screen.getByText('Activate AAPL'));expect(h.ttsStop.mock.calls.length).toBeGreaterThan(stops);
  fireEvent.change(screen.getByTestId('arx-input'),{target:{value:'show RSI'}});expect((screen.getByTestId('arx-send') as HTMLButtonElement).disabled).toBe(false);fireEvent.click(screen.getByTestId('arx-send'));expect(screen.getByText('Local AAPL observation')).toBeTruthy();
  await act(async()=>stream.enqueue(encoder.encode('data: {"type":"content","content":"Wrong late primary reply"}\n\ndata: {"type":"done"}\n\n')));
  expect(screen.queryByText(/Wrong late primary reply/)).toBeNull();expect(h.streamFlush).not.toHaveBeenCalled();expect(h.speak).not.toHaveBeenCalled();expect(screen.getByText('Local AAPL observation')).toBeTruthy();
 });

 it('old recorder-stop completion cannot release the new primary microphone or reset recording',async()=>{
  const pendingStop=deferred<Blob>(),oldStop=vi.fn(),newStop=vi.fn();const original=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValueOnce({getTracks:()=>[{stop:oldStop}]}).mockResolvedValueOnce({getTracks:()=>[{stop:newStop}]})}});
  try{renderScopedPanel();await act(async()=>{});await act(async()=>fireEvent.click(screen.getByTestId('arx-mic-toggle')));h.recordStop.mockImplementationOnce(()=>pendingStop.promise);
   fireEvent.click(screen.getByText('Activate AAPL'));expect(oldStop).toHaveBeenCalledOnce();await act(async()=>fireEvent.click(screen.getByText('Activate EURUSD')));await act(async()=>fireEvent.click(screen.getByTestId('arx-mic-toggle')));
   expect(screen.getByRole('button',{name:'Stop and send voice message'})).toBeTruthy();await act(async()=>pendingStop.resolve(new Blob()));expect(newStop).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Stop and send voice message'})).toBeTruthy();
  }finally{if(original)Object.defineProperty(navigator,'mediaDevices',original);else delete (navigator as any).mediaDevices;}
 });
 it('late canceled upload completion does not clear a newer primary upload lock',async()=>{
  const oldUpload=deferred<void>(),newUpload=deferred<void>();h.voiceStream.mockImplementationOnce(()=>oldUpload.promise).mockImplementationOnce(()=>newUpload.promise);h.recordStop.mockResolvedValue(new Blob(['voice']));
  const original=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn(async()=>({getTracks:()=>[{stop:vi.fn()}]}))}});
  vi.mocked(fetch).mockImplementation(async(url,init)=>String(url).endsWith('/conversations')&&init?.method==='POST'?Response.json({conversation:{id:7,title:'Chat'}}):Response.json({}));
  try{renderScopedPanel();await act(async()=>{});await act(async()=>fireEvent.click(screen.getByTestId('arx-mic-toggle')));await act(async()=>fireEvent.click(screen.getByTestId('arx-mic-toggle')));expect(h.voiceStream).toHaveBeenCalledTimes(1);
   await act(async()=>fireEvent.click(screen.getByText('Activate AAPL')));await act(async()=>fireEvent.click(screen.getByText('Activate EURUSD')));await act(async()=>fireEvent.click(screen.getByTestId('arx-mic-toggle')));await act(async()=>fireEvent.click(screen.getByTestId('arx-mic-toggle')));expect(h.voiceStream).toHaveBeenCalledTimes(2);
   act(()=>h.voiceCallbacks.onComplete());expect((screen.getByTestId('arx-mic-toggle') as HTMLButtonElement).disabled).toBe(true);
   await act(async()=>oldUpload.resolve());expect((screen.getByTestId('arx-mic-toggle') as HTMLButtonElement).disabled).toBe(true);
   await act(async()=>newUpload.resolve());expect((screen.getByTestId('arx-mic-toggle') as HTMLButtonElement).disabled).toBe(false);
  }finally{if(original)Object.defineProperty(navigator,'mediaDevices',original);else delete (navigator as any).mediaDevices;}
 });

 it('a pending stop-and-send cannot upload into a newly selected scope or release its microphone',async()=>{
  const stopping=deferred<Blob>(),newMicStop=vi.fn();const original=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValueOnce({getTracks:()=>[{stop:vi.fn()}]}).mockResolvedValueOnce({getTracks:()=>[{stop:newMicStop}]})}});
  vi.mocked(fetch).mockImplementation(async(url,init)=>String(url).endsWith('/conversations')&&init?.method==='POST'?Response.json({conversation:{id:7,title:'Chat'}}):Response.json({}));
  try{renderScopedPanel();await act(async()=>{});await act(async()=>fireEvent.click(screen.getByTestId('arx-mic-toggle')));h.recordStop.mockImplementationOnce(()=>stopping.promise);fireEvent.click(screen.getByTestId('arx-mic-toggle'));
   await act(async()=>fireEvent.click(screen.getByText('Activate AAPL')));await act(async()=>fireEvent.click(screen.getByText('Activate EURUSD')));await act(async()=>fireEvent.click(screen.getByTestId('arx-mic-toggle')));
   await act(async()=>stopping.resolve(new Blob(['old clip'])));expect(h.voiceStream).not.toHaveBeenCalled();expect(newMicStop).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Stop and send voice message'})).toBeTruthy();
  }finally{if(original)Object.defineProperty(navigator,'mediaDevices',original);else delete (navigator as any).mediaDevices;}
 });

 it('clears the old recording deadline instead of stopping a newer pending primary permission',async()=>{
  vi.useFakeTimers();const nextPermission=deferred<MediaStream>();const original=Object.getOwnPropertyDescriptor(navigator,'mediaDevices');Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValueOnce({getTracks:()=>[{stop:vi.fn()}]}).mockImplementationOnce(()=>nextPermission.promise)}});
  try{renderScopedPanel();await act(async()=>{});await act(async()=>fireEvent.click(screen.getByTestId('arx-mic-toggle')));await act(async()=>vi.advanceTimersByTime(5000));await act(async()=>fireEvent.click(screen.getByText('Activate AAPL')));await act(async()=>fireEvent.click(screen.getByText('Activate EURUSD')));fireEvent.click(screen.getByTestId('arx-mic-toggle'));const stops=h.recordStop.mock.calls.length;
   await act(async()=>vi.advanceTimersByTime(16000));expect(h.recordStop).toHaveBeenCalledTimes(stops);await act(async()=>nextPermission.resolve({getTracks:()=>[{stop:vi.fn()}]} as unknown as MediaStream));
  }finally{if(original)Object.defineProperty(navigator,'mediaDevices',original);else delete (navigator as any).mediaDevices;vi.useRealTimers();}
 });

});
