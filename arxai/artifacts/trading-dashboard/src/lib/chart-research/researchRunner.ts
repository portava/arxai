import type { DeepReadonly, ResearchV2Config, ResearchV2Input, ResearchV2Result } from "@workspace/domain/backtest/research-core";

export interface ResearchWorkerPort {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
export type ResearchRunOutcome = { status: "complete"; result: DeepReadonly<ResearchV2Result> } | { status: "error"; message: string };
export function createResearchRunner(factory: () => ResearchWorkerPort, timeoutMs = 60_000) {
  let sequence = 0;
  let active: ResearchWorkerPort | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    sequence++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const previous = active;
    active = null;
    if (previous) {
      previous.onmessage = previous.onerror = previous.onmessageerror = null;
      previous.terminate();
    }
  };
  return {
    cancel,
    run(input: ResearchV2Input, config: ResearchV2Config, receive: (outcome: ResearchRunOutcome) => void) {
      cancel();
      const id = sequence;
      let port: ResearchWorkerPort;
      const finish = (outcome: ResearchRunOutcome) => {
        if (id !== sequence) return;
        cancel();
        receive(outcome);
      };
      try {
        port = factory();
        active = port;
        port.onmessage = event => {
          if (event.data?.id !== id || id !== sequence) return;
          if (typeof event.data.error === "string") finish({ status: "error", message: event.data.error });
          else if (event.data.result && typeof event.data.result === "object") finish({ status: "complete", result: event.data.result });
          else finish({ status: "error", message: "The historical calculation returned an unreadable result." });
        };
        port.onerror = () => finish({ status: "error", message: "Historical calculation could not start or stopped unexpectedly. No result was accepted." });
        port.onmessageerror = () => finish({ status: "error", message: "Historical calculation could not be read. No result was accepted." });
        timer = setTimeout(() => finish({ status: "error", message: "Historical calculation exceeded its time limit. Reduce the window and retry." }), timeoutMs);
        port.postMessage({ id, input, config });
      } catch {
        finish({ status: "error", message: "This browser could not start the historical calculation. No result was accepted." });
      }
    },
  };
}

export const createBrowserResearchRunner = () => createResearchRunner(
  () => new Worker(new URL("./researchWorker.ts", import.meta.url), { type: "module", name: "arx-historical-research" }),
);
