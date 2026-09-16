/**
 * 服务生命周期与控制：启动 / 停止 / 重启 / 健康检查 / 连通性测试
 */

import { state } from './state.js';
import { showToast, invokeTauri } from './utils.js';

// 反代运行架构标签（直连上游、无中转网关）。
// index.html 的 #dash-mode 是静态占位，服务停止时也不会变，故改由状态驱动写入活值。
const RUNTIME_MODE_LABEL = 'Direct Proxy';

// 健康检查请求序号：/health 上游超时可达 10s，轮询/焦点/事件三路并发时，
// 早发出、晚返回的陈旧响应会把状态覆盖回「运行中」，故只认最新一次的结果。
// （沿用 usage.js 的 _usageRequestSeq 防竞态模式）
let _healthSeq = 0;

export function initServiceControls() {
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnRestart = document.getElementById('btn-restart');

  btnStart?.addEventListener('click', async () => {
    try {
      btnStart.disabled = true;
      // 作废点击前已在途的健康检查：其结果反映的是变更前状态，晚返回会把状态写旧
      _healthSeq++;
      showToast('正在启动反代服务...', 'info');
      await invokeTauri('proxy_start', { port: state.port, desensitize: state.desensitize });
      showToast('反代服务已拉起', 'success');
      setTimeout(checkHealth, 600);
    } catch (e) {
      showToast(`启动失败: ${e.message || e}`, 'error');
    } finally {
      // 按钮态一律以服务实况为准：失败时保持可重试，成功时交给 updateServiceStatus 收口
      btnStart.disabled = state.running;
    }
  });

  btnStop?.addEventListener('click', async () => {
    try {
      btnStop.disabled = true;
      await invokeTauri('proxy_stop');
      showToast('服务已停止', 'info');
      // 作废在途的健康检查：否则停止前发出、停止后才返回的响应会把看板改回「运行中」
      _healthSeq++;
      updateServiceStatus(false);
    } catch (e) {
      showToast(`停止失败: ${e.message || e}`, 'error');
    } finally {
      // 同上：停止成功后按钮必须保持禁用，否则停止态下仍可再次点击
      btnStop.disabled = !state.running;
    }
  });

  btnRestart?.addEventListener('click', async () => {
    try {
      btnRestart.disabled = true;
      // 重启期间服务会短暂停摆，在途检查的结果一律不可信（同上）
      _healthSeq++;
      showToast('正在重启服务...', 'info');
      await invokeTauri('proxy_restart', { port: state.port, desensitize: state.desensitize });
      showToast('服务已重启完成', 'success');
      setTimeout(checkHealth, 800);
    } catch (e) {
      showToast(`重启失败: ${e.message || e}`, 'error');
    } finally {
      // 同上：以服务实况为准，避免停止态下重新点亮「重启」
      btnRestart.disabled = !state.running;
    }
  });
}

export async function checkHealth() {
  // 入口取号；早发出、晚返回的陈旧响应（点「停止服务」前已在途）直接丢弃，
  // 避免看板从「已停止」回跳「运行中」（上游超时可达 10s，重排必然发生）
  const seq = ++_healthSeq;
  try {
    const data = await invokeTauri('proxy_health', { port: state.port });
    if (seq !== _healthSeq) return; // 已有更新的检查发出，丢弃本次陈旧结果
    updateServiceStatus(true, data, seq);
  } catch (e) {
    if (seq !== _healthSeq) return;
    updateServiceStatus(false, null, seq);
  }
}

// /health 已安全收窄（只返回 status/authenticated），身份信息改用鉴权的 Tauri 接口获取
async function getActiveAccountNickname() {
  try {
    const list = await invokeTauri('accounts_list');
    const active = list.find(a => a.is_active) || list[0];
    return active?.nickname || '已登录';
  } catch (e) {
    return '已登录';
  }
}

