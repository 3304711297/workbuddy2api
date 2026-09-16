/**
 * 前端防御机制**行为**测试（2026-09-16 全量修复批次）
 *
 * 与 test_frontend_defensive_contracts.test.js 的分工：
 *  - 契约文件做结构化静态断言（快、覆盖广）；
 *  - 本文件用 DOM 桩**真实 import 并驱动**被修模块，断言可观测行为。
 *
 * 为什么需要本文件：静态 grep 断言抓不到行为缺陷 —— 把 `if (autoScroll)` 改成
 * 无条件跳底、或删掉 finally 里的在途复位，包含式断言照样通过（实测 17 个变异
 * 只有 6 个被抓到）。行为测试才能确认「陈旧响应被丢弃」「并发恒为 1」真的成立。
 *
 * ⚠️ 桩的对象语义：installDomStubs 会**复制** elements 传入的属性到内部缓存对象，
 * 故断言必须通过 stub.getEl(id) 读取（不要持有传入的原始对象引用，那读不到变更）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDomStubs } from './helpers/dom-stub.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tag = 0;
const uniq = () => `?t=${Date.now()}-${++tag}`;

/** 等待条件成立（避免用固定 sleep 猜测时序） */
async function waitFor(fn, { timeout = 8000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
}

// ---------------------------------------------------------------------------
// OAuth 轮询：在途守卫 + 终态作废（成功分支会写盘并切活跃账号，风险最高）
// ---------------------------------------------------------------------------

test('auth_poll：上游挂起时并发恒为 1（在途守卫生效）', async () => {
  let polls = 0;
  let resolvePoll;
  const stub = installDomStubs({
    elements: { 'oauth-process-area': {}, 'oauth-status-text': {}, 'oauth-link-input': {} },
    invoke: async (cmd) => {
      if (cmd === 'auth_begin') return { state: 'S1', auth_url: 'https://copilot.tencent.com/x' };
      if (cmd === 'auth_poll') {
        polls += 1;
        // 挂起不返回：模拟上游卡顿（真实场景 2s 间隔 vs 30s 超时 → 可叠加约 15 路）
        return new Promise((res) => { resolvePoll = res; });
      }
      return {};
    },
  });

  const mod = await import('../src/oauth.js' + uniq());
  mod.initOAuth();
  await stub.getEl('btn-oauth-start').dispatch('click');

  // 等到第一次轮询真的发出（而非猜时间）
  assert.ok(await waitFor(() => polls >= 1), '轮询未启动');
  await sleep(5200); // 覆盖两个轮询周期

  assert.equal(polls, 1, `上游挂起期间发了 ${polls} 次 auth_poll，在途守卫失效（正常应恒为 1）`);

  // 收尾：放行挂起请求 + 取消轮询，避免 interval 挂住进程
  if (resolvePoll) resolvePoll({ code: 11217, msg: 'wait' });
  await sleep(50);
  await stub.getEl('btn-oauth-cancel').dispatch('click');
  await sleep(50);
});

test('auth_poll：成功后不再发起新轮询（终态作废）', async () => {
  let phase = 'pending';
  const stub = installDomStubs({
    elements: { 'oauth-process-area': {}, 'oauth-status-text': {}, 'oauth-link-input': {} },
    invoke: async (cmd) => {
      if (cmd === 'auth_begin') return { state: 'S1', auth_url: 'https://copilot.tencent.com/x' };
      if (cmd === 'auth_poll') {
        return phase === 'pending' ? { code: 11217, msg: 'wait' } : { code: 0, data: { nickname: 'n' } };
      }
      return {};
    },
  });

  const mod = await import('../src/oauth.js' + uniq());
  mod.initOAuth();
  await stub.getEl('btn-oauth-start').dispatch('click');

  // 等到至少一次 pending 轮询完成
  assert.ok(await waitFor(() => stub.calls.filter((c) => c.cmd === 'auth_poll').length >= 1, { timeout: 5000 }),
    '轮询未启动');

  phase = 'success';
  // 等成功轮询发生
  const gotSuccess = await waitFor(async () => {
    const n = stub.calls.filter((c) => c.cmd === 'auth_poll').length;
    return n >= 2;
  }, { timeout: 6000 });
  assert.ok(gotSuccess, '第二次轮询未发生，测试前提不成立');

  const afterSuccess = stub.calls.filter((c) => c.cmd === 'auth_poll').length;
  await sleep(4600); // 覆盖两个周期：若有残留轮询会再发
  const finalCount = stub.calls.filter((c) => c.cmd === 'auth_poll').length;
  assert.equal(finalCount, afterSuccess, `成功后仍发出 ${finalCount - afterSuccess} 次 auth_poll：清理不彻底，可能重复落盘凭据`);

  await stub.getEl('btn-oauth-cancel').dispatch('click');
  await sleep(50);
});

// ---------------------------------------------------------------------------
// 服务状态：陈旧健康响应不得覆盖新状态
// ---------------------------------------------------------------------------

test('checkHealth：陈旧响应被丢弃（停止服务后不得回跳「运行中」）', async () => {
  let resolveOld;
  let call = 0;
  const stub = installDomStubs({
    elements: {
      'side-dot': {}, 'side-status-text': {}, 'dash-status-badge': {}, 'dash-health-time': {},
      'dash-active-account': {}, 'side-active-user': {}, 'btn-start': {}, 'btn-stop': {},
      'btn-restart': {}, 'dash-mode': {},
      'test-result-box': {}, 'test-status-tag': {}, 'test-protocol-tag': {}, 'select-test-protocol': {},
      'test-model-tag': {}, 'test-latency': {}, 'test-ttft-wrap': {}, 'test-ttft': {}, 'test-response-text': {},
    },
    invoke: async (cmd) => {
      if (cmd === 'proxy_health') {
        call += 1;
        if (call === 1) return new Promise((res) => { resolveOld = () => res({ status: 'ok' }); });
        return { status: 'ok' };
      }
      if (cmd === 'accounts_list') return [];
      return {};
    },
  });

  const mod = await import('../src/service.js' + uniq());
  mod.initServiceControls();   // ← 必须：按钮监听是在这里注册的

  const first = mod.checkHealth();          // 在途（随后被停止动作作废）
  await waitFor(() => call >= 1);

  await stub.getEl('btn-stop').dispatch('click');  // 序号自增，作废在途检查
  await sleep(30);
  assert.equal(stub.getEl('dash-status-badge').textContent, '已停止', '停止动作后看板应显示「已停止」');

  if (resolveOld) resolveOld();              // 陈旧响应此时才返回
  await first;
  await sleep(50);

  assert.notEqual(
    stub.getEl('dash-status-badge').textContent,
    '运行中',
    '陈旧健康响应把看板刷回了「运行中」：请求序号未生效'
  );
  assert.equal(stub.getEl('btn-restart').disabled, true, '停止态下「重启」应禁用');
});

test('服务按钮门控：停止态下「重启」必须禁用', async () => {
  const stub = installDomStubs({
    elements: {
      'side-dot': {}, 'side-status-text': {}, 'dash-status-badge': {}, 'dash-health-time': {},
      'dash-active-account': {}, 'side-active-user': {}, 'btn-start': {}, 'btn-stop': {},
      'btn-restart': {}, 'dash-mode': {},
      'test-result-box': {}, 'test-status-tag': {}, 'test-protocol-tag': {}, 'select-test-protocol': {},
      'test-model-tag': {}, 'test-latency': {}, 'test-ttft-wrap': {}, 'test-ttft': {}, 'test-response-text': {},
    },
    invoke: async (cmd) => {
      if (cmd === 'proxy_health') throw new Error('内核未运行');
      if (cmd === 'accounts_list') return [];
      return {};
    },
  });

  const mod = await import('../src/service.js' + uniq());
  mod.initServiceControls();
  await mod.checkHealth();  // 抛错 → 走「已停止」分支
  await sleep(20);

  assert.equal(stub.getEl('btn-stop').disabled, true, '停止态下「停止服务」应为禁用');
  assert.equal(stub.getEl('btn-restart').disabled, true, '停止态下「重启」仍可点：语义错配');
  assert.equal(stub.getEl('btn-start').disabled, false, '停止态下「启动服务」应可用');
});

// ---------------------------------------------------------------------------
// 日志页：自动滚动门控
// ---------------------------------------------------------------------------

test('日志：用户上滚后轮询不得强制跳底（且自动标记暂停）', async () => {
  const stub = installDomStubs({
    elements: {
      'log-viewer': { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 }, // 非贴底
      'log-auto-scroll': {},
    },
    invoke: async (cmd) => (cmd === 'proxy_get_logs' ? 'line1\nline2\n' : {}),
  });

  const mod = await import('../src/logs.js' + uniq());
  const ok = await mod.loadLogs();
  const viewer = stub.getEl('log-viewer');

  assert.equal(ok, true, 'loadLogs 应返回成功');
  assert.equal(viewer.scrollTop, 100, `用户上滚后 scrollTop 被改成 ${viewer.scrollTop}：自动滚动未受贴底判断门控`);
  assert.equal(stub.getEl('log-auto-scroll')['aria-pressed'], 'false', '上滚后开关未标记为暂停态');
});

test('日志：贴底时保持跟随（不得因加入门控就永不滚动）', async () => {
  const stub = installDomStubs({
    elements: {
      'log-viewer': { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }, // 贴底（差 0px）
      'log-auto-scroll': {},
    },
    invoke: async (cmd) => (cmd === 'proxy_get_logs' ? 'new content\n' : {}),
  });

  const mod = await import('../src/logs.js' + uniq());
  await mod.loadLogs();
  const viewer = stub.getEl('log-viewer');
  assert.equal(viewer.scrollTop, viewer.scrollHeight, '贴底时应跟随到底部，否则实时日志看不到最新');
  assert.equal(stub.getEl('log-auto-scroll')['aria-pressed'], 'true', '贴底时应保持同步态');
});

test('日志：清空需二次确认，用户取消则不清', async () => {
  let cleared = 0;
  const stub = installDomStubs({
    elements: {
      'log-viewer': { scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
      'log-auto-scroll': {}, 'btn-clear-logs': {}, 'btn-refresh-logs': {}, 'btn-open-logs-dir': {},
      'confirm-overlay': { hidden: true }, 'confirm-title': {}, 'confirm-message': {},
      'confirm-ok': {}, 'confirm-cancel': {},
    },
    invoke: async (cmd) => {
      if (cmd === 'proxy_clear_logs') { cleared += 1; return 'ok'; }
      if (cmd === 'proxy_get_logs') return '';
      return {};
    },
  });

  // ⚠️ 不能用 uniq() 后缀：showConfirm 的待决状态（confirmState）是 utils 模块级的，
  // 若这里再 import 出第二个 utils 实例，logs.js 内部的 Promise 将永不结算 → 测试挂死。
  // 必须与 logs.js 解析到同一个 utils 实例（即无 query 的同一路径）。
  const logs = await import('../src/logs.js');
  const utils = await import('../src/utils.js');
  utils.initConfirmDialog();
  logs.initLogs();

  // 触发清空 → 弹确认框，未点确定前不得执行
  const p = stub.getEl('btn-clear-logs').dispatch('click');
  await sleep(30);
  assert.equal(cleared, 0, '用户尚未确认就执行了清空：破坏性操作缺少二次确认');
  assert.equal(stub.getEl('confirm-overlay').hidden, false, '未弹出确认框');

  // 点「取消」→ 结算为 false，不得清空
  await stub.getEl('confirm-cancel').dispatch('click');
  await p;
  assert.equal(cleared, 0, '取消后仍执行了清空');
  assert.equal(stub.getEl('confirm-overlay').hidden, true, '取消后确认框应关闭');

  // 收尾：释放日志轮询定时器，否则 node --test 进程不会退出
  logs.stopLogsPolling();
});

// ---------------------------------------------------------------------------
// openExternal：协议白名单（半可信上游可下发 auth_url）
// ---------------------------------------------------------------------------

test('openExternal：拒绝非 http(s) 协议且不抛错', async () => {
  let opened = 0;
  installDomStubs({ invoke: async () => ({}) });
  globalThis.window.__TAURI__.shell.open = async () => { opened += 1; };
  globalThis.window.open = () => { opened += 1; };

  const { openExternal } = await import('../src/utils.js' + uniq());

  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'data:text/html,<b>x</b>']) {
    const r = await openExternal(bad);
    assert.equal(r, false, `${bad} 应被拒绝（返回 false）`);
  }
  assert.equal(opened, 0, '非 http(s) 链接竟然触达了 shell.open / window.open（钓鱼原语）');

  const ok = await openExternal('https://copilot.tencent.com/login');
  assert.equal(ok, true, '合法 https 链接应放行');
  assert.equal(opened, 1, '合法链接应触达一次打开动作');
});

