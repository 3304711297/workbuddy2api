/**
 * 账号与资产管理 (核心：内嵌积分、多账号管理)
 * 说明：「刷新积分」按钮原 inline onclick 引用模块作用域函数（点击必抛错），
 * 已改 id 监听修复；保留的 `.nav-item[data-tab=...]` DOM click 跳转走全局 querySelector，行为正常。
 */

import { state } from './state.js';
import { esc, showToast, showConfirm, invokeTauri } from './utils.js';
import { checkHealth } from './service.js';

// 频率限制状态数据获取：优先 Tauri command（绕过 CSP connect-src 限制），
// 老版构建无该 command 或内核无该端点时返回 null（前端降级隐藏该卡片）。
async function fetchRateLimit() {
  try {
    return await invokeTauri('proxy_rate_limit', { port: state.port });
  } catch {
    return null;
  }
}

// 把 /api/rate_limit 载荷渲染成内嵌 HTML；rl=null 或 models 为空时返回空串。
function renderRateLimitCard(rl, activeModel) {
  if (!rl || !rl.models) return '';
  const models = Object.entries(rl.models);
  if (models.length === 0) return '';

  const rows = models.map(([model, e]) => {
    const limited = e.state === 'limited';
    const dot = limited
      ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--danger);margin-right:6px;animation:pulse-dot 1.2s ease-in-out infinite;"></span>'
      : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--success);margin-right:6px;"></span>';
    const status = limited
      ? `<strong style="color:var(--danger);">已触发 · 冷却中</strong> <span class="mono">⏳ ${esc(fmtCooldown(e.remainingSec))}</span> <small class="muted mono">@${esc(e.resetLocal || '')}</small>`
      : `<strong style="color:var(--success);">正常</strong> <small class="muted mono">(冷却已于 ${esc(e.resetLocal || '')} 结束)</small>`;
    const badge = model === activeModel ? '<span class="badge badge-info" style="font-size:10px;margin-left:6px;">当前会话</span>' : '';
    return `<div class="pkg-item" title="${esc(e.message || '腾讯上游 code 6004 频率限制')}">${dot}<span class="mono">${esc(model)}</span>${badge}<span>${status}</span></div>`;
  }).join('');

  const ru = rl.rollingUsage || {};
  const usageRows = Object.entries(ru).map(([model, u]) =>
    `<div class="pkg-item"><span class="mono muted">${esc(model)} · 近5h</span><span><strong>${u.reqs5h ?? 0}</strong> 次 / <strong>${((u.tokens5h || 0) / 1e6).toFixed(2)}M</strong> tokens${u.err429_5h ? ` <small style="color:var(--danger);">429×${u.err429_5h}</small>` : ''}</span></div>`
  ).join('');

  return `
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
        <span style="font-size:12px;color:var(--text-secondary);">上游频率限制（腾讯 code 6004）</span>
        <span class="muted" style="font-size:10px;">无固定公开阈值 · 仅报实测值</span>
      </div>
      ${rows}
      ${usageRows ? `<div style="margin-top:6px;">${usageRows}</div>` : ''}
    </div>
  `;
}

function fmtCooldown(sec) {
  if (sec == null) return '--';
  if (sec <= 0) return '已恢复';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(sec % 60).padStart(2, '0')}s`;
}

export async function loadAccountsData() {
  const container = document.getElementById('active-account-container');
  const listEl = document.getElementById('accounts-list');
  container.innerHTML = `<div class="card" style="padding: 24px; text-align: center;"><span class="spinner"></span> 正在同步账号与资产数据...</div>`;

  try {
    const [accounts, usage, rateLimit] = await Promise.allSettled([
      invokeTauri('accounts_list'),
      invokeTauri('usage_query'),
      fetchRateLimit()
    ]);

    const acctList = accounts.status === 'fulfilled' ? accounts.value : [];
    const usageData = usage.status === 'fulfilled' ? usage.value : null;
    const rateLimitData = rateLimit.status === 'fulfilled' ? rateLimit.value : null;
    state.accountsList = acctList;

    renderActiveAccountAndUsage(acctList.find(a => a.is_active) || acctList[0], usageData, rateLimitData);
    renderAccountsGrid(acctList);
  } catch (e) {
    container.innerHTML = `<div class="card" style="color: var(--danger);">加载失败: ${esc(e.message || e)}</div>`;
  }
}

function renderActiveAccountAndUsage(acct, usage, rateLimit) {
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
  // 频率限制卡片：仅当反代端点返回了真实 6004 记录时渲染（老版内核/无记录 → 空）
  // 桌面端无「当前测试模型」全局态，rate_limit.models 里的 model 字段即最近被限模型，直接展示不加会话徽标
  const rateLimitHtml = renderRateLimitCard(rateLimit, null);
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
        ${rateLimitHtml}
      </div>
    `;
  } else {
    quotaHtml = `
      <div class="embedded-quota-box" style="text-align: center; padding: 16px;">
        <span class="muted">暂未获取到该账号积分资产</span>
        <button class="btn btn-secondary btn-sm" style="margin-left: 10px;" id="btn-refresh-account-quota">刷新积分</button>
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

  // 事件绑定一律限定在 container 内部实际插入的按钮（避免误绑 usage 模块同名 ID，
  // 且 container.innerHTML 重建后旧监听自然失效，不会随重复加载累积）
  container.querySelector('#btn-refresh-token')?.addEventListener('click', async () => {
    try {
      showToast('正在向腾讯后端刷新 Token...', 'info');
      const res = await invokeTauri('accounts_refresh_token', { uid: acct.uid });
      showToast(res, 'success');
      loadAccountsData();
    } catch (e) {
      showToast(`Token 刷新失败: ${e.message || e}`, 'error');
    }
  });

  container.querySelector('#btn-refresh-account-quota')?.addEventListener('click', () => loadAccountsData());
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
export function initAccountsDelegation() {
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
