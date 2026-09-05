/**
 * Agent 一键接入 (Hermes / ZCode)
 */

import { state } from './state.js';
import { esc, showToast, copyToClipboard, invokeTauri } from './utils.js';

export async function loadAgentsStatus() {
  const hBadge = document.getElementById('hermes-status-badge');
  const zBadge = document.getElementById('zcode-status-badge');
  const hPath = document.getElementById('hermes-path');
  const zPath = document.getElementById('zcode-path');

  try {
    const res = await invokeTauri('agent_detect', { port: state.port });

    // Hermes 状态
    hPath.textContent = res.hermes_config_path || '未找到';
    if (!res.hermes_installed) {
      hBadge.className = 'badge badge-stopped';
      hBadge.textContent = '未安装';
    } else if (res.hermes_configured) {
      hBadge.className = 'badge badge-valid';
      hBadge.textContent = '已接入配置';
    } else {
      hBadge.className = 'badge badge-info';
      hBadge.textContent = '未配置';
    }

    // ZCode 状态：徽章反映服务真实可达性（Desktop 只认 UI 内添加，文件写入不生效）
    zPath.textContent = res.zcode_cli_path || '未找到';
    if (!res.zcode_installed) {
      zBadge.className = 'badge badge-stopped';
      zBadge.textContent = '未安装';
    } else if (res.zcode_service_online) {
      zBadge.className = 'badge badge-valid';
      zBadge.textContent = '服务在线 · 可接入';
    } else if (res.zcode_provider_registered) {
      zBadge.className = 'badge badge-info';
      zBadge.textContent = '服务离线（文件残留）';
    } else {
      zBadge.className = 'badge badge-info';
      zBadge.textContent = '服务离线';
    }
  } catch (e) {
    console.error('Agent 检测失败:', e);
    showToast(`Agent 检测失败: ${e.message || e}`, 'error');
    if (hBadge) hBadge.textContent = '检测失败';
    if (zBadge) zBadge.textContent = '检测失败';
  }
}

function renderZcodeGuide(guide) {
  const wrap = document.getElementById('zcode-guide');
  if (!wrap) return;
  const field = (label, value) => `
    <div class="zguide-field">
      <span class="zguide-label">${esc(label)}</span>
      <span class="zguide-value" data-copy="${esc(value)}" title="点击复制">${esc(value)}</span>
    </div>`;
  const chips = guide.models
    .map((m) => `<span class="zguide-chip" data-copy="${esc(m)}" title="点击复制模型名">${esc(m)}</span>`)
    .join('');
  const allModels = `<span class="zguide-chip" data-copy="${esc(guide.models.join(', '))}" title="点击复制全部模型名">复制全部模型</span>`;
  wrap.innerHTML = `
    <div class="zcode-guide-panel">
      ${field('Base URL（接口地址）', guide.base_url)}
      ${field('API 格式（下拉选择）', guide.api_format)}
      ${field('API Key（密钥）', guide.api_key)}
      <div class="zguide-field">
        <span class="zguide-label">模型列表（点击芯片复制模型名）</span>
        <div class="zguide-chips">${allModels}${chips}</div>
      </div>
      <ol class="zguide-steps">${guide.steps.map((s) => `<li>${esc(s.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ol>
    </div>`;
  wrap.hidden = false;
}

export function initAgentActions() {
  document.getElementById('btn-config-hermes')?.addEventListener('click', async () => {
    try {
      const res = await invokeTauri('agent_configure', { agent_type: 'hermes', port: state.port });
      showToast(res, 'success');
      loadAgentsStatus();
    } catch (e) {
      showToast(`配置失败: ${e.message || e}`, 'error');
    }
  });

  document.getElementById('btn-remove-hermes')?.addEventListener('click', async () => {
    try {
      const res = await invokeTauri('agent_remove', { agent_type: 'hermes' });
      showToast(res, 'info');
      loadAgentsStatus();
    } catch (e) {
      showToast(`移除失败: ${e.message || e}`, 'error');
    }
  });

  document.getElementById('btn-config-zcode')?.addEventListener('click', async () => {
    try {
      const raw = await invokeTauri('agent_configure', { agent_type: 'zcode', port: state.port });
      renderZcodeGuide(JSON.parse(raw));
    } catch (e) {
      showToast(`生成接入配置失败: ${e.message || e}`, 'error');
    }
  });

  // 引导面板内的值/芯片点击即复制（事件委托）
  document.getElementById('zcode-guide')?.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-copy]');
    if (!el) return;
    const ok = await copyToClipboard(el.dataset.copy);
    el.classList.add('copied');
    showToast(ok ? '已复制' : '复制失败，请手动选择文本复制', ok ? 'success' : 'error');
    setTimeout(() => el.classList.remove('copied'), 1500);
  });

  document.getElementById('btn-remove-zcode')?.addEventListener('click', async () => {
    try {
      const res = await invokeTauri('agent_remove', { agent_type: 'zcode' });
      showToast(res, 'info');
      loadAgentsStatus();
    } catch (e) {
      showToast(`清理失败: ${e.message || e}`, 'error');
    }
  });

  document.getElementById('btn-refresh-agents')?.addEventListener('click', loadAgentsStatus);
}
