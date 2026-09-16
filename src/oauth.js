/**
 * 网页授权登录 (OAuth) - 绝不混入无关资产卡片，纯粹专注登录
 * 注意：登录成功后跳转账号页沿用 DOM click 方式（`.nav-item[data-tab=...]`).click()），
 * 不 import tabs.js，避免循环依赖。
 */

import { state } from './state.js';
import { showToast, openExternal, invokeTauri } from './utils.js';

export function initOAuth() {
  const btnStart = document.getElementById('btn-oauth-start');
  const processArea = document.getElementById('oauth-process-area');
  const linkInput = document.getElementById('oauth-link-input');
  const btnOpen = document.getElementById('btn-open-browser');
  const btnCancel = document.getElementById('btn-oauth-cancel');
  const statusText = document.getElementById('oauth-status-text');

  let activeAuthUrl = '';
  // 轮询代次：成功/超时/取消/重新发起时递增，令上一轮的残留回调直接丢弃
  // （clearInterval 只能阻止后续 tick，已在途的 auth_poll 照常返回）
  let pollGen = 0;
  // 在途标志提升到本作用域（跨轮询代次共享）：auth_poll 上游超时可达 30s 而间隔仅 2s，
  // 无守卫时并发会持续堆积，而 auth_poll 成功会写盘保存凭据并切换活跃账号 →
  // 多路同时成功即并发落盘 + 多条「登录成功」刷屏。
  let pollInFlight = false;

  btnStart?.addEventListener('click', async () => {
    try {
      btnStart.disabled = true;
      statusText.textContent = '正在向腾讯授权中心发起登录请求...';
      processArea.classList.remove('hidden');

      const res = await invokeTauri('auth_begin', { platform: 'console' });
      activeAuthUrl = res.auth_url;
      linkInput.value = res.auth_url;

      // 自动尝试系统浏览器唤起
      await openExternal(res.auth_url);
      statusText.textContent = '浏览器已唤起，等待您扫码或登录授权完成...';

      // 启动轮询
      pollOAuth(res.state);
    } catch (e) {
      showToast(`授权发起失败: ${e.message || e}`, 'error');
      processArea.classList.add('hidden');
    } finally {
      btnStart.disabled = false;
    }
  });

  btnOpen?.addEventListener('click', () => {
    if (activeAuthUrl) openExternal(activeAuthUrl);
  });

  btnCancel?.addEventListener('click', () => {
    // 递增代次：取消后已在途的 auth_poll 若回来判定成功，也不得再落盘/弹成功提示
    pollGen++;
    if (state.oauthTimer) clearInterval(state.oauthTimer);
    processArea.classList.add('hidden');
    showToast('已取消本次登录', 'info');
  });

  function pollOAuth(oauthState) {
    if (state.oauthTimer) clearInterval(state.oauthTimer);
    const gen = ++pollGen; // 本轮代次；重新发起授权时旧轮询立即失效
    let attempts = 0;

    state.oauthTimer = setInterval(async () => {
      attempts++;
      if (attempts > 120) { // 4 分钟超时（按 tick 计数，与上游单次耗时无关，墙钟时间不被拖长）
        pollGen++; // 进入终态：作废仍在途的请求，其结果不得再落盘
        clearInterval(state.oauthTimer);
        statusText.textContent = '登录等待超时，请重新点击开始授权';
        return;
      }
      // 上一轮残留回调、超时/取消后的回调、以及上一次请求未返回（在途）时一律跳过，
      // 保证任一时刻至多一路 auth_poll 在途
      if (gen !== pollGen || pollInFlight) return;

      pollInFlight = true;
      try {
        const res = await invokeTauri('auth_poll', { state: oauthState });
        // await 期间可能已超时/取消/重新发起，此时结果不可再被采纳
        if (gen !== pollGen) return;
        if (res.code === 0 && res.data) {
          pollGen++; // 终态：连带作废其它在途请求，避免并发落盘与重复提示
          clearInterval(state.oauthTimer);
          showToast('登录成功！已自动保存凭据并更新活跃账号', 'success');
          processArea.classList.add('hidden');
          // 自动跳转到账号与资产面板
          document.querySelector('.nav-item[data-tab="accounts"]')?.click();
        }
      } catch (e) {
        console.warn('轮询中...', e);
      } finally {
        pollInFlight = false;
      }
    }, 2000);
  }
}
