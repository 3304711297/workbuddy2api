// 看门工作流（upstream-watch）自动收口契约（2026-11-04 新增）
//
// 背景：2026-11-04 实测一次真实静默失败 —— 巡检已 0 待跟进项，"Auto-close" 步骤也执行了，
// 但 Issue #39 仍开着，整条流水线还是绿的。根因是查询被写成了：
//     EXISTING=$(gh issue list ... 2>/dev/null || true)
// GitHub 的 GraphQL 恰好返回 502（Something went wrong while executing your query），
// stderr 被丢掉、非零退出被 `|| true` 吞掉，EXISTING 变成空串 → 走 else 分支 →
// "无待跟进项，也无未关闭 Issue，跳过"。也就是说：**查询故障被伪装成了「没有 Issue」**。
//
// 本测试锁三件事：
//   ① 不得再用 `|| true` / `2>/dev/null` 把查询失败洗成空结果（负向断言，可变异复现）；
//   ② 必须有有限重试，且重试耗尽后显式失败（宁可变红，也不要静默漏关）；
//   ③ 正常路径仍要真的关闭 Issue（不能为了 fail-closed 把功能删了）。

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(root, '.github', 'workflows', 'upstream-watch.yml'), 'utf8');

// 剥离 YAML 注释：注释里复述了被否掉的写法（2>/dev/null || true），不剥离会让负向断言恒失败。
const code = raw
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

test('不得用 || true / 2>/dev/null 吞掉 Issue 查询失败', () => {
  assert.ok(
    !/gh issue list[^\n]*\|\|\s*true/.test(code),
    'gh issue list 仍带 `|| true`：查询故障会被伪装成「没有 open Issue」，Issue 静默漏关'
  );
  assert.ok(
    !/gh issue list[^\n]*2>\s*\/dev\/null/.test(code),
    'gh issue list 仍重定向 stderr 到 /dev/null：GraphQL 错误将不可见'
  );
});

test('查询失败必须有限重试，重试耗尽后显式失败', () => {
  const retries = code.match(/for i in 1 2 3; do/g) ?? [];
  assert.ok(
    retries.length >= 3,
    `三个 Issue 相关步骤（create/retain/auto-close）都应有 3 次重试，实际只有 ${retries.length} 处`
  );
  assert.match(
    code,
    /if out=\$\(gh issue list[^\n]*\); then/,
    '重试体必须用 if 捕获 gh 的退出码，否则无法区分「查询失败」与「无 Issue」'
  );
  const guards = code.match(/EXISTING=\$\(get_issue\) \|\| \{ echo "::error::[^"]+"; exit 1; \}/g) ?? [];
  assert.ok(
    guards.length >= 3,
    `每个查询点都必须有「重试耗尽即中止」守卫，实际只有 ${guards.length} 处`
  );
});

test('创建/更新 Issue 不得吞掉 gh 写入失败', () => {
  assert.ok(
    !/gh issue (create|edit|comment)[^\n]*\|\|\s*true/.test(code),
    'gh issue create/edit/comment 仍带 `|| true`：写入失败会被伪装成成功（并发下可能漏建/漏更新）'
  );
  // 多行命令的 `|| true` 会落在末行参数后面，单行正则抓不到，必须单独钉一次
  assert.ok(
    !/--label "upstream-watch"[^\n]*\|\|\s*true/.test(code),
    '`gh issue create` 的多行命令末尾仍带 `|| true`：创建失败会被吞掉'
  );
});

test('正常路径仍要关闭 Issue（fail-closed 不能把功能删掉）', () => {
  assert.match(code, /gh issue close "\$EXISTING"/, '缺少 gh issue close：收口能力被删掉了');
  assert.match(
    code,
    /\[ -n "\$EXISTING" \]/,
    '缺少非空判断：空 ID 会传给 gh issue close'
  );
});

test('自动收口的前置条件仍是「无待跟项且无查询失败」', () => {
  assert.match(
    code,
    /if:\s*steps\.check\.outputs\.has_updates == 'false' && steps\.check\.outputs\.has_query_failures == 'false'/,
    'Auto-close 步骤的 if 条件被改：可能在上游仍有新提交时误关 Issue'
  );
});
