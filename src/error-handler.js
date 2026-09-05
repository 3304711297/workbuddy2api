/**
 * 全局错误兜底：未捕获异常与 Promise 拒绝统一弹窗展示（单例面板，重复触发仅更新内容）
 * 注意：本模块在 import 时（模块加载即生效，不等 DOMContentLoaded）注册监听，
 * 入口 main.js 必须将其放在第一条 import，以保持原有注册时机语义。
 */

let errorOverlayEl = null;

// 归一化错误详情：Error 取堆栈，普通对象取 JSON，其余转字符串
function formatErrorDetail(prefix, detail) {
  let text = '';
  if (detail instanceof Error) {
    text = detail.stack || `${detail.name}: ${detail.message}`;
  } else if (detail && typeof detail === 'object') {
    try { text = JSON.stringify(detail, null, 2); } catch { text = Object.prototype.toString.call(detail); }
  } else if (detail != null && detail !== '') {
    text = String(detail);
  }
  if (!text) text = '未知错误（无详细信息）';
  return prefix ? `${prefix}\n\n${text}` : text;
}

function showUncaughtError(detailText) {
  const full = String(detailText ?? '');
  // 完整信息始终输出到控制台，面板内最多展示 2000 字符
  console.error('[未捕获错误]', full);
  const display = full.length > 2000
    ? `${full.slice(0, 2000)}\n...（内容过长已截断，完整信息见控制台）`
    : full;

  const mount = () => {
    if (!errorOverlayEl) {
      errorOverlayEl = document.createElement('div');
      errorOverlayEl.className = 'modal-overlay error-overlay';
      errorOverlayEl.innerHTML = `
        <div class="modal-card error-card">
          <h3 class="error-title">应用发生未捕获错误</h3>
          <pre class="error-detail mono"></pre>
          <div class="modal-actions">
            <button class="btn btn-secondary btn-sm" data-act="ignore">忽略</button>
            <button class="btn btn-primary btn-sm" data-act="reload">重新加载</button>
          </div>
        </div>`;
      document.body.appendChild(errorOverlayEl);
      errorOverlayEl.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'ignore') errorOverlayEl.hidden = true;
        if (act === 'reload') location.reload();
      });
    }
    // 用 textContent 填充错误文本，避免二次注入；重复触发只更新内容不堆叠
    errorOverlayEl.querySelector('.error-detail').textContent = display;
    errorOverlayEl.hidden = false;
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

// 尽早注册监听（模块加载即生效，不等 DOMContentLoaded）
(function initGlobalErrorHandler() {
  window.addEventListener('error', (e) => {
    const src = e.filename ? `${e.filename}:${e.lineno || 0}:${e.colno || 0}` : '';
    showUncaughtError(formatErrorDetail(src, e.error ?? e.message ?? ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    showUncaughtError(formatErrorDetail('未处理的 Promise 拒绝', e.reason ?? ''));
  });
})();
