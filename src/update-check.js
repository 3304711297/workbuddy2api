/**
 * 更新检查（check_app_update 契约：失败不打断，update_available=false + error）
 */

import { showToast, copyToClipboard, invokeTauri, openExternal } from './utils.js';

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
    // 静默检查（silent=true）抛错时同样要落失败态：否则 entry.title 停在初始「检查更新」，
    // 用户无法区分「从未检查」与「检查失败（可点击重试）」。title 与点击重试链路共用，
    // entry 仍是 div[role=button][tabindex=0]，keydown 处理不受影响。
    updateInfo = null;
    if (dot) dot.hidden = true;
    if (text) text.textContent = '检查更新';
    entry.title = `检查失败：${e?.message || e}（点击重试）`;
    if (!silent) showToast(`检查更新失败: ${e.message || e}`, 'error');
    return null;
  }
}

// 统一走 utils.openExternal（含协议白名单等应用层校验），不再自行调用 shell.open，
// 避免绕过校验且与其它入口行为不一致。
// 契约：openExternal 是 async，成功返回 true、明确失败返回 false（旧实现返回 undefined）；
// 无论返回什么都不得抛错、不得打断用户操作。
async function openReleasePage(url) {
  if (!url) return;
  try {
    const ok = await openExternal(url);
    if (ok === false) {
      // 明确失败（协议非法 / 系统拒绝打开）：降级为复制链接，保证用户仍能拿到发布页
      await copyToClipboard(url);
      showToast('已复制发布页链接', 'info');
    } else {
      showToast('已在浏览器打开发布页', 'success');
    }
  } catch {
    // 容错兜底：openExternal 设计上不抛错，万一抛出也降级为复制链接
    await copyToClipboard(url);
    showToast('已复制发布页链接', 'info');
  }
}

export function initUpdateCheck() {
  // 绑定版本与构建指纹展示
  const verEl = document.getElementById('app-ver');
  if (verEl) {
    const ver = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.2.1';
    const fp = typeof __BUILD_FINGERPRINT__ !== 'undefined' ? __BUILD_FINGERPRINT__ : `v${ver}`;
    verEl.textContent = `v${ver}`;
    verEl.title = `构建指纹: ${fp}\n点击可复制版本信息`;
    verEl.style.cursor = 'pointer';
    verEl.addEventListener('click', () => {
      copyToClipboard(fp);
      showToast(`已复制版本指纹: ${fp}`, 'info');
    });
  }

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
