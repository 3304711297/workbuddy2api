/**
 * 调试 Tab：请求快照查看、一键重放与 curl 导出（React 版，迁移自 src/debug.js）。
 *
 * 行为契约（与旧实现一致）：
 *  - 挂载时加载快照列表（最新在前），显示总数；
 *  - 点击行选中快照，展示详情（ID、时间、方法、URL、状态、时延、请求/响应摘要）；
 *  - 重放：二次确认 → toast「正在重放…」→ 读磁盘设置拿端口与密钥（仅内存流转）
 *    → replaySnapshot → 结果区显示 HTTP 状态与时延+摘要，2xx 成功 toast、
 *    非 2xx 错误 toast，重放后刷新列表；
 *  - 复制 cURL：照旧拼命令，copyToClipboard 成功才报成功；
 *  - 清空快照：danger 二次确认，清空后刷新列表。
 * 快照内容全部用文本节点渲染（禁止 dangerouslySetInnerHTML）；不直连后端。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state/ServiceProvider';
import { useConfirm } from '../services/confirm';
import { useToast } from '../services/toast';
import { useI18n } from '../i18n';
import { copyToClipboard } from '../services/clipboard';
import {
  createDebugLoader,
  resolveReplayTarget,
  replaySnapshot,
  clearAllSnapshots,
  formatSnapshotTime,
  snapshotDetailJson,
  buildSnapshotCurl,
} from '../services/debugService';
import type { SnapshotItem } from '../services/tauri';

function latencyText(s: SnapshotItem): string {
  const ms = Number(s.latency_ms);
  return s.latency_ms == null || Number.isNaN(ms) ? '—' : `${ms} ms`;
}

export function DebugPage() {
  const { port } = useApp();
  const { confirm } = useConfirm();
  const { showToast } = useToast();
  const { t } = useI18n();

  const [snapshots, setSnapshots] = useState<SnapshotItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);

  const loaderRef = useRef(createDebugLoader());
  const detailRef = useRef<HTMLDivElement | null>(null);

  const selected = snapshots.find((s) => s.id === selectedId) ?? null;

  /** 加载快照列表（带请求序号防竞态，陈旧结果自动丢弃）。 */
  const refreshSnapshots = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await loaderRef.current.load();
      if (data === null) return; // 已被更新的请求作废
      setSnapshots(data.snapshots);
      setTotal(data.total);
    } catch (e) {
      setSnapshots([]);
      setLoadError(t('debug.loadFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshSnapshots();
    return () => loaderRef.current.invalidate();
  }, [refreshSnapshots]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setReplayResult(null);
    window.setTimeout(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 0);
  }, []);

  const handleReplay = useCallback(async () => {
    const s = snapshots.find((x) => x.id === selectedId);
    if (!s) {
      showToast(t('debug.selectFirst'), 'error');
      return;
    }
    const ok = await confirm({
      title: t('debug.replayConfirmTitle'),
      message: t('debug.replayConfirmMessage', { endpoint: s.endpoint || '' }),
      okText: t('debug.replay'),
    });
    if (!ok) return;
    setReplaying(true);
    try {
      showToast(t('debug.replaying'), 'info');
      // apiKey 只在内存中流转：resolve 后直接传给 replaySnapshot，不入 state、不打日志
      const target = await resolveReplayTarget(port);
      const r = await replaySnapshot(s.id, target);
      setReplayResult(
        `${t('debug.httpResult', { status: r.status, latency: r.latency_ms })}\n${r.excerpt || t('debug.emptyExcerpt')}`,
      );
      showToast(
        t('debug.replayDone', { status: r.status }),
        r.status >= 200 && r.status < 300 ? 'success' : 'error',
      );
      await refreshSnapshots();
    } catch (e) {
      showToast(
        t('debug.replayFailed', { error: e instanceof Error ? e.message : String(e) }),
        'error',
      );
    } finally {
      setReplaying(false);
    }
  }, [snapshots, selectedId, confirm, showToast, t, port, refreshSnapshots]);

  const handleCopyCurl = useCallback(async () => {
    const s = snapshots.find((x) => x.id === selectedId);
    if (!s) {
      showToast(t('debug.selectFirst'), 'error');
      return;
    }
    // 复制 cURL 只需端口（密钥位固定为占位符，不读真实密钥）
    const { port: targetPort } = await resolveReplayTarget(port);
    const cmd = buildSnapshotCurl(s, targetPort);
    const ok = await copyToClipboard(cmd);
    showToast(ok ? t('debug.curlCopied') : t('debug.copyFailed'), ok ? 'success' : 'error');
  }, [snapshots, selectedId, showToast, t, port]);

  const handleClear = useCallback(async () => {
    const ok = await confirm({
      title: t('debug.clearConfirmTitle'),
      message: t('debug.clearConfirmMessage'),
      okText: t('debug.clear'),
      danger: true,
    });
    if (!ok) return;
    try {
      await clearAllSnapshots();
      loaderRef.current.invalidate(); // 作废清空前已在途的旧请求
      setSelectedId(null);
      setReplayResult(null);
      await refreshSnapshots();
      showToast(t('debug.cleared'), 'success');
    } catch (e) {
      showToast(
        t('debug.clearFailed', { error: e instanceof Error ? e.message : String(e) }),
        'error',
      );
    }
  }, [confirm, showToast, t, refreshSnapshots]);

  return (
    <div className="panel-page active">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px' }}>{t('debug.title')}</h2>
          <span className="muted">{t('debug.total', { total })}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshSnapshots()}>
            {t('debug.refresh')}
          </button>
          <button type="button" className="btn btn-danger btn-sm" onClick={() => void handleClear()}>
            {t('debug.clear')}
          </button>
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>{t('debug.colTime')}</th>
            <th>{t('debug.colEndpoint')}</th>
            <th>{t('debug.colModel')}</th>
            <th>{t('debug.colStatus')}</th>
            <th>{t('debug.colLatency')}</th>
            <th>{t('debug.colAction')}</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={6} className="muted" style={{ textAlign: 'center' }}>
                {t('debug.loading')}
              </td>
            </tr>
          )}
          {!loading && loadError && (
            <tr>
              <td colSpan={6} className="muted" style={{ textAlign: 'center' }}>
                {loadError}
              </td>
            </tr>
          )}
          {!loading && !loadError && snapshots.length === 0 && (
            <tr>
              <td colSpan={6} className="muted" style={{ textAlign: 'center' }}>
                {t('debug.empty')}
              </td>
            </tr>
          )}
          {!loading &&
            !loadError &&
            snapshots.map((s) => (
              <tr
                key={s.id}
                data-snap-id={s.id}
                style={{ cursor: 'pointer', background: s.id === selectedId ? 'var(--row-hover)' : undefined }}
                onClick={() => handleSelect(s.id)}
              >
                <td className="mono">{formatSnapshotTime(s.ts)}</td>
                <td className="mono">{s.endpoint || ''}</td>
                <td className="mono">{s.model || ''}</td>
                <td>{s.ok !== false ? t('debug.ok') : t('debug.failed')}</td>
                <td className="mono">{latencyText(s)}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(s.id);
                    }}
                  >
                    {t('debug.detail')}
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      {selected && (
        <div className="card" ref={detailRef} style={{ marginTop: 16 }}>
          <div className="card-title">
            {selected.endpoint || ''} · {selected.model || ''} · {formatSnapshotTime(selected.ts)}
          </div>
          <table className="data-table" style={{ marginTop: 8 }}>
            <tbody>
              <tr>
                <td className="muted" style={{ width: 90 }}>{t('debug.fieldId')}</td>
                <td className="mono">{selected.id}</td>
              </tr>
              <tr>
                <td className="muted">{t('debug.fieldTime')}</td>
                <td className="mono">{formatSnapshotTime(selected.ts)}</td>
              </tr>
              <tr>
                <td className="muted">{t('debug.fieldMethod')}</td>
                <td className="mono">POST</td>
              </tr>
              <tr>
                <td className="muted">{t('debug.fieldUrl')}</td>
                <td className="mono">{selected.endpoint || '—'}</td>
              </tr>
              <tr>
                <td className="muted">{t('debug.fieldStatus')}</td>
                <td>{selected.ok !== false ? t('debug.ok') : t('debug.failed')}</td>
              </tr>
              <tr>
                <td className="muted">{t('debug.fieldLatency')}</td>
                <td className="mono">{latencyText(selected)}</td>
              </tr>
            </tbody>
          </table>
          <div className="muted" style={{ margin: '12px 0 4px' }}>
            {t('debug.fieldSummary')}
          </div>
          <pre className="code-block">{snapshotDetailJson(selected)}</pre>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={replaying}
              onClick={() => void handleReplay()}
            >
              {t('debug.replay')}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleCopyCurl()}>
              {t('debug.copyCurl')}
            </button>
          </div>
          {replayResult !== null && (
            <pre className="code-block" style={{ marginTop: 12 }}>
              {replayResult}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
