/**
 * 服务看板（原 index.html #panel-dashboard 的 React 迁移）。
 *
 * 左列：反代服务状态卡（运行 pill / 端口 / 运行架构 / 脱敏防护 / 活跃账号 /
 * 支持协议徽章 / 检测时间）+「去授权新账号」快捷入口；
 * 右列：本地接入端点（Base URL / 鉴权密钥 / 三协议端点卡，均随端口联动）；
 * 下方：接口连通性测试（协议下拉 + 真实请求 + 结果渲染）。
 *
 * 约束：不可信文本一律走 React 文本节点渲染，禁止 dangerouslySetInnerHTML；
 * 与后端交互只走 Tauri IPC（services/tauri），禁止直接 fetch；
 * 所有用户可见文案走 t('dashboard.*')。
 */
import { useCallback, useMemo, useState } from 'react';
import { Sparkles, Bot, TerminalSquare, Eye, EyeOff, Copy } from 'lucide-react';
import { useApp } from '../state/ServiceProvider';
import { proxyTestChat } from '../services/tauri';
import { copyToClipboard } from '../services/clipboard';
import { useToast } from '../services/toast';
import { useI18n } from '../i18n';

type TestProtocol = 'chat' | 'messages' | 'responses';

interface ProtocolMeta {
  id: TestProtocol;
  labelKey: string;
  path: string;
}

const PROTOCOLS: ProtocolMeta[] = [
  { id: 'chat', labelKey: 'dashboard.protocolChat', path: '/v1/chat/completions' },
  { id: 'messages', labelKey: 'dashboard.protocolMessages', path: '/v1/messages' },
  { id: 'responses', labelKey: 'dashboard.protocolResponses', path: '/v1/responses' },
];

type TestPhase = 'idle' | 'running' | 'success' | 'failed';

interface TestResult {
  phase: TestPhase;
  protocolLabel: string;
  model: string;
  latencyMs: number | null;
  ttftMs: number | null;
  output: string;
}

