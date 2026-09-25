/**
 * 应用入口。import 顺序即初始化顺序：
 *  1. errorHandler — 最先注册 window 错误监听（与旧 error-handler.js 同注册时机）；
 *  2. theme 预应用（public/theme-preset.js 已在 <head> 做过防闪白，这里做运行时接管）。
 */
import './services/errorHandler';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { ToastProvider } from './services/toast';
import { ConfirmProvider } from './services/confirm';
import { I18nProvider } from './i18n';
import { ServiceProvider } from './state/ServiceProvider';
import { initializeTheme } from './themeController';
import './styles.css';

initializeTheme();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('缺少 #root 挂载点');
}

createRoot(rootEl).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <ServiceProvider>
              <App />
            </ServiceProvider>
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
