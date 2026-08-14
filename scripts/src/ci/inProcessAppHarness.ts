// Shared in-process app harness for the CI in-process tests.
//
// Several CI tests exercise the REAL Express app in-process on an ephemeral
// port. Booting that app (importing the full route/middleware/DB module graph
// and binding a listener) is the dominant per-test cost. When each test runs in
// its own process it pays that cost from scratch every time.
//
// This harness lets a single combined runner boot the app exactly ONCE and hand
// the same base URL to every in-process test, while each test file remains
// independently runnable (the standalone guard lazily boots on first use and
// the process exit tears the listener down).
//
// Behaviour is identical to the per-test boot it replaces:
//   - Honours ARX_QA_BASE_URL: when set, no app is booted and that external
//     base URL is returned (so the tests can probe an already-running server).
//   - Otherwise imports artifacts/api-server/src/app.ts and listens on an
//     ephemeral 127.0.0.1 port.

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";

// Result shape every in-process CI test's run() returns so the combined runner
// can aggregate pass/fail counts without each test exiting the process itself.
export interface CiTestResultLike {
  name: string;
  passes: number;
  failures: number;
}

interface SharedServer {
  baseUrl: string;
  server: Server | null;
}

let sharedPromise: Promise<SharedServer> | null = null;

// Lazily boot the in-process app once and memoise it. Concurrent callers share
// the same boot promise, so the app module graph is imported and the listener
// bound exactly once per process.
export async function getSharedBaseUrl(): Promise<string> {
  if (!sharedPromise) {
    sharedPromise = (async (): Promise<SharedServer> => {
      const external = process.env["ARX_QA_BASE_URL"];
      if (external) {
        // eslint-disable-next-line no-console
        console.log(`[harness] probing external server at ${external}`);
        return { baseUrl: external, server: null };
      }
      const app = (await import("../../../artifacts/api-server/src/app.js"))
        .default;
      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      // eslint-disable-next-line no-console
      console.log(`[harness] in-process app listening on ${baseUrl}`);
      return { baseUrl, server };
    })();
  }
  return (await sharedPromise).baseUrl;
}

// Close the shared listener (no-op for an external base URL or if never booted).
export async function closeSharedServer(): Promise<void> {
  if (!sharedPromise) return;
  const { server } = await sharedPromise;
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  sharedPromise = null;
}

// True when the given module URL is the process entrypoint (i.e. the file was
// run directly via `tsx`, not imported by the combined runner). Used to gate the
// standalone run-and-exit block in each test file.
export function isEntrypoint(importMetaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return importMetaUrl === pathToFileURL(argv1).href;
}
