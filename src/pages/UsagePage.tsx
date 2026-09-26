/**
 * 用量统计与请求记录页 (对标 EasyCLIProxyAPI UsageRecordsPage)
 * 提供五大次级 Tab 体系：
 *   1. 概览 (overview): 核心指标网格、48 小时时序趋势图、Token 构成指标
 *   2. 细分分析 (analysis): 按模型、按状态分布统计
 *   3. 请求明细 (events): 7 列请求流水表、分页、错误信息与详情弹窗
 *   4. 模型费率 (pricing): 模型列表、倍率与上下文规格
 *   5. 数据管理 (data-management): 运行日志控制台与数据维护
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Activity,
  List,
  CircleDollarSign,
  Wrench,
  RefreshCw,
  X,
  Copy,
  Info,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { useToast } from '../services/toast';
import { copyToClipboard } from '../services/clipboard';
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
import { ModelsPage } from './ModelsPage';
import { LogsPage } from './LogsPage';

export type UsageTab = 'overview' | 'analysis' | 'events' | 'pricing' | 'data-management';

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

export function UsagePage({ initialTab = 'overview' }: { initialTab?: UsageTab }) {
  const { t } = useI18n();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<UsageTab>(initialTab);
  const [range, setRange] = useState<UsageRange>('24h');
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [refreshText, setRefreshText] = useState('');
  const [events, setEvents] = useState<UsageEvent[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<UsageEvent | null>(null);

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

  // 模型细分分析统计
  const modelAnalysis = useMemo(() => {
    if (!events) return [];
    const map = new Map<string, { requests: number; ok: number; failed: number; tokens: number }>();
    for (const e of events) {
      const key = e.model || 'unknown';
      const cur = map.get(key) || { requests: 0, ok: 0, failed: 0, tokens: 0 };
      cur.requests++;
      if (e.ok) cur.ok++;
      else cur.failed++;
      cur.tokens += (Number(e.input_tokens) || 0) + (Number(e.output_tokens) || 0);
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .map(([model, stat]) => ({ model, ...stat }))
      .sort((a, b) => b.requests - a.requests);
  }, [events]);

  const handleCopy = async (text: string) => {
    const ok = await copyToClipboard(text);
    showToast(ok ? t('dashboard.copied') : t('dashboard.copyFailed'), ok ? 'success' : 'warning');
  };

  return (
    <div className="panel-page usage-records-page active">
      {/* 顶部标题与次级 Tab 切换栏 (对标 EasyCLIProxyAPI .usage-topbar & .usage-tabs) */}
      <div className="usage-topbar">
        <div className="usage-tabs" role="tablist" aria-label={t('usage.title')}>
          <button
            type="button"
            className={activeTab === 'overview' ? 'active' : ''}
            onClick={() => setActiveTab('overview')}
          >
            <BarChart3 size={15} />
            <span>{t('usage.tab.overview')}</span>
          </button>
          <button
            type="button"
            className={activeTab === 'analysis' ? 'active' : ''}
            onClick={() => setActiveTab('analysis')}
          >
            <Activity size={15} />
            <span>{t('usage.tab.analysis')}</span>
          </button>
          <button
            type="button"
            className={activeTab === 'events' ? 'active' : ''}
            onClick={() => setActiveTab('events')}
          >
            <List size={15} />
            <span>{t('usage.tab.events')}</span>
          </button>
          <button
            type="button"
            className={activeTab === 'pricing' ? 'active' : ''}
            onClick={() => setActiveTab('pricing')}
          >
            <CircleDollarSign size={15} />
            <span>{t('usage.tab.pricing')}</span>
          </button>
          <button
            type="button"
            className={activeTab === 'data-management' ? 'active' : ''}
            onClick={() => setActiveTab('data-management')}
          >
            <Wrench size={15} />
            <span>{t('usage.tab.dataManagement')}</span>
          </button>
        </div>

        <div className="actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            className="input mono"
            style={{ fontSize: 12, padding: '4px 8px', height: 32 }}
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
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void handleManualRefresh()}
            title={t('usage.refresh')}
          >
            <RefreshCw size={13} style={{ marginRight: 4 }} />
            {t('usage.refresh')}
          </button>
        </div>
      </div>

      {/* 1. 概览视图 (Overview Tab) */}
      {activeTab === 'overview' && (
        <div className="usage-overview-layout">
          {/* 核心指标统计网格 (对标 ECPA .usage-stat-grid & .usage-stat-card) */}
          <div className="usage-stat-grid">
            <article className="panel usage-stat-card">
              <span className="usage-stat-card-label">{t('usage.card.requests', { range: rangeLabel })}</span>
              <strong className="usage-stat-card-value mono">{summary ? reqCount.toLocaleString() : '—'}</strong>
              <span className="muted usage-stat-card-meta">
                {summary
                  ? scoped
                    ? t('usage.card.okFailedRange', { ok: reqOk, failed: reqFailed, range: rangeLabel })
                    : t('usage.card.okFailed', { ok: reqOk, failed: reqFailed })
                  : '—'}
              </span>
            </article>

            <article className="panel usage-stat-card">
              <span className="usage-stat-card-label">{t('usage.card.tokens', { range: rangeLabel })}</span>
              <strong className="usage-stat-card-value mono">{summary ? fmtTokens(tokIn + tokOut) : '—'}</strong>
              <span className="muted usage-stat-card-meta">
                {summary ? t('usage.card.tokensSub', { input: fmtTokens(tokIn), output: fmtTokens(tokOut) }) : '—'}
              </span>
            </article>

            <article className="panel usage-stat-card">
              <span className="usage-stat-card-label">{t('usage.card.totalRequests')}</span>
              <strong className="usage-stat-card-value mono">{summary ? totalRequests.toLocaleString() : '—'}</strong>
              <span className="muted usage-stat-card-meta">
                {summary
                  ? t('usage.card.okFailed', { ok: Number(overall?.ok) || 0, failed: Number(overall?.failed) || 0 })
                  : '—'}
              </span>
            </article>

            <article className="panel usage-stat-card">
              <span className="usage-stat-card-label">{t('usage.card.tps')}</span>
              <strong className="usage-stat-card-value mono">
                {summary ? (tps > 0 ? tps.toFixed(1) + ' t/s' : '—') : '—'}
              </strong>
              <span className="muted usage-stat-card-meta">
                {summary ? t('usage.card.tpsSub', { samples: tpsSamples }) : '—'}
              </span>
            </article>

            <article className="panel usage-stat-card">
              <span className="usage-stat-card-label">{t('usage.card.avgLatency')}</span>
              <strong className="usage-stat-card-value mono">
                {summary
                  ? avgLatency > 0
                    ? avgLatency >= 1000
                      ? (avgLatency / 1000).toFixed(1) + ' s'
                      : avgLatency + ' ms'
                    : '—'
                  : '—'}
              </strong>
              <span className="muted usage-stat-card-meta">{t('usage.card.allRequests')}</span>
            </article>
          </div>

          {/* 48 小时趋势图面板 (对标 ECPA .usage-trend-panel) */}
          <section className="panel usage-trend-panel">
            <div className="usage-trend-header">
              <div>
                <h3 className="card-title" style={{ margin: 0 }}>{t('usage.chart.title')}</h3>
                <span className="muted" style={{ fontSize: 12 }}>
                  {t('usage.chart.note')}
                </span>
              </div>
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

            {/* Token 构成指标 */}
            <div className="token-metric-grid">
              <div className="token-metric-card">
                <span className="token-metric-label">输入 Token (Prompt)</span>
                <div className="token-metric-value">{tokIn.toLocaleString()}</div>
              </div>
              <div className="token-metric-card">
                <span className="token-metric-label">输出 Token (Completion)</span>
                <div className="token-metric-value">{tokOut.toLocaleString()}</div>
              </div>
              <div className="token-metric-card">
                <span className="token-metric-label">Token 消耗总计</span>
                <div className="token-metric-value">{(tokIn + tokOut).toLocaleString()}</div>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* 2. 细分分析视图 (Analysis Tab) */}
      {activeTab === 'analysis' && (
        <div className="usage-analysis-grid">
          <section className="panel usage-category-panel">
            <div className="panel-heading">
              <div>
                <h2>模型请求分布</h2>
                <p>当前时间范围内各模型请求量与 Token 消耗</p>
              </div>
            </div>
            <div className="usage-category-list">
              {modelAnalysis.length === 0 ? (
                <div className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  暂无细分数据
                </div>
              ) : (
                modelAnalysis.map((item) => {
                  const pct = totalRequests > 0 ? Math.round((item.requests / totalRequests) * 100) : 0;
                  return (
                    <div key={item.model} className="usage-category-row">
                      <div>
                        <strong className="mono" style={{ fontSize: 13 }}>{item.model}</strong>
                        <div className="muted" style={{ fontSize: 11 }}>
                          成功: {item.ok} · 失败: {item.failed}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                          {item.requests.toLocaleString()} 次
                        </span>
                        <div className="muted mono" style={{ fontSize: 11 }}>
                          {item.tokens.toLocaleString()} tok ({pct}%)
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section className="panel usage-category-panel">
            <div className="panel-heading">
              <div>
                <h2>请求状态质量</h2>
                <p>请求成功率与服务稳定性概况</p>
              </div>
            </div>
            <div className="usage-category-list">
              <div className="usage-category-row">
                <div>
                  <strong style={{ fontSize: 13, color: 'var(--success, #10b981)' }}>成功请求</strong>
                  <div className="muted" style={{ fontSize: 11 }}>HTTP 200 / 正常返回</div>
                </div>
                <strong className="mono" style={{ fontSize: 14 }}>{reqOk.toLocaleString()} 次</strong>
              </div>
              <div className="usage-category-row">
                <div>
                  <strong style={{ fontSize: 13, color: 'var(--danger, #ef4444)' }}>异常请求</strong>
                  <div className="muted" style={{ fontSize: 11 }}>HTTP 4xx / 5xx / 上游限流</div>
                </div>
                <strong className="mono" style={{ fontSize: 14 }}>{reqFailed.toLocaleString()} 次</strong>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* 3. 请求流水明细视图 (Events Tab) */}
      {activeTab === 'events' && (
        <section className="panel usage-events-panel">
          <div className="panel-heading">
            <div>
              <h2>{t('usage.events.title')}</h2>
              <p>{t('usage.events.note')}</p>
            </div>
          </div>
          <div className="panel card" style={{ padding: 0, overflowX: 'auto', marginTop: 10 }}>
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
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {eventsError !== null ? (
                  <tr>
                    <td colSpan={8} className="muted" style={{ textAlign: 'center' }}>
                      {t('usage.table.loadError', { msg: eventsError })}
                    </td>
                  </tr>
                ) : events === null ? (
                  <tr>
                    <td colSpan={8} className="muted" style={{ textAlign: 'center' }}>
                      {t('usage.table.loading')}
                    </td>
                  </tr>
                ) : events.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="muted" style={{ textAlign: 'center' }}>
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
                        <td>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            style={{ height: 26, fontSize: 11, padding: '0 8px' }}
                            onClick={() => setSelectedEvent(r)}
                          >
                            详情
                          </button>
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
        </section>
      )}

      {/* 4. 模型与费率视图 (Pricing & Models Tab) */}
      {activeTab === 'pricing' && (
        <div className="usage-pricing-container">
          <ModelsPage />
        </div>
      )}

      {/* 5. 数据与日志管理 (Data Management Tab) */}
      {activeTab === 'data-management' && (
        <div className="usage-data-management-container">
          <LogsPage />
        </div>
      )}

      {/* 事件快照详情模态弹窗 (对标 ECPA Detail Modal) */}
      {selectedEvent && (
        <div className="detail-modal-overlay" onClick={() => setSelectedEvent(null)}>
          <div className="detail-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="detail-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Info size={18} className="text-primary" />
                <strong style={{ fontSize: 15 }}>请求事件详情</strong>
                <span className="mono muted" style={{ fontSize: 12 }}>
                  {fmtEventTime(selectedEvent.ts)}
                </span>
              </div>
              <button
                type="button"
                className="icon-button quiet"
                onClick={() => setSelectedEvent(null)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="detail-modal-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                <div>
                  <span className="muted" style={{ fontSize: 11 }}>请求模型</span>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                    {selectedEvent.model || '—'}
                  </div>
                </div>
                <div>
                  <span className="muted" style={{ fontSize: 11 }}>状态</span>
                  <div>
                    {selectedEvent.ok ? (
                      <span className="badge badge-info">{t('usage.status.ok')}</span>
                    ) : (
                      <span className="badge badge-danger">{t('usage.status.failed')}</span>
                    )}
                  </div>
                </div>
                <div>
                  <span className="muted" style={{ fontSize: 11 }}>响应时延</span>
                  <div className="mono" style={{ fontSize: 13 }}>
                    {fmtDuration(selectedEvent.latency_ms)}
                  </div>
                </div>
                <div>
                  <span className="muted" style={{ fontSize: 11 }}>首字时延 (TTFT)</span>
                  <div className="mono" style={{ fontSize: 13 }}>
                    {selectedEvent.ttft_ms == null ? '—' : fmtDuration(selectedEvent.ttft_ms)}
                  </div>
                </div>
                <div>
                  <span className="muted" style={{ fontSize: 11 }}>Token 消耗</span>
                  <div className="mono" style={{ fontSize: 13 }}>
                    输入: {selectedEvent.input_tokens ?? 0} · 输出: {selectedEvent.output_tokens ?? 0}
                  </div>
                </div>
              </div>

              {selectedEvent.error && (
                <div style={{ marginTop: 8 }}>
                  <span className="muted" style={{ fontSize: 11 }}>错误信息</span>
                  <div className="code-block mono text-danger" style={{ marginTop: 4, padding: 10 }}>
                    {selectedEvent.error}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void handleCopy(JSON.stringify(selectedEvent, null, 2))}
                >
                  <Copy size={13} style={{ marginRight: 4 }} />
                  复制完整 JSON
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { UsagePage as UsageRecordsPage };
