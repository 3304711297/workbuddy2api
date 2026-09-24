import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SETTINGS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'settings.js'), 'utf-8');

test('P1-4: persistSettings 具备 saveChain 串行单写队列以防御并发 Lost Update', () => {
  assert.ok(
    SETTINGS_JS.includes('saveChain'),
    'src/settings.js 必须引入 saveChain 串行写队列'
  );
  assert.ok(
    /saveChain\s*=\s*saveChain\.catch\(\(\)\s*=>\s*\{\}\)\.then/.test(SETTINGS_JS) ||
    /saveChain\s*=\s*saveChain\.then/.test(SETTINGS_JS),
    'persistSettings 必须将保存操作挂载到 saveChain 队列中串行执行'
  );
});

test('P1-4: 串行队列行为模拟：并发保存保证后序请求等待前序完成后才读取磁盘', async () => {
  let diskState = { port: 8787, model_list_mode: 'all', log_level: 'info' };
  let activeWrites = 0;
  let maxConcurrentWrites = 0;
  
  let saveChain = Promise.resolve();
  const mockPersistSettings = (patch) => {
    saveChain = saveChain.catch(() => {}).then(async () => {
      activeWrites++;
      if (activeWrites > maxConcurrentWrites) maxConcurrentWrites = activeWrites;
      // 模拟异步读盘
      await new Promise(r => setTimeout(r, 10));
      const current = { ...diskState };
      // 模拟脏合并与写盘
      await new Promise(r => setTimeout(r, 10));
      diskState = { ...current, ...patch };
      activeWrites--;
      return true;
    });
    return saveChain;
  };

  // 并发触发两个保存
  const [res1, res2] = await Promise.all([
    mockPersistSettings({ model_list_mode: 'available' }),
    mockPersistSettings({ log_level: 'debug' })
  ]);

  assert.equal(res1, true);
  assert.equal(res2, true);
  assert.equal(maxConcurrentWrites, 1, '写盘操作必须严格串行（并发数恒为 1）');
  assert.equal(diskState.model_list_mode, 'available', '第一项修改必须被保留');
  assert.equal(diskState.log_level, 'debug', '第二项修改必须被保留');
});
