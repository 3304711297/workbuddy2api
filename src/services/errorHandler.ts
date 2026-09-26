/**
 * 全局错误兜底：未捕获异常与 Promise 拒绝统一弹窗展示（单例面板，重复触发仅更新内容）。
 * 本模块 import 时即注册监听（与旧 error-handler.js 保持同一注册时机语义），
 * 故 main.tsx 必须将其放在第一条 import。
 *
 * 错误文本一律经 textContent 填充，杜绝二次注入。
 */

let errorOverlayEl: HTMLDivElement | null = null;

// 归一化错误详情：Error 取堆栈，普通对象取 JSON，其余转字符串
function formatErrorDetail(prefix: string, detail: unknown): string {
  let text = '';
  if (detail instanceof Error) {
    text = detail.stack || `${detail.name}: ${detail.message}`;
  } else if (detail && typeof detail === 'object') {
    try {
      text = JSON.stringify(detail, null, 2);
    } catch {
      text = Object.prototype.toString.call(detail);
    }
  } else if (detail != null && detail !== '') {
    text = String(detail);
  }
  if (!text) text = '未知错误（无详细信息）';
  return prefix ? `${prefix}\n\n${text}` : text;
}

function buildOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay error-overlay';

  const card = document.createElement('div');
  card.className = 'modal-card error-card';

  const title = document.createElement('h3');
  title.className = 'error-title';
  title.textContent = '应用发生未捕获错误';

  const detail = document.createElement('pre');
  detail.className = 'error-detail mono';

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  const ignoreBtn = document.createElement('button');
  ignoreBtn.className = 'btn btn-secondary btn-sm';
  ignoreBtn.textContent = '忽略';
  ignoreBtn.addEventListener('click', () => {
    overlay.hidden = true;
  });

  const reloadBtn = document.createElement('button');
  reloadBtn.className = 'btn btn-primary btn-sm';
  reloadBtn.textContent = '重新加载';
  reloadBtn.addEventListener('click', () => {
    window.location.reload();
  });

  actions.append(ignoreBtn, reloadBtn);
  card.append(title, detail, actions);
  overlay.append(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
  document.body.appendChild(overlay);
  return overlay;
}

function showUncaughtError(detailText: string): void {
  // 完整信息始终输出到控制台，面板内最多展示 2000 字符
  console.error('[未捕获错误]', detailText);
  const display =
    detailText.length > 2000
      ? `${detailText.slice(0, 2000)}\n...（内容过长已截断，完整信息见控制台）`
      : detailText;

  const mount = () => {
    if (!errorOverlayEl) errorOverlayEl = buildOverlay();
    const detailEl = errorOverlayEl.querySelector('.error-detail');
    if (detailEl) detailEl.textContent = display;
    errorOverlayEl.hidden = false;
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

// 尽早注册监听（模块加载即生效，不等 DOMContentLoaded）
(function initGlobalErrorHandler() {
  window.addEventListener('error', (event) => {
    showUncaughtError(formatErrorDetail('', event.error ?? event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    showUncaughtError(formatErrorDetail('未处理的 Promise 拒绝', event.reason));
  });
})();
