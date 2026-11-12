import { parentPort, workerData } from "node:worker_threads";
import { fitStructuralModel } from "@workspace/domain/structural";
try { parentPort!.postMessage({ model: fitStructuralModel(workerData.bars, workerData.origin) }); }
catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : "MODEL_FIT_FAILED" }); }
