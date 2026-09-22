/**
 * 模型全量矩阵与参数定制 (倍率/思考强度/上下文)
 * 说明：window.saveModelConfig / window.openModelEdit 保持原有 window 挂载
 * （行内编辑按钮的事件委托以 window.openModelEdit 调用）。
 */

import { state } from './state.js';
import { esc, showToast, invokeTauri, copyToClipboard } from './utils.js';

let rawModelsList = [];
let currentModelsList = [];
let sortField = null; // 'id' | 'credits' | null
let sortOrder = null; // 'asc' | 'desc' | null
let selectedTagFilter = 'ALL';

/**
 * 判断当前是否处于夜间限免/折扣窗口（Asia/Shanghai 23:00–08:00）。
 * 支持注入自定义 Date 便于单元测试与时间冻结断言。
 * @param {Date} [date]
 * @returns {boolean}
 */
export function isNightWindowNow(date = new Date()) {
  const d = (date instanceof Date && !isNaN(date.getTime())) ? date : new Date();
  const utcHours = d.getUTCHours();
  const cstHours = (utcHours + 8) % 24;
  return cstHours >= 23 || cstHours < 8;
}

/**
 * 拉取全量模型矩阵并渲染。
 * @returns {Promise<boolean>} true = 云端同步成功；false = 已降级为本地内置数据
 * （调用方据此提示，禁止在 await 之前无条件弹「同步成功」）
 */
export async function loadModelsMatrix() {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return false;
  tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 24px;"><span class="spinner"></span> 正在同步全量模型与计费倍率数据...</td></tr>`;

  try {
    const list = await invokeTauri('models_fetch_all');
    rawModelsList = (list || []).map(m => {
      // 过滤 craft 冗余技术标签（含首尾空格），保留来源端与动态业务徽章（如夜间免费、限时免费、夜间折扣、独家优惠）
      m.tags = (m.tags || []).filter(t => t && t.toLowerCase() !== 'craft' && t.trim().toLowerCase() !== 'craft');
      return m;
    });
    updateTagFilterDropdown();
    applyAndRender();
    return true;
  } catch (e) {
    console.warn('获取全量模型列表失败，降级展示基础模型:', e);
    renderFallbackModels();
    return false;
  }
}

/**
 * 结构化倍率与时段信息解析（区分 base 与 effective）
 * @param {Object} m 模型对象
 * @param {Date} now 当前时间快照
 * @returns {{base: number|null, effective: number|null, isNightFree: boolean, isNightDiscount: boolean, effectiveRateStatus: 'normal'|'night_free'|'night_discount'|'unknown'}}
 */
export function getModelMultiplierInfo(m, now = new Date()) {
  if (!m || !m.credits || m.credits === '—') {
    return {
      base: null,
      effective: null,
      isNightFree: false,
      isNightDiscount: false,
      effectiveRateStatus: 'unknown',
    };
  }
  const tags = m.tags || [];
  const isNight = isNightWindowNow(now);
  const hasNightFree = tags.includes('夜间免费');
  const hasNightDiscount = tags.includes('夜间折扣');
  const match = String(m.credits).match(/(\d+(?:\.\d+)?)/);
  const base = match ? parseFloat(match[1]) : null;

  if (base === null) {
    return {
      base: null,
      effective: null,
      isNightFree: hasNightFree,
      isNightDiscount: hasNightDiscount,
      effectiveRateStatus: 'unknown',
    };
  }

  if (hasNightFree && isNight) {
    return {
      base,
      effective: 0.0,
      isNightFree: true,
      isNightDiscount: false,
      effectiveRateStatus: 'night_free',
    };
  }

  if (hasNightDiscount && isNight) {
    return {
      base,
      effective: base, // 上游未下发夜间折后数值，排序沿用 baseMultiplier，但在 UI/业务中标注折扣生效
      isNightFree: false,
      isNightDiscount: true,
      effectiveRateStatus: 'night_discount',
    };
  }

  return {
    base,
    effective: base,
    isNightFree: hasNightFree,
    isNightDiscount: hasNightDiscount,
    effectiveRateStatus: 'normal',
  };
}

/**
 * 计算距离下一个 23:00 或 08:00 (Asia/Shanghai, CST, UTC+8) 的毫秒延迟
 * 附带 1000ms 缓冲，确保定时器触发时已严格越过临界点
 * @param {Date} now 当前时间快照
 * @returns {number} 毫秒数
 */
