/**
 * dirty merge 契约（React+TS 迁移版）。
 *
 * 背景（2026-09-12 外部评审实证）：persist 原实现「读盘 → 无条件回灌 cache →
 * 写盘」，导致用户刚修改的值被磁盘旧值覆盖：LAN 开关 / log_level / log_payloads /
 * model_list_mode 首次修改保存不生效，「清空密钥」甚至永远清不掉（空输入恰好满足
 * 回灌条件把旧 key 读回来）。修复 = dirty merge：调用方通过 patch 显式声明本次修改
 * 的字段，patch 在最终 payload 中最后展开，磁盘真源只用于「本次未修改」的字段。
 *
 * 迁移映射：
 * - 旧 `src/settings.js` persistSettings / buildSettingsPayload
 *   → 新 `src/services/settingsService.ts` persist / buildPayload；
 * - 调用方旧 `persistSettings({ listen_host: ... })`
 *   → 新 SettingsPage `saveField({ listen_host: ... }, ...)`（saveField 内部调 store.persist）；
 * - dirty 守卫新形态：`if (!('<field>' in patch) && ...)`（守卫在前，语义与旧 `('<field>' in patch)` 一致）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SERVICE_TS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'settingsService.ts'), 'utf-8');
const SETTINGS_TSX = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'SettingsPage.tsx'), 'utf-8');

// 可 dirty 的字段全集：persist 回灌时每个都必须带 dirty 守卫
const DIRTY_FIELDS = [
  'rotate_mode',
  'rotate_count',
  'model_list_mode',
  'log_level',
  'log_payloads',
  'listen_host',
  'snapshots',
  'snapshots_keep',
  'api_key',
];

test('persist 接收 dirty patch 参数', () => {
  assert.ok(
    SERVICE_TS.includes('const persist = (patch: SettingsPatch, form: SettingsFormState)'),
    'persist 必须接收 patch 作为第一参数'
  );
});

test('buildPayload 接收 patch 且在 payload 末尾展开（patch 优先级最高）', () => {
  const start = SERVICE_TS.indexOf('const buildPayload = (');
  assert.ok(start > -1, '未找到 buildPayload');
  const block = SERVICE_TS.slice(start, SERVICE_TS.indexOf('});', start) + 3);
  assert.ok(
    block.includes('...patch'),
    'buildPayload 必须展开 patch，否则 dirty 字段无法覆盖磁盘旧值'
  );
  // ...patch 必须展开在对象末尾（之后只有收尾），保证优先级最高
  const spread = block.indexOf('...patch');
  const tail = block.slice(spread).trim();
  assert.ok(
    /^\.\.\.patch,?\s*\}\)\s*;?$/.test(tail),
    `...patch 之后不得再覆盖其他键（实际尾部: ${tail.slice(0, 40)}）`
  );
});

test('LAN 开关保存必须走 dirty patch（否则磁盘 127.0.0.1 会覆盖刚设置的 0.0.0.0）', () => {
  assert.ok(
    /saveField\(\s*\{\s*listen_host:\s*host\s*\}/.test(SETTINGS_TSX),
    'LAN 开关必须以 saveField({ listen_host: host }) 显式声明 dirty 字段'
  );
  // 开/关分别映射到 0.0.0.0 / 127.0.0.1
  assert.ok(
    /const host = checked \? '0\.0\.0\.0' : '127\.0\.0\.1'/.test(SETTINGS_TSX),
    'LAN 开关必须映射为 0.0.0.0（开）/ 127.0.0.1（关）'
  );
});

test('日志级别与正文落盘保存必须走 dirty patch', () => {
  assert.ok(
    /saveField\(\s*\{\s*log_level:\s*level\s*\}/.test(SETTINGS_TSX),
    'log_level 必须以 saveField({ log_level: level }) 保存'
  );
  assert.ok(
    /saveField\(\s*\{\s*log_payloads:\s*checked\s*\}/.test(SETTINGS_TSX),
    'log_payloads 必须以 saveField({ log_payloads: checked }) 保存'
  );
});

test('模型清单模式保存必须走 dirty patch', () => {
  assert.ok(
    /saveField\(\s*\{\s*model_list_mode:\s*mode\s*\}/.test(SETTINGS_TSX),
    'model_list_mode 必须以 saveField({ model_list_mode: mode }) 保存'
  );
});

test('生成与清空密钥都必须走 dirty patch（清空曾因空输入回灌永远清不掉）', () => {
  assert.ok(
    /saveField\(\s*\{\s*api_key:\s*key\s*\}/.test(SETTINGS_TSX),
    '生成密钥必须以 saveField({ api_key: key }) 保存'
  );
  assert.ok(
    /saveField\(\s*\{\s*api_key:\s*''\s*\}/.test(SETTINGS_TSX),
    "清空密钥必须以 saveField({ api_key: '' }) 显式保存空值"
  );
  assert.ok(
    /saveField\(\s*\{\s*api_key:\s*trimmed\s*\}/.test(SETTINGS_TSX),
    '手动编辑密钥必须以 saveField({ api_key: trimmed }) 保存'
  );
});

test('磁盘回灌必须带 dirty 守卫——本次修改的字段绝不被旧值覆盖', () => {
  // 取 persist 函数体做局部断言，避免其它函数的同名变量干扰
  const start = SERVICE_TS.indexOf('const persist = (patch');
  assert.ok(start > -1, '未找到 persist');
  const block = SERVICE_TS.slice(start, start + 4200);

  // 旧实现的无条件回灌形态（必须消失）：`if (latest.<f>) <cache>` 这种裸判断
  for (const banned of [
    'if (latest.listen_host) listenHostCache',
    'if (latest.log_level) logLevelCache',
    'if (latest.model_list_mode) modelListModeCache',
  ]) {
    assert.ok(
      !block.includes(banned),
      `存在无条件磁盘回灌「${banned}」——用户刚修改的值会被磁盘旧值覆盖（评审 P1 根因）`
    );
  }
  // 每个可 dirty 字段的回灌行都必须带 !('<field>' in patch) 守卫
  // （守卫可能在同行，也可能在上一行的多行 if 条件里）
  for (const field of DIRTY_FIELDS) {
    // 注意：latest.snapshots 是 latest.snapshots_keep 的前缀，需用负向前瞻排除
    const fieldRe = new RegExp(`latest\\.${field}(?![a-z_])`);
    const allLines = block.split('\n');
    const hits = allLines.filter((l) => fieldRe.test(l));
    assert.ok(hits.length > 0, `persist 内未找到对磁盘字段 latest.${field} 的回灌`);
    for (const line of hits) {
      const i = allLines.indexOf(line);
      // 回溯最多 4 行找外层 if 的守卫（如 api_key 的守卫在外层块上）
      const window = allLines.slice(Math.max(0, i - 4), i + 1).join('\n');
      assert.ok(
        window.includes(`!('${field}' in patch)`),
        `回灌缺少 dirty 守卫 !('${field}' in patch)：${line.trim().slice(0, 90)}`
      );
    }
  }
});

test('persist 仍须先读磁盘真源再写盘（保留既有防陈旧缓存契约）', () => {
  const start = SERVICE_TS.indexOf('const persist = (patch');
  assert.ok(start > -1, '未找到 persist');
  const block = SERVICE_TS.slice(start, start + 4200);
  const readIdx = block.indexOf('getAppSettings()');
  const writeIdx = block.indexOf('saveAppSettings(');
  assert.ok(readIdx > -1, 'persist 必须先调用 getAppSettings() 读取磁盘真源');
  assert.ok(writeIdx > readIdx, '读取必须发生在写入之前');
});

test('读盘失败必须中止保存（宁可重试，不静默写旧数据）', () => {
  const start = SERVICE_TS.indexOf('const persist = (patch');
  const block = SERVICE_TS.slice(start, start + 4200);
  assert.ok(
    block.includes('读取磁盘设置失败'),
    '读盘失败必须给出明确的用户提示（读取磁盘设置失败…）'
  );
  const errIdx = block.indexOf('读取磁盘设置失败');
  const saveIdx = block.indexOf('saveAppSettings(');
  assert.ok(errIdx < saveIdx, '读盘失败分支必须在写盘之前返回（中止保存）');
});
