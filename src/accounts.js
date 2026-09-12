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
    const expired = e.state === 'expired';
    const dot = limited
      ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--danger);margin-right:6px;animation:pulse-dot 1.2s ease-in-out infinite;"></span>'
      : expired
        ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--warning, #f59e0b);margin-right:6px;"></span>'
        : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--success);margin-right:6px;"></span>';
    const status = limited
      ? `<strong style="color:var(--danger);">已触发 · 冷却中</strong> <span class="mono">⏳ ${esc(fmtCooldown(e.remainingSec))}</span> <small class="muted mono">@${esc(e.resetLocal || '')}</small>`
      : expired
        ? `<strong style="color:var(--warning, #f59e0b);">已恢复</strong> <small class="muted mono">(冷却已于 ${esc(e.resetLocal || '')} 结束)</small>`
        : `<strong style="color:var(--success);">正常</strong>`;
    const badge = model === activeModel ? '<span class="badge badge-info" style="font-size:10px;margin-left:6px;">当前会话</span>' : '';
    return `<div class="pkg-item" title="${esc(e.message || '腾讯上游 code 6004 频率限制')}">${dot}<span class="mono">${esc(model)}</span>${badge}<span>${status}</span></div>`;
  }).join('');

  const ru = rl.rollingUsage || {};
  const usageRows = Object.entries(ru).map(([model, u]) => {
    const hasToday = u.reqsToday !== undefined;
    const reqs = hasToday ? u.reqsToday : (u.reqs5h ?? 0);
    const tokens = hasToday ? (u.tokensToday || 0) : (u.tokens5h || 0);
    const err429 = hasToday ? u.err429_today : u.err429_5h;
    const label = hasToday ? '今日' : '近5h';
    const subNote = hasToday && u.reqs5h !== undefined ? ` <small class="muted mono">(近5h ${u.reqs5h}次)</small>` : '';
    return `<div class="pkg-item"><span class="mono muted">${esc(model)} · ${label}</span><span><strong>${reqs}</strong> 次 / <strong>${(tokens / 1e6).toFixed(2)}M</strong> tokens${err429 ? ` <small style="color:var(--danger);">429×${err429}</small>` : ''}${subNote}</span></div>`;
  }).join('');

  const nightBadge = rl.nightFree
    ? '<span class="badge badge-success" style="font-size:10px;margin-left:6px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);">🌙 夜间限免中 (23:00–08:00)</span>'
    : '<span class="muted mono" style="font-size:10px;">夜间 23:00–08:00 免积分</span>';

  // 临期优先：内核按积分到期日分层调度（先烧快过期额度），到期日应对用户可见
  const soonest = rl.rotation?.soonest_expire_day;
  const expiryTag = soonest
    ? `<span class="badge" style="font-size:10px;margin-left:6px;background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3);" title="按积分到期日分层优先调度，避免临期额度作废">📅 临期优先: ${esc(soonest)}</span>`
    : '';

  // 静默降级感知：requested → actual，纠正「你以为在用的模型 ≠ 实际模型」
  const fallbacks = rl.fallbacks && typeof rl.fallbacks === 'object' ? Object.entries(rl.fallbacks) : [];
  const fallbackRows = fallbacks.map(([requested, ev]) => {
    const isCurrent = requested === activeModel;
    const detail = `${esc(ev.actual || '—')} · 原因 ${esc(ev.reason || 'unknown')} · ${ev.count || 0} 次 · ${esc(ev.lastLocal || '—')}`;
    return `<div class="pkg-item" title="请求 ${esc(requested)} 被上游拒绝后静默降级为 ${esc(ev.actual || '—')}">
      <span style="color:var(--danger);">⚠️ 降级${isCurrent ? '（当前会话）' : ''}</span>
      <span><span class="mono">${esc(requested)}</span> → <span class="mono">${esc(ev.actual || '—')}</span></span>
      <small class="muted mono">${detail}</small>
    </div>`;
  }).join('');

  // 网关能力元数据：内核自曝的协议数 / 413 上限 / 出站 UA
  const srv = rl.server || {};
  const protoCount = Array.isArray(srv.protocols) ? srv.protocols.length : 0;
  const protoLabel = protoCount === 3
    ? 'Chat / Messages / Responses 三协议'
    : protoCount > 0
      ? srv.protocols.map(p => esc(String(p))).join(' / ')
      : '—';
  const serverMeta = (protoCount > 0 || srv.maxBodyMb)
    ? `<div class="pkg-item" title="内核自曝的网关能力元数据">
        <span class="muted mono">网关能力</span>
        <span><strong>${protoLabel}</strong>${srv.maxBodyMb ? ` · 报文上限 ${esc(String(srv.maxBodyMb))}MB` : ''}${srv.userAgent ? ` · <small class="muted mono">${esc(srv.userAgent)}</small>` : ''}</span>
      </div>`
    : '';

  return `
    <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="display:flex;align-items:center;">
          <span style="font-size:12px;color:var(--text-secondary);">上游频率限制（腾讯 code 6004）</span>
          ${expiryTag}
          ${rl.nightFree ? nightBadge : ''}
        </div>
        <span class="muted" style="font-size:10px;">${!rl.nightFree ? nightBadge + ' · ' : ''}无固定公开阈值 · 仅报实测值</span>
      </div>
      ${rows}
      ${fallbackRows ? `<div style="margin-top:6px;">${fallbackRows}</div>` : ''}
      ${usageRows ? `<div style="margin-top:6px;">${usageRows}</div>` : ''}
      ${serverMeta ? `<div style="margin-top:6px;">${serverMeta}</div>` : ''}
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
    renderAccountsGrid(acctList, rateLimitData);
    renderProtocolBadge(rateLimitData);
    await syncRotationPolicyCard(acctList.length);
  } catch (e) {
    container.innerHTML = `<div class="card" style="color: var(--danger);">加载失败: ${esc(e.message || e)}</div>`;
  }
}

// 看板端点卡协议徽章：依据内核自曝的 server.protocols 动态渲染。
// 内核为三协议网关（chat / messages / responses）时明确标注，旧内核缺元数据时保守显示。
function renderProtocolBadge(rateLimit) {
  const badge = document.getElementById('dash-protocol-badge');
  if (!badge) return;
  const protocols = rateLimit?.server?.protocols;
  if (Array.isArray(protocols) && protocols.length >= 3) {
    badge.textContent = '三协议网关';
    badge.className = 'badge badge-valid';
    badge.title = `内核支持：${protocols.join(' / ')}`;
  } else if (Array.isArray(protocols) && protocols.length > 0) {
    badge.textContent = `${protocols.length} 协议`;
    badge.className = 'badge badge-info';
    badge.title = `内核支持：${protocols.join(' / ')}`;
  } else {
    badge.textContent = 'OpenAI 兼容';
    badge.className = 'badge badge-info';
    badge.title = '内核未上报协议元数据（旧版本或服务未启动）';
  }
}

// 读取后端持久化的轮换配置并同步到策略卡（仅用于初始化/保存后回读）
// ⚠️ 此函数会把磁盘值**强制回写**到下拉框，因此绝不能在 change 事件里调用——
// 否则用户刚选中的值会在读盘后被立刻改回旧值（表现为「闪一下就跳回原样」）。
async function syncRotationPolicyCard(accountCount) {
  const select = document.getElementById('select-rotate-mode');
  const countInput = document.getElementById('input-rotate-count');
  if (!select) return;

  try {
    const cfg = await invokeTauri('get_app_settings');
    if (cfg) {
      if (cfg.rotate_mode && ['off', 'failover', 'roundrobin'].includes(cfg.rotate_mode)) {
        select.value = cfg.rotate_mode;
      }
      if (cfg.rotate_count && countInput) {
        countInput.value = String(cfg.rotate_count);
      }
    }
  } catch (e) {
    console.warn('读取轮换配置失败:', e);
  }

  renderRotationPolicyUI(accountCount);
}

// 纯 UI 渲染：依据**当前控件值**刷新徽章与提示文案，不接触磁盘、不改动控件值。
// change 事件、切换账号后刷新都必须走这里。
function renderRotationPolicyUI(accountCount) {
  const badge = document.getElementById('rotation-status-badge');
  const select = document.getElementById('select-rotate-mode');
  const wrapCount = document.getElementById('wrap-rotate-count');
  const hint = document.getElementById('rotation-policy-hint');
  if (!select) return;

  const isMulti = accountCount >= 2;
  const mode = select.value;

  if (badge) {
    if (!isMulti) {
      badge.textContent = '单账号模式';
      badge.className = 'badge badge-info';
    } else if (mode === 'off') {
      badge.textContent = '多账号 · 未启用调度';
      badge.className = 'badge badge-info';
    } else if (mode === 'failover') {
      badge.textContent = `多账号 · 限流避让 (${accountCount} 账号)`;
      badge.className = 'badge badge-valid';
    } else {
      badge.textContent = `多账号 · 负载均衡 (${accountCount} 账号)`;
      badge.className = 'badge badge-valid';
    }
  }

  if (wrapCount) {
    wrapCount.style.display = mode === 'roundrobin' ? 'flex' : 'none';
  }

  if (hint) {
    hint.textContent = !isMulti
      ? '当前仅保存 1 个账号，轮换调度无效（N=1 等价原地不动）。请先在「授权新账号」添加第二个账号后启用。'
      : mode === 'off'
        ? '当前关闭调度，所有请求固定走「当前活跃」账号。切换活跃账号可在下方账号卡片点击「设为活跃」。'
        : mode === 'failover'
          ? '已开启限流避让：当前账号遇到 429/6004 冷却时，内核自动切换至下一个就绪账号并重试，无需手动干预。'
          : '已开启负载均衡：每 N 次请求在就绪账号间轮流调度，分摊单账号频控压力；遭遇限流同样自动故障转移。';
  }
}

// 保存轮换策略：走 save_app_settings
// ⚠️ save_app_settings 是整对象覆盖写盘，因此以读回的配置对象为基底做**浅合并**
// （展开原对象再覆盖 rotate_* 两个字段），这样将来给 AppConfig 加字段也不会漏。
async function saveRotationPolicy() {
  const select = document.getElementById('select-rotate-mode');
  const countInput = document.getElementById('input-rotate-count');
  const btn = document.getElementById('btn-save-rotation');
  if (!select) return;

  const mode = select.value;
  const count = Math.max(1, Math.min(100, parseInt(countInput?.value, 10) || 1));

  if (btn) btn.disabled = true;
  try {
    // 以磁盘真源为基底做浅合并，只改动 rotate_*，其余字段原样保留
    const cfg = (await invokeTauri('get_app_settings')) || {};
    const next = { ...cfg, rotate_mode: mode, rotate_count: count };
    await invokeTauri('save_app_settings', { settings: next });
    // 写盘后立即回读校验，确认确实落盘（而非静默失败）
    const verify = await invokeTauri('get_app_settings');
    if (verify?.rotate_mode !== mode || Number(verify?.rotate_count) !== count) {
      showToast('保存未生效：配置被其他页面覆盖，请重试', 'error');
      await syncRotationPolicyCard(state.accountsList.length);
      return;
    }
    showToast(
      mode === 'off'
        ? '已关闭多账号调度策略（即时生效）'
        : `调度策略已保存：${mode === 'failover' ? '限流自动避让' : '负载均衡轮询'}（即时生效）`,
      'success'
    );
    await syncRotationPolicyCard(state.accountsList.length);
    // 拉一次内核运行时状态，确认热读已生效（config_source=hot 表示无需重启）
    try {
      const rl = await fetchRateLimit();
      const live = rl?.rotation;
      if (live && live.mode) {
        const srcTag = live.config_source === 'hot' ? '内核已热加载' : '内核待刷新';
        const consistent = live.mode === mode;
        showToast(
          consistent
            ? `内核运行态确认：${live.mode} · ${srcTag}`
            : `内核运行态为 ${live.mode}（预期 ${mode}），请检查`,
          consistent ? 'success' : 'warning'
        );
      }
    } catch { /* 反代未启动时静默跳过 */ }
  } catch (e) {
    showToast(`保存失败: ${e.message || e}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
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
            <button class="btn btn-secondary btn-sm" id="btn-daily-checkin" style="margin-left: 10px;">🎁 每日签到</button>
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

  // 每日签到按钮：走 Tauri command 转发到反代 /api/checkin/claim（绕开 CSP connect-src）；
  // 内核负责注入 X-Device-Token，与桌面端行为一致
  container.querySelector('#btn-daily-checkin')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '签到中...';
    try {
      const data = await invokeTauri('proxy_checkin_claim', { port: state.port });
      if (data.ok) {
        showToast(`✅ 签到成功：+${data.credit ?? 0} 积分${data.streak_days ? `（连续 ${data.streak_days} 天）` : ''}`, 'success');
      } else if (data.status === 'already_claimed') {
        showToast('今日已签到，明天再来', 'info');
      } else if (data.status === 'event_ended') {
        showToast('签到活动已结束', 'warning');
      } else if (data.status === 'not_eligible') {
        showToast('当前账号无签到资格', 'warning');
      } else {
        showToast(`签到失败: ${data.error || data.msg || '未知错误'}`, 'error');
      }
    } catch (err) {
      showToast(`签到请求失败: ${err.message || err}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🎁 每日签到';
    }
  });
}

// 账号卡片渲染：携带轮换调度状态（活跃 / 就绪 / 冷却中）
function renderAccountsGrid(list, rateLimit) {
  const grid = document.getElementById('accounts-list');
  if (!grid) return;

  if (list.length === 0) {
    grid.innerHTML = `<p class="muted">暂无更多已保存账号</p>`;
    return;
  }

  // 冷却模型列表（state==='limited' 且属该账号时视为冷却中）——按账号名匹配有限，
  // 这里统一按「全局存在 6004 冷却记录」提示，避免多账号下错误归因
  const limitedModels = rateLimit && rateLimit.models
    ? Object.entries(rateLimit.models).filter(([, e]) => e.state === 'limited').map(([m]) => m)
    : [];
  const coolingTip = limitedModels.length > 0
    ? `<div class="muted" style="font-size:10px; margin-top:4px;">⏳ 上游冷却模型: ${esc(limitedModels.slice(0, 3).join(', '))}${limitedModels.length > 3 ? ` 等 ${limitedModels.length} 个` : ''}</div>`
    : '';

  const multi = list.length >= 2;

  grid.innerHTML = list.map(a => `
    <div class="account-item-card ${a.is_active ? 'is-active' : ''}">
      <div class="account-item-header">
        <strong>${esc(a.nickname || '未命名')}</strong>
        ${a.is_active
          ? `<span class="badge badge-running">${multi ? '● 活跃中' : '使用中'}</span>`
          : `<span class="badge badge-info">${a.token_expired ? '已过期' : '○ 待机就绪'}</span>`}
      </div>
      <div class="mono muted" style="font-size: 11px;">${esc(a.uid)}</div>
      <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; margin-top: 4px;">
        <span class="${a.token_expired ? 'text-danger' : 'text-success'}">${a.token_expired ? '凭据已过期' : '凭据有效'}</span>
        <span style="display: flex; gap: 6px;">
          ${!a.is_active ? `<button class="btn btn-secondary btn-sm" data-act="switch" data-uid="${esc(a.uid)}" style="padding: 2px 6px;">设为活跃</button>` : ''}
          ${!a.is_active ? `<button class="btn btn-danger btn-sm" data-act="delete" data-uid="${esc(a.uid)}" style="padding: 2px 6px;">删除</button>` : ''}
        </span>
      </div>
      ${a.is_active ? coolingTip : ''}
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

// 多账号调度策略卡：下拉切换与保存
export function initRotationPolicy() {
  const select = document.getElementById('select-rotate-mode');
  const saveBtn = document.getElementById('btn-save-rotation');
  if (!select) return;
  // 切换模式时只刷新 UI（纯渲染），绝不回读磁盘覆盖用户刚选的值
  select.addEventListener('change', () => renderRotationPolicyUI(state.accountsList?.length || 0));
  saveBtn?.addEventListener('click', saveRotationPolicy);
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
