/**
 * 应用更新弹窗：检测（GitHub commit 比对）+ 交接式自动更新。
 *
 * 视图：status（状态/错误）/ available（有更新 + 变更清单）/ applying（进度中）。
 * - 「正在更新」视图不允许关闭（更新已在路上）；
 * - 离开 applying 视图时停掉轮询；
 * - 手动检查 force: true；启动 1500ms 后静默检查；800ms 后接续未完成更新；
 * - commit 标题用文本节点渲染（React 默认转义，不可信远端输入不进 HTML）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useToast } from '../services/toast';
import {
  runUpdateCheck,
  startApplyUpdate,
  startUpdatePolling,
  resumeInFlightUpdate,
  UPDATE_STARTUP_SILENT_DELAY_MS,
  UPDATE_RESUME_DELAY_MS,
} from '../services/updateService';
import { buildCommitChangelog, totalItems } from '../services/commitChangelog';
import type { UpdateCheckResult } from '../services/tauri';

type View = 'status' | 'available' | 'applying';

interface StatusView {
  icon: string;
  title: string;
  body: string;
  detail?: string;
  actionLabel?: string;
}

export function UpdateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [view, setView] = useState<View>('status');
  const [status, setStatus] = useState<StatusView>({ icon: 'i', title: '', body: '' });
  const [info, setInfo] = useState<UpdateCheckResult | null>(null);
  const [applyingMessage, setApplyingMessage] = useState('');
  const [applyingLog, setApplyingLog] = useState('');
  const [applyingTitle, setApplyingTitle] = useState('');
  const [applyingHint, setApplyingHint] = useState('');
  const [applyingFailed, setApplyingFailed] = useState(false);
  const pollerRef = useRef<{ stop: () => void } | null>(null);
  const canCloseRef = useRef(true);
  // 接续流程会先切到 applying 视图再通知 App 开窗；开窗 effect 靠此标记
  // 区分「用户点击入口」与「接续未完成更新」，后者不触发新的 force 检查。
  const resumeArmedRef = useRef(false);

  const stopPolling = useCallback(() => {
    pollerRef.current?.stop();
    pollerRef.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const showStatus = useCallback((s: StatusView) => {
    stopPolling();
    setStatus(s);
    setView('status');
  }, [stopPolling]);

  const renderResult = useCallback(
    (result: UpdateCheckResult | null) => {
      if (!result) {
        showStatus({
          title: t('update.unableToCheck'),
          body: t('update.checkNetwork'),
          icon: '!',
          actionLabel: t('update.retry'),
        });
        return;
      }
      if (!result.supported) {
        showStatus({
          title: t('update.unavailable'),
          body: result.message || t('update.unsupportedInstall'),
          detail: result.reason === 'not-a-git-checkout' ? `安装目录：${result.update_root || '未知'}` : '',
          icon: '!',
        });
        return;
      }
      if (result.error) {
        showStatus({
          title: t('update.unableToCheck'),
          body: t('update.checkNetworkRetry'),
          detail: result.error,
          icon: '!',
          actionLabel: t('update.retry'),
        });
        return;
      }
      if (!result.update_available) {
        const sha = (result.current_sha || '').slice(0, 7);
        showStatus({
          title: t('update.upToDate'),
          body: t('update.upToDateBody', { branch: result.branch, sha: sha ? ` · ${sha}` : '' }),
          icon: '✓',
        });
        return;
      }
      stopPolling();
      setInfo(result);
      setView('available');
    },
    [showStatus, t],
  );

  const notifySidebar = useCallback((available: boolean) => {
    window.dispatchEvent(new CustomEvent('wb-update-available', { detail: available }));
  }, []);

  /** 检测：silent 时只提示不渲染弹窗内容（弹窗隐藏中）。 */
  const runCheck = useCallback(
    async (opts: { silent: boolean; force?: boolean }) => {
      const { silent, force = false } = opts;
      if (!silent) {
        showStatus({ title: t('update.checking'), body: t('update.checkingBody'), icon: '◐' });
      }
      try {
        const result = await runUpdateCheck({ silent, force });
        notifySidebar(result?.update_available === true);
        if (silent) {
          if (result?.update_available) {
            showToast(
              t('update.foundSilent', { behind: result.behind ?? '若干' }),
              'info',
            );
          }
        } else {
          renderResult(result);
        }
        return result;
      } catch (e) {
        notifySidebar(false);
        if (!silent) {
          renderResult(null);
          showToast(t('update.checkFailed', { msg: e instanceof Error ? e.message : String(e) }), 'error');
        }
        return null;
      }
    },
    [showStatus, renderResult, notifySidebar, showToast, t],
  );

  const handleClose = useCallback(() => {
    if (!canCloseRef.current) return;
    onClose();
  }, [onClose]);

  const canClose = view !== 'applying' || applyingFailed || applyingTitle === t('update.applyDone');
  canCloseRef.current = canClose;

  // 开窗：用户点击入口 → 强制实时检查；接续流程 → 保持 applying 视图
  const prevOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      if (resumeArmedRef.current) {
        resumeArmedRef.current = false;
        return;
      }
      void runCheck({ silent: false, force: true });
    }
  }, [open, runCheck]);

  // Escape 关闭（applying 期间不允许）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, handleClose]);

  // 启动后：1500ms 静默检查 + 800ms 接续未完成更新
  useEffect(() => {
    const t1 = window.setTimeout(() => void runCheck({ silent: true }), UPDATE_STARTUP_SILENT_DELAY_MS);
    const t2 = window.setTimeout(async () => {
      const state = await resumeInFlightUpdate();
      if (!state) return;
      setApplyingTitle(t('update.applying'));
      setApplyingMessage(state.message || t('update.applyingDefault'));
      setApplyingFailed(false);
      setApplyingLog('');
      setApplyingHint('');
      setView('applying');
      // 弹窗此时可能还没打开：通知 App 打开
      resumeArmedRef.current = true;
      window.dispatchEvent(new CustomEvent('wb-open-update-modal'));
      pollerRef.current = startUpdatePolling({
        onMessage: setApplyingMessage,
        onFailed: (detail, hint) => {
          setApplyingTitle(t('update.applyFailed'));
          setApplyingLog(detail);
          setApplyingHint(hint);
          setApplyingFailed(true);
        },
        onDone: () => {
          setApplyingTitle(t('update.applyDone'));
          setApplyingHint(t('update.applyDoneHint'));
          setApplyingFailed(false);
        },
      });
    }, UPDATE_RESUME_DELAY_MS);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCheckNow = useCallback(() => {
    void runCheck({ silent: false, force: true });
  }, [runCheck]);

  const handleApply = useCallback(async () => {
    setView('applying');
    setApplyingTitle(t('update.preparing'));
    setApplyingMessage(t('update.startingEnv'));
    setApplyingLog('');
    setApplyingHint(t('update.applyingWarn'));
    setApplyingFailed(false);
    try {
      const msg = await startApplyUpdate();
      if (msg) setApplyingLog(msg);
      pollerRef.current = startUpdatePolling({
        onMessage: setApplyingMessage,
        onFailed: (detail, hint) => {
          setApplyingTitle(t('update.applyFailed'));
          setApplyingLog(detail);
          setApplyingHint(hint);
          setApplyingFailed(true);
        },
        onDone: () => {
          setApplyingTitle(t('update.applyDone'));
          setApplyingHint(t('update.applyDoneHint'));
          setApplyingFailed(false);
        },
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      showStatus({
        title: t('update.applyStartFailed'),
        body: t('update.applyStartFailedBody'),
        detail,
        icon: '!',
        actionLabel: t('update.retry'),
      });
      showToast(t('update.applyStartFailedToast', { msg: detail }), 'error');
    }
  }, [showStatus, showToast, t]);

  if (!open) return null;

  const groups = info ? buildCommitChangelog(info.commits ?? []) : [];
  // behind == null 表示「有更新但数量未知」，绝不能 ?? 0 抹成「无更新」
  const behind: number | null = info?.behind ?? null;
  const remaining = behind === null ? 0 : Math.max(0, behind - totalItems(groups));

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="modal-card update-modal" role="dialog" aria-modal="true" aria-label={t('update.title')}>
        <div className="modal-header">
          <h3>{t('update.title')}</h3>
          {canClose && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleClose}>
              {t('update.close')}
            </button>
          )}
        </div>

        {view === 'status' && (
          <div className="update-status-view">
            <div className="update-status-icon">{status.icon}</div>
            <h4>{status.title}</h4>
            <p>{status.body}</p>
            {status.detail && <pre className="update-status-detail mono">{status.detail}</pre>}
            {status.actionLabel && (
              <button type="button" className="btn btn-primary btn-sm" onClick={handleCheckNow}>
                {status.actionLabel}
              </button>
            )}
          </div>
        )}

        {view === 'available' && info && (
          <div className="update-available-view">
            <h4>
              {behind === null
                ? t('update.availableUnknownBehind')
                : behind > 0
                  ? t('update.availableWithBehind', { behind })
                  : t('update.available')}
            </h4>
            <p className="muted">
              {info.dirty ? t('update.dirtyNote') : t('update.availableBody')}
            </p>
            <div className="update-changelog">
              {groups.map((g) => (
                <div key={g.id}>
                  <p className="update-group-label">{g.label}</p>
                  <ul className="update-group-list">
                    {g.items.map((item, i) => (
                      <li key={i}>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            {remaining > 0 && <p className="muted">{t('update.moreChanges', { remaining })}</p>}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={handleClose}>
                {t('update.later')}
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleApply()}>
                {t('update.applyNow')}
              </button>
            </div>
          </div>
        )}

        {view === 'applying' && (
          <div className="update-applying-view">
            <div className={`update-status-icon${applyingFailed ? '' : ' spin'}`}>
              {applyingFailed ? '!' : '◐'}
            </div>
            <h4>{applyingTitle || t('update.applying')}</h4>
            <p>{applyingMessage}</p>
            {applyingLog && <pre className="update-applying-log mono">{applyingLog}</pre>}
            {applyingHint && <p className="muted">{applyingHint}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
