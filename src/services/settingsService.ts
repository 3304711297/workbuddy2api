/**
 * 设置持久化（纯逻辑；控件渲染由 SettingsPage 持有）。
 *
 * 契约（与旧 settings.js 一致，AGENTS.md §4「AppConfig 整对象覆盖写盘」两条铁律）：
 *  - buildPayload 必须带全字段：缺失字段会被 serde default 抹回默认值；
 *  - dirty merge：patch 声明「本次修改的字段」，在 payload 末尾最后展开（优先级最高）；
 *  - 写前先读磁盘真源，只回填「本次未修改」的字段；读盘失败则中止保存
 *    （禁止用陈旧 cache 覆盖——会把旧密钥落回磁盘）；
 *  - 串行单写队列：saveChain.catch(() => {}).then(...)，防并发 Lost Update；
 *  - API key 用 CSPRNG 生成（crypto.getRandomValues 16 字节 hex）；
 *  - 密钥不进 localStorage，只在内存 cache。
 */

import {
  getAppSettings,
  saveAppSettings,
  type AppSettings,
  type SettingsPatch,
} from './tauri';

/** 设置页可编辑字段（React 表单态）。 */
export interface SettingsFormState {
  closeAction: string;
  autoStartProxy: boolean;
  showDebugConsole: boolean;
  port: number;
  desensitize: boolean;
  rotateMode: string;
  rotateCount: number;
  modelListMode: string;
  apiKey: string;
  logLevel: string;
  logPayloads: boolean;
  listenHost: string;
  snapshots: boolean;
  snapshotsKeep: number;
}

export const DEFAULT_SETTINGS_FORM: SettingsFormState = {
  closeAction: 'hide_to_tray',
  autoStartProxy: false,
  showDebugConsole: false,
  port: 8787,
  desensitize: false,
  rotateMode: 'off',
  rotateCount: 1,
  modelListMode: 'all',
  apiKey: '',
  logLevel: 'info',
  logPayloads: false,
  listenHost: '127.0.0.1',
  snapshots: true,
  snapshotsKeep: 200,
};

