/**
 * 纯工具函数与跨模块共享的 UI 基础设施
 * 包含：esc / showToast / copyToClipboard / openExternal / invokeTauri / 确认弹窗
 */

// 工具函数：HTML 转义（所有 innerHTML 动态插值统一使用，防 XSS 注入）
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 工具函数：Toast 消息
export function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(10px)';
    setTimeout(() => t.remove(), 200);
  }, 3000);
}

// 剪贴板写入（优先 Clipboard API，失败降级 execCommand）
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// 安全打开外部浏览器
export async function openExternal(url) {
  if (!url) return;
  try {
    if (window.__TAURI__?.shell?.open) {
      await window.__TAURI__.shell.open(url);
      return;
    }
  } catch (e) {
    console.warn('Tauri shell.open failed:', e);
  }
  window.open(url, '_blank');
}

// 统一 Tauri Invoke 调用包装
export async function invokeTauri(cmd, args = {}) {
  if (window.__TAURI__?.core?.invoke) {
    return await window.__TAURI__.core.invoke(cmd, args);
  }
  console.warn(`[Mock Invoke] ${cmd}`, args);
  throw new Error('未运行在 Tauri 运行时环境中');
}

// ---------------------------------------------------------------------------
// 自定义确认弹窗（Promise 风格，替代原生 window.confirm）
// 复用 model-edit-overlay 的遮罩模式：hidden 属性控制显隐，Esc / 点遮罩取消
// ---------------------------------------------------------------------------
let confirmState = null; // 当前待决确认 { resolve }

export function showConfirm({ title = '确认操作', message = '', confirmText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    const titleEl = document.getElementById('confirm-title');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('confirm-ok');
    // 弹窗 DOM 缺失时兜底走原生确认，保证调用方流程不中断
    if (!overlay || !titleEl || !msgEl || !okBtn) {
      resolve(window.confirm(message));
      return;
    }
    // 若已有待确认弹窗，先以“取消”结算旧的 Promise，避免悬挂
    if (confirmState) confirmState.resolve(false);
    confirmState = { resolve };
    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmText;
    okBtn.className = danger ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm';
    overlay.hidden = false;
  });
}

function settleConfirm(result) {
  const overlay = document.getElementById('confirm-overlay');
  if (overlay) overlay.hidden = true;
  if (confirmState) {
    confirmState.resolve(result);
    confirmState = null;
  }
}

export function initConfirmDialog() {
  const overlay = document.getElementById('confirm-overlay');
  if (!overlay) return;
  document.getElementById('confirm-ok')?.addEventListener('click', () => settleConfirm(true));
  document.getElementById('confirm-cancel')?.addEventListener('click', () => settleConfirm(false));
  // 点遮罩取消（仅当点击目标为遮罩本身）
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) settleConfirm(false);
  });
  // Esc 取消
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) settleConfirm(false);
  });
}
