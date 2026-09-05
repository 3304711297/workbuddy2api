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
    if (state.oauthTimer) clearInterval(state.oauthTimer);
    processArea.classList.add('hidden');
    showToast('已取消本次登录', 'info');
  });

  function pollOAuth(oauthState) {
    if (state.oauthTimer) clearInterval(state.oauthTimer);
    let attempts = 0;

    state.oauthTimer = setInterval(async () => {
      attempts++;
      if (attempts > 120) { // 4 分钟超时
        clearInterval(state.oauthTimer);
        statusText.textContent = '登录等待超时，请重新点击开始授权';
        return;
      }

      try {
        const res = await invokeTauri('auth_poll', { state: oauthState });
        if (res.code === 0 && res.data) {
          clearInterval(state.oauthTimer);
          showToast('登录成功！已自动保存凭据并更新活跃账号', 'success');
          processArea.classList.add('hidden');
          // 自动跳转到账号与资产面板
          document.querySelector('.nav-item[data-tab="accounts"]')?.click();
        }
      } catch (e) {
        console.warn('轮询中...', e);
      }
    }, 2000);
  }
}
