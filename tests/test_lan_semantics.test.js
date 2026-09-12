/**
 * 局域网访问语义准确性测试（P2-2，2026-09-12 外部评审）
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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS = (p) => readFileSync(join(ROOT, p), 'utf8');

const INDEX_HTML = JS('index.html');
const PROXY_RS = JS('src-tauri/src/commands/proxy.rs');

// 局域网开关所在区块（用于后续断言的局部窗口）
function lanSection() {
  const i = INDEX_HTML.indexOf('id="lan-access-field"');
  assert.ok(i > -1, 'index.html 缺少局域网访问区块 lan-access-field');
  return INDEX_HTML.slice(i, i + 2500);
}

test('开关文案不得只写「局域网」——实际实现是绑定所有网卡', () => {
  const seg = lanSection();
  // 旧文案：把 0.0.0.0 等价成「局域网访问」，语义过窄
  assert.ok(
    !/允许局域网内其它设备访问（--host 0\.0\.0\.0）/.test(seg),
    '开关文案仍把 0.0.0.0 表述为「局域网访问」——实际绑定所有网卡（含 VPN / 虚拟网卡），' +
      '文案会让用户低估暴露面'
  );
  assert.ok(
    /所有网卡/.test(seg),
    '文案必须点明「监听所有网卡」，与 0.0.0.0 的真实语义一致'
  );
});

test('风险说明须点出 VPN 与虚拟网卡（用户最容易低估的暴露面）', () => {
  const seg = lanSection();
  assert.ok(
    /VPN|虚拟网卡/.test(seg),
    '风险说明必须点出 VPN / 虚拟网卡：0.0.0.0 会绑定这些接口，不止「同一 Wi-Fi」'
  );
});

test('实现侧确认：开关确实下发 0.0.0.0（文案与实现保持一致）', () => {
  // 前端开关 → listen_host = 0.0.0.0
  const SETTINGS_JS = JS('src/settings.js');
  assert.ok(
    SETTINGS_JS.includes("'0.0.0.0'"),
    'settings.js 的 LAN 开关应下发 0.0.0.0'
  );
  // Rust 侧透传 --host
  assert.ok(PROXY_RS.includes('"--host"'), 'proxy.rs 必须透传 --host');
  // 安全默认仍是回环（不得因为改文案而放松任何安全约束）
  const LIB_RS = JS('src-tauri/src/lib.rs');
  const fnStart = LIB_RS.indexOf('fn default_listen_host()');
  assert.ok(fnStart > -1, '缺少 default_listen_host');
  const fnBody = LIB_RS.slice(fnStart, LIB_RS.indexOf('}', fnStart));
  assert.ok(
    fnBody.includes('"127.0.0.1"') && !fnBody.includes('0.0.0.0'),
    'default_listen_host 必须保持 127.0.0.1（安全默认不得放松）'
  );
});
