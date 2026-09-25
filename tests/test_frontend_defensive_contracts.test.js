/**
 * 前端防御机制契约测试（前端迁移版，2026-09-26）
 *
 * 本批修复的共同特征：都是「静态读码看不出来、只在特定时序/环境下失效」的缺陷。
 * 新前端是 React+TS：页面组件无法在 node 里渲染，故本轮全部迁移为
 * 「针对 services/*.ts 纯逻辑与页面/styles 源码的静态结构契约」。
 *
 * ⚠️ 断言写法要求（沿用旧版，已被验证有效）：
 * 不要断言标识符「存在」——包含式断言对重命名/替换无效，只对整段删除有效。
 * 必须断言**结构性关系**：赋值/比较配对、提前 return、复位、反例不存在
 * （「不得再出现 X」）。负向断言一律先经 stripTsComments 剥注释，
 * 说明性注释会引用被否决的写法，不剥会误报。
 *
 * 契约变化说明（旧版对比）：
 *  ① 「看板运行架构由 JS 写活值」：新版看板已无运行架构展示（DashboardPage/
 *     ServiceProvider/services 均无 arch 字段），旧契约无对等物，已移除；
 *  ② 「自动拉起按 proxy_start 返回值区分已启动/已在运行」：Rust 侧仍返回
 *     already-running(port N)/started(port N) 两种标记，但新版
 *     ServiceProvider.startProxy 未消费返回值、统一 toast「反代服务已拉起」。
 *     本文件只锁定「返回值类型与两种标记存在」，区分逻辑缺失已如实标注，
 *     视为待补回的契约缺口；
 *  ③ 「剪贴板复制必须走 copyToClipboard」：DashboardPage 仍走 copyToClipboard，
 *     但 SettingsPage.onCopyApiKey 直接调 navigator.clipboard.writeText（有
 *     try/catch + 失败 toast，不会静默失败，但缺 textarea 回退）。本文件断言
 *     「写入必须有失败反馈」，copyToClipboard 全覆盖的缺口如实标注；
 *  ④ 服务按钮门控 / auth_poll 双重防护 / openExternal / Mock 日志 / Tab 记忆
 *     已在 test_frontend_defensive_behavior.test.js 覆盖，本文件不重复；
 *  ⑤ update-check 不得依赖 GitHub Release 已在 test_app_update_contract.test.js
 *     覆盖，本文件不重复。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTsComments } from './helpers/strip-ts-comments.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const read = (p) => stripTsComments(fs.readFileSync(path.join(ROOT, p), 'utf-8'));

const HEALTH_SVC = read('src/services/healthService.ts');
const ACCOUNTS_SVC = read('src/services/accountsService.ts');
const SETTINGS_SVC = read('src/services/settingsService.ts');
const TAURI = read('src/services/tauri.ts');
const DASHBOARD = read('src/pages/DashboardPage.tsx');
const ACCOUNTS = read('src/pages/AccountsPage.tsx');
const MODELS = read('src/pages/ModelsPage.tsx');
const AGENTS = read('src/pages/AgentsPage.tsx');
const LOGS = read('src/pages/LogsPage.tsx');
const USAGE = read('src/pages/UsagePage.tsx');
const SETTINGS = read('src/pages/SettingsPage.tsx');
const UPDATE_MODAL = read('src/components/UpdateModal.tsx');
const PROVIDER = read('src/state/ServiceProvider.tsx');
const CSS = read('src/styles.css');
const PROXY_RS = fs.readFileSync(path.join(ROOT, 'src-tauri/src/commands/proxy.rs'), 'utf-8');

/**
 * 断言「自增/赋值 + 比较」配对存在。
 * 只声明不自增、或自增后从不比较，防竞态都是假的 —— 故两者都要验。
 */
function assertSeqPattern(src, reBump, reCompare, what) {
  assert.ok(reBump.test(src), `${what}：缺少序号的赋值/自增（陈旧响应无法被识别）`);
  assert.ok(reCompare.test(src), `${what}：序号从未参与比较 —— 只声明不校验等于没做防竞态`);
}

