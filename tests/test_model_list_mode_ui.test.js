/**
 * 模型清单模式（model_list_mode）UI 契约（2026-09-26 迁移至 React+TS）
 *
 * 迁移说明：
 *  - 旧 models.js 的「需授权」徽章/虚拟标签 → ModelsPage.tsx（availability 派生徽章 +
 *    setTagFilterAndClose('需授权')），筛选逻辑由 modelBilling.ts 的
 *    applyModelFilterSort / buildTagCounts 实现；
 *  - 旧 settings.js 的 buildSettingsPayload / persistSettings（整对象覆盖 + dirty merge）
 *    契约的新家是 src/services/settingsService.ts（normalizeModelListMode +
 *    ('model_list_mode' in patch) 守卫），第 3 条锁定其对等断言；
 *  - 旧 index.html 的设置页选择器与 MODEL_LIST_MODE_NOTES 文案 → 新实现中
 *    model_list_mode 的「客户端侧说明」在模型页筛选区下方渲染
 *    （ModelsPage.tsx 的 modelListModeNote(listMode)），文案表在 modelBilling.ts；
 *  - 按批次要求锁定：model_list_mode 说明必须明确「只影响内核清单」，
 *    不得给出「选此项即可让客户端隐藏模型」的误导性承诺。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');

const MODELS_PAGE = read('src/pages/ModelsPage.tsx');
const BILLING_TS = read('src/services/modelBilling.ts');
const SETTINGS_SVC = read('src/services/settingsService.ts');
const ZH_CN = read('src/i18n/zh-CN.ts');

const { applyModelFilterSort, buildTagCounts } = await import('../src/services/modelBilling.ts');

// 抽取 MODEL_LIST_MODE_NOTES 文案表（不依赖具体措辞顺序）
const notesTable = (() => {
  const m = /export const MODEL_LIST_MODE_NOTES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(BILLING_TS);
  assert.ok(m, 'modelBilling.ts 应存在 MODEL_LIST_MODE_NOTES 文案表');
  return m[1];
})();

test('ModelsPage 渲染不可用模型「需授权」徽章（availability=unavailable）', () => {
  assert.ok(
    MODELS_PAGE.includes("m.availability === 'unavailable'"),
    'ModelsPage 必须识别 m.availability === unavailable 并渲染提示徽章'
  );
  assert.ok(
    MODELS_PAGE.includes("t('models.unauthBadge')"),
    '不可用模型必须渲染 models.unauthBadge 徽章'
  );
  assert.ok(
    /'models\.unauthBadge': '需授权'/.test(ZH_CN),
    'models.unauthBadge 文案应为「需授权」'
  );
});

test('ModelsPage 标签筛选支持「需授权」虚拟标签（点徽章可筛出全部不可用模型）', () => {
  assert.ok(
    MODELS_PAGE.includes("setTagFilterAndClose('需授权')"),
    '「需授权」徽章点击必须能设为筛选条件'
  );
  const list = [
    { id: 'a', credits: 'x1', tags: ['双端'], availability: 'unavailable' },
    { id: 'b', credits: 'x1', tags: ['双端'], availability: 'available' },
  ];
  assert.deepEqual(
    applyModelFilterSort(list, '需授权', null, null).map((m) => m.id),
    ['a'],
    '虚拟标签「需授权」筛选应命中全部不可用模型'
  );
  const first = buildTagCounts(list)[0];
  assert.equal(first.tag, '需授权', '「需授权」虚拟标签应出现在筛选下拉首位');
});

test('settingsService 持久化 model_list_mode（整对象覆盖防回滚 + dirty merge 的新家）', () => {
  assert.ok(
    /export function normalizeModelListMode/.test(SETTINGS_SVC),
    'settingsService.ts 缺少 normalizeModelListMode'
  );
  // dirty merge 契约：回读时带 ('model_list_mode' in patch) 守卫——本次未修改才回填
  assert.ok(
    SETTINGS_SVC.includes("('model_list_mode' in patch)"),
    'settingsService 回读时未按 dirty 守卫保留 model_list_mode，会被覆盖回滚'
  );
});

test('model_list_mode 说明文案明确「只影响内核清单」，不做误导性承诺', () => {
  // ModelsPage 在筛选区下方渲染随当前模式切换的说明
  assert.ok(
    MODELS_PAGE.includes('modelListModeNote(listMode)'),
    'ModelsPage 筛选区下方必须渲染 model_list_mode 说明（modelListModeNote）'
  );
  assert.ok(
    BILLING_TS.includes("import { normalizeModelListMode } from '../services/settingsService'") ||
      MODELS_PAGE.includes("modelListModeNote }") ||
      MODELS_PAGE.includes('modelListModeNote,'),
    'ModelsPage 必须从 modelBilling 引入 modelListModeNote'
  );
  // available 分支：点出责任边界
  const availPart = notesTable.slice(
    notesTable.indexOf('available:'),
    notesTable.indexOf('all:')
  );
  assert.ok(/available:/.test(notesTable), 'available 分支应有专属说明');
  assert.ok(
    /Discover models|discover_models/.test(availPart),
    'available 分支须点名客户端「Discover models」开关，否则用户无从下手'
  );
  assert.ok(
    /只改变|只影响|不生效|管不到/.test(availPart),
    'available 分支须说清「只影响内核清单、管不到客户端写死的列表」这一边界'
  );
  // 反向断言：不能承诺「改了这里客户端就没了」这类误导
  assert.ok(
    !/选此项即可让客户端.*隐藏|即可从客户端移除/.test(notesTable),
    '不得给出「选了这里客户端就会隐藏该模型」的误导性承诺'
  );
});

test('清单模式切换说明不得声称内核需重启（内核热读 settings.json）', () => {
  assert.ok(
    !notesTable.includes('重启服务生效') && !notesTable.includes('重启内核'),
    '清单模式切换应即时生效（热读），不得提示需重启内核/服务'
  );
});
