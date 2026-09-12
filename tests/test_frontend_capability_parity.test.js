/**
 * 前端与内核能力对等性契约测试
 *
 * 背景：内核已交付多项能力（三协议网关、临期优先调度、静默降级感知、网关能力元数据、
 * Codex CLI 接入），此前 GUI 未消费，形成「后端已宣称 / 前端没跟上」的信息滞后。
 *
 * 本文件锁定前端必须消费的字段与必须存在的入口，防止再次漂移。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const HTML = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf-8');
const ACCOUNTS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'accounts.js'), 'utf-8');
const SERVICE_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'service.js'), 'utf-8');
const AGENTS_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'agents.js'), 'utf-8');
const PROXY_RS = fs.readFileSync(
  path.join(REPO_ROOT, 'src-tauri', 'src', 'commands', 'proxy.rs'),
  'utf-8'
);

// ==================== P1：协议徽章 / Codex 卡片 / 临期优先 ====================

test('P1 看板端点卡标注三协议，而非仅 OpenAI 兼容', () => {
  assert.ok(
    HTML.includes('id="dash-protocol-badge"'),
    'index.html 缺少 dash-protocol-badge：端点卡徽章需可按内核上报协议数动态渲染'
  );
  assert.ok(
    !HTML.includes('>OpenAI 兼容<'),
    '端点卡不应再硬编码「OpenAI 兼容」——内核已支持三协议（chat/messages/responses）'
  );
});

test('P1 Agent 接入页提供 Codex CLI 卡片（Responses 协议引导）', () => {
  assert.ok(HTML.includes('id="btn-guide-codex"'), 'index.html 缺少 Codex CLI 引导按钮');
  assert.ok(HTML.includes('Codex CLI'), 'index.html 缺少 Codex CLI 卡片标题');
  assert.ok(
    HTML.includes('id="codex-guide"'),
    'index.html 缺少 codex-guide 引导容器'
  );
  assert.ok(
    AGENTS_JS.includes('renderCodexGuide'),
    'agents.js 缺少 renderCodexGuide 渲染函数'
  );
  assert.ok(
    AGENTS_JS.includes('wire_api'),
    'Codex 引导必须体现 wire_api="responses"（Codex CLI 的 Responses 协议开关）'
  );
  assert.ok(
    AGENTS_JS.includes('config.toml'),
    'Codex 引导必须指向 ~/.codex/config.toml'
  );
  assert.ok(
    AGENTS_JS.includes("/v1/responses"),
    'Codex 引导必须给出 Responses 端点路径'
  );
});

test('P1 多账号策略卡展示「临期优先」到期日（消费 rotation.soonest_expire_day）', () => {
  assert.ok(
    ACCOUNTS_JS.includes('soonest_expire_day'),
    'accounts.js 未消费 rotation.soonest_expire_day —— 内核已按到期日分层调度，GUI 应可见'
  );
  assert.ok(
    ACCOUNTS_JS.includes('临期'),
    'accounts.js 缺少「临期」相关展示文案'
  );
});

// ==================== P2：降级感知 / 网关能力元数据 ====================

test('P2 GUI 展示静默降级感知（消费 fallbacks 字段）', () => {
  assert.ok(
    ACCOUNTS_JS.includes('fallbacks'),
    'accounts.js 未消费 fallbacks —— 模型被静默降级时用户应在 GUI 看到'
  );
  assert.ok(
    ACCOUNTS_JS.includes('降级'),
    'accounts.js 缺少「降级」展示文案'
  );
});

test('P2 GUI 展示网关能力元数据（消费 server.protocols / maxBodyMb）', () => {
  assert.ok(
    ACCOUNTS_JS.includes('server'),
    'accounts.js 未读取 server 元数据'
  );
  assert.ok(
    ACCOUNTS_JS.includes('protocols'),
    'accounts.js 未消费 server.protocols'
  );
  assert.ok(
    ACCOUNTS_JS.includes('maxBodyMb'),
    'accounts.js 未消费 server.maxBodyMb（413 防护上限应对用户可见）'
  );
});

// ==================== P3：三协议连通性测试 ====================

test('P3 连通性测试支持三种协议（前端入口 + 内核分发）', () => {
  assert.ok(
    HTML.includes('id="select-test-protocol"'),
    'index.html 缺少测试协议选择器 select-test-protocol'
  );
  assert.ok(
    SERVICE_JS.includes('protocol'),
    'service.js 未向 proxy_test_chat 传递 protocol 参数'
  );
  assert.ok(
    PROXY_RS.includes('protocol'),
    'proxy.rs 的 proxy_test_chat 未接收 protocol 参数'
  );
  // 协议分发：三条路径由同一函数按 proto 动态拼装（/v1/{path}，chat → chat/completions）
  assert.ok(
    PROXY_RS.includes('/v1/{path}'),
    'proxy.rs 未按 proto 动态拼装端点路径'
  );
  assert.ok(
    PROXY_RS.includes('"messages"') && PROXY_RS.includes('"responses"'),
    'proxy.rs 缺少 messages / responses 两种协议的分发分支'
  );
  // 三种协议的 SSE 增量解析必须各自实现（事件形态不同）
  assert.ok(
    PROXY_RS.includes('content_block_delta') || PROXY_RS.includes('/delta/text'),
    'proxy.rs 缺少 Anthropic Messages 的文本增量解析（delta.text）'
  );
  assert.ok(
    PROXY_RS.includes('response.output_text.delta'),
    'proxy.rs 缺少 Responses 的文本增量解析（response.output_text.delta）'
  );
});

// ==================== 运行时常量说明（不改后端透传） ====================

test('设置页标注高级运行时开关需环境变量且重启内核才生效', () => {
  assert.ok(
    HTML.includes('id="runtime-advanced-hint"'),
    'index.html 缺少 runtime-advanced-hint：高级运行时开关（投影压缩/图片上限/413 上限）'
      + '不在 AppConfig 中，必须在界面标注配置方式与生效条件'
  );
  assert.ok(
    HTML.includes('重启') && HTML.includes('环境变量'),
    '运行时开关提示必须写明「环境变量」与「重启内核」两个要件'
  );
});
