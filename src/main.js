/**
 * CodeBuddy2OpenAI 前端主交互逻辑 (对标 EasyCLIProxyAPI 标准)
 * 具备：全局状态机、多账号管理、内嵌资产积分渲染、Agent 一键配置、接口连通性测试
 */

// 状态管理
const state = {
  currentTab: 'dashboard',
  port: 8787,
  desensitize: true,
  running: false,
  healthTimer: null,
  oauthTimer: null,
  activeAccount: null,
  accountsList: [],
  models: [
    { id: 'glm-5.3-flash', target: 'glm-5.3-flash', ctx: '1,048,576 (1M)', tags: ['主力', '超长上下文', '快速'] },
    { id: 'glm-5.3', target: 'glm-5.3', ctx: '1,048,576 (1M)', tags: ['深度推理', '高智商'] },
    { id: 'glm-5.2', target: 'glm-5.2', ctx: '1,048,576 (1M)', tags: ['稳定'] },
    { id: 'glm-5v-turbo', target: 'glm-5v-turbo', ctx: '1,048,576 (1M)', tags: ['多模态视觉'] },
    { id: 'kimi-k3', target: 'kimi-k3', ctx: '200,000 (200K)', tags: ['长文本', '超强检索'] },
    { id: 'kimi-k2.7', target: 'kimi-k2.7', ctx: '200,000 (200K)', tags: ['通用'] },
    { id: 'deepseek-v4-pro', target: 'deepseek-v4-pro', ctx: '200,000 (200K)', tags: ['代码专家', '强推理'] },
    { id: 'deepseek-v4-flash', target: 'deepseek-v4-flash', ctx: '200,000 (200K)', tags: ['极速响应'] },
    { id: 'hy4-preview', target: 'hy4-preview', ctx: '200,000 (200K)', tags: ['混元最新代'] },
    { id: 'auto', target: 'auto', ctx: '1,048,576 (1M)', tags: ['智能自动路由'] },
  ]
};

// 工具函数：HTML 转义（所有 innerHTML 动态插值统一使用，防 XSS 注入）
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 工具函数：Toast 消息
function showToast(msg, type = 'info') {
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

// ---------------------------------------------------------------------------
// 全局错误兜底：未捕获异常与 Promise 拒绝统一弹窗展示（单例面板，重复触发仅更新内容）
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 自定义确认弹窗（Promise 风格，替代原生 window.confirm）
// 复用 model-edit-overlay 的遮罩模式：hidden 属性控制显隐，Esc / 点遮罩取消
// ---------------------------------------------------------------------------
let confirmState = null; // 当前待决确认 { resolve }

function showConfirm({ title = '确认操作', message = '', confirmText = '确定', danger = false } = {}) {
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

function initConfirmDialog() {
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

// 安全打开外部浏览器
async function openExternal(url) {
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
async function invokeTauri(cmd, args = {}) {
  if (window.__TAURI__?.core?.invoke) {
    return await window.__TAURI__.core.invoke(cmd, args);
  }
  console.warn(`[Mock Invoke] ${cmd}`, args);
  throw new Error('未运行在 Tauri 运行时环境中');
}

// ---------------------------------------------------------------------------
// 明暗双主题（对标上游 theme.ts 模式）
// 初始化顺序：localStorage 持久化值 → 否则系统 prefers-color-scheme（默认深色）
// index.html <head> 内联脚本已在 DOM 渲染前设置 dataset.theme 防闪烁，
// 此处负责读取当前值、同步按钮选中态，并把原生窗口底色与主题对齐。
// ---------------------------------------------------------------------------
const THEME_STORAGE_KEY = 'codebuddy2openai.theme';

// 各主题对应的原生窗口底色（与 CSS --bg-app 保持一致，防原生窗口闪白/闪黑）
const THEME_NATIVE_BG = {
  dark: { red: 13, green: 15, blue: 18, alpha: 255 },     // #0d0f12
  light: { red: 246, green: 247, blue: 245, alpha: 255 }  // #f6f7f5
};

// 同步原生窗口底色；非 Tauri 环境或 API 缺失时静默失败，绝不影响页面
function syncNativeWindowBackground(theme) {
  try {
    const color = THEME_NATIVE_BG[theme] || THEME_NATIVE_BG.dark;
    const current = window.__TAURI__?.window?.getCurrent?.();
    const result = current?.setBackgroundColor?.(color);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch (e) {
    // 静默失败：主题切换不依赖原生窗口底色同步
  }
}

// 应用主题：设置 html[data-theme]、同步切换按钮选中态，persist 为 true 时持久化
function applyTheme(theme, persist = false) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  document.getElementById('btn-theme-light')?.classList.toggle('active', t === 'light');
  document.getElementById('btn-theme-dark')?.classList.toggle('active', t === 'dark');
  syncNativeWindowBackground(t);
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, t); } catch (e) { /* 存储不可用时忽略 */ }
  }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_STORAGE_KEY); } catch (e) { /* 忽略 */ }
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)')?.matches;
  const initial = (saved === 'light' || saved === 'dark') ? saved : (prefersLight ? 'light' : 'dark');
  applyTheme(initial, false); // 初始不写入 localStorage，保留“跟随系统”语义

  document.getElementById('btn-theme-light')?.addEventListener('click', () => applyTheme('light', true));
  document.getElementById('btn-theme-dark')?.addEventListener('click', () => applyTheme('dark', true));
}

