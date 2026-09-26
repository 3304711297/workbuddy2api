/**
 * 设置 payload 整对象覆盖契约（React+TS 迁移版）。
 *
 * 迁移说明：
 * - 旧 `src/settings.js` 的 buildSettingsPayload / persistSettings → 新
 *   `src/services/settingsService.ts` 的 buildPayload / persist（SettingsPage 只声明 patch）；
 * - 旧 `src/accounts.js` 的调度策略卡（saveRotationPolicy / renderRotationPolicyUI /
 *   initRotationPolicy）在本分支尚未迁入 React（AccountsPage.tsx 暂无 rotate 相关代码），
 *   故原 4–8 条账号侧断言改为对等新断言，并在下方逐条标注；
 * - lib.rs 的 AppConfig 整对象覆盖写盘铁律未变，字段反射提取保持原样。
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
const TAURI_TS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'tauri.ts'), 'utf-8');
const ZH_CN = fs.readFileSync(path.join(REPO_ROOT, 'src', 'i18n', 'zh-CN.ts'), 'utf-8');
const LIB_RS = fs.readFileSync(path.join(REPO_ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf-8');
const CONVERTER_PY = fs.readFileSync(path.join(REPO_ROOT, 'converter.py'), 'utf-8');

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
  for (const f of ['close_action', 'auto_start_proxy', 'show_debug_console', 'port', 'desensitize', 'rotate_mode', 'rotate_count', 'api_key', 'log_level', 'log_payloads', 'listen_host', 'snapshots', 'snapshots_keep']) {
    assert.ok(fields.includes(f), `AppConfig 缺少预期字段 ${f}（实际: ${fields.join(', ')}）`);
  }
});

test('settingsService.buildPayload 必须带全 AppConfig 全部字段（防整对象覆盖回滚）', () => {
  const fields = extractAppConfigFields();
  const start = SERVICE_TS.indexOf('const buildPayload = (');
  assert.ok(start > -1, '未找到 buildPayload');
  const block = SERVICE_TS.slice(start, SERVICE_TS.indexOf('});', start) + 3);

  const missing = fields.filter((f) => !block.includes(`${f}:`));
  assert.deepEqual(
    missing,
    [],
    `buildPayload 漏字段 [${missing.join(', ')}]：save_app_settings 是整对象覆盖写盘，漏字段会被 serde default 静默抹回默认值`
  );
  // dirty patch 必须最后展开（优先级最高），否则磁盘旧值会压住本次修改
  assert.ok(/\.\.\.patch,\s*\}\)/.test(block), 'buildPayload 末尾必须 ...patch 展开');
});

test('persist 写盘前先读磁盘真源（防止陈旧缓存反向覆盖）', () => {
  const start = SERVICE_TS.indexOf('const persist = (patch');
  assert.ok(start > -1, '未找到 persist');
  const block = SERVICE_TS.slice(start, start + 4200);
  const readIdx = block.indexOf('getAppSettings()');
  const writeIdx = block.indexOf('saveAppSettings(');
  assert.ok(readIdx > -1, 'persist 必须先调用 getAppSettings() 读取磁盘真源');
  assert.ok(writeIdx > readIdx, '读取必须发生在写入之前');
  // 读盘失败必须中止保存（禁止用陈旧 cache 把旧密钥落回磁盘）
  const abortSeg = block.slice(readIdx, writeIdx);
  assert.ok(abortSeg.includes('return false'), '读盘失败必须中止本次保存并返回 false');
});

test('tauri.ts 的 get/saveAppSettings 映射到正确的 invoke 命令', () => {
  assert.ok(
    /getAppSettings\s*=\s*\(\)\s*=>\s*invokeTauri<AppSettings>\('get_app_settings'\)/.test(TAURI_TS),
    'getAppSettings 必须映射到 get_app_settings'
  );
  assert.ok(
    /saveAppSettings\s*=\s*\(settings: AppSettings\)\s*=>\s*\n?\s*invokeTauri<string>\('save_app_settings'/.test(TAURI_TS),
    'saveAppSettings 必须映射到 save_app_settings'
  );
});

test('（原 saveRotationPolicy 回读校验的对等断言）settingsService 托管他页写入字段的缓存同步', () => {
  // 旧契约：accounts.js 的调度策略卡负责写 rotate_mode/rotate_count，写后回读校验。
  // 新对等：settingsService 通过 setPeerCaches 接收「他页写入」字段的缓存同步，
  // buildPayload 仍带全 rotate_* 字段 —— 整对象覆盖写盘时不会把账号页的字段抹除。
  assert.ok(
    SERVICE_TS.includes('setPeerCaches'),
    'createSettingsStore 必须暴露 setPeerCaches 供账号页同步 rotate_* 字段'
  );
  const start = SERVICE_TS.indexOf('setPeerCaches: (c) =>');
  assert.ok(start > -1, '未找到 setPeerCaches 实现');
  const seg = SERVICE_TS.slice(start, start + 260);
  assert.ok(seg.includes('rotateModeCache = c.rotateMode'), 'setPeerCaches 必须同步 rotateModeCache');
  assert.ok(seg.includes('rotateCountCache = c.rotateCount'), 'setPeerCaches 必须同步 rotateCountCache');
});

test('（原 change 事件闪回根因的对等断言）SettingsPage 只在挂载时回读磁盘一次', () => {
  // 旧根因：accounts.js 把「读盘+回写控件」的 syncRotationPolicyCard 挂在 change 上，
  // 用户选择被立刻改回旧值。新版 React：表单为纯 state，loadFromDisk 只在挂载回填用一次。
  const calls = SETTINGS_TSX.match(/store\.loadFromDisk\(\)/g) || [];
  assert.equal(calls.length, 1, `store.loadFromDisk() 应只出现一次（挂载回填），实际 ${calls.length} 次`);
  assert.ok(
    !SETTINGS_TSX.includes('getAppSettings'),
    'SettingsPage 不得直接调用 getAppSettings（所有磁盘读取收敛在 settingsService.persist/loadFromDisk 内）'
  );
});

test('（原热读契约的对等断言）新版源码不得再声称需重启服务生效', () => {
  // 内核已改为热读 settings.json，UI 不得再提示「需重启服务生效」
  for (const [name, src] of [['SettingsPage.tsx', SETTINGS_TSX], ['settingsService.ts', SERVICE_TS], ['zh-CN.ts', ZH_CN]]) {
    assert.ok(
      !src.includes('需重启服务生效'),
      `${name} 仍提示需重启——热读模式下应当即时生效`
    );
  }
  // 模型清单模式说明明确写了内核热读
  assert.ok(
    /'settings\.modelListModeHint':\s*'[^']*内核热读/.test(ZH_CN),
    'modelListModeHint 应明确「内核热读生效」'
  );
});

test('converter.py 实现 settings.json 热读（免重启生效）', () => {
  assert.ok(CONVERTER_PY.includes('def load_app_settings('), '缺少 load_app_settings 热读函数');
  assert.ok(CONVERTER_PY.includes('_settings_sig'), '缺少 mtime+size 签名缓存机制');
  // rotator 必须以磁盘配置为准，CLI 仅兜底
  const start = CONVERTER_PY.indexOf('def _get_rotator()');
  assert.ok(start > -1, '未找到 _get_rotator');
  const block = CONVERTER_PY.slice(start, start + 1200);
  assert.ok(block.includes('load_app_settings()'), '_get_rotator 必须热读 settings.json');
  assert.ok(
    block.indexOf('load_app_settings()') < block.indexOf('CONFIG.get("rotate_mode")'),
    'settings.json 必须优先于 CLI 参数（顺序反了会退回需重启的旧行为）'
  );
});
