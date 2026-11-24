import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { StructuralBar, DataOrigin, StructuralModel } from "@workspace/domain/structural";

const FIT_TIMEOUT_MS = 30_000;
// Bound retained bar arrays while servicing several charts with one CPU worker.
const MAX_OUTSTANDING_FITS = 8;
let outstanding = 0;
let tail: Promise<void> = Promise.resolve();

export function fitInWorker(bars: StructuralBar[], origin: DataOrigin): Promise<StructuralModel> {
  if (outstanding >= MAX_OUTSTANDING_FITS) return Promise.reject(new Error("MODEL_FIT_BUSY"));
  outstanding++;
  const deadline = performance.now() + FIT_TIMEOUT_MS;
  const fit = tail.then(() => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("MODEL_FIT_TIMEOUT");
    return runWorker(bars, origin, remaining);
  }).finally(() => { outstanding--; });
  // A failed market must release its place for every later request.
  tail = fit.then(() => undefined, () => undefined);
  return fit;
}

function runWorker(bars: StructuralBar[], origin: DataOrigin, timeoutMs: number): Promise<StructuralModel> {
  return new Promise((resolve, reject) => {
    const dev = import.meta.url.endsWith(".ts");
    const entry = fileURLToPath(new URL(dev ? "./fitWorker.ts" : "./structuralFitWorker.mjs", import.meta.url));
    const worker = dev
      ? new Worker("import('node:worker_threads').then(({workerData})=>import('tsx/esm/api').then(({tsImport})=>tsImport(workerData.entry, workerData.entry)));", { eval: true, workerData: { entry, bars, origin } })
      : new Worker(new URL("./structuralFitWorker.mjs", import.meta.url), { workerData: { bars, origin } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("MODEL_FIT_TIMEOUT")); }, timeoutMs);
    worker.once("message", (message: { model?: StructuralModel; error?: string }) => {
      clearTimeout(timer); void worker.terminate();
      if (message.model) resolve(message.model); else reject(new Error(message.error ?? "MODEL_FIT_FAILED"));
    });
    worker.once("error", error => { clearTimeout(timer); reject(new Error("MODEL_WORKER_FAILED", { cause: error })); });
    worker.once("exit", () => { clearTimeout(timer); reject(new Error("MODEL_WORKER_EXITED")); });
  });
}