const IDLE_RESULT: TestResult = {
  phase: 'idle',
  protocolLabel: '',
  model: '',
  latencyMs: null,
  ttftMs: null,
  output: '',
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function DashboardPage() {
  const { running, port, activeNickname, desensitize, setTab, startProxy, stopProxy, restartProxy } = useApp();
  const { showToast } = useToast();
  const { t } = useI18n();

  const [protocol, setProtocol] = useState<TestProtocol>('chat');
  const [result, setResult] = useState<TestResult>(IDLE_RESULT);
  const [showKey, setShowKey] = useState(false);

  const baseUrl = useMemo(() => `http://127.0.0.1:${port}/v1`, [port]);

  const handleCopy = useCallback(
    async (text: string) => {
      const ok = await copyToClipboard(text);
      if (ok) {
        showToast(t('dashboard.copied'), 'success');
      } else {
        showToast(t('dashboard.copyFailed'), 'error');
      }
    },
    [showToast, t],
  );

  const runTest = useCallback(async () => {
    const selected = PROTOCOLS.find((p) => p.id === protocol) ?? PROTOCOLS[0];
    const protocolLabel = t(selected.labelKey);
    // 请求中：先清空上次残留的时延/首字指标，再发起请求
    setResult({
      phase: 'running',
      protocolLabel,
      model: '',
      latencyMs: null,
      ttftMs: null,
      output: t('dashboard.testRequesting', { protocol: protocolLabel }),
    });
    try {
      const res = await proxyTestChat(port, selected.id);
      const label = res.protocol || protocolLabel;
      const ttftMs = isFiniteNumber(res.ttft_ms) ? res.ttft_ms : null;
      if (res.success) {
        setResult({
          phase: 'success',
          protocolLabel: label,
          model: res.model,
          latencyMs: res.latency_ms,
          ttftMs,
          output: res.response || t('dashboard.testEmptyResponse'),
        });
        showToast(t('dashboard.testSuccessToast', { protocol: label }), 'success');
      } else {
        setResult({
          phase: 'failed',
          protocolLabel: label,
          model: res.model,
          latencyMs: res.latency_ms,
          ttftMs,
          output: res.error || t('dashboard.testNoResult'),
        });
        showToast(t('dashboard.testFailToast', { protocol: label }), 'error');
      }
    } catch (e) {
      // 非 Tauri 环境等：invokeTauri 已做处理，这里只提示错误
      const msg = e instanceof Error ? e.message : String(e);
      setResult((prev) => ({
        ...prev,
        phase: 'failed',
        output: t('dashboard.testClientError', { error: msg }),
      }));
      showToast(t('dashboard.testErrorToast', { error: msg }), 'error');
    }
  }, [port, protocol, showToast, t]);

  const statusBadgeClass = running ? 'badge badge-running' : 'badge badge-stopped';
  const statusBadgeText = running ? t('dashboard.running') : t('dashboard.stopped');
  const protocolBadge = running
    ? t('dashboard.protocolsRunning')
    : t('dashboard.protocolsDetecting');

  const statusTagClass =
    result.phase === 'success'
      ? 'badge badge-valid'
      : result.phase === 'failed'
        ? 'badge badge-expired'
        : 'badge badge-info';
  const statusTagText =
    result.phase === 'success'
      ? t('dashboard.testPass')
      : result.phase === 'failed'
        ? t('dashboard.testFail')
        : t('dashboard.testing');

  return (
    <div className="page kernel-page home-page dashboard-page panel-page active">
      {/* 1. 服务控制与运行状态 (对标 EasyCLIProxyAPI KernelPage .control-panel) */}
      <section className="panel control-panel">
        <div className="panel-heading">
          <div>
            <h2>{t('dashboard.statusTitle')}</h2>
            <p>{running ? t('dashboard.modeDirect') : t('dashboard.modeDetecting')}</p>
          </div>
          <span className={`state-pill ${running ? 'success' : 'neutral'}`} role="status">
            <span className={`status-dot ${running ? 'success' : 'neutral'}`} style={{ marginRight: 6 }} />
            <span className={statusBadgeClass}>{statusBadgeText}</span>
          </span>
        </div>

        {/* 顶部指标状态条 (对标 ECPA .status-strip) */}
        <div className="status-strip">
          <div className="status-card status-card-primary">
            <span className={`status-dot ${running ? 'success' : 'neutral'}`} />
            <div>
              <span>{t('dashboard.statusTitle')}</span>
              <strong className="status-card-value">
                {running ? `127.0.0.1:${port}` : t('dashboard.stopped')}
              </strong>
            </div>
          </div>

          <div className="status-card">
            <span>{t('dashboard.activeAccount')}</span>
            <strong className="status-card-value truncate" title={activeNickname}>
              {running ? activeNickname : t('status.offline')}
            </strong>
          </div>

          <div className="status-card">
            <span>{t('dashboard.protocols')}</span>
            <strong className="status-card-value">{protocolBadge}</strong>
          </div>

          <div className="status-card">
            <span>{t('dashboard.desensitize')}</span>
            <strong className="status-card-value">
              <span className={`badge ${desensitize ? 'badge-success' : 'badge-warn'}`}>
                {desensitize ? t('dashboard.desensitizeOn') : t('dashboard.desensitizeOff')}
              </span>
            </strong>
          </div>
        </div>

        {/* 控制操作按钮条 (对标 ECPA control-action-row) */}
        <div className="button-row panel-action-row control-action-row">
          <button
            type="button"
            className={running ? 'danger-button' : 'primary-button'}
            disabled={running}
            onClick={() => void startProxy()}
          >
            {running ? t('dashboard.running') : t('service.start')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!running}
            onClick={() => void restartProxy()}
          >
            {t('service.restart')}
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={!running}
            onClick={() => void stopProxy()}
          >
            {t('service.stop')}
          </button>
        </div>
      </section>

      {/* 2. 客户端接入配置面板 (对标 EasyCLIProxyAPI KernelPage .client-api-panel) */}
      <section className="panel client-api-panel">
        <div className="panel-heading client-api-heading">
          <div>
            <h2>{t('dashboard.endpointsTitle')}</h2>
            <div className="client-api-key-actions">
              <span className="client-api-meta">{t('dashboard.apiKey')}:</span>
              <code className="client-api-key-code">
                {showKey ? 'local' : '••••••••'}
              </code>
              <button
                type="button"
                className="icon-button quiet"
                onClick={() => setShowKey(!showKey)}
                title={showKey ? '隐藏' : '显示'}
                aria-label={showKey ? '隐藏' : '显示'}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button
                type="button"
                className="icon-button quiet"
                onClick={() => void handleCopy('local')}
                title={t('dashboard.copy')}
                aria-label={t('dashboard.copy')}
              >
                <Copy size={14} />
              </button>
              <span className="client-api-divider">|</span>
              <span className="client-api-meta">Base URL:</span>
              <code className="client-api-key-code">{baseUrl}</code>
              <button
                type="button"
                className="icon-button quiet"
                onClick={() => void handleCopy(baseUrl)}
                title={t('dashboard.copy')}
                aria-label={t('dashboard.copy')}
              >
                <Copy size={14} />
              </button>
            </div>
          </div>
          <button className="secondary-button" style={{ height: 34, fontSize: 12.5 }} onClick={() => setTab('oauth')}>
            {t('dashboard.gotoOauth')}
          </button>
        </div>

        {/* 客户端接入卡片网格 (对标 ECPA .client-api-grid & .client-api-card) */}
        <div className="client-api-grid">
          {PROTOCOLS.map((p) => {
            const fullUrl = `${baseUrl}${p.path}`;
            const Icon = p.id === 'chat' ? Sparkles : p.id === 'messages' ? Bot : TerminalSquare;
            return (
              <article key={p.id} className={`client-api-card ${p.id}`}>
                <div className="client-api-card-heading">
                  <span className="client-api-logo">
                    <Icon size={18} />
                  </span>
                  <div>
                    <strong>{t(p.labelKey)}</strong>
                    <span className="client-api-format-tag">{p.path}</span>
                  </div>
                </div>

                <div className="client-api-values">
                  <div className="client-api-value-row">
                    <span>{t(p.labelKey)}</span>
                    <code title={fullUrl} onClick={() => void handleCopy(fullUrl)}>
                      {fullUrl}
                    </code>
                    <button
                      type="button"
                      className="icon-button quiet"
                      onClick={() => void handleCopy(fullUrl)}
                      title={t('dashboard.copy')}
                      aria-label={t('dashboard.copy')}
                    >
                      <Copy size={15} />
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* 3. 连通性测试面板 (对标 EasyCLIProxyAPI .panel.quiet-panel) */}
      <section className="panel quiet-panel diagnostic-test-panel">
        <div className="panel-heading">
          <div>
            <h2>{t('dashboard.testTitle')}</h2>
            <p>{t('dashboard.testDesc')}</p>
          </div>
          <div className="actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select
              className="input mono"
              style={{ minWidth: 200, height: 38 }}
              title={t('dashboard.testProtocolTitle')}
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as TestProtocol)}
              disabled={result.phase === 'running'}
            >
              {PROTOCOLS.map((p) => (
                <option value={p.id} key={p.id}>
                  {t(p.labelKey)} ({p.path})
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-primary primary-button"
              onClick={() => void runTest()}
              disabled={result.phase === 'running'}
            >
              {result.phase === 'running' && (
                <span
                  className="spinner"
                  style={{
                    width: 14,
                    height: 14,
                    borderWidth: 2,
                    display: 'inline-block',
                    marginRight: 6,
                  }}
                />
              )}
              {result.phase === 'running' ? t('dashboard.testing') : t('dashboard.test')}
            </button>
          </div>
        </div>

        {result.phase !== 'idle' && (
          <div className="test-result-box">
            <div className="test-status-line">
              <span className={statusTagClass}>{statusTagText}</span>
              <span className="muted">
                {t('dashboard.protocol')}: <strong className="mono">{result.protocolLabel}</strong>
              </span>
              {result.model && (
                <span className="muted">
                  {t('dashboard.model')}: <strong className="mono">{result.model}</strong>
                </span>
              )}
              {isFiniteNumber(result.ttftMs) && (
                <span className="muted">
                  {t('dashboard.ttft')}: <strong className="mono">{`${Math.round(result.ttftMs)} ms`}</strong>
                </span>
              )}
              <span className="muted">
                {t('dashboard.latency')}:{' '}
                <strong className="mono text-success">
                  {isFiniteNumber(result.latencyMs) ? `${result.latencyMs} ms` : '— ms'}
                </strong>
              </span>
            </div>
            {/* 模型响应 / 错误文本：远端不可信文本，用文本节点渲染 */}
            <div className="test-output-quote">{result.output}</div>
          </div>
        )}
      </section>
    </div>
  );
}
