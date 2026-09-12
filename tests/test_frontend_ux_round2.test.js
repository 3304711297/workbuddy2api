/**
 * 前端体验补齐契约测试（第二轮）
 *
 * 覆盖三类缺口：
 *   A. 签到状态查询（内核有 /api/checkin/status，前端从未消费）
 *   B. 限流历史与当前活跃账号（lastSeenLocal / active_uid 后端已给，前端 0 消费）
 *   C. 借鉴 EasyCLIProxyAPI v0.2.90 的高价值项：
 *      - 用量数据「按时间范围筛选」（4h/24h/今日/7d/30d/全部）
 *      - 请求明细可下钻（events 列表）
 *      - 刷新并发去重（requestId 防竞态）
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
const USAGE_JS = fs.readFileSync(path.join(REPO_ROOT, 'src', 'usage.js'), 'utf-8');
const PROXY_RS = fs.readFileSync(
  path.join(REPO_ROOT, 'src-tauri', 'src', 'commands', 'proxy.rs'),
  'utf-8'
);
const LIB_RS = fs.readFileSync(path.join(REPO_ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf-8');
const CONVERTER_PY = fs.readFileSync(path.join(REPO_ROOT, 'converter.py'), 'utf-8');

// ==================== A. 签到状态查询 ====================

test('A 内核提供 checkin/status 端点的前置事实未漂移', () => {
  assert.ok(
    CONVERTER_PY.includes('/api/checkin/status'),
    'converter.py 未提供 /api/checkin/status（本测试的前提）'
  );
});

test('A Rust 侧提供 proxy_checkin_status 命令桥接内核 status 端点', () => {
  assert.ok(
    PROXY_RS.includes('proxy_checkin_status'),
    'proxy.rs 缺少 proxy_checkin_status 命令'
  );
  assert.ok(
    PROXY_RS.includes('/api/checkin/status'),
    'proxy.rs 未请求内核 /api/checkin/status'
  );
  assert.ok(
    LIB_RS.includes('proxy_checkin_status'),
    'lib.rs 未注册 proxy_checkin_status 命令'
  );
});

test('A 前端查询签到状态并据此渲染按钮文案（今天是否已签到）', () => {
  assert.ok(
    ACCOUNTS_JS.includes('proxy_checkin_status'),
    'accounts.js 未调用 proxy_checkin_status —— 按钮无法反映今天是否已签到'
  );
  assert.ok(
    ACCOUNTS_JS.includes('today_checked_in'),
    'accounts.js 未消费 today_checked_in 字段'
  );
  assert.ok(
    ACCOUNTS_JS.includes('已签到'),
    'accounts.js 缺少「已签到」文案（签到完成后按钮应变为已完成态）'
  );
  assert.ok(
    ACCOUNTS_JS.includes('btn-daily-checkin'),
    'accounts.js 丢失签到按钮引用'
  );
});

// ==================== B. 限流历史与活跃账号 ====================

test('B 展示上次限流发生时间（消费 lastSeenLocal）', () => {
  assert.ok(
    ACCOUNTS_JS.includes('lastSeenLocal'),
    'accounts.js 未消费 lastSeenLocal —— 用户看不到上次限流发生在何时'
  );
});

test('B 展示当前活跃账号 UID（消费 rotation.active_uid）', () => {
  assert.ok(
    ACCOUNTS_JS.includes('active_uid'),
    'accounts.js 未消费 rotation.active_uid —— 多账号场景下无法确认当前使用哪个账号'
  );
});

// ==================== C. 借鉴 EasyCLIProxyAPI 的高价值项 ====================

test('C 用量页提供时间范围筛选（借鉴 EasyCLIProxyAPI 的 4h/24h/今日/7d/30d/全部）', () => {
  assert.ok(
    HTML.includes('id="select-usage-range"'),
    'index.html 缺少用量时间范围选择器 select-usage-range'
  );
  const ranges = ['4h', '24h', 'today', '7d', '30d', 'all'];
  for (const r of ranges) {
    assert.ok(
      HTML.includes(`value="${r}"`),
      `index.html 用量范围选择器缺少 ${r} 选项`
    );
  }
  assert.ok(
    USAGE_JS.includes('usage-range') || USAGE_JS.includes('select-usage-range'),
    'usage.js 未读取范围选择器的值'
  );
});

test('C 刷新时防竞态（请求序号校验，借鉴 refreshScheduler 思路）', () => {
  assert.ok(
    USAGE_JS.includes('_usageRequestSeq'),
    'usage.js 缺少请求序号防竞态机制：快速切换范围时旧响应可能覆盖新结果'
  );
  assert.ok(
    USAGE_JS.includes('seq !== _usageRequestSeq'),
    'usage.js 未在响应返回时校验序号（陈旧响应必须丢弃）'
  );
});

test('C 范围切换不堆积并发请求（就地重渲染 + 单次静默刷新）', () => {
  assert.ok(
    USAGE_JS.includes('_lastUsageData'),
    'usage.js 未缓存最近数据：范围切换应就地重渲染，而非等待网络'
  );
  assert.ok(
    USAGE_JS.includes("select-usage-range") && USAGE_JS.includes("addEventListener('change'"),
    'usage.js 未监听范围选择器变更'
  );
});
