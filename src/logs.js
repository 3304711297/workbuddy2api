/**
 * 实时运行日志 (Logs)
 */

import { state } from './state.js';
import { showToast, invokeTauri } from './utils.js';

let logInterval = null;

export async function loadLogs() {
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

export function initLogs() {
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
