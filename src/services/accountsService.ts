/**
 * 账号与资产面板数据加载（纯逻辑；渲染由 AccountsPage 持有）。
 *
 * 契约（与旧 accounts.js 一致）：
 *  - 单次加载 4 路并行：list_accounts / proxy_rate_limit / usage_query / checkin_claim；
 *  - Promise.allSettled：单路失败不拖死整页；
 *  - 请求序号 _accountsRequestSeq：单次加载可能耗时数十秒（usage_query 上游
 *    超时 30s），期间用户可能已点击「刷新」——陈旧结果直接丢弃；
 *  - 活跃账号来自最后一页快照（_lastActiveUid）；限流卡取 isActiveAccountLimited
 *    对应的账号。
 */

import {
  accountsList,
  proxyRateLimit,
  usageQuery,
  proxyCheckinStatus,
  type AccountInfo,
  type RateLimitInfo,
  type UsageQuota,
  type CheckinStatus,
} from './tauri';

export const ACCOUNTS_PAGE_SIZE = 100;

export interface AccountsLoadResult {
  accounts: AccountInfo[] | null;
  total: number;
  rateLimit: RateLimitInfo | null;
  quota: UsageQuota | null;
  checkin: CheckinStatus | null;
  failReason: string | null;
}

export interface AccountsLoader {
  /** 加载；陈旧结果返回 null（调用方直接丢弃）。 */
  load: (port: number) => Promise<AccountsLoadResult | null>;
  /** 作废在途加载。 */
  invalidate: () => void;
}

export function createAccountsLoader(): AccountsLoader {
  let requestSeq = 0;
  return {
    invalidate: () => {
      requestSeq++;
    },
    load: async (port: number) => {
      const seq = ++requestSeq;
      const settled = await Promise.allSettled([
        accountsList(),
        proxyRateLimit(port),
        usageQuery(),
        // 只读签到状态（与旧 syncCheckinStatus 一致）：页面加载绝不自动 claim，
        // claim 只发生在用户点击「每日签到」按钮时。
        proxyCheckinStatus(port),
      ]);
      if (seq !== requestSeq) return null; // 已被新一轮作废
      const [accRes, rlRes, quotaRes, checkinRes] = settled;
      const accounts = accRes.status === 'fulfilled' ? accRes.value : null;
      return {
        accounts,
        total: accounts?.length ?? 0,
        rateLimit: rlRes.status === 'fulfilled' ? rlRes.value : null,
        quota: quotaRes.status === 'fulfilled' ? quotaRes.value : null,
        checkin: checkinRes.status === 'fulfilled' ? checkinRes.value : null,
        failReason: accRes.status === 'fulfilled' ? null : '账号列表加载失败',
      };
    },
  };
}

/** 冷却倒计时格式化：90s → "1分30秒"。 */
export function formatCooldown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}分` : `${m}分${r}秒`;
}

/**
 * 账号 uid → 冷却秒数映射（纯函数）。
 * accountCooldowns 可能是 [{uid, model, remainingSec}] 或 {uid: seconds}。
 */
export function buildAccountCooldownMap(rateLimit: RateLimitInfo | null): Map<string, number> {
  const map = new Map<string, number>();
  const raw = rateLimit?.accountCooldowns;
  if (!raw) return map;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const uid = String(item?.uid ?? '');
      if (uid) map.set(uid, Number(item?.remainingSec ?? 0));
    }
  } else if (typeof raw === 'object') {
    for (const [uid, sec] of Object.entries(raw)) {
      map.set(uid, Number(sec ?? 0));
    }
  }
  return map;
}

/** 限流卡目标账号：优先 isActiveAccountLimited 指向的账号。 */
export function pickLimitedAccount(
  accounts: AccountInfo[],
  rateLimit: RateLimitInfo | null,
): AccountInfo | null {
  if (!accounts.length) return null;
  for (const m of Object.values(rateLimit?.models ?? {})) {
    if (m?.isActiveAccountLimited && m.limitedUid) {
      const hit = accounts.find((a) => a.uid === m.limitedUid);
      if (hit) return hit;
    }
  }
  return accounts[0];
}

/** uid 截断展示（与旧 renderAccountCard 一致：前 12 + …）。 */
export function shortUid(uid: string): string {
  return uid.length > 12 ? `${uid.slice(0, 12)}…` : uid;
}
