/**
 * 用量统计（纯逻辑；图表渲染由 UsagePage 持有）。
 *
 * 契约（与旧 usage.js 一致）：
 *  - USAGE_CHART_BARS = 48（与后端 hourly 桶数一致）；
 *  - 时间范围分档：4h / 24h / today / 7d / 30d / all；
 *  - 按选定范围裁剪 hourly 桶，再由裁剪后的桶反算区间汇总；
 *  - 汇总请求与明细请求各自独立的请求序号防竞态；
 *  - 用量页活动时 30s 静默刷新（定时器由页面持有，这里只给常量）。
 */

import { usageSummary, usageEvents, type UsageSummary, type UsageEvent } from './tauri';

export const USAGE_CHART_BARS = 48;
export const USAGE_SILENT_REFRESH_MS = 30_000;
export const USAGE_EVENTS_PAGE_SIZE = 50;

export type UsageRange = '4h' | '24h' | 'today' | '7d' | '30d' | 'all';

/** 时间范围 → 小时数（today/all 为特殊口径，不走小时回推）。 */
export const USAGE_RANGE_HOURS: Record<UsageRange, number | null> = {
  '4h': 4,
  '24h': 24,
  today: null,
  '7d': 24 * 7,
  '30d': 24 * 30,
  all: null,
};

export const USAGE_RANGE_LABEL: Record<UsageRange, string> = {
  '4h': '近 4 小时',
  '24h': '近 24 小时',
  today: '今日',
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部',
};

export function normalizeUsageRange(v: unknown): UsageRange {
  return typeof v === 'string' && v in USAGE_RANGE_HOURS ? (v as UsageRange) : '24h';
}

export interface HourlyBucket {
  ts: number;
  requests: number;
  ok: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
}

/** 按选定范围裁剪 hourly 桶（all 原样返回；today 走本地零点）。 */
export function clipHourlyByRange(
  hourly: HourlyBucket[] | null | undefined,
  range: UsageRange,
): HourlyBucket[] {
  if (!Array.isArray(hourly) || hourly.length === 0) return [];
  if (range === 'all') return hourly;
  if (range === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    return hourly.filter((h) => Number(h.ts) >= startMs);
  }
  const hours = USAGE_RANGE_HOURS[range];
  if (!hours) return hourly;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return hourly.filter((h) => Number(h.ts) >= cutoff);
}

export interface ClippedSummary {
  requests: number;
  ok: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
}

/** 由裁剪后的桶反算区间汇总（区间统计卡随范围同步变化）。 */
export function summarizeClipped(clipped: HourlyBucket[]): ClippedSummary {
  const acc: ClippedSummary = { requests: 0, ok: 0, failed: 0, input_tokens: 0, output_tokens: 0 };
  for (const h of clipped) {
    acc.requests += Number(h.requests) || 0;
    acc.ok += Number(h.ok) || 0;
    acc.failed += Number(h.failed) || 0;
    acc.input_tokens += Number(h.input_tokens) || 0;
    acc.output_tokens += Number(h.output_tokens) || 0;
  }
  return acc;
}

/** 时间范围 → 起始 epoch 毫秒（明细查询用；all 返回 undefined 表示不过滤）。 */
export function rangeToSinceMs(range: UsageRange): number | undefined {
  if (range === 'all') return undefined;
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const hours = USAGE_RANGE_HOURS[range];
  if (!hours) return undefined;
  return Date.now() - hours * 60 * 60 * 1000;
}

export interface UsageLoader {
  /** 拉取汇总；陈旧结果返回 null。 */
  loadSummary: () => Promise<UsageSummary | null>;
  /** 拉取明细页；陈旧结果返回 null。 */
  loadEvents: (range: UsageRange, page: number) => Promise<{
    events: UsageEvent[];
    total: number;
    pages: number;
  } | null>;
  invalidate: () => void;
}

export function createUsageLoader(): UsageLoader {
  let summarySeq = 0;
  let eventsSeq = 0;
  return {
    invalidate: () => {
      summarySeq++;
      eventsSeq++;
    },
    loadSummary: async () => {
      const seq = ++summarySeq;
      const data = await usageSummary();
      if (seq !== summarySeq) return null;
      return data;
    },
    loadEvents: async (range, page) => {
      const seq = ++eventsSeq;
      const data = await usageEvents({
        page,
        pageSize: USAGE_EVENTS_PAGE_SIZE,
        sinceMs: rangeToSinceMs(range),
      });
      if (seq !== eventsSeq) return null;
      return {
        events: data.items ?? [],
        total: data.total ?? 0,
        pages: data.total_pages ?? 1,
      };
    },
  };
}
