/**
 * IPC 契约与 CSP 回归测试（前端迁移版，2026-09-26）
 *
 * 三类缺陷的共同点：静态源码断言测不到，却影响真实功能。
 *  ① 内联 onclick 在 Tauri 打包后的 CSP（script-src 'self'，无 unsafe-inline/nonce）下被阻断
 *  ② Tauri 命令参数默认走 camelCase（tauri-macros 的 ArgumentCase::Camel +
 *     key.to_lower_camel_case()），前端写 snake_case 时 Option 形参被静默填 None，不报错
 *  ③ 消费了后端不存在的字段 → 恒为 0 的静默错误
 *
 * 前端迁移说明：
 *  - 旧断言读 src/*.js 与 index.html；新前端交互全部经 src/services/tauri.ts 的
 *    invokeTauri 收口（37 处），本文件聚焦该收口 + tauri.conf.json 的 CSP。
 *  - React 的 onClick={} 是 JSX 属性绑定，经构建编译，不属于 CSP 禁止的 HTML
 *    内联事件处理器；故 CSP 用例只约束 index.html（唯一的真实 HTML）与
 *    tauri.conf.json 的 script-src。
 *  - 旧「空账号态 CTA 容器级查询绑定」：新版空账号态只有提示卡（accounts.noAccounts），
 *    无前往授权 CTA，旧契约无对等物，已移除。
 *  - 旧 hourly 桶字段缺陷已在 Rust 侧修复（桶含 ts/requests/ok/failed/input_tokens/
 *    output_tokens），本文件保留「前端消费字段 ⊆ 后端产出字段」的对拍。
 *  - 「交互只走 Tauri IPC、禁直接 HTTP fetch」：新 TS 源码中唯一形如 fetch( 的是
 *    logsService.ts 的 startLogsPolling(onLogs, fetch) —— fetch 是 () => Promise<string>
 *    形参（注入的日志拉取函数），不是全局 HTTP fetch。断言正则必须排除无参调用，
 *    只禁「带参 fetch(」（即真实的网络请求形态）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTsComments } from './helpers/strip-ts-comments.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const readTs = (p) => stripTsComments(read(p));

const TAURI = readTs('src/services/tauri.ts');
const INDEX_HTML = read('index.html');
const TAURI_CONF = read('src-tauri/tauri.conf.json');
const PROXY_RS = read('src-tauri/src/commands/proxy.rs');

// 新 TS 源码树（旧 src/*.js 已是迁移中的死代码，不在约束范围内）。
// 从目录动态枚举：新增 service 文件自动纳入约束，删除文件不会导致用例 ENOENT。
const TS_FILES = fs.readdirSync(path.join(ROOT, 'src/services'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => `src/services/${f}`)
  .concat(
    fs.readdirSync(path.join(ROOT, 'src/pages'))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => `src/pages/${f}`),
    fs.readdirSync(path.join(ROOT, 'src/components'))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => `src/components/${f}`),
    fs.readdirSync(path.join(ROOT, 'src/state'))
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => `src/state/${f}`),
  );

// ---------------------------------------------------------------------------
// ① CSP：内联事件处理器在打包应用里不可用
// ---------------------------------------------------------------------------

test('CSP: script-src 不含 unsafe-inline（本文件断言的前提）', () => {
  const csp = JSON.parse(TAURI_CONF).app.security.csp;
  const scriptSrc = csp.split('script-src')[1].split(';')[0];
  assert.ok(
    !/'unsafe-inline'/.test(scriptSrc),
    'CSP 的 script-src 不得含 unsafe-inline（否则本测试前提失效，需重新评估）'
  );
  assert.ok(
    !/nonce/.test(scriptSrc) && !INDEX_HTML.includes('__TAURI_SCRIPT_NONCE__'),
    'CSP 前提变化：出现了 nonce 机制，需重新评估内联 handler 豁免'
  );
});

test('CSP: index.html 不得出现内联事件属性', () => {
  // index.html 是唯一的真实 HTML；React 组件的 onClick={} 是 JSX 绑定，
  // 经构建编译，不属于此处禁止的 HTML 内联事件处理器。
  const INLINE_EVENT_ATTR = /\son(?:click|change|input|submit|load|error)\s*=/;
  assert.ok(
    !INLINE_EVENT_ATTR.test(INDEX_HTML),
    'index.html 含内联事件属性；CSP script-src \'self\' 下会被阻断'
  );
});

// ---------------------------------------------------------------------------
// ② IPC 参数名：Tauri 命令默认 camelCase
// ---------------------------------------------------------------------------

test('usage_events 必须以 camelCase 传 pageSize/sinceMs（Rust 形参 page_size/since_ms）', () => {
  // tauri.ts 收口：usageEvents(params: { page, pageSize, sinceMs?, ... })
  assert.ok(
    /export const usageEvents = \(params: \{[\s\S]*?pageSize: number;[\s\S]*?sinceMs\?: number;/.test(TAURI),
    'tauri.ts 的 usageEvents 参数类型未用 camelCase 的 pageSize/sinceMs'
  );
  const callIdx = TAURI.indexOf("invokeTauri<UsageEventsResult>('usage_events'");
  assert.ok(callIdx > 0, 'tauri.ts 未找到 usage_events 调用');
  const payload = TAURI.slice(callIdx, callIdx + 400);
  assert.ok(
    /pageSize: params\.pageSize/.test(payload),
    'usage_events 载荷未传 pageSize'
  );
  assert.ok(
    /sinceMs: params\.sinceMs/.test(payload),
    'usage_events 载荷未传 sinceMs'
  );
  assert.ok(
    !/since_ms|page_size/.test(payload),
    'usage_events 载荷出现 snake_case：Tauri 宏未声明 rename_all 时按 camelCase 取键，'
      + '写成 snake_case 会被 Option 静默填 None（时间范围筛选完全失效）'
  );
  // 调用链上游同样走 camelCase
  const USAGE_SVC = readTs('src/services/usageService.ts');
  assert.ok(
    /pageSize: USAGE_EVENTS_PAGE_SIZE/.test(USAGE_SVC) && /sinceMs: rangeToSinceMs\(range\)/.test(USAGE_SVC),
    'usageService 未以 camelCase 组装 usage_events 参数'
  );
});

test('snapshot_replay 必须以 camelCase 传 apiKey（Rust 形参 api_key）', () => {
  // 注意：读配置对象时的 cfg.api_key 是 AppConfig 字段（snake_case 正确），
  // 只约束 invoke 的载荷键名。
  const invokeCall = /invokeTauri<SnapshotReplayResult>\('snapshot_replay',\s*\{([^}]*)\}\)/.exec(TAURI);
  assert.ok(invokeCall, 'tauri.ts 未找到 snapshot_replay 调用');
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

test('所有后端调用经 invokeTauri 收口（不得绕过类型化收口直调 invoke）', () => {
  // tauri.ts 内除 invokeTauri 定义处外，不得出现裸 invoke< 调用：
  // 收口承载非 Tauri 环境安全失败与 mock 日志约束，绕过即失去保护。
  const withoutDef = TAURI.replace(/export async function invokeTauri[\s\S]*?\n\}/, '');
  assert.ok(
    !/[^a-zA-Z]invoke</.test(withoutDef),
    'tauri.ts 存在绕过 invokeTauri 的裸 invoke 调用'
  );
  // 收口函数的非 Tauri 分支抛错（调用方据此展示环境横幅并安全失败）
  assert.ok(
    /throw new Error\(NOT_IN_TAURI_MESSAGE\)/.test(TAURI),
    'invokeTauri 非 Tauri 分支未抛 NOT_IN_TAURI_MESSAGE'
  );
});

// ---------------------------------------------------------------------------
// ③ 交互只走 Tauri IPC：禁直接 HTTP fetch
// ---------------------------------------------------------------------------

test('新前端不得直接发起 HTTP fetch（后端交互只走 Tauri IPC）', () => {
  // 形态：fetch( 后跟参数 = 真实的网络请求；fetch() 无参调用是 logsService
  // 注入的形参（() => Promise<string>），必须排除（见文件头说明）。
  for (const f of TS_FILES) {
    const src = readTs(f);
    const directFetch = /fetch\((?!\s*\))/.test(src);
    assert.ok(
      !directFetch,
      `${f} 存在带参 fetch( 调用：后端交互必须走 Tauri IPC，不得直接发 HTTP`
    );
    assert.ok(
      !/new XMLHttpRequest/.test(src),
      `${f} 使用了 XMLHttpRequest：后端交互必须走 Tauri IPC`
    );
  }
});

// ---------------------------------------------------------------------------
// ④ hourly 桶字段契约：前端只能消费后端实际产出的字段
// ---------------------------------------------------------------------------

test('hourly 桶字段契约：前端累加的字段必须由 Rust 侧实际产出', () => {
  // 历史缺陷：summarizeClipped 累加 h.ok/h.failed/h.input_tokens，而旧 Rust
  // aggregate_usage 的 hourly 桶只有 {ts, requests, output_tokens} → 统计卡恒显示
  // 「成功 0 · 失败 0」且输入 token 少算。现 Rust 侧已补齐桶字段，
  // 本用例锁定「消费 ⊆ 产出」，防再次漂移。
  const aggStart = PROXY_RS.indexOf('fn aggregate_usage');
  assert.ok(aggStart > -1, '未找到 aggregate_usage');
  const agg = PROXY_RS.slice(aggStart, PROXY_RS.indexOf('\n}\n', aggStart));

  const hourlyStart = agg.indexOf('let hourly');
  assert.ok(hourlyStart > -1, '未找到 hourly 桶构造');
  const bucketJson = agg.slice(hourlyStart, agg.indexOf('.collect()', hourlyStart));

  const USAGE_SVC = readTs('src/services/usageService.ts');
  const sumStart = USAGE_SVC.indexOf('export function summarizeClipped');
  assert.ok(sumStart > -1, '未找到 summarizeClipped');
  const sumBlock = USAGE_SVC.slice(sumStart, USAGE_SVC.indexOf('\n}', sumStart));

  // 前端 summarizeClipped 读取的每个 h.<field> 都必须出现在桶 JSON 里
  const consumed = [...sumBlock.matchAll(/h\.([a-z_]+)/g)].map((m) => m[1]);
  const uniqueConsumed = [...new Set(consumed)];
  assert.ok(uniqueConsumed.length >= 3, `summarizeClipped 解析出的字段过少：${uniqueConsumed.join(', ')}`);

  for (const field of uniqueConsumed) {
    assert.ok(
      bucketJson.includes(`"${field}"`),
      `hourly 桶缺字段 "${field}"：前端 summarizeClipped 会读到 undefined（静默归零）`
    );
  }
});
