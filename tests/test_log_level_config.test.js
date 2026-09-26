/**
 * 结构化日志透传契约测试（React+TS 迁移版；第五轮：对标 EasyCLIProxyAPI 的日志级别管理）
 *
 * 背景：内核支持 --log / --log-level / --log-payloads 三级结构化日志
 * （info/debug/trace + 全量 payload 落盘，带时间戳与自动脱敏），
 * 但 GUI 启动内核时**未传 --log**——内核 _log() 因 log_path 为空直接丢弃，
 * 日志页只能看到 uvicorn 原始 stdout。本测试锁定该链路的透传。
 *
 * 关键安全约束：--log-payloads 会把完整 Prompt/响应正文写入磁盘，
 * 必须默认关闭且 UI 明确警示，绝不能静默开启。
 *
 * 迁移映射：
 * - 旧 index.html 的 select-log-level / chk-log-payloads
 *   → 新 SettingsPage.tsx 的 id="settings-select-log-level" 下拉与 logPayloads 开关
 *     （文案经 t() 走 i18n 词典）；
 * - 旧 settings.js 的 log_level / log_payloads 读写
 *   → 新 settingsService.ts（cache + normalizeLogLevel + dirty patch）与
 *     SettingsPage 的 onLogLevel / onToggleLogPayloads；
 * - converter.py / proxy.rs / lib.rs 后端契约未变，原断言保留。
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
const SETTINGS_TSX = JS('src/pages/SettingsPage.tsx');
const SERVICE_TS = JS('src/services/settingsService.ts');
const ZH_CN = JS('src/i18n/zh-CN.ts');

function dictValue(key) {
  const m = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(ZH_CN);
  assert.ok(m, `i18n 词典缺少 ${key}`);
  return m[1];
}

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
  // 级别下拉：选项严格限定 info/debug/trace 三档
  assert.ok(
    SETTINGS_TSX.includes('id="settings-select-log-level"'),
    'SettingsPage 缺少日志级别选择器'
  );
  assert.ok(
    /const LOG_LEVELS = \['info', 'debug', 'trace'\]/.test(SETTINGS_TSX),
    '日志级别选项必须严格限定为 info/debug/trace'
  );
  assert.ok(
    SETTINGS_TSX.includes("t('settings.logLevelHint')"),
    '级别选择器下方必须有说明 t(\'settings.logLevelHint\')'
  );
  // payload 开关 + 隐私警示
  assert.ok(
    /checked=\{form\.logPayloads\}/.test(SETTINGS_TSX),
    'SettingsPage 缺少 payload 落盘开关'
  );
  assert.ok(
    SETTINGS_TSX.includes("t('settings.logPayloadsHint')"),
    'payload 开关附近必须有警示 t(\'settings.logPayloadsHint\')'
  );
  const hint = dictValue('settings.logPayloadsHint');
  assert.ok(
    /Prompt|提示词|正文|隐私|敏感|明文/.test(hint),
    `payload 警示必须点出「明文落盘 Prompt/响应正文」（实际: ${hint.slice(0, 60)}…）`
  );
});

test('前端逻辑：日志设置接入 AppConfig 且不在整对象覆盖中被抹除', () => {
  // buildPayload 必须显式带上（整对象覆盖写盘会抹掉缺省字段）
  const start = SERVICE_TS.indexOf('const buildPayload = (');
  assert.ok(start > -1, '未找到 buildPayload');
  const block = SERVICE_TS.slice(start, SERVICE_TS.indexOf('});', start) + 3);
  assert.ok(block.includes('log_level:'), 'buildPayload 必须显式带上 log_level');
  assert.ok(block.includes('log_payloads:'), 'buildPayload 必须显式带上 log_payloads');
  // 保存必须走 dirty patch
  assert.ok(
    /saveField\(\s*\{\s*log_level:\s*level\s*\}/.test(SETTINGS_TSX),
    'log_level 必须以 saveField({ log_level: level }) 保存'
  );
  assert.ok(
    /saveField\(\s*\{\s*log_payloads:\s*checked\s*\}/.test(SETTINGS_TSX),
    'log_payloads 必须以 saveField({ log_payloads: checked }) 保存'
  );
});

test('log_level 仅 info/debug/trace，非法值归一到 info', () => {
  // normalizeLogLevel：只有 debug/trace 能通过，其余一律 info
  const start = SERVICE_TS.indexOf('export function normalizeLogLevel');
  assert.ok(start > -1, '未找到 normalizeLogLevel');
  const fn = SERVICE_TS.slice(start, SERVICE_TS.indexOf('}', start) + 1);
  assert.ok(
    /v === 'debug' \|\| v === 'trace'/.test(fn),
    'normalizeLogLevel 必须只放行 debug/trace'
  );
  assert.ok(
    /:\s*'info'/.test(fn),
    '非法 log_level 必须归一到 info'
  );
  // onLogLevel 入口与磁盘回读都必须经过归一化（非法值进不了表单也进不了磁盘回填）
  assert.ok(
    /const level = normalizeLogLevel\(value\)/.test(SETTINGS_TSX),
    'onLogLevel 必须用 normalizeLogLevel 归一化用户选择'
  );
  assert.ok(
    /const logLevel = normalizeLogLevel\(cfg\.log_level\)/.test(SERVICE_TS),
    'loadFromDisk 必须用 normalizeLogLevel 归一化磁盘值'
  );
});

test('日志页读取结构化日志文件（否则级别设置形同虚设）', () => {
  // 结构化日志写 converter.log，stdout 写 proxy_stdout.log；
  // proxy_get_logs 只读后者的话，用户在日志页看不到级别调整的效果。
  assert.ok(
    PROXY_RS.includes('converter.log'),
    'proxy_get_logs 未读取结构化日志文件——调整日志级别后用户在日志页看不到任何变化'
  );
  const start = PROXY_RS.indexOf('pub fn proxy_get_logs()');
  assert.ok(start > -1, '未找到 proxy_get_logs');
  const block = PROXY_RS.slice(start, start + 1200);
  assert.ok(
    block.includes('structured_log_path()'),
    'proxy_get_logs 必须合并读取结构化日志（converter.log）'
  );
});
