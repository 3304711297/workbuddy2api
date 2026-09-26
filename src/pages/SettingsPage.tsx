/**
 * 设置页（React 迁移版）。
 *
 * 迁移自旧 `src/settings.js` 的「设置表单」部分；主题切换已迁至 Sidebar，本页不重复。
 * - 挂载时经 settingsService.loadFromDisk() 回填表单；之后表单为纯 React state，
 *   用户编辑不再被异步回填覆盖（touched 语义天然满足）；
 * - 每个分组独立保存：store.persist(patch, form)，patch 只声明本次修改字段。
 *   后端 save_app_settings 为「整对象覆盖写盘」，缺字段会被 serde default 抹回——
 *   全字段构造 + dirty merge（写前读盘只回填未修改字段、读盘失败中止保存、
 *   串行单写队列）由 settingsService 保证，本页只负责声明 patch；
 * - API Key 只存内存 state（本页表单 + 全局 useApp），绝不进 localStorage，
 *   绝不出现在日志/toast 文案中；
 * - 新增「界面语言」下拉（旧版没有的 i18n 入口），置于页首。
 *
 * 注意：close_action 的 'minimize' 选项后端暂不支持——Rust 侧 CloseAction 枚举
 * （src-tauri/src/lib.rs）仅有 quit / hide_to_tray，落盘 'minimize' 会因 serde
 * 未知变体导致整个 save_app_settings 调用失败（error toast，不会静默写坏）。
 * 待后端补齐变体后再启用该选项的实际落盘。
 */
import { useEffect, useRef, useState } from 'react';
import {
  createSettingsStore,
  generateApiKey,
  normalizeLogLevel,
  normalizeModelListMode,
  normalizePort,
  DEFAULT_SETTINGS_FORM,
  type SettingsFormState,
  type SettingsStore,
} from '../services/settingsService';
import { lanIpv4, type SettingsPatch } from '../services/tauri';
import { useApp } from '../state/ServiceProvider';
import { useI18n, LANGS, type Lang } from '../i18n';
import { useToast } from '../services/toast';
import { useConfirm } from '../services/confirm';

const CLOSE_ACTION_OPTIONS = [
  { value: 'hide_to_tray', labelKey: 'settings.closeAction.hideToTray', descKey: 'settings.closeAction.hideToTrayDesc' },
  { value: 'minimize', labelKey: 'settings.closeAction.minimize', descKey: 'settings.closeAction.minimizeDesc' },
  { value: 'quit', labelKey: 'settings.closeAction.quit', descKey: 'settings.closeAction.quitDesc' },
] as const;

const LOG_LEVELS = ['info', 'debug', 'trace'] as const;

const ENV_VAR_ROWS: Array<{ name: string; descKey: string }> = [
  { name: 'WORKBUDDY2API_OPTIMIZE_CONTEXT=1', descKey: 'settings.envOptimize' },
  { name: 'WORKBUDDY2API_MAX_IMAGE_MB', descKey: 'settings.envMaxImage' },
  { name: 'WORKBUDDY2API_MAX_BODY_MB', descKey: 'settings.envMaxBody' },
  { name: 'WORKBUDDY2API_USER_AGENT', descKey: 'settings.envUserAgent' },
];

