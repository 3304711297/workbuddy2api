/**
 * 用量统计（usage_summary 契约：today/overall/hourly，详见 commands.rs）
 */

import { state } from './state.js';
import { showToast, invokeTauri, esc } from './utils.js';

const USAGE_CHART_BARS = 48; // 与后端 hourly 桶数一致

// 请求序号：防快速切换范围时的响应竞态（旧响应不得覆盖新结果）
let _usageRequestSeq = 0;
// 最近一次成功拉取的原始数据：范围切换时可就地重渲染，无需等待网络
let _lastUsageData = null;
// 明细查询状态：分页游标 / 请求序号（与汇总请求各自独立防竞态）
let _usageEventsSeq = 0;
let _usageEventsPage = 1;
let _usageEventsPages = 1;
let _usageEventsTotal = 0;

// 时间范围 -> 小时数（借鉴 EasyCLIProxyAPI 的 4h/24h/今日/7d/30d/全部 分档）
const USAGE_RANGE_HOURS = {
  '4h': 4,
  '24h': 24,
  today: null,   // 特殊：今日 0 点起
  '7d': 24 * 7,
  '30d': 24 * 30,
  all: null,     // 不裁剪
};

function readUsageRange() {
  const sel = document.getElementById('select-usage-range');
  const v = sel?.value;
  return Object.prototype.hasOwnProperty.call(USAGE_RANGE_HOURS, v) ? v : '24h';
}

