/**
 * Tauri IPC 适配层（与 EasyCLIProxyAPI 的 services/tauri.ts 对齐）。
 *
 * 全部后端调用经此收口：前端**零直接 HTTP**，一律走 Tauri 命令。
 * 参数名一律 camelCase（Tauri 宏默认 ArgumentCase::Camel）。
 *
 * 类型与 Rust 命令定义逐项对齐（src-tauri/src/commands/*.rs, src-tauri/src/lib.rs）。
 * 注意两个 snake_case 例外（AGENTS.md 锁定）：
 *  - agent_detect 返回的 `hermes_proxy_base_url`（serde snake_case），不得写成 camelCase；
 *  - 更新检测字段 `update_available / current_sha / target_sha / behind / supported / dirty / commits / failure_kind`。
 */

import { invoke } from '@tauri-apps/api/core';

export const NOT_IN_TAURI_MESSAGE = '未运行在 Tauri 运行时环境中';

/** 是否运行在 Tauri 运行时内。 */
export function isTauriRuntime(): boolean {
  try {
    return typeof window !== 'undefined' && '__TAURI__' in window;
  } catch {
    return false;
  }
}

/**
 * 类型化 Tauri 命令调用。
 * 非 Tauri 环境（浏览器 dev）抛中文错误，调用方据此展示环境横幅并安全失败。
 */
export async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    // Mock Invoke（浏览器/dev 环境）：仅回显命令名，绝不打印参数（含密钥）
    console.warn(`[Mock Invoke] ${cmd} — 当前不在 Tauri 运行时内`);
    throw new Error(NOT_IN_TAURI_MESSAGE);
  }
  return invoke<T>(cmd, args);
}

// ---------------------------------------------------------------------------
// 设置（与 src-tauri/src/lib.rs 的 AppConfig 对齐；整对象覆盖写盘）
// ---------------------------------------------------------------------------

export interface AppSettings {
  close_action: string;
  auto_start_proxy: boolean;
  show_debug_console: boolean;
  port: number;
  desensitize: boolean;
  rotate_mode: string;
  rotate_count: number;
  model_list_mode: string;
  api_key: string;
  log_level: string;
  log_payloads: boolean;
  listen_host: string;
  snapshots: boolean;
  snapshots_keep: number;
}

export type SettingsPatch = Partial<AppSettings>;

export const getAppSettings = () => invokeTauri<AppSettings>('get_app_settings');
export const saveAppSettings = (settings: AppSettings) =>
  invokeTauri<string>('save_app_settings', { settings });

// ---------------------------------------------------------------------------
// 服务启停
// ---------------------------------------------------------------------------

export interface ProxyHealth {
  status: string;
  authenticated?: boolean;
}

export const proxyStart = (port: number, desensitize: boolean) =>
  invokeTauri<string>('proxy_start', { port, desensitize });
export const proxyStop = () => invokeTauri<string>('proxy_stop');
export const proxyRestart = (port: number, desensitize: boolean) =>
  invokeTauri<string>('proxy_restart', { port, desensitize });
export const proxyHealth = (port: number) => invokeTauri<ProxyHealth>('proxy_health', { port });
/** /api/rate_limit 载荷（内核自曝；404/未运行 → None） */
export interface RateLimitModelEntry {
  state?: string;
  remainingSec?: number;
  resetLocal?: string;
  lastSeenLocal?: string;
  message?: string;
  isActiveAccountLimited?: boolean;
  limitedUid?: string;
  limitedNickname?: string;
}

export interface RateLimitInfo {
  models?: Record<string, RateLimitModelEntry>;
  rollingUsage?: Record<string, {
    reqsToday?: number;
    tokensToday?: number;
    err429_today?: number;
    reqs5h?: number;
    tokens5h?: number;
    err429_5h?: number;
  }>;
  nightFree?: boolean;
  rotation?: { soonest_expire_day?: string; active_uid?: string };
  fallbacks?: Record<string, { count?: number; actual?: string; reason?: string; lastLocal?: string }>;
  accountCooldowns?: Array<{ uid?: string; model?: string; remainingSec?: number }>;
  server?: { protocols?: string[]; maxBodyMb?: number; userAgent?: string };
}

export const proxyRateLimit = (port: number) =>
  invokeTauri<RateLimitInfo | null>('proxy_rate_limit', { port });

/** 与 proxy.rs 的 TestChatResult 对齐 */
export interface ChatTestResult {
  success: boolean;
  model: string;
  response: string;
  latency_ms: number;
  ttft_ms?: number | null;
  error?: string | null;
  protocol: string;
}

export const proxyTestChat = (port: number, protocol: string, model = 'glm-5.3-flash') =>
  invokeTauri<ChatTestResult>('proxy_test_chat', { port, model, protocol });

// ---------------------------------------------------------------------------
// 账号 / OAuth（与 auth.rs 的 AccountItem / LoginState / TokenPollResult 对齐）
// ---------------------------------------------------------------------------

export interface AccountInfo {
  uid: string;
  nickname: string;
  phone_number?: string | null;
  enterprise_name?: string | null;
  token_expires_at: number;
  token_expired: boolean;
  is_active: boolean;
  last_updated: number;
}

