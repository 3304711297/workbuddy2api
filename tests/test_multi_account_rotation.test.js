/**
 * 多账号轮换契约测试（React+TS 迁移版）。
 *
 * 契约变更说明（中文）：
 *   旧前端契约（index.html 的 select-rotate-mode / input-rotate-count /
 *   btn-save-rotation / rotation-status-badge 四控件 + accounts.js 的
 *   initRotationPolicy / syncRotationPolicyCard / saveRotationPolicy + main.js
 *   调用）在 React 迁移中**未被迁移**：src/pages/AccountsPage.tsx 与
 *   src/pages/SettingsPage.tsx 均无轮换策略 UI。settingsService.ts 的注释仍称
 *   「账号页调度策略卡负责 rotate_*」，并通过 setPeerCaches 保留了「账号页写入
 *   rotate 字段」的内存镜像入口，但实际无页面调用。
 *   后端契约（Rust AppConfig 字段 + proxy.rs 透传 + converter.py AccountRotator）
 *   未动，原断言原样保留。新对等断言锁定前端数据链路不丢字段：
 *   settingsService 仍携带 rotate_mode/rotate_count（默认 off/1，dirty merge 不丢），
 *   tauri.ts 类型保留两字段，App 在 accounts 页挂载 AccountsPage。
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
const SETTINGS_SERVICE = read('src/services/settingsService.ts');
const TAURI_TS = read('src/services/tauri.ts');
const ACCOUNTS_TSX = read('src/pages/AccountsPage.tsx');
const SETTINGS_TSX = read('src/pages/SettingsPage.tsx');
const APP_TSX = read('src/App.tsx');
const LIB_RS = read('src-tauri/src/lib.rs');
const PROXY_RS = read('src-tauri/src/commands/proxy.rs');
const CONVERTER_PY = read('converter.py');

test('轮换策略卡 UI 在 React 迁移中被移除（契约变更：无页面再渲染调度策略控件）', () => {
  // 旧 index.html 的四控件 id 必须不再出现于新前端（无残留、无半成品绑定）
  for (const id of ['select-rotate-mode', 'input-rotate-count', 'btn-save-rotation', 'rotation-status-badge']) {
    assert.ok(!ACCOUNTS_TSX.includes(id), `AccountsPage.tsx 不得残留旧控件 ${id}`);
    assert.ok(!SETTINGS_TSX.includes(id), `SettingsPage.tsx 不得残留旧控件 ${id}`);
  }
  // 旧 accounts.js 的 initRotationPolicy / syncRotationPolicyCard / saveRotationPolicy 无 React 对等实现
  for (const fn of ['initRotationPolicy', 'syncRotationPolicyCard', 'saveRotationPolicy']) {
    assert.ok(!ACCOUNTS_TSX.includes(fn), `AccountsPage.tsx 不得残留旧函数 ${fn}`);
  }
});

test('前端数据链路仍携带 rotate_mode / rotate_count（dirty merge 不丢字段）', () => {
  // settingsService 表单态 + 默认值（off/1，与后端兜底一致）
  assert.ok(SETTINGS_SERVICE.includes('rotateMode'), 'settingsService 缺少 rotateMode');
  assert.ok(SETTINGS_SERVICE.includes('rotateCount'), 'settingsService 缺少 rotateCount');
  assert.ok(SETTINGS_SERVICE.includes("rotateMode: 'off'"), 'rotateMode 默认值必须为 off');
  assert.ok(SETTINGS_SERVICE.includes('rotateCount: 1'), 'rotateCount 默认值必须为 1');
  // 落盘 payload 必须带全字段（AppConfig 整对象覆盖写盘，缺字段会被 serde default 抹回）
  assert.ok(SETTINGS_SERVICE.includes('rotate_mode: rotateModeCache'), 'persist payload 缺少 rotate_mode');
  assert.ok(SETTINGS_SERVICE.includes('rotate_count: rotateCountCache'), 'persist payload 缺少 rotate_count');
  // 「他页写入」内存镜像入口保留（账号页调度策略卡的历史写入位）
  assert.ok(SETTINGS_SERVICE.includes('setPeerCaches'), '缺少 setPeerCaches（rotate 字段的跨页同步入口）');
});

test('tauri.ts 类型层保留 rotate_mode / rotate_count 且 App 挂载账号页', () => {
  assert.ok(TAURI_TS.includes('rotate_mode: string'), 'tauri.ts 类型缺少 rotate_mode');
  assert.ok(TAURI_TS.includes('rotate_count: number'), 'tauri.ts 类型缺少 rotate_count');
  assert.ok(APP_TSX.includes("tab === 'accounts' && <AccountsPage />"), 'App 未在 accounts 页挂载 AccountsPage');
});

test('Rust AppConfig 含 rotate_mode / rotate_count 且带 serde default（旧配置兼容）', () => {
  assert.ok(LIB_RS.includes('pub rotate_mode: String'), 'AppConfig 缺少 rotate_mode');
  assert.ok(LIB_RS.includes('pub rotate_count: u32'), 'AppConfig 缺少 rotate_count');
  assert.ok(LIB_RS.includes('fn default_rotate_mode()'), '缺少 default_rotate_mode');
  assert.ok(LIB_RS.includes('fn default_rotate_count()'), '缺少 default_rotate_count');
  assert.ok(LIB_RS.includes('#[serde(default = "default_rotate_mode")]'), 'rotate_mode 缺少 serde default');
  assert.ok(LIB_RS.includes('#[serde(default = "default_rotate_count")]'), 'rotate_count 缺少 serde default');
});

test('proxy.rs 始终向内核透传轮换参数（作为 settings.json 不可读时的兜底默认值）', () => {
  assert.ok(PROXY_RS.includes('"--rotate-mode"'), 'proxy.rs 未透传 --rotate-mode');
  assert.ok(PROXY_RS.includes('"--rotate-count"'), 'proxy.rs 未透传 --rotate-count');
  // 热读模式下参数仅作兜底，因此必须无条件传递（不再对 off 做短路）
  assert.ok(
    !PROXY_RS.includes('cfg.rotate_mode != "off"'),
    'proxy.rs 不应再对 off 短路——内核以 settings.json 为运行时真源，参数只是兜底'
  );
  assert.ok(
    PROXY_RS.includes('if cfg.rotate_mode.is_empty()'),
    'proxy.rs 需对空字符串做归一处理'
  );
});

test('converter.py 注册 rotate_mode / rotate_count 配置与 CLI 参数', () => {
  assert.ok(CONVERTER_PY.includes('"rotate_mode"'), 'CONFIG 缺少 rotate_mode');
  assert.ok(CONVERTER_PY.includes('"rotate_count"'), 'CONFIG 缺少 rotate_count');
  assert.ok(CONVERTER_PY.includes('--rotate-mode'), '缺少 --rotate-mode CLI 参数');
  assert.ok(CONVERTER_PY.includes('--rotate-count'), '缺少 --rotate-count CLI 参数');
  // 环境变量经 _env_compat 读取（新名 WORKBUDDY2API_* 优先，旧名 CODEBUDDY2OPENAI_* 兜底）
  assert.ok(
    CONVERTER_PY.includes('_env_compat("ROTATE_MODE"'),
    'rotate_mode 未经 _env_compat 读取（应兼容新旧环境变量名）'
  );
});

test('converter.py 轮换默认关闭（off）且支持三种模式', () => {
  assert.ok(CONVERTER_PY.includes('class AccountRotator'), '缺少 AccountRotator 实现');
  assert.ok(CONVERTER_PY.includes('"failover"'), '缺少 failover 模式');
  assert.ok(CONVERTER_PY.includes('"roundrobin"'), '缺少 roundrobin 模式');
  // 默认值必须是 off（不改变既有单账号行为）
  const m = CONVERTER_PY.match(/"rotate_mode": _env_compat\("ROTATE_MODE", "off"\)/);
  assert.ok(m, 'rotate_mode 默认值必须为 off');
});