// ---------------------------------------------------------------------------
// 页面与选项卡切换
// ---------------------------------------------------------------------------
function initTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.panel-page');
  const titleEl = document.getElementById('page-title');
  const descEl = document.getElementById('page-desc');

  const meta = {
    dashboard: { title: '服务看板', desc: '反代服务运行状态与全局端点概览' },
    accounts: { title: '账号与资产', desc: '管理多账号凭据切换，实时查看各账号的剩余积分与资源包' },
    agents: { title: 'Agent 一键接入', desc: '为日常 AI 助理 (Hermes / ZCode) 一键写入代理配置' },
    models: { title: '模型与接口', desc: '查看支持的标准模型别名与多语言接入示例' },
    oauth: { title: '授权新账号', desc: '无需原版 WorkBuddy 客户端，浏览器直接网页授权绑定' },
    settings: { title: '服务设置', desc: '代理端口、脱敏选项及凭据目录管理' },
    logs: { title: '实时运行日志', desc: '内嵌控制台查看本地反代服务的完整输出与 Debug 信息' },
    usage: { title: '用量统计', desc: '本地请求统计与 48 小时趋势（数据自本版本起记录）' },
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      if (!tab) return;
      state.currentTab = tab;

      navItems.forEach(n => n.classList.toggle('active', n === item));
      panels.forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));

      if (meta[tab]) {
        titleEl.textContent = meta[tab].title;
        descEl.textContent = meta[tab].desc;
      }

      // 切换到对应页面时的专属数据加载
      if (tab === 'accounts') loadAccountsData();
      if (tab === 'agents') loadAgentsStatus();
      if (tab === 'dashboard') checkHealth();
      if (tab === 'models') loadModelsMatrix();
      if (tab === 'logs') loadLogs();
      if (tab === 'usage') loadUsageData();
    });
  });

  // 跨页面快速跳转按钮
  document.getElementById('btn-goto-oauth')?.addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="oauth"]')?.click();
  });
}

// ---------------------------------------------------------------------------
// 服务生命周期与控制
// ---------------------------------------------------------------------------
function initServiceControls() {
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnRestart = document.getElementById('btn-restart');

  btnStart?.addEventListener('click', async () => {
    try {
      btnStart.disabled = true;
      showToast('正在启动反代服务...', 'info');
      await invokeTauri('proxy_start', { port: state.port, desensitize: state.desensitize });
      showToast('反代服务已拉起', 'success');
      setTimeout(checkHealth, 600);
    } catch (e) {
      showToast(`启动失败: ${e.message || e}`, 'error');
    } finally {
      btnStart.disabled = false;
    }
  });

  btnStop?.addEventListener('click', async () => {
    try {
      btnStop.disabled = true;
      await invokeTauri('proxy_stop');
      showToast('服务已停止', 'info');
      updateServiceStatus(false);
    } catch (e) {
      showToast(`停止失败: ${e.message || e}`, 'error');
    } finally {
      btnStop.disabled = false;
    }
  });

  btnRestart?.addEventListener('click', async () => {
    try {
      btnRestart.disabled = true;
      showToast('正在重启服务...', 'info');
      await invokeTauri('proxy_restart', { port: state.port, desensitize: state.desensitize });
      showToast('服务已重启完成', 'success');
      setTimeout(checkHealth, 800);
    } catch (e) {
      showToast(`重启失败: ${e.message || e}`, 'error');
    } finally {
      btnRestart.disabled = false;
    }
  });
}

async function checkHealth() {
  try {
    const data = await invokeTauri('proxy_health', { port: state.port });
    updateServiceStatus(true, data);
  } catch (e) {
    updateServiceStatus(false);
  }
}