// 按选定范围裁剪 hourly 桶（返回过滤后的数组；all 时原样返回）
function clipHourlyByRange(hourly, range) {
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

// 由裁剪后的桶反算区间汇总（今日/近N小时 统计卡随范围同步变化）
function summarizeClipped(clipped) {
  const acc = { requests: 0, ok: 0, failed: 0, input_tokens: 0, output_tokens: 0 };
  for (const h of clipped) {
    acc.requests += Number(h.requests) || 0;
    acc.ok += Number(h.ok) || 0;
    acc.failed += Number(h.failed) || 0;
    acc.input_tokens += Number(h.input_tokens) || 0;
    acc.output_tokens += Number(h.output_tokens) || 0;
  }
  return acc;
}

const USAGE_RANGE_LABEL = {
  '4h': '近 4 小时',
  '24h': '近 24 小时',
  today: '今日',
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部',
};

/** 时间范围 → 起始 epoch 毫秒（detail 查询用；all 返回 null 表示不过滤）。
 *  today 走本地零点；其余按小时回推；与图表裁剪口径一致。 */
function rangeToSinceMs(range) {
  if (range === 'all') return null;
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const hours = USAGE_RANGE_HOURS[range];
  if (!hours) return null;
  return Date.now() - hours * 60 * 60 * 1000;
}

/** 明细行时间格式：MM-DD HH:MM:SS */
function fmtEventTime(ts) {
  const d = new Date(Number(ts));
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtEventDuration(ms) {
  const v = Number(ms) || 0;
  return v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms';
}

/** 渲染请求明细表（全部动态值经 esc 转义） */
function renderUsageEvents(data) {
  const body = document.getElementById('usage-events-body');
  const info = document.getElementById('usage-page-info');
  if (!body) return;
  const items = Array.isArray(data?.items) ? data.items : [];
  _usageEventsTotal = Number(data?.total) || 0;
  _usageEventsPages = Number(data?.total_pages) || 1;
  _usageEventsPage = Number(data?.page) || 1;

  const prev = document.getElementById('usage-page-prev');
  const next = document.getElementById('usage-page-next');
  if (prev) prev.disabled = _usageEventsPage <= 1;
  if (next) next.disabled = _usageEventsPage >= _usageEventsPages;
  if (info) info.textContent = `第 ${_usageEventsPage} / ${_usageEventsPages} 页 · 共 ${_usageEventsTotal} 条`;

  if (!items.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted" style="text-align: center;">无匹配记录</td></tr>';
    return;
  }

  body.innerHTML = items.map((r) => {
    const ok = !!r.ok;
    const statusBadge = ok
      ? '<span class="badge badge-info">成功</span>'
      : '<span class="badge badge-danger">失败</span>';
    const tin = Number(r.input_tokens) || 0;
    const tout = Number(r.output_tokens) || 0;
    const tokens = tin + tout > 0 ? `${tin.toLocaleString()} / ${tout.toLocaleString()}` : '—';
    // 详情列：优先展示降级链路与失败原因，其次失败原因，最后重试信息
    let detail = '';
    if (r.requested_model && r.actual_model && r.requested_model !== r.actual_model) {
      detail += `<div class="mono" style="font-size: 11px;">${esc(r.requested_model)} → ${esc(r.actual_model)}` +
        (r.fallback_reason ? ` · ${esc(r.fallback_reason)}` : '') + '</div>';
    }
    if (r.error) {
      detail += `<div class="mono muted" style="font-size: 11px;" title="${esc(r.error)}">${esc(r.error)}</div>`;
    }
    if (Number(r.retry_count) > 0) {
      detail += `<div class="mono muted" style="font-size: 11px;">重试 ${Number(r.retry_count)} 次` +
        (r.retry_reason ? ` · ${esc(r.retry_reason)}` : '') + '</div>';
    }
    return `<tr>
      <td class="mono" style="font-size: 12px; white-space: nowrap;">${esc(fmtEventTime(r.ts))}</td>
      <td class="mono" style="font-size: 12px;">${esc(r.model || '—')}</td>
      <td>${statusBadge}</td>
      <td class="mono" style="font-size: 12px;">${esc(tokens)}</td>
      <td class="mono" style="font-size: 12px;">${esc(fmtEventDuration(r.latency_ms))}</td>
      <td>${detail || '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
}

/** 渲染按模型分布（同样 esc 转义模型名） */
function renderUsageModels(analysis) {
  const body = document.getElementById('usage-models-body');
  if (!body) return;
  const models = Array.isArray(analysis?.models) ? analysis.models : [];
  if (!models.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted" style="text-align: center;">暂无数据</td></tr>';
    return;
  }
  body.innerHTML = models.map((m) => {
    const tin = Number(m.input_tokens) || 0;
    const tout = Number(m.output_tokens) || 0;
    const avg = Number(m.avg_latency_ms) || 0;
    return `<tr>
      <td class="mono" style="font-size: 12px;">${esc(m.model || '—')}</td>
      <td class="mono" style="font-size: 12px;">${Number(m.requests) || 0}</td>
      <td class="mono" style="font-size: 12px;">${Number(m.ok) || 0} / ${Number(m.failed) || 0}</td>
      <td class="mono" style="font-size: 12px;">${esc(fmtUsageTokens(tin))} / ${esc(fmtUsageTokens(tout))}</td>
      <td class="mono" style="font-size: 12px;">${esc(avg > 0 ? fmtEventDuration(avg) : '—')}</td>
    </tr>`;
  }).join('');
}

/** 拉取请求明细 + 模型分布。pageOverride 供翻页使用；缺省沿用当前页。 */
export async function loadUsageEvents(pageOverride) {
  const seq = ++_usageEventsSeq;
  const page = Number.isFinite(pageOverride) ? pageOverride : _usageEventsPage;
  const modelEl = document.getElementById('usage-events-model');
  const statusEl = document.getElementById('select-usage-status');
  const since = rangeToSinceMs(readUsageRange());
  const args = { page, page_size: 50 };
  const model = (modelEl?.value || '').trim();
  if (model) args.model = model;
  const status = statusEl?.value || '';
  if (status) args.status = status;
  if (since) args.since_ms = since;
  try {
    const data = await invokeTauri('usage_events', args);
    if (seq !== _usageEventsSeq) return; // 陈旧响应丢弃
    renderUsageEvents(data);
    renderUsageModels(data?.analysis);
  } catch (e) {
    if (seq !== _usageEventsSeq) return;
    const body = document.getElementById('usage-events-body');
    if (body) body.innerHTML = `<tr><td colspan="6" class="muted" style="text-align: center;">明细加载失败：${esc(e.message || e)}</td></tr>`;
  }
}

function fmtUsageTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'k';
  return String(v);
}

function fmtUsageHour(ts) {
  const d = new Date(Number(ts));
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00`;
}

/** 渲染统计卡与趋势图（纯数字插值，无用户字符串，无 XSS 面）
 *  统计卡随所选时间范围裁剪（借鉴 EasyCLIProxyAPI 的 range 语义） */
function renderUsage(data) {
  const today = data?.today || {};
  const overall = data?.overall || {};
  const rawHourly = Array.isArray(data?.hourly) ? data.hourly : [];

  const range = readUsageRange();
  const hourly = clipHourlyByRange(rawHourly, range);
  // 范围汇总：非 all 时以裁剪后桶为准（口径与所见范围一致）
  const scoped = range === 'all' ? null : summarizeClipped(hourly);

  const tReq = scoped ? scoped.requests : (Number(today.requests) || 0);
  const tOut = scoped ? scoped.output_tokens : (Number(today.output_tokens) || 0);
  const tIn = scoped ? scoped.input_tokens : (Number(today.input_tokens) || 0);
  const rangeLabel = USAGE_RANGE_LABEL[range] || range;
  const reqLabel = document.getElementById('usage-today-label');
  if (reqLabel) reqLabel.textContent = rangeLabel;

  document.getElementById('usage-today-requests').textContent = tReq.toLocaleString();
  document.getElementById('usage-today-sub').textContent = scoped
    ? `成功 ${scoped.ok} · 失败 ${scoped.failed}（${rangeLabel}）`
    : `成功 ${Number(today.ok) || 0} · 失败 ${Number(today.failed) || 0}`;
  document.getElementById('usage-today-tokens').textContent = fmtUsageTokens(tIn + tOut);
  document.getElementById('usage-today-tokens-sub').textContent = `输入 ${fmtUsageTokens(tIn)} · 输出 ${fmtUsageTokens(tOut)}`;

  document.getElementById('usage-total-requests').textContent = (Number(overall.requests) || 0).toLocaleString();
  document.getElementById('usage-total-sub').textContent = `成功 ${Number(overall.ok) || 0} · 失败 ${Number(overall.failed) || 0}`;

  const tps = Number(overall.tps) || 0;
  document.getElementById('usage-tps').textContent = tps > 0 ? tps.toFixed(1) + ' t/s' : '—';
  document.getElementById('usage-tps-sub').textContent = `${Number(overall.tps_samples) || 0} 个样本`;

  const avg = Number(overall.avg_latency_ms) || 0;
  document.getElementById('usage-avg-latency').textContent = avg > 0 ? (avg >= 1000 ? (avg / 1000).toFixed(1) + ' s' : avg + ' ms') : '—';

  // —— 手写 SVG 柱状趋势图（对标上游零图表库做法） ——
  const svg = document.getElementById('usage-chart');
  const axis = document.getElementById('usage-chart-axis');
  if (!svg) return;
  const W = 960, H = 180, BASE = 172, TOP = 12;
  const maxReq = Math.max(1, ...hourly.map(h => Number(h.requests) || 0));
  // 柱宽随实际桶数自适应：范围越窄桶越少，柱越宽，避免右侧留白
  const slot = W / Math.max(hourly.length, 1);
  const barW = Math.max(2, slot * 0.72);

  const bars = hourly.map((h, i) => {
    const n = Number(h.requests) || 0;
    const barH = n > 0 ? Math.max(2, ((BASE - TOP) * n) / maxReq) : 0;
    const x = (i * slot + (slot - barW) / 2).toFixed(1);
    const y = (BASE - barH).toFixed(1);
    const when = fmtUsageHour(h.ts);
    const tokens = Number(h.output_tokens) || 0;
    return `<rect class="usage-bar" x="${x}" y="${y}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5"><title>${when} · ${n} 次 · ${tokens.toLocaleString()} tokens</title></rect>`;
  }).join('');

  const grid = [0.25, 0.5, 0.75].map(f => {
    const y = (TOP + (BASE - TOP) * f).toFixed(1);
    return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" class="usage-grid-line"/>`;
  }).join('');

  if (!hourly.length || overall.requests === 0) {
    svg.innerHTML = `${grid}<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="usage-empty-text">暂无数据，统计从本版本起开始记录</text>`;
  } else {
    svg.innerHTML = `
      <defs>
        <linearGradient id="usage-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.9"/>
          <stop offset="100%" stop-color="var(--primary)" stop-opacity="0.35"/>
        </linearGradient>
      </defs>
      ${grid}
      <line x1="0" y1="${BASE}" x2="${W}" y2="${BASE}" class="usage-base-line"/>
      ${bars}`;
    axis.textContent = '';
    const span = document.createElement('span');
    span.textContent = fmtUsageHour(hourly[0].ts);
    const spanEnd = document.createElement('span');
    spanEnd.textContent = fmtUsageHour(hourly[hourly.length - 1].ts);
    axis.append(span, spanEnd);
  }
}

export async function loadUsageData(isAuto = false) {
  const timeEl = document.getElementById('usage-refresh-time');
  // 请求序号防竞态：快速切换时间范围时，旧响应可能晚于新响应返回并覆盖结果
  const seq = ++_usageRequestSeq;
  try {
    const data = await invokeTauri('usage_summary');
    if (seq !== _usageRequestSeq) return; // 已有更新的请求发出，丢弃本次陈旧结果
    _lastUsageData = data;
    renderUsage(data);
    if (timeEl) {
      const p = (x) => String(x).padStart(2, '0');
      const d = new Date();
      timeEl.textContent = `更新于 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  } catch (e) {
    if (seq !== _usageRequestSeq) return;
    // 自动刷新失败静默（避免 30s 一条 toast 刷屏），手动刷新才提示
    if (timeEl) timeEl.textContent = '更新失败';
    if (!isAuto) showToast(`获取用量统计失败: ${e.message || e}`, 'error');
  }
}

export function initUsage() {
  document.getElementById('btn-refresh-usage')?.addEventListener('click', () => {
    loadUsageData(false);
    loadUsageEvents(1);
  });
  // 时间范围切换：立即重渲染（数据已在内存，无需重新请求）并补一次刷新以取最新桶；
  // 明细表同步回到第 1 页（范围变了，旧页码可能越界）
  document.getElementById('select-usage-range')?.addEventListener('change', () => {
    if (_lastUsageData) renderUsage(_lastUsageData);
    loadUsageData(true);
    loadUsageEvents(1);
  });

  // —— 请求明细：筛选 / 翻页 / 重置 ——
  const modelInput = document.getElementById('usage-events-model');
  // 输入防抖 350ms，避免逐字符敲击打爆调用
  let debounceTimer = null;
  modelInput?.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadUsageEvents(1), 350);
  });
  document.getElementById('select-usage-status')?.addEventListener('change', () => loadUsageEvents(1));
  document.getElementById('usage-page-prev')?.addEventListener('click', () => {
    if (_usageEventsPage > 1) loadUsageEvents(_usageEventsPage - 1);
  });
  document.getElementById('usage-page-next')?.addEventListener('click', () => {
    if (_usageEventsPage < _usageEventsPages) loadUsageEvents(_usageEventsPage + 1);
  });
  document.getElementById('btn-usage-events-reset')?.addEventListener('click', () => {
    if (modelInput) modelInput.value = '';
    const statusEl = document.getElementById('select-usage-status');
    if (statusEl) statusEl.value = '';
    loadUsageEvents(1);
  });

  // Tab 激活期间每 30s 静默刷新（切换走后由 currentTab 守卫跳过）
  setInterval(() => {
    if (state.currentTab === 'usage') {
      loadUsageData(true);
      loadUsageEvents();
    }
  }, 30000);
}
