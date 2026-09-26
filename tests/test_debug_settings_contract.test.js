// 调试 Tab 与快照开关契约测试（前端迁移版，2026-09-26）
//
// 背景：旧前端（tabs.js / index.html / src/debug.js / src/settings.js）已迁移为
// React+TS：
//   tabs.js 的 debug 元信息   → src/state/ServiceProvider.tsx 的 TABS（含 'debug'）
//   index.html 导航与面板     → src/components/Sidebar.tsx（data-tab 导航）
//                              + src/App.tsx（tab === 'debug' 时渲染 DebugPage）
//   src/debug.js              → src/services/debugService.ts（纯逻辑）
//                              + src/pages/DebugPage.tsx（UI）
//   src/settings.js 的快照开关 → src/services/settingsService.ts（dirty merge payload）
//
// 契约（与旧实现一致）：
//   ① snapshots_list 返回 { snapshots, total }（非裸数组），前端消费两者；
//   ② snapshot_replay 载荷键名必须 camelCase（apiKey）：Tauri 命令参数默认
//      ArgumentCase::Camel，写 api_key 时 Rust 的 Option<String> 会静默收到 None，
//      配了客户端密钥后重放必 401；
//   ③ 设置 payload 必须带 snapshots/snapshots_keep（整对象覆盖写盘，漏字段会被抹回默认），
//      且磁盘回灌必须带 ('snapshots' in patch) 脏合并守卫。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const read = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf-8');

const PROVIDER = read('src/state/ServiceProvider.tsx');
const SIDEBAR = read('src/components/Sidebar.tsx');
const APP = read('src/App.tsx');
const DEBUG_PAGE = read('src/pages/DebugPage.tsx');
const DEBUG_SVC = read('src/services/debugService.ts');
const TAURI = read('src/services/tauri.ts');
const SETTINGS_SVC = read('src/services/settingsService.ts');

test('调试 Tab：ServiceProvider 注册 debug，App 挂载 DebugPage', () => {
  // TABS 必须含 'debug'（导航渲染与 sessionStorage 恢复的合法值都源于它）
  assert.ok(
    /'debug'/.test(PROVIDER),
    'ServiceProvider 的 TABS 缺少 debug：侧栏无入口，刷新恢复也会被判非法值'
  );
  // App 按 tab 显隐九页，debug 必须渲染 DebugPage
  assert.ok(
    /\{tab === 'debug' && <DebugPage \/>\}/.test(APP),
    'App 未在 tab === \'debug\' 时渲染 DebugPage'
  );
  assert.ok(
    /import \{ DebugPage \}/.test(APP),
    'App 未导入 DebugPage'
  );
});

test('调试 Tab：Sidebar 渲染 data-tab 导航入口', () => {
  // 导航由 TABS 驱动，按钮带 data-tab={id}（旧 index.html 的 data-tab="debug" 同等语义）
  assert.ok(
    /data-tab=\{id\}/.test(SIDEBAR),
    'Sidebar 导航按钮缺少 data-tab：无法定位/绑定 debug 入口'
  );
  assert.ok(
    /debug:\s*'nav\.debug'/.test(SIDEBAR) || /TAB_LABEL_KEYS/.test(SIDEBAR),
    'Sidebar 缺少 debug 的导航文案映射'
  );
});

test('调试页：挂载即加载快照列表（最新在前），显示总数', () => {
  assert.ok(
    /createDebugLoader\(\)/.test(DEBUG_PAGE),
    'DebugPage 未使用 createDebugLoader（请求序号防竞态丢失）'
  );
  assert.ok(
    /void refreshSnapshots\(\);/.test(DEBUG_PAGE),
    'DebugPage 挂载时未加载快照列表'
  );
  assert.ok(
    /setSnapshots\(data\.snapshots\)/.test(DEBUG_PAGE) && /setTotal\(data\.total\)/.test(DEBUG_PAGE),
    'DebugPage 未同时消费 data.snapshots 与 data.total'
  );
});

test('调试页：debugService 导出加载/重放/导出/清空能力', () => {
  for (const fn of ['createDebugLoader', 'replaySnapshot', 'buildSnapshotCurl', 'clearAllSnapshots', 'resolveReplayTarget']) {
    assert.ok(
      new RegExp(`export (async )?function ${fn}`).test(DEBUG_SVC),
      `debugService.ts 缺少导出 ${fn}`
    );
  }
  assert.ok(DEBUG_SVC.includes('snapshotsList'), 'debugService 未调用 snapshots_list');
  assert.ok(DEBUG_SVC.includes('snapshotReplay'), 'debugService 未调用 snapshot_replay');
});

