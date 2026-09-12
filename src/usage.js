/**
 * 用量统计（usage_summary 契约：today/overall/hourly，详见 commands.rs）
 */

import { state } from './state.js';
import { showToast, invokeTauri } from './utils.js';

const USAGE_CHART_BARS = 48; // 与后端 hourly 桶数一致

// 请求序号：防快速切换范围时的响应竞态（旧响应不得覆盖新结果）
let _usageRequestSeq = 0;
// 最近一次成功拉取的原始数据：范围切换时可就地重渲染，无需等待网络
let _lastUsageData = null;

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
  document.getElementById('btn-refresh-usage')?.addEventListener('click', () => loadUsageData(false));
  // 时间范围切换：立即重渲染（数据已在内存，无需重新请求）并补一次刷新以取最新桶
  document.getElementById('select-usage-range')?.addEventListener('change', () => {
    if (_lastUsageData) renderUsage(_lastUsageData);
    loadUsageData(true);
  });
  // Tab 激活期间每 30s 静默刷新（切换走后由 currentTab 守卫跳过）
  setInterval(() => {
    if (state.currentTab === 'usage') loadUsageData(true);
  }, 30000);
}
