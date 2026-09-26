/**
 * 模型表「计费倍率」排序的三态语义（免费 vs 未知）行为测试（2026-09-26 迁移至 React+TS）
 *
 * 历史缺陷：`getMultiplierNum` 对「缺失 / `—`」与「`x0.00` 免费」**都**返回 -1，
 * 于是「倍率未知」与「免费」在排序上完全等价：
 *   · 升序（低→高）时未知被排到免费之上（-1 < 0），用户看到未知模型混在免费组里置顶；
 *   · 两种语义无法区分，免费也不该被当成「比未知更贵」。
 * 修法：三态 —— 正数=真实倍率 / 0=免费 / null=未知，且未知在升序与降序下**一律置底**。
 *
 * 迁移说明：
 *  - 旧实现是 models.js 的 toggleCreditsSort → applyAndRender（靠 DOM 桩真实驱动），
 *    新实现是 modelBilling.ts 的纯函数 applyModelFilterSort（排序/筛选/倍率逻辑
 *    已从 ModelsPage.tsx 剥离），不再需要 DOM 桩——直接用真实函数断言行序，
 *    同样能抓到「改 src 不会红」的本地拷贝类缺陷（这里没有本地拷贝）；
 *  - 排序切换三态（desc → asc → 关）由 nextCreditsSort 锁定，ModelsPage 倍率表头
 *    onClick 接入它，首次点击即「高→低」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BILLING_TS = fs.readFileSync(
  path.join(REPO_ROOT, 'src', 'services', 'modelBilling.ts'),
  'utf-8'
);
const MODELS_PAGE = fs.readFileSync(path.join(REPO_ROOT, 'src', 'pages', 'ModelsPage.tsx'), 'utf-8');

const { applyModelFilterSort, getMultiplierNum, nextCreditsSort } = await import(
  '../src/services/modelBilling.ts'
);

/// 样本：两档真实倍率 + 免费 + 三种「未知」形态（缺失 / — / 无可解析数字）
const SAMPLE = [
  { id: 'glm-5.3', name: 'glm', credits: 'x0.51 credits', tags: ['双端'] },
  { id: 'hy3', name: 'hy3', credits: '免费 (0.00x)', tags: ['双端'] },
  { id: 'unknown-dash', name: 'dash', credits: '—', tags: ['双端'] },
  { id: 'unknown-missing', name: 'missing', tags: ['双端'] },
  { id: 'unknown-text', name: 'text', credits: '不确定', tags: ['双端'] },
  { id: 'gpt-6-astra', name: 'astra', credits: 'x6.67 credits', tags: ['WorkBuddy'] },
  { id: 'deepseek-v4.1-flash', name: 'ds', credits: 'x1.62 credits', tags: ['CodeBuddy'] },
];

/** 用真实 applyModelFilterSort 排一次倍率，返回模型 id 的出现顺序（真实实现结果）。 */
function renderSorted({ orderSeq }) {
  // orderSeq=1 等价于倍率表头首次点击：nextCreditsSort(null, null) → desc（高→低）
  const order = orderSeq === 1 ? 'desc' : 'asc';
  return applyModelFilterSort(SAMPLE, 'ALL', 'credits', order).map((m) => m.id);
}

const UNKNOWN_IDS = ['unknown-dash', 'unknown-missing', 'unknown-text'];

test('ModelsPage 倍率表头首次点击即「高→低」（nextCreditsSort 首态 desc）', () => {
  assert.ok(
    MODELS_PAGE.includes('nextCreditsSort(sortField, sortOrder)'),
    'ModelsPage 倍率表头未接入 nextCreditsSort'
  );
  assert.deepEqual(
    nextCreditsSort(null, null),
    { field: 'credits', order: 'desc' },
    '倍率排序首次点击应为 desc（高→低）'
  );
});

test('倍率降序：真实倍率从高到低，免费(0)排在最后，倍率未知一律置底', () => {
  const order = renderSorted({ orderSeq: 1 });
  assert.deepEqual(
    order.slice(0, 4),
    ['gpt-6-astra', 'deepseek-v4.1-flash', 'glm-5.3', 'hy3'],
    `降序应为 6.67 > 1.62 > 0.51 > 免费0，实际：${order.join(', ')}`
  );
  assert.deepEqual(
    order.slice(4),
    UNKNOWN_IDS.slice().sort(),
    `降序时倍率未知必须置底，实际：${order.join(', ')}`
  );
});

test('倍率升序：免费(0)在最前，倍率未知仍置底（不得凌驾于免费之上）', () => {
  const order = renderSorted({ orderSeq: 2 });
  assert.deepEqual(
    order.slice(0, 4),
    ['hy3', 'glm-5.3', 'deepseek-v4.1-flash', 'gpt-6-astra'],
    `升序应为 免费0 < 0.51 < 1.62 < 6.67，实际：${order.join(', ')}`
  );
  assert.deepEqual(
    order.slice(4),
    UNKNOWN_IDS.slice().sort(),
    `升序时倍率未知必须置底（旧实现把未知当 -1，会排到免费之上），实际：${order.join(', ')}`
  );
});

test('免费与未知在两种排序下都不混为一组（三态语义）', () => {
  const desc = renderSorted({ orderSeq: 1 });
  const asc = renderSorted({ orderSeq: 2 });
  // 降序：免费紧跟在三个已知倍率之后（第 4 位）；升序：免费在最前（第 1 位）
  assert.equal(desc.indexOf('hy3'), 3, `降序下免费应在已知倍率之后：${desc.join(', ')}`);
  assert.equal(asc.indexOf('hy3'), 0, `升序下免费应是最前：${asc.join(', ')}`);
  for (const order of [desc, asc]) {
    for (const id of UNKNOWN_IDS) {
      assert.ok(
        order.indexOf(id) > order.indexOf('hy3'),
        `未知倍率 ${id} 不得出现在免费模型之前：${order.join(', ')}`
      );
    }
  }
});

test('modelBilling 的 getMultiplierNum 不再用 -1 表示「未知」（真实三态）', () => {
  const fn = BILLING_TS.match(/export function getMultiplierNum[\s\S]*?\n}/)?.[0] || '';
  assert.ok(fn, '未找到 getMultiplierNum 实现');
  assert.ok(
    !fn.includes('return -1'),
    'getMultiplierNum 仍以 -1 表示未知：免费(0) 与未知会被排成同一档，升序时未知排在免费之上'
  );
  // 缺失/`—` 与无可解析数字都回落到 null
  assert.ok(/return null/.test(fn), '未知路径必须返回 null（不能退回 -1）');
  // 行为侧：免费=0、未知=null，确实分开
  const free = { id: 'hy3', credits: '免费 (0.00x)', tags: ['双端'] };
  const unknown = { id: 'u', credits: '—', tags: ['双端'] };
  assert.strictEqual(getMultiplierNum(free), 0, '免费倍率应为 0');
  assert.strictEqual(getMultiplierNum(unknown), null, '未知倍率应为 null');
});
