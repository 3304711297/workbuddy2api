/**
 * 用量统计页（React 迁移版，对标旧 src/usage.js）：
 * - 汇总卡（随时间范围裁剪反算）+ 48 桶 div 柱状趋势图；
 * - 请求明细表（7 列：时间 / 模型 / 状态 / 输入输出 Token / 时延 / TTFT / 错误信息）+ 分页；
 * - 挂载时并行拉取汇总与明细第 1 页；卸载时 loader.invalidate()；
 * - 范围切换用已缓存 summary 就地 clip + summarize 重渲染（无需等待网络），明细回第 1 页；
 * - 30s 静默刷新汇总（自动刷新失败不 toast）；手动刷新失败 toast；
 * - 不可信文本（错误信息等）一律文本节点渲染，禁止 dangerouslySetInnerHTML。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useToast } from '../services/toast';
import {
  USAGE_SILENT_REFRESH_MS,
  clipHourlyByRange,
  createUsageLoader,
  normalizeUsageRange,
  summarizeClipped,
  type UsageLoader,
  type UsageRange,
} from '../services/usageService';
import type { UsageEvent, UsageSummary } from '../services/tauri';

const RANGES: UsageRange[] = ['4h', '24h', 'today', '7d', '30d', 'all'];

/** 明细行时间格式：MM-DD HH:MM:SS */
function fmtEventTime(ts: number): string {
  const d = new Date(Number(ts));
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 时延：>=1000ms 显示 x.x s，否则 Nms */
function fmtDuration(ms: number | null | undefined): string {
  const v = Number(ms) || 0;
  return v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms';
}

/** 桶标签：MM-DD HH:00 */
function fmtBucketHour(ts: number): string {
  const d = new Date(Number(ts));
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00`;
}

/** Token 缩写：1.2M / 3.4k / 原值 */
function fmtTokens(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'k';
  return String(v);
}

function fmtClock(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function UsagePage() {
  const { t } = useI18n();
  const { showToast } = useToast();

  const [range, setRange] = useState<UsageRange>('24h');
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [refreshText, setRefreshText] = useState('');
  const [events, setEvents] = useState<UsageEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const loaderRef = useRef<UsageLoader | null>(null);
  const mountedRef = useRef(false);

  /** 拉取汇总。silent=true 为 30s 定时静默刷新：失败只改时间戳文案，不 toast。 */
  const refreshSummary = useCallback(
    async (loader: UsageLoader, silent: boolean) => {
      try {
        const data = await loader.loadSummary();
        if (!mountedRef.current || data === null) return; // null = 陈旧响应，丢弃
        setSummary(data);
        setRefreshText(t('usage.refreshTime', { time: fmtClock(new Date()) }));
      } catch (e) {
        if (!mountedRef.current) return;
        setRefreshText(t('usage.refreshFailed'));
        if (!silent) showToast(t('usage.summary.loadError', { msg: errMsg(e) }), 'error');
      }
    },
    [t, showToast],
  );

  /** 拉取明细页。失败：行内错误行 + toast。 */
  const loadEventsPage = useCallback(
    async (loader: UsageLoader, r: UsageRange, p: number) => {
      setEventsError(null);
      try {
        const res = await loader.loadEvents(r, p);
        if (!mountedRef.current || res === null) return; // null = 陈旧响应，丢弃
        setEvents(res.events);
        setPage(p);
        setTotal(res.total);
        setTotalPages(Math.max(1, res.pages));
      } catch (e) {
        if (!mountedRef.current) return;
        const msg = errMsg(e);
        setEvents([]);
        setEventsError(msg);
        showToast(t('usage.events.loadError', { msg }), 'error');
      }
    },
    [t, showToast],
  );

  // 挂载：并行拉取汇总 + 明细第 1 页；30s 静默刷新汇总；卸载：清定时器 + invalidate()。
  useEffect(() => {
    const loader = createUsageLoader();
    loaderRef.current = loader;
    mountedRef.current = true;
    void refreshSummary(loader, false);
    void loadEventsPage(loader, '24h', 1);
    const timer = window.setInterval(() => {
      void refreshSummary(loader, true);
    }, USAGE_SILENT_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      mountedRef.current = false;
      loader.invalidate();
    };
  }, [refreshSummary, loadEventsPage]);

  // 范围切换：state 更新即用已缓存 summary 就地 clip + summarize 重渲染（无需等待网络）；
  // 明细同步回第 1 页。
  const handleRangeChange = useCallback(
    (r: UsageRange) => {
      setRange(r);
      const loader = loaderRef.current;
      if (loader) void loadEventsPage(loader, r, 1);
    },
    [loadEventsPage],
  );

  const handleManualRefresh = useCallback(() => {
    const loader = loaderRef.current;
    if (!loader) return;
    void refreshSummary(loader, false);
    void loadEventsPage(loader, range, 1);
  }, [refreshSummary, loadEventsPage, range]);

  const handlePage = useCallback(
    (p: number) => {
      const loader = loaderRef.current;
      if (loader && p >= 1 && p <= totalPages && p !== page) {
        void loadEventsPage(loader, range, p);
      }
    },
    [loadEventsPage, range, page, totalPages],
  );

  // —— 汇总卡派生（随 range 就地重算） ——
  const rangeLabel = t(`usage.range.${range}`);
  const clipped = useMemo(
    () => clipHourlyByRange(summary?.hourly, range),
    [summary, range],
  );
  // all 不裁剪：沿用旧口径，首卡取 today（48 桶只能覆盖 48h，反算会低估「全部」）
  const scoped = range === 'all' ? null : summarizeClipped(clipped);
  const today = summary?.today;
  const overall = summary?.overall;

  const reqCount = scoped ? scoped.requests : Number(today?.requests) || 0;
  const reqOk = scoped ? scoped.ok : Number(today?.ok) || 0;
  const reqFailed = scoped ? scoped.failed : Number(today?.failed) || 0;
  const tokIn = scoped ? scoped.input_tokens : Number(today?.input_tokens) || 0;
  const tokOut = scoped ? scoped.output_tokens : Number(today?.output_tokens) || 0;

  const totalRequests = Number(overall?.requests) || 0;
  const tps = Number(overall?.tps) || 0;
  const tpsSamples = Number(overall?.tps_samples) || 0;
  const avgLatency = Number(overall?.avg_latency_ms) || 0;

  // —— 趋势图派生 ——
  const maxReq = clipped.reduce((m, h) => Math.max(m, Number(h.requests) || 0), 0);
  const chartHasData = clipped.length > 0 && totalRequests > 0;

  return (
    <div className="panel-page active">
      <div className="section-title-row">
        <div>
          <h2>{t('usage.title')}</h2>
          <p className="muted">{t('usage.desc')}</p>
        </div>
        <div className="actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="input mono"
            style={{ fontSize: 12, padding: '4px 8px' }}
            title={t('usage.rangeTitle')}
            value={range}
            onChange={(e) => handleRangeChange(normalizeUsageRange(e.target.value))}
          >
            {RANGES.map((r) => (
              <option key={r} value={r}>
                {t(`usage.range.${r}`)}
              </option>
            ))}
          </select>
          <span className="muted mono" style={{ fontSize: 12 }}>
            {refreshText || '—'}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={handleManualRefresh}>
            {t('usage.refresh')}
          </button>
        </div>
      </div>

      <div className="usage-cards">
        <div className="card usage-stat-card">
          <span className="metric-label">{t('usage.card.requests', { range: rangeLabel })}</span>
          <span className="metric-value mono">{summary ? reqCount.toLocaleString() : '—'}</span>
          <span className="muted usage-sub">
            {summary
              ? scoped
                ? t('usage.card.okFailedRange', { ok: reqOk, failed: reqFailed, range: rangeLabel })
                : t('usage.card.okFailed', { ok: reqOk, failed: reqFailed })
              : '—'}
          </span>
        </div>
        <div className="card usage-stat-card">
          <span className="metric-label">{t('usage.card.tokens', { range: rangeLabel })}</span>
          <span className="metric-value mono">{summary ? fmtTokens(tokIn + tokOut) : '—'}</span>
          <span className="muted usage-sub">
            {summary ? t('usage.card.tokensSub', { input: fmtTokens(tokIn), output: fmtTokens(tokOut) }) : '—'}
          </span>
        </div>
        <div className="card usage-stat-card">
          <span className="metric-label">{t('usage.card.totalRequests')}</span>
          <span className="metric-value mono">{summary ? totalRequests.toLocaleString() : '—'}</span>
          <span className="muted usage-sub">
            {summary
              ? t('usage.card.okFailed', { ok: Number(overall?.ok) || 0, failed: Number(overall?.failed) || 0 })
              : '—'}
          </span>
        </div>
        <div className="card usage-stat-card">
          <span className="metric-label">{t('usage.card.tps')}</span>
          <span className="metric-value mono">{summary ? (tps > 0 ? tps.toFixed(1) + ' t/s' : '—') : '—'}</span>
          <span className="muted usage-sub">
            {summary ? t('usage.card.tpsSub', { samples: tpsSamples }) : '—'}
          </span>
        </div>
        <div className="card usage-stat-card">
          <span className="metric-label">{t('usage.card.avgLatency')}</span>
          <span className="metric-value mono">
            {summary ? (avgLatency > 0 ? (avgLatency >= 1000 ? (avgLatency / 1000).toFixed(1) + ' s' : avgLatency + ' ms') : '—') : '—'}
          </span>
          <span className="muted usage-sub">{t('usage.card.allRequests')}</span>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header-flex">
          <h3 className="card-title">{t('usage.chart.title')}</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {t('usage.chart.note')}
          </span>
        </div>
        {chartHasData ? (
          <div
            className="usage-chart-wrap"
            style={{ display: 'flex', alignItems: 'flex-end', gap: 2 }}
            role="img"
            aria-label={t('usage.chart.title')}
          >
            {clipped.map((h, i) => {
              const n = Number(h.requests) || 0;
              const tokens = Number(h.output_tokens) || 0;
              const heightPct = maxReq > 0 ? (n / maxReq) * 100 : 0;
              return (
                <div
                  key={`${h.ts}-${i}`}
                  className="usage-bar"
                  title={t('usage.chart.barTitle', {
                    time: fmtBucketHour(h.ts),
                    n,
                    tokens: tokens.toLocaleString(),
                  })}
                  style={{
                    flex: '1 1 0',
                    minWidth: 2,
                    // 空桶占位：2px 细线；有值桶按比例，最小 4% 保证可见
                    height: n > 0 ? `${Math.max(heightPct, 4)}%` : 2,
                    borderRadius: 2,
                    background: n > 0 ? 'var(--primary)' : 'var(--border)',
                    opacity: n > 0 ? 0.85 : 0.6,
                  }}
                />
              );
            })}
          </div>
        ) : (
          <div
            className="usage-chart-wrap"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <span className="muted" style={{ fontSize: 14 }}>
              {t('usage.chart.empty')}
            </span>
          </div>
        )}
        <div className="usage-chart-axis mono">
          {chartHasData && (
            <>
              <span>{fmtBucketHour(clipped[0].ts)}</span>
              <span>{fmtBucketHour(clipped[clipped.length - 1].ts)}</span>
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header-flex">
          <h3 className="card-title">{t('usage.events.title')}</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {t('usage.events.note')}
          </span>
        </div>
        <div className="card" style={{ padding: 0, overflowX: 'auto', marginTop: 10 }}>
          <table className="data-table usage-events-table">
            <thead>
              <tr>
                <th>{t('usage.table.time')}</th>
                <th>{t('usage.table.model')}</th>
                <th>{t('usage.table.status')}</th>
                <th>{t('usage.table.tokens')}</th>
                <th>{t('usage.table.latency')}</th>
                <th>{t('usage.table.ttft')}</th>
                <th>{t('usage.table.error')}</th>
              </tr>
            </thead>
            <tbody>
              {eventsError !== null ? (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: 'center' }}>
                    {t('usage.table.loadError', { msg: eventsError })}
                  </td>
                </tr>
              ) : events === null ? (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: 'center' }}>
                    {t('usage.table.loading')}
                  </td>
                </tr>
              ) : events.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: 'center' }}>
                    {t('usage.table.empty')}
                  </td>
                </tr>
              ) : (
                events.map((r, i) => {
                  const tin = Number(r.input_tokens) || 0;
                  const tout = Number(r.output_tokens) || 0;
                  return (
                    <tr key={`${r.ts}-${i}`}>
                      <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {fmtEventTime(r.ts)}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {r.model || '—'}
                      </td>
                      <td>
                        {r.ok ? (
                          <span className="badge badge-info">{t('usage.status.ok')}</span>
                        ) : (
                          <span className="badge badge-danger">{t('usage.status.failed')}</span>
                        )}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {tin + tout > 0 ? `${tin.toLocaleString()} / ${tout.toLocaleString()}` : '—'}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {fmtDuration(r.latency_ms)}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {r.ttft_ms == null ? '—' : fmtDuration(r.ttft_ms)}
                      </td>
                      <td>
                        {r.error ? (
                          <span className="mono muted" style={{ fontSize: 11 }} title={r.error}>
                            {r.error}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div
          className="usage-pager"
          style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginTop: 10 }}
        >
          <button
            className="btn btn-secondary btn-sm"
            disabled={page <= 1}
            onClick={() => handlePage(page - 1)}
          >
            {t('usage.page.prev')}
          </button>
          <span className="muted mono" style={{ fontSize: 12 }}>
            {t('usage.page.info', { page, pages: totalPages, total })}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            disabled={page >= totalPages}
            onClick={() => handlePage(page + 1)}
          >
            {t('usage.page.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
