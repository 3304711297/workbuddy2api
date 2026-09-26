/**
 * 日志拉取（纯逻辑；渲染与滚动由调用方持有）。
 *
 * 契约（与旧 logs.js 一致）：
 *  - 2s 拉取一次，仅日志页活动时；
 *  - 贴底判断：用户上滚时暂停自动滚动，新日志到达不抢滚动条；
 *  - 清空需二次确认。
 */

export const LOGS_POLL_INTERVAL_MS = 2000;

/** 稳定 ID：测试与组件共享，避免魔法字符串漂移 */
export const LOG_AUTO_SCROLL_ID = 'log-auto-scroll';

/**
 * 是否贴底：scrollHeight - scrollTop - clientHeight <= 阈值。
 * 纯函数，可单测。
 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 40,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export interface LogsPoller {
  stop: () => void;
}

/** 启动日志轮询；调用方在回调里做「暂停自动滚动」判断后追加渲染。 */
export function startLogsPolling(onLogs: (text: string) => void, fetch: () => Promise<string>): LogsPoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      onLogs(await fetch());
    } catch {
      /* 拉取失败静默：下轮重试，不打扰用户 */
    } finally {
      inFlight = false;
    }
  };

  void tick();
  timer = setInterval(tick, LOGS_POLL_INTERVAL_MS);

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
