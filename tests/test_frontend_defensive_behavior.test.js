/**
 * 前端防御性行为契约测试（前端迁移版，2026-09-26）
 *
 * 背景：旧前端把行为逻辑散在 index.html / src/*.js 的 DOM 代码里，
 * 旧版测试靠「动态 import + DOM 打桩」验证行为。新前端是 React+TS：
 * 页面组件无法在 node 里渲染（且不允许搭测试运行器覆盖 src），
 * 故本轮全部迁移为「针对 services/*.ts 纯逻辑与页面源码的静态结构契约」：
 * 守卫的写法本身被逐条锁定，而不是运行它。
 *
 * 契约变化说明（旧版对比）：
 *   ① openExternal 旧行为：拒绝非 http(s) 时返回 false「且不抛错」；
 *      新行为（src/services/external.ts）：**抛 Error（「拒绝打开非 http(s) 链接」）**，
 *      调用方按错误 toast 提示。防御强度不变、失败可见性更强，
 *      本文件断言新行为（抛错），旧「返回 false」断言已失效；
 *   ② 服务按钮门控：旧断言看 index.html 的按钮 disabled；新版按钮在
 *      src/components/Header.tsx（三键：启动/重启/停止），门控语义不变：
 *      运行中禁用「启动」，停止态禁用「重启」「停止」；
 *   ③ 日志清空确认：旧版 window.confirm → 新版 useConfirm 自定义确认框，
 *      「先确认再执行、取消不清」的语义保留；
 *   ④ 非 Tauri 安全失败：旧版 mock invoke 静默；新版 invokeTauri 在浏览器/dev
 *      环境先 warn 仅命令名、再抛中文错误，调用方展示环境横幅并安全失败。
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

const OAUTH_SVC = read('src/services/oauthService.ts');
const EXTERNAL = read('src/services/external.ts');
const TAURI = read('src/services/tauri.ts');
const DASHBOARD = read('src/pages/DashboardPage.tsx');
const LOGS = read('src/pages/LogsPage.tsx');
const PROVIDER = read('src/state/ServiceProvider.tsx');
const HEADER = read('src/components/Header.tsx');

// ==================== OAuth 轮询守卫 ====================

test('auth_poll：在途守卫生效（并发恒为 1）', () => {
  // 上游 auth_poll 超时可达 30s（2s 间隔），无守卫会堆积在途请求。
  // oauthService.createOAuthController 的 tick 必须以 inFlight 门控并发。
  assert.ok(
    /const tick = async \(\) => \{[\s\S]*?const gen = generation;[\s\S]*?if \(inFlight\) return;[\s\S]*?inFlight = true;/.test(OAUTH_SVC),
    'tick 未以 inFlight 门控并发：上游挂起时轮询请求会堆积'
  );
  assert.ok(
    /finally \{[\s\S]*?inFlight = false;/.test(OAUTH_SVC),
    'tick 未在 finally 释放 inFlight：一次异常会永久卡死轮询'
  );
});

test('auth_poll：取消/新轮次作废在途响应（终态不得回跳）', () => {
  // begin() 与 cancel() 都 generation++：上一轮的在途 poll 回来时
  // tick 以 gen !== generation 丢弃 —— 成功落盘/弹提示只属于当前轮次。
  assert.ok(
    /begin\(\) \{[\s\S]*?generation\+\+;/.test(OAUTH_SVC),
    'begin 未作废上一轮：旧轮次在途成功会错误落盘'
  );
  assert.ok(
    /cancel\(\) \{[\s\S]*?generation\+\+;/.test(OAUTH_SVC),
    'cancel 未作废在途 poll：卸载页面后成功回调仍会弹提示'
  );
  assert.ok(
    /if \(gen !== generation\) return;/.test(OAUTH_SVC),
    'tick 未丢弃被作废轮次的响应'
  );
});

test('auth_poll：成功后停表（不再发起新轮询）', () => {
  // code === 0 成功必须 stopTimer + onSuccess；只回调不清除 timer 会继续打轮询。
  assert.ok(
    /if \(res\.code === 0 && res\.data\) \{[\s\S]*?stopTimer\(\);[\s\S]*?callbacks\.onSuccess\(\);/.test(OAUTH_SVC),
    '成功后未停表：轮询会继续打 auth_poll'
  );
  // tick 上限：120 tick（约 4 分钟，腾讯 state 有效期），超时按取消处理
  assert.ok(
    /if \(ticks > OAUTH_MAX_TICKS\) \{[\s\S]*?stopTimer\(\);[\s\S]*?callbacks\.onTimeout\(\);/.test(OAUTH_SVC),
    'tick 上限未停表并回调超时'
  );
  assert.ok(
    /OAUTH_MAX_TICKS = 120/.test(OAUTH_SVC),
    'OAUTH_MAX_TICKS 不是 120'
  );
});

// ==================== 健康检查陈旧响应丢弃 ====================

test('checkHealth：陈旧响应被丢弃（停止服务后不得回跳「运行中」）', () => {
  // 健康轮询在 healthService：checkHealthOnce 取号（seq），快照回来时
  // seq !== healthSeq 即判陈旧返回 null，调用方不落态。
  const HEALTH_SVC = read('src/services/healthService.ts');
  assert.ok(
    /const seq = \+\+healthSeq;/.test(HEALTH_SVC),
    '健康检查未取号（seq）'
  );
  assert.ok(
    /if \(seq !== healthSeq\) return null;/.test(HEALTH_SVC),
    '健康检查未丢弃陈旧响应：停止后迟到包会回跳「运行中」'
  );
  // 启停/重启前必须作废在途检查
  assert.ok(
    /export function bumpHealthSeq\(\): void \{\s*healthSeq\+\+;/.test(HEALTH_SVC),
    '缺少 bumpHealthSeq：启停/重启前无法作废在途检查'
  );
  const startIdx = PROVIDER.indexOf('const startProxy');
  const stopIdx = PROVIDER.indexOf('const stopProxy');
  assert.ok(
    startIdx > 0 && /bumpHealthSeq\(\)/.test(PROVIDER.slice(startIdx, startIdx + 200)),
    'startProxy 前未作废在途健康检查'
  );
  assert.ok(
    stopIdx > 0 && /bumpHealthSeq\(\)/.test(PROVIDER.slice(stopIdx, stopIdx + 200)),
    'stopProxy 后未作废在途健康检查'
  );
});

// ==================== 按钮门控 ====================

test('服务按钮门控：Header 三键按运行态禁用（停止态「重启」不可点）', () => {
  // 新版服务按钮在 Header.tsx：启动/重启/停止三键，门控语义与旧版一致。
  assert.ok(
    /disabled=\{running\} onClick=\{\(\) => void startProxy\(\)\}/.test(HEADER),
    '运行中「启动」未禁用'
  );
  assert.ok(
    /disabled=\{!running\} onClick=\{\(\) => void restartProxy\(\)\}/.test(HEADER),
    '停止态「重启」未禁用：点重启会走到 proxy_restart 的异常分支'
  );
  assert.ok(
    /disabled=\{!running\} onClick=\{\(\) => void stopProxy\(\)\}/.test(HEADER),
    '停止态「停止」未禁用'
  );
});

test('连通性测试：运行中 select 与测试按钮必须禁用（防并发测试）', () => {
  // 测试运行时（result.phase === 'running'）协议选择器与测试按钮都 disabled，
  // 防止用户中途换协议打乱在途请求。
  assert.ok(
    /value=\{protocol\}[\s\S]*?disabled=\{result\.phase === 'running'\}/.test(DASHBOARD),
    '测试运行时协议选择器未禁用'
  );
  assert.ok(
    /onClick=\{\(\) => void runTest\(\)\}[\s\S]*?disabled=\{result\.phase === 'running'\}/.test(DASHBOARD),
    '测试运行时测试按钮未禁用'
  );
});

// ==================== 日志滚动与清空 ====================

test('日志：用户上滚后轮询不得强制跳底（且自动标记暂停）', () => {
  // LogsPage：上滚（!near）即关掉自动跟随标记；新日志到达只在跟随态滚到底。
  assert.ok(
    /if \(!near && autoScrollRef\.current\) setAutoScroll\(false\)/.test(LOGS),
    '用户上滚后未自动暂停跟随'
  );
  assert.ok(
    /if \(viewer && autoScrollRef\.current\)/.test(LOGS),
    '新日志到达未按跟随态决定是否滚到底'
  );
});

test('日志：清空需二次确认，用户取消则不清', () => {
  // handleClear 先 await confirm({ danger: true })；!ok 直接 return。
  assert.ok(
    /const handleClear = useCallback\(async \(\) => \{[\s\S]*?const ok = await confirm\(\{[\s\S]*?danger: true,/.test(LOGS),
    '清空日志未使用 danger 确认框'
  );
  assert.ok(
    /if \(!ok\) return;/.test(LOGS),
    '确认取消后仍会执行清空'
  );
});

// ==================== 外链 ====================

test('openExternal：非法协议抛错且绝不触达打开动作', () => {
  // ⚠️ 契约变化（见文件头①）：旧「返回 false 且不抛错」→ 新「抛 Error」。
  assert.ok(
    /if \(!isAllowedExternalUrl\(raw\)\) \{\s*throw new Error\(`拒绝打开非 http\(s\) 链接: \$\{raw\}`\);/.test(EXTERNAL),
    'openExternal 未在非法协议时抛错'
  );
  // 抛错发生在任何打开动作之前：throw 分支之后才出现 open(raw)/window.open
  const throwIdx = EXTERNAL.indexOf('拒绝打开非 http(s) 链接');
  const openIdx = EXTERNAL.indexOf('await open(raw)');
  assert.ok(throwIdx > 0 && openIdx > throwIdx, '打开动作位置异常：非法协议可能触达打开');
});

test('isAllowedExternalUrl：只放行 http/https', () => {
  // 纯校验函数：URL 解析失败返回 false；仅 http: / https: 通过。
  assert.ok(
    /return url\.protocol === 'http:' \|\| url\.protocol === 'https:';/.test(EXTERNAL),
    '协议白名单不是严格的 http:/https:'
  );
  assert.ok(
    /catch \{\s*return false;/.test(EXTERNAL),
    'URL 解析失败未返回 false（畸形输入会抛到调用方）'
  );
  // 浏览器兜底必须带 noopener,noreferrer（防 window.opener 劫持）
  assert.ok(
    /window\.open\(raw, '_blank', 'noopener,noreferrer'\)/.test(EXTERNAL),
    '浏览器兜底未带 noopener,noreferrer'
  );
});

// ==================== Tab 记忆 ====================

test('Tab：切换写入 sessionStorage，刷新可恢复', () => {
  assert.ok(
    /sessionStorage\.setItem\(TAB_STORAGE_KEY, t\)/.test(PROVIDER),
    'Tab 切换未写入 sessionStorage'
  );
  assert.ok(
    /sessionStorage\.getItem\(TAB_STORAGE_KEY\)/.test(PROVIDER),
    '启动时未从 sessionStorage 恢复 Tab'
  );
});

// ==================== Tauri 边界安全 ====================

test('invokeTauri：非 Tauri 环境安全失败（抛中文错误，不静默）', () => {
  // 浏览器/dev 环境：mock warn 后抛 NOT_IN_TAURI_MESSAGE，调用方展示环境横幅。
  assert.ok(
    /if \(!isTauriRuntime\(\)\) \{[\s\S]*?throw new Error\(NOT_IN_TAURI_MESSAGE\);/.test(TAURI),
    '非 Tauri 环境未抛 NOT_IN_TAURI_MESSAGE'
  );
  assert.ok(
    TAURI.includes('NOT_IN_TAURI_MESSAGE'),
    '缺少 NOT_IN_TAURI_MESSAGE 定义'
  );
});

test('Mock 日志只含命令名（参数绝不打印，防密钥泄漏）', () => {
  // 浏览器/dev 环境的 mock warn 只回显 cmd；snapshotReplay 等携带 apiKey，
  // 若把 args 打印出来就是把密钥写进控制台。
  assert.ok(
    /console\.warn\(`\[Mock Invoke\] \$\{cmd\} —/.test(TAURI),
    'Mock 日志格式异常'
  );
  assert.ok(
    !/console\.(warn|log|debug|error)\([^)]*args/.test(TAURI),
    'tauri.ts 有日志打印了 args：密钥可能泄漏到控制台'
  );
  assert.ok(
    !/console\.(warn|log|debug|error)\([^)]*apiKey/.test(TAURI),
    'tauri.ts 有日志打印了 apiKey'
  );
});
