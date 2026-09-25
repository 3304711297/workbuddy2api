/**
 * 调试页：请求快照查看、一键重放与 curl 导出（纯逻辑）。
 *
 * 契约（与旧 debug.js 一致）：
 *  - 请求序号防竞态：清空快照后立即刷新，但清空前已在途的旧调用晚到，
 *    不得把已删除的行重新渲染出来；
 *  - 重放前二次确认（会真实消耗上游额度）；
 *  - 重放走 snapshot_replay({ id, port, apiKey })，端口与密钥读自磁盘设置，
 *    读不到用 state.port/空串继续；
 *  - curl 导出密钥位固定为占位符（不把真实密钥写进剪贴板命令）。
 */

import {
  snapshotsList,
  snapshotReplay,
  snapshotsClear,
  getAppSettings,
  type SnapshotItem,
  type SnapshotReplayResult,
} from './tauri';

export const SNAPSHOTS_LIMIT = 100;

export function formatSnapshotTime(ts: unknown): string {
  try {
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return '—';
  }
}

/** 快照详情 JSON（req/resp/error/replay 标记）。 */
export function snapshotDetailJson(s: SnapshotItem): string {
  return JSON.stringify(
    { req: s.req, resp: s.resp ?? null, error: s.error ?? null, replay: !!s.replay },
    null,
    2,
  );
}

/**
 * 构建 curl 导出命令（纯函数，可单测）。
 * 密钥位固定占位符 `<redacted>`，body 内单引号做 shell 转义。
 */
export function buildSnapshotCurl(s: SnapshotItem, port: number): string {
  const body = JSON.stringify(s.req ?? {}).replace(/'/g, "'\\''");
  return (
    `curl -s -X POST http://127.0.0.1:${port}${s.endpoint || ''} ` +
    `-H 'Content-Type: application/json' -H 'Authorization: Bearer <redacted>' -d '${body}'`
  );
}

export interface DebugLoader {
  load: () => Promise<{ snapshots: SnapshotItem[]; total: number } | null>;
  invalidate: () => void;
}

export function createDebugLoader(): DebugLoader {
  let seq = 0;
  return {
    invalidate: () => {
      seq++;
    },
    load: async () => {
      const cur = ++seq;
      const data = await snapshotsList(SNAPSHOTS_LIMIT);
      if (cur !== seq) return null;
      const snapshots = data.snapshots ?? [];
      return { snapshots, total: data.total ?? snapshots.length };
    },
  };
}

export interface ReplayPortAndKey {
  port: number;
  apiKey: string;
}

/** 读磁盘设置拿端口与密钥；读不到用 fallbackPort/空串继续。 */
export async function resolveReplayTarget(fallbackPort: number): Promise<ReplayPortAndKey> {
  let port = fallbackPort;
  let apiKey = '';
  try {
    const cfg = await getAppSettings();
    if (cfg) {
      if (cfg.port) port = cfg.port;
      if (typeof cfg.api_key === 'string') apiKey = cfg.api_key;
    }
  } catch {
    /* 读不到设置则用默认值继续 */
  }
  return { port, apiKey };
}

/** 重放快照（snapshot_replay 的 id/port/apiKey 契约，apiKey 走 camelCase）。 */
export async function replaySnapshot(
  id: string,
  target: ReplayPortAndKey,
): Promise<SnapshotReplayResult> {
  return snapshotReplay(id, target.port, target.apiKey);
}

export async function clearAllSnapshots(): Promise<void> {
  await snapshotsClear();
}
