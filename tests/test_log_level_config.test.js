/**
 * 结构化日志透传契约测试（第五轮：对标 EasyCLIProxyAPI 的日志级别管理）
 *
 * 背景：内核支持 --log / --log-level / --log-payloads 三级结构化日志
 * （info/debug/trace + 全量 payload 落盘，带时间戳与自动脱敏），
 * 但 GUI 启动内核时**未传 --log**——内核 _log() 因 log_path 为空直接丢弃，
 * 日志页只能看到 uvicorn 原始 stdout。本测试锁定该链路的透传。
 *
 * 关键安全约束：--log-payloads 会把完整 Prompt/响应正文写入磁盘，
 * 必须默认关闭且 UI 明确警示，绝不能静默开启。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS = (p) => readFileSync(join(ROOT, p), 'utf8');

const CONVERTER = JS('converter.py');
const PROXY_RS = JS('src-tauri/src/commands/proxy.rs');
const LIB_RS = JS('src-tauri/src/lib.rs');
const SETTINGS_JS = JS('src/settings.js');
const INDEX_HTML = JS('index.html');

test('前置事实：内核支持 --log / --log-level / --log-payloads 且 payload 需 trace 级', () => {
  for (const flag of ['"--log"', '"--log-level"', '"--log-payloads"']) {
    assert.ok(CONVERTER.includes(flag), `converter.py 缺少 ${flag} 参数`);
  }
  // payload 落盘必须同时要求 log_payloads 且级别为 trace（双闸门）
  assert.ok(
    CONVERTER.includes('def _log_payload('),
    'converter.py 缺少 _log_payload 函数'
  );
  const fn = CONVERTER.match(/def _log_payload[\s\S]{0,500}/)?.[0] || '';
  assert.ok(
    fn.includes('log_payloads') && fn.includes('trace'),
    '_log_payload 须同时受 log_payloads 与 trace 级约束（防 Prompt 正文意外落盘）'
  );
});

test('Rust AppConfig 承载 log_level / log_payloads（serde default 兼容旧配置）', () => {
  assert.ok(/pub log_level: String/.test(LIB_RS), 'AppConfig 缺少 log_level 字段');
  assert.ok(/pub log_payloads: bool/.test(LIB_RS), 'AppConfig 缺少 log_payloads 字段');
  const idx = LIB_RS.indexOf('pub log_level: String');
  assert.ok(
    LIB_RS.slice(Math.max(0, idx - 120), idx).includes('#[serde(default'),
    'log_level 需带 serde(default) 保证旧配置兼容（属性在声明之前）'
  );
  const idx2 = LIB_RS.indexOf('pub log_payloads: bool');
  assert.ok(
    LIB_RS.slice(Math.max(0, idx2 - 120), idx2).includes('#[serde(default'),
    'log_payloads 需带 serde(default) 保证旧配置兼容'
  );
});

test('proxy_start 透传 --log 指向结构化日志文件，并按级别追加参数', () => {
  assert.ok(
    PROXY_RS.includes('"--log"'),
    'proxy.rs 未透传 --log——内核 _log() 会因 log_path 为空而丢弃全部结构化日志'
  );
  assert.ok(
    PROXY_RS.includes('"--log-level"'),
    'proxy.rs 未透传 --log-level'
  );
  // payload 开关必须条件追加（默认关闭）
  const block = PROXY_RS.match(/[\s\S]{0,300}"--log-payloads"[\s\S]{0,80}/)?.[0] || '';
  assert.ok(
    /if\s+.*log_payloads/.test(block),
    '--log-payloads 必须条件追加（会落盘完整 Prompt 正文，默认必须关闭）'
  );
});

test('前端设置页提供日志级别选择与 payload 警示', () => {
  assert.ok(
    INDEX_HTML.includes('select-log-level'),
    'index.html 缺少日志级别选择器'
  );
  assert.ok(
    INDEX_HTML.includes('chk-log-payloads'),
    'index.html 缺少 payload 落盘开关'
  );
  // payload 开关附近必须有隐私警示（明文落盘 Prompt 正文）
  const i = INDEX_HTML.indexOf('chk-log-payloads');
  const seg = INDEX_HTML.slice(Math.max(0, i - 1500), i + 1500);
  assert.ok(
    /Prompt|提示词|正文|隐私|敏感/.test(seg),
    'payload 开关附近需警示「会明文落盘 Prompt/响应正文」'
  );
});

test('前端逻辑：日志设置接入 AppConfig 且不在整对象覆盖中被抹除', () => {
  assert.ok(
    SETTINGS_JS.includes('log_level'),
    'settings.js 未读写 log_level'
  );
  assert.ok(
    SETTINGS_JS.includes('log_payloads'),
    'settings.js 未读写 log_payloads'
  );
  // buildSettingsPayload 必须显式带上（整对象覆盖写盘会抹掉缺省字段）
  const fn = SETTINGS_JS.match(/const buildSettingsPayload[\s\S]{0,900}/)?.[0] || '';
  assert.ok(
    fn.includes('log_level') && fn.includes('log_payloads'),
    'buildSettingsPayload 必须显式带上 log_level/log_payloads，否则被 serde default 抹回默认值'
  );
});

test('日志页读取结构化日志文件（否则级别设置形同虚设）', () => {
  // 结构化日志写 converter.log，stdout 写 proxy_stdout.log；
  // proxy_get_logs 只读后者的话，用户在日志页看不到级别调整的效果。
  assert.ok(
    PROXY_RS.includes('converter.log'),
    'proxy_get_logs 未读取结构化日志文件——调整日志级别后用户在日志页看不到任何变化'
  );
});
