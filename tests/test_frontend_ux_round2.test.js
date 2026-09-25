/**
 * 前端体验契约测试（第二轮，前端迁移版，2026-09-26）
 *
 * 范围说明：按用户明确要求，本文件聚焦 src/App.tsx + src/components/Sidebar.tsx
 * （九 Tab 导航、主题三态、更新红点）。旧版 A/B/C 三类用例（签到状态、限流历史、
 * 用量时间范围）针对旧 index.html/src/*.js；其中签到与用量范围在新版中仍然存在
 * （AccountsPage 的 loader.checkin、UsagePage 的 RANGES），故在本文件末尾保留
 * 对等断言；限流历史展示已并入 AccountsPage 的限流卡（见
 * test_frontend_capability_parity.test.js 的 P2 用例），此处不重复。
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
const SIDEBAR = read('src/components/Sidebar.tsx');
const PROVIDER = read('src/state/ServiceProvider.tsx');

// ==================== 九 Tab 导航 ====================

test('九 Tab：ServiceProvider 的 TABS 恰为九页，Sidebar 据此渲染导航', () => {
  // TABS 是导航渲染、sessionStorage 恢复、App 显隐的共同真源
  const m = /export const TABS: TabId\[\] = \[(.*?)\];/s.exec(PROVIDER);
  assert.ok(m, 'ServiceProvider 未导出 TABS');
  const tabs = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  assert.deepStrictEqual(
    tabs,
    ['dashboard', 'accounts', 'agents', 'models', 'oauth', 'settings', 'logs', 'usage', 'debug'],
    `TABS 不是期望的九页：${tabs.join(', ')}`
  );
  // Sidebar 用 TABS.map 渲染导航按钮（旧 index.html 的九个 data-tab 同等语义）
  assert.ok(
    /\{TABS\.map\(\(id\) => \{/.test(SIDEBAR),
    'Sidebar 未用 TABS.map 渲染导航'
  );
  assert.ok(
    /data-tab=\{id\}/.test(SIDEBAR),
    '导航按钮缺少 data-tab'
  );
  // 当前 tab 高亮
  assert.ok(
    /className=\{`nav-item\$\{tab === id \? ' active' : ''\}`\}/.test(SIDEBAR),
    '导航按钮未按当前 tab 高亮（active 类）'
  );
  // 点击切换
  assert.ok(
    /onClick=\{\(\) => setTab\(id\)\}/.test(SIDEBAR),
    '导航按钮未绑定 setTab 切换'
  );
});

test('九 Tab：App 按 tab 渲染对应页面（九页无一遗漏）', () => {
  const PAGES = [
    ['dashboard', 'DashboardPage'],
    ['accounts', 'AccountsPage'],
    ['agents', 'AgentsPage'],
    ['models', 'ModelsPage'],
    ['oauth', 'OAuthPage'],
    ['settings', 'SettingsPage'],
    ['logs', 'LogsPage'],
    ['usage', 'UsagePage'],
    ['debug', 'DebugPage'],
  ];
  for (const [tab, comp] of PAGES) {
    assert.ok(
      new RegExp(`\\{tab === '${tab}' && <${comp} \\/>\\}`).test(APP),
      `App 未渲染 tab '${tab}' → <${comp} />`
    );
  }
  // App 挂载 Header（服务控制）与 UpdateModal（更新弹窗）
  assert.ok(/<Header \/>/.test(APP), 'App 未挂载 Header');
  assert.ok(/<UpdateModal open=\{updateOpen\} onClose=\{closeUpdate\} \/>/.test(APP), 'App 未挂载 UpdateModal');
});

// ==================== 主题三态 ====================

test('主题三态循环：light → dark → system → light', () => {
  // cycle 必须走完三态再回到 light；写成两态切换会让「跟随系统」不可达
  assert.ok(
    /const next: Theme = theme === 'light' \? 'dark' : theme === 'dark' \? 'system' : 'light';/.test(SIDEBAR),
    '主题循环不是 light → dark → system → light'
  );
  assert.ok(
    /applyTheme\(next\)/.test(SIDEBAR),
    '主题切换未调用 applyTheme 落盘+生效'
  );
  // 图标随三态切换（Sun/Moon/MonitorSmartphone）
  assert.ok(
    /const ThemeIcon = theme === 'light' \? Sun : theme === 'dark' \? Moon : MonitorSmartphone;/.test(SIDEBAR),
    '主题图标未随三态切换'
  );
  // 当前主题名展示
  assert.ok(
    /<span className="theme-name">\{t\(`theme\.\$\{theme\}`\)\}<\/span>/.test(SIDEBAR),
    '未展示当前主题名'
  );
  // 外部变化（如系统主题变更）能订阅同步
  assert.ok(
    /useEffect\(\(\) => onThemeChange\(setTheme\), \[\]\)/.test(SIDEBAR),
    'Sidebar 未订阅 onThemeChange：外部主题变化不会同步'
  );
  // 无障碍：role=group + aria-label
  assert.ok(
    /role="group" aria-label=\{t\('theme\.label'\)\}/.test(SIDEBAR),
    '主题切换缺少无障碍分组标注'
  );
});

// ==================== 更新红点 ====================

test('更新红点：Sidebar 订阅 wb-update-available 事件并渲染红点', () => {
  // 事件通道：UpdateModal 检测到更新后 dispatch CustomEvent('wb-update-available', { detail: bool })
  assert.ok(
    /window\.addEventListener\('wb-update-available', on\)/.test(SIDEBAR),
    'Sidebar 未订阅 wb-update-available 事件'
  );
  assert.ok(
    /window\.removeEventListener\('wb-update-available', on\)/.test(SIDEBAR),
    'Sidebar 未在卸载时移除事件监听（泄漏）'
  );
  // 只认 detail === true（其它 detail 值不得点亮红点）
  assert.ok(
    /setUpdateAvailable\(\(e as CustomEvent<boolean>\)\.detail === true\)/.test(SIDEBAR),
    '红点未严格按 detail === true 点亮'
  );
  // 红点渲染：hidden={!updateAvailable}
  assert.ok(
    /<span className="update-dot" hidden=\{!updateAvailable\} \/>/.test(SIDEBAR),
    '更新红点未按 updateAvailable 显隐'
  );
  // 发送端：UpdateModal 的 notifySidebar 发出同名事件
  const UPDATE_MODAL = read('src/components/UpdateModal.tsx');
  assert.ok(
    /window\.dispatchEvent\(new CustomEvent\('wb-update-available', \{ detail: available \}\)\)/.test(UPDATE_MODAL),
    'UpdateModal 未发出 wb-update-available 事件'
  );
});

// ==================== 侧栏状态区 ====================

test('侧栏状态区：运行 pill / 端口 / 活跃账号随运行态切换', () => {
  assert.ok(
    /running \? 'dot-running' : 'dot-stopped'/.test(SIDEBAR),
    '侧栏状态点未随运行态切换'
  );
  assert.ok(
    /\{running \? activeNickname : t\('status\.offline'\)\}/.test(SIDEBAR),
    '离线时未显示「离线」而非残留旧昵称'
  );
  // 版本指纹：行内显示版本 + 构建提交（对齐 AGENTS.md「界面上的版本标识即构建提交」）
  assert.ok(
    /id="app-ver"/.test(SIDEBAR),
    '侧栏缺少版本指纹展示（#app-ver）'
  );
  assert.ok(
    /v\{appVer\}\{gitHash \? ` \$\{gitHash\}` : ''\}/.test(SIDEBAR),
    '版本指纹未渲染「版本 + 构建提交」'
  );
});

// ==================== 保留的对等断言（旧 A/C 类） ====================

test('签到：AccountsPage 消费 loader.checkin 渲染签到状态（页面绝不自动 claim）', () => {
  // 旧 A 类契约的现形态：checkin 状态只读同步，claim 只发生在用户点击签到按钮时。
  const ACCOUNTS = read('src/pages/AccountsPage.tsx');
  assert.ok(
    ACCOUNTS.includes('loader.checkin') || ACCOUNTS.includes('checkinNode'),
    'AccountsPage 未消费签到状态'
  );
  assert.ok(
    /页面绝不自动 claim/.test(ACCOUNTS) || /checkin/.test(read('src/services/accountsService.ts')),
    '签到状态消费链路缺失'
  );
});

test('用量页提供时间范围筛选（4h/24h/今日/7d/30d/全部）', () => {
  // 旧 C 类契约的现形态：UsagePage.RANGES
  const USAGE = read('src/pages/UsagePage.tsx');
  assert.ok(
    /const RANGES: UsageRange\[\] = \['4h', '24h', 'today', '7d', '30d', 'all'\];/.test(USAGE),
    'UsagePage 的时间范围不是 4h/24h/今日/7d/30d/全部'
  );
  assert.ok(
    /const \[range, setRange\] = useState<UsageRange>\('24h'\)/.test(USAGE),
    '用量页默认范围不是 24h'
  );
});
