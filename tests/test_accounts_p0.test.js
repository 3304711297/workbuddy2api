/**
 * 账号页 P0-3 / B1 契约测试（React+TS 迁移版）。
 *
 * 契约变更说明（中文）：
 *   1. P0-3 原契约锁的是旧实现「accounts.js 不得引用 btn-refresh-usage、必须用
 *      btn-refresh-account-quota 且经 container.querySelector 绑定」。React 迁移后
 *      不再有任何按 id 查找/绑定的按钮（全部 onClick 直连），因此两个旧 id 都应
 *      彻底消失 —— 既无冲突，也无回归土壤。新对等断言：账号页的「刷新积分」按钮
 *      经 onRefreshQuota 直连 loader.reload（只刷新账号/额度数据），用量页有自己
 *      独立的刷新（handleManualRefresh），两页刷新互不串扰。
 *   2. 原「index.html 保留 btn-refresh-usage + usage.js 绑定它」同样被替换：
 *      新 index.html 是 Vite React 入口，不再承载任何业务 id；用量页刷新按钮由
 *      UsagePage.tsx 自行渲染。
 *   3. B1（nightFree / reqsToday / expired 呈现）保持不变，断言目标改为
 *      AccountsPage.tsx 内的真实渲染逻辑。
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const ACCOUNTS_TSX = fs.readFileSync(path.join(rootDir, 'src', 'pages', 'AccountsPage.tsx'), 'utf-8');
const USAGE_TSX = fs.readFileSync(path.join(rootDir, 'src', 'pages', 'UsagePage.tsx'), 'utf-8');
const INDEX_HTML = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
const I18N = fs.readFileSync(path.join(rootDir, 'src', 'i18n', 'zh-CN.ts'), 'utf-8');

test('P0-3 React 迁移后账号页不得再出现任何旧刷新按钮 id（杜绝 btn-refresh-usage 冲突回归）', () => {
  // 两个旧 id 必须彻底消失：React 下按钮不再按 id 查找/绑定
  for (const id of ['btn-refresh-usage', 'btn-refresh-account-quota']) {
    assert.strictEqual(
      ACCOUNTS_TSX.includes(id),
      false,
      `AccountsPage.tsx 中严禁出现 ${id}（旧 id 冲突的回归土壤必须铲除）`
    );
    assert.strictEqual(
      USAGE_TSX.includes(id),
      false,
      `UsagePage.tsx 中严禁出现 ${id}`
    );
  }
  // 新 index.html 是 Vite React 入口，不再承载任何业务 id
  assert.strictEqual(
    INDEX_HTML.includes('btn-refresh-usage'),
    false,
    '新 index.html 不得再有 btn-refresh-usage（业务 id 已随旧实现删除）'
  );
});

test('P0-3 账号页的额度刷新按钮直连 loader（只刷新账号/额度，不碰用量明细）', () => {
  // QuotaBox 的刷新按钮经 onRefreshQuota 回调直连，不再走全局 id 查找
  assert.strictEqual(
    ACCOUNTS_TSX.includes('onRefreshQuota'),
    true,
    'AccountsPage.tsx 必须有 onRefreshQuota 额度刷新回调'
  );
  assert.strictEqual(
    ACCOUNTS_TSX.includes("t('accounts.refreshQuota')"),
    true,
    '额度刷新按钮必须使用 accounts.refreshQuota 文案'
  );
  assert.strictEqual(
    I18N.includes("'accounts.refreshQuota': '刷新积分'"),
    true,
    'i18n 必须有 accounts.refreshQuota = 刷新积分'
  );
  // 额度刷新触发的是账号数据重载（loader.load），而非用量事件查询
  assert.strictEqual(
    /onRefreshQuota=\{\(\) => void load\(\)\}/.test(ACCOUNTS_TSX),
    true,
    'onRefreshQuota 必须直连 load()（账号数据重载），不得调用用量明细接口'
  );
});

test('P0-3 用量页拥有独立的刷新按钮（与账号页互不串扰）', () => {
  assert.strictEqual(
    USAGE_TSX.includes('handleManualRefresh'),
    true,
    'UsagePage.tsx 必须有独立的 handleManualRefresh'
  );
  assert.strictEqual(
    USAGE_TSX.includes("t('usage.refresh')"),
    true,
    '用量页刷新按钮必须使用 usage.refresh 文案'
  );
  // 用量页刷新只拉汇总+明细，不触发账号 loader
  assert.strictEqual(
    USAGE_TSX.includes('createUsageLoader'),
    true,
    '用量页刷新必须走自己的 usage loader，与账号页隔离'
  );
});

test('B1 AccountsPage.tsx 覆盖 nightFree、reqsToday 与 expired 状态呈现', () => {
  assert.strictEqual(
    ACCOUNTS_TSX.includes('nightFree'),
    true,
    'AccountsPage.tsx 必须处理 nightFree 夜间免费标识'
  );
  assert.strictEqual(
    ACCOUNTS_TSX.includes('reqsToday'),
    true,
    'AccountsPage.tsx 必须处理 reqsToday 今日统计字段'
  );
  assert.strictEqual(
    ACCOUNTS_TSX.includes('expired'),
    true,
    'AccountsPage.tsx 必须处理 expired 恢复状态'
  );
});
