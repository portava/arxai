/**
 * React hook for voice recording using MediaRecorder API.
 * Negotiates a supported MIME type across browsers (Chrome, Firefox, Safari).
 */
import { useRef, useCallback, useState, useEffect } from "react";

export type RecordingState = "idle" | "recording" | "stopped";

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/aac",
];

function getSupportedMimeType(): string | undefined {
  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return undefined;
}

export function useVoiceRecorder() {
  const [state, setState] = useState<RecordingState>("idle");
  type Recording={recorder:MediaRecorder;chunks:Blob[];mimeType:string|undefined};
  const recordingRef=useRef<Recording|null>(null);
  const generation=useRef(0);
  const abortError=()=>{const error=new Error("Recording start was cancelled");error.name="AbortError";return error;};
  const discard=(recording:Recording|null)=>{
    if(!recording)return;
    try{if(recording.recorder.state==="recording")recording.recorder.stop();}catch{/* already stopped */}
    recording.recorder.stream.getTracks().forEach(track=>track.stop());
  };
  useEffect(()=>()=>{generation.current++;const old=recordingRef.current;recordingRef.current=null;discard(old);},[]);

  const startRecording = useCallback(async (): Promise<void> => {
    const owner=++generation.current;
    const old=recordingRef.current;recordingRef.current=null;discard(old);
    let stream:MediaStream;
    try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}
    catch(error){if(owner!==generation.current)throw abortError();throw error;}
    if(owner!==generation.current){stream.getTracks().forEach(track=>track.stop());throw abortError();}
    try{
      const mimeType=getSupportedMimeType();
      const recorder=mimeType?new MediaRecorder(stream,{mimeType}):new MediaRecorder(stream);
      // Every recorder owns its chunks and MIME; old stop events cannot consume
      // or overwrite a newer recording's data or React state.
      const recording:Recording={recorder,chunks:[],mimeType};
      recordingRef.current=recording;
      recorder.ondataavailable=event=>{if(event.data.size>0)recording.chunks.push(event.data);};
      recorder.start(100);setState("recording");
    }catch(error){stream.getTracks().forEach(track=>track.stop());if(owner===generation.current)recordingRef.current=null;throw error;}
  },[]);

  const stopRecording=useCallback(():Promise<Blob>=>{
    const owner=++generation.current; // Also cancels a permission request still pending.
    const recording=recordingRef.current;recordingRef.current=null;
    if(!recording||recording.recorder.state!=="recording"){discard(recording);return Promise.resolve(new Blob());}
    return new Promise((resolve,reject)=>{
      const recorder=recording.recorder;
      recorder.onstop=()=>{
        const blob=new Blob(recording.chunks,{type:recording.mimeType??recorder.mimeType??"audio/webm"});
        recorder.stream.getTracks().forEach(track=>track.stop());
        if(owner===generation.current)setState("stopped");
        resolve(blob);
      };
      try{recorder.stop();}catch(error){recorder.stream.getTracks().forEach(track=>track.stop());reject(error);}
    });
  },[]);
  return {state,startRecording,stopRecording};
}
