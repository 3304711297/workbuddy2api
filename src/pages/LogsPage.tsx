/**
 * 实时运行日志 (Logs)：旧 src/logs.js 的 React 移植。
 *
 * 行为契约（与旧实现一致）：
 *  - 挂载即以 2s 间隔轮询日志，卸载停表；
 *  - 用户贴底时新日志到达自动滚到底，上滚即暂停跟随、不抢滚动条；
 *  - 清空需 danger 二次确认，清空后重新拉取；
 *  - 打开日志目录走 Tauri IPC；
 *  - 日志经 <pre> 文本节点渲染（禁止 dangerouslySetInnerHTML）；
 *  - 后端调用只走 Tauri IPC（invokeTauri），按钮动作的错误（含非 Tauri 环境）以 toast 提示。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LOG_AUTO_SCROLL_ID,
  isNearBottom,
  startLogsPolling,
} from '../services/logsService';
import { openLogsDir, proxyClearLogs, proxyGetLogs } from '../services/tauri';
import { useConfirm } from '../services/confirm';
import { useToast } from '../services/toast';
import { useI18n } from '../i18n';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function LogsPage() {
  const { t } = useI18n();
  const { confirm } = useConfirm();
  const { showToast } = useToast();

  const viewerRef = useRef<HTMLPreElement | null>(null);
  const autoScrollRef = useRef(true);
  // 语言可能中途切换，回调/轮询读取 ref 里的最新 t 与 showToast，避免闭包过期
  const tRef = useRef(t);
  const toastRef = useRef(showToast);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  useEffect(() => {
    toastRef.current = showToast;
  }, [showToast]);

  const [autoScroll, setAutoScrollState] = useState(true);
  const [logText, setLogText] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const setAutoScroll = useCallback((v: boolean) => {
    autoScrollRef.current = v;
    setAutoScrollState(v);
  }, []);

  /**
   * 写入新日志：贴底判断必须在替换文本之前测量——
   * 替换后 scrollHeight 已是新内容高度，旧滚动位置会被误判为贴底。
   */
  const applyLogs = useCallback(
    (text: string) => {
      const viewer = viewerRef.current;
      if (viewer) {
        const near = isNearBottom(
          viewer.scrollTop,
          viewer.scrollHeight,
          viewer.clientHeight,
        );
        // 用户主动上滚即自动暂停跟随，翻看历史不再被打断
        if (!near && autoScrollRef.current) setAutoScroll(false);
      }
      setLogText(text || tRef.current('logs.empty'));
    },
    [setAutoScroll],
  );

  // 新日志到达且处于跟随态时滚到底（文本已写入后 scrollHeight 即最新高度）
  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && autoScrollRef.current) {
      viewer.scrollTop = viewer.scrollHeight;
    }
  }, [logText]);

  // 页面挂载开始 2s 轮询，卸载停表（只在日志页活动时轮询）
  useEffect(() => {
    const poller = startLogsPolling(applyLogs, proxyGetLogs);
    return () => poller.stop();
  }, [applyLogs]);

  const handleScroll = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (
      !isNearBottom(viewer.scrollTop, viewer.scrollHeight, viewer.clientHeight) &&
      autoScrollRef.current
    ) {
      setAutoScroll(false);
    }
  }, [setAutoScroll]);

  // 手动切换：恢复时立即跳到底部（兼任「回到底部」按钮）
  const toggleAutoScroll = useCallback(() => {
    const next = !autoScrollRef.current;
    if (next) {
      const viewer = viewerRef.current;
      if (viewer) viewer.scrollTop = viewer.scrollHeight;
    }
    setAutoScroll(next);
    toastRef.current(
      next ? tRef.current('logs.resumeAutoScroll') : tRef.current('logs.pauseAutoScroll'),
      'info',
    );
  }, [setAutoScroll]);

  const handleRefresh = useCallback(async () => {
    // 慢请求期间禁用按钮防连点；提示等结果出来再给，避免失败时自相矛盾
    setRefreshing(true);
    try {
      applyLogs(await proxyGetLogs());
      toastRef.current(tRef.current('logs.refreshDone'), 'info');
    } catch (e) {
      setLogText(tRef.current('logs.fetchError', { message: errorMessage(e) }));
      toastRef.current(tRef.current('logs.refreshFailed'), 'error');
    } finally {
      setRefreshing(false);
    }
  }, [applyLogs]);

  const handleClear = useCallback(async () => {
    // 破坏性操作：日志是排障的唯一证据链，误点不可恢复，先确认再执行
    const ok = await confirm({
      title: tRef.current('logs.clearTitle'),
      message: tRef.current('logs.clearMessage'),
      okText: tRef.current('logs.clearConfirmOk'),
      danger: true,
    });
    if (!ok) return;
    try {
      await proxyClearLogs();
      applyLogs(await proxyGetLogs());
      toastRef.current(tRef.current('logs.cleared'), 'info');
    } catch (e) {
      toastRef.current(
        tRef.current('logs.clearFailed', { message: errorMessage(e) }),
        'error',
      );
    }
  }, [applyLogs, confirm]);

  const handleOpenDir = useCallback(async () => {
    try {
      await openLogsDir();
      toastRef.current(tRef.current('logs.dirOpened'), 'success');
    } catch (e) {
      toastRef.current(
        tRef.current('logs.dirFailed', { message: errorMessage(e) }),
        'error',
      );
    }
  }, []);

  return (
    <div className="panel-page active">
      <div className="section-title-row">
        <div>
          <h2>{t('logs.title')}</h2>
          <p className="muted">{t('logs.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={refreshing}
            onClick={handleRefresh}
          >
            {t('logs.refresh')}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleClear}
          >
            {t('logs.clear')}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleOpenDir}
          >
            {t('logs.openDir')}
          </button>
        </div>
      </div>

      <div className="card log-console" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="log-console-header">
          <span className="mono log-console-path">proxy_stdout.log</span>
          <button
            id={LOG_AUTO_SCROLL_ID}
            type="button"
            className="log-console-hint log-auto-scroll-btn"
            aria-pressed={autoScroll}
            title={t('logs.autoScrollTitle')}
            onClick={toggleAutoScroll}
          >
            {autoScroll ? t('logs.autoScrollOn') : t('logs.autoScrollOff')}
          </button>
        </div>
        <pre
          id="log-viewer"
          ref={viewerRef}
          className="code-block"
          style={{
            border: 'none',
            borderRadius: 0,
            minHeight: 420,
            maxHeight: 520,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            margin: 0,
            padding: 16,
            lineHeight: 1.5,
            fontSize: 12,
            color: '#a6adbb',
          }}
          onScroll={handleScroll}
        >
          {logText}
        </pre>
      </div>
    </div>
  );
}
