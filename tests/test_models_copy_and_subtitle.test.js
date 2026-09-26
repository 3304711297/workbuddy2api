/**
 * 模型页 UI 契约：模型调用名一键复制 + 移除冗余副标题标语（2026-09-18，2026-09-26 迁移）
 *
 * 背景：模型页原先只能看不能取——用户在客户端（图吧工具箱 / Cherry 等）配置模型时
 * 得手抄模型 id，容易抄错导致上游 11102。现在模型 id 整块可点即复制调用名。
 * 同轮删除了标题下那句「全量读取 … 调节/关闭思考强度」的冗余副标题（信息已在表格列头体现）。
 *
 * 迁移说明（React+TS）：
 *  - 旧 models.js（data-copy-model 渲染 + 事件委托）→ src/pages/ModelsPage.tsx（原生 button +
 *    onClick → handleCopyModelId），断言目标改为 TSX 真实结构；
 *  - 旧 index.html（标题/副标题/同步按钮）→ React 后页面内容由 ModelsPage.tsx + i18n
 *    （src/i18n/zh-CN.ts 的 models.title）提供，index.html 只剩 Vite 入口挂载点，不再断言它；
 *  - 旧 src/style.css → src/styles.css（文件名变更，规则保持）；
 *  - 「复制失败报错」文案从 models.js 内联字符串改为 i18n 键 models.copyFailed，
 *    断言改为「toast 按真实结果分流 + i18n 文案仍在」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const MODELS_PAGE = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'ModelsPage.tsx'), 'utf-8');
const CSS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'styles.css'), 'utf-8');
const ZH_CN = fs.readFileSync(path.join(REPO_ROOT, 'src', 'i18n', 'zh-CN.ts'), 'utf-8');

test('模型 id 渲染为原生 button 复制控件（class="model-id-copy" + data-copy-model={m.id}）', () => {
  assert.ok(
    /<button[\s\S]{0,300}className="model-id-copy/.test(MODELS_PAGE),
    'ModelsPage.tsx 未用原生 button 渲染 .model-id-copy，点击复制调用名不可用'
  );
  assert.ok(
    /data-copy-model=\{m\.id\}/.test(MODELS_PAGE),
    'ModelsPage.tsx 的复制按钮未绑定 data-copy-model={m.id}'
  );
});

test('复制走 copyToClipboard 并在失败时报错（不得谎报成功）', () => {
  assert.ok(
    /from '\.\.\/services\/clipboard'/.test(MODELS_PAGE) && MODELS_PAGE.includes('copyToClipboard'),
    'ModelsPage.tsx 未复用 services/clipboard 的 copyToClipboard（无法感知剪贴板失败）'
  );
  assert.ok(
    /await copyToClipboard\(modelId\)/.test(MODELS_PAGE),
    '复制模型名未 await copyToClipboard，无法按真实结果提示'
  );
  // 成功/失败 toast 必须按 ok 分流：只有 ok 才报 models.copied，否则 models.copyFailed
  assert.ok(
    /showToast\(ok \? t\('models\.copied'[^)]*\) : t\('models\.copyFailed'[^)]*\), ok \? 'success' : 'error'\)/.test(
      MODELS_PAGE
    ),
    'handleCopyModelId 未按复制真实结果分流 toast（成功不得在失败时谎报）'
  );
  // 不得有无条件的成功 toast
  assert.ok(
    !/showToast\(t\('models\.copied'/.test(MODELS_PAGE),
    '存在不经 ok 守卫的成功 toast，复制失败会被谎报成功'
  );
  // 失败文案仍在（i18n 化后）
  assert.ok(
    /'models\.copyFailed': '复制失败，请手动选择文本复制'/.test(ZH_CN),
    '复制失败的可行动提示文案丢失（models.copyFailed）'
  );
});

test('模型名控件键盘可达（原生 button + aria-label）', () => {
  assert.ok(
    /<button[\s\S]{0,300}className="model-id-copy[\s\S]{0,600}aria-label=\{t\('models\.copyModelId'/.test(
      MODELS_PAGE
    ),
    '模型名控件必须是原生 button 且带 aria-label，否则键盘/读屏不可达'
  );
  assert.ok(
    /'models\.copyModelId': '复制模型调用名/.test(ZH_CN),
    'i18n 缺少 models.copyModelId（复制模型调用名）无障碍文案'
  );
});

test('复制图标样式存在且默认隐去、悬停/聚焦显现', () => {
  assert.ok(/\.model-id-copy\s*\{/.test(CSS), 'styles.css 缺少 .model-id-copy 样式');
  assert.ok(
    /\.model-id-copy-icon\s*\{[^}]*opacity:\s*0/.test(CSS),
    '复制图标应默认隐去'
  );
  assert.ok(
    /\.model-id-copy:hover \.model-id-copy-icon[\s\S]{0,160}opacity:\s*0\.9/.test(CSS),
    '悬停时复制图标应显现'
  );
});

test('模型页标题下冗余副标题已删除', () => {
  assert.ok(
    !MODELS_PAGE.includes('全量读取 WorkBuddy 官方后端'),
    'ModelsPage.tsx 仍残留「全量读取 …」副标题标语'
  );
  assert.ok(
    !MODELS_PAGE.includes('调节/关闭思考强度'),
    'ModelsPage.tsx 仍残留「调节/关闭思考强度」副标题文案'
  );
  assert.ok(
    !ZH_CN.includes('全量读取 WorkBuddy 官方后端') && !ZH_CN.includes('调节/关闭思考强度'),
    'i18n models 分区仍残留副标题文案'
  );
  // 标题本身与同步按钮必须保留
  assert.ok(
    /'models\.title': '可用模型矩阵与参数定制'/.test(ZH_CN),
    '模型页标题被误删（models.title）'
  );
  assert.ok(MODELS_PAGE.includes("t('models.title')"), 'ModelsPage 未渲染 models.title');
  assert.ok(
    /onClick=\{\(\) => void load\(true\)\}/.test(MODELS_PAGE),
    '云端同步（手动刷新）按钮被误删'
  );
});
