/**
 * 页面与选项卡切换
 * 允许 import 各功能模块的 loader 函数；反向依赖（功能模块 import 本模块）禁止，
 * 需要「跳转 Tab」时沿用 `document.querySelector('.nav-item[data-tab=...]').click()` 的 DOM 方式。
 */

import { state } from './state.js';
import { checkHealth } from './service.js';
import { loadAccountsData } from './accounts.js';
import { loadAgentsStatus } from './agents.js';
import { loadModelsMatrix } from './models.js';
import { loadLogs } from './logs.js';
import { loadUsageData } from './usage.js';

export function initTabs() {
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
    usage: { title: '用量统计', desc: '本地请求统计与 48 小时趋势（数据自本版本起记录）' },
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
      if (tab === 'usage') loadUsageData();
    });
  });

  // 跨页面快速跳转按钮
  document.getElementById('btn-goto-oauth')?.addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="oauth"]')?.click();
  });
}
