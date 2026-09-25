/**
 * 扫码登录页（OAuth）— 旧 oauth.js 的 React 迁移。
 *
 * 行为契约与旧实现一一对应：
 *  - 「开始授权」：禁用按钮 → controller.begin() 拿 auth_url → 只读展示（可复制）
 *    → openExternal 自动唤起系统浏览器（失败只 toast 警告，不阻断轮询）
 *    → 状态文案「等待扫码…」；begin 失败则 toast 错误并隐藏流程区
 *  - 「在浏览器中打开」：重新 openExternal(activeAuthUrl)
 *  - 「取消」：controller.cancel() → 隐藏流程区 → toast info
 *  - onSuccess：toast 成功 → 隐藏流程区 → checkHealthNow() → setTab('accounts')
 *  - onTimeout：状态文案显示超时提示
 *  - 组件卸载时 cancel()，避免后台轮询泄漏
 *
 * 轮询细节（2s 单路 in-flight、120 tick 超时、generation 守卫）由
 * services/oauthService.createOAuthController 内部实现。
 */

import { useEffect, useRef, useState } from 'react';
import {
  createOAuthController,
  type OAuthController,
} from '../services/oauthService';
import { openExternal } from '../services/external';
import { copyToClipboard } from '../services/clipboard';
import { useToast } from '../services/toast';
import { useI18n } from '../i18n';
import { useApp } from '../state/ServiceProvider';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function OAuthPage() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { setTab, checkHealthNow } = useApp();

  const [inProgress, setInProgress] = useState(false); // 流程区（链接 + 状态）是否可见
  const [starting, setStarting] = useState(false); // begin() 在途 → 禁用开始按钮
  const [authUrl, setAuthUrl] = useState('');
  const [statusText, setStatusText] = useState('');

  // controller 只创建一次，但回调需要最新闭包 → 用 ref 中转
  const live = useRef({ t, showToast, setTab, checkHealthNow });
  live.current = { t, showToast, setTab, checkHealthNow };

  const controllerRef = useRef<OAuthController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createOAuthController({
      onSuccess: () => {
        const ctx = live.current;
        ctx.showToast(ctx.t('oauth.loginSuccess'), 'success');
        setInProgress(false);
        setAuthUrl('');
        void ctx.checkHealthNow();
        ctx.setTab('accounts');
      },
      onTimeout: () => {
        setStatusText(live.current.t('oauth.timeout'));
      },
    });
  }

  // 卸载时取消轮询（cancel 内部已作废在途 poll）
  useEffect(() => {
    const controller = controllerRef.current;
    return () => {
      controller?.cancel();
    };
  }, []);

  const handleStart = async () => {
    const controller = controllerRef.current;
    if (!controller || starting) return;
    const { t, showToast } = live.current;
    try {
      setStarting(true);
      setStatusText(t('oauth.requesting'));
      setInProgress(true);

      const url = await controller.begin();
      setAuthUrl(url);

      // 自动唤起系统浏览器；失败只警告，不阻断后续轮询（与旧行为一致）
      try {
        await openExternal(url);
      } catch (e) {
        showToast(t('oauth.openBrowserFailed', { msg: errorMessage(e) }), 'warning');
      }
      setStatusText(t('oauth.waiting'));
    } catch (e) {
      showToast(t('oauth.beginFailed', { msg: errorMessage(e) }), 'error');
      setInProgress(false);
      setAuthUrl('');
    } finally {
      setStarting(false);
    }
  };

  const handleOpenBrowser = async () => {
    if (!authUrl) return;
    try {
      await openExternal(authUrl);
    } catch (e) {
      showToast(t('oauth.openBrowserFailed', { msg: errorMessage(e) }), 'warning');
    }
  };

  const handleCopy = async () => {
    if (!authUrl) return;
    const ok = await copyToClipboard(authUrl);
    showToast(t(ok ? 'oauth.copied' : 'oauth.copyFailed'), ok ? 'success' : 'warning');
  };

  const handleCancel = () => {
    controllerRef.current?.cancel();
    setInProgress(false);
    setAuthUrl('');
    showToast(t('oauth.cancelled'), 'info');
  };

  return (
    <div className="panel-page active">
      <div className="card oauth-card">
        <h2 className="card-title">{t('oauth.title')}</h2>
        <p className="card-desc">{t('oauth.desc')}</p>

        <div className="oauth-box">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            onClick={handleStart}
            disabled={starting}
          >
            {t('oauth.startButton')}
          </button>
        </div>

        {inProgress && (
          <div className="oauth-process-area">
            <div className="divider" />
            <div className="oauth-url-container">
              <label className="field-label" htmlFor="oauth-link-input">
                {t('oauth.linkLabel')}
              </label>
              <div className="input-with-btn">
                <input
                  id="oauth-link-input"
                  className="input mono"
                  type="text"
                  readOnly
                  value={authUrl}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleOpenBrowser}
                >
                  {t('oauth.openInBrowser')}
                </button>
                <button type="button" className="btn btn-secondary" onClick={handleCopy}>
                  {t('oauth.copy')}
                </button>
              </div>
            </div>

            <div className="polling-status-box">
              <div className="spinner" />
              <div>
                <div className="polling-main-text">{statusText}</div>
                <div className="muted" style={{ fontSize: '12px', marginTop: '4px' }}>
                  {t('oauth.waitingHint')}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={handleCancel}
              >
                {t('oauth.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