// /health 已安全收窄（只返回 status/authenticated），身份信息改用鉴权的 Tauri 接口获取
async function getActiveAccountNickname() {
  try {
    const list = await invokeTauri('accounts_list');
    const active = list.find(a => a.is_active) || list[0];
    return active?.nickname || '已登录';
  } catch (e) {
    return '已登录';
  }
}

function updateServiceStatus(isRunning, data = null) {
  state.running = isRunning;
  const sideDot = document.getElementById('side-dot');
  const sideText = document.getElementById('side-status-text');
  const dashBadge = document.getElementById('dash-status-badge');
  const dashTime = document.getElementById('dash-health-time');
  const dashActive = document.getElementById('dash-active-account');
  const sideUser = document.getElementById('side-active-user');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');

  if (btnStart) btnStart.disabled = isRunning;
  if (btnStop) btnStop.disabled = !isRunning;

  if (isRunning) {
    sideDot.className = 'dot dot-running';
    sideText.textContent = '服务运行中';
    dashBadge.className = 'badge badge-running';
    dashBadge.textContent = '运行中';

    getActiveAccountNickname().then((nick) => {
      dashActive.textContent = nick;
      sideUser.textContent = nick;
    });
    dashTime.textContent = `检测时间: ${new Date().toLocaleTimeString()}`;
  } else {
    sideDot.className = 'dot dot-stopped';
    sideText.textContent = '服务已停止';
    dashBadge.className = 'badge badge-stopped';
    dashBadge.textContent = '已停止';
    dashActive.textContent = '—';
    sideUser.textContent = '未在线';
    dashTime.textContent = '服务离线';
  }
}

