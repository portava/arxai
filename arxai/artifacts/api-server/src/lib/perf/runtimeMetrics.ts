import { performance } from "node:perf_hooks";

let previousCpu = process.cpuUsage();
let previousAt = performance.now();
let previousLoop = performance.eventLoopUtilization();

/** Read on the existing operator poll; no extra worker, query, or public data. */
export function readRuntimeMetrics(pool: { totalCount: number; idleCount: number; waitingCount: number }) {
  const now = performance.now();
  const elapsedMs = now - previousAt;
  const cpu = process.cpuUsage();
  const loop = performance.eventLoopUtilization();
  const loopDelta = performance.eventLoopUtilization(loop, previousLoop);
  const memory = process.memoryUsage();
  const cpuPercent = elapsedMs > 0
    ? ((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / (elapsedMs * 1000)) * 100 : null;
  previousCpu = cpu;
  previousAt = now;
  previousLoop = loop;
  return {
    sampledAt: new Date().toISOString(),
    intervalMs: elapsedMs,
    uptimeSeconds: process.uptime(),
    cpuPercent,
    eventLoopUtilization: loopDelta.utilization,
    memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external },
    database: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    alerts: pool.waitingCount > 0 ? ["DATABASE_POOL_WAITING"] : [],
  };
}
