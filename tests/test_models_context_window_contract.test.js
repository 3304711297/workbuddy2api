/**
 * 模型清单「上下文窗口」字段口径契约（2026-09 升级：最高可用）
 *
 * 规范：
 * 1. 默认窗口统一取「最高可用」（supportedLengths / maxLength / maxInputTokens / maxAllowedSize 最大值），
 *    规避客户端（如 Hermes）因 300k 默认值导致 70% 真实可用上下文闲置早早压缩。
 * 2. 移除控制台上下文窗口手改功能：表格只读展示最高可用上下文，编辑弹窗移除上下文修改输入框，
 *    只保留思考强度等必要参数配置。
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

test('Rust 侧默认窗口取最高可用（supportedLengths / maxLength / maxInputTokens / maxAllowedSize 最大值）', () => {
  const fn = BILLING_RS.match(/fn upstream_highest_available_window[\s\S]*?\n}/)?.[0] || '';
  assert.ok(fn, '未找到 upstream_highest_available_window');
  assert.ok(
    fn.includes('supportedLengths') || fn.includes('/contextWindow/supportedLengths'),
    '最高可用计算必须解析 supportedLengths 列表'
  );

  const resolve = BILLING_RS.match(/fn resolve_context_windows[\s\S]*?\n}/)?.[0] || '';
  assert.ok(resolve, '未找到 resolve_context_windows');
  assert.ok(
    resolve.includes('upstream_highest_available_window(m)'),
    'resolve_context_windows 必须接入 upstream_highest_available_window'
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

test('前端模型表格仅只读展示最高可用上下文，编辑弹窗移除上下文修改输入框', () => {
  const start = MODELS_JS.indexOf('window.openModelEdit = (modelId) => {');
  assert.ok(start > -1, '未找到 openModelEdit');
  const block = MODELS_JS.slice(start, MODELS_JS.indexOf('\n};', start));
  assert.ok(block, '未找到 openModelEdit 实现');

  assert.ok(
    !block.includes('id="ctx-'),
    '编辑弹窗已移除上下文窗口修改输入框，不得再包含 ctx- 输入框'
  );
  assert.ok(
    !block.includes('上下文窗口上限'),
    '编辑弹窗已移除上下文窗口修改标签与说明'
  );

  const saveStart = MODELS_JS.indexOf('window.saveModelConfig = async (modelId) => {');
  assert.ok(saveStart > -1, '未找到 saveModelConfig');
  const saveBlock = MODELS_JS.slice(saveStart, MODELS_JS.indexOf('\n  };', saveStart));
  assert.ok(
    !saveBlock.includes('contextWindow:'),
    'saveModelConfig 不再传递 contextWindow 参数'
  );

  const renderStart = MODELS_JS.indexOf('function renderModelsTable(');
  assert.ok(renderStart > -1, '未找到 renderModelsTable');
  const renderBlock = MODELS_JS.slice(renderStart, MODELS_JS.indexOf('\nfunction renderFallbackModels', renderStart));
  assert.ok(
    !renderBlock.includes('title="点击修改上下文窗口"'),
    '表格中上下文窗口应为只读展示，不得再提供点击修改入口'
  );
});
