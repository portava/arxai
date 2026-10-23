// Cache adapter — pluggable façade over an in-process Map for single-server
// mode, with a forward-compatible interface for distributed cache (Redis,
// Memcached, …) once the API is horizontally scaled.
//
// Mode is selected by env at process start:
//   ARX_CACHE_MODE = "in-process" (default) | "distributed"
//
// "distributed" is reserved for a future Redis-backed adapter. Until that
// adapter ships, "distributed" still uses the in-process map but the
// runtime metadata reports `mode: "distributed"` so an admin can see the
// configuration was applied. The admin dashboard surfaces a warning when
// the app is scaled horizontally while still in in-process mode.

import { randomUUID } from "node:crypto";
import { DEFAULT_ASSISTANT_NAME } from "@workspace/domain/assistant-name";

export type CacheMode = "in-process" | "distributed";

export interface CacheAdapter {
  readonly mode: CacheMode;
  readonly ttlMs: number;
  readonly instanceId: string;
  /** Returns a cached value if present and not expired. */
  get<T>(key: string): { hit: true; value: T } | { hit: false };
  /** Stores a value; TTL is fixed per-adapter at construction. */
  set<T>(key: string, value: T): void;
  /** Drops a single key (or all keys if `key` omitted). */
  clear(key?: string): void;
  /** Returns the total number of live (non-expired) keys. */
  size(): number;
}

// ── In-memory adapter ─────────────────────────────────────────────────────
class InMemoryCacheAdapter implements CacheAdapter {
  readonly mode: CacheMode;
  readonly ttlMs: number;
  readonly instanceId: string;
  private readonly store = new Map<string, { at: number; value: unknown }>();

  constructor(mode: CacheMode, ttlMs: number, instanceId: string) {
    this.mode = mode;
    this.ttlMs = ttlMs;
    this.instanceId = instanceId;
  }

  get<T>(key: string): { hit: true; value: T } | { hit: false } {
    const row = this.store.get(key);
    if (!row) return { hit: false };
    if (Date.now() - row.at > this.ttlMs) {
      this.store.delete(key);
      return { hit: false };
    }
    return { hit: true, value: row.value as T };
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, { at: Date.now(), value });
  }

  clear(key?: string): void {
    if (key === undefined) this.store.clear();
    else this.store.delete(key);
  }

  size(): number {
    // Purge expired entries opportunistically so the count is accurate.
    const now = Date.now();
    for (const [k, row] of this.store) {
      if (now - row.at > this.ttlMs) this.store.delete(k);
    }
    return this.store.size;
  }
}

// ── Registry ──────────────────────────────────────────────────────────────
// One adapter per logical namespace so different subsystems can have
// independent TTLs without colliding key spaces.
const REGISTRY = new Map<string, CacheAdapter>();

// Stable per-process identifier so admin diagnostics can tell two replicas
// apart at a glance. Resolved once at module load.
const PROCESS_INSTANCE_ID = process.env.ARX_INSTANCE_ID
  || `${process.pid}-${randomUUID().slice(0, 8)}`;

function resolveMode(): CacheMode {
  const raw = String(process.env.ARX_CACHE_MODE ?? "").trim().toLowerCase();
  if (raw === "distributed") return "distributed";
  return "in-process";
}

/**
 * Returns (and lazily creates) the cache adapter for a namespace.
 *
 * @param namespace logical bucket name (e.g. `"scanner-selected-market"`)
 * @param ttlMs     entry TTL in milliseconds (default 30 s)
 */
export function getCache(namespace: string, ttlMs = 30_000): CacheAdapter {
  const existing = REGISTRY.get(namespace);
  if (existing) return existing;
  const mode = resolveMode();
  // Until a Redis adapter ships, `distributed` still uses the in-memory
  // implementation under the hood. Mode metadata is reported faithfully so
  // operators can detect a mismatch between configuration and runtime.
  const adapter = new InMemoryCacheAdapter(mode, ttlMs, PROCESS_INSTANCE_ID);
  REGISTRY.set(namespace, adapter);
  return adapter;
}

export interface CacheRuntimeReport {
  mode: CacheMode;
  instanceId: string;
  pid: number;
  namespaces: Array<{ name: string; ttlMs: number; size: number }>;
  distributedAdapterImplemented: boolean;
  /** True when ARX_CACHE_MODE=distributed but no real distributed adapter is wired yet. */
  modeMismatchWarning: boolean;
  notes: string[];
}

export function describeCacheRuntime(): CacheRuntimeReport {
  const mode = resolveMode();
  const namespaces = Array.from(REGISTRY.entries()).map(([name, c]) => ({
    name, ttlMs: c.ttlMs, size: c.size(),
  }));
  const distributedAdapterImplemented = false;
  const modeMismatchWarning = mode === "distributed" && !distributedAdapterImplemented;
  const instanceId = PROCESS_INSTANCE_ID;
  const notes: string[] = [];
  if (mode === "in-process") {
    notes.push(`In-process cache: state is local to this server instance. If the app is horizontally scaled, cache hit rates will be uneven and ${DEFAULT_ASSISTANT_NAME} Market Intelligence may recompute per replica.`);
  }
  if (modeMismatchWarning) {
    notes.push("ARX_CACHE_MODE=distributed is set but no distributed adapter is wired yet. Currently falling back to in-process. Wire a Redis adapter before scaling.");
  }
  return {
    mode, instanceId, pid: process.pid, namespaces,
    distributedAdapterImplemented, modeMismatchWarning, notes,
  };
}

/** Test-only — clears every namespace. */
export function __resetAllCachesForTest(): void {
  for (const c of REGISTRY.values()) c.clear();
}