export const accountsList = () => invokeTauri<AccountInfo[]>('accounts_list');
export const accountsSwitch = (uid: string) => invokeTauri<string>('accounts_switch', { uid });
export const accountsDelete = (uid: string) => invokeTauri<string>('accounts_delete', { uid });
export const accountsRefreshToken = (uid: string) =>
  invokeTauri<unknown>('accounts_refresh_token', { uid });

export interface AuthBeginResult {
  state: string;
  auth_url: string;
}

export const authBegin = () => invokeTauri<AuthBeginResult>('auth_begin', { platform: 'console' });

export interface AuthPollResult {
  code: number;
  msg: string;
  data?: unknown;
}

export const authPoll = (state: string) => invokeTauri<AuthPollResult>('auth_poll', { state });

// ---------------------------------------------------------------------------
// 模型（与 billing.rs 的 ModelMetaItem / ModelBadge 对齐）
// ---------------------------------------------------------------------------

export interface ModelBadge {
  text: string;
  color: string;
  kind: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  credits: string;
  max_input_tokens: number;
  max_output_tokens: number;
  upstream_max_input_tokens?: number | null;
  supports_reasoning: boolean;
  can_disable_thinking: boolean;
  supported_efforts: string[];
  default_effort: string;
  description: string;
  tags: string[];
  badges: ModelBadge[];
  custom_context_window?: number | null;
  custom_reasoning_effort?: string | null;
  efforts_source: string;
  availability: string;
}

/** 别名：服务层沿用旧命名，真实类型见上。 */
export type ModelMetaItem = ModelInfo;

export const modelsFetchAll = () => invokeTauri<ModelInfo[]>('models_fetch_all');
export const modelSaveConfig = (modelId: string, reasoningEffort: string | null) =>
  invokeTauri<string>('model_save_config', { modelId, reasoningEffort });

// ---------------------------------------------------------------------------
// Agent / 引导（与 agents.rs 对齐；hermes_proxy_base_url 保持 snake_case）
// ---------------------------------------------------------------------------

export interface AgentDetectResult {
  hermes_installed: boolean;
  hermes_configured: boolean;
  hermes_config_path: string;
  hermes_proxy_base_url: string;
  zcode_installed: boolean;
  zcode_provider_registered: boolean;
  zcode_service_online: boolean;
  zcode_cli_path: string;
  zcode_v2_path: string;
}

/** 别名：服务层沿用旧命名，真实类型见上。 */
export type AgentStatus = AgentDetectResult;

export interface HermesEndpointGuide {
  installed: boolean;
  config_path: string;
  current_provider: string;
  current_model: string;
  current_base_url: string;
  current_api_key_configured: boolean;
  target_base_url: string;
  target_api_key: string;
  target_model: string;
  yaml_snippet: string;
  steps: string[];
}

/** zcode_guide 返回 JSON 字符串：{ mode, base_url, api_format, api_key, models, steps, note } */
export interface ZcodeGuide {
  mode: string;
  base_url: string;
  api_format: string;
  api_key: string;
  models: string[];
  steps: string[];
  note: string;
}

export const agentDetect = (port: number) =>
  invokeTauri<AgentDetectResult>('agent_detect', { port });
export const hermesEndpointGuide = (port: number) =>
  invokeTauri<HermesEndpointGuide>('hermes_endpoint_guide', { port });
export const zcodeGuide = (port: number) => invokeTauri<string>('zcode_guide', { port });
export const zcodeRemove = () => invokeTauri<string>('zcode_remove');

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

export const proxyGetLogs = () => invokeTauri<string>('proxy_get_logs');
export const proxyClearLogs = () => invokeTauri<string>('proxy_clear_logs');
export const openLogsDir = () => invokeTauri<string>('open_logs_dir');

// ---------------------------------------------------------------------------
// 用量：billing.rs 的 usage_query(uid?) 是上游资产积分；proxy.rs 的
// usage_summary() / usage_events(...) 是本地请求统计。两者不得混淆。
// ---------------------------------------------------------------------------

/** 上游资产积分（billing.rs UsageSummary）：uid 缺省走活跃账号 */
export interface UsagePackage {
  code: string;
  total: number;
  remain: number;
  used: number;
  unit: string;
}

export interface UsageQuota {
  uid: string;
  nickname: string;
  total: number;
  remain: number;
  used: number;
  is_paid_user: boolean;
  packages: UsagePackage[];
}

export const usageQuery = (uid?: string) =>
  invokeTauri<UsageQuota>('usage_query', uid ? { uid } : {});

