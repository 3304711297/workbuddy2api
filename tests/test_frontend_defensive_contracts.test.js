/**
 * 前端防御机制契约测试（2026-09-16 全量修复批次）
 *
 * 本批修复的共同特征：都是「静态读码看不出来、只在特定时序/环境下失效」的缺陷。
 * 子代理修复时已在仓库外用 DOM 垫片验证过行为（含变异测试），但脚手架未入库，
 * 故此处把「机制必须存在且不被静默移除」的部分固化进来。
 *
 * ⚠️ 断言写法要求（本文件迭代中踩过的坑，务必遵守）：
 * 不要断言标识符「存在」——包含式断言对重命名/替换无效（把 `pollInFlight` 改成
 * `pollInFlightXX` 仍能通过），只对整段删除有效。这正是本仓库既有测试的通病
 * （104 个断言放过了 P0 死按钮）。必须断言**结构性关系**：赋值/比较配对、提前
 * return、复位、反例不存在（「不得再出现 X」）。
 *
 * 每个断言都做过变异验证：把源码还原成缺陷形态，测试必须变红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

/** 剥注释：说明性注释会引用被否决的写法，污染结构性断言 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '').replace(/([^:])\/\/[^\n]*/g, '$1');

const SERVICE = stripComments(read('src/service.js'));
const MAIN = stripComments(read('src/main.js'));
const TABS = stripComments(read('src/tabs.js'));
const ACCOUNTS = stripComments(read('src/accounts.js'));
const DEBUG = stripComments(read('src/debug.js'));
const OAUTH = stripComments(read('src/oauth.js'));
const LOGS = stripComments(read('src/logs.js'));
const UTILS = stripComments(read('src/utils.js'));
const SETTINGS = stripComments(read('src/settings.js'));
const MODELS = stripComments(read('src/models.js'));
const UPDATE = stripComments(read('src/update-check.js'));
const USAGE = stripComments(read('src/usage.js'));
const CSS = stripComments(read('src/style.css'));

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
  assert.ok(/[A-Za-z_]*[Pp]ending\s*=\s*true|[A-Za-z_]*[Ii]n[Ff]light\s*=\s*true/.test(src),
    `${what}：缺少在途置位（并发请求会叠加）`);
  assert.ok(/[A-Za-z_]*[Pp]ending\s*=\s*false|[A-Za-z_]*[Ii]n[Ff]light\s*=\s*false/.test(src),
    `${what}：在途标志未复位（一次失败后机制会永久停摆）`);
}

// ---------------------------------------------------------------------------
// 请求序号防竞态
// ---------------------------------------------------------------------------

test('并发加载模块各自持有「赋值 + 比较」配对的请求序号', () => {
  // 这些加载可能耗时数十秒（usage_query 上游 30s 超时）。无序号时旧响应覆盖新状态：
  // 账号页把切换后的账号显示回原账号；看板在停止服务后回跳「运行中」。
  assertSeqPattern(SERVICE, /\+\+_healthSeq|_healthSeq\s*=\s*[^=]/, /[!=]==?\s*_healthSeq|_healthSeq\s*[!=]==?/, 'service.js 健康检查');
  assertSeqPattern(ACCOUNTS, /\+\+_accountsRequestSeq/, /[!=]==?\s*_accountsRequestSeq|_accountsRequestSeq\s*[!=]==?/, 'accounts.js 账号数据');
  assertSeqPattern(DEBUG, /\+\+_snapshotsRequestSeq/, /[!=]==?\s*_snapshotsRequestSeq|_snapshotsRequestSeq\s*[!=]==?/, 'debug.js 快照列表');
  assertSeqPattern(USAGE, /\+\+_usageRequestSeq/, /[!=]==?\s*_usageRequestSeq|_usageRequestSeq\s*[!=]==?/, 'usage.js 用量汇总');
  assertSeqPattern(USAGE, /\+\+_usageEventsSeq/, /[!=]==?\s*_usageEventsSeq|_usageEventsSeq\s*[!=]==?/, 'usage.js 用量明细');
});