// ---------------------------------------------------------------------------
// 连通性测试 (Test Chat)
// ---------------------------------------------------------------------------
function initTestChat() {
  const btn = document.getElementById('btn-test-chat');
  const box = document.getElementById('test-result-box');
  const tag = document.getElementById('test-status-tag');
  const modelTag = document.getElementById('test-model-tag');
  const latency = document.getElementById('test-latency');
  const ttftWrap = document.getElementById('test-ttft-wrap');
  const ttft = document.getElementById('test-ttft');
  const output = document.getElementById('test-response-text');

  // 展示首字时延（契约1：ttft_ms 为数字或 null，null/缺失表示未测得则隐藏该指标）
  const renderTtft = (value) => {
    if (!ttftWrap || !ttft) return;
    const n = Number(value);
    if (value !== null && value !== undefined && Number.isFinite(n)) {
      ttft.textContent = `${Math.round(n)} ms`;
      ttftWrap.classList.remove('hidden');
    } else {
      ttftWrap.classList.add('hidden');
    }
  };

  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;margin-right:6px;"></span>请求中...`;
    box.classList.remove('hidden');
    tag.className = 'badge badge-info';
    tag.textContent = '请求中...';
    latency.textContent = '— ms';
    renderTtft(null); // 请求开始时隐藏首字指标，避免残留上次结果
    output.textContent = '正在向本地反代发起聊天完成测试...';

    try {
      const res = await invokeTauri('proxy_test_chat', { port: state.port, model: 'glm-5.3-flash' });
      if (res.success) {
        tag.className = 'badge badge-valid';
        tag.textContent = '测试通过';
        modelTag.textContent = res.model;
        latency.textContent = `${res.latency_ms} ms`;
        renderTtft(res.ttft_ms);
        output.textContent = res.response || '(模型返回内容为空)';
        showToast('接口连通测试成功！', 'success');
      } else {
        tag.className = 'badge badge-expired';
        tag.textContent = '请求异常';
        modelTag.textContent = res.model;
        latency.textContent = `${res.latency_ms} ms`;
        renderTtft(res.ttft_ms);
        output.textContent = res.error || '未返回有效结果';
        showToast('测试失败，请检查服务状态', 'error');
      }
    } catch (e) {
      tag.className = 'badge badge-expired';
      tag.textContent = '错误';
      output.textContent = `客户端错误: ${e.message || e}`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> 测试连通性`;
    }
  });
}

// ---------------------------------------------------------------------------
// 账号与资产管理 (核心：内嵌积分、多账号管理)
// ---------------------------------------------------------------------------
async function loadAccountsData() {
  const container = document.getElementById('active-account-container');
  const listEl = document.getElementById('accounts-list');
  container.innerHTML = `<div class="card" style="padding: 24px; text-align: center;"><span class="spinner"></span> 正在同步账号与资产数据...</div>`;

  try {
    const [accounts, usage] = await Promise.allSettled([
      invokeTauri('accounts_list'),
      invokeTauri('usage_query')
    ]);

    const acctList = accounts.status === 'fulfilled' ? accounts.value : [];
    const usageData = usage.status === 'fulfilled' ? usage.value : null;
    state.accountsList = acctList;

    renderActiveAccountAndUsage(acctList.find(a => a.is_active) || acctList[0], usageData);
    renderAccountsGrid(acctList);
  } catch (e) {
    container.innerHTML = `<div class="card" style="color: var(--danger);">加载失败: ${esc(e.message || e)}</div>`;
  }
}

function renderActiveAccountAndUsage(acct, usage) {
  const container = document.getElementById('active-account-container');
  if (!container) return;

  if (!acct) {
    container.innerHTML = `
      <div class="card" style="text-align: center; padding: 36px 20px;">
        <p class="muted" style="font-size: 15px; margin-bottom: 14px;">当前尚未登录任何账号</p>
        <button class="btn btn-primary" onclick="document.querySelector('.nav-item[data-tab=\\'oauth\\']').click()">立即授权绑定新账号</button>
      </div>
    `;
    return;
  }

  const firstLetter = (acct.nickname || 'W').charAt(0).toUpperCase();
  const expStr = acct.token_expires_at ? new Date(acct.token_expires_at).toLocaleString() : '长期有效';
  const badgeClass = acct.token_expired ? 'badge-expired' : 'badge-valid';
  const badgeText = acct.token_expired ? 'Token 已过期' : 'Token 有效';

  // 计算积分进度
  let quotaHtml = '';
  if (usage) {
    const total = usage.total || 0;
    const remain = usage.remain || 0;
    const used = usage.used || 0;
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((remain / total) * 100))) : 0;
    const progressColor = pct < 15 ? 'var(--danger)' : pct < 35 ? 'var(--warning)' : 'var(--success)';

    const pkgRows = (usage.packages || []).map(p => `
      <div class="pkg-item">
        <span class="mono muted">${esc(p.code || '默认资源包')}</span>
        <span><strong>${Math.round(p.remain)}</strong> / ${Math.round(p.total)} <small class="muted">${esc(p.unit)}</small></span>
      </div>
    `).join('');

    quotaHtml = `
      <div class="embedded-quota-box">
        <div class="quota-stats-head">
          <div>
            <span class="quota-remain-big mono">${Math.round(remain).toLocaleString()}</span>
            <span class="quota-unit-tag">剩余积分</span>
            ${usage.is_paid_user ? '<span class="badge badge-info" style="margin-left:8px;">企业/付费版</span>' : '<span class="badge badge-info" style="margin-left:8px;">个人免费版</span>'}
          </div>
          <div class="quota-totals-text">
            <span>总计 <strong class="mono">${Math.round(total).toLocaleString()}</strong></span> · 
            <span>已消耗 <strong class="mono">${Math.round(used).toLocaleString()}</strong></span>
          </div>
        </div>
        <div class="progress-track">
          <div class="progress-fill" style="width: ${pct}%; background: ${progressColor};"></div>
        </div>
        ${pkgRows ? `<div class="pkg-list">${pkgRows}</div>` : ''}
      </div>
    `;
  } else {
    quotaHtml = `
      <div class="embedded-quota-box" style="text-align: center; padding: 16px;">
        <span class="muted">暂未获取到该账号积分资产</span>
        <button class="btn btn-secondary btn-sm" style="margin-left: 10px;" onclick="loadAccountsData()">刷新积分</button>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="account-card-active">
      <div class="account-profile-header">
        <div class="avatar-circle">${esc(firstLetter)}</div>
        <div class="account-titles">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span class="account-nickname">${esc(acct.nickname || '未命名')}</span>
            <span class="badge ${badgeClass}">${badgeText}</span>
            <span class="badge badge-running" style="font-size: 10px;">当前活跃</span>
          </div>
          <div class="account-sub-info">
            <span>UID: <strong class="mono">${esc(acct.uid)}</strong></span>
            ${acct.phone_number ? `<span>手机: <strong class="mono">${esc(acct.phone_number)}</strong></span>` : ''}
            <span>到期时间: <strong class="mono">${esc(expStr)}</strong></span>
          </div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-secondary btn-sm" id="btn-refresh-token">刷新 Token</button>
        </div>
      </div>
      ${quotaHtml}
    </div>
  `;

  document.getElementById('btn-refresh-token')?.addEventListener('click', async () => {
    try {
      showToast('正在向腾讯后端刷新 Token...', 'info');
      const res = await invokeTauri('accounts_refresh_token', { uid: acct.uid });
      showToast(res, 'success');
      loadAccountsData();
    } catch (e) {
      showToast(`Token 刷新失败: ${e.message || e}`, 'error');
    }
  });
}

function renderAccountsGrid(list) {
  const grid = document.getElementById('accounts-list');
  if (!grid) return;

  if (list.length === 0) {
    grid.innerHTML = `<p class="muted">暂无更多已保存账号</p>`;
    return;
  }

  grid.innerHTML = list.map(a => `
    <div class="account-item-card ${a.is_active ? 'is-active' : ''}">
      <div class="account-item-header">
        <strong>${esc(a.nickname || '未命名')}</strong>
        ${a.is_active ? '<span class="badge badge-running">使用中</span>' : `<button class="btn btn-secondary btn-sm" data-act="switch" data-uid="${esc(a.uid)}">设为活跃</button>`}
      </div>
      <div class="mono muted" style="font-size: 11px;">${esc(a.uid)}</div>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-top: 4px;">
        <span class="${a.token_expired ? 'text-danger' : 'text-success'}">${a.token_expired ? '已过期' : '凭据有效'}</span>
        ${!a.is_active ? `<button class="btn btn-danger btn-sm" data-act="delete" data-uid="${esc(a.uid)}" style="padding: 2px 6px;">删除</button>` : ''}
      </div>
    </div>
  `).join('');
}

// 账号卡片按钮事件委托（data-act + data-uid，替代 inline onclick 的字符串拼接注入风险）
function initAccountsDelegation() {
  const grid = document.getElementById('accounts-list');
  if (!grid) return;
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !btn.dataset.uid) return;
    if (btn.dataset.act === 'switch') window.switchAccount(btn.dataset.uid);
    if (btn.dataset.act === 'delete') window.deleteAccount(btn.dataset.uid);
  });
}

window.switchAccount = async (uid) => {
  try {
    await invokeTauri('accounts_switch', { uid });
    showToast('已成功切换当前活跃账号', 'success');
    loadAccountsData();
    checkHealth();
  } catch (e) {
    showToast(`切换账号失败: ${e.message || e}`, 'error');
  }
};

window.deleteAccount = async (uid) => {
  const ok = await showConfirm({
    title: '删除账号',
    message: '确定要删除该账号的本地凭据吗？',
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;
  try {
    await invokeTauri('accounts_delete', { uid });
    showToast('已删除指定账号', 'info');
    loadAccountsData();
  } catch (e) {
    showToast(`删除失败: ${e.message || e}`, 'error');
  }
};

// ---------------------------------------------------------------------------
// Agent 一键接入 (Hermes / ZCode)
// ---------------------------------------------------------------------------
async function loadAgentsStatus() {
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

async function copyToClipboard(text) {
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

function initAgentActions() {
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

// ---------------------------------------------------------------------------
// 网页授权登录 (OAuth) - 绝不混入无关资产卡片，纯粹专注登录
// ---------------------------------------------------------------------------
function initOAuth() {
  const btnStart = document.getElementById('btn-oauth-start');
  const processArea = document.getElementById('oauth-process-area');
  const linkInput = document.getElementById('oauth-link-input');
  const btnOpen = document.getElementById('btn-open-browser');
  const btnCancel = document.getElementById('btn-oauth-cancel');
  const statusText = document.getElementById('oauth-status-text');

  let activeAuthUrl = '';

  btnStart?.addEventListener('click', async () => {
    try {
      btnStart.disabled = true;
      statusText.textContent = '正在向腾讯授权中心发起登录请求...';
      processArea.classList.remove('hidden');

      const res = await invokeTauri('auth_begin', { platform: 'console' });
      activeAuthUrl = res.auth_url;
      linkInput.value = res.auth_url;

      // 自动尝试系统浏览器唤起
      await openExternal(res.auth_url);
      statusText.textContent = '浏览器已唤起，等待您扫码或登录授权完成...';

      // 启动轮询
      pollOAuth(res.state);
    } catch (e) {
      showToast(`授权发起失败: ${e.message || e}`, 'error');
      processArea.classList.add('hidden');
    } finally {
      btnStart.disabled = false;
    }
  });

  btnOpen?.addEventListener('click', () => {
    if (activeAuthUrl) openExternal(activeAuthUrl);
  });

  btnCancel?.addEventListener('click', () => {
    if (state.oauthTimer) clearInterval(state.oauthTimer);
    processArea.classList.add('hidden');
    showToast('已取消本次登录', 'info');
  });

  function pollOAuth(oauthState) {
    if (state.oauthTimer) clearInterval(state.oauthTimer);
    let attempts = 0;

    state.oauthTimer = setInterval(async () => {
      attempts++;
      if (attempts > 120) { // 4 分钟超时
        clearInterval(state.oauthTimer);
        statusText.textContent = '登录等待超时，请重新点击开始授权';
        return;
      }

      try {
        const res = await invokeTauri('auth_poll', { state: oauthState });
        if (res.code === 0 && res.data) {
          clearInterval(state.oauthTimer);
          showToast('登录成功！已自动保存凭据并更新活跃账号', 'success');
          processArea.classList.add('hidden');
          // 自动跳转到账号与资产面板
          document.querySelector('.nav-item[data-tab="accounts"]')?.click();
        }
      } catch (e) {
        console.warn('轮询中...', e);
      }
    }, 2000);
  }
}

// ---------------------------------------------------------------------------
// 模型全量矩阵与参数定制 (倍率/思考强度/上下文)
// ---------------------------------------------------------------------------
async function loadModelsMatrix() {
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

function initModelsAndCopy() {
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

// ---------------------------------------------------------------------------
// 设置页面逻辑
// ---------------------------------------------------------------------------
function initSettings() {
  const inputPort = document.getElementById('input-port');
  const btnSave = document.getElementById('btn-save-port');
  const chkDesensitize = document.getElementById('chk-desensitize');
  const chkDebugConsole = document.getElementById('chk-debug-console');
  const chkAutoStart = document.getElementById('chk-auto-start');
  const btnOpenLiveConsole = document.getElementById('btn-open-live-console');
  const radioCloseActions = document.querySelectorAll('input[name="close-action"]');

  // 用户是否已手动改动（防止异步加载的持久化配置覆盖用户正在编辑的值）
  let portTouched = false;
  let desensitizeTouched = false;
  // 最近一次持久化到后端的端口值（用于保存时判断端口是否变化）
  let savedPort = state.port;

  // 端口 → 内存 state 与看板/侧边栏/端点联动展示
  const applyPortToUi = (val) => {
    state.port = val;
    const dashPort = document.getElementById('dash-port');
    if (dashPort) dashPort.textContent = String(val);
    const sideBadge = document.getElementById('side-port-badge');
    if (sideBadge) sideBadge.textContent = `:${val}`;
    const endpoint = document.getElementById('endpoint-url');
    if (endpoint) endpoint.value = `http://127.0.0.1:${val}/v1`;
  };

  // 脱敏开关 → 内存 state 与看板联动展示
  const applyDesensitizeToUi = (val) => {
    state.desensitize = val;
    const txt = document.getElementById('dash-desensitize');
    if (txt) {
      txt.textContent = val ? '已启用' : '已禁用';
      txt.className = val ? 'metric-value text-success' : 'metric-value muted';
    }
  };

  // 统一构造完整设置对象（契约：save_app_settings 接收含 port/desensitize 的完整对象）
  const buildSettingsPayload = () => {
    const currentClose = Array.from(radioCloseActions).find(r => r.checked)?.value || 'hide_to_tray';
    return {
      close_action: currentClose,
      auto_start_proxy: chkAutoStart ? chkAutoStart.checked : false,
      show_debug_console: chkDebugConsole ? chkDebugConsole.checked : false,
      port: state.port,
      desensitize: state.desensitize
    };
  };

  const persistSettings = async () => {
    try {
      await invokeTauri('save_app_settings', { settings: buildSettingsPayload() });
      return true;
    } catch (err) {
      showToast(`保存设置失败: ${err.message || err}`, 'error');
      return false;
    }
  };

  // 用户手动改动追踪（先于异步配置加载绑定）
  inputPort?.addEventListener('input', () => { portTouched = true; });
  chkDesensitize?.addEventListener('change', () => { desensitizeTouched = true; });

  chkDebugConsole?.addEventListener('change', async (e) => {
    if (await persistSettings()) {
      showToast(e.target.checked ? '已启用：启动服务时显示外部 CMD 调试窗口' : '已恢复默认：静默后台启动（无黑框）', 'success');
    }
  });

  chkAutoStart?.addEventListener('change', async (e) => {
    if (await persistSettings()) {
      showToast(e.target.checked ? '已启用：下次打开应用自动拉起反代服务' : '已关闭：反代服务需手动启动', 'success');
    }
  });

  radioCloseActions.forEach(r => {
    r.addEventListener('change', async () => {
      if (r.checked) {
        if (await persistSettings()) {
          showToast(r.value === 'hide_to_tray' ? '已设置为：关闭窗口时最小化到系统托盘' : '已设置为：关闭窗口时停止服务并退出', 'success');
        }
      }
    });
  });

  btnSave?.addEventListener('click', async () => {
    const val = parseInt(inputPort.value, 10);
    if (val >= 1024 && val <= 65535) {
      const portChanged = val !== savedPort;
      applyPortToUi(val);
      if (await persistSettings()) {
        savedPort = val;
        // 服务运行中且端口有变化时不自动重启，仅提示用户手动重启生效
        if (state.running && portChanged) {
          showToast('端口已保存，重启服务后生效', 'info');
        } else {
          showToast(`端口已保存为 ${val}，请重启服务生效`, 'info');
        }
      }
    } else {
      showToast('端口范围必须在 1024-65535 之间', 'error');
    }
  });

  chkDesensitize?.addEventListener('change', async (e) => {
    applyDesensitizeToUi(e.target.checked);
    if (await persistSettings()) {
      showToast('脱敏设置已保存', 'success');
    }
  });

  // 读取后端配置（放最后：先绑定监听，异步返回后不覆盖用户已手动改动的值）
  (async () => {
    try {
      const cfg = await invokeTauri('get_app_settings');
      if (cfg) {
        if (cfg.close_action) {
          radioCloseActions.forEach(r => {
            r.checked = (r.value === cfg.close_action);
          });
        }
        if (chkDebugConsole) {
          chkDebugConsole.checked = Boolean(cfg.show_debug_console);
        }
        // 契约新增字段：port / desensitize（缺失或非法时保持前端默认值）
        const cfgPort = Number(cfg.port);
        if (Number.isFinite(cfgPort) && cfgPort >= 1024 && cfgPort <= 65535) {
          savedPort = cfgPort;
          if (!portTouched) {
            if (inputPort) inputPort.value = String(cfgPort);
            applyPortToUi(cfgPort);
          }
        }
        if (typeof cfg.desensitize === 'boolean' && !desensitizeTouched) {
          if (chkDesensitize) chkDesensitize.checked = cfg.desensitize;
          applyDesensitizeToUi(cfg.desensitize);
        }
        if (chkAutoStart) {
          chkAutoStart.checked = Boolean(cfg.auto_start_proxy);
        }
        // 自动拉起：应用启动时按持久化设置执行一次（托盘隐藏重开不触发——前端只加载一次；
        // proxy_start 本身幂等，与首次 checkHealth 的竞态由 800ms 延迟 + state.running 守卫兜底）
        if (cfg.auto_start_proxy && window.__TAURI__) {
          setTimeout(async () => {
            if (state.running) return;
            try {
              await invokeTauri('proxy_start', { port: state.port, desensitize: state.desensitize });
              showToast(`已按设置自动拉起反代服务（:${state.port}）`, 'success');
              setTimeout(checkHealth, 600);
            } catch (e) {
              console.warn('自动拉起反代失败:', e);
            }
          }, 800);
        }
      }
    } catch (e) {
      console.warn('获取设置失败:', e);
    }
  })();
}

