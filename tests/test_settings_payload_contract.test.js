import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SETTINGS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'settings.js'), 'utf-8');
const ACCOUNTS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'accounts.js'), 'utf-8');
const LIB_RS = fs.readFileSync(path.join(REPO_ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf-8');

// 从 Rust AppConfig 中提取所有字段名（pub xxx:），作为前端 payload 必须覆盖的契约集
function extractAppConfigFields() {
  const start = LIB_RS.indexOf('pub struct AppConfig {');
  assert.ok(start > -1, '未找到 AppConfig 定义');
  const block = LIB_RS.slice(start, LIB_RS.indexOf('}', start));
  const fields = [];
  const re = /pub\s+([a-z_][a-z0-9_]*)\s*:/g;
  let m;
  while ((m = re.exec(block)) !== null) fields.push(m[1]);
  return fields;
}

test('AppConfig 字段全集可被提取（契约基线）', () => {
  const fields = extractAppConfigFields();
  // 至少包含这批已确认字段，防止解析失效导致后续断言空转
  for (const f of ['close_action', 'auto_start_proxy', 'show_debug_console', 'port', 'desensitize', 'rotate_mode', 'rotate_count']) {
    assert.ok(fields.includes(f), `AppConfig 缺少预期字段 ${f}（实际: ${fields.join(', ')}）`);
  }
});

test('settings.js 的 buildSettingsPayload 必须带全 AppConfig 全部字段（防整对象覆盖回滚）', () => {
  const fields = extractAppConfigFields();
  const start = SETTINGS_JS.indexOf('const buildSettingsPayload = ()');
  assert.ok(start > -1, '未找到 buildSettingsPayload');
  const block = SETTINGS_JS.slice(start, SETTINGS_JS.indexOf('};', start));

  const missing = fields.filter((f) => !block.includes(`${f}:`));
  assert.deepEqual(
    missing,
    [],
    `buildSettingsPayload 漏字段 [${missing.join(', ')}]：save_app_settings 是整对象覆盖写盘，漏字段会被 serde default 静默抹回默认值`
  );
});

test('persistSettings 写盘前先读磁盘真源（防止陈旧缓存反向覆盖）', () => {
  const start = SETTINGS_JS.indexOf('const persistSettings = async () =>');
  assert.ok(start > -1, '未找到 persistSettings');
  const block = SETTINGS_JS.slice(start, start + 900);
  assert.ok(
    block.includes("invokeTauri('get_app_settings')"),
    'persistSettings 必须先调用 get_app_settings 读取磁盘真源再合并写回'
  );
  assert.ok(
    block.indexOf("invokeTauri('get_app_settings')") < block.indexOf("invokeTauri('save_app_settings'"),
    '读取必须发生在写入之前'
  );
});

test('saveRotationPolicy 写盘后做回读校验（防止静默失败伪装成功）', () => {
  const start = ACCOUNTS_JS.indexOf('async function saveRotationPolicy()');
  assert.ok(start > -1, '未找到 saveRotationPolicy');
  const block = ACCOUNTS_JS.slice(start, start + 1800);
  const saveIdx = block.indexOf("invokeTauri('save_app_settings'");
  const verifyIdx = block.indexOf("invokeTauri('get_app_settings'", saveIdx);
  assert.ok(saveIdx > -1, 'saveRotationPolicy 未调用 save_app_settings');
  assert.ok(verifyIdx > saveIdx, 'saveRotationPolicy 写盘后必须回读校验');
  assert.ok(block.includes('保存未生效'), '缺少回读失败的用户提示');
});

test('accounts.js 调度策略卡不再声称单账号模式时也允许保存（提示与实际一致）', () => {
  // 单账号时提示语必须说明无效，避免用户误以为已生效
  assert.ok(
    ACCOUNTS_JS.includes('轮换调度无效（N=1 等价原地不动）'),
    '单账号提示语缺失或语义被改弱'
  );
});

test('change 事件只做纯渲染，绝不回读磁盘覆盖用户选择（闪回根因）', () => {
  const start = ACCOUNTS_JS.indexOf('export function initRotationPolicy()');
  assert.ok(start > -1, '未找到 initRotationPolicy');
  const block = ACCOUNTS_JS.slice(start, start + 500);

  assert.ok(
    block.includes('renderRotationPolicyUI'),
    'change 事件必须调用纯渲染函数 renderRotationPolicyUI'
  );
  assert.ok(
    !block.includes('syncRotationPolicyCard'),
    'change 事件严禁调用 syncRotationPolicyCard —— 它会读盘并强制回写 select.value，导致用户选择被立刻改回旧值'
  );
});

test('存在纯渲染函数 renderRotationPolicyUI 且不触碰磁盘', () => {
  const start = ACCOUNTS_JS.indexOf('function renderRotationPolicyUI(');
  assert.ok(start > -1, '未找到 renderRotationPolicyUI');
  const block = ACCOUNTS_JS.slice(start, start + 1600);
  assert.ok(!block.includes('invokeTauri'), 'renderRotationPolicyUI 必须是纯渲染，不得调用 invokeTauri');
  assert.ok(!block.includes('select.value ='), 'renderRotationPolicyUI 不得改写 select.value');
});

