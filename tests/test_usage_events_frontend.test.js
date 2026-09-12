/**
 * 前端体验补齐契约测试（第三轮：用量明细下钻）
 *
 * 对标 EasyCLIProxyAPI v0.2.90 的 UsageRecordsPage 五子 Tab 能力，
 * 本轮落地「明细事件」维度：
 *   - usage_events 命令暴露（模型子串/状态/起始时间 + 分页）
 *   - 前端明细表：筛选、分页、失败原因/降级链路展示
 *   - 按模型分组分析视图
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS = (p) => readFileSync(join(ROOT, p), 'utf8');

const USAGE_JS = JS('src/usage.js');
const INDEX_HTML = JS('index.html');
const PROXY_RS = JS('src-tauri/src/commands/proxy.rs');
const LIB_RS = JS('src-tauri/src/lib.rs');

test('前置事实：内核 usage.jsonl 已写 model/error/fallback 等明细字段', () => {
  const CONVERTER = JS('converter.py');
  for (const field of ['"model"', '"error"', '"retry_count"', 'fallback_reason', 'requested_model']) {
    assert.ok(
      CONVERTER.includes(field),
      `converter.py 未写入 ${field} 字段，usage_events 明细将不完整`
    );
  }
});

test('Rust 侧暴露 usage_events 命令并注册到 invoke_handler', () => {
  assert.ok(
    PROXY_RS.includes('pub fn usage_events('),
    'proxy.rs 未暴露 usage_events 命令'
  );
  assert.ok(
    PROXY_RS.includes('fn query_usage_events('),
    'proxy.rs 缺少 query_usage_events 组装函数'
  );
  assert.ok(
    LIB_RS.includes('commands::usage_events'),
    'lib.rs invoke_handler 未注册 usage_events'
  );
});

test('Rust 侧支持模型子串过滤 + 状态过滤 + 分页（含越界与脏入参防御）', () => {
  assert.ok(
    /fn filter_usage_records['<]/.test(PROXY_RS),
    'proxy.rs 缺少 filter_usage_records'
  );
  assert.ok(
    /fn paginate_usage_refs['<]/.test(PROXY_RS),
    'proxy.rs 缺少 paginate_usage_refs'
  );
  // 大小写不敏感子串匹配
  assert.ok(
    /to_lowercase\(\)\.contains|contains\(n\.as_str\(\)\)/.test(PROXY_RS),
    '模型过滤应支持大小写不敏感子串匹配'
  );
  // 默认分页 50/页
  assert.ok(
    PROXY_RS.includes('unwrap_or(50)'),
    '默认 page_size 应为 50（对齐 EasyCLIProxyAPI）'
  );
});

test('Rust 侧提供按模型分组分析且在过滤后全集上计算', () => {
  assert.ok(
    PROXY_RS.includes('fn group_usage_by_model('),
    'proxy.rs 缺少 group_usage_by_model'
  );
  assert.ok(
    PROXY_RS.includes('"analysis"'),
    'usage_events 响应应含 analysis 字段'
  );
});

test('前端用量页提供明细筛选控件（模型/状态）', () => {
  assert.ok(
    INDEX_HTML.includes('usage-events-model') || INDEX_HTML.includes('input-usage-model'),
    'index.html 缺少模型筛选输入框'
  );
  assert.ok(
    INDEX_HTML.includes('select-usage-status'),
    'index.html 缺少状态筛选下拉框'
  );
});

test('前端用量页提供明细分页与明细表容器', () => {
  assert.ok(
    INDEX_HTML.includes('usage-events-body') || INDEX_HTML.includes('usage-events-table'),
    'index.html 缺少明细表容器'
  );
  assert.ok(
    INDEX_HTML.includes('usage-page-prev') && INDEX_HTML.includes('usage-page-next'),
    'index.html 缺少分页按钮'
  );
  assert.ok(
    INDEX_HTML.includes('usage-page-info'),
    'index.html 缺少页码信息展示位'
  );
});

test('usage.js 调用 usage_events 并渲染明细（失败原因/降级链路）', () => {
  assert.ok(
    USAGE_JS.includes("invokeTauri('usage_events'"),
    "usage.js 未调用 usage_events 命令"
  );
  assert.ok(
    USAGE_JS.includes('renderUsageEvents') || USAGE_JS.includes('loadUsageEvents'),
    'usage.js 缺少明细渲染/加载函数'
  );
  // 失败原因与降级链路要有展示
  assert.ok(
    USAGE_JS.includes('fallback_reason') || USAGE_JS.includes('requested_model'),
    'usage.js 未展示降级链路（requested → actual）'
  );
  // XSS 防护：动态插值必须走 esc()
  assert.ok(
    /esc\(/.test(USAGE_JS),
    'usage.js 明细渲染必须使用 esc() 转义'
  );
});

test('usage.js 明细分页防竞态并复用范围选择器', () => {
  assert.ok(
    /_usageEventsSeq|_eventsSeq/.test(USAGE_JS),
    'usage.js 明细分页缺少请求序号防竞态'
  );
  assert.ok(
    USAGE_JS.includes('readUsageRange') && /rangeToSinceMs|since_ms/.test(USAGE_JS),
    'usage.js 明细查询应复用时间范围选择器换算 since_ms'
  );
});
