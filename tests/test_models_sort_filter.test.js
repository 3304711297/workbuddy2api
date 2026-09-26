/**
 * 模型表排序 / 筛选契约（2026-09-26 迁移至 React+TS）
 *
 * 迁移说明：
 *  - 旧 models.js 的 toggleModelSort / toggleCreditsSort / setTagFilter →
 *    src/services/modelBilling.ts 的 nextModelSort / nextCreditsSort（纯函数，返回下一状态），
 *    表头/筛选下拉由 src/pages/ModelsPage.tsx 的 th（class="sortable-th"）与
 *    div.tag-filter-menu 渲染（旧 index.html 的 th-sort-model / th-sort-credits /
 *    th-filter-tags / tag-filter-dropdown id 已随旧 HTML 删除）；
 *  - craft 标签过滤：前端侧由 modelBilling.cleanModelTags 实现（ModelsPage 拉取后即清洗），
 *    后端 billing.rs 的过滤逻辑未动，仍由其 Rust 侧单测覆盖（本文件不再重复断言）；
 *  - 旧文件的「纯逻辑模拟」是 getMultiplierNum 的本地拷贝（实现改了照样绿），
 *    迁移后改为 import 真实 modelBilling 模块做行为断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MODELS_PAGE = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'ModelsPage.tsx'), 'utf-8');
const BILLING_TS = fs.readFileSync(
  path.join(REPO_ROOT, 'src', 'services', 'modelBilling.ts'),
  'utf-8'
);

const {
  applyModelFilterSort,
  buildTagCounts,
  cleanModelTags,
  nextCreditsSort,
  nextModelSort,
} = await import('../src/services/modelBilling.ts');

test('modelBilling.cleanModelTags 过滤 craft 标签（含 trim 保护），放行来源端与动态徽章', () => {
  assert.ok(
    /toLowerCase\(\) !== 'craft'/.test(BILLING_TS),
    'modelBilling.ts 必须过滤 craft 标签'
  );
  assert.deepEqual(
    cleanModelTags(['双端', 'craft', ' Craft ', 'WorkBuddy', '夜间免费', '']),
    ['双端', 'WorkBuddy', '夜间免费'],
    'cleanModelTags 应只剔除 craft（含首尾空格），保留来源端与动态业务徽章'
  );
});

test('ModelsPage 拉取模型后即用 cleanModelTags 清洗 tags', () => {
  assert.ok(
    /cleanModelTags\(m\.tags\)/.test(MODELS_PAGE),
    'ModelsPage 拉取 modelsFetchAll 后未对 tags 做 cleanModelTags 清洗'
  );
});

test('模型页含可排序表头（模型/倍率）与标签筛选下拉（React 结构）', () => {
  const sortableCount = (MODELS_PAGE.match(/sortable-th/g) || []).length;
  assert.ok(sortableCount >= 2, `缺少可排序表头（sortable-th，需模型/倍率两列），实得 ${sortableCount}`);
  assert.ok(
    MODELS_PAGE.includes('nextModelSort(sortField, sortOrder)'),
    '模型列表头未接入 nextModelSort'
  );
  assert.ok(
    MODELS_PAGE.includes('nextCreditsSort(sortField, sortOrder)'),
    '倍率列表头未接入 nextCreditsSort'
  );
  assert.ok(
    MODELS_PAGE.includes('className="tag-filter-menu"'),
    '缺少标签筛选下拉容器（tag-filter-menu）'
  );
  assert.ok(
    MODELS_PAGE.includes('handleTagToggle'),
    '标签筛选触发（展开/清空）逻辑缺失'
  );
});

test('nextModelSort / nextCreditsSort 三态切换语义（真实函数）', () => {
  // 模型列：未排序 → id 升序 → id 降序 → 关
  assert.deepEqual(nextModelSort(null, null), { field: 'id', order: 'asc' });
  assert.deepEqual(nextModelSort('id', 'asc'), { field: 'id', order: 'desc' });
  assert.deepEqual(nextModelSort('id', 'desc'), { field: null, order: null });
  // 倍率列：未排序 → 倍率降序（首次点击高→低）→ 升序 → 关
  assert.deepEqual(nextCreditsSort(null, null), { field: 'credits', order: 'desc' });
  assert.deepEqual(nextCreditsSort('credits', 'desc'), { field: 'credits', order: 'asc' });
  assert.deepEqual(nextCreditsSort('credits', 'asc'), { field: null, order: null });
  // 切换列时直接落到该列的默认首态
  assert.deepEqual(nextModelSort('credits', 'desc'), { field: 'id', order: 'asc' });
  assert.deepEqual(nextCreditsSort('id', 'asc'), { field: 'credits', order: 'desc' });
});

test('排序与筛选走真实 applyModelFilterSort（非本地拷贝）', () => {
  const rawModels = [
    { id: 'hy3', credits: '免费 (0.00x)', tags: ['双端'] },
    { id: 'gpt-6-astra', credits: 'x6.67 credits', tags: ['WorkBuddy'] },
    { id: 'glm-5.3', credits: 'x0.51 credits', tags: ['双端'] },
    { id: 'deepseek-v4.1-flash', credits: 'x1.62 credits', tags: ['CodeBuddy'] },
  ];
  const ids = (list) => list.map((m) => m.id);

  // 1. 计费倍率从大到小 (desc)
  assert.deepEqual(
    ids(applyModelFilterSort(rawModels, 'ALL', 'credits', 'desc')),
    ['gpt-6-astra', 'deepseek-v4.1-flash', 'glm-5.3', 'hy3'],
    '倍率降序应为 6.67 > 1.62 > 0.51 > 免费0'
  );

  // 2. 计费倍率从小到大 (asc)
  assert.deepEqual(
    ids(applyModelFilterSort(rawModels, 'ALL', 'credits', 'asc')),
    ['hy3', 'glm-5.3', 'deepseek-v4.1-flash', 'gpt-6-astra'],
    '倍率升序应为 免费0 < 0.51 < 1.62 < 6.67'
  );

  // 3. 模型首字母从小到大 (asc)
  assert.deepEqual(
    ids(applyModelFilterSort(rawModels, 'ALL', 'id', 'asc')),
    ['deepseek-v4.1-flash', 'glm-5.3', 'gpt-6-astra', 'hy3'],
    '模型 id 升序错误'
  );

  // 4. 标签筛选
  assert.deepEqual(
    ids(applyModelFilterSort(rawModels, 'WorkBuddy', null, null)),
    ['gpt-6-astra'],
    'WorkBuddy 标签筛选错误'
  );
  assert.deepEqual(
    ids(applyModelFilterSort(rawModels, '双端', null, null)),
    ['hy3', 'glm-5.3'],
    '双端标签筛选错误'
  );
  assert.deepEqual(
    ids(applyModelFilterSort(rawModels, 'ALL', null, null)),
    ['hy3', 'gpt-6-astra', 'glm-5.3', 'deepseek-v4.1-flash'],
    'ALL 应保持原顺序'
  );
});