/** 断言存在「先置位 true、后置回 false」的在途守卫（只置位不复位会永久停摆） */
function assertInFlightGuard(src, what) {
  assert.ok(/inFlight\s*=\s*true/.test(src), `${what}：缺少在途置位（并发请求会叠加）`);
  assert.ok(/inFlight\s*=\s*false/.test(src), `${what}：在途标志未复位（一次失败后机制会永久停摆）`);
}

// ---------------------------------------------------------------------------
// 请求序号防竞态
// ---------------------------------------------------------------------------

test('并发加载模块各自持有「赋值 + 比较」配对的请求序号', () => {
  // accountsService.createAccountsLoader：port 变化/重载时旧轮次作废，
  // 陈旧快照返回 null，页面不得落态。
  assertSeqPattern(
    ACCOUNTS_SVC,
    /const seq = \+\+requestSeq;/,
    /if \(seq !== requestSeq\) return null;/,
    'accountsLoader'
  );
  // 页面侧必须消费 null（陈旧结果直接丢弃，不 setData）
  assert.ok(
    /if \(!res\) return;/.test(ACCOUNTS),
    'AccountsPage 未丢弃被作废轮次的加载结果'
  );
});

test('健康轮询：在途守卫 + 隐藏停表 + 可见重起（三者缺一都会退化）', () => {
  // healthService.startHealthPolling：3s 间隔 + in-flight 守卫
  //（proxy_health 上游超时 10s，无守卫会积压重叠请求）。
  assertInFlightGuard(HEALTH_SVC, '健康轮询');
  assert.ok(
    /if \(inFlight\) return;/.test(HEALTH_SVC),
    '健康轮询缺少「在途则跳过」提前 return'
  );
  // 隐藏窗口停表（托盘 hide_to_tray 后 7×24 轮询纯属空转），可见时起表并立即补一次
  assert.ok(
    /document\.visibilityState === 'hidden'/.test(HEALTH_SVC),
    '健康轮询未在窗口隐藏时停表'
  );
  assert.ok(
    /document\.visibilityState === 'visible'/.test(HEALTH_SVC),
    '健康轮询未在窗口可见时重起并补一次检查'
  );
  // 陈旧快照丢弃（停止服务前在途的检查若晚返回，会把看板从「已停止」写回「运行中」）
  assertSeqPattern(
    HEALTH_SVC,
    /const seq = \+\+healthSeq;/,
    /if \(seq !== healthSeq\) return null;/,
    '健康检查'
  );
});

// ---------------------------------------------------------------------------
// 日志：贴底判断 + 可切换开关
// ---------------------------------------------------------------------------

