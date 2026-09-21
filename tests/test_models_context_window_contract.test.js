/**
 * 模型清单「上下文窗口」字段口径契约（2026-09 修复）
 *
 * 缺陷：`billing.rs` 把上游 `maxInputTokens`（硬上限）当作 `max_input_tokens` 上报，
 * 而该字段同时是控制台「默认窗口」语义 → 12 个模型把客户端默认窗口 300000 谎报成 1000000。
 * 上游 payload 里两个字段同时存在：
 *   `contextWindow.defaultLength` = 客户端默认窗口（应作为 max_input_tokens）
 *   `maxInputTokens`             = 模型硬上限（应另存 upstream_max_input_tokens）
 *
 * 前端连带约束：编辑弹窗的 `<input max>` 必须用**硬上限**，否则用户无法把窗口调到
 * 默认值以上（模型本可支持），等于把默认值当成不可逾越的天花板。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

const MODELS_JS = read('src/models.js');
const BILLING_RS = read('src-tauri/src/commands/billing.rs');

test('Rust 侧同时保留「默认窗口」与「硬上限」两个字段', () => {
  assert.ok(
    BILLING_RS.includes('pub upstream_max_input_tokens: Option<i64>'),
    'ModelMetaItem 缺少 upstream_max_input_tokens —— 硬上限会被丢弃，控制台无法再展示/放开上限'
  );
  assert.ok(
    BILLING_RS.includes('upstream_max_input_tokens: upstream_max_input'),
    '构造 ModelMetaItem 时未填 upstream_max_input_tokens'
  );
});

test('Rust 侧默认窗口优先取 contextWindow.defaultLength（缺失才回退硬上限）', () => {
  const fn = BILLING_RS.match(/fn upstream_default_window[\s\S]*?\n}/)?.[0] || '';
  assert.ok(fn, '未找到 upstream_default_window');
  assert.ok(
    fn.includes('/contextWindow/defaultLength'),
    '默认窗口必须优先读 contextWindow.defaultLength，否则又会把硬上限当默认窗口虚报'
  );
  assert.ok(
    /or_else\(\|\| upstream_hard_limit\(m\)\)/.test(fn),
    'defaultLength 缺失时必须回退硬上限（兼容未下发 contextWindow 的上游/老条目）'
  );

  const resolve = BILLING_RS.match(/fn resolve_context_windows[\s\S]*?\n}/)?.[0] || '';
  assert.ok(resolve, '未找到 resolve_context_windows');
  assert.ok(
    resolve.includes('upstream_default_window(m).unwrap_or(FALLBACK_CONTEXT_WINDOW)'),
    '两个字段都缺失时仍应回退内置默认窗口 200000（既有行为）'
  );
});

test('Rust 侧过滤 disabled === true 的模型条目', () => {
  const fn = BILLING_RS.match(/fn is_model_entry_dropped[\s\S]*?\n}/)?.[0] || '';
  assert.ok(fn, '未找到 is_model_entry_dropped');
  assert.ok(
    /get\("disabled"\)[\s\S]{0,80}as_bool\(\)[\s\S]{0,40}unwrap_or\(false\)/.test(fn),
    '必须把上游显式 disabled === true 的条目剔除（旧实现只按名字过滤 hunyuan-image-v3.0）'
  );
  assert.ok(
    BILLING_RS.includes('if is_model_entry_dropped(&m)'),
    'models_fetch_all 未接入 is_model_entry_dropped'
  );
  assert.ok(
    fn.includes('"hunyuan-image-v3.0"'),
    '历史黑名单必须保留（上游曾以未置 disabled 的形态下发该条目）'
  );
});

test('Rust 侧描述截断到 512 字符且按字符边界切', () => {
  assert.ok(
    BILLING_RS.includes('DESCRIPTION_MAX_CHARS: usize = 512'),
    '描述截断上限应为 512'
  );
  const fn = BILLING_RS.match(/fn truncate_description[\s\S]*?\n}/)?.[0] || '';
  assert.ok(fn, '未找到 truncate_description');
  assert.ok(
    fn.includes('chars()'),
    '截断必须按字符（bytes 切片会把中文/emoji 切成非法 UTF-8）'
  );
  assert.ok(
    BILLING_RS.includes('let desc = truncate_description('),
    'models_fetch_all 未对 description 做截断'
  );
});

test('前端编辑弹窗的 max 用硬上限，不再把默认窗口当天花板', () => {
  const start = MODELS_JS.indexOf('window.openModelEdit = (modelId) => {');
  assert.ok(start > -1, '未找到 openModelEdit');
  const block = MODELS_JS.slice(start, MODELS_JS.indexOf('\n};', start));
  assert.ok(block, '未找到 openModelEdit 实现');
  assert.ok(
    block.includes('m.upstream_max_input_tokens || defaultCtx'),
    '硬上限缺省时必须回退默认窗口（老版内核无该字段时保持既有行为）'
  );
  assert.ok(
    block.includes('max="${esc(hardCtx)}"'),
    '输入框 max 必须绑定硬上限：绑定默认窗口会让用户无法把窗口调大'
  );
  assert.ok(
    !block.includes('max="${esc(defaultCtx)}"'),
    '输入框 max 仍绑定默认窗口（defaultCtx）'
  );
});
