/**
 * CodeBuddy2OpenAI 前端主交互逻辑 (对标 EasyCLIProxyAPI 标准)
 * 具备：全局状态机、多账号管理、内嵌资产积分渲染、Agent 一键配置、接口连通性测试
 *
 * 本文件是唯一入口：只负责按原顺序装配各功能模块，不承载业务逻辑。
 * 模块划分见同目录各文件；共享状态在 state.js，纯工具在 utils.js。
 */

// 全局错误兜底必须最先 import：模块加载即注册 window error/unhandledrejection 监听（保持原时机语义）
import './error-handler.js';

// 各功能域模块（仅引入 init 函数与入口所需的 loader）
import { initTheme, initSettings } from './settings.js';
import { initTabs } from './tabs.js';
import { initServiceControls, initTestChat, checkHealth } from './service.js';
import { initAgentActions, loadAgentsStatus } from './agents.js';
import { initOAuth } from './oauth.js';
import { initModelsAndCopy, loadModelsMatrix } from './models.js';
import { initLogs } from './logs.js';
import { initUsage } from './usage.js';
import { initUpdateCheck } from './update-check.js';
import { initConfirmDialog } from './utils.js';
import { initAccountsDelegation } from './accounts.js';

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
