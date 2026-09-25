/**
 * 局域网访问与监听地址契约测试（React+TS 迁移版；第六轮：对标 EasyCLIProxyAPI 的 get_lan_ipv4 / 网络设置）
 *
 * 背景：内核支持 --host（默认 127.0.0.1，非回环时强制要求 --api-key 或
 * --unsafe-expose 显式确认），但 GUI **从不传 --host**，用户也无法在界面
 * 查看局域网 IP——「手机/其他设备连本机反代」这一常见诉求完全无入口。
 *
 * 安全铁律：把服务暴露到局域网属高风险操作，必须
 *   1) 显式开关（默认关闭，保持回环）
 *   2) 无密钥时拒绝开启（内核会 exit 1，前端应提前拦截并引导）
 *   3) UI 明确警示风险并展示可复制的局域网地址
 *
 * 迁移映射：
 * - 旧 index.html 的 chk-lan-access / lan-address → 新 SettingsPage.tsx 的
 *   onToggleLan / lanEnabled / lanAddressText / probeLanIp（文案经 t() 走 i18n 词典）；
 * - 旧 settings.js 的 listen_host 逻辑 → 新 onToggleLan + saveField({ listen_host: host })；
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
const ZH_CN = JS('src/i18n/zh-CN.ts');

test('前置事实：内核支持 --host 且非回环无密钥时拒绝启动', () => {
  assert.ok(CONVERTER.includes('"--host"'), 'converter.py 缺少 --host 参数');
  // 非回环 + 无 api_key + 无 unsafe_expose → sys.exit(1)
  const seg = CONVERTER.match(/if not args\.api_key and not args\.unsafe_expose:[\s\S]{0,600}/)?.[0] || '';
  assert.ok(
    seg.includes('sys.exit(1)'),
    '内核应在非回环且无鉴权时拒绝启动（安全拒绝），这是前端必须配合的前提'
  );
});

test('Rust 侧提供局域网 IPv4 探测命令', () => {
  assert.ok(
    /pub fn lan_ipv4/.test(PROXY_RS),
    '缺少局域网 IPv4 探测命令 lan_ipv4（无法向用户展示可连接的地址）'
  );
  assert.ok(
    LIB_RS.includes('commands::lan_ipv4'),
    '命令未注册到 invoke_handler'
  );
});

test('AppConfig 承载 listen_host 且默认回环（安全默认）', () => {
  assert.ok(/pub listen_host: String/.test(LIB_RS), 'AppConfig 缺少 listen_host 字段');
  const idx = LIB_RS.indexOf('pub listen_host: String');
  assert.ok(
    LIB_RS.slice(Math.max(0, idx - 160), idx).includes('#[serde(default'),
    'listen_host 需带 serde(default) 保证旧配置兼容'
  );
  // 默认值必须是回环（绝不能默认暴露到网络）——按函数体边界取值，容忍注释行
  const fnStart = LIB_RS.indexOf('fn default_listen_host()');
  assert.ok(fnStart > -1, '缺少 default_listen_host');
  const fnBody = LIB_RS.slice(fnStart, LIB_RS.indexOf('}', fnStart));
  assert.ok(
    fnBody.includes('"127.0.0.1"'),
    'default_listen_host 必须返回 127.0.0.1——默认值绝不能是 0.0.0.0'
  );
  assert.ok(
    !fnBody.includes('0.0.0.0'),
    'default_listen_host 不得包含 0.0.0.0'
  );
});

test('proxy_start 透传 --host 并做安全守卫（非回环无密钥拒绝）', () => {
  assert.ok(PROXY_RS.includes('"--host"'), 'proxy.rs 未透传 --host');
  // 安全属性：非回环 + 无密钥 → 必须拒绝启动（而非静默透传给内核 exit 1，
  // 也刻意不提供 --unsafe-expose 放行开关——GUI 不应鼓励无鉴权暴露）
  assert.ok(
    /is_loopback/.test(PROXY_RS),
    '--host 透传处需回环判定逻辑'
  );
  const guard = PROXY_RS.match(/if\s+!is_loopback[\s\S]{0,400}/)?.[0] || '';
  assert.ok(
    guard.includes('return Err'),
    '非回环且无密钥时必须 return Err 拒绝启动（不能只靠内核 exit 1，用户无从判断原因）'
  );
  assert.ok(
    /api_key\.is_empty\(\)/.test(guard),
    '守卫条件必须包含「密钥为空」判定'
  );
});

test('前端设置页提供局域网访问开关与地址展示', () => {
  // 开关本体：checked={lanEnabled} 的 checkbox + onToggleLan
  assert.ok(
    SETTINGS_TSX.includes('checked={lanEnabled}'),
    'SettingsPage 缺少局域网访问开关（checked={lanEnabled}）'
  );
  assert.ok(
    /const lanEnabled = form\.listenHost === '0\.0\.0\.0'/.test(SETTINGS_TSX),
    '开关状态必须由 listenHost === 0.0.0.0 派生'
  );
  // 地址展示：lanAddressText（含可复制的 http://<lan-ip>:<port>/v1）
  assert.ok(
    SETTINGS_TSX.includes('lanAddressText'),
    'SettingsPage 缺少局域网地址展示（lanAddressText）'
  );
  assert.ok(
    /`http:\/\/\$\{lanIp\}:\$\{form\.port\}\/v1`/.test(SETTINGS_TSX),
    '地址展示必须拼出 http://<lan-ip>:<port>/v1'
  );
  // 地址来自 Rust lan_ipv4 探测命令
  assert.ok(
    SETTINGS_TSX.includes('lanIpv4'),
    'SettingsPage 必须经 lanIpv4() 探测局域网地址'
  );
  assert.ok(
    /const ip = await lanIpv4\(\)/.test(SETTINGS_TSX),
    'probeLanIp 必须调用 lanIpv4()'
  );
  // 风险警示：t('settings.lanHint') 接在开关下方，词典文案必须点出风险与密钥要求
  assert.ok(
    SETTINGS_TSX.includes("t('settings.lanHint')"),
    '开关附近必须渲染风险警示 t(\'settings.lanHint\')'
  );
  const hint = /'settings\.lanHint':\s*'((?:[^'\\]|\\.)*)'/.exec(ZH_CN)?.[1] || '';
  assert.ok(hint, 'i18n 词典缺少 settings.lanHint');
  assert.ok(
    /风险/.test(hint) && /0\.0\.0\.0/.test(hint) && /密钥/.test(hint),
    `lanHint 必须点出风险、0.0.0.0 与密钥要求（实际: ${hint.slice(0, 60)}…）`
  );
});

test('前端逻辑：无密钥时不允许开启局域网访问', () => {
  // onToggleLan 开启前必须校验密钥（防止内核拒绝启动后用户一头雾水）
  const start = SETTINGS_TSX.indexOf('const onToggleLan = async');
  assert.ok(start > -1, '未找到 onToggleLan');
  const seg = SETTINGS_TSX.slice(start, start + 900);
  assert.ok(
    /if\s*\(checked\s*&&\s*!form\.apiKey\.trim\(\)\)/.test(seg),
    '开启局域网访问前必须校验已设置密钥（无密钥时提前拦截）'
  );
  assert.ok(
    seg.includes("t('settings.lanNeedApiKey')"),
    '无密钥拦截必须给出引导提示 lanNeedApiKey'
  );
  // listen_host 必须走 dirty patch 落盘（整对象覆盖写盘）
  assert.ok(
    /saveField\(\s*\{\s*listen_host:\s*host\s*\}/.test(seg),
    'listen_host 必须以 saveField({ listen_host: host }) 显式声明 dirty 字段，否则被 serde default 抹回 127.0.0.1'
  );
  assert.ok(
    /const host = checked \? '0\.0\.0\.0' : '127\.0\.0\.1'/.test(seg),
    '开关必须映射为 0.0.0.0（开）/ 127.0.0.1（关）'
  );
});
