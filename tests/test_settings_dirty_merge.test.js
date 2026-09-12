import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SETTINGS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'settings.js'), 'utf-8');

// ---------------------------------------------------------------------------
// 背景（2026-09-12 外部评审实证）：persistSettings() 原实现「读盘 → 无条件回灌 cache →
// 写盘」，导致用户刚修改的值被磁盘旧值覆盖：LAN 开关 / log_level / log_payloads /
// model_list_mode 首次修改保存不生效，「清空密钥」甚至永远清不掉（空输入恰好满足
// 回灌条件把旧 key 读回来）。修复 = dirty merge：调用方通过 patch 显式声明本次修改
// 的字段，patch 在最终 payload 中最后展开，磁盘真源只用于「本次未修改」的字段。
// ---------------------------------------------------------------------------

function sliceFrom(needle) {
  const start = SETTINGS_JS.indexOf(needle);
  assert.ok(start > -1, `未找到 ${needle}`);
  return start;
}

test('persistSettings 接收 dirty patch 参数', () => {
  sliceFrom('const persistSettings = async (patch = {}) =>');
});

test('buildSettingsPayload 接收 patch 且在 payload 末尾展开（patch 优先级最高）', () => {
  const start = sliceFrom('const buildSettingsPayload = (patch = {}) =>');
  const end = SETTINGS_JS.indexOf('};', start);
  const block = SETTINGS_JS.slice(start, end + 2);
  assert.ok(
    block.includes('...patch'),
    'buildSettingsPayload 必须展开 patch，否则 dirty 字段无法覆盖磁盘旧值'
  );
  // ...patch 必须展开在对象末尾（之后只有收尾括号），保证优先级最高
  const spread = block.indexOf('...patch');
  const tail = block.slice(spread);
  assert.ok(
    /^\.\.\.patch,\s*\}\s*;?\s*$/.test(tail) || /^\.\.\.patch\s*\}/.test(tail.trim()),
    `...patch 之后不得再覆盖其他键（实际尾部: ${tail.slice(0, 60)}）`
  );
});

test('LAN 开关保存必须走 dirty patch（否则磁盘 127.0.0.1 会覆盖刚设置的 0.0.0.0）', () => {
  const start = sliceFrom("chkLanAccess?.addEventListener('change'");
  const block = SETTINGS_JS.slice(start, SETTINGS_JS.indexOf("persistSettings()", start) > -1
    ? SETTINGS_JS.indexOf("persistSettings()", start)
    : start + 1200);
  assert.ok(
    /persistSettings\(\{\s*listen_host:/.test(SETTINGS_JS.slice(start, start + 1200)),
    'LAN 开关必须以 persistSettings({ listen_host: ... }) 显式声明 dirty 字段'
  );
});

test('日志级别与正文落盘保存必须走 dirty patch', () => {
  assert.ok(
    /persistSettings\(\{\s*log_level:/.test(SETTINGS_JS),
    'log_level 必须以 persistSettings({ log_level: ... }) 保存'
  );
  assert.ok(
    /persistSettings\(\{\s*log_payloads:/.test(SETTINGS_JS),
    'log_payloads 必须以 persistSettings({ log_payloads: ... }) 保存'
  );
});

test('模型清单模式保存必须走 dirty patch', () => {
  assert.ok(
    /persistSettings\(\{\s*model_list_mode:/.test(SETTINGS_JS),
    'model_list_mode 必须以 persistSettings({ model_list_mode: ... }) 保存'
  );
});

test('生成与清空密钥都必须走 dirty patch（清空曾因空输入回灌永远清不掉）', () => {
  assert.ok(
    /persistSettings\(\{\s*api_key:\s*key\s*\}\)/.test(SETTINGS_JS),
    '生成密钥必须以 persistSettings({ api_key: key }) 保存'
  );
  assert.ok(
    /persistSettings\(\{\s*api_key:\s*''\s*\}\)/.test(SETTINGS_JS),
    '清空密钥必须以 persistSettings({ api_key: \'\' }) 显式保存空值'
  );
  assert.ok(
    /persistSettings\(\{\s*api_key:\s*\(?inputApiKey\.value/.test(SETTINGS_JS),
    '手动编辑密钥必须以 persistSettings({ api_key: ... }) 保存'
  );
});

test('磁盘回灌必须带 dirty 守卫——本次修改的字段绝不被旧值覆盖', () => {
  // 旧实现的无条件回灌语句（必须消失，替换为 !('<field>' in patch) 守卫形态）
  for (const banned of [
    'if (latest.listen_host) listenHostCache',
    'if (latest.log_level) logLevelCache',
    'if (latest.model_list_mode) modelListModeCache',
  ]) {
    assert.ok(
      !SETTINGS_JS.includes(banned),
      `存在无条件磁盘回灌「${banned}」——用户刚修改的值会被磁盘旧值覆盖（评审 P1 根因）`
    );
  }
  // 五个可 dirty 的字段都必须有守卫形态
  for (const field of ['listen_host', 'log_level', 'log_payloads', 'model_list_mode', 'api_key']) {
    assert.ok(
      SETTINGS_JS.includes(`('${field}' in patch)`),
      `缺少 dirty 守卫 ('${field}' in patch)`
    );
  }
});

test('persistSettings 仍须先读磁盘真源再写盘（保留既有防陈旧缓存契约）', () => {
  const start = sliceFrom('const persistSettings = async (patch = {}) =>');
  const end = SETTINGS_JS.indexOf('};', start);
  const block = SETTINGS_JS.slice(start, end + 2);
  const readIdx = block.indexOf("invokeTauri('get_app_settings')");
  const writeIdx = block.indexOf("invokeTauri('save_app_settings'");
  assert.ok(readIdx > -1, 'persistSettings 必须先调用 get_app_settings 读取磁盘真源');
  assert.ok(writeIdx > readIdx, '读取必须发生在写入之前');
});
