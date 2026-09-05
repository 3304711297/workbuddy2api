/**
 * 用量统计（usage_summary 契约：today/overall/hourly，详见 commands.rs）
 */

import { state } from './state.js';
import { showToast, invokeTauri } from './utils.js';

const USAGE_CHART_BARS = 48; // 与后端 hourly 桶数一致

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

/** 渲染统计卡与 48 小时趋势图（纯数字插值，无用户字符串，无 XSS 面） */
function renderUsage(data) {
  const today = data?.today || {};
  const overall = data?.overall || {};
  const hourly = Array.isArray(data?.hourly) ? data.hourly : [];

  const tReq = Number(today.requests) || 0;
  const tOut = Number(today.output_tokens) || 0;
  const tIn = Number(today.input_tokens) || 0;
  document.getElementById('usage-today-requests').textContent = tReq.toLocaleString();
  document.getElementById('usage-today-sub').textContent = `成功 ${Number(today.ok) || 0} · 失败 ${Number(today.failed) || 0}`;
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
  const slot = W / USAGE_CHART_BARS;
  const barW = slot * 0.72;

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
  try {
    const data = await invokeTauri('usage_summary');
    renderUsage(data);
    if (timeEl) {
      const p = (x) => String(x).padStart(2, '0');
      const d = new Date();
      timeEl.textContent = `更新于 ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  } catch (e) {
    // 自动刷新失败静默（避免 30s 一条 toast 刷屏），手动刷新才提示
    if (timeEl) timeEl.textContent = '更新失败';
    if (!isAuto) showToast(`获取用量统计失败: ${e.message || e}`, 'error');
  }
}

export function initUsage() {
  document.getElementById('btn-refresh-usage')?.addEventListener('click', () => loadUsageData(false));
  // Tab 激活期间每 30s 静默刷新（切换走后由 currentTab 守卫跳过）
  setInterval(() => {
    if (state.currentTab === 'usage') loadUsageData(true);
  }, 30000);
}
