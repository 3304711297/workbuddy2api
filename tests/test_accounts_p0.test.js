import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('P0-3 accounts.js 不得引用或绑定 btn-refresh-usage，必须使用 btn-refresh-account-quota', () => {
  const accountsJs = fs.readFileSync(path.join(rootDir, 'src', 'accounts.js'), 'utf-8');

  // 1. 验证 accounts.js 中不再出现 btn-refresh-usage
  assert.strictEqual(
    accountsJs.includes('btn-refresh-usage'),
    false,
    'accounts.js 中严禁出现 btn-refresh-usage（该 ID 专属 usage 模块）'
  );

  // 2. 验证 accounts.js 使用 btn-refresh-account-quota
  assert.strictEqual(
    accountsJs.includes('btn-refresh-account-quota'),
    true,
    'accounts.js 必须使用唯一的 btn-refresh-account-quota'
  );

  // 3. 验证事件绑定仅限 container 内部实际插入的按钮，而非全局 document.getElementById
  assert.strictEqual(
    accountsJs.includes("container.querySelector('#btn-refresh-account-quota')"),
    true,
    '事件绑定必须基于 container.querySelector，避免全局 document 查找与脱离 DOM 时的重复绑定'
  );
});

test('P0-3 usage.js 与 index.html 保持拥有独立的 btn-refresh-usage', () => {
  const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
  const usageJs = fs.readFileSync(path.join(rootDir, 'src', 'usage.js'), 'utf-8');

  assert.strictEqual(
    indexHtml.includes('id="btn-refresh-usage"'),
    true,
    'index.html 用量统计模块必须保有 btn-refresh-usage'
  );

  assert.strictEqual(
    usageJs.includes('btn-refresh-usage'),
    true,
    'usage.js 必须绑定独立的 btn-refresh-usage'
  );
});

test('B1 accounts.js 覆盖 nightFree、reqsToday 与 expired 状态呈现', () => {
  const accountsJs = fs.readFileSync(path.join(rootDir, 'src', 'accounts.js'), 'utf-8');

  assert.strictEqual(
    accountsJs.includes('nightFree'),
    true,
    'accounts.js 必须处理 nightFree 夜间免费标识'
  );
  assert.strictEqual(
    accountsJs.includes('reqsToday'),
    true,
    'accounts.js 必须处理 reqsToday 今日统计字段'
  );
  assert.strictEqual(
    accountsJs.includes('expired'),
    true,
    'accounts.js 必须处理 expired 恢复状态'
  );
});

