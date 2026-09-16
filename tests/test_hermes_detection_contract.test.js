// Hermes 接入检测契约测试（2026-09-16）
//
// 背景（真实线上问题）：用户在 Hermes 里把反代登记为 `providers.workbuddy2api`
// （含全部模型），但顶层 `model.provider` 指向另一个订阅（opencode-free）、
// 且 `model.base_url` 为空。旧检测逻辑只读顶层 model 段 → 回退到 `providers`
// 按 provider 名字找同名键 → 找不到 → 判定「未配置」，而实际当前会话就跑在这条反代上。
//
// 本测试锁定三件事：
//   1. Rust 侧确实实现了对 providers / model_aliases / custom_providers 的扫描；
//   2. 判据带**端口比对**（本机另有回环服务如 18080，仅凭「回环 + /v1」会误报）；
//   3. 前端读取的返回字段名与 Rust 序列化结果一致（snake_case）——
//      本仓库历史上多次出现「把 Rust 形参名/IPC 键名搞混」的缺陷，这里显式锁死。

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const agentsRs = readFileSync(join(root, 'src-tauri', 'src', 'commands', 'agents.rs'), 'utf8');
const agentsJs = readFileSync(join(root, 'src', 'agents.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

test('Hermes 检测覆盖 providers / model_aliases / custom_providers 三个落点', () => {
  // 三个落点必须都被扫描：真实配置用的是 providers.<name>，而 model_aliases 是
  // 本项目引导用户写入的别名写法，custom_providers 是旧版写法（需保持兼容）。
  for (const key of ['"providers"', '"model_aliases"', '"custom_providers"']) {
    assert.ok(
      agentsRs.includes(`map_value(root, ${key})`),
      `检测逻辑必须扫描 ${key}（否则该写法下会误报「未配置」）`
    );
  }
});

test('接入判据包含端口比对，避免把别的回环服务认作本工具', () => {
  // 仅凭「回环主机 + /v1」不够：本机可能同时跑着别的网关（实测 18080）。
  // 必须把端口与本工具配置比对。
  assert.ok(
    /port\.unwrap_or\(80\)\s*!=\s*our_port/.test(agentsRs),
    '缺少端口比对 —— 其它回环 /v1 服务会被误判为本工具反代'
  );
  // 端口不能写死：必须来自调用方/本工具配置
  assert.ok(
    /fn is_our_proxy_url\(raw: &str, our_port: Option<u16>\)/.test(agentsRs),
    '端口应作为参数传入（可配置），不得在函数内写死'
  );
});

test('「已接入」判定在 proxy_registered 为真时成立（顶层 base_url 为空也要点亮）', () => {
  // 直接回归线上场景：顶层 model.base_url 为空、反代在 providers 里 → 必须算已接入。
  const fn = agentsRs.slice(agentsRs.indexOf('fn hermes_is_configured'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.ok(
    /if snapshot\.proxy_registered\s*\{\s*return true;/.test(body),
    'hermes_is_configured 必须优先采信 proxy_registered'
  );
});

test('返回字段是 snake_case，与前端读取的键名一致', () => {
  // Rust 侧结构体无 rename_all 时按字段名原样序列化（snake_case）。
  assert.ok(
    /pub hermes_proxy_base_url: String/.test(agentsRs),
    'Rust 侧应有 hermes_proxy_base_url 字段'
  );
  assert.ok(
    agentsJs.includes('res.hermes_proxy_base_url'),
    '前端必须读 snake_case 的 hermes_proxy_base_url'
  );
  assert.ok(
    !agentsJs.includes('res.hermesProxyBaseUrl'),
    '前端不得读 camelCase —— 返回值不经 tauri-macros 驼峰化，写成驼峰会静默取到 undefined'
  );
  // 既有的两个字段同样锁死，防止有人「顺手统一成驼峰」
  assert.ok(agentsJs.includes('res.hermes_configured'));
  assert.ok(agentsJs.includes('res.hermes_config_path'));
});

test('UI 展示接入点，便于用户核对命中的地址', () => {
  assert.ok(
    html.includes('id="hermes-proxy-url"'),
    'index.html 应有接入点展示元素'
  );
  assert.ok(
    agentsJs.includes("getElementById('hermes-proxy-url')"),
    'agents.js 应写入该元素'
  );
});
