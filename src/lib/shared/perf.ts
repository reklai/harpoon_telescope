import perfBudgets from "./perfBudgets.json";

type PerfBudgetKey = keyof typeof perfBudgets;

interface PerfStat {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  budgetMs: number;
  overBudgetCount: number;
}

type PerfStatMap = Record<string, PerfStat>;

type RuntimePerfState = typeof globalThis & {
  __HT_PERF_STATS__?: PerfStatMap;
  __HT_DEBUG_PERF__?: boolean;
};

const runtime = globalThis as RuntimePerfState;

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function getBudgetMs(key: PerfBudgetKey): number {
  return perfBudgets[key];
}

function recordPerf(key: PerfBudgetKey, durationMs: number): void {
  const budgetMs = getBudgetMs(key);
  const stats = runtime.__HT_PERF_STATS__ || {};
  const prev = stats[key] || {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
    budgetMs,
    overBudgetCount: 0,
  };

  prev.count += 1;
  prev.totalMs += durationMs;
  prev.maxMs = Math.max(prev.maxMs, durationMs);
  prev.lastMs = durationMs;
  prev.budgetMs = budgetMs;
  if (durationMs > budgetMs) prev.overBudgetCount += 1;

  stats[key] = prev;
  runtime.__HT_PERF_STATS__ = stats;

  if (runtime.__HT_DEBUG_PERF__ && durationMs > budgetMs) {
    console.warn(`[ht:perf] ${key} exceeded budget: ${durationMs.toFixed(2)}ms > ${budgetMs}ms`);
  }
}

export function withPerfTrace<T>(key: PerfBudgetKey, fn: () => T): T {
  const start = nowMs();
  const result = fn();
  recordPerf(key, nowMs() - start);
  return result;
}

export async function withPerfTraceAsync<T>(key: PerfBudgetKey, fn: () => Promise<T>): Promise<T> {
  const start = nowMs();
  try {
    return await fn();
  } finally {
    recordPerf(key, nowMs() - start);
  }
}
