/**
 * 左侧导航栏：品牌 + 服务状态 + 九页导航 + 主题切换 + 更新入口。
 */
import React, { useEffect, useState } from 'react';
import {
  LayoutDashboard, Users, Bot, TerminalSquare, QrCode,
  Settings as SettingsIcon, ScrollText, BarChart3, Bug,
  Sun, Moon, MonitorSmartphone,
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
      <div className="brand">
        <span className="brand-title">WorkBuddy2API</span>
        <span className="brand-subtitle">
          OpenAI / Anthropic{' '}
          <small
            id="app-ver"
            title={t('app.versionTitle', { fp: buildFp })}
            style={{ cursor: 'pointer' }}
            onClick={handleVerClick}
          >
            v{appVer}{gitHash ? ` ${gitHash}` : ''}
          </small>
        </span>
      </div>

      <div className="side-status">
        <span className={`dot ${running ? 'dot-running' : 'dot-stopped'}`} />
        <span className="side-status-text">{running ? t('status.running') : t('status.stopped')}</span>
        <div className="side-meta">
          <span className="mono">:{port}</span>
          <span className="truncate">{running ? activeNickname : t('status.offline')}</span>
        </div>
      </div>

      <nav className="nav-menu">
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
              <Icon size={18} className="nav-icon" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="theme-toggle" role="group" aria-label={t('theme.label')}>
        <button
          type="button"
          className="theme-btn"
          onClick={cycle}
          title={t('theme.cycleTitle')}
          aria-label={t('theme.cycleTitle')}
        >
          <ThemeIcon size={18} />
        </button>
        <span className="theme-name">{t(`theme.${theme}`)}</span>
      </div>

      <div
        id="update-entry"
        className="update-entry"
        role="button"
        tabIndex={0}
        title={t('update.check')}
        onClick={onOpenUpdate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenUpdate();
          }
        }}
      >
        <span className="update-dot" hidden={!updateAvailable} />
        <span>{t('update.check')}</span>
      </div>
    </aside>
  );
}
