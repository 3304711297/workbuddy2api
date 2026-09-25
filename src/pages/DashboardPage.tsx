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
  const { running, port, activeNickname, healthTime, desensitize, setTab } = useApp();
  const { showToast } = useToast();
  const { t } = useI18n();

  const [protocol, setProtocol] = useState<TestProtocol>('chat');
  const [result, setResult] = useState<TestResult>(IDLE_RESULT);

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
    <div className="panel-page active">
      <div className="dashboard-hero-grid">
        {/* 左列：运行状态卡 */}
        <div className="card status-card">
          <div className="card-header-flex">
            <div>
              <h3 className="card-title">{t('dashboard.statusTitle')}</h3>
              <p className="card-desc" style={{ marginBottom: 0 }}>
                {t('dashboard.statusDesc')}
              </p>
            </div>
            <div className={`state-pill ${running ? 'running' : 'stopped'}`}>
              <span className={`dot ${running ? 'dot-running' : 'dot-stopped'}`}></span>
              <span className={statusBadgeClass}>{statusBadgeText}</span>
            </div>
          </div>

          <dl className="panel-detail-grid">
            <div className="panel-detail-row">
              <dt>{t('dashboard.port')}</dt>
              <dd>
                <span className="metric-value mono">{port}</span>
              </dd>
            </div>
            <div className="panel-detail-row">
              <dt>{t('dashboard.mode')}</dt>
              <dd>
                <span className="metric-value mono">
                  {running ? t('dashboard.modeDirect') : t('dashboard.modeDetecting')}
                </span>
              </dd>
            </div>
            <div className="panel-detail-row">
              <dt>{t('dashboard.desensitize')}</dt>
              <dd>
                <span className={`metric-value ${desensitize ? 'text-success' : ''}`}>
                  {desensitize ? t('dashboard.desensitizeOn') : t('dashboard.desensitizeOff')}
                </span>
              </dd>
            </div>
            <div className="panel-detail-row">
              <dt>{t('dashboard.activeAccount')}</dt>
              <dd>
                <span className="truncate font-medium">{activeNickname}</span>
              </dd>
            </div>
          </dl>

          <div className="divider"></div>
          <div className="card-footer-info">
            <span>
              {t('dashboard.protocols')}
              <strong className="badge badge-info">{protocolBadge}</strong>
            </span>
            <span className="muted">{healthTime}</span>
          </div>

          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={() => setTab('oauth')}>
              {t('dashboard.gotoOauth')}
            </button>
          </div>
        </div>

        {/* 右列：API 端点快速接入卡片组 */}
        <div className="card">
          <div className="card-header-flex">
            <div>
              <h3 className="card-title">{t('dashboard.endpointsTitle')}</h3>
              <p className="card-desc" style={{ marginBottom: 0 }}>
                {t('dashboard.endpointsDesc')}
              </p>
            </div>
          </div>

          <div className="copy-input-group" style={{ marginTop: 4 }}>
            <label className="field-label">Base URL</label>
            <div className="input-with-btn">
              <input className="input mono" type="text" readOnly value={baseUrl} />
              <button className="btn btn-sm btn-copy" onClick={() => void handleCopy(baseUrl)}>
                {t('dashboard.copy')}
              </button>
            </div>
          </div>
          <div className="copy-input-group" style={{ marginTop: 10 }}>
            <label className="field-label">{t('dashboard.apiKey')}</label>
            <div className="input-with-btn">
              {/* 字面量占位符：客户端鉴权密钥以 'local' 直连即可 */}
              <input className="input mono" type="text" readOnly value="local" />
              <button className="btn btn-sm btn-copy" onClick={() => void handleCopy('local')}>
                {t('dashboard.copy')}
              </button>
            </div>
          </div>

          <div className="endpoint-grid">
            {PROTOCOLS.map((p) => {
              const fullUrl = `${baseUrl}${p.path}`;
              return (
                <div className="endpoint-card" key={p.id}>
                  <div className="endpoint-header">
                    <span className="endpoint-title">{t(p.labelKey)}</span>
                    <span className="endpoint-tag">POST</span>
                  </div>
                  <div className="endpoint-path">{fullUrl}</div>
                  <button
                    className="btn btn-sm btn-secondary"
                    style={{ width: '100%', fontSize: 11 }}
                    onClick={() => void handleCopy(fullUrl)}
                  >
                    {t('dashboard.copyFullEndpoint')}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 连通性实时测试卡片 */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header-flex">
          <div>
            <h3 className="card-title">{t('dashboard.testTitle')}</h3>
            <p className="card-desc">{t('dashboard.testDesc')}</p>
          </div>
          <div className="actions" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select
              className="input mono"
              style={{ minWidth: 190 }}
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
              className="btn btn-secondary"
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
                ></span>
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
      </div>
    </div>
  );
}