test('snapshots_list 返回 { snapshots, total }（非裸数组）', () => {
  // tauri.ts 的 SnapshotsResult 类型与旧后端契约对齐：{ snapshots: [...最新在前], total }
  assert.ok(
    /interface SnapshotsResult \{[\s\S]*?snapshots: SnapshotItem\[\][\s\S]*?total: number/.test(TAURI),
    'tauri.ts 的 SnapshotsResult 未定义 { snapshots, total } 结构'
  );
  assert.ok(
    /'snapshots_list'/.test(TAURI),
    'tauri.ts 未收口 snapshots_list 命令'
  );
  // debugService 的 loader 必须透传 total（缺省才用数组长度兜底）
  assert.ok(
    /total: data\.total \?\? snapshots\.length/.test(DEBUG_SVC),
    'debugService 未透传 total：后端给的总量会被丢掉'
  );
  // DebugPage 展示总数（旧面板的「共 N 条」同等语义）
  assert.ok(
    /t\('debug\.total', \{ total \}\)/.test(DEBUG_PAGE),
    'DebugPage 未展示快照总数'
  );
});

test('snapshot_replay 载荷必须用 camelCase 的 apiKey', () => {
  // 注意：读配置对象时的 cfg.api_key 是 AppConfig 字段（snake_case 正确），
  // 只约束 invoke 的载荷键名。
  assert.ok(
    /'snapshot_replay'/.test(TAURI),
    'tauri.ts 未收口 snapshot_replay 命令'
  );
  const call = /invokeTauri<SnapshotReplayResult>\('snapshot_replay',\s*\{([^}]*)\}\)/.exec(TAURI);
  assert.ok(call, 'tauri.ts 未找到 snapshot_replay 调用');
  assert.ok(/\bid\b/.test(call[1]) && /\bport\b/.test(call[1]), 'snapshot_replay 载荷缺少 id/port');
  assert.ok(/\bapiKey\b/.test(call[1]), 'snapshot_replay 载荷必须用 apiKey');
  assert.ok(!/\bapi_key\s*:/.test(call[1]), 'snapshot_replay 载荷不得使用 api_key');
  // 导出函数的参数名同样走 camelCase（调用链一致）
  assert.ok(
    /export const snapshotReplay = \(id: string, port: number, apiKey: string\)/.test(TAURI),
    'snapshotReplay 参数名不是 camelCase 的 apiKey'
  );
  // debugService 的重放注释/调用同样用 apiKey
  assert.ok(
    /snapshot_replay 的 id\/port\/apiKey 契约/.test(DEBUG_SVC),
    'debugService 未声明 snapshot_replay 的 apiKey 契约'
  );
});

test('快照开关进设置契约：payload 与脏合并守卫', () => {
  // buildPayload（旧 buildSettingsPayload）必须带全字段：整对象覆盖写盘，
  // 漏掉 snapshots/snapshots_keep 会被抹回默认值
  assert.ok(
    /snapshots: snapshotsCache/.test(SETTINGS_SVC),
    'payload 漏 snapshots（会被整对象覆盖抹回默认）'
  );
  assert.ok(
    /snapshots_keep: snapshotsKeepCache/.test(SETTINGS_SVC),
    'payload 漏 snapshots_keep'
  );
  // dirty merge：磁盘回灌只回填「本次未修改」的字段，必须带 in patch 守卫
  assert.ok(
    SETTINGS_SVC.includes("('snapshots' in patch)") && SETTINGS_SVC.includes("('snapshots_keep' in patch)"),
    'settingsService 缺少快照字段的脏合并守卫'
  );
  // patch 必须最后展开（优先级最高），否则用户本次修改会被回灌覆盖
  const payloadIdx = SETTINGS_SVC.indexOf('const buildPayload');
  const spreadIdx = SETTINGS_SVC.indexOf('...patch', payloadIdx);
  assert.ok(
    payloadIdx > -1 && spreadIdx > payloadIdx,
    'buildPayload 未在末尾 ...patch 展开：本次修改会被磁盘回灌覆盖'
  );
});
