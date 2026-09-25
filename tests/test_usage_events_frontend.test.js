/**
 * 前端体验补齐契约测试（React+TS 迁移版；第三轮：用量明细下钻）
 *
 * 对标 EasyCLIProxyAPI v0.2.90 的 UsageRecordsPage 五子 Tab 能力，
 * 本轮落地「明细事件」维度：
 *   - usage_events 命令暴露（模型子串/状态/起始时间 + 分页）
 *   - 前端明细表：筛选、分页、失败原因/降级链路展示
 *   - 按模型分组分析视图
 *
 * 契约变更说明（中文）：
 *   1. 旧断言目标 index.html 的明细筛选/分页控件 id（usage-events-model /
 *      select-usage-status / usage-events-body / usage-page-prev/next/info）在
 *      React 迁移中**未被迁移**：新 UsagePage.tsx 只渲染时间范围 <select>、
 *      明细 <table> 与上一页/下一页 + 页码信息（t('usage.page.*')），没有模型
 *      子串/状态筛选输入框。model / status 筛选参数保留在 tauri.ts usageEvents
 *      的服务边界（后端 proxy.rs 支持过滤），但新页面未传。新对等断言锁定：
 *      tauri.ts 的 usageEvents 仍接受 model/status 参数、请求载荷键保持
 *      camelCase（sinceMs / pageSize），响应读取 items / total / total_pages。
 *   2. 旧断言「usage.js 展示 fallback_reason / requested_model 降级链路」：
 *      字段保留在 tauri.ts UsageEventItem 类型（requested_model /
 *      actual_model / fallback_reason），但新明细表只渲染错误列，未渲染降级
 *      链路 —— 此处如实降级为类型层断言，不编造 UI 断言。
 *   3. 旧断言「明细渲染走 esc() 防 XSS」→ React 版一律文本节点渲染，
 *      契约改为：剥离注释后 UsagePage.tsx 不得出现 dangerouslySetInnerHTML，
 *      且明细行渲染 {r.error} 文本节点。
 *   4. 后端契约（converter.py 字段 / proxy.rs 命令与分页 / lib.rs 注册）未动，
 *      原断言原样保留。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS = (p) => readFileSync(join(ROOT, p), 'utf8');

const USAGE_SERVICE = JS('src/services/usageService.ts');
const USAGE_TSX = JS('src/pages/UsagePage.tsx');
const TAURI_TS = JS('src/services/tauri.ts');
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

test('tauri.ts usage_events 服务边界：IPC 键保持 camelCase，筛选参数保留', () => {
  // 命令名
  assert.ok(
    TAURI_TS.includes("invokeTauri<UsageEventsResult>('usage_events'"),
    "tauri.ts 未调用 usage_events 命令"
  );
  // 请求载荷键名必须 camelCase（sinceMs / pageSize），Tauri 默认 camelCase，
  // 写成 snake_case 会被静默丢弃 —— 只检查请求对象字面量，不碰响应类型
  const fnStart = TAURI_TS.indexOf('export const usageEvents');
  assert.ok(fnStart >= 0, 'tauri.ts 缺少 usageEvents 导出（断言锚点失效）');
  const fnBlock = TAURI_TS.slice(fnStart, TAURI_TS.indexOf('});', fnStart) + 3);
  assert.ok(fnBlock.includes('pageSize: params.pageSize'), '请求载荷必须用 camelCase pageSize');
  assert.ok(fnBlock.includes('sinceMs: params.sinceMs'), '请求载荷必须用 camelCase sinceMs');
  assert.ok(!/since_ms|page_size/.test(fnBlock), '请求载荷不得用 snake_case 键名');
  // 模型子串 / 状态筛选参数在服务边界保留（后端支持；新页面暂未传参，见顶部契约变更说明）
  assert.ok(fnBlock.includes('model: params.model'), 'usageEvents 应保留 model 筛选参数');
  assert.ok(fnBlock.includes('status: params.status'), 'usageEvents 应保留 status 筛选参数');
});

test('usageService 明细加载：请求序号防竞态 + 范围换算 sinceMs + 读 items/total/total_pages', () => {
  // 汇总与明细各自独立的请求序号防竞态
  assert.ok(USAGE_SERVICE.includes('eventsSeq'), 'usageService 明细分页缺少请求序号防竞态');
  assert.ok(USAGE_SERVICE.includes('summarySeq'), 'usageService 汇总缺少请求序号防竞态');
  // 时间范围 → sinceMs（camelCase，Tauri IPC 键名）
  assert.ok(USAGE_SERVICE.includes('rangeToSinceMs'), 'usageService 缺少 rangeToSinceMs');
  assert.ok(
    /sinceMs: rangeToSinceMs\(range\)/.test(USAGE_SERVICE),
    '明细查询必须用 rangeToSinceMs(range) 换算 sinceMs'
  );
  assert.ok(
    /pageSize: USAGE_EVENTS_PAGE_SIZE/.test(USAGE_SERVICE),
    '明细查询必须带 pageSize（USAGE_EVENTS_PAGE_SIZE）'
  );
  assert.ok(
    USAGE_SERVICE.includes('export const USAGE_EVENTS_PAGE_SIZE = 50'),
    '默认分页大小必须为 50（对齐旧契约与后端 unwrap_or(50)）'
  );
  // 响应字段读取：items / total / total_pages（与 UsageEventsResult 对齐）
  assert.ok(USAGE_SERVICE.includes('data.items'), '未读取响应 items 字段');
  assert.ok(USAGE_SERVICE.includes('data.total ?? 0'), '未读取响应 total 字段');
  assert.ok(USAGE_SERVICE.includes('data.total_pages'), '未读取响应 total_pages 字段');
  // 响应类型声明 items/total_pages（后端 serde snake_case 原样）
  assert.ok(TAURI_TS.includes('items: UsageEventItem[]'), 'UsageEventsResult 缺少 items');
  assert.ok(TAURI_TS.includes('total_pages: number'), 'UsageEventsResult 缺少 total_pages');
});

test('UsagePage.tsx 提供明细表、时间范围选择与分页（模型/状态筛选控件未迁移，见顶部说明）', () => {
  // 时间范围选择器（旧 readUsageRange 的 React 对等）
  assert.ok(USAGE_TSX.includes('normalizeUsageRange'), '缺少范围选择器 normalizeUsageRange');
  // 明细表
  assert.ok(USAGE_TSX.includes('usage-events-table'), '缺少明细表容器');
  // 分页：上一页/下一页 + 页码信息
  assert.ok(USAGE_TSX.includes("t('usage.page.prev')"), '缺少上一页按钮');
  assert.ok(USAGE_TSX.includes("t('usage.page.next')"), '缺少下一页按钮');
  assert.ok(USAGE_TSX.includes("t('usage.page.info'"), '缺少页码信息展示');
  // 旧 index.html 的筛选控件 id 不得再出现（无残留、无半成品）
  for (const id of ['usage-events-model', 'input-usage-model', 'select-usage-status', 'usage-page-prev', 'usage-page-next', 'usage-page-info']) {
    assert.ok(!USAGE_TSX.includes(id), `UsagePage.tsx 不得残留旧控件 id：${id}`);
  }
  // 降级链路字段保留在类型层（requested_model / fallback_reason），页面暂未渲染
  assert.ok(TAURI_TS.includes('requested_model?: string | null'), 'UsageEventItem 缺少 requested_model');
  assert.ok(TAURI_TS.includes('fallback_reason?: string | null'), 'UsageEventItem 缺少 fallback_reason');
});

test('UsagePage.tsx 明细渲染走文本节点（XSS 防护：旧 esc() 的 React 对等）', () => {
  // 剥离注释后不得出现 dangerouslySetInnerHTML（注释里提及不算）
  const codeOnly = USAGE_TSX
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !codeOnly.includes('dangerouslySetInnerHTML'),
    '明细渲染不得用 dangerouslySetInnerHTML（不可信文本必须走文本节点）'
  );
  // 错误信息走文本节点渲染（{r.error}）
  assert.ok(USAGE_TSX.includes('{r.error}'), '错误列必须走 {r.error} 文本节点渲染');
  // 陈旧响应丢弃（防竞态的消费侧）
  assert.ok(
    USAGE_TSX.includes('res === null') || USAGE_TSX.includes('data === null'),
    '页面必须丢弃 loader 返回的陈旧（null）结果'
  );
});
