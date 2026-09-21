/**
 * 模型表「计费倍率」排序的三态语义（免费 vs 未知）行为测试
 *
 * 历史缺陷：`getMultiplierNum` 对「缺失 / `—`」与「`x0.00` 免费」**都**返回 -1，
 * 于是「倍率未知」与「免费」在排序上完全等价：
 *   · 升序（低→高）时未知被排到免费之上（-1 < 0），用户看到未知模型混在免费组里置顶；
 *   · 两种语义无法区分，免费也不该被当成「比未知更贵」。
 * 修法：三态 —— 正数=真实倍率 / 0=免费 / null=未知，且未知在升序与降序下**一律置底**。
 *
 * 为什么用 DOM 桩真实驱动而不是复刻一份纯函数：`test_models_sort_filter.test.js`
 * 里的 `getMultiplierNum` 是**本地拷贝**，实现改了它照样绿（改 src 不会红）——那种断言
 * 抓不到本缺陷。这里 import 真实模块，走 toggleCreditsSort → applyAndRender → 渲染出的行序。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDomStubs } from './helpers/dom-stub.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const MODELS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'models.js'), 'utf-8');

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

let seq = 0;

/// 渲染一次倍率排序，返回 tbody 内模型 id 的出现顺序（真实渲染结果，不是模拟）
async function renderSorted({ orderSeq }) {
  const stub = installDomStubs({ invoke: async (cmd) => (cmd === 'models_fetch_all' ? SAMPLE : {}) });
  const mod = await import('../src/models.js' + `?t=${Date.now()}-${++seq}`);
  await mod.loadModelsMatrix();
  for (let i = 0; i < orderSeq; i += 1) mod.toggleCreditsSort();
  const html = stub.getEl('models-table-body').innerHTML;
  return [...html.matchAll(/data-copy-model="([^"]+)"/g)].map((m) => m[1]);
}

const UNKNOWN_IDS = ['unknown-dash', 'unknown-missing', 'unknown-text'];

test('倍率降序：真实倍率从高到低，免费(0)排在最后，倍率未知一律置底', async () => {
  const order = await renderSorted({ orderSeq: 1 }); // 首次点击 = 高→低
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

test('倍率升序：免费(0)在最前，倍率未知仍置底（不得凌驾于免费之上）', async () => {
  const order = await renderSorted({ orderSeq: 2 }); // 第二次点击 = 低→高
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

test('免费与未知在两种排序下都不混为一组（三态语义）', async () => {
  const desc = await renderSorted({ orderSeq: 1 });
  const asc = await renderSorted({ orderSeq: 2 });
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

test('models.js 的 getMultiplierNum 不再用 -1 表示「未知」', () => {
  const fn = MODELS_JS.match(/function getMultiplierNum[\s\S]{0,400}?\n}/)?.[0] || '';
  assert.ok(fn, '未找到 getMultiplierNum 实现');
  assert.ok(
    !fn.includes('return -1'),
    'getMultiplierNum 仍以 -1 表示未知：免费(0) 与未知会被排成同一档，升序时未知排在免费之上'
  );
  // 两条路径都必须回落到 null：① 缺失/`—` 的提前返回 ② 无可解析数字的兜底
  assert.ok(
    /credits === '—'\) return null/.test(fn),
    "缺失/`—` 路径必须返回 null"
  );
  assert.ok(
    /parseFloat\(match\[1\]\) : null/.test(fn),
    '无可解析数字的兜底路径必须返回 null（不能退回 -1）'
  );
});
