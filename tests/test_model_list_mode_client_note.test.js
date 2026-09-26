/**
 * 设置页「模型清单模式」的客户端侧说明契约（React+TS 迁移版，2026-09-16）
 *
 * 背景（真实用户困惑）：用户选了「仅展示可用模型」，但 Hermes 模型选择器里仍有
 * 需授权模型。原因不是内核过滤失效（/v1/models 实测已无 gpt 系列），而是客户端
 * 侧的自定义端点勾了 discover_models: false —— 它改用自己配置里写死的 models 列表，
 * 从不请求本清单。用户在原开关上反复尝试，无从判断真正原因。
 *
 * 本测试锁定：设置页必须对这一「责任边界」给出说明，且随当前选择切换文案。
 *
 * 迁移映射：
 * - 旧 settings.js 的 MODEL_LIST_MODE_NOTES / renderModelListModeNote（DOM 读写）
 *   → 新 SettingsPage.tsx 的 React 条件渲染
 *     t(form.modelListMode === 'available' ? 'settings.modelListModeNote.available'
 *                                          : 'settings.modelListModeNote.all')，
 *   文案本体迁入 src/i18n/zh-CN.ts 词典；
 * - 同源文案另有一份在 src/services/modelBilling.ts 的 MODEL_LIST_MODE_NOTES
 *  （供 ModelsPage 使用），两处共同受「不得误导性承诺」约束；
 * - 「DOM 缺失降级 / textContent / 初始化渲染」旧断言在 React 下不再适用：
 *   说明由 form.modelListMode 派生（单一数据源，天然与选择同步），
 *   JSX 文本插值替代了 textContent/innerHTML，normalizeModelListMode 保证永不 undefined。
 */
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const SETTINGS_TSX = readFileSync(join(root, 'src', 'pages', 'SettingsPage.tsx'), 'utf8');
const ZH_CN = readFileSync(join(root, 'src', 'i18n', 'zh-CN.ts'), 'utf8');
const SERVICE_TS = readFileSync(join(root, 'src', 'services', 'settingsService.ts'), 'utf8');
const MODEL_BILLING_TS = readFileSync(join(root, 'src', 'services', 'modelBilling.ts'), 'utf8');

function dictValue(key) {
  const m = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(ZH_CN);
  assert.ok(m, `i18n 词典缺少 ${key}`);
  return m[1];
}

test('说明随当前选择动态切换（available / all 各有专属文案）', () => {
  // React 条件渲染：说明直接派生自表单态，随选择即时切换（旧 renderModelListModeNote 的行为对等）
  assert.ok(
    /t\(\s*form\.modelListMode === 'available'\s*\?\s*'settings\.modelListModeNote\.available'\s*:\s*'settings\.modelListModeNote\.all',?\s*\)/.test(SETTINGS_TSX),
    '设置页必须按 form.modelListMode 动态选择 available/all 说明文案'
  );
  const avail = dictValue('settings.modelListModeNote.available');
  const all = dictValue('settings.modelListModeNote.all');
  assert.ok(avail.length > 0 && all.length > 0, 'available/all 说明文案都必须非空');
  assert.notEqual(avail, all, '两档说明文案必须不同（否则切换无意义）');
});

test('available 说明点出「客户端 discover_models 关闭时本开关不生效」这一责任边界', () => {
  const avail = dictValue('settings.modelListModeNote.available');
  // 必须提到客户端的 Discover models / discover_models，否则用户无法知道该去哪儿改
  assert.ok(
    /Discover models|discover_models/.test(avail),
    'available 说明须点名客户端「Discover models」开关，否则用户无从下手'
  );
  assert.ok(
    /不生效|管不到|只改变|只影响/.test(avail),
    'available 说明须说清「本开关管不到客户端写死的列表」这一边界'
  );
  // 反向断言：不能承诺「改了这里客户端就没了」这类误导
  assert.ok(
    !/选此项即可让客户端.*隐藏|即可从客户端移除|客户端就会隐藏/.test(avail),
    '不得给出「选了这里客户端就会隐藏该模型」的误导性承诺'
  );
});

test('all 说明同样不得写误导性承诺', () => {
  const all = dictValue('settings.modelListModeNote.all');
  assert.ok(
    !/选此项即可让客户端.*隐藏|即可从客户端移除|客户端就会隐藏/.test(all),
    'all 说明也不得给出误导性承诺'
  );
});

test('说明经 JSX 文本渲染，不得用 innerHTML 注入', () => {
  // 说明渲染点在 <p className="muted field-hint"> 内做文本插值
  assert.ok(
    /<p className="muted field-hint">\s*\{\s*t\(\s*form\.modelListMode/.test(SETTINGS_TSX),
    '说明必须经 JSX 文本插值渲染'
  );
  assert.ok(
    !SETTINGS_TSX.includes('dangerouslySetInnerHTML'),
    'SettingsPage 不得用 dangerouslySetInnerHTML 写静态文案'
  );
});

test('说明与表单态同源：非法 mode 永不渲染 undefined', () => {
  // form.modelListMode 唯一来源是 loadFromDisk 的 normalizeModelListMode 回填
  // 与 onModelListMode 的归一化写入 —— 文案选择表达式只有 available/all 两支，
  // 非法值在入库前就被归一，不可能把 undefined 写进界面。
  assert.ok(
    /const modelListMode = normalizeModelListMode\(cfg\.model_list_mode\)/.test(SERVICE_TS),
    'loadFromDisk 必须用 normalizeModelListMode 归一化磁盘值'
  );
  assert.ok(
    /const mode = normalizeModelListMode\(value\)/.test(SETTINGS_TSX),
    'onModelListMode 必须用 normalizeModelListMode 归一化用户选择'
  );
  const start = SERVICE_TS.indexOf('export function normalizeModelListMode');
  const fn = SERVICE_TS.slice(start, SERVICE_TS.indexOf('}', start) + 1);
  assert.ok(
    /v === 'available' \? 'available' : 'all'/.test(fn),
    'normalizeModelListMode 必须把非法值归一到 all'
  );
});

test('同源文案一致性：modelBilling.ts 的 MODEL_LIST_MODE_NOTES 守同一边界', () => {
  // ModelsPage 用的说明表与设置页文案同源，「不得误导性承诺」约束两处一致
  assert.ok(
    MODEL_BILLING_TS.includes('MODEL_LIST_MODE_NOTES'),
    'modelBilling.ts 应保留 MODEL_LIST_MODE_NOTES 说明表'
  );
  const m = /MODEL_LIST_MODE_NOTES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(MODEL_BILLING_TS);
  assert.ok(m, '未找到 MODEL_LIST_MODE_NOTES 表');
  const table = m[1];
  assert.ok(
    /available:/.test(table) && /Discover models|discover_models/.test(table),
    'available 分支须点名客户端「Discover models」'
  );
  assert.ok(
    !/选此项即可让客户端.*隐藏|即可从客户端移除/.test(table),
    '同源文案同样不得给出误导性承诺'
  );
});
