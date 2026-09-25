/**
 * 限流归因前端契约测试（React+TS 迁移版）。
 *
 * 背景（历史致命归因错误）：旧 accounts.js 曾把冷却提示无条件挂在 a.is_active
 * 上（`${a.is_active ? coolingTip : ''}`），导致健康的当前账号背锅、真正受限的
 * 备用账号显示就绪。本测试锁定 uid 级别归因在 React 迁移中不退化。
 *
 * 契约映射（旧 → 新）：
 *   A. 「不得硬绑定 a.is_active」→ AccountsPage.tsx 不得再出现旧插值模式，
 *      且 RateLimitCard 必须按 limitedUid / isActiveAccountLimited 区分
 *      isCurrentLimited（当前账号被限）与 isOtherLimited（备用账号被限，已避让）。
 *   B. 「消费后端归因字段」→ AccountsPage.tsx 的 coolingModelNames 与
 *      RateLimitCard 消费 accountCooldowns / limitedUid / isActiveAccountLimited；
 *      accountsService.pickLimitedAccount 按 isActiveAccountLimited 选限流卡目标账号。
 *   C. 「备用账号冷却时主卡片不得误报」→ i18n 文案 accounts.rateLimitAvoided
 *     （已自动避让）+ rateLimitAvoidedNote（备用账号…冷却中 · 当前账号正常）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const read = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf-8');
const ACCOUNTS_TSX = read('src/pages/AccountsPage.tsx');
const ACCOUNTS_SERVICE = read('src/services/accountsService.ts');
const I18N = read('src/i18n/zh-CN.ts');

test('A AccountsPage.tsx 不得把冷却提示硬绑定到 is_active（历史致命归因错误不得回归）', () => {
  // 旧 bug 模式：无条件 `${a.is_active ? coolingTip : ''}` —— 新代码不得出现同类写法
  assert.ok(
    !ACCOUNTS_TSX.includes('a.is_active ? coolingTip'),
    '致命归因错误回归：不得把 coolingTip 无条件挂在 a.is_active 上'
  );
  // 正向：冷却报警必须按 uid 级归因区分「当前被限」与「他号被限」
  assert.ok(ACCOUNTS_TSX.includes('isCurrentLimited'), 'RateLimitCard 缺少 isCurrentLimited 判定');
  assert.ok(ACCOUNTS_TSX.includes('isOtherLimited'), 'RateLimitCard 缺少 isOtherLimited 判定');
  // 当前账号冷却才给红色报警；他号冷却给「已避让」黄色态
  assert.ok(
    /isCurrentLimited \? \(\s*<Dot color="var\(--danger\)" pulse/.test(ACCOUNTS_TSX),
    '只有当前活跃账号被限时才允许红色脉冲报警'
  );
});

test('B AccountsPage.tsx 必须支持账号级冷却状态判定 (uid 级别归因)', () => {
  assert.ok(ACCOUNTS_TSX.includes('limitedUid'), '未消费 limitedUid 字段');
  assert.ok(ACCOUNTS_TSX.includes('isActiveAccountLimited'), '未消费 isActiveAccountLimited 字段');
  assert.ok(ACCOUNTS_TSX.includes('accountCooldowns'), '未消费 accountCooldowns 字段');
  // 账号卡片的冷却模型名按 uid 归属计算（旧 renderAccountsGrid 的冷却映射逻辑）
  assert.ok(ACCOUNTS_TSX.includes('coolingModelNames'), '缺少按 uid 归属的冷却模型名计算');
  // 服务层：限流卡目标账号优先 isActiveAccountLimited 指向的账号
  assert.ok(ACCOUNTS_SERVICE.includes('pickLimitedAccount'), 'accountsService 缺少 pickLimitedAccount');
  assert.ok(ACCOUNTS_SERVICE.includes('isActiveAccountLimited'), 'pickLimitedAccount 未用 isActiveAccountLimited 选号');
});

test('C 当前账号正常但备用账号冷却时，主卡片必须体现「已避让」而非误报当前账号被限', () => {
  // 他号被限分支渲染避让文案（t('accounts.rateLimitAvoided')）
  assert.ok(
    ACCOUNTS_TSX.includes("t('accounts.rateLimitAvoided')"),
    'RateLimitCard 的 isOtherLimited 分支必须渲染 rateLimitAvoided 文案'
  );
  // i18n 真源：避让文案 + 备用账号说明
  assert.ok(
    /'accounts\.rateLimitAvoided': '[^']*避让[^']*'/.test(I18N),
    'i18n 缺少「避让」文案（accounts.rateLimitAvoided）'
  );
  assert.ok(
    I18N.includes('备用账号'),
    'i18n 缺少「备用账号」说明（rateLimitAvoidedNote：备用账号冷却中 · 当前账号正常）'
  );
});
