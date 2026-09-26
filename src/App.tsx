/**
 * 应用根组件：侧栏 + 顶栏 + 九页 Tab 切换 + 更新弹窗。
 * Tab 切换时触发各页专属数据加载（与旧 tabs.js 同语义，由各页组件的
 * useEffect on-mount 承担，App 只负责显隐）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useApp } from './state/ServiceProvider';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { UpdateModal } from './components/UpdateModal';
import { DashboardPage } from './pages/DashboardPage';
import { AccountsPage } from './pages/AccountsPage';
import { AgentsPage } from './pages/AgentsPage';
import { ModelsPage } from './pages/ModelsPage';
import { OAuthPage } from './pages/OAuthPage';
import { SettingsPage } from './pages/SettingsPage';
import { LogsPage } from './pages/LogsPage';
import { UsagePage } from './pages/UsagePage';
import { DebugPage } from './pages/DebugPage';

export function App() {
  const { tab } = useApp();
  const [updateOpen, setUpdateOpen] = useState(false);

  const openUpdate = useCallback(() => setUpdateOpen(true), []);
  const closeUpdate = useCallback(() => setUpdateOpen(false), []);

  // 接续流程的开窗通知（UpdateModal 内 resume 逻辑发出）
  useEffect(() => {
    const on = () => setUpdateOpen(true);
    window.addEventListener('wb-open-update-modal', on);
    return () => window.removeEventListener('wb-open-update-modal', on);
  }, []);

  return (
    <div className="app-layout">
      <Sidebar onOpenUpdate={openUpdate} />
      <main className="main-content">
        <Header />
        <div className="page-container">
          {tab === 'dashboard' && <DashboardPage />}
          {tab === 'accounts' && <AccountsPage />}
          {tab === 'agents' && <AgentsPage />}
          {tab === 'models' && <ModelsPage />}
          {tab === 'oauth' && <OAuthPage />}
          {tab === 'settings' && <SettingsPage />}
          {tab === 'logs' && <LogsPage />}
          {tab === 'usage' && <UsagePage />}
          {tab === 'debug' && <DebugPage />}
        </div>
      </main>
      <UpdateModal open={updateOpen} onClose={closeUpdate} />
    </div>
  );
}
