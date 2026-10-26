export interface DependencyReadiness {
  status: "ready" | "unavailable";
  checkedAt: string;
}

/** Bounded, single-flight read-only readiness probe. A stuck dependency retains
 * one in-flight probe after the HTTP timeout, preventing request-driven buildup.
 * Liveness remains separate: this does not claim trading/provider readiness. */
export function createDependencyReadiness(ping: () => Promise<unknown>,
  options: { timeoutMs?: number; cacheMs?: number; now?: () => number } = {}) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const cacheMs = options.cacheMs ?? 5_000;
  const now = options.now ?? Date.now;
  let cached: { result: DependencyReadiness; at: number } | null = null;
  let pending: Promise<DependencyReadiness> | null = null;
  return (): Promise<DependencyReadiness> => {
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age >= 0 && age < cacheMs) return Promise.resolve(cached.result);
    if (pending) return pending;
    let settle!: (result: DependencyReadiness) => void;
    pending = new Promise<DependencyReadiness>(resolve => { settle = resolve; });
    const result = pending;
    let completed = false;
    const finish = (ok: boolean) => {
      if (completed) return;
      completed = true;
      const at = now();
      const value: DependencyReadiness = { status: ok ? "ready" : "unavailable", checkedAt: new Date(at).toISOString() };
      cached = { result: value, at };
      settle(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Promise.resolve().then(ping).then(() => finish(true), () => finish(false)).finally(() => {
      clearTimeout(timer);
      pending = null;
    });
    return result;
  };
}