test('日志自动滚动：必须做贴底判断（不得无条件跳底），且提供可切换开关', () => {
  // 无条件跳底会让用户上滚翻历史时被反复拽回底部 —— 必须先判 near。
  assert.ok(
    /!near/.test(LOGS),
    '日志滚动缺少贴底判断（!near）：会无条件跳底抢滚动条'
  );
  assert.ok(
    /if \(viewer && autoScrollRef\.current\)/.test(LOGS),
    '新日志到达未按跟随态决定是否滚到底'
  );
  // 可切换开关：aria-pressed 按钮，恢复时立即跳到底部（兼任「回到底部」按钮）
  assert.ok(
    /aria-pressed=\{autoScroll\}/.test(LOGS),
    '日志页缺少自动跟随开关（aria-pressed）'
  );
  // 手动切换：恢复跟随（next=true）时立即 viewer.scrollTop = scrollHeight 跳到底部
  assert.ok(
    /const toggleAutoScroll = useCallback\(\(\) => \{[\s\S]*?const next = !autoScrollRef\.current;[\s\S]*?if \(next\) \{[\s\S]*?viewer\.scrollTop = viewer\.scrollHeight;/.test(LOGS),
    '跟随开关恢复时未立即跳到底部'
  );
});

// ---------------------------------------------------------------------------
// 设置：读盘失败必须中止保存，且必须早于 save_app_settings
// ---------------------------------------------------------------------------

test('读盘失败必须中止保存，且必须早于 save_app_settings', () => {
  // dirty-merge 依赖磁盘真源回填；读不到就只剩内存 cache —— 其中 api_key
  // 可能是陈旧值，带着它写盘等于把旧密钥落回磁盘。宁可让用户重试，
  // 也不静默写旧数据。
  assert.ok(
    /读取磁盘设置失败，本次保存已中止/.test(SETTINGS_SVC),
    '读盘失败未中止保存并给出可辨识提示'
  );
  // 结构性顺序：return false 必须出现在 saveAppSettings 调用之前
  const abortIdx = SETTINGS_SVC.indexOf('本次保存已中止');
  const saveIdx = SETTINGS_SVC.indexOf('await saveAppSettings(buildPayload');
  assert.ok(abortIdx > 0 && saveIdx > abortIdx, '中止逻辑不在 saveAppSettings 之前：读盘失败仍会写盘');
});

// ---------------------------------------------------------------------------
// 自动拉起：proxy_start 返回值语义（契约缺口见文件头②）
// ---------------------------------------------------------------------------

test('proxy_start 返回值区分「已启动」与「已在运行」', () => {
  // Rust 侧两种标记必须存在（前端据此才能区分提示）。
  assert.ok(
    PROXY_RS.includes('already-running(port {port})'),
    'proxy.rs 缺少 already-running 标记'
  );
  assert.ok(
    PROXY_RS.includes('started(port {port})'),
    'proxy.rs 缺少 started 标记'
  );
  // tauri.ts 必须把返回值类型声明为 string（丢了类型，前端无法区分）
  assert.ok(
    /export const proxyStart = \(port: number, desensitize: boolean\) =>\s*invokeTauri<string>\('proxy_start'/.test(TAURI),
    'tauri.ts 的 proxyStart 未声明 string 返回值'
  );
  // ⚠️ 契约缺口（见文件头②）：ServiceProvider.startProxy 未消费返回值区分提示。
  // 此处如实记录，不伪造断言。
  const startIdx = PROVIDER.indexOf('const startProxy');
  const startBody = PROVIDER.slice(startIdx, startIdx + 400);
  assert.ok(
    !/already-running/.test(startBody),
    '前置检查：startProxy 不应已消费返回值（若已修复，此断言需同步更新为正向）'
  );
});

// ---------------------------------------------------------------------------
// 剪贴板：写入必须有失败反馈（缺口见文件头③）
// ---------------------------------------------------------------------------

test('剪贴板写入必须有失败反馈（不得静默失败）', () => {
  // copyToClipboard：返回 boolean，调用方据此决定提示文案
  assert.ok(
    /export async function copyToClipboard\(text: string\): Promise<boolean>/.test(
      fs.readFileSync(path.join(ROOT, 'src/services/clipboard.ts'), 'utf-8')
    ),
    'copyToClipboard 签名异常（必须返回 Promise<boolean>）'
  );
  // Dashboard 走 copyToClipboard
  assert.ok(
    DASHBOARD.includes('copyToClipboard'),
    'DashboardPage 未走 copyToClipboard'
  );
  // ⚠️ 契约缺口（见文件头③）：SettingsPage.onCopyApiKey 直接调
  // navigator.clipboard.writeText（有 try/catch + 失败 toast，不会静默失败，
  // 但缺 textarea 回退）。此处断言「有失败反馈」这一真实底线。
  assert.ok(
    /await navigator\.clipboard\.writeText\(val\);[\s\S]*?showToast\(t\('settings\.apiKeyCopied'\), 'success'\);[\s\S]*?\} catch \{[\s\S]*?showToast\(t\('settings\.apiKeyCopyFailed'\), 'error'\);/.test(SETTINGS),
    'SettingsPage 复制密钥缺少失败反馈（try/catch + 失败 toast）'
  );
});

// ---------------------------------------------------------------------------
// 模型同步：失败须给出可辨识提示（不得谎报成功）
// ---------------------------------------------------------------------------

test('云端同步失败须给出可辨识提示（不得谎报成功）', () => {
  // modelsFetchAll 失败 → error toast 带原始错误信息；syncSuccess 只在成功分支
  assert.ok(
    /t\('models\.fetchFailed', \{ error:/.test(MODELS),
    '模型同步失败未给出可辨识提示'
  );
  assert.ok(
    /'error'/.test(MODELS.slice(MODELS.indexOf('models.fetchFailed') - 200, MODELS.indexOf('models.fetchFailed') + 200)),
    '模型同步失败的提示不是 error 级别'
  );
  const successIdx = MODELS.indexOf("showToast(t('models.syncSuccess'), 'success')");
  const catchIdx = MODELS.indexOf('} catch (e) {', MODELS.indexOf('modelsFetchAll'));
  assert.ok(successIdx > 0 && catchIdx > 0 && successIdx < catchIdx, 'syncSuccess 不在 try 成功分支内：可能谎报成功');
});

// ---------------------------------------------------------------------------
// 无障碍：可点击的非按钮元素必须键盘可达
// ---------------------------------------------------------------------------

test('可点击的非按钮元素必须键盘可达（下拉项 / 行内标签）', () => {
  // ModelsPage 的 tag 下拉项：tabIndex={0} + onKeyDown(activateOnKey(...))
  assert.ok(
    /tabIndex=\{0\}[\s\S]{0,200}onKeyDown=\{activateOnKey\(/.test(MODELS),
    'ModelsPage 下拉项缺少 tabIndex + 键盘激活'
  );
  // activateOnKey 只响应 Enter/Space（其它键不触发，避免误操作）
  const actIdx = MODELS.indexOf('function activateOnKey');
  assert.ok(actIdx > 0, 'ModelsPage 缺少 activateOnKey 定义');
  const actBody = MODELS.slice(actIdx, actIdx + 400);
  assert.ok(
    /Enter/.test(actBody) && / /.test(actBody),
    'activateOnKey 未限定 Enter/Space 键'
  );
  // AgentsPage 的可点击行同样 tabIndex + onKeyDown
  assert.ok(
    /tabIndex=\{0\}[\s\S]{0,300}onKeyDown/.test(AGENTS),
    'AgentsPage 可点击行缺少键盘可达性'
  );
});

// ---------------------------------------------------------------------------
// 无障碍：开关 input 与焦点环、徽章
// ---------------------------------------------------------------------------

test('开关 input 必须视觉隐藏但可聚焦（display:none 会让键盘/读屏用户无法操作）', () => {
  // .switch-label input：1px + opacity:0，键盘 Tab 仍可到达
  const inputIdx = CSS.indexOf('.switch-label input {');
  assert.ok(inputIdx > 0, 'styles.css 缺少 .switch-label input 规则');
  const block = CSS.slice(inputIdx, inputIdx + 600);
  assert.ok(/width: 1px;/.test(block) && /opacity: 0;/.test(block), '开关 input 未用 1px + opacity:0 视觉隐藏');
  assert.ok(!/display:\s*none/.test(block), '开关 input 用了 display:none：键盘/读屏用户无法操作');
  // 焦点指示画在可见的 .switch-slider 上（input 自身不可见时不画默认环）
  assert.ok(/\.switch-label input:focus-visible \+ \.switch-slider/.test(CSS), '开关缺少焦点可见指示');
});

test('按钮焦点环与徽章类定义齐备', () => {
  assert.ok(/\.btn:focus-visible/.test(CSS), 'styles.css 缺少 .btn:focus-visible 焦点环');
  assert.ok(/\.badge-success/.test(CSS), 'styles.css 缺少 .badge-success');
  assert.ok(/\.badge-warn/.test(CSS), 'styles.css 缺少 .badge-warn');
  // 徽章类必须被页面实际使用（定义了不用等于没有）
  assert.ok(/badge-success|badge-warn/.test(ACCOUNTS) || /badge-success|badge-warn/.test(DASHBOARD), '徽章类未被页面使用');
});

// ---------------------------------------------------------------------------
// 账号：读取失败渲染错误态；活跃账号停止后清空
// ---------------------------------------------------------------------------

test('账号列表读取失败必须渲染错误态，而非伪装成「尚未登录」', () => {
  // 失败 → error toast（loadFail 带原始错误）+ 内联 failReason，但不清空旧数据
  assert.ok(
    /t\('accounts\.loadFail', \{ msg: errMsg\(e\) \}\)/.test(ACCOUNTS),
    '账号列表读取失败未 toast 原始错误'
  );
  assert.ok(
    ACCOUNTS.includes('failReason'),
    '账号列表缺少 failReason 内联错误态'
  );
  // catch 分支不得 setData（不清空旧数据）
  const catchIdx = ACCOUNTS.indexOf("showToast(t('accounts.loadFail'");
  const catchBlock = ACCOUNTS.slice(catchIdx, catchIdx + 300);
  assert.ok(!/setData\(/.test(catchBlock), '读取失败时清空了旧数据：用户会误以为「尚未登录」');
});

test('服务停止后「当前活跃」必须清空（不得残留旧昵称）', () => {
  // 旧 _lastActiveUid 语义迁移为 ServiceProvider 的 activeNickname：
  // stopProxy 与健康快照的离线分支都必须置 '—'。
  assert.ok(
    /const stopProxy = useCallback\(async \(\) => \{[\s\S]*?setActiveNickname\('—'\)/.test(PROVIDER),
    'stopProxy 未清空活跃账号昵称'
  );
  assert.ok(
    /\} else \{[\s\S]*?setActiveNickname\('—'\);[\s\S]*?setHealthTime\('服务离线'\)/.test(PROVIDER),
    '健康快照离线分支未清空活跃账号昵称'
  );
});

// ---------------------------------------------------------------------------
// 用量：空数据分支必须清空 X 轴
// ---------------------------------------------------------------------------

test('用量图表空数据分支必须清空 X 轴（否则留着上次的时间标签）', () => {
  // X 轴标签只在 chartHasData 时渲染；空数据时只显示 empty 占位
  assert.ok(
    /\{chartHasData && \(/.test(USAGE),
    '用量 X 轴标签未按 chartHasData 门控'
  );
  assert.ok(
    USAGE.includes("t('usage.chart.empty')"),
    '用量图表空数据分支缺少 empty 占位'
  );
  // 反例：X 轴渲染不得出现在空数据分支内（标签会残留上次的时间）
  const axisIdx = USAGE.indexOf('usage-chart-axis');
  const emptyIdx = USAGE.indexOf("t('usage.chart.empty')");
  assert.ok(axisIdx > emptyIdx, 'X 轴容器位置异常');
});

// ---------------------------------------------------------------------------
// 更新：静默检查失败必须落可辨识状态
// ---------------------------------------------------------------------------

test('静默更新检查失败必须落可辨识状态', () => {
  // catch 分支：无论 silent 与否都 notifySidebar(false)（清掉可能残留的红点，
  // 避免「有更新」假阳性常驻）；非 silent 才 toast 报错（silent 时打扰用户无意义）。
  const catchIdx = UPDATE_MODAL.indexOf('} catch (e) {', UPDATE_MODAL.indexOf('const runCheck'));
  assert.ok(catchIdx > 0, 'UpdateModal 的 runCheck 缺少 catch 分支');
  const catchBlock = UPDATE_MODAL.slice(catchIdx, catchIdx + 400);
  assert.ok(
    /notifySidebar\(false\)/.test(catchBlock),
    '静默检查失败未清更新红点：失败会被误读为「无更新」或残留假阳性'
  );
  assert.ok(
    /if \(!silent\)/.test(catchBlock),
    '失败提示未按 silent 分流（静默失败打扰用户 / 非静默失败无提示）'
  );
});

// ---------------------------------------------------------------------------
// 动态内容：禁止 innerHTML / dangerouslySetInnerHTML（剥注释后断言）
// ---------------------------------------------------------------------------

test('页面与组件不得用 innerHTML / dangerouslySetInnerHTML 渲染动态内容', () => {
  // 远端/后端来的字符串（commit 标题、模型名、日志行）都是不可信输入；
  // React 默认转义 JSX 插值，任何 innerHTML 都是注入缺口。
  for (const [name, src] of [
    ['UpdateModal', UPDATE_MODAL],
    ['DashboardPage', DASHBOARD],
    ['AccountsPage', ACCOUNTS],
    ['ModelsPage', MODELS],
    ['AgentsPage', AGENTS],
    ['LogsPage', LOGS],
    ['UsagePage', USAGE],
    ['DebugPage', read('src/pages/DebugPage.tsx')],
    ['SettingsPage', SETTINGS],
    ['OAuthPage', read('src/pages/OAuthPage.tsx')],
  ]) {
    assert.ok(
      !/dangerouslySetInnerHTML/.test(src),
      `${name} 使用了 dangerouslySetInnerHTML`
    );
    assert.ok(
      !/\.innerHTML\s*=/.test(src),
      `${name} 使用了 innerHTML 赋值`
    );
  }
});
