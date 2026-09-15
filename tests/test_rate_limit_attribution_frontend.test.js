import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const ACCOUNTS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'accounts.js'), 'utf-8');

test('A accounts.js 账号列表不得将冷却提示硬绑定到 a.is_active', () => {
  assert.ok(
    !ACCOUNTS_JS.includes('${a.is_active ? coolingTip : \'\'}'),
    '致命归因错误：accounts.js 不得把 coolingTip 无条件挂在 a.is_active 上，这会导致健康的当前账号背锅而真正受限的账号显示就绪！'
  );
});

test('B accounts.js 必须支持账号级冷却状态判定 (uid 级别归因)', () => {
  assert.ok(
    ACCOUNTS_JS.includes('limitedUid') || ACCOUNTS_JS.includes('isActiveAccountLimited') || ACCOUNTS_JS.includes('accountCooldowns'),
    'accounts.js 必须消费后端返回的 limitedUid / isActiveAccountLimited / accountCooldowns 字段进行账号隔离'
  );
});

test('C accounts.js 主卡片在备用账号冷却而当前活跃账号正常时，不得显示当前账号红色冷却报警', () => {
  assert.ok(
    ACCOUNTS_JS.includes('已避让') || ACCOUNTS_JS.includes('备用账号'),
    '当当前账号正常但备用账号被限时，主卡片应体现「已避让」或「备用账号冷却中」，避免误报当前活跃账号已触发频率限制'
  );
});
