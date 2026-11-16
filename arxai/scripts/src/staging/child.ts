import { spawn } from "node:child_process";

/** Terminate the process group on timeout/overflow, including pnpm descendants. */
export async function runChild(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxBytes?: number }) {
  return new Promise<{ status: number | null; output: string; timedOut: boolean; interrupted: boolean }>((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = "", bytes = 0, timedOut = false, interrupted = false, killTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = (sig: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* already exited */ }
    };
    const terminate = () => { signal("SIGTERM"); killTimer ??= setTimeout(() => signal("SIGKILL"), 2000); };
    const cancel = () => { interrupted = true; terminate(); };
    process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    const append = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= (options.maxBytes ?? 32 * 1024 * 1024)) output += chunk.toString();
      else { timedOut = true; terminate(); }
    };
    child.stdout.on("data", append); child.stderr.on("data", append);
    child.on("error", error => { output += `\n${error.message}`; });
    child.on("close", status => {
      process.off("SIGTERM", cancel); process.off("SIGINT", cancel);
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      // A background descendant may have closed stdio while outliving its parent.
      signal("SIGKILL");
      resolve({ status, output, timedOut, interrupted });
    });
  });
}
