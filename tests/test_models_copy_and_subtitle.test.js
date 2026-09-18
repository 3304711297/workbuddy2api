/**
 * 模型页 UI 契约：模型调用名一键复制 + 移除冗余副标题标语（2026-09-18）
 *
 * 背景：模型页原先只能看不能取——用户在客户端（图吧工具箱 / Cherry 等）配置模型时
 * 得手抄模型 id，容易抄错导致上游 11102。现在模型 id 整块可点即复制调用名。
 * 同轮删除了标题下那句「全量读取 … 调节/关闭思考强度」的冗余副标题（信息已在表格列头体现）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MODELS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'models.js'), 'utf-8');
const HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf-8');
const CSS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'style.css'), 'utf-8');

test('模型 id 渲染为可点击复制控件（data-copy-model 携带调用名）', () => {
  assert.ok(
    /data-copy-model="\$\{esc\(m\.id\)\}"/.test(MODELS),
    'models.js 未给模型 id 挂 data-copy-model，点击复制调用名不可用'
  );
  assert.ok(
    /class="model-id-copy/.test(MODELS),
    'models.js 缺少 .model-id-copy 样式钩子'
  );
});

test('复制走 copyToClipboard 并在失败时报错（不得谎报成功）', () => {
  const idx = MODELS.indexOf('data-copy-model');
  assert.ok(idx > -1, '缺少 data-copy-model 渲染点');
  const handler = MODELS.slice(MODELS.indexOf('modelsTbody?.addEventListener'));
  assert.ok(
    /closest\('\[data-copy-model\]'\)/.test(handler),
    '事件委托未识别 [data-copy-model] 点击'
  );
  assert.ok(
    /await copyToClipboard\(modelId\)/.test(handler),
    '复制模型名未复用 copyToClipboard（无法感知剪贴板失败）'
  );
  assert.ok(
    /'复制失败，请手动选择文本复制'/.test(handler),
    '复制失败时缺少可行动提示'
  );
});

test('模型名控件键盘可达（原生 button + aria-label）', () => {
  assert.ok(
    /<button class="model-id-copy[\s\S]{0,200}aria-label="复制模型调用名/.test(MODELS),
    '模型名控件必须是原生 button 且带 aria-label，否则键盘/读屏不可达'
  );
});

test('复制图标样式存在且默认隐去、悬停显现', () => {
  assert.ok(/\.model-id-copy\s*\{/.test(CSS), 'style.css 缺少 .model-id-copy 样式');
  assert.ok(/\.model-id-copy-icon\s*\{[\s\S]{0,160}opacity:\s*0/.test(CSS), '复制图标应默认隐去');
  assert.ok(
    /\.model-id-copy:hover \.model-id-copy-icon[\s\S]{0,80}opacity:\s*0\.9/.test(CSS),
    '悬停时复制图标应显现'
  );
});

test('模型页标题下冗余副标题已删除', () => {
  assert.ok(
    !HTML.includes('全量读取 WorkBuddy 官方后端'),
    'index.html 仍残留「全量读取 …」副标题标语'
  );
  assert.ok(
    !HTML.includes('调节/关闭思考强度'),
    'index.html 仍残留「调节/关闭思考强度」副标题文案'
  );
  // 标题本身与同步按钮必须保留
  assert.ok(HTML.includes('可用模型矩阵与参数定制'), '模型页标题被误删');
  assert.ok(HTML.includes('id="btn-refresh-models"'), '云端同步按钮被误删');
});
