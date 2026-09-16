/**
 * 应用更新：检测（GitHub commit 比对）+ 交接式自动更新
 *
 * 检测口径对齐 Hermes Desktop：
 *   - 被动查询 GitHub API 比对远端分支 tip SHA 与本机 HEAD，不做 git fetch 轮询；
 *   - 有更新时用 compare 返回的 commit 列表构建分组变更清单；
 *   - 检测失败不打断流程，只落可辨识的失败态（入口 title + 弹窗内可重试）。
 *
 * 本项目不使用 GitHub Release 发版，因此「立即更新」不是下载安装包，而是
 * 退出 GUI → 更新脚本快进源码 + 重建 → 自动拉起新版本
 * （见 scripts/app-update/windows.ps1）。
 */

import { showToast, copyToClipboard, invokeTauri } from './utils.js';
import { buildCommitChangelog, totalItems } from './commit-changelog.js';

let updateInfo = null; // 最近一次 check_app_update 的完整结果

function el(id) {
  return document.getElementById(id);
}

// ---------------------------------------------------------------------------
// 弹窗视图切换
// ---------------------------------------------------------------------------

function showView(name) {
  const views = {
    status: 'update-status-view',
    available: 'update-available-view',
    applying: 'update-applying-view',
  };
  for (const [key, id] of Object.entries(views)) {
    const node = el(id);
    if (node) node.hidden = key !== name;
  }
  // 「正在更新」视图不允许关闭：更新已在路上，留着关闭入口只会让用户以为能取消
  const close = el('update-close');
  if (close) close.hidden = name === 'applying';
  // 离开 applying 视图时必须停掉轮询，否则后台一直打 IPC
  if (name !== 'applying') stopUpdatePolling();
}

function renderStatus({ title, body, detail = '', action = null, icon = 'i' }) {
  showView('status');
  const iconEl = el('update-status-icon');
  if (iconEl) iconEl.textContent = icon;
  const titleEl = el('update-status-title');
  if (titleEl) titleEl.textContent = title;
  const bodyEl = el('update-status-body');
  if (bodyEl) bodyEl.textContent = body ?? '';
  const detailEl = el('update-status-detail');
  if (detailEl) {
    detailEl.textContent = detail;
    detailEl.hidden = !detail;
  }
  const actionEl = el('update-status-action');
  if (actionEl) {
    if (action) {
      actionEl.textContent = action.label;
      actionEl.hidden = false;
      actionEl.onclick = action.onClick;
    } else {
      actionEl.hidden = true;
      actionEl.onclick = null;
    }
  }
}

function renderAvailable(info) {
  showView('available');

  const behind = info.behind ?? 0;
  const titleEl = el('update-title');
  const bodyEl = el('update-subtitle');
  if (titleEl) {
    titleEl.textContent = behind > 0 ? `有可用更新（落后 ${behind} 个提交）` : '有可用更新';
  }
  if (bodyEl) {
    bodyEl.textContent = info.dirty
      ? '新版 WorkBuddy2API 已可安装。检测到工作区有未提交改动，更新程序会先自动 stash 保存。'
      : '新版 WorkBuddy2API 已可安装。';
  }

  const changelog = el('update-changelog');
  const moreEl = el('update-more');
  if (!changelog) return;

  const groups = buildCommitChangelog(info.commits ?? []);
  changelog.replaceChildren();
  for (const group of groups) {
    const wrap = document.createElement('div');

    const label = document.createElement('p');
    label.className = 'update-group-label';
    label.textContent = group.label;

    const list = document.createElement('ul');
    list.className = 'update-group-list';
    for (const item of group.items) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      // textContent：commit 标题来自远端仓库，绝不能当 HTML 注入
      span.textContent = item;
      li.appendChild(span);
      list.appendChild(li);
    }

    wrap.append(label, list);
    changelog.appendChild(wrap);
  }

  if (moreEl) {
    // 只展示了部分 commit：如实说明还有多少没列出，而不是假装这就是全部
    const remaining = Math.max(0, behind - totalItems(groups));
    if (remaining > 0) {
      moreEl.textContent = `另有 ${remaining} 项更改。`;
      moreEl.hidden = false;
    } else {
      moreEl.hidden = true;
    }
  }
}

