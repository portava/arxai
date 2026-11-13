import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { StructuralBar, DataOrigin, StructuralModel } from "@workspace/domain/structural";

let active = false;
/** CPU-bound fitting never blocks the application's execution/feed event loop. */
export async function fitInWorker(bars: StructuralBar[], origin: DataOrigin): Promise<StructuralModel> {
  if (active) throw new Error("MODEL_FIT_BUSY");
  active = true;
  try {
    return await new Promise<StructuralModel>((resolve, reject) => {
      const dev = import.meta.url.endsWith(".ts");
      const entry = fileURLToPath(new URL(dev ? "./fitWorker.ts" : "./structuralFitWorker.mjs", import.meta.url));
      const worker = dev
        ? new Worker("import('node:worker_threads').then(({workerData})=>import('tsx/esm/api').then(({tsImport})=>tsImport(workerData.entry, workerData.entry)));", { eval: true, workerData: { entry, bars, origin } })
        : new Worker(new URL("./structuralFitWorker.mjs", import.meta.url), { workerData: { bars, origin } });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error("MODEL_FIT_TIMEOUT")); }, 30_000);
      worker.once("message", (message: { model?: StructuralModel; error?: string }) => {
        clearTimeout(timer); void worker.terminate();
        if (message.model) resolve(message.model); else reject(new Error(message.error ?? "MODEL_FIT_FAILED"));
      });
      worker.once("error", error => { clearTimeout(timer); reject(error); });
      worker.once("exit", () => { clearTimeout(timer); reject(new Error("MODEL_WORKER_EXITED")); });
    });
  } finally { active = false; }
}
