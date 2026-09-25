/**
 * 健康轮询（纯逻辑；UI 状态由调用方持有）。
 *
 * 契约：
 *  - 3s 间隔 + in-flight 守卫（proxy_health 上游超时 10s，无守卫会积压重叠请求）；
 *  - `_healthSeq` 取号：早发出晚返回的陈旧响应直接丢弃（停止服务前在途的检查
 *    若晚返回，会把看板从「已停止」写回「运行中」）；
 *  - 窗口隐藏时停表（托盘 hide_to_tray 后 7×24 轮询纯属空转），可见时起表；
 *  - bumpHealthSeq()：启停/重启前作废在途检查。
 */

import { proxyHealth } from './tauri';

export const HEALTH_POLL_INTERVAL_MS = 3000;

export interface HealthSnapshot {
  running: boolean;
  seq: number;
}

let healthSeq = 0;
/** 作废所有在途的健康检查（服务启停/重启前调用）。 */
export function bumpHealthSeq(): void {
  healthSeq++;
}

/** 单次健康检查：返回取号后的快照；陈旧响应返回 null。 */
export async function checkHealthOnce(port: number): Promise<HealthSnapshot | null> {
  const seq = ++healthSeq;
  try {
    await proxyHealth(port);
    if (seq !== healthSeq) return null;
    return { running: true, seq };
  } catch {
    if (seq !== healthSeq) return null;
    return { running: false, seq };
  }
}

export interface HealthPoller {
  stop: () => void;
}

/**
 * 启动健康轮询。
 * @param check 由调用方提供、用最新端口做单次检查的闭包（端口变化即时生效）；
 * @param onSnapshot 收到快照（null = 陈旧响应已丢弃）。
 * 隐藏窗口时停表，可见时起表并立即补一次。
 */
export function startHealthPolling(
  check: () => Promise<HealthSnapshot | null>,
  onSnapshot: (snap: HealthSnapshot | null) => void,
): HealthPoller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      onSnapshot(await check());
    } finally {
      inFlight = false;
    }
  };

  const startTimer = () => {
    if (document.visibilityState === 'hidden') return;
    if (timer) return;
    timer = setInterval(tick, HEALTH_POLL_INTERVAL_MS);
  };
  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      void tick();
      startTimer();
    } else {
      stopTimer();
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  startTimer();

  return {
    stop: () => {
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
