/**
 * 应用更新：检测（GitHub commit 比对）+ 交接式自动更新（纯逻辑；弹窗 UI 由组件持有）。
 *
 * 契约（与旧 update-check.js / AGENTS.md §4 一致）：
 *  - 检测口径对齐 Hermes Desktop：被动 API 比对远端分支 tip SHA 与本机 HEAD，
 *    不做 git fetch 轮询；本项目不使用 GitHub Release；
 *  - 字段走 snake_case：update_available / current_sha / target_sha / behind /
 *    supported / dirty / commits / failure_kind；
 *  - behind == null → 「数量未知」，绝不编造数字；
 *  - 手动检查必须 force: true（绕过 Rust 侧缓存）；启动静默检查走缓存（1500ms 后）；
 *  - 接续更新必须先问 app_update_resume（核实 updater 仍存活），不能只看残留 phase
 *    （800ms 后）；进程已死则收尾成 failed + updater-gone；
 *  - 应用中 1s 轮询 app_update_state；GUI 即将退出时 IPC 断开属正常，继续等；
 *  - 阶段名 UPDATE_PHASES 与脚本 Write-State 对齐；失败分类 FAILURE_HINTS
 *    与脚本 Throw-Failure 的 kind 对应；
 *  - commit 标题必须用 textContent 渲染（远端不可信输入）。
 */

import {
  checkAppUpdate,
  applyAppUpdate,
  appUpdateState,
  appUpdateResume,
  type UpdateCheckResult,
  type AppUpdateState,
} from './tauri';

/** 阶段定义（与脚本 Write-State 的 phase 取值对齐）。 */
export const UPDATE_PHASES = [
  'preparing', 'fetching', 'merging', 'deps',
  'frontend', 'building', 'verifying', 'restarting',
] as const;

export type UpdatePhase = (typeof UPDATE_PHASES)[number];

/** 失败分类 → 用户能据以行动的一句话（与脚本 Throw-Failure 的 kind 对应）。 */
export const FAILURE_HINTS: Record<string, string> = {
  'not-a-git-checkout': '当前安装目录不是 git 检出，无法自动更新。',
  'gui-exit-timeout': '应用未能在预期时间内退出，更新已中止。',
  'fetch-failed': '网络或代理不可用，无法获取远端提交。可检查代理后重试。',
  diverged: '本地存在未推送的提交，与远端分叉。请先手动处理分叉再更新。',
  'stash-failed': '工作区改动未能安全保存，为避免丢失已中止更新。',
  'deps-failed': '依赖安装失败，通常是网络问题。可检查代理后重试。',
  'frontend-build-failed': '前端构建失败，代码可能存在问题。',
  'rust-build-failed': 'Rust 编译失败，代码可能存在问题。',
  'artifact-missing': '构建未产出可执行文件，已拒绝使用。',
  'artifact-suspicious': '构建产物异常（疑似未内嵌前端），已拒绝使用。',
  'startup-unhealthy': '新版本启动后服务不可用，已回滚到更新前的版本。',
  'port-not-released': '旧服务未释放端口（残留进程占用），已中止更新以避免误判。请重启电脑后重试。',
  // 更新进程中途消失（被杀 / 关窗 / 断电）：脚本没机会写终态，由 Rust 侧 app_update_resume
  // 收尾成这个分类，避免永远接续一个早已死掉的更新。
  'updater-gone': '上次更新未正常结束（更新进程已退出）。可重新点击「检查更新」发起一次完整更新。',
  unknown: '请查看更新日志了解详情。',
};

export function failureHint(kind: string | null | undefined): string {
  return FAILURE_HINTS[kind ?? ''] ?? FAILURE_HINTS.unknown;
}

/** 可接续的进行中阶段（含握手态 handoff-ready 与回滚态 rolling-back）。 */
const RESUMABLE_PHASES = new Set([
  'handoff-ready', 'preparing', 'fetching', 'merging', 'deps',
  'frontend', 'building', 'verifying', 'restarting', 'rolling-back',
]);

export interface UpdatePoller {
  stop: () => void;
}

export interface UpdatePollCallbacks {
  onMessage: (message: string) => void;
  onFailed: (detail: string, hint: string) => void;
  onDone: () => void;
}

/** 1s 轮询脚本写入的阶段状态。 */
export function startUpdatePolling(callbacks: UpdatePollCallbacks): UpdatePoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let seenAlive = false;

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const arm = () => {
    stop();
    timer = setInterval(tick, 1000);
  };

  const tick = async () => {
    let state: AppUpdateState | null;
    try {
      state = await appUpdateState();
    } catch {
      // GUI 即将退出时 IPC 可能已经断开，属正常，继续等
      return;
    }
    if (!state || !state.phase) {
      // 状态文件曾出现又消失：重建轮询（与旧 startUpdatePolling 递归语义一致，
      // 旧实现靠全局 timer 变量替换达到同样效果）
      if (seenAlive) arm();
      return;
    }
    seenAlive = true;

    const phase = state.phase;
    if (phase === 'handoff-ready') {
      callbacks.onMessage('更新环境已就绪，主窗口即将关闭并由更新视窗接管…');
      return;
    }

    callbacks.onMessage(state.message || '正在更新…');

    if (phase === 'failed') {
      stop();
      const detail = [state.detail, failureHint(state.failure_kind)].filter(Boolean).join('\n');
      callbacks.onFailed(detail, '可关闭本窗口后重新检查更新。');
      return;
    }

    if (phase === 'done') {
      // 脚本会拉起新 GUI；本进程仍在时如实告知，用户可自行关闭
      stop();
      callbacks.onDone();
    }
  };

  arm();
  return { stop };
}

export interface UpdateCheckOptions {
  silent: boolean;
  force?: boolean;
}

/** 执行一次检测。返回原始结果；抛错由调用方按 silent 与否决定提示。 */
export async function runUpdateCheck(opts: UpdateCheckOptions): Promise<UpdateCheckResult> {
  return checkAppUpdate(opts.force ?? false);
}

/** 启动交接式更新：返回脚本的首条回执（可能为空）。抛错由调用方处理。 */
export async function startApplyUpdate(): Promise<string> {
  return applyAppUpdate();
}

/**
 * 接续未完成的更新：必须问 app_update_resume（核实 updater 存活），
 * 返回可接续的 state；不可接续返回 null。
 */
export async function resumeInFlightUpdate(): Promise<AppUpdateState | null> {
  let state: AppUpdateState | null;
  try {
    state = await appUpdateResume();
  } catch {
    // 命令不可用（旧版 Rust 侧）时保守不接续：宁可漏显示一次进度，
    // 也不要因为无法核实存活而弹出一个用户关不掉的窗。
    return null;
  }
  if (!state?.phase) return null;
  if (!RESUMABLE_PHASES.has(state.phase)) return null;
  return state;
}

export const UPDATE_STARTUP_SILENT_DELAY_MS = 1500;
export const UPDATE_RESUME_DELAY_MS = 800;