export function SettingsPage() {
  const { setPort, setDesensitize, checkHealthNow, running, setApiKey } = useApp();
  const { lang, setLang, t } = useI18n();
  const { showToast } = useToast();
  const { confirm } = useConfirm();

  // ---- 表单态：loadFromDisk 回填后即为真源，用户编辑不再被异步覆盖 ----
  const [form, setForm] = useState<SettingsFormState>(DEFAULT_SETTINGS_FORM);
  const [portText, setPortText] = useState(String(DEFAULT_SETTINGS_FORM.port));
  const [keepText, setKeepText] = useState(String(DEFAULT_SETTINGS_FORM.snapshotsKeep));
  const [showKey, setShowKey] = useState(false);
  const [lanIp, setLanIp] = useState<string | null>(null); // null=未探测/失败，''=未探测到地址
  const [lanDetecting, setLanDetecting] = useState(false);

  // 最近一次落盘的端口（判断端口是否变化）与密钥（避免无改动空保存）
  const savedPortRef = useRef<number>(DEFAULT_SETTINGS_FORM.port);
  const apiKeySavedRef = useRef<string>('');

  // store 单例：onError 经 ref 转发，避免闭包捕获过期 showToast
  const toastRef = useRef(showToast);
  toastRef.current = showToast;
  const storeRef = useRef<SettingsStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createSettingsStore({
      onError: (message) => {
        toastRef.current(message, 'error');
      },
    });
  }
  const store = storeRef.current;

  const restartSuffix = () => (running ? t('settings.suffixRestartKernel') : '');
  const restartSuffixParen = () => (running ? t('settings.suffixRestartKernelParen') : '');

  /** 单字段保存链路：刷新表单态 → 串行 dirty-merge 落盘 → 成功 toast。 */
  const saveField = async (
    patch: SettingsPatch,
    next: SettingsFormState,
    okMessage: string,
    okKind: 'success' | 'info' = 'success',
  ): Promise<boolean> => {
    setForm(next);
    const ok = await store.persist(patch, next);
    if (ok) showToast(okMessage, okKind);
    return ok;
  };

  const probeLanIp = async () => {
    setLanDetecting(true);
    try {
      const ip = await lanIpv4();
      setLanIp(ip || '');
    } catch {
      setLanIp(null);
    } finally {
      setLanDetecting(false);
    }
  };

  // 挂载回填（仅一次）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const loaded = await store.loadFromDisk();
        if (!alive) return;
        setForm(loaded);
        setPortText(String(loaded.port));
        setKeepText(String(loaded.snapshotsKeep));
        savedPortRef.current = loaded.port;
        apiKeySavedRef.current = loaded.apiKey;
        // 同步全局态：看板/侧边栏的端口、脱敏与密钥展示
        setPort(loaded.port);
        setDesensitize(loaded.desensitize);
        setApiKey(loaded.apiKey);
        if (loaded.listenHost === '0.0.0.0') void probeLanIp();
      } catch (e) {
        showToast(t('settings.loadFailed', { msg: e instanceof Error ? e.message : String(e) }), 'error');
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------
  // 各分组保存动作（patch 只声明本次修改字段）
  // ------------------------------------------------------------------

  /** 监听端口：独立保存按钮；normalizePort 非法值 toast 报错不保存。 */
  const onSavePort = async () => {
    const val = normalizePort(portText.trim());
    if (val === null) {
      showToast(t('settings.portRangeError'), 'error');
      return;
    }
    const changed = val !== savedPortRef.current;
    const next = { ...form, port: val };
    const ok = await saveField(
      { port: val },
      next,
      changed && running ? t('settings.portSavedRunning') : t('settings.portSaved', { port: val }),
      'info',
    );
    if (!ok) return;
    savedPortRef.current = val;
    setPortText(String(val));
    // 保存成功后同步全局态；ServiceProvider 的 portRef 随渲染更新，
    // 用 macrotask 延后探活才能打到新端口
    setPort(val);
    window.setTimeout(() => {
      void checkHealthNow();
    }, 50);
  };

  const onToggleDesensitize = async (checked: boolean) => {
    const next = { ...form, desensitize: checked };
    if (await saveField({ desensitize: checked }, next, t('settings.desensitizeSaved'))) {
      setDesensitize(checked);
    }
  };

  const onToggleAutoStart = async (checked: boolean) => {
    const next = { ...form, autoStartProxy: checked };
    await saveField(
      { auto_start_proxy: checked },
      next,
      t(checked ? 'settings.autoStartOn' : 'settings.autoStartOff'),
    );
  };

  const onToggleDebugConsole = async (checked: boolean) => {
    const next = { ...form, showDebugConsole: checked };
    await saveField(
      { show_debug_console: checked },
      next,
      t(checked ? 'settings.debugConsoleOn' : 'settings.debugConsoleOff'),
    );
  };

  const onCloseAction = async (value: string) => {
    const opt = CLOSE_ACTION_OPTIONS.find((o) => o.value === value);
    if (!opt) return;
    const next = { ...form, closeAction: value };
    await saveField(
      { close_action: value },
      next,
      t('settings.closeActionSaved', { name: t(opt.labelKey) }),
    );
  };

  /** 模型清单模式：内核热读，保存后无需重启。 */
  const onModelListMode = async (value: string) => {
    const mode = normalizeModelListMode(value);
    const next = { ...form, modelListMode: mode };
    await saveField(
      { model_list_mode: mode },
      next,
      t(mode === 'available' ? 'settings.modelListModeToAvailable' : 'settings.modelListModeToAll'),
    );
  };

  // —— 客户端鉴权密钥（只存内存；生成走 CSPRNG；清空需二次确认） ——
  const onGenApiKey = async () => {
    const key = generateApiKey();
    const next = { ...form, apiKey: key };
    setApiKey(key);
    if (
      await saveField({ api_key: key }, next, t('settings.apiKeyGenSaved', { suffix: restartSuffix() }))
    ) {
      apiKeySavedRef.current = key;
    }
  };

  const onCopyApiKey = async () => {
    const val = form.apiKey.trim();
    if (!val) {
      showToast(t('settings.apiKeyEmptyNoCopy'), 'info');
      return;
    }
    try {
      await navigator.clipboard.writeText(val);
      showToast(t('settings.apiKeyCopied'), 'success');
    } catch {
      showToast(t('settings.apiKeyCopyFailed'), 'error');
    }
  };

  const onClearApiKey = async () => {
    const okConfirm = await confirm({
      title: t('settings.apiKeyClearTitle'),
      message: t('settings.apiKeyClearMsg'),
      danger: true,
    });
    if (!okConfirm) return;
    const next = { ...form, apiKey: '' };
    setApiKey('');
    // 显式声明空值：dirty merge 下空 patch 不会被磁盘回灌覆盖，清空真正生效
    if (
      await saveField(
        { api_key: '' },
        next,
        t(running ? 'settings.apiKeyClearedRestart' : 'settings.apiKeyCleared'),
        'info',
      )
    ) {
      apiKeySavedRef.current = '';
    }
  };

  /** 手动编辑：失焦/回车即保存（无改动时不空保存）。 */
  const commitApiKeyEdit = async () => {
    const trimmed = form.apiKey.trim();
    if (trimmed === apiKeySavedRef.current) return;
    const next = { ...form, apiKey: trimmed };
    setApiKey(trimmed);
    if (await saveField({ api_key: trimmed }, next, t('settings.apiKeySaved', { suffix: restartSuffix() }))) {
      apiKeySavedRef.current = trimmed;
    }
  };

  const onLogLevel = async (value: string) => {
    const level = normalizeLogLevel(value);
    const next = { ...form, logLevel: level };
    await saveField(
      { log_level: level },
      next,
      t('settings.logLevelSaved', { level, suffix: restartSuffix() }),
    );
  };

  const onToggleLogPayloads = async (checked: boolean) => {
    const next = { ...form, logPayloads: checked };
    await saveField(
      { log_payloads: checked },
      next,
      checked
        ? t('settings.logPayloadsOn', { suffix: restartSuffixParen() })
        : t('settings.logPayloadsOff'),
      checked ? 'info' : 'success',
    );
  };

  const onToggleSnapshots = async (checked: boolean) => {
    const next = { ...form, snapshots: checked };
    await saveField(
      { snapshots: checked },
      next,
      checked
        ? t('settings.snapshotsOn', { suffix: restartSuffixParen() })
        : t('settings.snapshotsOff'),
      checked ? 'info' : 'success',
    );
  };

  /** 快照保留条数：钳制到 10–2000，非法输入回退 200；失焦/回车即保存。 */
  const commitSnapshotsKeep = async () => {
    const parsed = parseInt(keepText, 10);
    const v = Math.max(10, Math.min(2000, Number.isFinite(parsed) ? parsed : 200));
    setKeepText(String(v));
    if (v === form.snapshotsKeep) return;
    const next = { ...form, snapshotsKeep: v };
    await saveField(
      { snapshots_keep: v },
      next,
      t('settings.snapshotsKeepSaved', { count: v, suffix: restartSuffixParen() }),
    );
  };

  /** 局域网访问：无密钥时拒绝开启并引导（内核会拒绝启动，不如提前拦截）。 */
  const onToggleLan = async (checked: boolean) => {
    if (checked && !form.apiKey.trim()) {
      showToast(t('settings.lanNeedApiKey'), 'error');
      return;
    }
    const host = checked ? '0.0.0.0' : '127.0.0.1';
    const next = { ...form, listenHost: host };
    if (checked) {
      void probeLanIp();
    } else {
      setLanDetecting(false);
      setLanIp(null);
    }
    await saveField(
      { listen_host: host },
      next,
      checked ? t('settings.lanEnabled', { suffix: restartSuffix() }) : t('settings.lanDisabled'),
      checked ? 'info' : 'success',
    );
  };

  const onLangChange = (value: string) => {
    const next = (LANGS.some((l) => l.id === value) ? value : 'zh-CN') as Lang;
    const msg = t('settings.languageChanged');
    setLang(next);
    showToast(msg, 'success');
  };

  const lanEnabled = form.listenHost === '0.0.0.0';
  const lanAddressText = lanDetecting
    ? t('settings.lanDetecting')
    : lanIp === null
      ? t('settings.lanDetectFailed')
      : lanIp === ''
        ? t('settings.lanNoAddress')
        : `http://${lanIp}:${form.port}/v1`;

  return (
    <div className="panel-page active">
      <div className="section-title-row">
        <div>
          <h2>{t('settings.title')}</h2>
          <p className="muted">{t('settings.subtitle')}</p>
        </div>
      </div>

      <div className="settings-grid">
        {/* 0. 界面语言（React 迁移新增的 i18n 入口，旧版没有） */}
        <div className="card settings-card">
          <div className="card-header-flex">
            <div>
              <h3 className="card-title">{t('settings.languageTitle')}</h3>
              <p className="card-desc" style={{ marginBottom: 0 }}>{t('settings.languageDesc')}</p>
            </div>
          </div>
          <select
            className="input"
            style={{ maxWidth: 340, marginTop: 12 }}
            value={lang}
            onChange={(e) => onLangChange(e.target.value)}
            aria-label={t('settings.languageTitle')}
          >
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        {/* 1. 网络与端点配置 */}
        <div className="card settings-card">
          <div className="card-header-flex">
            <div>
              <h3 className="card-title">{t('settings.networkTitle')}</h3>
              <p className="card-desc" style={{ marginBottom: 0 }}>{t('settings.networkDesc')}</p>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="settings-input-port">{t('settings.portLabel')}</label>
            <div className="input-with-btn" style={{ maxWidth: 320, marginTop: 6 }}>
              <input
                id="settings-input-port"
                className="input mono"
                type="number"
                min={1024}
                max={65535}
                value={portText}
                onChange={(e) => setPortText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onSavePort();
                }}
                aria-label={t('settings.portLabel')}
              />
              <button type="button" className="btn btn-secondary" onClick={() => void onSavePort()}>
                {t('settings.savePort')}
              </button>
            </div>
            <p className="muted field-hint">{t('settings.portHint')}</p>
          </div>

          <div className="divider" />

          <div>
            <label className="switch-label">
              <input
                type="checkbox"
                checked={form.autoStartProxy}
                onChange={(e) => void onToggleAutoStart(e.target.checked)}
              />
              <span className="switch-slider" />
              <span className="switch-text">{t('settings.autoStart')}</span>
            </label>
            <p className="muted field-hint">{t('settings.autoStartHint')}</p>
          </div>

          <div className="divider" />

          <div>
            <label className="switch-label">
              <input
                type="checkbox"
                checked={lanEnabled}
                onChange={(e) => void onToggleLan(e.target.checked)}
              />
              <span className="switch-slider" />
              <span className="switch-text">{t('settings.lanLabel')}</span>
            </label>
            <p className="muted field-hint" style={{ marginTop: 6 }}>{t('settings.lanHint')}</p>
            {lanEnabled && (
              <p className="muted field-hint" style={{ marginTop: 6 }}>
                {t('settings.lanAddressLabel')}
                <code className="mono">{lanAddressText}</code>
                {t('settings.lanAddressRestartNote')}
              </p>
            )}
          </div>
        </div>

        {/* 2. 安全与访问鉴权 */}
        <div className="card settings-card">
          <div className="card-header-flex">
            <div>
              <h3 className="card-title">{t('settings.securityTitle')}</h3>
              <p className="card-desc" style={{ marginBottom: 0 }}>{t('settings.securityDesc')}</p>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="settings-input-api-key">{t('settings.apiKeyLabel')}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
              <input
                id="settings-input-api-key"
                className="input mono"
                type={showKey ? 'text' : 'password'}
                value={form.apiKey}
                placeholder={t('settings.apiKeyPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, minWidth: 260 }}
                onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
                onBlur={() => void commitApiKeyEdit()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitApiKeyEdit();
                }}
              />
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowKey((s) => !s)}>
                {t(showKey ? 'settings.apiKeyHide' : 'settings.apiKeyShow')}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                title={t('settings.apiKeyGenTitle')}
                onClick={() => void onGenApiKey()}
              >
                {t('settings.apiKeyGen')}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void onCopyApiKey()}>
                {t('settings.apiKeyCopy')}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void onClearApiKey()}>
                {t('settings.apiKeyClear')}
              </button>
            </div>
            <p className="muted field-hint" style={{ marginTop: 6 }}>
              {t('settings.apiKeyHintA')}
              <code className="mono">Authorization: Bearer &lt;key&gt;</code>
              {t('settings.apiKeyHintB')}
              <code className="mono">x-api-key: &lt;key&gt;</code>
              {t('settings.apiKeyHintC')}
            </p>
          </div>

          <div className="divider" />

          <div>
            <label className="switch-label">
              <input
                type="checkbox"
                checked={form.desensitize}
                onChange={(e) => void onToggleDesensitize(e.target.checked)}
              />
              <span className="switch-slider" />
              <span className="switch-text">{t('settings.desensitizeLabel')}</span>
            </label>
            <p className="muted field-hint">{t('settings.desensitizeHint')}</p>
          </div>
        </div>

        {/* 3. 模型与客户端交互 */}
        <div className="card settings-card">
          <div className="card-header-flex">
            <div>
              <h3 className="card-title">{t('settings.modelTitle')}</h3>
              <p className="card-desc" style={{ marginBottom: 0 }}>{t('settings.modelDesc')}</p>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="settings-select-model-list-mode">
              {t('settings.modelListModeLabel')}
            </label>
            <select
              id="settings-select-model-list-mode"
              className="input"
              style={{ maxWidth: 340, marginTop: 6 }}
              value={form.modelListMode}
              onChange={(e) => void onModelListMode(e.target.value)}
            >
              <option value="all">{t('settings.modelListModeAll')}</option>
              <option value="available">{t('settings.modelListModeAvailable')}</option>
            </select>
            <p className="muted field-hint">{t('settings.modelListModeHint')}</p>
            <p className="muted field-hint">
              {t(
                form.modelListMode === 'available'
                  ? 'settings.modelListModeNote.available'
                  : 'settings.modelListModeNote.all',
              )}
            </p>
          </div>

          <div className="divider" />

          <div>
            <span className="field-label" id="settings-close-action-label">{t('settings.closeActionLabel')}</span>
            <div
              role="radiogroup"
              aria-labelledby="settings-close-action-label"
              style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}
            >
              {CLOSE_ACTION_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                >
                  <input
                    type="radio"
                    name="close-action"
                    value={o.value}
                    checked={form.closeAction === o.value}
                    onChange={() => void onCloseAction(o.value)}
                  />
                  <span>
                    <strong>{t(o.labelKey)}</strong>
                    {t(o.descKey)}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="divider" />

          <div>
            <label className="switch-label">
              <input
                type="checkbox"
                checked={form.showDebugConsole}
                onChange={(e) => void onToggleDebugConsole(e.target.checked)}
              />
              <span className="switch-slider" />
              <span className="switch-text">{t('settings.debugConsoleLabel')}</span>
            </label>
            <p className="muted field-hint">{t('settings.debugConsoleHint')}</p>
          </div>

          <div className="divider" />

          <div>
            <label className="field-label" htmlFor="settings-data-dir">{t('settings.dataDirLabel')}</label>
            <input
              id="settings-data-dir"
              className="input mono"
              type="text"
              readOnly
              value="%LOCALAPPDATA%\workbuddy2api\accounts.json"
              style={{ marginTop: 6 }}
            />
          </div>
        </div>

        {/* 4. 日志、调试与高级运行时 */}
        <div className="card settings-card">
          <div className="card-header-flex">
            <div>
              <h3 className="card-title">{t('settings.logTitle')}</h3>
              <p className="card-desc" style={{ marginBottom: 0 }}>{t('settings.logDesc')}</p>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="field-label" htmlFor="settings-select-log-level">
              {t('settings.logLevelLabel')}
            </label>
            <select
              id="settings-select-log-level"
              className="input"
              style={{ maxWidth: 420, marginTop: 6 }}
              value={form.logLevel}
              onChange={(e) => void onLogLevel(e.target.value)}
            >
              {LOG_LEVELS.map((lv) => (
                <option key={lv} value={lv}>
                  {t(`settings.logLevel.${lv}`)}
                </option>
              ))}
            </select>
            <p className="muted field-hint" style={{ marginTop: 6 }}>{t('settings.logLevelHint')}</p>

            <label className="switch-label" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={form.logPayloads}
                onChange={(e) => void onToggleLogPayloads(e.target.checked)}
              />
              <span className="switch-slider" />
              <span className="switch-text">{t('settings.logPayloadsLabel')}</span>
            </label>
            <p className="muted field-hint">{t('settings.logPayloadsHint')}</p>

            <label className="switch-label" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={form.snapshots}
                onChange={(e) => void onToggleSnapshots(e.target.checked)}
              />
              <span className="switch-slider" />
              <span className="switch-text">{t('settings.snapshotsLabel')}</span>
            </label>
            <p className="muted field-hint">
              {t('settings.snapshotsKeepLabel')}
              <input
                type="number"
                className="input mono"
                style={{ width: 76, fontSize: 12, padding: '4px 8px', margin: '0 4px' }}
                min={10}
                max={2000}
                step={10}
                value={keepText}
                onChange={(e) => setKeepText(e.target.value)}
                onBlur={() => void commitSnapshotsKeep()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitSnapshotsKeep();
                }}
                aria-label={t('settings.snapshotsKeepLabel')}
              />
              {t('settings.snapshotsKeepUnit')}
            </p>
          </div>

          <div className="divider" />

          <div>
            <span className="field-label">{t('settings.advancedTitle')}</span>
            <ul className="muted field-hint" style={{ margin: '6px 0 0 18px', padding: 0, fontSize: 11, lineHeight: 1.9 }}>
              {ENV_VAR_ROWS.map((row) => (
                <li key={row.name}>
                  <code className="mono">{row.name}</code>
                  {' —— '}
                  {t(row.descKey)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