// ---------------------------------------------------------------------------
// 实时运行日志 (Logs)
// ---------------------------------------------------------------------------
let logInterval = null;

async function loadLogs() {
  const viewer = document.getElementById('log-viewer');
  if (!viewer) return;
  try {
    const raw = await invokeTauri('proxy_get_logs');
    viewer.textContent = raw || '（暂无日志输出）';
    viewer.scrollTop = viewer.scrollHeight;
  } catch (e) {
    viewer.textContent = `获取日志失败: ${e.message || e}`;
  }
}

function initLogs() {
  const btnRefresh = document.getElementById('btn-refresh-logs');
  const btnClear = document.getElementById('btn-clear-logs');
  const btnOpenDir = document.getElementById('btn-open-logs-dir');

  btnRefresh?.addEventListener('click', () => {
    loadLogs();
    showToast('日志已刷新', 'info');
  });

  btnClear?.addEventListener('click', async () => {
    try {
      await invokeTauri('proxy_clear_logs');
      loadLogs();
      showToast('日志已清空', 'info');
    } catch (e) {
      showToast(`清空失败: ${e.message || e}`, 'error');
    }
  });

  // 打开应用数据目录的资源管理器窗口（契约2：open_logs_dir 无参数，返回 Promise）
  btnOpenDir?.addEventListener('click', async () => {
    try {
      await invokeTauri('open_logs_dir');
      showToast('已打开日志目录', 'success');
    } catch (e) {
      showToast(`打开日志目录失败: ${e.message || e}`, 'error');
    }
  });

  // 处于 logs 标签页时定时拉取
  setInterval(() => {
    if (state.currentTab === 'logs') {
      loadLogs();
    }
  }, 2000);
}