test('健康轮询：在途守卫 + 隐藏停表 + 可见重起（三者缺一都会退化）', () => {
  assertInFlightGuard(MAIN, 'main.js 健康轮询');
  assert.ok(/visibilitychange/.test(MAIN), 'main.js 未处理 visibilitychange（隐藏后仍 7×24 轮询）');
  // 必须同时存在「清理」与「起表」：只停不起会让轮询再也不跑
  assert.ok(/clearInterval\s*\(\s*state\.healthTimer\s*\)/.test(MAIN), '隐藏时未清理轮询定时器');
  assert.ok(/(setInterval\s*\([^)]*healthTimer|startHealthPolling\s*\()/.test(MAIN),
    '可见时未重新起表（隐藏一次后轮询永久停摆）');
});

test('看板运行架构由 JS 写活值，不再依赖 HTML 硬编码占位', () => {
  assert.ok(
    /getElementById\(\s*['"]dash-mode['"]\s*\)/.test(SERVICE),
    'service.js 未引用 #dash-mode（会永远显示 HTML 里的静态文案）'
  );
});

// ---------------------------------------------------------------------------
// 服务启停按钮门控
// ---------------------------------------------------------------------------

test('服务控制按钮按运行状态门控（停止态下「重启」不可点）', () => {
  assert.ok(
    /btnRestart\.disabled\s*=\s*!isRunning/.test(SERVICE),
    'service.js 未按运行状态门控 btnRestart：服务未运行时「重启」仍可点，语义错配'
  );
});

// ---------------------------------------------------------------------------
// OAuth 轮询重入（成功分支会写盘 + 切活跃账号，风险最高）
// ---------------------------------------------------------------------------

test('auth_poll 轮询有「在途守卫 + 终态作废」双重防护', () => {
  assertInFlightGuard(OAUTH, 'oauth.js 轮询');
  // 代次：自增 + 比较配对（取消/成功后在途响应不得再判定成功）
  assertSeqPattern(OAUTH, /\+{2}\w*[Gg]en|\w*[Gg]en\s*\+\+/, /[!=]==?\s*\w*[Gg]en|\w*[Gg]en\s*[!=]==?/, 'oauth.js 轮询代次');
});

// ---------------------------------------------------------------------------
// 日志页
// ---------------------------------------------------------------------------

test('日志自动滚动：必须做贴底判断（不得无条件跳底），且提供可切换开关', () => {
  // 反例：在 loadLogs 的轮询路径上「无条件」跳底（此前即如此，用户回溯时被 2s 轮询反复拉走）。
  // 允许的出现形式只有两种：受 autoScroll 门控、或在用户主动恢复的点击处理里。
  const pollJump = /viewer\.textContent\s*=[^\n]*\n\s*(?!if\s*\()viewer\.scrollTop\s*=\s*viewer\.scrollHeight/.test(LOGS);
  assert.ok(!pollJump, 'logs.js 在替换内容后无条件跳到底部，用户无法向上回溯日志（排障时被 2s 轮询反复拉走）');
  // 自动跳底若存在，必须紧跟受 autoScroll 门控
  if (/viewer\.scrollTop\s*=\s*viewer\.scrollHeight/.test(LOGS)) {
    assert.ok(
      /if\s*\(\s*autoScroll\s*\)\s*viewer\.scrollTop\s*=\s*viewer\.scrollHeight/.test(LOGS),
      'logs.js 的自动跳底未受 autoScroll 门控'
    );
  }
  // 贴底判断需滚动几何量三者齐备
  assert.ok(/scrollHeight/.test(LOGS) && /scrollTop/.test(LOGS) && /clientHeight/.test(LOGS),
    'logs.js 缺少贴底几何判断（无法知道用户是否已上滚）');
  assert.ok(/log-auto-scroll/.test(LOGS), 'logs.js 未接上 #log-auto-scroll 开关');
  assert.ok(/aria-pressed/.test(LOGS), 'logs.js 未同步开关的 aria-pressed（读屏无法得知暂停态）');
});

test('日志清空需二次确认（排障证据链不可误删）', () => {
  const i = LOGS.indexOf('btn-clear-logs');
  assert.ok(i > -1, 'logs.js 未绑定清空按钮');
  assert.ok(/showConfirm/.test(LOGS.slice(i, i + 900)), 'logs.js「清空日志」缺少 showConfirm 二次确认');
});

// ---------------------------------------------------------------------------
// 外链协议白名单（半可信上游可下发 auth_url）
// ---------------------------------------------------------------------------

test('openExternal 实施协议白名单、不抛错、window.open 带 noopener', () => {
  const i = UTILS.indexOf('openExternal');
  assert.ok(i > -1, 'utils.js 缺 openExternal');
  const fn = UTILS.slice(i, i + 1400);
  assert.ok(/new URL\(/.test(fn), 'openExternal 未解析 URL（无协议校验）');
  assert.ok(
    /protocol\s*!==\s*['"]https?:['"]|protocol\s*===\s*['"]http:['"]/.test(fn),
    'openExternal 未比对 protocol 白名单（半可信上游可下发任意站点引导用户「授权登录」）'
  );
  assert.ok(/return false/.test(fn), 'openExternal 未以 false 表示拒绝（调用方无法区分成败）');
  assert.ok(/noopener/.test(fn), 'window.open 兜底缺 noopener,noreferrer');
});

test('update-check 不再自行调 shell.open（须经 openExternal 的协议校验）', () => {
  assert.ok(
    !/__TAURI__[^\n]*shell[^\n]*\.open/.test(UPDATE),
    'update-check.js 仍直接调 shell.open，绕过 openExternal 的应用层校验'
  );
  assert.ok(/openExternal/.test(UPDATE), 'update-check.js 未改为走 openExternal');
});

test('Mock invoke 不得把含密钥的实参打进控制台', () => {
  const i = UTILS.indexOf('Mock Invoke');
  assert.ok(i > -1, 'utils.js 缺 Mock invoke 分支');
  const line = UTILS.slice(i, UTILS.indexOf('\n', i));
  assert.ok(!/\bargs\b/.test(line), 'Mock invoke 仍引用 args（dev/浏览器环境会输出 api_key 明文）');
});

// ---------------------------------------------------------------------------
// 设置写入安全
// ---------------------------------------------------------------------------

test('读盘失败必须中止保存，且必须早于 save_app_settings', () => {
  // dirty-merge 下，读盘失败若继续写盘，非 patch 字段会沿用内存 cache（含 api_key），
  // 一次瞬时 IPC 失败即可把旧密钥写回磁盘。
  const failIdx = SETTINGS.indexOf('读取磁盘设置失败');
  assert.ok(failIdx > -1, 'settings.js 读盘失败分支未给出中止提示');
  assert.ok(/return false/.test(SETTINGS.slice(failIdx, failIdx + 400)),
    'settings.js 读盘失败分支未中止（会带着陈旧 cache 写盘）');
  assert.ok(
    SETTINGS.indexOf('save_app_settings', failIdx) > failIdx,
    'settings.js 读盘失败后仍走到 save_app_settings（旧密钥会被静默写回）'
  );
});

test('自动拉起按 proxy_start 返回值区分「已启动」与「已在运行」', () => {
  assert.ok(
    /already-running/.test(SETTINGS),
    'settings.js 未消费 proxy_start 的 already-running 返回值，会谎报「已按设置自动拉起」'
  );
});

// ---------------------------------------------------------------------------
// 模型页 / 剪贴板
// ---------------------------------------------------------------------------

test('剪贴板复制必须走 copyToClipboard（带失败检测），不得裸调 writeText', () => {
  assert.ok(/\[data-copy\]/.test(MODELS), 'models.js 未注册 data-copy 按钮');
  assert.ok(/copyToClipboard/.test(MODELS), 'models.js 未复用 copyToClipboard（无失败检测）');
  assert.ok(
    !/navigator\.clipboard\.writeText/.test(MODELS),
    'models.js 仍直接调 writeText：剪贴板被拒时仍会弹「已复制成功」'
  );
});

test('云端同步失败须给出可辨识提示（不得谎报成功）', () => {
  assert.ok(
    /同步失败/.test(MODELS),
    'models.js 未对降级路径给出提示（用户会误以为拿到了云端模型矩阵）'
  );
});

test('可点击的非按钮元素必须键盘可达（下拉项 / 行内标签）', () => {
  assert.ok(/tag-filter-item/.test(MODELS), 'models.js 未渲染标签筛选项');
  assert.ok(/tabindex="0"/.test(MODELS), 'models.js 下拉项/标签缺 tabindex，键盘无法到达');
  assert.ok(/role="button"/.test(MODELS), 'models.js 可点击元素缺 role="button"');
  assert.ok(/keydown/.test(MODELS), 'models.js 缺键盘事件处理');
  assert.ok(/preventDefault/.test(MODELS), 'models.js 键盘处理缺 preventDefault（Space 会滚动页面）');
});

// ---------------------------------------------------------------------------
// 可访问性样式（必须真在 CSS 里，不能只是注释里提到）
// ---------------------------------------------------------------------------

test('开关 input 必须视觉隐藏但可聚焦（display:none 会让键盘/读屏用户无法操作）', () => {
  const m = /\.switch-label input\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(m, 'style.css 未找到 .switch-label input 规则');
  assert.ok(!/display\s*:\s*none/.test(m[1]), '.switch-label input 用 display:none 隐藏，键盘与读屏不可达');
  assert.ok(/opacity\s*:\s*0/.test(m[1]), '.switch-label input 未采用视觉隐藏（应 1px + opacity:0）');
  assert.ok(
    /\.switch-label input:focus-visible\s*\+\s*\.switch-slider/.test(CSS),
    'style.css 缺少开关的 :focus-visible 焦点指示（应画在可见滑块上）'
  );
});

test('按钮焦点环与徽章类定义齐备', () => {
  assert.ok(/\.btn:focus-visible/.test(CSS), 'style.css 缺 .btn:focus-visible，Tab 到按钮无可见焦点');
  for (const cls of ['.badge-success', '.badge-warn']) {
    assert.ok(CSS.includes(cls), `style.css 缺少 ${cls} 定义（会渲染成裸文字）`);
  }
});

// ---------------------------------------------------------------------------
// 错误态与状态清理
// ---------------------------------------------------------------------------

test('账号列表读取失败必须渲染错误态，而非伪装成「尚未登录」', () => {
  assert.ok(
    /status\s*!==\s*['"]fulfilled['"]/.test(ACCOUNTS) && /reason/.test(ACCOUNTS),
    'accounts.js 未区分「列表为空」与「读取失败」，读失败会误导用户重新授权'
  );
});

test('_lastActiveUid 必须可被清空（服务停止后不得残留「当前活跃」）', () => {
  // 必须是「按条件赋 null」的形状，而不是仅在 truthy 时赋值
  assert.ok(
    /_lastActiveUid\s*=\s*[^;\n]*\?[^;\n]*:\s*null/.test(ACCOUNTS) || /_lastActiveUid\s*=\s*null/.test(ACCOUNTS),
    '_lastActiveUid 只写不清：内核离线后仍显示上次的活跃账号'
  );
});

// ---------------------------------------------------------------------------
// 用量图表
// ---------------------------------------------------------------------------

test('用量图表空数据分支必须清空 X 轴（否则留着上次的时间标签）', () => {
  const fnStart = USAGE.search(/function renderUsage\(/);
  assert.ok(fnStart > -1, '未找到 renderUsage 函数');
  const body = USAGE.slice(fnStart);
  const clearIdx = body.indexOf("axis.textContent = ''");
  const emptyIdx = body.indexOf('暂无数据');
  assert.ok(clearIdx > -1, 'usage.js 未清空 X 轴（空数据后仍残留上次的时间标签）');
  assert.ok(clearIdx < emptyIdx, 'usage.js 的 X 轴清空必须在「暂无数据」分支之前');
});

// ---------------------------------------------------------------------------
// 更新检查 / Tab 记忆
// ---------------------------------------------------------------------------

test('静默更新检查失败必须落可辨识状态', () => {
  assert.ok(/检查失败/.test(UPDATE), 'update-check.js 静默失败无信号，用户无法区分「从未检查」与「检查失败」');
  assert.ok(/\.title\s*=/.test(UPDATE), 'update-check.js 失败态未落到 entry.title（用户看不到）');
});

test('Tab 切换写入存储并在启动时恢复', () => {
  assert.ok(/sessionStorage|localStorage/.test(TABS), 'tabs.js 未持久化当前 Tab（刷新后总是回到看板）');
  assert.ok(/setItem/.test(TABS), 'tabs.js 缺写入调用');
  assert.ok(/getItem/.test(TABS), 'tabs.js 缺读取调用');
  assert.ok(/\.click\(\)/.test(TABS), 'tabs.js 未在启动时触发恢复切换（读了也不用）');
});