/** CSPRNG 生成 16 字节 hex 密钥。 */
export function generateApiKey(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function normalizeLogLevel(v: unknown): string {
  return v === 'debug' || v === 'trace' ? (v as string) : 'info';
}

export function normalizeModelListMode(v: unknown): string {
  return v === 'available' ? 'available' : 'all';
}

export function normalizePort(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1024 && n <= 65535 ? n : null;
}

export interface SettingsStore {
  /** 从磁盘加载并归一化为表单态（非法值归一到默认）。 */
  loadFromDisk: () => Promise<SettingsFormState>;
  /** 构造完整 payload（全字段 + dirty patch 最后展开）。 */
  buildPayload: (form: SettingsFormState, patch?: SettingsPatch) => AppSettings;
  /**
   * 持久化：dirty merge + 串行写队列。
   * @param patch 本次明确修改的字段；
   * @param form 当前表单态（port/desensitize/close_action 等取自它）；
   * @returns 是否保存成功（失败/中止返回 false，不抛错，由回调提示）。
   */
  persist: (patch: SettingsPatch, form: SettingsFormState) => Promise<boolean>;
  /** 同步「他页负责写入」的字段缓存（账号页写 rotate_mode/rotate_count）。 */
  setPeerCaches: (c: { rotateMode?: string; rotateCount?: number }) => void;
}

export function createSettingsStore(callbacks: {
  onError: (message: string) => void;
}): SettingsStore {
  // 「他页写入」字段的内存镜像（账号页调度策略卡负责 rotate_*）
  let rotateModeCache = 'off';
  let rotateCountCache = 1;
  let modelListModeCache = 'all';
  let apiKeyCache = '';
  let logLevelCache = 'info';
  let logPayloadsCache = false;
  let listenHostCache = '127.0.0.1';
  let snapshotsCache = true;
  let snapshotsKeepCache = 200;

  // 串行单写队列（P1-4 防御并发 Lost Update）
  let saveChain: Promise<boolean> = Promise.resolve(true);

  const buildPayload = (form: SettingsFormState, patch: SettingsPatch = {}): AppSettings => ({
    close_action: form.closeAction || 'hide_to_tray',
    auto_start_proxy: form.autoStartProxy,
    show_debug_console: form.showDebugConsole,
    port: form.port,
    desensitize: form.desensitize,
    rotate_mode: rotateModeCache,
    rotate_count: rotateCountCache,
    model_list_mode: modelListModeCache,
    // 密钥：留空即不鉴权；每次保存都带上，避免被整对象覆盖写盘抹除
    api_key: apiKeyCache,
    log_level: logLevelCache,
    log_payloads: logPayloadsCache,
    listen_host: listenHostCache,
    snapshots: snapshotsCache,
    snapshots_keep: snapshotsKeepCache,
    // dirty 字段最后展开：显式声明的「本次修改」优先于磁盘回填与 cache
    ...patch,
  });

  const persist = (patch: SettingsPatch, form: SettingsFormState): Promise<boolean> => {
    saveChain = saveChain.catch(() => false).then(async () => {
      try {
        // 写盘前先读一次磁盘真源：只回填「本次未修改」的字段
        let latest: Awaited<ReturnType<typeof getAppSettings>> | null = null;
        try {
          latest = await getAppSettings();
        } catch {
          // 读盘失败必须中止本次保存：dirty-merge 依赖磁盘真源回填，
          // 读不到就只剩内存 cache —— 其中 api_key 可能是陈旧值，
          // 带着它写盘等于把旧密钥落回磁盘。宁可让用户重试，也不静默写旧数据。
          callbacks.onError('读取磁盘设置失败，本次保存已中止（未写入任何改动），请稍后重试');
          return false;
        }
        if (latest) {
          if (!('rotate_mode' in patch) && latest.rotate_mode) rotateModeCache = latest.rotate_mode;
          if (!('rotate_count' in patch) && latest.rotate_count) rotateCountCache = latest.rotate_count;
          if (!('model_list_mode' in patch) && latest.model_list_mode) modelListModeCache = latest.model_list_mode;
          if (!('log_level' in patch) && latest.log_level) logLevelCache = latest.log_level;
          if (!('log_payloads' in patch) && typeof latest.log_payloads === 'boolean') logPayloadsCache = latest.log_payloads;
          if (!('listen_host' in patch) && latest.listen_host) listenHostCache = latest.listen_host;
          if (!('snapshots' in patch) && typeof latest.snapshots === 'boolean') snapshotsCache = latest.snapshots;
          if (!('snapshots_keep' in patch) && Number.isInteger(latest.snapshots_keep) && latest.snapshots_keep > 0) {
            snapshotsKeepCache = latest.snapshots_keep;
          }
          // 密钥：表单是真源。表单非空 → 采用表单值（用户刚改的）；
          // 表单为空 → 回退磁盘值（用户没动密钥，避免把空串写盘）；
          // 显式清空走 { api_key: '' } patch，不会被回灌覆盖。
          if (!('api_key' in patch)) {
            if (form.apiKey.trim()) {
              apiKeyCache = form.apiKey;
            } else if (typeof latest.api_key === 'string') {
              apiKeyCache = latest.api_key;
            }
          }
        }
        await saveAppSettings(buildPayload(form, patch));
        return true;
      } catch (err) {
        callbacks.onError(`保存设置失败: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    });
    return saveChain;
  };

  const loadFromDisk = async (): Promise<SettingsFormState> => {
    const cfg = await getAppSettings();
    const port = normalizePort(cfg.port) ?? DEFAULT_SETTINGS_FORM.port;
    const apiKey = typeof cfg.api_key === 'string' ? cfg.api_key : '';
    const modelListMode = normalizeModelListMode(cfg.model_list_mode);
    const logLevel = normalizeLogLevel(cfg.log_level);
    const listenHost = typeof cfg.listen_host === 'string' && cfg.listen_host ? cfg.listen_host : '127.0.0.1';
    const snapshotsKeep = Number.isInteger(cfg.snapshots_keep) && cfg.snapshots_keep > 0 ? cfg.snapshots_keep : 200;

    // 同步内存 cache（与旧 settings.js 回读语义一致）
    rotateModeCache = cfg.rotate_mode || 'off';
    rotateCountCache = Number.isInteger(cfg.rotate_count) ? cfg.rotate_count : 1;
    modelListModeCache = modelListMode;
    apiKeyCache = apiKey;
    logLevelCache = logLevel;
    logPayloadsCache = !!cfg.log_payloads;
    listenHostCache = listenHost;
    snapshotsCache = cfg.snapshots !== false;
    snapshotsKeepCache = snapshotsKeep;

    return {
      closeAction: cfg.close_action || 'hide_to_tray',
      autoStartProxy: !!cfg.auto_start_proxy,
      showDebugConsole: !!cfg.show_debug_console,
      port,
      desensitize: !!cfg.desensitize,
      rotateMode: rotateModeCache,
      rotateCount: rotateCountCache,
      modelListMode,
      apiKey,
      logLevel,
      logPayloads: !!cfg.log_payloads,
      listenHost,
      snapshots: cfg.snapshots !== false,
      snapshotsKeep,
    };
  };

  return {
    loadFromDisk,
    buildPayload,
    persist,
    setPeerCaches: (c) => {
      if (c.rotateMode !== undefined) rotateModeCache = c.rotateMode;
      if (c.rotateCount !== undefined) rotateCountCache = c.rotateCount;
    },
  };
}
