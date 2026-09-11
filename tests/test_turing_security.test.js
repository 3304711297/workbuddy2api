import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const { looksLikeSdk } = require(path.join(rootDir, 'turing_helper.cjs'));

test('Turing SDK 供应链安全严格校验测试', async (t) => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'turing-sec-test-'));

  t.after(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch (_) {}
  });

  await t.test('1. 缺少 index.cjs 入口无论如何都拒绝', () => {
    const d = path.join(tmpBase, 'no-index');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'turing-fake' }));
    fs.writeFileSync(path.join(d, 'turing_sdk.node'), '');

    assert.strictEqual(looksLikeSdk(d, true), false);
    assert.strictEqual(looksLikeSdk(d, false), false);
  });

  await t.test('2. 假冒目录：含 index.cjs + turing_sdk.node + 无 Turing 标识的 package.json，严格模式必须拦截！', () => {
    const d = path.join(tmpBase, 'fake-sdk-arbitrary-pkg');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.cjs'), '// evil payload');
    fs.writeFileSync(path.join(d, 'turing_sdk.node'), 'binary');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'some-random-library', description: 'not related' }));

    // 核心断言：此前代码存在 bug：(hasNative && has(/^package\.json$/i)) 导致此处逃逸为 true。
    // 修复后严格模式下 package.json 无 turing 标识必须严格返回 false！
    assert.strictEqual(looksLikeSdk(d, true), false, '严格校验必须拒绝无 turing 标识的普通 package.json');
  });

  await t.test('3. 正确目录：含 index.cjs + turing_sdk.node + 含 turing 标识的 package.json，严格模式放行', () => {
    const d = path.join(tmpBase, 'valid-sdk-name');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.cjs'), '// ok');
    fs.writeFileSync(path.join(d, 'turing_sdk.node'), 'binary');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'workbuddy-turing-sdk' }));

    assert.strictEqual(looksLikeSdk(d, true), true);
  });

  await t.test('4. 正确目录：原生模块在 build/Release 子目录，package.json description 含 turing，严格模式放行', () => {
    const d = path.join(tmpBase, 'valid-sdk-release-dir');
    fs.mkdirSync(path.join(d, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(d, 'index.cjs'), '// ok');
    fs.writeFileSync(path.join(d, 'build', 'Release', 'turing_sdk.node'), 'binary');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'my-pkg', description: 'TuringShieldSDK native wrapper' }));

    assert.strictEqual(looksLikeSdk(d, true), true);
  });

  await t.test('5. 官方 DLL 特征：含 index.cjs + TuringShieldSDK.dll，严格模式放行', () => {
    const d = path.join(tmpBase, 'valid-sdk-dll');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.cjs'), '// ok');
    fs.writeFileSync(path.join(d, 'TuringShieldSDK.dll'), 'binary');

    assert.strictEqual(looksLikeSdk(d, true), true);
  });

  await t.test('6. 显式配置目录（strict=false）：仅需 index.cjs 即可信任放行', () => {
    const d = path.join(tmpBase, 'explicit-user-dir');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.cjs'), '// custom wrapper');

    assert.strictEqual(looksLikeSdk(d, false), true);
  });
});
