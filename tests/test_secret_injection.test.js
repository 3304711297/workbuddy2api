/**
 * 密钥注入方式契约测试（P2-1，2026-09-12 外部评审）
 *
 * 背景：Rust 启动内核时曾以命令行参数传密钥：
 *     cmd.arg("--api-key").arg(&api_key);
 * 密钥由此进入子进程 argv —— 本机任意有足够权限的进程都能通过
 * 任务管理器 / wmic / WMI Win32_Process.CommandLine / 第三方进程工具读到明文。
 * 加上 settings.json 也是明文，等于同一份 secret 有**两处明文暴露面**。
 *
 * 更安全且更简单的方案：改走环境变量注入。内核 argparse 的 --api-key 默认值
 * 本就取自 _env_compat("KEY", "")（即 WORKBUDDY2API_KEY / CODEBUDDY2OPENAI_KEY），
 * 因此内核零改动即可支持，只需 Rust 侧换成 cmd.env(...)。
 *
 * 锁定契约：
 *   A. proxy.rs 不得再通过 argv 传 --api-key
 *   B. proxy.rs 必须走 WORKBUDDY2API_KEY 环境变量注入
 *   C. 内核必须能从环境变量取到密钥（_env_compat 真源）
 *   D. 环境变量名与内核 --api-key 的 _env_compat("KEY") 后缀一致
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS = (p) => readFileSync(join(ROOT, p), 'utf8');

const PROXY_RS = JS('src-tauri/src/commands/proxy.rs');
const CONVERTER = JS('converter.py');

// 只看真实代码：去掉注释，避免「注释里写了 --api-key 说明」误判为仍在传参
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('A 内核启动不得再把密钥放进 argv（防明文进命令行）', () => {
  const code = stripComments(PROXY_RS);
  assert.ok(
    !/"--api-key"/.test(code),
    'proxy.rs 仍在以命令行参数 --api-key 传密钥——密钥会进入子进程 argv，' +
      '本机任意有权限的进程（任务管理器 / wmic / WMI）都能读到明文。请改用环境变量注入。'
  );
});

test('B 密钥必须走 WORKBUDDY2API_KEY 环境变量注入子进程', () => {
  const code = stripComments(PROXY_RS);
  assert.ok(
    code.includes('WORKBUDDY2API_KEY'),
    'proxy.rs 未通过 WORKBUDDY2API_KEY 环境变量注入密钥'
  );
  // 必须是 cmd.env(...) 形态（注入到子进程环境），而非仅字符串出现
  assert.ok(
    /\.env\(\s*"WORKBUDDY2API_KEY"/.test(code),
    '密钥必须以 cmd.env("WORKBUDDY2API_KEY", ...) 注入子进程环境'
  );
});

test('C 内核 --api-key 的默认值取自 _env_compat("KEY")（环境变量即真源）', () => {
  // 内核零改动的前提：argparse 默认值读环境变量
  const seg = CONVERTER.match(/"--api-key"[\s\S]{0,200}/)?.[0] || '';
  assert.ok(seg.length > 0, 'converter.py 未定义 --api-key 参数');
  assert.ok(
    seg.includes('_env_compat("KEY"'),
    'converter.py 的 --api-key 默认值必须取自 _env_compat("KEY")，否则环境变量注入无效'
  );
});

test('D 空密钥仍不得下发（传空串会开启校验却无有效密钥→全部 401）', () => {
  const code = stripComments(PROXY_RS);
  // 注入点必须带非空守卫：空值不得写入环境变量，避免内核把空串当「已配置」语义歧义
  assert.ok(
    /api_key\.is_empty\(\)/.test(code),
    '密钥注入处必须保留 api_key.is_empty() 非空判定'
  );
});