export function getNextWindowBoundaryDelayMs(now = new Date()) {
  const utcMs = now.getTime();
  const curUtcDate = new Date(utcMs);
  const y = curUtcDate.getUTCFullYear();
  const m = curUtcDate.getUTCMonth();
  const d = curUtcDate.getUTCDate();

  const candidateTargets = [];
  for (let offset = -1; offset <= 2; offset++) {
    // 00:00 UTC (08:00 CST)
    candidateTargets.push(Date.UTC(y, m, d + offset, 0, 0, 0, 0));
    // 15:00 UTC (23:00 CST)
    candidateTargets.push(Date.UTC(y, m, d + offset, 15, 0, 0, 0));
  }

  const futureTargets = candidateTargets.filter(t => t > utcMs).sort((a, b) => a - b);
  const nextTarget = futureTargets[0] || (utcMs + 3600 * 1000);
  return Math.max(1000, (nextTarget - utcMs) + 1000);
}

let windowRefreshTimer = null;
export function scheduleNextWindowRefresh() {
  if (typeof setTimeout === 'undefined') return;
  if (windowRefreshTimer) {
    clearTimeout(windowRefreshTimer);
    windowRefreshTimer = null;
  }
  const delay = getNextWindowBoundaryDelayMs();
  windowRefreshTimer = setTimeout(() => {
    applyAndRender();
    scheduleNextWindowRefresh();
  }, delay);
}

/**
 * 倍率数值化（三态语义）：
 *   - 正数：真实倍率
 *   - `0`：免费（`免费 (0.00x)` / `x0.00`）
 *   - `null`：**未知**（credits 缺失 / `—` / 无可解析数字）
 * 免费与未知必须分开：旧实现把两者都归成 `-1`，导致升序时「未知」被排到「免费」之上，
 * 且两种语义在排序上完全无法区分（用户看到的是「未知倍率混在免费里一起置顶」）。
 * @returns {number|null} 倍率数值；未知返回 null（排序时单独置底）
 */
export function getMultiplierNum(m, now = new Date()) {
  if (!m || !m.credits || m.credits === '—') return null;
  const match = String(m.credits).match(/(\d+(?:\.\d+)?)/);
  const fallback = match ? parseFloat(match[1]) : null;
  const info = getModelMultiplierInfo(m, now);
  return info.effective !== null ? info.effective : fallback;
}

