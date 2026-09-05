/**
 * 模型全量矩阵与参数定制 (倍率/思考强度/上下文)
 * 说明：window.saveModelConfig / window.openModelEdit 保持原有 window 挂载
 * （行内编辑按钮的事件委托以 window.openModelEdit 调用）。
 */

import { state } from './state.js';
import { esc, showToast, invokeTauri } from './utils.js';

export async function loadModelsMatrix() {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 24px;"><span class="spinner"></span> 正在同步全量模型与计费倍率数据...</td></tr>`;

  try {
    const list = await invokeTauri('models_fetch_all');
    renderModelsTable(list);
  } catch (e) {
    console.warn('获取全量模型列表失败，降级展示基础模型:', e);
    renderFallbackModels();
  }
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

let currentModelsList = [];

function renderModelsTable(list) {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return;
  currentModelsList = list || [];

  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align: center; padding: 20px;">未获取到模型数据</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(m => {
    // 纯粹干净的倍率展示（去除无意义的 credits 单词）
    const creditsBadge = formatMultiplier(m.credits);

    // 思考强度：行内只读展示，点击弹出编辑弹窗
    const effortText = !m.supports_reasoning
      ? ''
      : m.custom_reasoning_effort === 'disable'
        ? '已关闭思考'
        : (m.custom_reasoning_effort && m.custom_reasoning_effort !== 'default')
          ? `强度: ${m.custom_reasoning_effort}`
          : `默认 (${m.default_effort})`;
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

    // 标签（描述已按需求移除）
    const tagsHtml = m.tags.map(t => `<span class="badge badge-info" style="font-size: 10px; margin-right: 3px;">${esc(t)}</span>`).join('');

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
    const options = [`<option value="default" ${currentEffort === 'default' ? 'selected' : ''}>默认 (${esc(m.default_effort)})</option>`];
    for (const ef of m.supported_efforts) {
      options.push(`<option value="${esc(ef)}" ${currentEffort === ef ? 'selected' : ''}>强度: ${esc(ef)}</option>`);
    }
    if (m.can_disable_thinking) {
      options.push(`<option value="disable" ${currentEffort === 'disable' ? 'selected' : ''}>🚫 关闭思考</option>`);
    }
    html += `
      <div class="zguide-field" style="margin-top: 12px;">
        <span class="zguide-label">思考强度 (Reasoning)</span>
        <select class="input mono" style="width: 100%;" id="effort-${esc(modelId)}">${options.join('')}</select>
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

  // 模型表格行内编辑按钮事件委托（data-edit-model，替代 inline onclick 字符串拼接注入风险）
  document.getElementById('models-table-body')?.addEventListener('click', (e) => {
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
