/**
 * 局域网访问语义准确性测试（React+TS 迁移版；P2-2，2026-09-12 外部评审）
 *
 * 背景：GUI 的「允许局域网访问」实际传的是 --host 0.0.0.0，这**不是**「只开放局域网」，
 * 而是绑定**所有网卡**——Wi-Fi / 有线 / VPN / 虚拟网卡（VMware、Hyper-V、WSL、
 * Docker）/ 任何可达接口理论上都会暴露该端口。
 *
 * 现有 API Key 强制保护使其不构成漏洞，但产品名称与实现语义不符是真实缺陷：
 * 用户以为「只给局域网内设备用」，实际可能同时暴露到 VPN 隧道的另一侧。
 *
 * 修复（本轮取最小正确解）：把 UI 文案改成与实现一致的表述
 * 「监听所有网卡（含局域网 / VPN / 虚拟网卡）」，并明确列出暴露面。
 * 未做「让用户选择具体 LAN IP」——那是产品级增强，超出 P2 修复范围，留待后续。
 *
 * 迁移映射：旧 index.html 的 lan-access-field 区块文案 → 新版文案走 i18n 词典
 * （settings.lanLabel / settings.lanHint），SettingsPage.tsx 负责接线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS = (p) => readFileSync(join(ROOT, p), 'utf8');

const SETTINGS_TSX = JS('src/pages/SettingsPage.tsx');
const ZH_CN = JS('src/i18n/zh-CN.ts');
const PROXY_RS = JS('src-tauri/src/commands/proxy.rs');
const LIB_RS = JS('src-tauri/src/lib.rs');

// 取词典中指定 key 的文案值
function dictValue(key) {
  const m = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(ZH_CN);
  assert.ok(m, `i18n 词典缺少 ${key}`);
  return m[1];
}

test('开关文案不得只写「局域网」——实际实现是绑定所有网卡', () => {
  // SettingsPage 的开关 label 接线到 t('settings.lanLabel')
  assert.ok(
    SETTINGS_TSX.includes("t('settings.lanLabel')"),
    '局域网开关 label 必须接线 t(\'settings.lanLabel\')'
  );
  const label = dictValue('settings.lanLabel');
  // 旧文案：把 0.0.0.0 等价成「局域网访问」，语义过窄
  assert.ok(
    !/允许局域网内其它设备访问（--host 0\.0\.0\.0）/.test(label),
    '开关文案仍把 0.0.0.0 表述为「局域网访问」——实际绑定所有网卡（含 VPN / 虚拟网卡），' +
      '文案会让用户低估暴露面'
  );
  assert.ok(
    /监听所有网卡/.test(label),
    `文案必须点明「监听所有网卡」，与 0.0.0.0 的真实语义一致（实际: ${label}）`
  );
  assert.ok(
    /局域网/.test(label) && /VPN/.test(label) && /虚拟网卡/.test(label),
    `文案必须如实写「监听所有网卡（含局域网 / VPN / 虚拟网卡）」，不得简化（实际: ${label}）`
  );
});

test('风险说明须点出 VPN 与虚拟网卡（用户最容易低估的暴露面）', () => {
  // 风险说明接线到 t('settings.lanHint')
  assert.ok(
    SETTINGS_TSX.includes("t('settings.lanHint')"),
    '开关附近必须渲染风险说明 t(\'settings.lanHint\')'
  );
  const hint = dictValue('settings.lanHint');
  assert.ok(
    /所有网卡/.test(hint) && /0\.0\.0\.0/.test(hint),
    `风险说明必须点明 0.0.0.0 = 所有网卡（实际: ${hint.slice(0, 60)}…）`
  );
  // label + hint 合在一起必须覆盖 VPN / 虚拟网卡这两个最易低估的暴露面
  const combined = dictValue('settings.lanLabel') + '\n' + hint;
  assert.ok(
    /VPN|虚拟网卡/.test(combined),
    '风险说明必须点出 VPN / 虚拟网卡：0.0.0.0 会绑定这些接口，不止「同一 Wi-Fi」'
  );
});

test('实现侧确认：开关确实下发 0.0.0.0（文案与实现保持一致）', () => {
  // 前端开关 → listen_host = 0.0.0.0
  assert.ok(
    /const host = checked \? '0\.0\.0\.0' : '127\.0\.0\.1'/.test(SETTINGS_TSX),
    'SettingsPage 的 LAN 开关应下发 0.0.0.0（开）/ 127.0.0.1（关）'
  );
  // Rust 侧透传 --host
  assert.ok(PROXY_RS.includes('"--host"'), 'proxy.rs 必须透传 --host');
  // 安全默认仍是回环（不得因为改文案而放松任何安全约束）
  const fnStart = LIB_RS.indexOf('fn default_listen_host()');
  assert.ok(fnStart > -1, '缺少 default_listen_host');
  const fnBody = LIB_RS.slice(fnStart, LIB_RS.indexOf('}', fnStart));
  assert.ok(
    fnBody.includes('"127.0.0.1"') && !fnBody.includes('0.0.0.0'),
    'default_listen_host 必须保持 127.0.0.1（安全默认不得放松）'
  );
});