function updateServiceStatus(isRunning, data = null, seq = _healthSeq) {
  state.running = isRunning;
  const sideDot = document.getElementById('side-dot');
  const sideText = document.getElementById('side-status-text');
  const dashBadge = document.getElementById('dash-status-badge');
  const dashTime = document.getElementById('dash-health-time');
  const dashActive = document.getElementById('dash-active-account');
  const dashMode = document.getElementById('dash-mode');
  const sideUser = document.getElementById('side-active-user');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnRestart = document.getElementById('btn-restart');

  // 三个按钮同源门控：服务未运行时「停止」「重启」都无对象可作用，禁用而非空点
  if (btnStart) btnStart.disabled = isRunning;
  if (btnStop) btnStop.disabled = !isRunning;
  if (btnRestart) btnRestart.disabled = !isRunning;

  if (isRunning) {
    sideDot.className = 'dot dot-running';
    sideText.textContent = '服务运行中';
    dashBadge.className = 'badge badge-running';
    dashBadge.textContent = '运行中';
    if (dashMode) dashMode.textContent = RUNTIME_MODE_LABEL;

    // 昵称是异步取的：期间可能已停止服务或有更新检查发出，
    // 此时不能再回写账号名（否则覆盖掉 else 分支写入的「—」/「未在线」）
    getActiveAccountNickname().then((nick) => {
      if (seq !== _healthSeq || !state.running) return;
      dashActive.textContent = nick;
      sideUser.textContent = nick;
    });
    dashTime.textContent = `检测时间: ${new Date().toLocaleTimeString()}`;
  } else {
    sideDot.className = 'dot dot-stopped';
    sideText.textContent = '服务已停止';
    dashBadge.className = 'badge badge-stopped';
    dashBadge.textContent = '已停止';
    if (dashMode) dashMode.textContent = '—';
    dashActive.textContent = '—';
    sideUser.textContent = '未在线';
    dashTime.textContent = '服务离线';
  }
}

// ---------------------------------------------------------------------------
// 连通性测试 (Test Chat)
// ---------------------------------------------------------------------------
const TEST_PROTOCOL_LABELS = {
  chat: 'Chat Completions',
  messages: 'Anthropic Messages',
  responses: 'Codex Responses',
};

export function initTestChat() {
  const btn = document.getElementById('btn-test-chat');
  const box = document.getElementById('test-result-box');
  const tag = document.getElementById('test-status-tag');
  const protocolTag = document.getElementById('test-protocol-tag');
  const protocolSelect = document.getElementById('select-test-protocol');
  const modelTag = document.getElementById('test-model-tag');
  const latency = document.getElementById('test-latency');
  const ttftWrap = document.getElementById('test-ttft-wrap');
  const ttft = document.getElementById('test-ttft');
  const output = document.getElementById('test-response-text');

  // 展示首字时延（契约1：ttft_ms 为数字或 null，null/缺失表示未测得则隐藏该指标）
  const renderTtft = (value) => {
    if (!ttftWrap || !ttft) return;
    const n = Number(value);
    if (value !== null && value !== undefined && Number.isFinite(n)) {
      ttft.textContent = `${Math.round(n)} ms`;
      ttftWrap.classList.remove('hidden');
    } else {
      ttftWrap.classList.add('hidden');
    }
  };

  btn?.addEventListener('click', async () => {
    const protocol = protocolSelect?.value || 'chat';
    const protocolLabel = TEST_PROTOCOL_LABELS[protocol] || protocol;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;margin-right:6px;"></span>请求中...`;
    box.classList.remove('hidden');
    tag.className = 'badge badge-info';
    tag.textContent = '请求中...';
    if (protocolTag) protocolTag.textContent = protocolLabel;
    latency.textContent = '— ms';
    renderTtft(null); // 请求开始时隐藏首字指标，避免残留上次结果
    output.textContent = `正在通过 ${protocolLabel} 协议向本地反代发起测试请求...`;

    try {
      const res = await invokeTauri('proxy_test_chat', {
        port: state.port,
        model: 'glm-5.3-flash',
        protocol,
      });
      if (protocolTag) protocolTag.textContent = res.protocol || protocolLabel;
      if (res.success) {
        tag.className = 'badge badge-valid';
        tag.textContent = '测试通过';
        modelTag.textContent = res.model;
        latency.textContent = `${res.latency_ms} ms`;
        renderTtft(res.ttft_ms);
        output.textContent = res.response || '(模型返回内容为空)';
        showToast(`${protocolLabel} 连通测试成功！`, 'success');
      } else {
        tag.className = 'badge badge-expired';
        tag.textContent = '请求异常';
        modelTag.textContent = res.model;
        latency.textContent = `${res.latency_ms} ms`;
        renderTtft(res.ttft_ms);
        output.textContent = res.error || '未返回有效结果';
        showToast(`${protocolLabel} 测试失败，请检查服务状态`, 'error');
      }
    } catch (e) {
      tag.className = 'badge badge-expired';
      tag.textContent = '错误';
      output.textContent = `客户端错误: ${e.message || e}`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> 测试连通性`;
    }
  });
}
