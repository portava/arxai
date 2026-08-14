import { useCallback, useEffect, useRef } from "react";
import { useAudioPlayback } from "./useAudioPlayback";

interface StreamCallbacks {
  workletPath: string;
  onUserTranscript?: (text: string) => void;
  onTranscript?: (text: string, full: string) => void;
  onComplete?: (transcript: string) => void;
  onError?: (error: Error) => void;
}

type TypedVoiceStreamEvent =
  | { type: "user_transcript"; data: string }
  | { type: "transcript"; data: string }
  | { type: "audio"; data: string }
  | { type: "error"; error: string };

type DoneEvent = { done: true };

type VoiceStreamEvent = TypedVoiceStreamEvent | DoneEvent;

type PlaybackHandle = ReturnType<typeof useAudioPlayback>;

type StreamState = {
  fullTranscript: string;
  didComplete: boolean;
};

const SSE_EVENT_DELIMITER = /\r\n\r\n|\n\n|\r\r/g;

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : "Unknown error");
}

function notifyError(callbacks: Pick<StreamCallbacks, "onError">, error: Error) {
  try {
    callbacks.onError?.(error);
  } catch {
    // Do not let onError mask the original error.
  }
}

function isVoiceStreamEvent(value: unknown): value is VoiceStreamEvent {
  if (!value || typeof value !== "object") return false;

  const record = value as Record<string, unknown>;

  if (record.done === true) return true;

  switch (record.type) {
    case "user_transcript":
    case "transcript":
    case "audio":
      return typeof record.data === "string";
    case "error":
      return typeof record.error === "string";
    default:
      return false;
  }
}

function parseVoiceStreamEvent(raw: string): VoiceStreamEvent | null {
  // Phase 22F — be tolerant of non-canonical or future event shapes
  // (e.g. server heartbeat `{type:"ping"}`, provider events the lib
  // doesn't know about). Returning null lets the caller drop the
  // event silently instead of bubbling a thrown error to the user UI.
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    if (typeof console !== "undefined") {
      console.warn("[useVoiceStream] dropped malformed SSE JSON payload");
    }
    return null;
  }

  if (!isVoiceStreamEvent(parsed)) {
    if (typeof console !== "undefined") {
      const t = (parsed && typeof parsed === "object") ? (parsed as Record<string, unknown>).type : undefined;
      console.warn("[useVoiceStream] dropped non-canonical SSE event", t);
    }
    return null;
  }

  return parsed;
}

function readSseDataFromBlock(block: string): string | null {
  const normalizedBlock = block.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const dataLines: string[] = [];

  for (const line of normalizedBlock.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }

    // SSE allows one optional leading space after the colon.
    dataLines.push(line.slice(5).replace(/^ /, ""));
  }

  if (dataLines.length === 0) {
    return null;
  }

  return dataLines.join("\n");
}

function extractCompleteSseBlocks(buffer: string): {
  blocks: string[];
  remaining: string;
} {
  const blocks: string[] = [];
  let lastIndex = 0;

  SSE_EVENT_DELIMITER.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SSE_EVENT_DELIMITER.exec(buffer)) !== null) {
    blocks.push(buffer.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
  }

  return {
    blocks,
    remaining: buffer.slice(lastIndex),
  };
}

function isDoneEvent(event: VoiceStreamEvent): event is DoneEvent {
  return "done" in event && (event as DoneEvent).done === true;
}

function handleVoiceStreamEvent(
  event: VoiceStreamEvent,
  playback: PlaybackHandle,
  callbacks: Omit<StreamCallbacks, "workletPath">,
  state: StreamState
) {
  if (isDoneEvent(event)) {
    if (!state.didComplete) {
      state.didComplete = true;
      playback.signalComplete();
      callbacks.onComplete?.(state.fullTranscript);
    }
    return;
  }

  switch (event.type) {
    case "user_transcript":
      callbacks.onUserTranscript?.(event.data);
      return;

    case "transcript":
      state.fullTranscript += event.data;
      callbacks.onTranscript?.(event.data, state.fullTranscript);
      return;

    case "audio":
      playback.pushAudio(event.data);
      return;

    case "error":
      throw new Error(event.error);
  }
}

async function readErrorText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

