/**
 * 更新检查（check_app_update 契约：失败不打断，update_available=false + error）
 */

import { showToast, copyToClipboard, invokeTauri } from './utils.js';

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

export function initUpdateCheck() {
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
