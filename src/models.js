/**
 * 模型全量矩阵与参数定制 (倍率/思考强度/上下文)
 * 说明：window.saveModelConfig / window.openModelEdit 保持原有 window 挂载
 * （行内编辑按钮的事件委托以 window.openModelEdit 调用）。
 */

import { state } from './state.js';
import { esc, showToast, invokeTauri } from './utils.js';

let rawModelsList = [];
let currentModelsList = [];
let sortField = null; // 'id' | 'credits' | null
let sortOrder = null; // 'asc' | 'desc' | null
let selectedTagFilter = 'ALL';

export async function loadModelsMatrix() {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 24px;"><span class="spinner"></span> 正在同步全量模型与计费倍率数据...</td></tr>`;

  try {
    const list = await invokeTauri('models_fetch_all');
    rawModelsList = (list || []).map(m => {
      // 过滤掉无实际业务区分意义的内部 craft 标签
      m.tags = (m.tags || []).filter(t => t && t.toLowerCase() !== 'craft');
      return m;
    });
    updateTagFilterDropdown();
    applyAndRender();
  } catch (e) {
    console.warn('获取全量模型列表失败，降级展示基础模型:', e);
    renderFallbackModels();
  }
}

function getMultiplierNum(m) {
  if (!m.credits || m.credits === '—') return -1;
  const match = String(m.credits).match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : -1;
}

function applyAndRender() {
  let list = [...rawModelsList];

  // 1. 标签筛选
  if (selectedTagFilter !== 'ALL') {
    list = list.filter(m => (m.tags || []).includes(selectedTagFilter));
  }

  // 2. 排序（按首字母 / 按倍率）
  if (sortField === 'id') {
    list.sort((a, b) => {
      const cmp = (a.id || '').localeCompare(b.id || '');
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  } else if (sortField === 'credits') {
    list.sort((a, b) => {
      const diff = getMultiplierNum(b) - getMultiplierNum(a);
      if (diff !== 0) {
        return sortOrder === 'desc' ? diff : -diff;
      }
      return (a.id || '').localeCompare(b.id || '');
    });
  }

  updateSortHeadersUI();
  updateTagFilterHeaderUI();
  renderModelsTable(list);
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
  for (const m of rawModelsList) {
    for (const t of m.tags || []) {
      if (t) tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }

  const sortedTags = Object.keys(tagCounts).sort((a, b) => {
    const order = { '双端': 1, 'WorkBuddy': 2, 'CodeBuddy': 3 };
    const oa = order[a] || 99;
    const ob = order[b] || 99;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });

  let itemsHtml = `
    <div class="tag-filter-item ${selectedTagFilter === 'ALL' ? 'active' : ''}" data-filter-tag="ALL">
      <span>全部标签</span>
      <span class="count-badge">${rawModelsList.length}</span>
    </div>
  `;

  for (const tag of sortedTags) {
    itemsHtml += `
      <div class="tag-filter-item ${selectedTagFilter === tag ? 'active' : ''}" data-filter-tag="${esc(tag)}">
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

function formatMultiplier(raw) {
  if (!raw || raw === '—') return '<span class="muted">—</span>';
  const match = String(raw).match(/(\d+(?:\.\d+)?)/);
  if (!match) return `<span class="badge badge-info mono">${esc(raw)}</span>`;
  const num = parseFloat(match[1]);
  if (num === 0) {
    return `<span class="badge badge-valid" style="background: var(--success-subtle); color: var(--success-bright); font-weight: 700;">免费 (0.00x)</span>`;
  }
  return `<span class="badge badge-info mono" style="font-weight: 600;">${match[1]}x</span>`;
}

function renderModelsTable(list) {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return;
  currentModelsList = list || [];

  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align: center; padding: 20px;">没有符合筛选条件的模型</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(m => {
    // 纯粹干净的倍率展示（去除无意义的 credits 单词）
    const creditsBadge = formatMultiplier(m.credits);

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

    // 标签：支持点击快速按标签筛选
    const tagsHtml = (m.tags || []).map(t =>
      `<span class="badge badge-info clickable-tag" data-filter-tag="${esc(t)}" title="点击仅筛选 ${esc(t)} 标签模型" style="font-size: 10px; margin-right: 3px; cursor: pointer;">${esc(t)}</span>`
    ).join('');

    return `
      <tr>
        <td>
          <strong class="mono" style="color: var(--link); font-size: 13px;">${esc(m.id)}</strong>
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
function renderFallbackModels() {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return;
  tbody.innerHTML = state.models.map(m => `
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
      : v === 'default' ? `默认 (${m.default_effort})`
      : `强度: ${v}`;
    m.custom_reasoning_effort = v === 'default' ? null : v;
  }
}

window.openModelEdit = (modelId) => {
  const m = currentModelsList.find((x) => x.id === modelId);
  if (!m) return;
  const defaultCtx = m.max_input_tokens;
  const currentCtx = m.custom_context_window || defaultCtx;
  let html = `
    <div class="zguide-field">
      <span class="zguide-label">上下文窗口上限 (Tokens) · 上限 ${Math.round(defaultCtx / 1000)}k</span>
      <input type="number" class="input mono" style="width: 100%;" id="ctx-${esc(modelId)}"
        value="${esc(currentCtx)}" min="1024" max="${esc(defaultCtx)}" step="1024" />
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

function closeModelEdit() {
  const overlay = document.getElementById('model-edit-overlay');
  if (overlay) overlay.hidden = true;
}

export function initModelsAndCopy() {
  document.getElementById('btn-refresh-models')?.addEventListener('click', () => {
    loadModelsMatrix();
    showToast('已从云端同步模型列表', 'info');
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
    }
  });

  // 标签筛选菜单点击选项
  tagDropdown?.addEventListener('click', (e) => {
    e.stopPropagation();
    const item = e.target.closest('[data-filter-tag]');
    if (item) {
      setTagFilter(item.dataset.filterTag);
    }
  });

  // 点击外部自动收起标签筛选下拉菜单
  document.addEventListener('click', (e) => {
    const th = document.getElementById('th-filter-tags');
    if (th && !th.contains(e.target)) {
      if (tagDropdown) tagDropdown.hidden = true;
    }
  });

  // 模型表格事件委托：行内编辑按钮与标签快速筛选
  document.getElementById('models-table-body')?.addEventListener('click', (e) => {
    const tagEl = e.target.closest('.clickable-tag[data-filter-tag]');
    if (tagEl) {
      setTagFilter(tagEl.dataset.filterTag);
      return;
    }
    const btn = e.target.closest('[data-edit-model]');
    if (btn) window.openModelEdit(btn.dataset.editModel);
  });

  // 复制按钮事件代理
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.copy;
      const el = document.getElementById(targetId);
      const text = el?.value || el?.textContent || '';
      if (text) {
        navigator.clipboard.writeText(text);
        showToast('已复制到剪贴板', 'success');
      }
    });
  });
}
