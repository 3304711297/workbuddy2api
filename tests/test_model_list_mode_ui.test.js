import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const MODELS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'models.js'), 'utf-8');
const SETTINGS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'settings.js'), 'utf-8');
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf-8');

test('models.js 渲染不可用模型「需授权」徽章（availability=unavailable）', () => {
  assert.ok(
    MODELS_JS.includes('availability === \'unavailable\'') || MODELS_JS.includes("availability === \"unavailable\""),
    'models.js 必须识别 m.availability === unavailable 并渲染提示徽章'
  );
  assert.ok(
    MODELS_JS.includes('需授权') || MODELS_JS.includes('套餐'),
    '不可用模型必须有可见的「需授权/套餐」徽章文案'
  );
});

test('models.js 标签筛选支持「需授权」虚拟标签（点徽章可筛出全部不可用模型）', () => {
  assert.ok(
    MODELS_JS.includes("'需授权'") || MODELS_JS.includes('"需授权"'),
    '「需授权」虚拟标签必须参与筛选下拉与行内徽章点击'
  );
});

test('settings.js buildSettingsPayload 透传 model_list_mode（整对象覆盖防回滚契约）', () => {
  const start = SETTINGS_JS.indexOf('const buildSettingsPayload = ()');
  assert.ok(start > -1, '未找到 buildSettingsPayload');
  const block = SETTINGS_JS.slice(start, SETTINGS_JS.indexOf('};', start));
  assert.ok(block.includes('model_list_mode'), 'buildSettingsPayload 缺少 model_list_mode 字段');
});

test('settings.js 持久化前回读磁盘真源并保留 model_list_mode', () => {
  const start = SETTINGS_JS.indexOf('const persistSettings = async () =>');
  assert.ok(start > -1, '未找到 persistSettings');
  const block = SETTINGS_JS.slice(start, start + 900);
  assert.ok(block.includes('model_list_mode'), 'persistSettings 回读磁盘时未保留 model_list_mode，会被覆盖回滚');
});

test('index.html 设置页含模型清单模式选择器', () => {
  assert.ok(
    INDEX_HTML.includes('model-list-mode') || INDEX_HTML.includes('模型清单'),
    '设置页必须提供模型清单模式（all/available）选择控件'
  );
});

test('模式切换为 available 时提示无需重启（内核热读 settings.json）', () => {
  // 内核每请求热读 settings.json；UI 不得声称需重启
  const modeArea = SETTINGS_JS.match(/model_list_mode[\s\S]{0,600}/);
  const area = (modeArea ? modeArea[0] : '') + INDEX_HTML.match(/model-list-mode[\s\S]{0,400}/)?.[0] || '';
  assert.ok(!area.includes('重启服务生效'), '清单模式切换应即时生效（热读），不得提示需重启');
});
