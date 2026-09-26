/**
 * OAuth 登录轮询（纯逻辑；二维码/状态 UI 由调用方持有）。
 *
 * 契约（与旧 oauth.js 一致）：
 *  - 2s 间隔、单路 in-flight（auth_poll 上游超时可达 30s，无守卫并发堆积）；
 *  - 120 tick 上限（约 4 分钟，腾讯 state 有效期），超时按取消处理；
 *  - generation 取号：取消后已在途的 poll 若回来判定成功，也不得再落盘/弹提示；
 *  - 成功（code === 0）后停表 → 回调 onSuccess，由调用方刷新账号/健康。
 */

import { authBegin, authPoll } from './tauri';

export const OAUTH_POLL_INTERVAL_MS = 2000;
export const OAUTH_MAX_TICKS = 120;

export interface OAuthController {
  /** 开始新一轮登录：返回二维码 URL；旧轮次自动作废 */
  begin: () => Promise<string>;
  /** 取消当前轮次（在途 poll 回来也按作废处理） */
  cancel: () => void;
  /** 当前是否在轮询 */
  readonly polling: boolean;
}

export function createOAuthController(callbacks: {
  onSuccess: () => void;
  onTimeout: () => void;
}): OAuthController {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let ticks = 0;
  let generation = 0;
  let currentState = '';
  let polling = false;

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    polling = false;
  };

  const tick = async () => {
    const gen = generation;
    if (inFlight) return;
    inFlight = true;
    try {
      ticks++;
      if (ticks > OAUTH_MAX_TICKS) {
        stopTimer();
        callbacks.onTimeout();
        return;
      }
      const res = await authPoll(currentState);
      if (gen !== generation) return; // 已被取消/新轮次，丢弃
      if (res.code === 0 && res.data) {
        stopTimer();
        callbacks.onSuccess();
      }
      // code !== 0：继续等待（腾讯侧未完成授权）
    } catch {
      // 单次 poll 失败不中断轮询（上游抖动常见）；连续失败由 tick 上限兜底
    } finally {
      inFlight = false;
    }
  };

  return {
    get polling() {
      return polling;
    },
    async begin() {
      generation++; // 作废上一轮
      stopTimer();
      const { state, auth_url } = await authBegin();
      currentState = state;
      ticks = 0;
      inFlight = false;
      polling = true;
      timer = setInterval(tick, OAUTH_POLL_INTERVAL_MS);
      return auth_url;
    },
    cancel() {
      generation++; // 在途 poll 回来也按作废处理
      stopTimer();
    },
  };
}
