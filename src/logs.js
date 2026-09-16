/**
 * 实时运行日志 (Logs)
 */

import { state } from './state.js';
import { showToast, invokeTauri, showConfirm } from './utils.js';

let logInterval = null;

// 自动滚动开关（#log-auto-scroll 按钮）：
// true = 贴底跟随（默认）；false = 用户暂停。用户向上翻看时自动置 false，
// 点按钮可强制恢复——否则 2s 轮询会把正在回溯报错的人反复拉回底部。
let autoScroll = true;

// 同步开关按钮的 aria-pressed 与文案（无障碍状态与视觉状态必须一致）
function syncAutoScrollBtn() {
  const btn = document.getElementById('log-auto-scroll');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(autoScroll));
  btn.textContent = autoScroll ? '自动同步中 (每 2 秒)' : '已暂停自动滚动';
}

// 返回 true=本次拉取成功，false=失败（失败时面板内已写入错误文本）。
// tabs.js 也在调用本函数，它不消费返回值，故签名扩展不影响那里。
export async function loadLogs() {
  const viewer = document.getElementById('log-viewer');
  if (!viewer) return false;
  try {
    const raw = await invokeTauri('proxy_get_logs');
    // 贴底判断必须在替换 textContent 之前测量：替换后 scrollHeight 已是新内容高度，
    // 旧内容的滚动位置会被误判为贴底。阈值 8px 容忍滚动/行高的小数误差。
    const nearBottom = viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 8;
    // 用户主动上滚即自动暂停跟随，翻看历史不再被打断；贴底阅读时保持跟随
    if (!nearBottom) autoScroll = false;
    viewer.textContent = raw || '（暂无日志输出）';
    if (autoScroll) viewer.scrollTop = viewer.scrollHeight;
    syncAutoScrollBtn();
    return true;
  } catch (e) {
    viewer.textContent = `获取日志失败: ${e.message || e}`;
    return false;
  }
}

export function initLogs() {
  const btnRefresh = document.getElementById('btn-refresh-logs');
  const btnClear = document.getElementById('btn-clear-logs');
  const btnOpenDir = document.getElementById('btn-open-logs-dir');
  const btnAutoScroll = document.getElementById('log-auto-scroll');

  btnRefresh?.addEventListener('click', async () => {
    // 慢请求期间禁用按钮防连点；提示必须等结果出来再给——
    // 无条件弹「日志已刷新」会在失败时与面板里的「获取日志失败」自相矛盾。
    btnRefresh.disabled = true;
    try {
      const ok = await loadLogs();
      showToast(ok ? '日志已刷新' : '日志刷新失败，请查看面板提示', ok ? 'info' : 'error');
    } finally {
      btnRefresh.disabled = false;
    }
  });

  btnClear?.addEventListener('click', async () => {
    // 破坏性操作与同级「清空快照」保持一致的保护：日志是排障的唯一证据链，
    // 误点即不可恢复，故先确认再执行。
    const ok = await showConfirm({
      title: '清空日志',
      message: '将删除全部本地日志，不可恢复。',
      confirmText: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      await invokeTauri('proxy_clear_logs');
      await loadLogs();
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

  // 手动切换自动滚动：暂停后不再被轮询拉走，恢复时立即跳到底部
  btnAutoScroll?.addEventListener('click', () => {
    autoScroll = !autoScroll;
    if (autoScroll) {
      const viewer = document.getElementById('log-viewer');
      if (viewer) viewer.scrollTop = viewer.scrollHeight;
    }
    syncAutoScrollBtn();
    showToast(autoScroll ? '已恢复自动滚动' : '已暂停自动滚动，可安心翻看历史', 'info');
  });

  syncAutoScrollBtn();

  // 处于 logs 标签页时定时拉取。
  // 句柄存入模块级 logInterval：既让轮询可控（重复 initLogs 不会叠加定时器），
  // 也让测试能在收尾时 clearInterval —— 无句柄的永久 interval 会挂住事件循环。
  if (logInterval) clearInterval(logInterval);
  logInterval = setInterval(() => {
    if (state.currentTab === 'logs') {
      loadLogs();
    }
  }, 2000);
}

/** 停止日志轮询并释放句柄（供测试收尾与未来「关闭自动刷新」复用） */
export function stopLogsPolling() {
  if (logInterval) {
    clearInterval(logInterval);
    logInterval = null;
  }
}
