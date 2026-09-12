/**
 * 密钥优先级契约测试（2026-09-12 二次评审补充）
 *
 * 二次评审指出：改走环境变量注入后，若**父进程环境**本身存在 WORKBUDDY2API_KEY，
 * 即使 GUI 的 api_key 为空，子进程仍可能继承该变量并启用鉴权。
 *
 * 实测结论（本测试锁定，防止日后漂移）：
 *   A. 环境有值 + GUI 未设 → 内核启用鉴权（继承生效）—— 属实，但**不是**本次 P2 引入：
 *      内核 --api-key 的 _env_compat("KEY") 默认值自 db88e36（2026-09-11 改名兼容层）起就存在。
 *   B. GUI 显式设值 → **GUI 值胜出**，父进程环境变量不会反向覆盖（实测 200/401 对拍）。
 *      即真实优先级为：GUI 显式配置 > 继承的环境变量 > 无鉴权。
 *
 * 因优先级已由 argparse「CLI 显式值覆盖 default」语义天然保证，本轮不引入
 * 「GUI 空密钥时清除环境变量」的行为变更，改为把优先级在文档里说死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS = (p) => readFileSync(join(ROOT, p), 'utf8');

const AGENTS = JS('AGENTS.md');
const CONVERTER = JS('converter.py');

test('AGENTS.md 必须写明密钥三档优先级（GUI > 环境变量 > 无）', () => {
  const i = AGENTS.indexOf('密钥注入方式');
  assert.ok(i > -1, 'AGENTS.md 缺少「密钥注入方式」章节');
  const seg = AGENTS.slice(i, i + 1600);
  assert.ok(
    /GUI\s*显式[^>]{0,6}>\s*继承\s*环境变量|GUI[^>]{0,6}>\s*环境变量/.test(seg),
    '必须在文档里说死优先级：GUI 显式配置 > 继承的环境变量 > 无鉴权'
  );
});

test('AGENTS.md 须声明「父进程已设环境变量时 GUI 留空仍会鉴权」这一副作用', () => {
  const i = AGENTS.indexOf('密钥注入方式');
  const seg = AGENTS.slice(i, i + 1600);
  assert.ok(
    /WORKBUDDY2API_KEY/.test(seg),
    '文档须点名环境变量 WORKBUDDY2API_KEY（含旧名兼容）'
  );
  assert.ok(
    /继承/.test(seg),
    '文档须说明 GUI 留空时会继承父进程环境变量并启用鉴权（用户可见副作用）'
  );
});

test('内核仍以 _env_compat("KEY") 为 --api-key 默认值（继承行为的实现基础）', () => {
  const seg = CONVERTER.match(/"--api-key"[\s\S]{0,200}/)?.[0] || '';
  assert.ok(
    seg.includes('_env_compat("KEY"'),
    '内核 --api-key 默认值必须取自 _env_compat("KEY")，否则环境变量链路失效'
  );
});

test('CLI 显式 --api-key 必须覆盖环境变量（优先级由 argparse 语义保证）', () => {
  // argparse 的 default 仅在 CLI 未显式给值时生效——这是优先级「GUI > 环境」的
  // 实现基础。此处锁定 default 形态为 _env_compat 调用（而非硬编码空串），
  // 若日后被改成 default="" 则环境变量链路整体失效，测试转红。
  const seg = CONVERTER.match(/"--api-key"[\s\S]{0,200}/)?.[0] || '';
  assert.ok(
    /default\s*=\s*_env_compat\("KEY"/.test(seg),
    '--api-key 必须以 _env_compat("KEY") 作为 default，显式传参时自动覆盖之'
  );
});
