import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf-8');
const ACCOUNTS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'accounts.js'), 'utf-8');
const MAIN_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'main.js'), 'utf-8');
const LIB_RS = fs.readFileSync(path.join(REPO_ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf-8');
const PROXY_RS = fs.readFileSync(path.join(REPO_ROOT, 'src-tauri', 'src', 'commands', 'proxy.rs'), 'utf-8');
const CONVERTER_PY = fs.readFileSync(path.join(REPO_ROOT, 'converter.py'), 'utf-8');

test('index.html 含多账号调度策略卡的三个必需控件', () => {
  assert.ok(HTML.includes('id="select-rotate-mode"'), '缺少调度策略下拉');
  assert.ok(HTML.includes('id="input-rotate-count"'), '缺少轮换阈值输入框');
  assert.ok(HTML.includes('id="btn-save-rotation"'), '缺少保存按钮');
  assert.ok(HTML.includes('id="rotation-status-badge"'), '缺少状态徽章');
});

test('accounts.js 导出 initRotationPolicy 且 main.js 已调用', () => {
  assert.ok(ACCOUNTS_JS.includes('export function initRotationPolicy'), 'accounts.js 未导出 initRotationPolicy');
  assert.ok(ACCOUNTS_JS.includes('syncRotationPolicyCard'), 'accounts.js 缺少 syncRotationPolicyCard');
  assert.ok(ACCOUNTS_JS.includes('saveRotationPolicy'), 'accounts.js 缺少 saveRotationPolicy');
  assert.ok(MAIN_JS.includes('initRotationPolicy'), 'main.js 未导入 initRotationPolicy');
  assert.ok(MAIN_JS.includes('initRotationPolicy();'), 'main.js 未调用 initRotationPolicy()');
});

test('账号卡片状态徽章区分活跃与待机就绪', () => {
  assert.ok(ACCOUNTS_JS.includes('● 活跃中'), '缺少活跃态徽章文案');
  assert.ok(ACCOUNTS_JS.includes('○ 待机就绪'), '缺少待机就绪徽章文案');
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
