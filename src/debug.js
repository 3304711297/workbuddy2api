/**
 * 调试 Tab (Debug)：请求快照查看、一键重放与 curl 导出
 */

import { state } from './state.js';
import { showToast, invokeTauri, esc } from './utils.js';

let snapshots = [];
let selectedId = null;

function fmtTime(ts) {
  try {
    const d = new Date(Number(ts));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return '—';
  }
}

export async function loadSnapshots() {
  const body = document.getElementById('debug-list-body');
  const totalEl = document.getElementById('debug-total');
  if (!body) return;
  try {
    const data = await invokeTauri('snapshots_list', { limit: 100 });
    snapshots = data.snapshots || [];
    if (totalEl) totalEl.textContent = `共 ${data.total ?? snapshots.length} 条`;
    if (!snapshots.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted" style="text-align: center;">暂无快照（新请求完成后自动记录；可在设置页关闭）</td></tr>';
      return;
    }
    body.innerHTML = snapshots.map((s) => {
      const ok = s.ok !== false;
      return `<tr data-snap-id="${esc(s.id || '')}" style="cursor: pointer;">`
        + `<td class="mono">${esc(fmtTime(s.ts))}</td>`
        + `<td class="mono">${esc(s.endpoint || '')}</td>`
        + `<td class="mono">${esc(s.model || '')}</td>`
        + `<td>${ok ? '<span style="color: #4ade80;">成功</span>' : '<span style="color: #f87171;">失败</span>'}</td>`
        + `<td class="mono">${s.latency_ms ?? '—'} ms</td>`
        + `<td><button class="btn btn-secondary btn-sm" data-act="detail">详情</button></td>`
        + '</tr>';
    }).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="muted" style="text-align: center;">加载失败: ${esc(e.message || e)}</td></tr>`;
  }
}

export function showSnapshotDetail(id) {
  const s = snapshots.find((x) => x.id === id);
  if (!s) return;
  selectedId = id;
  const card = document.getElementById('debug-detail-card');
  const title = document.getElementById('debug-detail-title');
  const pre = document.getElementById('debug-detail-body');
  const result = document.getElementById('debug-replay-result');
  if (!card || !title || !pre) return;
  title.textContent = `${s.endpoint || ''} · ${s.model || ''} · ${fmtTime(s.ts)}`;
  pre.textContent = JSON.stringify(
    { req: s.req, resp: s.resp ?? null, error: s.error ?? null, replay: !!s.replay },
    null, 2
  );
  if (result) {
    result.style.display = 'none';
    result.textContent = '';
  }
  card.style.display = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export async function replaySnapshot(id) {
  const s = snapshots.find((x) => x.id === (id || selectedId));
  if (!s) {
    showToast('请先选择一条快照', 'error');
    return;
  }
  const ok = window.confirm(
    `将把该请求原样再发一次（${s.endpoint || ''}），会真实消耗上游额度，继续吗？`
  );
  if (!ok) return;
  const result = document.getElementById('debug-replay-result');
  try {
    showToast('正在重放…', 'info');
    let port = state.port || 8787;
    let apiKey = '';
    try {
      const cfg = await invokeTauri('get_app_settings');
      if (cfg) {
        if (cfg.port) port = cfg.port;
        if (typeof cfg.api_key === 'string') apiKey = cfg.api_key;
      }
    } catch { /* 读不到设置则用默认值继续 */ }
    const r = await invokeTauri('snapshot_replay', { id: s.id, port, api_key: apiKey });
    if (result) {
      result.style.display = '';
      result.textContent = `HTTP ${r.status} · ${r.latency_ms} ms\n${r.excerpt || '（空响应）'}`;
    }
    showToast(`重放完成：HTTP ${r.status}`, r.status >= 200 && r.status < 300 ? 'success' : 'error');
    loadSnapshots();
  } catch (e) {
    showToast(`重放失败: ${e.message || e}`, 'error');
  }
}

export async function copyCurl(id) {
  const s = snapshots.find((x) => x.id === (id || selectedId));
  if (!s) {
    showToast('请先选择一条快照', 'error');
    return;
  }
  let port = state.port || 8787;
  try {
    const cfg = await invokeTauri('get_app_settings');
    if (cfg && cfg.port) port = cfg.port;
  } catch { /* 忽略 */ }
  const body = JSON.stringify(s.req ?? {}).replace(/'/g, "'\\''");
  const cmd = `curl -s -X POST http://127.0.0.1:${port}${s.endpoint || ''} `
    + `-H 'Content-Type: application/json' -H 'Authorization: Bearer YOUR_KEY' -d '${body}'`;
  try {
    await navigator.clipboard.writeText(cmd);
    showToast('curl 已复制（请把 YOUR_KEY 换成你的客户端密钥）', 'success');
  } catch {
    showToast('复制失败：浏览器拒绝剪贴板写入', 'error');
  }
}

export async function clearSnapshots() {
  if (!window.confirm('清空全部请求快照吗？此操作不可恢复。')) return;
  try {
    await invokeTauri('snapshots_clear');
    document.getElementById('debug-detail-card').style.display = 'none';
    selectedId = null;
    loadSnapshots();
    showToast('快照已清空', 'success');
  } catch (e) {
    showToast(`清空失败: ${e.message || e}`, 'error');
  }
}

export function initDebug() {
  document.getElementById('btn-refresh-debug')?.addEventListener('click', () => {
    loadSnapshots();
    showToast('快照已刷新', 'info');
  });
  document.getElementById('btn-clear-debug')?.addEventListener('click', clearSnapshots);
  document.getElementById('btn-debug-replay')?.addEventListener('click', () => replaySnapshot());
  document.getElementById('btn-debug-copy-curl')?.addEventListener('click', () => copyCurl());
  document.getElementById('debug-list-body')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-snap-id]');
    if (tr) showSnapshotDetail(tr.dataset.snapId);
  });
}
