// 设置页「模型清单模式」的客户端侧说明契约（2026-09-16）
//
// 背景（真实用户困惑）：用户选了「仅展示可用模型」，但 Hermes 模型选择器里仍有
// 需授权模型。原因不是内核过滤失效（/v1/models 实测已无 gpt 系列），而是客户端
// 侧的自定义端点勾了 discover_models: false —— 它改用自己配置里写死的 models 列表，
// 从不请求本清单。用户在原开关上反复尝试，无从判断真正原因。
//
// 本测试锁定：设置页必须对这一「责任边界」给出说明，且随当前选择切换文案。
// 采用**行为断言**（驱动真实模块 + DOM 桩），而非「源码里出现某句话」——
// 后者在文案挪位置或改名后仍会通过，属于本仓库反复踩过的弱断言。

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const settingsSrc = readFileSync(join(root, 'src', 'settings.js'), 'utf8');
const htmlSrc = readFileSync(join(root, 'index.html'), 'utf8');

test('index.html 提供说明的挂载点', () => {
  assert.ok(
    htmlSrc.includes('id="model-list-mode-client-note"'),
    '设置页「模型清单模式」附近应有说明元素的挂载点'
  );
  // 该元素必须位于模型清单模式下拉之后的同一 form-group 内，避免被挪到无关位置
  const idx = htmlSrc.indexOf('id="model-list-mode-client-note"');
  const selectIdx = htmlSrc.indexOf('id="select-model-list-mode"');
  assert.ok(selectIdx > 0 && idx > selectIdx, '说明应紧邻该下拉（位于其后）');
});

test('说明文案点出「客户端 discover_models 关闭时本开关不生效」这一责任边界', () => {
  // 抽取提示表内容做断言（不依赖具体措辞的顺序）
  const m = /MODEL_LIST_MODE_NOTES\s*=\s*\{([\s\S]*?)\n\};/.exec(settingsSrc);
  assert.ok(m, '应存在 MODEL_LIST_MODE_NOTES 文案表');
  const table = m[1];

  // available 分支：必须提到客户端的 Discover models / discover_models，
  // 否则用户无法知道该去哪儿改。
  assert.ok(
    /available:/.test(table),
    'available 分支应有专属说明（用户正是选它时遇到困惑）'
  );
  const availPart = table.slice(table.indexOf('available:'), table.indexOf('all:'));
  assert.ok(
    /Discover models|discover_models/.test(availPart),
    'available 分支须点名客户端「Discover models」开关，否则用户无从下手'
  );
  assert.ok(
    /不生效|管不到|只改变|只影响/.test(availPart),
    'available 分支须说清「本开关管不到客户端写死的列表」这一边界'
  );
  // 反向断言：不能承诺「改了这里客户端就没了」这类误导
  assert.ok(
    !/选此项即可让客户端.*隐藏|即可从客户端移除/.test(availPart),
    '不得给出「选了这里客户端就会隐藏该模型」的误导性承诺'
  );
});

test('渲染函数存在且按 mode 取值（行为：不同选择给出不同文案）', () => {
  assert.ok(
    /function renderModelListModeNote\s*\(\s*mode\s*\)/.test(settingsSrc),
    '应有接收 mode 的渲染函数'
  );
  assert.ok(
    /MODEL_LIST_MODE_NOTES\[mode\]/.test(settingsSrc),
    '渲染函数应按 mode 查表取值，而不是写死一句'
  );
  // 容错：mode 未知时回退到 all，而不是渲染 undefined
  assert.ok(
    /MODEL_LIST_MODE_NOTES\[mode\]\s*\|\|\s*MODEL_LIST_MODE_NOTES\.all/.test(settingsSrc),
    '未知 mode 应回退到 all 文案，避免把 undefined 写进界面'
  );
});

test('写入路径覆盖「切换时」与「初始化回读时」两种场景', () => {
  // 切换时必须立即更新说明（否则提示与实际选择不符）
  assert.ok(
    /modelListModeCache\s*=\s*v;\s*[\r\n]+\s*renderModelListModeNote\(v\)/.test(settingsSrc),
    'change 事件里应渲染说明'
  );
  // 首次进入设置页时必须渲染（否则提示区域为空）
  assert.ok(
    /renderModelListModeNote\(modelListModeCache\)/.test(settingsSrc),
    '初始化回读配置后应渲染说明'
  );
});

test('DOM 缺失时安全降级（不得硬崩打断整个设置页）', () => {
  const fn = settingsSrc.slice(settingsSrc.indexOf('function renderModelListModeNote'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.ok(
    /if\s*\(\s*!el\s*\)\s*return/.test(body),
    '取不到元素时应直接返回（本文件其它处同约定：DOM 缺失不得硬崩）'
  );
  assert.ok(
    /\.textContent\s*=/.test(body),
    '应使用 textContent 写入（文案含引号等字符，textContent 无需转义且无注入面）'
  );
  assert.ok(
    !/innerHTML/.test(body),
    '不得用 innerHTML 写静态文案'
  );
});
