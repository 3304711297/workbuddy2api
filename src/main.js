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
  const output = document.getElementById('test-response-text');

  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;margin-right:6px;"></span>请求中...`;
    box.classList.remove('hidden');
    tag.className = 'badge badge-info';
    tag.textContent = '请求中...';
    latency.textContent = '— ms';
    output.textContent = '正在向本地反代发起聊天完成测试...';

    try {
      const res = await invokeTauri('proxy_test_chat', { port: state.port, model: 'glm-5.3-flash' });
      if (res.success) {
        tag.className = 'badge badge-valid';
        tag.textContent = '测试通过';
        modelTag.textContent = res.model;
        latency.textContent = `${res.latency_ms} ms`;
        output.textContent = res.response || '(模型返回内容为空)';
        showToast('接口连通测试成功！', 'success');
      } else {
        tag.className = 'badge badge-expired';
        tag.textContent = '请求异常';
        modelTag.textContent = res.model;
        latency.textContent = `${res.latency_ms} ms`;
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
    container.innerHTML = `<div class="card" style="color: var(--danger);">加载失败: ${e.message || e}</div>`;
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
        <span class="mono muted">${p.code || '默认资源包'}</span>
        <span><strong>${Math.round(p.remain)}</strong> / ${Math.round(p.total)} <small class="muted">${p.unit}</small></span>
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
        <div class="avatar-circle">${firstLetter}</div>
        <div class="account-titles">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span class="account-nickname">${acct.nickname || '未命名'}</span>
            <span class="badge ${badgeClass}">${badgeText}</span>
            <span class="badge badge-running" style="font-size: 10px;">当前活跃</span>
          </div>
          <div class="account-sub-info">
            <span>UID: <strong class="mono">${acct.uid}</strong></span>
            ${acct.phone_number ? `<span>手机: <strong class="mono">${acct.phone_number}</strong></span>` : ''}
            <span>到期时间: <strong class="mono">${expStr}</strong></span>
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
        <strong>${a.nickname || '未命名'}</strong>
        ${a.is_active ? '<span class="badge badge-running">使用中</span>' : `<button class="btn btn-secondary btn-sm" onclick="switchAccount('${a.uid}')">设为活跃</button>`}
      </div>
      <div class="mono muted" style="font-size: 11px;">${a.uid}</div>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-top: 4px;">
        <span class="${a.token_expired ? 'text-danger' : 'text-success'}">${a.token_expired ? '已过期' : '凭据有效'}</span>
        ${!a.is_active ? `<button class="btn btn-danger btn-sm" onclick="deleteAccount('${a.uid}')" style="padding: 2px 6px;">删除</button>` : ''}
      </div>
    </div>
  `).join('');
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
  if (!confirm('确定要删除该账号的本地凭据吗？')) return;
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
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
      const res = await invokeTauri('agent_configure', { agent_type: 'hermes', agentType: 'hermes', port: state.port });
      showToast(res, 'success');
      loadAgentsStatus();
    } catch (e) {
      showToast(`配置失败: ${e.message || e}`, 'error');
    }
  });

  document.getElementById('btn-remove-hermes')?.addEventListener('click', async () => {
    try {
      const res = await invokeTauri('agent_remove', { agent_type: 'hermes', agentType: 'hermes' });
      showToast(res, 'info');
      loadAgentsStatus();
    } catch (e) {
      showToast(`移除失败: ${e.message || e}`, 'error');
    }
  });

  document.getElementById('btn-config-zcode')?.addEventListener('click', async () => {
    try {
      const raw = await invokeTauri('agent_configure', { agent_type: 'zcode', agentType: 'zcode', port: state.port });
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
      const res = await invokeTauri('agent_remove', { agent_type: 'zcode', agentType: 'zcode' });
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
  tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 24px;"><span class="spinner"></span> 正在同步全量模型与计费倍率数据...</td></tr>`;

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
  if (!match) return `<span class="badge badge-info mono">${raw}</span>`;
  const num = parseFloat(match[1]);
  if (num === 0) {
    return `<span class="badge badge-valid" style="background: rgba(16,185,129,0.2); color: #34d399; font-weight: 700;">免费 (0.00x)</span>`;
  }
  return `<span class="badge badge-info mono" style="font-weight: 600;">${match[1]}x</span>`;
}

function renderModelsTable(list) {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return;

  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align: center; padding: 20px;">未获取到模型数据</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(m => {
    // 纯粹干净的倍率展示（去除无意义的 credits 单词）
    const creditsBadge = formatMultiplier(m.credits);

    // 思考模式配置下拉
    let effortSelect = '<span class="muted" style="font-size: 11px;">不支持思考</span>';
    if (m.supports_reasoning) {
      const currentEffort = m.custom_reasoning_effort || 'default';
      const options = [];
      options.push(`<option value="default" ${currentEffort === 'default' ? 'selected' : ''}>默认 (${m.default_effort})</option>`);
      
      for (const ef of m.supported_efforts) {
        options.push(`<option value="${ef}" ${currentEffort === ef ? 'selected' : ''}>强度: ${ef}</option>`);
      }
      if (m.can_disable_thinking) {
        options.push(`<option value="disable" ${currentEffort === 'disable' ? 'selected' : ''}>🚫 关闭思考</option>`);
      }
      effortSelect = `
        <select class="input mono" style="padding: 3px 6px; font-size: 11px; width: 130px;" id="effort-${m.id}">
          ${options.join('')}
        </select>
      `;
    }

    // 上下文限制输入
    const defaultCtx = m.max_input_tokens;
    const currentCtx = m.custom_context_window || defaultCtx;
    const ctxInput = `
      <div style="display: flex; align-items: center; gap: 4px;">
        <input type="number" class="input mono" style="padding: 3px 6px; font-size: 11px; width: 100px;" 
          id="ctx-${m.id}" value="${currentCtx}" min="1024" max="${defaultCtx}" step="1024" />
        <small class="muted" style="font-size: 10px;">/ ${Math.round(defaultCtx/1000)}k</small>
      </div>
    `;

    // 标签与描述
    const tagsHtml = m.tags.map(t => `<span class="badge badge-info" style="font-size: 10px; margin-right: 3px;">${t}</span>`).join('');
    const descHtml = m.description ? `<div class="muted truncate" style="font-size: 11px; max-width: 220px; margin-top: 3px;" title="${m.description}">${m.description}</div>` : '';

    return `
      <tr>
        <td>
          <strong class="mono" style="color: #60a5fa; font-size: 13px;">${m.id}</strong>
          <div class="muted" style="font-size: 11px;">${m.name}</div>
        </td>
        <td>${creditsBadge}</td>
        <td>${ctxInput}</td>
        <td>${effortSelect}</td>
        <td>
          <div>${tagsHtml}</div>
          ${descHtml}
        </td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="saveModelConfig('${m.id}')" style="padding: 3px 8px; font-size: 11px;">保存</button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderFallbackModels() {
  const tbody = document.getElementById('models-table-body');
  if (!tbody) return;
  tbody.innerHTML = state.models.map(m => `
    <tr>
      <td><strong class="mono" style="color: #60a5fa;">${m.id}</strong></td>
      <td><span class="badge badge-info">标准倍率</span></td>
      <td><span class="mono">${m.ctx}</span></td>
      <td><span class="muted">默认</span></td>
      <td>${m.tags.map(t => `<span class="badge badge-info" style="margin-right:4px;">${t}</span>`).join('')}</td>
      <td><span class="muted">—</span></td>
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
  } catch (e) {
    showToast(`保存失败: ${e.message || e}`, 'error');
  }
};