// ---------------------------------------------------------------------------
// 用量统计（usage_summary 契约：today/overall/hourly，详见 commands.rs）
// ---------------------------------------------------------------------------
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

async function loadUsageData(isAuto = false) {
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

function initUsage() {
  document.getElementById('btn-refresh-usage')?.addEventListener('click', () => loadUsageData(false));
  // Tab 激活期间每 30s 静默刷新（切换走后由 currentTab 守卫跳过）
  setInterval(() => {
    if (state.currentTab === 'usage') loadUsageData(true);
  }, 30000);
}

// ---------------------------------------------------------------------------
// 更新检查（check_app_update 契约：失败不打断，update_available=false + error）
// ---------------------------------------------------------------------------
let updateInfo = null; // { current, latest, update_available, release_url, error }

async function checkAppUpdate(silent = true) {
  const entry = document.getElementById('update-entry');
  const dot = document.getElementById('update-dot');
  const text = document.getElementById('update-entry-text');
  if (!entry) return null;
  try {
    const info = await invokeTauri('check_app_update');
    updateInfo = info;
    if (info?.update_available) {
      if (dot) dot.hidden = false;
      if (text) text.textContent = `新版本 v${info.latest} 可用`;
      entry.title = `发现新版本 v${info.latest}，点击查看发布页`;
    } else {
      if (dot) dot.hidden = true;
      if (text) text.textContent = '检查更新';
      entry.title = info?.error
        ? `检查失败：${info.error}（点击重试）`
        : `当前已是最新版本（v${info?.current || ''}）`;
      if (!silent) {
        if (info?.error) showToast(`检查更新失败: ${info.error}`, 'error');
        else showToast(`当前已是最新版本（v${info.current}）`, 'success');
      }
    }
    return info;
  } catch (e) {
    if (!silent) showToast(`检查更新失败: ${e.message || e}`, 'error');
    return null;
  }
}

async function openReleasePage(url) {
  try {
    await window.__TAURI__?.shell?.open(url);
    showToast('已在浏览器打开发布页', 'success');
  } catch {
    // shell 打开失败（权限/环境）：降级为复制链接
    await copyToClipboard(url);
    showToast('已复制发布页链接', 'info');
  }
}

function initUpdateCheck() {
  const entry = document.getElementById('update-entry');
  if (!entry) return;
  const onClick = async () => {
    if (updateInfo?.update_available && updateInfo.release_url) {
      await openReleasePage(updateInfo.release_url);
      return;
    }
    entry.classList.add('checking');
    const text = document.getElementById('update-entry-text');
    if (text) text.textContent = '检查中...';
    await checkAppUpdate(false);
    if (text && !updateInfo?.update_available) text.textContent = '检查更新';
    entry.classList.remove('checking');
  };
  entry.addEventListener('click', onClick);
  entry.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  });
  // 启动后延迟静默检查一次（避开启动初期的健康检查高峰）
  setTimeout(() => checkAppUpdate(true), 1500);
}

// ---------------------------------------------------------------------------
// 初始化入口
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  // 环境检测
  if (!window.__TAURI__) {
    document.getElementById('env-banner')?.classList.remove('hidden');
  }

  // 主题初始化（dataset.theme 已由 head 内联脚本预设，此处同步按钮态与原生窗口底色）
  initTheme();

  initTabs();
  initServiceControls();
  initTestChat();
  initAgentActions();
  initOAuth();
  initModelsAndCopy();
  initSettings();
  initLogs();
  initUsage();
  initUpdateCheck();
  initConfirmDialog();
  initAccountsDelegation();

  // 监听 Tauri 事件广播（托盘启动/停止/重启时即时响应）
  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('proxy-status-changed', () => {
      setTimeout(checkHealth, 200);
      setTimeout(checkHealth, 800);
    });
  }

  // 窗口获取焦点时立即检测（用户从托盘切回控制台瞬间刷新）
  window.addEventListener('focus', checkHealth);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkHealth();
    }
  });

  // 默认启动检测健康（缩短为 3 秒轻量轮询）
  checkHealth();
  loadAgentsStatus();
  loadModelsMatrix();
  setInterval(checkHealth, 3000);
});
