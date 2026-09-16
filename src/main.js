/**
 * WorkBuddy2API 前端主交互逻辑 (对标 EasyCLIProxyAPI 标准)
 * 具备：全局状态机、多账号管理、内嵌资产积分渲染、Agent 接入引导、接口连通性测试
 *
 * 本文件是唯一入口：只负责按原顺序装配各功能模块，不承载业务逻辑。
 * 模块划分见同目录各文件；共享状态在 state.js，纯工具在 utils.js。
 */

// 全局错误兜底必须最先 import：模块加载即注册 window error/unhandledrejection 监听（保持原时机语义）
import './error-handler.js';

// 各功能域模块（仅引入 init 函数与入口所需的 loader）
import { state } from './state.js';
import { initTheme, initSettings } from './settings.js';
import { initTabs } from './tabs.js';
import { initServiceControls, initTestChat, checkHealth } from './service.js';
import { initAgentActions, loadAgentsStatus } from './agents.js';
import { initOAuth } from './oauth.js';
import { initModelsAndCopy, loadModelsMatrix } from './models.js';
import { initLogs } from './logs.js';
import { initDebug } from './debug.js';
import { initUsage } from './usage.js';
import { initUpdateCheck } from './update-check.js';
import { initConfirmDialog } from './utils.js';
import { initAccountsDelegation, initRotationPolicy } from './accounts.js';

// ---------------------------------------------------------------------------
// 健康轮询调度（T4）
// ---------------------------------------------------------------------------
// 上一次检查是否仍在途：proxy_health 上游超时 10s，而定时器每 3s 触发一次，
// 无守卫时最多积压 4 个重叠请求，故「上一次未返回就跳过本轮」。
let healthPending = false;

async function pollHealth() {
  if (healthPending) return;
  healthPending = true;
  try {
    await checkHealth();
  } finally {
    healthPending = false;
  }
}

// 起表/停表成对：句柄存 state.healthTimer，避免重复起表导致双倍轮询；
// 窗口不可见时不起表（应用从托盘静默启动时，不该在隐藏状态空转）
function startHealthPolling() {
  if (document.visibilityState === 'hidden') return;
  if (state.healthTimer) return;
  state.healthTimer = setInterval(pollHealth, 3000);
}

// 窗口隐藏时停表：默认关闭行为是 hide_to_tray，隐藏后仍 7×24 轮询纯属空转
// （≈28,800 次/天 IPC+HTTP），恢复可见时再起表并立即补一次检测。
function stopHealthPolling() {
  if (!state.healthTimer) return;
  clearInterval(state.healthTimer);
  state.healthTimer = null;
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
  initDebug();
  initUsage();
  initUpdateCheck();
  initConfirmDialog();
  initAccountsDelegation();
  initRotationPolicy();

  // 监听 Tauri 事件广播（托盘启动/停止/重启时即时响应）
  if (window.__TAURI__?.event?.listen) {
    try {
      const ret = window.__TAURI__.event.listen('proxy-status-changed', () => {
        setTimeout(checkHealth, 200);
        setTimeout(checkHealth, 800);
      });
      // listen 返回 Promise，必须吞掉 rejection：否则冒到 error-handler.js 的
      // unhandledrejection，开机即弹整屏「应用发生未捕获错误」模态（与主题同步同款处理）
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch (e) {
      // 事件通道不可用时静默降级：3s 轮询仍在兜底状态刷新
    }
  }

  // 窗口获取焦点时立即检测（用户从托盘切回控制台瞬间刷新）
  window.addEventListener('focus', checkHealth);
  // 可见性变化：隐藏时停表、可见时起表并立即补一次检测
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkHealth();
      startHealthPolling();
    } else {
      stopHealthPolling();
    }
  });

  // 默认启动检测健康（缩短为 3 秒轻量轮询，带 in-flight 守卫与隐藏暂停）
  checkHealth();
  loadAgentsStatus();
  loadModelsMatrix();
  startHealthPolling();
});
