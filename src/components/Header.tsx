/**
 * 顶部 Header：页面标题/描述 + 服务启停按钮组。
 */
import { Play, RotateCw, Square } from 'lucide-react';
import { useApp, type TabId } from '../state/ServiceProvider';
import { useI18n } from '../i18n';

const TAB_TITLE_KEYS: Record<TabId, string> = {
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

const TAB_DESC_KEYS: Record<TabId, string> = {
  dashboard: 'nav.dashboardDesc',
  accounts: 'nav.accountsDesc',
  agents: 'nav.agentsDesc',
  models: 'nav.modelsDesc',
  oauth: 'nav.oauthDesc',
  settings: 'nav.settingsDesc',
  logs: 'nav.logsDesc',
  usage: 'nav.usageDesc',
  debug: 'nav.debugDesc',
};

export function Header() {
  const { tab, running, startProxy, stopProxy, restartProxy } = useApp();
  const { t } = useI18n();

  return (
    <header className="content-header">
      <div className="header-left">
        <h1>{t(TAB_TITLE_KEYS[tab])}</h1>
        <p className="page-desc">{t(TAB_DESC_KEYS[tab])}</p>
      </div>
      <div className="header-right">
        <button type="button" className="btn btn-primary" disabled={running} onClick={() => void startProxy()}>
          <Play size={14} className="btn-icon" />
          {t('service.start')}
        </button>
        <button type="button" className="btn btn-secondary" disabled={!running} onClick={() => void restartProxy()}>
          <RotateCw size={14} className="btn-icon" />
          {t('service.restart')}
        </button>
        <button type="button" className="btn btn-danger" disabled={!running} onClick={() => void stopProxy()}>
          <Square size={14} className="btn-icon" />
          {t('service.stop')}
        </button>
      </div>
    </header>
  );
}
