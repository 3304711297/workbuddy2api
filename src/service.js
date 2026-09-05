/**
 * 服务生命周期与控制：启动 / 停止 / 重启 / 健康检查 / 连通性测试
 */

import { state } from './state.js';
import { showToast, invokeTauri } from './utils.js';

export function initServiceControls() {
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');
  const btnRestart = document.getElementById('btn-restart');

  btnStart?.addEventListener('click', async () => {
    try {
      btnStart.disabled = true;
      showToast('正在启动反代服务...', 'info');
      await invokeTauri('proxy_start', { port: state.port, desensitize: state.desensitize });
      showToast('反代服务已拉起', 'success');
      setTimeout(checkHealth, 600);
    } catch (e) {
      showToast(`启动失败: ${e.message || e}`, 'error');
    } finally {
      btnStart.disabled = false;
    }
  });

  btnStop?.addEventListener('click', async () => {
    try {
      btnStop.disabled = true;
      await invokeTauri('proxy_stop');
      showToast('服务已停止', 'info');
      updateServiceStatus(false);
    } catch (e) {
      showToast(`停止失败: ${e.message || e}`, 'error');
    } finally {
      btnStop.disabled = false;
    }
  });

  btnRestart?.addEventListener('click', async () => {
    try {
      btnRestart.disabled = true;
      showToast('正在重启服务...', 'info');
      await invokeTauri('proxy_restart', { port: state.port, desensitize: state.desensitize });
      showToast('服务已重启完成', 'success');
      setTimeout(checkHealth, 800);
    } catch (e) {
      showToast(`重启失败: ${e.message || e}`, 'error');
    } finally {
      btnRestart.disabled = false;
    }
  });
}

export async function checkHealth() {
  try {
    const data = await invokeTauri('proxy_health', { port: state.port });
    updateServiceStatus(true, data);
  } catch (e) {
    updateServiceStatus(false);
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

function updateServiceStatus(isRunning, data = null) {
  state.running = isRunning;
  const sideDot = document.getElementById('side-dot');
  const sideText = document.getElementById('side-status-text');
  const dashBadge = document.getElementById('dash-status-badge');
  const dashTime = document.getElementById('dash-health-time');
  const dashActive = document.getElementById('dash-active-account');
  const sideUser = document.getElementById('side-active-user');
  const btnStart = document.getElementById('btn-start');
  const btnStop = document.getElementById('btn-stop');

  if (btnStart) btnStart.disabled = isRunning;
  if (btnStop) btnStop.disabled = !isRunning;

  if (isRunning) {
    sideDot.className = 'dot dot-running';
    sideText.textContent = '服务运行中';
    dashBadge.className = 'badge badge-running';
    dashBadge.textContent = '运行中';

    getActiveAccountNickname().then((nick) => {
      dashActive.textContent = nick;
      sideUser.textContent = nick;
    });
    dashTime.textContent = `检测时间: ${new Date().toLocaleTimeString()}`;
  } else {
    sideDot.className = 'dot dot-stopped';
    sideText.textContent = '服务已停止';
    dashBadge.className = 'badge badge-stopped';
    dashBadge.textContent = '已停止';
    dashActive.textContent = '—';
    sideUser.textContent = '未在线';
    dashTime.textContent = '服务离线';
  }
}

// ---------------------------------------------------------------------------
// 连通性测试 (Test Chat)
// ---------------------------------------------------------------------------
export function initTestChat() {
  const btn = document.getElementById('btn-test-chat');
  const box = document.getElementById('test-result-box');
  const tag = document.getElementById('test-status-tag');
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
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px;display:inline-block;margin-right:6px;"></span>请求中...`;
    box.classList.remove('hidden');
    tag.className = 'badge badge-info';
    tag.textContent = '请求中...';
    latency.textContent = '— ms';
    renderTtft(null); // 请求开始时隐藏首字指标，避免残留上次结果
    output.textContent = '正在向本地反代发起聊天完成测试...';

    try {
      const res = await invokeTauri('proxy_test_chat', { port: state.port, model: 'glm-5.3-flash' });
      if (res.success) {
        tag.className = 'badge badge-valid';
        tag.textContent = '测试通过';
        modelTag.textContent = res.model;
        latency.textContent = `${res.latency_ms} ms`;
        renderTtft(res.ttft_ms);
        output.textContent = res.response || '(模型返回内容为空)';
        showToast('接口连通测试成功！', 'success');
      } else {
        tag.className = 'badge badge-expired';
        tag.textContent = '请求异常';
        modelTag.textContent = res.model;
        latency.textContent = `${res.latency_ms} ms`;
        renderTtft(res.ttft_ms);
        output.textContent = res.error || '未返回有效结果';
        showToast('测试失败，请检查服务状态', 'error');
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
