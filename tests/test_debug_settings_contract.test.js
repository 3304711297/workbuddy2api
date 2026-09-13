import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SETTINGS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'settings.js'), 'utf-8');
const TABS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'tabs.js'), 'utf-8');
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf-8');

test('调试 Tab：tabs.js 注册 debug 元信息与加载勾子', () => {
  assert.ok(TABS_JS.includes('debug:'), 'tabs.js 缺少 debug meta');
  assert.ok(TABS_JS.includes('loadSnapshots'), 'tabs.js 未在切换时加载快照');
});

test('调试 Tab：index.html 有导航与面板', () => {
  assert.ok(INDEX_HTML.includes('data-tab="debug"'), 'index.html 缺少 debug 导航');
  assert.ok(INDEX_HTML.includes('id="panel-debug"'), 'index.html 缺少 panel-debug 面板');
});

test('调试 Tab：debug.js 导出加载/重放/导出能力', () => {
  const p = path.join(REPO_ROOT, 'src', 'debug.js');
  assert.ok(fs.existsSync(p), 'src/debug.js 不存在');
  const src = fs.readFileSync(p, 'utf-8');
  for (const fn of ['loadSnapshots', 'replaySnapshot', 'copyCurl', 'clearSnapshots']) {
    assert.ok(src.includes(fn), `debug.js 缺少 ${fn}`);
  }
  assert.ok(src.includes('snapshots_list'), 'debug.js 未调用 snapshots_list');
  assert.ok(src.includes('snapshot_replay'), 'debug.js 未调用 snapshot_replay');
});

test('快照开关进设置契约：payload 与脏合并守卫', () => {
  const start = SETTINGS_JS.indexOf('const buildSettingsPayload = (patch = {})');
  assert.ok(start > -1, '未找到 buildSettingsPayload');
  const block = SETTINGS_JS.slice(start, SETTINGS_JS.indexOf('};', start));
  assert.ok(block.includes('snapshots:'), 'payload 漏 snapshots（会被整对象覆盖抹回默认）');
  assert.ok(block.includes('snapshots_keep:'), 'payload 漏 snapshots_keep');
  assert.ok(
    SETTINGS_JS.includes("('snapshots' in patch)") && SETTINGS_JS.includes("('snapshots_keep' in patch)"),
    'persistSettings 缺少快照字段的脏合并守卫'
  );
});