function applyAndRender() {
  const now = new Date();
  let list = [...rawModelsList];

  // 1. 标签筛选（「需授权」虚拟标签 = availability === 'unavailable'）
  if (selectedTagFilter !== 'ALL') {
    list = list.filter(m => {
      if (selectedTagFilter === '需授权') return m.availability === 'unavailable';
      return (m.tags || []).includes(selectedTagFilter);
    });
  }

  // 2. 排序（按首字母 / 按倍率）
  if (sortField === 'id') {
    list.sort((a, b) => {
      const cmp = (a.id || '').localeCompare(b.id || '');
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  } else if (sortField === 'credits') {
    list.sort((a, b) => {
      const va = getMultiplierNum(a, now);
      const vb = getMultiplierNum(b, now);
      // 「倍率未知」在升序与降序下**一律置底**：未知不等于 0，也不该被当成最小值。
      // 旧实现把未知当 -1，升序时会排在免费的 0 之上（未知混进免费一组，语义错乱）。
      if (va === null && vb === null) return (a.id || '').localeCompare(b.id || '');
      if (va === null) return 1;
      if (vb === null) return -1;
      const diff = vb - va;
      if (diff !== 0) {
        return sortOrder === 'desc' ? diff : -diff;
      }
      return (a.id || '').localeCompare(b.id || '');
    });
  }

  updateSortHeadersUI();
  updateTagFilterHeaderUI();
  renderModelsTable(list, now);
}

function updateSortHeadersUI() {
  const modelIcon = document.getElementById('sort-icon-model');
  const creditsIcon = document.getElementById('sort-icon-credits');
  const thModel = document.getElementById('th-sort-model');
  const thCredits = document.getElementById('th-sort-credits');

  if (modelIcon) {
    if (sortField === 'id') {
      modelIcon.textContent = sortOrder === 'asc' ? 'A→Z ▲' : 'Z→A ▼';
      modelIcon.classList.add('active');
      thModel?.classList.add('sorted');
    } else {
      modelIcon.textContent = '↕';
      modelIcon.classList.remove('active');
      thModel?.classList.remove('sorted');
    }
  }

  if (creditsIcon) {
    if (sortField === 'credits') {
      creditsIcon.textContent = sortOrder === 'desc' ? '高→低 ▼' : '低→高 ▲';
      creditsIcon.classList.add('active');
      thCredits?.classList.add('sorted');
    } else {
      creditsIcon.textContent = '↕';
      creditsIcon.classList.remove('active');
      thCredits?.classList.remove('sorted');
    }
  }
}

function updateTagFilterDropdown() {
  const dropdown = document.getElementById('tag-filter-dropdown');
  if (!dropdown) return;

  const tagCounts = {};
  // 「需授权」虚拟标签：统计不可用模型数，参与筛选
  const unauthCount = rawModelsList.filter(m => m.availability === 'unavailable').length;
  if (unauthCount > 0) tagCounts['需授权'] = unauthCount;
  for (const m of rawModelsList) {
    for (const t of m.tags || []) {
      if (t) tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }

  const sortedTags = Object.keys(tagCounts).sort((a, b) => {
    const order = { '需授权': 0, '双端': 1, 'WorkBuddy': 2, 'CodeBuddy': 3 };
    const oa = order[a] ?? 99;
    const ob = order[b] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });

  // S7：下拉项补 role/tabindex/aria-label，键盘用户可 Tab 到达并用 Enter/Space 选择
  let itemsHtml = `
    <div class="tag-filter-item ${selectedTagFilter === 'ALL' ? 'active' : ''}" data-filter-tag="ALL"
      role="button" tabindex="0" aria-label="显示全部标签，共 ${rawModelsList.length} 个模型">
      <span>全部标签</span>
      <span class="count-badge">${rawModelsList.length}</span>
    </div>
  `;

  for (const tag of sortedTags) {
    itemsHtml += `
      <div class="tag-filter-item ${selectedTagFilter === tag ? 'active' : ''}" data-filter-tag="${esc(tag)}"
        role="button" tabindex="0" aria-label="按标签筛选：${esc(tag)}，共 ${tagCounts[tag]} 个模型">
        <span>${esc(tag)}</span>
        <span class="count-badge">${tagCounts[tag]}</span>
      </div>
    `;
  }

  dropdown.innerHTML = itemsHtml;
}

function updateTagFilterHeaderUI() {
  const badge = document.getElementById('tag-filter-active-badge');
  const arrow = document.getElementById('tag-filter-arrow');
  const btn = document.getElementById('btn-toggle-tag-filter');

  if (badge) {
    if (selectedTagFilter !== 'ALL') {
      badge.textContent = `${selectedTagFilter} ✕`;
      badge.style.display = 'inline-block';
      if (arrow) arrow.style.display = 'none';
      btn?.classList.add('filter-active');
    } else {
      badge.style.display = 'none';
      if (arrow) arrow.style.display = 'inline-block';
      btn?.classList.remove('filter-active');
    }
  }
}

export function setTagFilter(tag) {
  selectedTagFilter = tag;
  updateTagFilterDropdown();
  applyAndRender();
  const dropdown = document.getElementById('tag-filter-dropdown');
  if (dropdown) dropdown.hidden = true;
}

export function toggleModelSort() {
  if (sortField !== 'id') {
    sortField = 'id';
    sortOrder = 'asc';
  } else if (sortOrder === 'asc') {
    sortOrder = 'desc';
  } else {
    sortField = null;
    sortOrder = null;
  }
  applyAndRender();
}

export function toggleCreditsSort() {
  if (sortField !== 'credits') {
    sortField = 'credits';
    sortOrder = 'desc'; // 默认从大到小排
  } else if (sortOrder === 'desc') {
    sortOrder = 'asc';  // 再点一次从小到大
  } else {
    sortField = null;
    sortOrder = null;
  }
  applyAndRender();
}

export function formatMultiplier(rawOrModel, now = new Date()) {
  const isObj = rawOrModel && typeof rawOrModel === 'object';
  const raw = isObj ? rawOrModel.credits : rawOrModel;
  const tags = isObj ? (rawOrModel.tags || []) : [];
  const hasNightFree = tags.includes('夜间免费');
  const hasNightDiscount = tags.includes('夜间折扣');
  const isNight = isNightWindowNow(now);

  if (!raw || raw === '—') return '<span class="muted">—</span>';
  const match = String(raw).match(/(\d+(?:\.\d+)?)/);
  if (!match) return `<span class="badge badge-info mono">${esc(raw)}</span>`;
  const num = parseFloat(match[1]);

  if (num === 0) {
    return `<span class="badge badge-valid" style="background: var(--success-subtle); color: var(--success-bright); font-weight: 700;">免费 (0.00x)</span>`;
  }

  if (hasNightFree) {
    if (isNight) {
      return `<span class="badge badge-valid" style="background: var(--success-subtle); color: var(--success-bright); font-weight: 700;">免费 (0.00x)</span> <span class="muted" style="font-size:10px; margin-left:3px;" title="夜间限免时段 (23:00–08:00) 调用不扣积分">(🌙 限免中, 原 ${match[1]}x)</span>`;
    } else {
      return `<span class="badge badge-info mono" style="font-weight: 600;">${match[1]}x</span> <span class="muted" style="font-size:10px; margin-left:3px;" title="夜间 23:00–08:00 期间免积分">(🌙 夜间 0.00x)</span>`;
    }
  }

  if (hasNightDiscount) {
    if (isNight) {
      return `<span class="badge badge-info mono" style="font-weight: 600;">${match[1]}x</span> <span class="badge badge-warn" style="font-size:10px; margin-left:3px; font-weight: 600;" title="当前处于夜间时段，该模型享受专属折扣">🌙 折扣生效中</span>`;
    } else {
      return `<span class="badge badge-info mono" style="font-weight: 600;">${match[1]}x</span> <span class="muted" style="font-size:10px; margin-left:3px;" title="夜间 23:00–08:00 享受夜间折扣">(🌙 夜间享折扣)</span>`;
    }
  }

  return `<span class="badge badge-info mono" style="font-weight: 600;">${match[1]}x</span>`;
}

export function renderBadgeHtml(t, m, isNight = isNightWindowNow()) {
  const badgeObj = (m?.badges || []).find(b => b.text === t);
  const color = badgeObj ? badgeObj.color : null;
  const isHex = color && /^#[0-9a-fA-F]{3,8}$/.test(color);

  // 1. 夜间免费
  if (t === '夜间免费' || (badgeObj && badgeObj.kind === 'night_free')) {
    const text = isNight ? '🌙 夜间免费中' : '🌙 夜间免费';
    const title = isNight ? '当前夜间时段 (23:00–08:00) 免积分调用' : '夜间 23:00–08:00 免积分调用';
    const style = isHex
      ? `background: ${color}26; color: ${color}; border: 1px solid ${color}66; font-weight: 600;`
      : isNight
        ? 'background: rgba(16,185,129,0.18); color: #10b981; border: 1px solid rgba(16,185,129,0.4); font-weight: 600;'
        : 'background: rgba(59,130,246,0.12); color: #3b82f6; border: 1px solid rgba(59,130,246,0.3);';
    return `<span class="badge clickable-tag" data-filter-tag="${esc(t)}" role="button" tabindex="0" aria-label="按标签筛选：${esc(t)}" title="${title}" style="font-size: 10px; margin-right: 3px; cursor: pointer; ${style}">${text}</span>`;
  }

  // 2. 夜间折扣
  if (t === '夜间折扣' || (badgeObj && badgeObj.kind === 'night_discount')) {
    const text = isNight ? '🌙 夜间折扣中' : '🌙 夜间折扣';
    const title = isNight ? '当前夜间时段享受折扣倍率（实际以扣费为准）' : '夜间 23:00–08:00 享受夜间折扣';
    const style = isHex
      ? `background: ${color}26; color: ${color}; border: 1px solid ${color}66; font-weight: 600;`
      : isNight
        ? 'background: rgba(245,158,11,0.18); color: #f59e0b; border: 1px solid rgba(245,158,11,0.4); font-weight: 600;'
        : 'background: rgba(59,130,246,0.12); color: #3b82f6; border: 1px solid rgba(59,130,246,0.3);';
    return `<span class="badge clickable-tag" data-filter-tag="${esc(t)}" role="button" tabindex="0" aria-label="按标签筛选：${esc(t)}" title="${title}" style="font-size: 10px; margin-right: 3px; cursor: pointer; ${style}">${text}</span>`;
  }

  // 3. 限时免费
  if (t === '限时免费' || (badgeObj && badgeObj.kind === 'limited_free')) {
    const style = isHex
      ? `background: ${color}26; color: ${color}; border: 1px solid ${color}66; font-weight: 600;`
      : 'background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.4); font-weight: 600;';
    return `<span class="badge clickable-tag" data-filter-tag="${esc(t)}" role="button" tabindex="0" aria-label="按标签筛选：${esc(t)}" title="全天限时免积分调用" style="font-size: 10px; margin-right: 3px; cursor: pointer; ${style}">🔥 ${esc(t)}</span>`;
  }

  // 4. 独家优惠
  if (t === '独家优惠' || (badgeObj && badgeObj.kind === 'exclusive')) {
    const style = isHex
      ? `background: ${color}26; color: ${color}; border: 1px solid ${color}66; font-weight: 600;`
      : 'background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.4); font-weight: 600;';
    return `<span class="badge clickable-tag" data-filter-tag="${esc(t)}" role="button" tabindex="0" aria-label="按标签筛选：${esc(t)}" title="专属特惠超低倍率" style="font-size: 10px; margin-right: 3px; cursor: pointer; ${style}">✨ ${esc(t)}</span>`;
  }

  // 5. 上游下发的其他自定义合法色徽章
  if (isHex) {
    return `<span class="badge clickable-tag" data-filter-tag="${esc(t)}" role="button" tabindex="0" aria-label="按标签筛选：${esc(t)}" title="点击仅筛选 ${esc(t)} 标签模型" style="font-size: 10px; margin-right: 3px; cursor: pointer; background: ${color}26; color: ${color}; border: 1px solid ${color}66; font-weight: 600;">${esc(t)}</span>`;
  }

  // 6. 普通标签
  return `<span class="badge badge-info clickable-tag" data-filter-tag="${esc(t)}" role="button" tabindex="0" aria-label="按标签筛选：${esc(t)}" title="点击仅筛选 ${esc(t)} 标签模型" style="font-size: 10px; margin-right: 3px; cursor: pointer;">${esc(t)}</span>`;
}

function renderModelsTable(list, now = new Date()) {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return;
  currentModelsList = list || [];

  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align: center; padding: 20px;">没有符合筛选条件的模型</td></tr>`;
    return;
  }

  const isNight = isNightWindowNow(now);

  tbody.innerHTML = list.map(m => {
    // 纯粹干净的倍率展示（去除无意义的 credits 单词，动态感知时段限免与折扣）
    const creditsBadge = formatMultiplier(m, now);

    // 思考强度：行内只读展示，点击弹出编辑弹窗
    // 「默认」= 不覆盖，原样透传客户端（Hermes agent.reasoning_effort）下发的值
    const effortText = !m.supports_reasoning
      ? ''
      : m.custom_reasoning_effort === 'disable'
        ? '已关闭思考'
        : (m.custom_reasoning_effort && m.custom_reasoning_effort !== 'default')
          ? `强度: ${m.custom_reasoning_effort}`
          : `默认 (跟随客户端)`;
    const effortCell = m.supports_reasoning
      ? `<button class="cell-edit" id="effort-cell-${esc(m.id)}" data-edit-model="${esc(m.id)}" title="点击修改思考强度">${esc(effortText)}</button>`
      : '<span class="muted" style="font-size: 11px;">不支持思考</span>';

    // 上下文限制：行内只读展示，点击弹出编辑弹窗
    const defaultCtx = m.max_input_tokens;
    const currentCtx = m.custom_context_window || defaultCtx;
    const ctxCell = `
      <button class="cell-edit" id="ctx-cell-${esc(m.id)}" data-edit-model="${esc(m.id)}" title="点击修改上下文窗口">
        ${esc(currentCtx)} <small class="muted">/ ${Math.round(defaultCtx/1000)}k</small>
      </button>
    `;

    // 标签：支持点击快速按标签筛选；不可用模型附「需授权」徽章；精细化渲染彩色徽章
    const tagsHtml = [
      ...(m.availability === 'unavailable'
        ? ['<span class="badge badge-warn clickable-tag" data-filter-tag="需授权" role="button" tabindex="0" aria-label="筛选全部需授权套餐模型" title="点击筛选全部需授权模型" style="font-size: 10px; margin-right: 3px; cursor: pointer;">🔒 需授权套餐</span>']
        : []),
      ...(m.tags || []).map(t => renderBadgeHtml(t, m, isNight)),
    ].join('');

    return `
      <tr>
        <td>
          <button class="model-id-copy mono" data-copy-model="${esc(m.id)}"
            title="点击复制模型调用名（${esc(m.id)}）" aria-label="复制模型调用名 ${esc(m.id)}">
            <strong style="color: var(--link); font-size: 13px;">${esc(m.id)}</strong>
            <span class="model-id-copy-icon" aria-hidden="true">⧉</span>
          </button>
          <div class="muted" style="font-size: 11px;">${esc(m.name)}</div>
        </td>
        <td>${creditsBadge}</td>
        <td>
          <div class="param-cell">${ctxCell}</div>
          <div class="param-cell">${effortCell}</div>
        </td>
        <td><div>${tagsHtml}</div></td>
      </tr>
    `;
  }).join('');
}

// 降级展示：models_fetch_all 拉取失败时使用本地内置模型数据（与主表格保持同 4 列结构）
// S5：降级数据必须视觉可辨识——置顶横幅 + 每行「本地内置模型」标注，
// 避免用户把内置占位数据（倍率列全为 —）误当云端同步回来的真实倍率矩阵。
function renderFallbackModels() {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return;
  const banner = `
    <tr>
      <td colspan="4" style="background: var(--warning-subtle); border-bottom: 1px solid var(--border); padding: 10px 16px;">
        <span class="badge badge-warn" style="margin-right: 8px;">⚠ 云端同步失败</span>
        <span class="muted" style="font-size: 12px;">当前展示的是本地内置模型（${state.models.length} 条），倍率与上下文上限可能与云端不一致。请先启动服务，再点「从云端同步模型列表」重试。</span>
      </td>
    </tr>
  `;
  tbody.innerHTML = banner + state.models.map(m => `
    <tr>
      <td>
        <strong class="mono" style="color: var(--link); font-size: 13px;">${esc(m.id)}</strong>
        <div class="muted" style="font-size: 11px;">本地内置模型</div>
      </td>
      <td><span class="muted">—</span></td>
      <td><span class="mono">${esc(m.ctx)}</span></td>
      <td>${m.tags.map(t => `<span class="badge badge-info" style="font-size: 10px; margin-right: 3px;">${esc(t)}</span>`).join('')}</td>
    </tr>
  `).join('');
}

if (typeof window !== 'undefined') {
  window.saveModelConfig = async (modelId) => {
    const ctxInput = document.getElementById(`ctx-${modelId}`);
    const effortSelect = document.getElementById(`effort-${modelId}`);
    
    const ctxVal = ctxInput ? parseInt(ctxInput.value, 10) : null;
    const effortVal = effortSelect ? effortSelect.value : null;

    try {
      const res = await invokeTauri('model_save_config', {
        modelId,
        contextWindow: ctxVal && !isNaN(ctxVal) ? ctxVal : null,
        reasoningEffort: effortVal && effortVal !== 'default' ? effortVal : null
      });
      showToast(res, 'success');
      updateModelCells(modelId);
      closeModelEdit();
    } catch (e) {
      showToast(`保存失败: ${e.message || e}`, 'error');
    }
  };
}

function updateModelCells(modelId) {
  const ctxInput = document.getElementById(`ctx-${modelId}`);
  const effortSelect = document.getElementById(`effort-${modelId}`);
  const m = currentModelsList.find((x) => x.id === modelId);
  const ctxCell = document.getElementById(`ctx-cell-${modelId}`);
  if (ctxCell && ctxInput && m) {
    ctxCell.innerHTML = `${esc(ctxInput.value)} <small class="muted">/ ${Math.round(m.max_input_tokens / 1000)}k</small>`;
    m.custom_context_window = parseInt(ctxInput.value, 10);
  }
  const eCell = document.getElementById(`effort-cell-${modelId}`);
  if (eCell && effortSelect && m) {
    const v = effortSelect.value;
    eCell.textContent = v === 'disable' ? '已关闭思考'
      : v === 'default' ? '默认 (跟随客户端)'
      : `强度: ${v}`;
    m.custom_reasoning_effort = v === 'default' ? null : v;
  }
}

if (typeof window !== 'undefined') {
  window.openModelEdit = (modelId) => {
    const m = currentModelsList.find((x) => x.id === modelId);
    if (!m) return;
    const defaultCtx = m.max_input_tokens;
    // 硬上限（上游 maxInputTokens）与「客户端默认窗口」是两个量：默认窗口是建议值，
    // 输入框的 max 必须用**硬上限**，否则用户无法把窗口调到默认值以上（模型本可支持）。
    // 老版内核无该字段时退化为默认窗口（= 既有行为）。
    const hardCtx = m.upstream_max_input_tokens || defaultCtx;
    const currentCtx = m.custom_context_window || defaultCtx;
    let html = `
      <div class="zguide-field">
        <span class="zguide-label">上下文窗口上限 (Tokens) · 默认 ${Math.round(defaultCtx / 1000)}k · 硬上限 ${Math.round(hardCtx / 1000)}k</span>
        <input type="number" class="input mono" style="width: 100%;" id="ctx-${esc(modelId)}"
          value="${esc(currentCtx)}" min="1024" max="${esc(hardCtx)}" step="1024" />
      </div>`;
    if (m.supports_reasoning) {
      const currentEffort = m.custom_reasoning_effort || 'default';
      const options = [`<option value="default" ${currentEffort === 'default' ? 'selected' : ''}>默认（跟随客户端下发值）</option>`];
      for (const ef of m.supported_efforts) {
        options.push(`<option value="${esc(ef)}" ${currentEffort === ef ? 'selected' : ''}>强度: ${esc(ef)}</option>`);
      }
      if (m.can_disable_thinking) {
        options.push(`<option value="disable" ${currentEffort === 'disable' ? 'selected' : ''}>🚫 关闭思考</option>`);
      }
      const sourceHint = m.efforts_source === 'catalog'
        ? '（档位矩阵来自内置覆盖表，上游此接口未下发完整档位）'
        : m.efforts_source === 'merged'
          ? '（上游只下发部分档位，已按内置覆盖表补全）'
          : '';
      html += `
        <div class="zguide-field" style="margin-top: 12px;">
          <span class="zguide-label">思考强度 (Reasoning) ${esc(sourceHint)}</span>
          <select class="input mono" style="width: 100%;" id="effort-${esc(modelId)}">${options.join('')}</select>
          <p class="muted" style="font-size: 11px; margin-top: 6px;">默认档位 = 不覆盖，原样透传客户端（如 Hermes 的 reasoning_effort）下发的值；模型默认档为 <code>${esc(m.default_effort)}</code>。</p>
        </div>`;
    } else {
      html += '<p class="muted" style="font-size: 12px; margin-top: 12px;">该模型不支持思考强度调节</p>';
    }
    document.getElementById('model-edit-title').textContent = `编辑 ${m.id}（${m.name}）`;
    document.getElementById('model-edit-body').innerHTML = html;
    document.getElementById('model-edit-save').dataset.model = modelId;
    document.getElementById('model-edit-overlay').hidden = false;
  };
}

function closeModelEdit() {
  const overlay = document.getElementById('model-edit-overlay');
  if (overlay) overlay.hidden = true;
}

// S6：标签筛选下拉改为视口级定位。
// 触发按钮所在的 <th> 位于 `overflow-x: auto` 的卡片容器内，窗口拖窄时（窗口 minWidth 820）
// 绝对定位的下拉会被该容器裁剪 —— 实测 800px 宽时仅 47.5% 可见、8 个菜单项 0 个可点。
// position: fixed 使下拉脱离该裁剪容器，坐标按触发按钮实时计算（滚动/缩放时重算）。
function positionTagDropdown(trigger) {
  const dropdown = document.getElementById('tag-filter-dropdown');
  if (!dropdown || dropdown.hidden || !trigger) return;
  const rect = trigger.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  // 触发按钮已滚出视口：直接收起，避免菜单跟着跑到屏幕外变成「看不见也点不着」
  if (rect.bottom < 8 || rect.top > vh - 8) {
    dropdown.hidden = true;
    return;
  }
  // 先切到 fixed 再量尺寸，否则量到的是被裁剪容器约束下的值
  dropdown.style.position = 'fixed';
  dropdown.style.right = 'auto';
  dropdown.style.marginTop = '0';
  const menuWidth = dropdown.offsetWidth || 160;
  const menuHeight = dropdown.offsetHeight || 240;
  // 水平：右对齐触发按钮，并夹紧在视口内
  const left = Math.max(8, Math.min(rect.right - menuWidth, vw - menuWidth - 8));
  // 垂直：默认挂在按钮下方；下方空间不足则翻到按钮上方；最后夹紧进视口，
  // 避免触发按钮贴近视口边缘时菜单被裁掉一半（窄窗 + 长标签列表更容易触发）。
  const below = rect.bottom + 4;
  const above = rect.top - menuHeight - 4;
  let top = below + menuHeight > vh - 8 && above >= 8 ? above : below;
  top = Math.max(8, Math.min(top, vh - menuHeight - 8));
  dropdown.style.top = `${Math.round(top)}px`;
  dropdown.style.left = `${Math.round(left)}px`;
}

export function initModelsAndCopy() {
  // S5：等真实结果再提示——云端失败时降级为本地内置数据，不能再弹「同步成功」
  document.getElementById('btn-refresh-models')?.addEventListener('click', async () => {
    const ok = await loadModelsMatrix();
    showToast(
      ok ? '已从云端同步模型列表' : '云端同步失败，已展示本地内置模型',
      ok ? 'success' : 'error'
    );
  });

  // 模型参数编辑弹窗
  document.getElementById('model-edit-save')?.addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.model;
    if (id) saveModelConfig(id);
  });
  document.getElementById('model-edit-cancel')?.addEventListener('click', closeModelEdit);
  document.getElementById('model-edit-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'model-edit-overlay') closeModelEdit();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('model-edit-overlay')?.hidden) closeModelEdit();
  });

  // 表头排序事件：点击“模型”首字母排序
  document.getElementById('th-sort-model')?.addEventListener('click', () => {
    toggleModelSort();
  });

  // 表头排序事件：点击“计费倍率”排序（高->低，低->高）
  document.getElementById('th-sort-credits')?.addEventListener('click', () => {
    toggleCreditsSort();
  });

  // 表头标签筛选下拉展开/收起
  const btnTagFilter = document.getElementById('btn-toggle-tag-filter');
  const tagDropdown = document.getElementById('tag-filter-dropdown');
  btnTagFilter?.addEventListener('click', (e) => {
    e.stopPropagation();
    // 若点击的是选中的标签 ✕，则直接清空筛选恢复全部
    if (e.target.id === 'tag-filter-active-badge' || e.target.closest('#tag-filter-active-badge')) {
      setTagFilter('ALL');
      return;
    }
    if (tagDropdown) {
      tagDropdown.hidden = !tagDropdown.hidden;
      if (!tagDropdown.hidden) positionTagDropdown(e.currentTarget);
    }
  });

  // 下拉打开期间：窗口缩放 / 内容区滚动时重算 fixed 坐标（否则菜单会与触发按钮脱位）
  window.addEventListener('resize', () => positionTagDropdown(btnTagFilter));
  document.querySelector('.content-body')?.addEventListener('scroll', () => positionTagDropdown(btnTagFilter));

  // 标签筛选菜单点击选项
  tagDropdown?.addEventListener('click', (e) => {
    e.stopPropagation();
    const item = e.target.closest('[data-filter-tag]');
    if (item) {
      setTagFilter(item.dataset.filterTag);
    }
  });

  // S7：下拉项键盘操作（Enter/Space 等同点击；Space 需 preventDefault 防页面滚动）
  tagDropdown?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const item = e.target.closest('[data-filter-tag]');
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    setTagFilter(item.dataset.filterTag);
  });

  // 点击外部自动收起标签筛选下拉菜单
  document.addEventListener('click', (e) => {
    const th = document.getElementById('th-filter-tags');
    if (th && !th.contains(e.target)) {
      if (tagDropdown) tagDropdown.hidden = true;
    }
  });

  // 模型表格事件委托：行内编辑按钮与标签快速筛选
  const modelsTbody = document.getElementById('models-table-body');
  modelsTbody?.addEventListener('click', async (e) => {
    // 模型 id 点击 = 复制调用名（客户端配置时直接粘贴）
    const idEl = e.target.closest('[data-copy-model]');
    if (idEl) {
      const modelId = idEl.dataset.copyModel || '';
      if (!modelId) return;
      const ok = await copyToClipboard(modelId);
      showToast(ok ? `已复制模型名：${modelId}` : '复制失败，请手动选择文本复制', ok ? 'success' : 'error');
      return;
    }
    const tagEl = e.target.closest('.clickable-tag[data-filter-tag]');
    if (tagEl) {
      setTagFilter(tagEl.dataset.filterTag);
      return;
    }
    const btn = e.target.closest('[data-edit-model]');
    if (btn) window.openModelEdit(btn.dataset.editModel);
  });

  // S7：行内标签徽章键盘操作（Enter/Space 等同点击；Space 需 preventDefault 防页面滚动）
  modelsTbody?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    const tagEl = e.target.closest('.clickable-tag[data-filter-tag]');
    if (!tagEl) return;
    e.preventDefault();
    setTagFilter(tagEl.dataset.filterTag);
  });

  // 复制按钮事件代理（S4：必须 await 真实结果再提示——剪贴板写入被拒时不得报「已复制」）
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.copy;
      const el = document.getElementById(targetId);
      const text = el?.value || el?.textContent || '';
      if (!text) {
        showToast('没有可复制的内容', 'error');
        return;
      }
      const ok = await copyToClipboard(text);
      showToast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本复制', ok ? 'success' : 'error');
    });
  });

  // P1-2：对齐下一个 23:00 或 08:00 边界时刻自动重渲染；并监听可见性与焦点唤醒重排
  scheduleNextWindowRefresh();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) applyAndRender();
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => {
      applyAndRender();
    });
  }
}
