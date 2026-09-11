import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test('models.js and billing.rs filter out useless craft tag', () => {
  const modelsJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'models.js'), 'utf-8');
  assert.equal(modelsJs.includes("t.toLowerCase() !== 'craft'"), true, 'models.js 必须过滤 craft 标签');

  const billingRs = fs.readFileSync(path.join(REPO_ROOT, 'src-tauri', 'src', 'commands', 'billing.rs'), 'utf-8');
  assert.equal(billingRs.includes('ts.to_lowercase() != "craft"'), true, 'billing.rs 必须过滤 craft 标签');
});

test('index.html contains sortable headers and tag filter dropdown container', () => {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.equal(html.includes('id="th-sort-model"'), true, '缺少模型排序表头');
  assert.equal(html.includes('id="th-sort-credits"'), true, '缺少倍率排序表头');
  assert.equal(html.includes('id="th-filter-tags"'), true, '缺少标签筛选表头');
  assert.equal(html.includes('id="tag-filter-dropdown"'), true, '缺少标签筛选下拉容器');
});

test('models.js contains toggleModelSort, toggleCreditsSort, and setTagFilter functions', () => {
  const modelsJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'models.js'), 'utf-8');
  assert.equal(modelsJs.includes('toggleModelSort'), true, '缺少 toggleModelSort');
  assert.equal(modelsJs.includes('toggleCreditsSort'), true, '缺少 toggleCreditsSort');
  assert.equal(modelsJs.includes('setTagFilter'), true, '缺少 setTagFilter');
});

test('Sorting and filtering pure logic simulation', () => {
  const rawModels = [
    { id: 'hy3', credits: '免费 (0.00x)', tags: ['双端'] },
    { id: 'gpt-6-astra', credits: 'x6.67 credits', tags: ['WorkBuddy'] },
    { id: 'glm-5.3', credits: 'x0.51 credits', tags: ['双端'] },
    { id: 'deepseek-v4.1-flash', credits: 'x1.62 credits', tags: ['CodeBuddy'] }
  ];

  function getMultiplierNum(m) {
    if (!m.credits || m.credits === '—') return -1;
    const match = String(m.credits).match(/(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]) : -1;
  }

  // 1. 计费倍率从大到小 (desc)
  const sortedByCreditsDesc = [...rawModels].sort((a, b) => getMultiplierNum(b) - getMultiplierNum(a));
  assert.equal(sortedByCreditsDesc[0].id, 'gpt-6-astra'); // 6.67
  assert.equal(sortedByCreditsDesc[1].id, 'deepseek-v4.1-flash'); // 1.62
  assert.equal(sortedByCreditsDesc[2].id, 'glm-5.3'); // 0.51
  assert.equal(sortedByCreditsDesc[3].id, 'hy3'); // 0.00

  // 2. 计费倍率从小到大 (asc)
  const sortedByCreditsAsc = [...rawModels].sort((a, b) => getMultiplierNum(a) - getMultiplierNum(b));
  assert.equal(sortedByCreditsAsc[0].id, 'hy3'); // 0.00
  assert.equal(sortedByCreditsAsc[1].id, 'glm-5.3'); // 0.51
  assert.equal(sortedByCreditsAsc[2].id, 'deepseek-v4.1-flash'); // 1.62
  assert.equal(sortedByCreditsAsc[3].id, 'gpt-6-astra'); // 6.67

  // 3. 模型首字母从小到大 (asc)
  const sortedByModelAsc = [...rawModels].sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(sortedByModelAsc[0].id, 'deepseek-v4.1-flash');
  assert.equal(sortedByModelAsc[1].id, 'glm-5.3');
  assert.equal(sortedByModelAsc[2].id, 'gpt-6-astra');
  assert.equal(sortedByModelAsc[3].id, 'hy3');

  // 4. 标签筛选
  const filteredWorkBuddy = rawModels.filter(m => m.tags.includes('WorkBuddy'));
  assert.equal(filteredWorkBuddy.length, 1);
  assert.equal(filteredWorkBuddy[0].id, 'gpt-6-astra');

  const filteredDual = rawModels.filter(m => m.tags.includes('双端'));
  assert.equal(filteredDual.length, 2);
});
