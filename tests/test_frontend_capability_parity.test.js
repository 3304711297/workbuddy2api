/**
 * 前端与内核能力对等性契约测试（前端迁移版，2026-09-26）
 *
 * 背景：内核已交付多项能力（三协议网关、临期优先调度、静默降级感知、网关能力元数据、
 * Codex CLI 接入），此前 GUI 未消费，形成「后端已宣称 / 前端没跟上」的信息滞后。
 * 本文件锁定前端必须消费的字段与必须存在的入口，防止再次漂移。
 *
 * 前端迁移说明：旧前端（index.html + src/*.js）已迁移为 React+TS。
 *   - 九页存在性：src/App.tsx 按 tab 渲染九个页面组件，
 *     每个页面文件必须存在且导出对应组件；
 *   - P1「三协议端点卡」：旧 index.html 的 dash-protocol-badge →
 *     DashboardPage 的动态 protocolBadge（三协议就绪/协议检测中，随运行态切换），
 *     不再硬编码「OpenAI 兼容」；
 *   - P1「Codex CLI 引导卡片」：新版 AgentsPage 已移除 Codex/Claude Code 引导
 *     （其文件头注释明确「不含 Claude Code / Codex 引导」），改为 Hermes / ZCode
 *     检测徽章与只读引导卡片。此处断言对等的新能力：AgentsPage 仍消费 agent_detect
 *     并提供 Hermes / ZCode 引导；
 *   - P1「临期优先」/ P2「降级感知」/ P2「网关能力元数据」：迁移至 AccountsPage，
 *     仍消费 rotation.soonest_expire_day / fallbacks / server.protocols / server.maxBodyMb；
 *   - P3「三协议连通性测试」：DashboardPage 的协议选择器 + tauri.ts 的
 *     proxyTestChat(port, protocol, model) + proxy.rs 的协议分发（后端未变）；
 *   - 「高级运行时开关标注」：旧 index.html 的 runtime-advanced-hint 在新版
 *     SettingsPage 中已不存在（高级运行时开关的说明改为各开关下方的 field-hint，
 *     如模型清单模式的「内核热读，保存后无需重启」）。此处断言对等的新形态：
 *     model_list_mode 开关下方有动态说明。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const read = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf-8');

const APP = read('src/App.tsx');
const DASHBOARD = read('src/pages/DashboardPage.tsx');
const ACCOUNTS = read('src/pages/AccountsPage.tsx');
const AGENTS = read('src/pages/AgentsPage.tsx');
const SETTINGS = read('src/pages/SettingsPage.tsx');
const TAURI = read('src/services/tauri.ts');
const PROXY_RS = read('src-tauri/src/commands/proxy.rs');

// ==================== 九页存在性（本轮迁移主断言） ====================

const PAGES = [
  ['dashboard', 'src/pages/DashboardPage.tsx', 'DashboardPage'],
  ['accounts', 'src/pages/AccountsPage.tsx', 'AccountsPage'],
  ['agents', 'src/pages/AgentsPage.tsx', 'AgentsPage'],
  ['models', 'src/pages/ModelsPage.tsx', 'ModelsPage'],
  ['oauth', 'src/pages/OAuthPage.tsx', 'OAuthPage'],
  ['settings', 'src/pages/SettingsPage.tsx', 'SettingsPage'],
  ['logs', 'src/pages/LogsPage.tsx', 'LogsPage'],
  ['usage', 'src/pages/UsagePage.tsx', 'UsagePage'],
  ['debug', 'src/pages/DebugPage.tsx', 'DebugPage'],
];

test('九个页面文件都存在且导出对应组件', () => {
  assert.equal(PAGES.length, 9, '页面清单必须是 9 页');
  for (const [tab, file, comp] of PAGES) {
    const p = path.join(REPO_ROOT, file);
    assert.ok(fs.existsSync(p), `${file} 不存在`);
    const src = read(file);
    assert.ok(
      new RegExp(`export function ${comp}\\b`).test(src),
      `${file} 未导出 ${comp} 组件`
    );
  }
});

test('App 按 tab 渲染九页（无一遗漏、无多余）', () => {
  for (const [tab, , comp] of PAGES) {
    assert.ok(
      APP.includes(`import { ${comp} }`),
      `App 未导入 ${comp}`
    );
    assert.ok(
      new RegExp(`\\{tab === '${tab}' && <${comp} \\/>\\}`).test(APP),
      `App 未在 tab === '${tab}' 时渲染 <${comp} />`
    );
  }
});

// ==================== P1：协议徽章 / Agent 引导 / 临期优先 ====================

test('P1 看板端点卡标注三协议，而非仅 OpenAI 兼容', () => {
  // 三协议端点卡：PROTOCOLS 定义三条端点路径
  for (const p of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
    assert.ok(
      DASHBOARD.includes(p),
      `DashboardPage 的 PROTOCOLS 缺少 ${p}：端点卡未覆盖三协议`
    );
  }
  // 徽章必须随运行态动态渲染（protocolBadge），不得硬编码「OpenAI 兼容」
  assert.ok(
    /const protocolBadge = running/.test(DASHBOARD),
    'DashboardPage 未按运行态动态计算 protocolBadge'
  );
  assert.ok(
    !DASHBOARD.includes('>OpenAI 兼容<') && !DASHBOARD.includes('OpenAI 兼容'),
    'DashboardPage 仍硬编码「OpenAI 兼容」——内核已支持三协议'
  );
});

test('P1 Agent 接入页消费 agent_detect 并提供 Hermes / ZCode 引导', () => {
  // 旧契约的 Codex CLI 引导卡片在新版中已移除（见文件头迁移说明）；
  // 对等的现能力是 Hermes / ZCode 检测徽章 + 只读引导卡片。
  const AGENTS_SVC = read('src/services/agentsService.ts');
  assert.ok(AGENTS_SVC.includes('agentDetect'), 'agentsService 未调用 agent_detect');
  assert.ok(AGENTS.includes('detectAgents'), 'AgentsPage 未经 detectAgents 触发检测');
  assert.ok(AGENTS.includes('hermesBadgeState'), 'AgentsPage 未消费 Hermes 检测徽章状态');
  assert.ok(AGENTS.includes('zcodeBadgeState'), 'AgentsPage 未消费 ZCode 检测徽章状态');
  assert.ok(AGENTS.includes('fetchHermesGuide'), 'AgentsPage 未提供 Hermes 端点引导');
  assert.ok(AGENTS.includes('fetchZcodeGuide'), 'AgentsPage 未提供 ZCode 引导');
  // hermes_proxy_base_url 保持 snake_case（AGENTS.md 锁定，写驼峰会静默 undefined）
  assert.ok(TAURI.includes('hermes_proxy_base_url'), 'tauri.ts 的 AgentDetectResult 丢失 snake_case 的 hermes_proxy_base_url');
  assert.ok(!/hermesProxyBaseUrl/.test(TAURI), 'tauri.ts 误用 camelCase 的 hermesProxyBaseUrl');
});

test('P1 多账号策略卡展示「临期优先」到期日（消费 rotation.soonest_expire_day）', () => {
  assert.ok(
    ACCOUNTS.includes('soonest_expire_day'),
    'AccountsPage 未消费 rotation.soonest_expire_day —— 内核已按到期日分层调度，GUI 应可见'
  );
  assert.ok(
    /临期/.test(ACCOUNTS) || /rateLimitExpiry/.test(ACCOUNTS),
    'AccountsPage 缺少「临期」相关展示'
  );
});

// ==================== P2：降级感知 / 网关能力元数据 ====================

test('P2 GUI 展示静默降级感知（消费 fallbacks 字段）', () => {
  assert.ok(
    ACCOUNTS.includes('fallbacks'),
    'AccountsPage 未消费 fallbacks —— 模型被静默降级时用户应在 GUI 看到'
  );
  // 降级展示走 i18n 键 accounts.fallbackLabel（zh-CN 落到「降级」）
  assert.ok(
    ACCOUNTS.includes('accounts.fallbackLabel'),
    'AccountsPage 缺少降级展示（应渲染 accounts.fallbackLabel）'
  );
  const zh = read('src/i18n/zh-CN.ts');
  assert.ok(
    zh.includes(`'accounts.fallbackLabel': '降级'`),
    'zh-CN 的 accounts.fallbackLabel 不是「降级」'
  );
});

test('P2 GUI 展示网关能力元数据（消费 server.protocols / maxBodyMb）', () => {
  assert.ok(
    ACCOUNTS.includes('protocols'),
    'AccountsPage 未消费 server.protocols'
  );
  assert.ok(
    ACCOUNTS.includes('maxBodyMb'),
    'AccountsPage 未消费 server.maxBodyMb（413 防护上限应对用户可见）'
  );
  assert.ok(
    /srv\.protocols/.test(ACCOUNTS) && /srv\.maxBodyMb/.test(ACCOUNTS),
    'AccountsPage 未从 server 元数据读取 protocols / maxBodyMb'
  );
});

// ==================== P3：三协议连通性测试 ====================

test('P3 连通性测试支持三种协议（前端入口 + 内核分发）', () => {
  // 前端：协议选择器（旧 select-test-protocol 的同等语义：select 绑定 protocol state）
  assert.ok(
    /value=\{protocol\}/.test(DASHBOARD) && /setProtocol\(e\.target\.value/.test(DASHBOARD),
    'DashboardPage 缺少测试协议选择器（应绑定 protocol state）'
  );
  assert.ok(
    /type TestProtocol = 'chat' \| 'messages' \| 'responses'/.test(DASHBOARD),
    'DashboardPage 的协议类型未覆盖 chat/messages/responses 三种'
  );
  // 前端经 tauri.ts 向 proxy_test_chat 传递 protocol 参数
  assert.ok(
    /proxyTestChat = \(port: number, protocol: string/.test(TAURI),
    'tauri.ts 的 proxyTestChat 未接收 protocol 参数'
  );
  assert.ok(
    /'proxy_test_chat', \{ port, model, protocol \}/.test(TAURI),
    'tauri.ts 未向 proxy_test_chat 传递 protocol'
  );
  // 内核分发（后端未迁移，保持原断言）
  assert.ok(PROXY_RS.includes('protocol'), 'proxy.rs 的 proxy_test_chat 未接收 protocol 参数');
  assert.ok(PROXY_RS.includes('/v1/{path}'), 'proxy.rs 未按 proto 动态拼装端点路径');
  assert.ok(
    PROXY_RS.includes('"messages"') && PROXY_RS.includes('"responses"'),
    'proxy.rs 缺少 messages / responses 两种协议的分发分支'
  );
  assert.ok(
    PROXY_RS.includes('response.output_text.delta'),
    'proxy.rs 缺少 Responses 的文本增量解析（response.output_text.delta）'
  );
});

// ==================== 运行时开关说明（不改后端透传） ====================

test('设置页在开关下方标注生效条件（对等旧 runtime-advanced-hint）', () => {
  // 旧 index.html 的 runtime-advanced-hint 在新版中已不存在；
  // 对等形态是各开关下方的 field-hint（如模型清单模式「内核热读，保存后无需重启」）。
  assert.ok(
    /field-hint/.test(SETTINGS),
    'SettingsPage 缺少开关下方的 field-hint 说明'
  );
  assert.ok(
    SETTINGS.includes('内核热读') || SETTINGS.includes('保存后无需重启'),
    'SettingsPage 未标注模型清单模式「内核热读、保存后无需重启」的生效条件'
  );
});