function openOverlay() {
  el('update-overlay')?.removeAttribute('hidden');
}

function closeOverlay() {
  el('update-overlay')?.setAttribute('hidden', '');
}

// ---------------------------------------------------------------------------
// 检测
// ---------------------------------------------------------------------------

/** 依据检测结果渲染弹窗内容（检测与渲染分离，便于「重试」复用）。 */
function renderResult(info) {
  if (!info) {
    renderStatus({
      title: '无法检查更新',
      body: '未能取得更新信息，请检查网络或代理设置后重试。',
      icon: '!',
      action: { label: '重试', onClick: () => runCheck({ silent: false, force: true }) },
    });
    return;
  }

  if (!info.supported) {
    renderStatus({
      title: '更新不可用',
      body: info.message || '此安装方式无法在应用内自更新。',
      detail: info.reason === 'not-a-git-checkout' ? `安装目录：${info.update_root || '未知'}` : '',
      icon: '!',
    });
    return;
  }

  if (info.error) {
    renderStatus({
      title: '无法检查更新',
      body: '请检查网络连接后重试。',
      detail: info.error,
      icon: '!',
      action: { label: '重试', onClick: () => runCheck({ silent: false, force: true }) },
    });
    return;
  }

  if (!info.update_available) {
    const sha = (info.current_sha || '').slice(0, 7);
    renderStatus({
      title: '已是最新',
      body: `你正在运行最新版本（${info.branch}${sha ? ' · ' + sha : ''}）。`,
      icon: '✓',
    });
    return;
  }

  renderAvailable(info);
}