export function useVoiceStream({ workletPath, ...callbacks }: StreamCallbacks) {
  const playback = useAudioPlayback(workletPath);

  const callbacksRef = useRef<Omit<StreamCallbacks, "workletPath">>(callbacks);
  callbacksRef.current = callbacks;

  const playbackRef = useRef<PlaybackHandle>(playback);
  playbackRef.current = playback;

  const activeRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      activeRequestRef.current?.abort();
    };
  }, []);

  const streamVoiceResponse = useCallback(
    async (url: string, audioBlob: Blob): Promise<void> => {
      activeRequestRef.current?.abort();

      const abortController = new AbortController();
      activeRequestRef.current = abortController;

      const throwIfNotCurrent = () => {
        if (
          abortController.signal.aborted ||
          activeRequestRef.current !== abortController
        ) {
          throw createAbortError();
        }
      };

      const processBlocks = (blocks: string[], state: StreamState) => {
        for (const block of blocks) {
          throwIfNotCurrent();

          const rawData = readSseDataFromBlock(block);
          if (!rawData) {
            continue;
          }

          const event = parseVoiceStreamEvent(rawData);
          if (!event) continue; // non-canonical / heartbeat — drop silently
          handleVoiceStreamEvent(
            event,
            playbackRef.current,
            callbacksRef.current,
            state
          );
        }
      };

      const state: StreamState = {
        fullTranscript: "",
        didComplete: false,
      };

      try {
        await playbackRef.current.init();
        throwIfNotCurrent();

        playbackRef.current.clear();

        // Phase 22D — multipart/form-data upload. Avoids ~33% base64 bloat
        // and lets the server enforce a route-scoped multer file-size limit
        // without inflating the global express.json() ceiling.
        const form = new FormData();
        const ext = audioBlob.type.includes("webm") ? "webm"
          : audioBlob.type.includes("mp4") ? "mp4"
          : audioBlob.type.includes("aac") ? "aac"
          : "bin";
        form.append("audio", audioBlob, `voice.${ext}`);
        throwIfNotCurrent();

        const response = await fetch(url, {
          method: "POST",
          headers: { Accept: "text/event-stream" },
          body: form,
          credentials: "include",
          signal: abortController.signal,
        });
        throwIfNotCurrent();

        if (!response.ok) {
          // Try to extract a structured JSON error code (e.g. VOICE_TOO_LARGE)
          // before falling back to status text. We deliberately do NOT
          // surface raw HTML — the panel layer also sanitizes.
          let code = "";
          let message = "";
          try {
            const j = await response.clone().json() as { error?: string; message?: string };
            code = j?.error ?? "";
            message = j?.message ?? "";
          } catch { /* not JSON */ }
          if (code === "VOICE_TOO_LARGE" || response.status === 413) {
            throw new Error("VOICE_TOO_LARGE");
          }
          const detail = message || (await readErrorText(response));
          throw new Error(
            detail
              ? `Voice request failed (${response.status} ${response.statusText}): ${detail}`
              : `Voice request failed (${response.status} ${response.statusText})`
          );
        }

        if (!response.body) {
          throw new Error("Voice request failed: response body is missing");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            throwIfNotCurrent();

            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });

            const { blocks, remaining } = extractCompleteSseBlocks(buffer);
            buffer = remaining;

            processBlocks(blocks, state);
          }

          // Flush any trailing UTF-8 bytes.
          buffer += decoder.decode();

          const { blocks, remaining } = extractCompleteSseBlocks(buffer);
          processBlocks(blocks, state);

          // Process a final unterminated event if the server closed without a trailing blank line.
          const finalData = readSseDataFromBlock(remaining);
          if (finalData) {
            throwIfNotCurrent();

            const event = parseVoiceStreamEvent(finalData);
            if (event) {
              handleVoiceStreamEvent(
                event,
                playbackRef.current,
                callbacksRef.current,
                state
              );
            }
          }
        } finally {
          try {
            await reader.cancel();
          } catch {
            // Ignore cleanup errors.
          }

          reader.releaseLock();
        }
      } catch (error) {
        const err = toError(error);

        if (err.name === "AbortError") {
          return;
        }

        notifyError(callbacksRef.current, err);
        throw err;
      } finally {
        if (activeRequestRef.current === abortController) {
          activeRequestRef.current = null;
        }
      }
    },
    []
  );

  return { streamVoiceResponse, playbackState: playback.state };
}