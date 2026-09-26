/**
 * 外链打开（纯函数 + Tauri shell.open 封装）。
 * 只允许 http:/https:，其余一律拒绝（防 file:/javascript: 注入）。
 */

import { open } from '@tauri-apps/plugin-shell';
import { isTauriRuntime } from './tauri';

/** 校验 URL 是否为允许外开的 http(s) 链接。 */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * 在系统浏览器打开外链。非法协议抛错；非 Tauri 环境回退 window.open。
 * 统一带 noopener,noreferrer。
 */
export async function openExternal(raw: string): Promise<void> {
  if (!isAllowedExternalUrl(raw)) {
    throw new Error(`拒绝打开非 http(s) 链接: ${raw}`);
  }
  if (isTauriRuntime()) {
    await open(raw);
    return;
  }
  window.open(raw, '_blank', 'noopener,noreferrer');
}