async function runCheck({ silent = true, force = false } = {}) {
  const entry = el('update-entry');
  const dot = el('update-dot');
  const text = el('update-entry-text');

  if (!silent) {
    openOverlay();
    renderStatus({ title: '正在检查更新…', body: '正在比对 GitHub 上的最新提交。', icon: '◐' });
  }

  try {
    const info = await invokeTauri('check_app_update', { force });
    updateInfo = info;

    // 侧栏入口状态：有更新点亮圆点并改文案，不开弹窗也能看见
    if (info?.update_available) {
      if (dot) dot.hidden = false;
      if (text) text.textContent = `新版本可用（落后 ${info.behind ?? '若干'}）`;
      if (entry) entry.title = '发现新版本，点击查看更新详情';
    } else {
      if (dot) dot.hidden = true;
      if (text) text.textContent = '检查更新';
      if (entry) {
        const sha = (info?.current_sha || '').slice(0, 7);
        entry.title = info?.error
          ? `检查失败：${info.error}（点击重试）`
          : `当前已是最新版本${sha ? '（' + sha + '）' : ''}`;
      }
    }

    // 静默检查（启动后自动跑）发现更新：只提示不打扰 —— 点开弹窗时会现场重新渲染。
    // 注意不能在静默路径里渲染弹窗内容：弹窗此时是隐藏的，渲染了用户也看不到。
    if (silent) {
      if (info?.update_available) {
        showToast(
          `发现新版本（落后 ${info.behind ?? '若干'} 个提交），点击侧栏「检查更新」查看详情`,
          'info'
        );
      }
    } else {
      renderResult(info);
    }
    return info;
  } catch (e) {
    // 静默检查抛错时同样要落失败态：否则入口 title 停在初始「检查更新」，
    // 用户无法区分「从未检查」与「检查失败（可点击重试）」。
    updateInfo = null;
    if (dot) dot.hidden = true;
    if (text) text.textContent = '检查更新';
    if (entry) entry.title = `检查失败：${e?.message || e}（点击重试）`;
    if (!silent) {
      renderResult(null);
      showToast(`检查更新失败: ${e?.message || e}`, 'error');
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 应用更新
// ---------------------------------------------------------------------------

// 阶段顺序须与 index.html 的 #update-steps 及脚本 Write-State 的 phase 取值一致
const UPDATE_PHASES = [
  'preparing', 'fetching', 'merging', 'deps',
  'frontend', 'building', 'verifying', 'restarting',
];

// 失败分类 → 用户能据以行动的一句话（与脚本 Throw-Failure 的 kind 对应）
const FAILURE_HINTS = {
  'not-a-git-checkout': '当前安装目录不是 git 检出，无法自动更新。',
  'gui-exit-timeout': '应用未能在预期时间内退出，更新已中止。',
  'fetch-failed': '网络或代理不可用，无法获取远端提交。可检查代理后重试。',
  diverged: '本地存在未推送的提交，与远端分叉。请先手动处理分叉再更新。',
  'stash-failed': '工作区改动未能安全保存，为避免丢失已中止更新。',
  'deps-failed': '依赖安装失败，通常是网络问题。可检查代理后重试。',
  'frontend-build-failed': '前端构建失败，代码可能存在问题。',
  'rust-build-failed': 'Rust 编译失败，代码可能存在问题。',
  'artifact-missing': '构建未产出可执行文件，已拒绝使用。',
  'artifact-suspicious': '构建产物异常（疑似未内嵌前端），已拒绝使用。',
  'startup-unhealthy': '新版本启动后服务不可用，已回滚到更新前的版本。',
  unknown: '请查看更新日志了解详情。',
};

let updatePollTimer = null;

/** 渲染阶段步骤条：已完成打勾、进行中高亮、失败标红。 */
function renderSteps(phase, failed = false) {
  const list = el('update-steps');
  if (!list) return;
  const idx = UPDATE_PHASES.indexOf(phase);
  for (const li of list.querySelectorAll('li')) {
    li.classList.remove('is-done', 'is-active', 'is-failed');
    const step = li.dataset.step;
    const stepIdx = UPDATE_PHASES.indexOf(step);
    if (failed) {
      // 失败时：失败点标红，之前的算完成，之后的保持待办
      if (stepIdx === idx) li.classList.add('is-failed');
      else if (idx >= 0 && stepIdx < idx) li.classList.add('is-done');
      continue;
    }
    if (stepIdx < idx) li.classList.add('is-done');
    else if (stepIdx === idx) li.classList.add('is-active');
  }
  // done 时全部打勾
  if (phase === 'done') {
    for (const li of list.querySelectorAll('li')) {
      li.classList.remove('is-active', 'is-failed');
      li.classList.add('is-done');
    }
  }
}

function setApplyingText(message) {
  const msgEl = el('update-applying-message');
  if (msgEl && message) msgEl.textContent = message;
}

/** 轮询脚本写入的阶段状态，把进度画到弹窗上。 */
function startUpdatePolling() {
  stopUpdatePolling();
  let seenAlive = false;

  updatePollTimer = setInterval(async () => {
    let state = null;
    try {
      state = await invokeTauri('app_update_state');
    } catch {
      // GUI 即将退出时 IPC 可能已经断开，属正常，继续等
      return;
    }
    if (!state || !state.phase) {
      // 状态文件尚未出现（脚本刚启动）；此前若已见过状态又消失，说明脚本重启了
      if (seenAlive) startUpdatePolling();
      return;
    }
    seenAlive = true;

    const phase = state.phase;
    setApplyingText(state.message || '正在更新…');

    if (phase === 'failed') {
      stopUpdatePolling();
      const hint = FAILURE_HINTS[state.failure_kind] || FAILURE_HINTS.unknown;
      renderSteps(state.failure_kind === 'startup-unhealthy' ? 'restarting' : phase, true);
      const titleEl = el('update-applying-title');
      if (titleEl) titleEl.textContent = '更新失败';
      const iconEl = el('update-applying-view')?.querySelector('.update-status-icon');
      if (iconEl) iconEl.classList.remove('spin');
      const logEl = el('update-applying-log');
      if (logEl) logEl.textContent = [state.detail, hint].filter(Boolean).join('\n');
      // 失败后允许关闭，并提示可重试
      const close = el('update-close');
      if (close) close.hidden = false;
      const hintEl = el('update-applying-hint');
      if (hintEl) hintEl.textContent = '可关闭本窗口后重新检查更新。';
      return;
    }

    renderSteps(phase, false);

    if (phase === 'done') {
      // 脚本会拉起新 GUI；本进程仍在时如实告知，用户可自行关闭
      stopUpdatePolling();
      const titleEl = el('update-applying-title');
      if (titleEl) titleEl.textContent = '更新完成';
      const iconEl = el('update-applying-view')?.querySelector('.update-status-icon');
      if (iconEl) iconEl.classList.remove('spin');
    }
  }, 1000);
}

function stopUpdatePolling() {
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

async function applyUpdate() {
  showView('applying');
  renderSteps('preparing', false);
  const logEl = el('update-applying-log');
  if (logEl) logEl.textContent = '';
  const hintEl = el('update-applying-hint');
  if (hintEl) hintEl.textContent = '更新期间请勿手动启动应用；更新完成后会自动重新打开。';

  try {
    // 该命令启动分离的更新进程后会让 GUI 退出，因此 await 很可能拿不到返回值 ——
    // 那是预期行为，不是失败。启动轮询以显示脚本写入的真实进度。
    const msg = await invokeTauri('apply_app_update');
    if (logEl && msg) logEl.textContent = msg;
    startUpdatePolling();
  } catch (e) {
    // 启动更新失败才是真失败：退回状态视图并给出可操作提示
    stopUpdatePolling();
    const detail = e?.message || String(e);
    renderStatus({
      title: '更新启动失败',
      body: '无法启动更新程序，请确认工作区完整（含 scripts/app-update/windows.ps1）后重试。',
      detail,
      icon: '!',
      action: { label: '重试', onClick: () => applyUpdate() },
    });
    showToast(`更新启动失败: ${detail}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

export function initUpdateCheck() {
  // 绑定版本与构建指纹展示（形态与 Hermes 一致：v0.2.1 d1cb787）
  const verEl = el('app-ver');
  if (verEl) {
    const ver = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.2.1';
    const hash = typeof __GIT_HASH__ !== 'undefined' ? __GIT_HASH__ : '';
    const fp = typeof __BUILD_FINGERPRINT__ !== 'undefined' ? __BUILD_FINGERPRINT__ : `v${ver}`;
    // 行内直接显示「版本 + 构建提交」：当前跑的是哪个提交必须一眼可见，
    // 否则用户无法判断「界面上的版本」与「实际运行的产物」是否一致。
    verEl.textContent = hash ? `v${ver} ${hash}` : `v${ver}`;
    verEl.title = `构建指纹: ${fp}\n点击可复制版本信息`;
    verEl.style.cursor = 'pointer';
    verEl.addEventListener('click', () => {
      copyToClipboard(fp);
      showToast(`已复制版本指纹: ${fp}`, 'info');
    });
  }

  const entry = el('update-entry');
  if (!entry) return;

  // 入口点击：一律打开弹窗并现场检查（不再跳转发布页——本项目不用 Release 发版）
  const onClick = () => {
    openOverlay();
    runCheck({ silent: false, force: false });
  };
  entry.addEventListener('click', onClick);
  entry.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  });

  // 弹窗交互
  el('update-close')?.addEventListener('click', closeOverlay);
  el('update-later')?.addEventListener('click', closeOverlay);
  el('update-now')?.addEventListener('click', () => applyUpdate());

  // 点遮罩关闭（与 confirm 弹窗一致），但「正在更新」期间不允许
  const overlay = el('update-overlay');
  overlay?.addEventListener('click', (e) => {
    if (e.target !== overlay) return;
    if (!el('update-applying-view')?.hidden) return;
    closeOverlay();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !overlay || overlay.hidden) return;
    if (!el('update-applying-view')?.hidden) return;
    closeOverlay();
  });

  // 启动后延迟静默检查一次（避开启动初期的健康检查高峰）；
  // 24h TTL 缓存由 Rust 侧持有，重复启动不会反复打 GitHub API。
  setTimeout(() => runCheck({ silent: true }), 1500);

  // 接续未完成的更新：若上次更新仍在进行（GUI 曾崩溃重启 / 用户重开应用），
  // 直接把弹窗切到进度视图继续显示，否则用户会以为更新丢了而重复点击。
  setTimeout(() => resumeInFlightUpdate(), 800);
}

async function resumeInFlightUpdate() {
  let state = null;
  try {
    state = await invokeTauri('app_update_state');
  } catch {
    return;
  }
  if (!state?.phase) return;
  if (!['preparing', 'fetching', 'merging', 'deps', 'frontend', 'building', 'verifying', 'restarting', 'rolling-back'].includes(state.phase)) {
    return;
  }
  openOverlay();
  showView('applying');
  renderSteps(state.phase, false);
  setApplyingText(state.message || '正在更新…');
  startUpdatePolling();
}
