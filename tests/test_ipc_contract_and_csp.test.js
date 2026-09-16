/**
 * IPC 契约与 CSP 回归测试（2026-09-16 前端审计修复）
 *
 * 三类缺陷的共同点：静态源码断言测不到，却影响真实功能。
 *  ① 内联 onclick 在 Tauri 打包后的 CSP（script-src 'self'，无 unsafe-inline/nonce）下被阻断
 *  ② Tauri 命令参数默认走 camelCase（tauri-macros 的 ArgumentCase::Camel +
 *     key.to_lower_camel_case()），前端写 snake_case 时 Option 形参被静默填 None，不报错
 *  ③ 消费了后端不存在的字段 → 恒为 0 的静默错误
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const ACCOUNTS_JS = read('src/accounts.js');
const USAGE_JS = read('src/usage.js');
const DEBUG_JS = read('src/debug.js');
const INDEX_HTML = read('index.html');
const TAURI_CONF = read('src-tauri/tauri.conf.json');

// ---------------------------------------------------------------------------
// ① CSP：内联事件处理器在打包应用里不可用
// ---------------------------------------------------------------------------

test('CSP: 全前端不得出现内联事件属性（script-src 不含 unsafe-inline/nonce）', () => {
  // 约束源：打包 CSP 为 script-src 'self'；index.html 无 __TAURI_SCRIPT_NONCE__ token，
  // 故 Tauri 不会注入 nonce —— 内联 handler 无任何豁免来源。
  const csp = JSON.parse(TAURI_CONF).app.security.csp;
  assert.ok(
    !/'unsafe-inline'/.test(csp.split('script-src')[1].split(';')[0]),
    'CSP 的 script-src 不得含 unsafe-inline（否则本测试前提失效，需重新评估）'
  );

  const INLINE_EVENT_ATTR = /\son(?:click|change|input|submit|load|error)\s*=/;
  for (const [name, src] of [
    ['src/accounts.js', ACCOUNTS_JS],
    ['src/models.js', read('src/models.js')],
    ['src/settings.js', read('src/settings.js')],
    ['src/debug.js', DEBUG_JS],
    ['src/agents.js', read('src/agents.js')],
    ['index.html', INDEX_HTML],
  ]) {
    assert.ok(
      !INLINE_EVENT_ATTR.test(src),
      `${name} 含内联事件属性；CSP script-src 'self' 下会被阻断，须改 addEventListener/事件委托`
    );
  }
});

test('空账号态 CTA 必须用容器级查询 + 监听绑定（不得依赖内联 onclick）', () => {
  assert.ok(
    ACCOUNTS_JS.includes('btn-empty-goto-oauth'),
    'accounts.js 空账号态 CTA 缺少稳定 id（btn-empty-goto-oauth），无法以 addEventListener 绑定'
  );
  assert.ok(
    /container\.querySelector\('#btn-empty-goto-oauth'\)/.test(ACCOUNTS_JS),
    '空账号态 CTA 必须在 container 作用域内查询绑定（与 btn-refresh-account-quota 同一约定）'
  );
});

// ---------------------------------------------------------------------------
// ② IPC 参数名：Tauri 命令默认 camelCase
// ---------------------------------------------------------------------------

test('usage_events 必须以 camelCase 传 pageSize/sinceMs（Rust 形参 page_size/since_ms）', () => {
  assert.ok(
    !/since_ms|page_size/.test(USAGE_JS),
    'usage.js 不得出现 since_ms/page_size：Tauri 宏未声明 rename_all 时按 camelCase 取键，'
      + '写成 snake_case 会被 Option 静默填 None（时间范围筛选完全失效）'
  );
  assert.ok(USAGE_JS.includes('pageSize'), 'usage.js 明细分页应传 pageSize');
  assert.ok(USAGE_JS.includes('sinceMs'), 'usage.js 时间筛选应传 sinceMs');
});

test('snapshot_replay 必须以 camelCase 传 apiKey（Rust 形参 api_key）', () => {
  // 注意：读取配置对象时的 cfg.api_key 是 AppConfig 字段（snake_case 正确），
  // 只约束 invoke 的载荷键名。
  const invokeCall = /invokeTauri\(\s*'snapshot_replay'\s*,\s*\{([^}]*)\}/.exec(DEBUG_JS);
  assert.ok(invokeCall, 'debug.js 未找到 snapshot_replay 调用');
  const payload = invokeCall[1];

  assert.ok(
    /\bapiKey\b/.test(payload),
    'snapshot_replay 载荷必须用 apiKey；写 api_key 时 Option 静默为 None，'
      + '配了客户端密钥后重放必 401'
  );
  assert.ok(
    !/\bapi_key\s*:/.test(payload),
    'snapshot_replay 载荷不得使用 snake_case 键 api_key'
  );
});

// ---------------------------------------------------------------------------
// ③ hourly 桶字段契约：前端只能消费后端实际产出的字段
// ---------------------------------------------------------------------------

test('hourly 桶字段契约：前端累加的字段必须由 Rust 侧实际产出', () => {
  // 历史缺陷：summarizeClipped 累加 h.ok/h.failed/h.input_tokens，而 Rust aggregate_usage
  // 的 hourly 桶只有 {ts, requests, output_tokens} → 统计卡恒显示「成功 0 · 失败 0」
  // 且输入 token 少算。修复方向为在 Rust 侧补齐桶字段（保住「统计卡随范围裁剪」语义）。
  const PROXY_RS = read('src-tauri/src/commands/proxy.rs');

  const aggStart = PROXY_RS.indexOf('fn aggregate_usage');
  assert.ok(aggStart > -1, '未找到 aggregate_usage');
  const agg = PROXY_RS.slice(aggStart, PROXY_RS.indexOf('\n}\n', aggStart));

  const hourlyStart = agg.indexOf('let hourly');
  assert.ok(hourlyStart > -1, '未找到 hourly 桶构造');
  const bucketJson = agg.slice(hourlyStart, agg.indexOf('.collect()', hourlyStart));

  const jsStart = USAGE_JS.indexOf('function summarizeClipped');
  const jsBlock = USAGE_JS.slice(jsStart, USAGE_JS.indexOf('\n}', jsStart));

  // 前端 summarizeClipped 读取的每个 h.<field> 都必须出现在桶 JSON 里
  const consumed = [...jsBlock.matchAll(/h\.([a-z_]+)/g)].map((m) => m[1]);
  const uniqueConsumed = [...new Set(consumed)];
  assert.ok(uniqueConsumed.length >= 3, `summarizeClipped 解析出的字段过少：${uniqueConsumed.join(', ')}`);

  for (const field of uniqueConsumed) {
    assert.ok(
      bucketJson.includes(`"${field}"`),
      `hourly 桶缺字段 "${field}"：前端 summarizeClipped 会读到 undefined（静默归零）`
    );
  }
});