// ---------------------------------------------------------------------------
// Tab 记忆
// ---------------------------------------------------------------------------

test('Tab：切换写入 sessionStorage', async () => {
  const stub = installDomStubs({
    elements: { 'page-title': {}, 'page-desc': {} },
    invoke: async () => ({}),
  });
  const mkNav = (t) => ({
    dataset: { tab: t },
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                 toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener(ev, fn) { this._fn = fn; },
    click() { return this._fn && this._fn(); },
  });
  const navs = [mkNav('dashboard'), mkNav('usage')];

  globalThis.document.querySelectorAll = (sel) => (sel === '.nav-item' ? navs : []);
  globalThis.document.querySelector = (sel) => {
    const m = /data-tab="([^"]+)"/.exec(sel);
    return m ? (navs.find((n) => n.dataset.tab === m[1]) || null) : null;
  };
  const panels = {};
  globalThis.document.getElementById = (id) => {
    if (id.startsWith('panel-')) {
      return (panels[id] = panels[id] || {
        classList: { _s: new Set(), add() {}, remove() {}, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains() { return false; } },
      });
    }
    return stub.getEl(id);
  };

  const { initTabs } = await import('../src/tabs.js' + uniq());
  initTabs();

  await navs[1].click(); // 切到 usage
  const stored = globalThis.sessionStorage.getItem('workbuddy2api.tab');
  assert.equal(stored, 'usage', `Tab 未持久化（实际存值：${stored}）`);
  assert.equal(globalThis.document.getElementById('page-title').textContent, '用量统计', '标题未同步');
});
