/**
 * 设置串行保存队列契约（React+TS 迁移版）。
 *
 * 迁移映射：旧 `src/settings.js` 的 saveChain / persistSettings
 * → 新 `src/services/settingsService.ts` 的 saveChain / persist。
 * 串行单写队列 + 写前读盘 + 读盘失败中止 三条不变，由 settingsService 保证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SERVICE_TS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'settingsService.ts'), 'utf-8');

function persistBlock() {
  const start = SERVICE_TS.indexOf('const persist = (patch');
  assert.ok(start > -1, '未找到 persist');
  return SERVICE_TS.slice(start, start + 4200);
}

test('P1-4: persist 具备 saveChain 串行单写队列以防御并发 Lost Update', () => {
  assert.ok(
    SERVICE_TS.includes('let saveChain: Promise<boolean> = Promise.resolve(true);'),
    'settingsService.ts 必须声明 saveChain 串行写队列'
  );
  assert.ok(
    /saveChain\s*=\s*saveChain\.catch\(\(\)\s*=>\s*false\)\.then/.test(SERVICE_TS),
    'persist 必须将保存操作挂载到 saveChain 队列中串行执行（前序失败不得阻塞后续保存）'
  );
});

test('P1-4: persist 的保存体确实跑在 saveChain 队列内', () => {
  const block = persistBlock();
  assert.ok(
    /saveChain\s*=\s*saveChain\.catch\(\(\)\s*=>\s*false\)\.then\(async \(\) =>/.test(block),
    'persist 函数体内必须把保存逻辑挂载到 saveChain'
  );
  const chainIdx = block.indexOf('saveChain = saveChain');
  const readIdx = block.indexOf('getAppSettings()');
  assert.ok(chainIdx > -1 && readIdx > chainIdx, '读盘必须发生在队列内部（串行化读-改-写）');
});

test('写前读盘：persist 必须先读磁盘真源再写盘', () => {
  const block = persistBlock();
  const readIdx = block.indexOf('getAppSettings()');
  const writeIdx = block.indexOf('saveAppSettings(');
  assert.ok(readIdx > -1, 'persist 必须先调用 getAppSettings() 读取磁盘真源');
  assert.ok(writeIdx > readIdx, '读取必须发生在写入之前');
});

test('读盘失败中止：禁止用陈旧 cache 写盘', () => {
  const block = persistBlock();
  // 读盘 try/catch 内：onError 提示 + return false，且 return false 在 saveAppSettings 之前
  const errIdx = block.indexOf('读取磁盘设置失败');
  const saveIdx = block.indexOf('saveAppSettings(');
  assert.ok(errIdx > -1, '读盘失败必须提示「读取磁盘设置失败…」');
  assert.ok(errIdx < saveIdx, '读盘失败必须中止本次保存（不执行 saveAppSettings）');
  const errSeg = block.slice(errIdx, errIdx + 200);
  assert.ok(errSeg.includes('return false'), '读盘失败分支必须返回 false（调用方不弹成功 toast）');
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
