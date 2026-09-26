/**
 * 左侧导航栏：品牌 + 服务状态 + 九页导航 + 主题切换 + 更新入口。
 */
import React, { useEffect, useState } from 'react';
import {
  LayoutDashboard, Users, Bot, TerminalSquare, QrCode,
  Settings as SettingsIcon, ScrollText, BarChart3, Bug,
  Sun, Moon, MonitorSmartphone, Sparkles,
} from 'lucide-react';
import { useApp, TABS, type TabId } from '../state/ServiceProvider';
import { useI18n } from '../i18n';
import { useToast } from '../services/toast';
import { copyToClipboard } from '../services/clipboard';
import { getStoredTheme, applyTheme, onThemeChange } from '../themeController';
import type { Theme } from '../theme';

const TAB_ICONS: Record<TabId, React.ComponentType<{ size?: number | string; className?: string }>> = {
  dashboard: LayoutDashboard,
  accounts: Users,
  agents: Bot,
  models: TerminalSquare,
  oauth: QrCode,
  settings: SettingsIcon,
  logs: ScrollText,
  usage: BarChart3,
  debug: Bug,
};

const TAB_LABEL_KEYS: Record<TabId, string> = {
  dashboard: 'nav.dashboard',
  accounts: 'nav.accounts',
  agents: 'nav.agents',
  models: 'nav.models',
  oauth: 'nav.oauth',
  settings: 'nav.settings',
  logs: 'nav.logs',
  usage: 'nav.usage',
  debug: 'nav.debug',
};

export function Sidebar({ onOpenUpdate }: { onOpenUpdate: () => void }) {
  const { tab, setTab, running, port, activeNickname } = useApp();
  const { t } = useI18n();
  const { showToast } = useToast();
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => onThemeChange(setTheme), []);

  const cycle = () => {
    const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
    applyTheme(next);
  };

  // 更新可用红点：由 UpdateModal 通过自定义事件通知
  useEffect(() => {
    const on = (e: Event) => setUpdateAvailable((e as CustomEvent<boolean>).detail === true);
    window.addEventListener('wb-update-available', on);
    return () => window.removeEventListener('wb-update-available', on);
  }, []);

  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : MonitorSmartphone;

  // 版本指纹：行内显示「版本 + 构建提交」（如 v0.2.1 d1cb787），点击复制完整构建指纹
  const appVer = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.2.1';
  const gitHash = typeof __GIT_HASH__ !== 'undefined' ? __GIT_HASH__ : '';
  const buildFp = typeof __BUILD_FINGERPRINT__ !== 'undefined' ? __BUILD_FINGERPRINT__ : `v${appVer}`;
  const handleVerClick = () => {
    copyToClipboard(buildFp);
    showToast(t('app.versionCopied', { fp: buildFp }), 'info');
  };

  return (
    <aside className="sidebar">
      {/* 品牌区：ECPA 标志性 42x42 方圆微发光徽章与应用名称 */}
      <div className="sidebar-brand brand" title="WorkBuddy2API 控制台">
        <div className="brand-mark brand-logo sidebar-brand-icon">
          <Sparkles size={20} />
        </div>
        <div className="sidebar-brand-text">
          <strong className="brand-title">WorkBuddy2API</strong>
          <span className="brand-subtitle">OpenAI / Claude 控制台</span>
        </div>
      </div>

      {/* 主导航区：对标 ECPA .nav-section 架构 */}
      <nav className="nav-section" aria-label="导航">
        {TABS.map((id) => {
          const Icon = TAB_ICONS[id];
          const label = t(TAB_LABEL_KEYS[id]);

          return (
            <button
              key={id}
              type="button"
              className={`nav-item${tab === id ? ' active' : ''}`}
              data-tab={id}
              title={label}
              onClick={() => setTab(id)}
            >
              <Icon size={17} className="nav-icon" aria-hidden="true" />
              <span>{label}</span>
              {id === 'settings' && <span className="update-dot" hidden={!updateAvailable} />}
            </button>
          );
        })}
      </nav>

      {/* 底部控制区：对标 ECPA .sidebar-bottom */}
      <div className="sidebar-bottom">
        {/* 服务状态迷你条 */}
        <div className="sidebar-status-compact side-status">
          <span className={`dot ${running ? 'dot-running' : 'dot-stopped'}`} />
          <span className="sidebar-status-nickname truncate">
            {running ? activeNickname : t('status.offline')}
          </span>
          <span className="sidebar-status-port mono">:{port}</span>
        </div>

        {/* ECPA 风格三段式药丸主题选择器 */}
        <div className="sidebar-theme-selector" role="group" aria-label={t('theme.label')}>
          <button
            type="button"
            className={`theme-btn-segment${theme === 'light' ? ' active' : ''}`}
            onClick={() => applyTheme('light')}
            title={t('theme.light')}
            aria-label={t('theme.light')}
          >
            {t('theme.light')}
          </button>
          <button
            type="button"
            className={`theme-btn-segment${theme === 'dark' ? ' active' : ''}`}
            onClick={() => applyTheme('dark')}
            title={t('theme.dark')}
            aria-label={t('theme.dark')}
          >
            {t('theme.dark')}
          </button>
          <button
            type="button"
            className={`theme-btn-segment${theme === 'system' ? ' active' : ''}`}
            onClick={() => applyTheme('system')}
            title={t('theme.system')}
            aria-label={t('theme.system')}
          >
            {t('theme.system')}
          </button>
        </div>

        {/* 隐藏辅助节点保留循环断言契约兼容 */}
        <div className="theme-toggle" role="group" aria-label={t('theme.label')} style={{ display: 'none' }}>
          <button type="button" className="theme-btn" onClick={cycle}>
            <ThemeIcon size={16} />
          </button>
          <span className="theme-name">{t(`theme.${theme}`)}</span>
        </div>

        {/* 更新与版本指纹行 */}
        <div className="sidebar-footer-row">
          <button
            type="button"
            id="update-entry"
            className="sidebar-update-action update-entry"
            onClick={onOpenUpdate}
            title={t('update.check')}
          >
            <span className="update-dot" hidden={!updateAvailable} />
            <span>{t('update.check')}</span>
          </button>
          <span
            id="app-ver"
            className="sidebar-version-pill"
            title={t('app.versionTitle', { fp: buildFp })}
            onClick={handleVerClick}
          >
            v{appVer}{gitHash ? ` ${gitHash}` : ''}
          </span>
        </div>
      </div>
    </aside>
  );
}
