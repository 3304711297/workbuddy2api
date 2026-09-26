/**
 * Agent 接入引导（原 src/agents.js 的 React 迁移）。
 *
 * Hermes / ZCode 检测、徽章、只读引导卡片（不含 Claude Code / Codex 引导，
 * 旧实现中那两份属于客户端直连片段，非本次迁移范围）。
 *
 * 硬约束：
 * - guide 下发的 steps / yaml_snippet / 字段值是远端不可信输入，一律走 React
 *   文本节点渲染，禁止 dangerouslySetInnerHTML；
 * - 真实 API key 只在内存中替换展示（pre 文本内可为明文，便于复制），
 *   绝不写入 localStorage、绝不打日志；
 * - Hermes 绝不自动改写配置，仅手动引导；
 * - 所有用户可见文案走 t('agents.*')。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../state/ServiceProvider';
import { copyToClipboard } from '../services/clipboard';
import { useToast } from '../services/toast';
import { useConfirm } from '../services/confirm';
import { useI18n } from '../i18n';
import {
  cleanZcodeStep,
  detectAgents,
  effectiveApiKey,
  fetchHermesGuide,
  fetchZcodeGuide,
  hermesBadgeState,
  resolveHermesGuideKey,
  substituteGuideApiKey,
  zcodeBadgeState,
  type AgentStatus,
  type HermesBadgeState,
  type ZcodeBadgeState,
} from '../services/agentsService';
import { zcodeRemove, type HermesEndpointGuide, type ZcodeGuide } from '../services/tauri';

const HERMES_BADGE_CLASS: Record<HermesBadgeState, string> = {
  'not-installed': 'badge badge-stopped',
  configured: 'badge badge-valid',
  unconfigured: 'badge badge-info',
};

const ZCODE_BADGE_CLASS: Record<ZcodeBadgeState, string> = {
  'not-installed': 'badge badge-stopped',
  online: 'badge badge-valid',
  'offline-residue': 'badge badge-info',
  offline: 'badge badge-info',
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AgentsPage() {
  const { port, apiKey } = useApp();
  const { showToast } = useToast();
  const { confirm } = useConfirm();
  const { t } = useI18n();

  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [detectFailed, setDetectFailed] = useState(false);
  const [hermesGuide, setHermesGuide] = useState<HermesEndpointGuide | null>(null);
  const [zcodeGuide, setZcodeGuide] = useState<ZcodeGuide | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(
    async (id: string, text: string) => {
      const ok = await copyToClipboard(text);
      if (ok) {
        setCopiedId(id);
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopiedId(null), 1500);
        showToast(t('agents.copied'), 'success');
      } else {
        showToast(t('agents.copyFailed'), 'error');
      }
    },
    [showToast, t],
  );

  const loadStatus = useCallback(async () => {
    setDetectFailed(false);
    try {
      setStatus(await detectAgents(port));
    } catch (e) {
      setStatus(null);
      setDetectFailed(true);
      showToast(t('agents.detectFailed', { msg: errMsg(e) }), 'error');
    }
  }, [port, showToast, t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const loadHermesGuide = useCallback(async () => {
    try {
      setHermesGuide(await fetchHermesGuide(port));
    } catch (e) {
      showToast(t('agents.hermesGuideFailed', { msg: errMsg(e) }), 'error');
    }
  }, [port, showToast, t]);

  const loadZcodeGuide = useCallback(async () => {
    try {
      const raw = await fetchZcodeGuide(port);
      setZcodeGuide(JSON.parse(raw) as ZcodeGuide);
    } catch (e) {
      showToast(t('agents.zcodeGuideFailed', { msg: errMsg(e) }), 'error');
    }
  }, [port, showToast, t]);

  const handleRemoveZcode = useCallback(async () => {
    const ok = await confirm({
      title: t('agents.zcodeRemoveTitle'),
      message: t('agents.zcodeRemoveConfirm'),
      okText: t('agents.zcodeRemoveOk'),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await zcodeRemove();
      showToast(res, 'info');
      await loadStatus();
    } catch (e) {
      showToast(t('agents.zcodeRemoveFailed', { msg: errMsg(e) }), 'error');
    }
  }, [confirm, loadStatus, showToast, t]);

  // 真实密钥只在内存中保留，绝不落盘/打日志
  const configuredKey = apiKey;
  const key = effectiveApiKey(configuredKey);

  // ---- Hermes 派生 ----
  const hermesState: HermesBadgeState | null = status ? hermesBadgeState(status) : null;
  const hermesBadgeText = hermesState
    ? t(
        hermesState === 'not-installed'
          ? 'agents.hermesBadgeNotInstalled'
          : hermesState === 'configured'
            ? 'agents.hermesBadgeConfigured'
            : 'agents.hermesBadgeUnconfigured',
      )
    : detectFailed
      ? t('agents.detectFailedBadge')
      : t('agents.detecting');
  const hermesPath = status ? status.hermes_config_path || t('agents.notFound') : '—';
  const hermesProxy = status
    ? status.hermes_proxy_base_url ||
      (status.hermes_configured ? t('agents.hermesProxyUnresolved') : t('agents.hermesProxyUnknown'))
    : detectFailed
      ? '—'
      : t('agents.detecting');

  const hermesDisplayKey = hermesGuide ? resolveHermesGuideKey(hermesGuide.target_api_key, configuredKey) : '';
  const hermesSnippet = hermesGuide ? substituteGuideApiKey(hermesGuide.yaml_snippet || '', key) : '';

  // ---- ZCode 派生 ----
  const zcodeState: ZcodeBadgeState | null = status ? zcodeBadgeState(status) : null;
  const zcodeBadgeText = zcodeState
    ? t(
        zcodeState === 'not-installed'
          ? 'agents.zcodeBadgeNotInstalled'
          : zcodeState === 'online'
            ? 'agents.zcodeBadgeOnline'
            : zcodeState === 'offline-residue'
              ? 'agents.zcodeBadgeOfflineResidue'
              : 'agents.zcodeBadgeOffline',
      )
    : detectFailed
      ? t('agents.detectFailedBadge')
      : t('agents.detecting');
  const zcodePath = status ? status.zcode_cli_path || t('agents.notFound') : '—';
  // 仅在「离线残留」态提供清理入口
  const showZcodeRemove = zcodeState === 'offline-residue';

  const zcodeDisplayKey = zcodeGuide
    ? !zcodeGuide.api_key || zcodeGuide.api_key === 'local'
      ? key
      : zcodeGuide.api_key
    : '';

  return (
    <div className="panel-page active">
      <div className="section-title-row">
        <div>
          <h2>{t('agents.pageTitle')}</h2>
          <p className="muted">{t('agents.pageDesc')}</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadStatus()}>
          {t('agents.refresh')}
        </button>
      </div>

      <div className="grid-2">
        {/* Hermes Agent 卡片 */}
        <div className="card agent-card">
          <div className="agent-card-header">
            <div className="agent-icon hermes-icon">H</div>
            <div>
              <h3 className="agent-name">{t('agents.hermesTitle')}</h3>
              <p className="muted agent-sub">{t('agents.hermesSub')}</p>
            </div>
            <span className={hermesState ? HERMES_BADGE_CLASS[hermesState] : 'badge badge-info'}>
              {hermesBadgeText}
            </span>
          </div>
          <p className="agent-desc">{t('agents.hermesDesc')}</p>
          <div className="agent-path-text">
            {t('agents.hermesConfigPath')}: <span className="mono truncate">{hermesPath}</span>
          </div>
          <div className="agent-path-text">
            {t('agents.hermesProxy')}: <span className="mono truncate">{hermesProxy}</span>
          </div>
          <div className="divider" />
          <div className="agent-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void loadHermesGuide()}>
              {t('agents.hermesGuideBtn')}
            </button>
          </div>
          {hermesGuide && (
            <div className="zcode-guide-panel">
              <GuideField
                id="hermes-config-path"
                label={t('agents.guideConfigPath')}
                value={hermesGuide.config_path}
                copiedId={copiedId}
                onCopy={handleCopy}
                copyTitle={t('agents.clickToCopy')}
              />
              <GuideField
                id="hermes-target-base-url"
                label={t('agents.guideTargetBaseUrl')}
                value={hermesGuide.target_base_url}
                copiedId={copiedId}
                onCopy={handleCopy}
                copyTitle={t('agents.clickToCopy')}
              />
              <GuideField
                id="hermes-target-api-key"
                label={t('agents.guideTargetApiKey')}
                value={hermesDisplayKey}
                copiedId={copiedId}
                onCopy={handleCopy}
                copyTitle={t('agents.clickToCopy')}
              />
              <GuideField
                id="hermes-target-model"
                label={t('agents.guideTargetModel')}
                value={hermesGuide.target_model}
                copiedId={copiedId}
                onCopy={handleCopy}
                copyTitle={t('agents.clickToCopy')}
              />
              <div className="zguide-field">
                <span className="zguide-label">{t('agents.guideYamlSnippet')}</span>
                <pre
                  className={`zguide-value${copiedId === 'hermes-yaml-snippet' ? ' copied' : ''}`}
                  title={t('agents.clickToCopy')}
                  style={{ whiteSpace: 'pre-wrap', fontSize: '11.5px', margin: 0 }}
                  onClick={() => void handleCopy('hermes-yaml-snippet', hermesSnippet)}
                >
                  {hermesSnippet}
                </pre>
              </div>
              <ol className="zguide-steps">
                {hermesGuide.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {/* ZCode 卡片 */}
        <div className="card agent-card">
          <div className="agent-card-header">
            <div className="agent-icon zcode-icon">Z</div>
            <div>
              <h3 className="agent-name">{t('agents.zcodeTitle')}</h3>
              <p className="muted agent-sub">{t('agents.zcodeSub')}</p>
            </div>
            <span className={zcodeState ? ZCODE_BADGE_CLASS[zcodeState] : 'badge badge-info'}>
              {zcodeBadgeText}
            </span>
          </div>
          <p className="agent-desc">{t('agents.zcodeDesc')}</p>
          <div className="agent-path-text">
            {t('agents.zcodeCliPath')}: <span className="mono truncate">{zcodePath}</span>
          </div>
          <div className="divider" />
          <div className="agent-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void loadZcodeGuide()}>
              {t('agents.zcodeGuideBtn')}
            </button>
            {showZcodeRemove && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void handleRemoveZcode()}
              >
                {t('agents.zcodeRemoveBtn')}
              </button>
            )}
          </div>
          {zcodeGuide && (
            <div className="zcode-guide-panel">
              <GuideField
                id="zcode-base-url"
                label={t('agents.zcodeBaseUrl')}
                value={zcodeGuide.base_url}
                copiedId={copiedId}
                onCopy={handleCopy}
                copyTitle={t('agents.clickToCopy')}
              />
              <GuideField
                id="zcode-api-format"
                label={t('agents.zcodeApiFormat')}
                value={zcodeGuide.api_format}
                copiedId={copiedId}
                onCopy={handleCopy}
                copyTitle={t('agents.clickToCopy')}
              />
              <GuideField
                id="zcode-api-key"
                label={t('agents.zcodeApiKey')}
                value={zcodeDisplayKey}
                copiedId={copiedId}
                onCopy={handleCopy}
                copyTitle={t('agents.clickToCopy')}
              />
              <div className="zguide-field">
                <span className="zguide-label">{t('agents.zcodeModels')}</span>
                <div className="zguide-chips">
                  <span
                    className={`zguide-chip${copiedId === 'zcode-models-all' ? ' copied' : ''}`}
                    title={t('agents.clickToCopy')}
                    onClick={() => void handleCopy('zcode-models-all', (zcodeGuide.models || []).join(', '))}
                  >
                    {t('agents.zcodeCopyAllModels')}
                  </span>
                  {(zcodeGuide.models || []).map((m, i) => (
                    <span
                      key={i}
                      className={`zguide-chip${copiedId === `zcode-model-${i}` ? ' copied' : ''}`}
                      title={t('agents.clickToCopy')}
                      onClick={() => void handleCopy(`zcode-model-${i}`, m)}
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>
              <ol className="zguide-steps">
                {(zcodeGuide.steps || []).map((s, i) => (
                  <li key={i}>{cleanZcodeStep(s)}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface GuideFieldProps {
  id: string;
  label: string;
  value: string;
  copiedId: string | null;
  copyTitle: string;
  onCopy: (id: string, text: string) => void;
}

/** 点击复制的字段行：远端值一律走文本节点渲染。 */
function GuideField({ id, label, value, copiedId, copyTitle, onCopy }: GuideFieldProps) {
  return (
    <div className="zguide-field">
      <span className="zguide-label">{label}</span>
      <span
        className={`zguide-value${copiedId === id ? ' copied' : ''}`}
        title={copyTitle}
        role="button"
        tabIndex={0}
        onClick={() => onCopy(id, value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onCopy(id, value);
          }
        }}
      >
        {value}
      </span>
    </div>
  );
}
