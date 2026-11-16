import {renderHook,act,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
const h=vi.hoisted(()=>({clear:vi.fn(),init:vi.fn(async()=>{}),pushAudio:vi.fn()}));
vi.mock('../../../../../lib/integrations-openai-ai-react/src/audio/useAudioPlayback',()=>({useAudioPlayback:()=>({state:'idle',init:h.init,clear:h.clear,pushAudio:h.pushAudio,signalComplete:vi.fn()})}));
import {useVoiceStream} from '../../../../../lib/integrations-openai-ai-react/src/audio/useVoiceStream';
import {useRealtimeVoice} from './useRealtimeVoice';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {promise,resolve};}
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
it('cancels existing uploaded voice and queued audio, discarding a late response transcript',async()=>{
 const response=deferred<Response>(),onTranscript=vi.fn(),onError=vi.fn();vi.stubGlobal('fetch',vi.fn(()=>response.promise));
 const {result}=renderHook(()=>useVoiceStream({workletPath:'/offline',onTranscript,onError}));let pending!:Promise<void>;
 await act(async()=>{pending=result.current.streamVoiceResponse('/offline-voice',new Blob(['offline'],{type:'audio/webm'}));await Promise.resolve();});
 const signal=vi.mocked(fetch).mock.calls[0]![1]!.signal as AbortSignal;const clears=h.clear.mock.calls.length;
 act(()=>result.current.cancelVoiceResponse());expect(signal.aborted).toBe(true);expect(h.clear.mock.calls.length).toBeGreaterThan(clears);
 await act(async()=>{response.resolve(new Response('data: {"type":"transcript","data":"wrong pane"}\n\n'));await pending;});expect(onTranscript).not.toHaveBeenCalled();expect(onError).not.toHaveBeenCalled();expect(h.pushAudio).not.toHaveBeenCalled();
});
it('does not request microphone or provider handshake when stopped while realtime mint body is pending',async()=>{
 const body=deferred<any>(),getUserMedia=vi.fn();vi.stubGlobal('navigator',{mediaDevices:{getUserMedia}});vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:()=>body.promise})));
 const {result}=renderHook(()=>useRealtimeVoice());let pending!:Promise<void>;
 await act(async()=>{pending=result.current.start();await Promise.resolve();});await act(async()=>result.current.stop());
 await act(async()=>{body.resolve({mode:'true_webrtc_realtime',clientSecret:{value:'offline-never-used'},safety:{safetyMode:'paper_only',liveLocked:true}});await pending;});
 expect(getUserMedia).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1);expect(result.current.state).toBe('idle');
});

it('drops a late non-OK uploaded voice error body after cancellation',async()=>{
 const body=deferred<any>(),onError=vi.fn();vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:503,clone:()=>({json:()=>body.promise}),text:async()=>''})));
 const {result}=renderHook(()=>useVoiceStream({workletPath:'/offline',onError}));let pending!:Promise<void>;
 await act(async()=>{pending=result.current.streamVoiceResponse('/offline-voice',new Blob(['offline']));await Promise.resolve();});act(()=>result.current.cancelVoiceResponse());
 await act(async()=>{body.resolve({error:'late old error'});await pending;});expect(onError).not.toHaveBeenCalled();
});

import {useVoiceRecorder} from '../../../../../lib/integrations-openai-ai-react/src/audio/useVoiceRecorder';
it('a stopped pending recorder start cannot replace a newer recorder or release its stream',async()=>{
 const oldPermission=deferred<MediaStream>(),oldStop=vi.fn(),newStop=vi.fn();const oldStream={id:'old',getTracks:()=>[{stop:oldStop}]},newStream={id:'new-data',getTracks:()=>[{stop:newStop}]};
 const made:any[]=[];
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:vi.fn().mockImplementationOnce(()=>oldPermission.promise).mockResolvedValueOnce(newStream)}});
 vi.stubGlobal('MediaRecorder',class{static isTypeSupported(){return true;}state='inactive';mimeType='audio/webm';ondataavailable:any;onstop:any;constructor(public stream:any){made.push(this);}start(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob([this.stream.id])});this.onstop?.();}});
 const {result}=renderHook(()=>useVoiceRecorder());let old!:Promise<unknown>;
 await act(async()=>{old=result.current.startRecording().catch(error=>error.name);await Promise.resolve();});await act(async()=>{await result.current.stopRecording();});await act(async()=>{await result.current.startRecording();});
 await act(async()=>{oldPermission.resolve(oldStream as unknown as MediaStream);await old;});expect(oldStop).toHaveBeenCalledOnce();expect(newStop).not.toHaveBeenCalled();expect(made).toHaveLength(1);expect(made[0].stream).toBe(newStream);
 let blob!:Blob;await act(async()=>{blob=await result.current.stopRecording();});expect(blob.size).toBe('new-data'.length);expect(newStop).toHaveBeenCalledOnce();
});
it('a stale realtime mint cannot request microphone after stop and a newer start',async()=>{
 const oldMint=deferred<any>(),newMint=deferred<any>(),getUserMedia=vi.fn(async()=>{throw new Error('offline microphone must not be requested');});let requests=0;
 vi.stubGlobal('navigator',{mediaDevices:{getUserMedia}});vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:()=>++requests===1?oldMint.promise:newMint.promise})));
 const {result}=renderHook(()=>useRealtimeVoice());let old!:Promise<void>,next!:Promise<void>;
 await act(async()=>{old=result.current.start();await Promise.resolve();});await act(async()=>result.current.stop());await act(async()=>{next=result.current.start();await Promise.resolve();});
 await act(async()=>{oldMint.resolve({mode:'true_webrtc_realtime',clientSecret:{value:'offline-old'},safety:{safetyMode:'paper_only',liveLocked:true}});await old;});expect(getUserMedia).not.toHaveBeenCalled();expect(result.current.state).toBe('connecting');
 await act(async()=>result.current.stop());await act(async()=>{newMint.resolve({mode:'text_only_fallback'});await next;});
});