/** 本地请求统计（proxy.rs aggregate_usage）：无参 */
export interface UsageBucket {
  requests: number;
  ok: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageHourlyBucket extends UsageBucket {
  ts: number;
}

export interface UsageOverall extends UsageBucket {
  avg_latency_ms: number;
  tps: number;
  tps_samples: number;
}

export interface LocalUsageSummary {
  today: UsageBucket;
  overall: UsageOverall;
  hourly: UsageHourlyBucket[];
}

/** 别名：服务层沿用旧命名，真实类型见上。 */
export type UsageSummary = LocalUsageSummary;

export const usageSummary = () => invokeTauri<LocalUsageSummary>('usage_summary');

export interface UsageEventItem {
  ts: number;
  model: string;
  ok: boolean;
  input_tokens?: number | null;
  output_tokens?: number | null;
  latency_ms: number;
  ttft_ms?: number | null;
  error?: string | null;
  retry_count: number;
  retry_reason?: string | null;
  requested_model?: string | null;
  actual_model?: string | null;
  fallback_reason?: string | null;
}

/** 别名：服务层沿用旧命名，真实类型见上。 */
export type UsageEvent = UsageEventItem;

export interface UsageModelAnalysis {
  model: string;
  requests: number;
  ok: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  avg_latency_ms: number;
}

export interface UsageEventsResult {
  items: UsageEventItem[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  analysis: { models: UsageModelAnalysis[] };
}

export const usageEvents = (params: {
  page: number;
  pageSize: number;
  sinceMs?: number;
  model?: string;
  status?: string;
}) =>
  invokeTauri<UsageEventsResult>('usage_events', {
    page: params.page,
    pageSize: params.pageSize,
    sinceMs: params.sinceMs,
    model: params.model,
    status: params.status,
  });

// ---------------------------------------------------------------------------
// 签到（内核返回 { ok, data: { today_checked_in, active, end_time } }）
// ---------------------------------------------------------------------------

export interface CheckinStatusData {
  today_checked_in?: boolean;
  active?: boolean;
  end_time?: string;
}

export interface CheckinStatus {
  ok: boolean;
  data?: CheckinStatusData;
  error?: string;
}

/** proxy_checkin_claim 返回：{ ok, status, credit, streak_days, error, msg }（见旧 accounts.js 签到按钮）。 */
export interface CheckinClaimResult {
  ok: boolean;
  status?: string;
  credit?: number;
  streak_days?: number;
  error?: string;
  msg?: string;
}

export const proxyCheckinStatus = (port: number) =>
  invokeTauri<CheckinStatus>('proxy_checkin_status', { port });
export const proxyCheckinClaim = (port: number) =>
  invokeTauri<CheckinClaimResult>('proxy_checkin_claim', { port });

// ---------------------------------------------------------------------------
// 快照调试（snapshots_list 返回 { snapshots: [...最新在前], total }）
// ---------------------------------------------------------------------------

export interface SnapshotItem {
  id: string;
  ts: number;
  endpoint?: string;
  model?: string;
  status?: number;
  latency_ms?: number;
  [key: string]: unknown;
}

export interface SnapshotsResult {
  snapshots: SnapshotItem[];
  total: number;
}

export const snapshotsList = (limit = 100) =>
  invokeTauri<SnapshotsResult>('snapshots_list', { limit });
export const snapshotsClear = () => invokeTauri<string>('snapshots_clear');

/** snapshot_replay 返回：{ status, latency_ms, excerpt }（见旧 debug.js 重放处理）。 */
export interface SnapshotReplayResult {
  status: number;
  latency_ms: number;
  excerpt?: string;
}

export const snapshotReplay = (id: string, port: number, apiKey: string) =>
  invokeTauri<SnapshotReplayResult>('snapshot_replay', { id, port, apiKey });

// ---------------------------------------------------------------------------
// 应用更新（commit 比对 + 交接式自更新；不用 GitHub Release）
// 字段与 src-tauri/src/commands/update.rs 的 AppUpdateInfo / AppUpdateState 对齐
// （snake_case；AGENTS.md 锁定）
// ---------------------------------------------------------------------------

export interface UpdateCommit {
  sha: string;
  summary: string;
  author: string;
  at: number;
}

export interface UpdateCheckResult {
  supported: boolean;
  reason?: string | null;
  branch: string;
  current_sha: string;
  target_sha?: string | null;
  /** 落后多少个 commit；null = 有更新但数量未知（绝不编造数字） */
  behind?: number | null;
  update_available: boolean;
  /** 工作区可能有未提交改动（更新脚本会先 stash） */
  dirty: boolean;
  commits: UpdateCommit[];
  update_root: string;
  fetched_at: number;
  error?: string | null;
  message?: string | null;
}

export interface AppUpdateState {
  run_id?: string | null;
  updater_pid?: number | null;
  phase: string;
  message: string;
  failure_kind: string;
  detail: string;
  updated_at: number;
  pid: number;
}

export const checkAppUpdate = (force = false) =>
  invokeTauri<UpdateCheckResult>('check_app_update', { force });
export const applyAppUpdate = () => invokeTauri<string>('apply_app_update');
export const appUpdateState = () => invokeTauri<AppUpdateState | null>('app_update_state');
export const appUpdateResume = () => invokeTauri<AppUpdateState | null>('app_update_resume');

// ---------------------------------------------------------------------------
// 其它
// ---------------------------------------------------------------------------

export const lanIpv4 = () => invokeTauri<string>('lan_ipv4');