function initModelsAndCopy() {
  document.getElementById('btn-refresh-models')?.addEventListener('click', () => {
    loadModelsMatrix();
    showToast('已从云端同步模型列表', 'info');
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
  const btnOpenLiveConsole = document.getElementById('btn-open-live-console');
  const radioCloseActions = document.querySelectorAll('input[name="close-action"]');

  // 读取后端配置
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
      }
    } catch (e) {
      console.warn('获取设置失败:', e);
    }
  })();

  chkDebugConsole?.addEventListener('change', async (e) => {
    try {
      const currentClose = Array.from(radioCloseActions).find(r => r.checked)?.value || 'hide_to_tray';
      await invokeTauri('save_app_settings', {
        settings: {
          close_action: currentClose,
          auto_start_proxy: false,
          show_debug_console: e.target.checked
        }
      });
      showToast(e.target.checked ? '已启用：启动服务时显示外部 CMD 调试窗口' : '已恢复默认：静默后台启动（无黑框）', 'success');
    } catch (err) {
      showToast(`保存设置失败: ${err.message || err}`, 'error');
    }
  });

  radioCloseActions.forEach(r => {
    r.addEventListener('change', async () => {
      if (r.checked) {
        try {
          await invokeTauri('save_app_settings', {
            settings: {
              close_action: r.value,
              auto_start_proxy: false,
              show_debug_console: chkDebugConsole ? chkDebugConsole.checked : false
            }
          });
          showToast(r.value === 'hide_to_tray' ? '已设置为：关闭窗口时最小化到系统托盘' : '已设置为：关闭窗口时停止服务并退出', 'success');
        } catch (e) {
          showToast(`保存设置失败: ${e.message || e}`, 'error');
        }
      }
    });
  });

  btnSave?.addEventListener('click', () => {
    const val = parseInt(inputPort.value, 10);
    if (val >= 1024 && val <= 65535) {
      state.port = val;
      document.getElementById('dash-port').textContent = val;
      document.getElementById('side-port-badge').textContent = `:${val}`;
      document.getElementById('endpoint-url').value = `http://127.0.0.1:${val}/v1`;
      showToast(`端口已保存为 ${val}，请重启服务生效`, 'info');
    } else {
      showToast('端口范围必须在 1024-65535 之间', 'error');
    }
  });

  chkDesensitize?.addEventListener('change', (e) => {
    state.desensitize = e.target.checked;
    const txt = document.getElementById('dash-desensitize');
    if (txt) {
      txt.textContent = state.desensitize ? '已启用' : '已禁用';
      txt.className = state.desensitize ? 'metric-value text-success' : 'metric-value muted';
    }
  });
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

  // 处于 logs 标签页时定时拉取
  setInterval(() => {
    if (state.currentTab === 'logs') {
      loadLogs();
    }
  }, 2000);
}

// ---------------------------------------------------------------------------
// 初始化入口
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  // 环境检测
  if (!window.__TAURI__) {
    document.getElementById('env-banner')?.classList.remove('hidden');
  }

  initTabs();
  initServiceControls();
  initTestChat();
  initAgentActions();
  initOAuth();
  initModelsAndCopy();
  initSettings();
  initLogs();

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
