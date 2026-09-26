/**
 * 主题类型与存储键（与 EasyCLIProxyAPI 的 theme.ts 对齐）。
 *
 * - 存储键 `workbuddy2api.theme`，兼容旧键 `codebuddy2openai.theme`（只读回退）；
 * - 三态：light | dark | system（system = 跟随操作系统）。
 */

export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'workbuddy2api.theme';
export const THEME_LEGACY_STORAGE_KEY = 'codebuddy2openai.theme';

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark' || value === 'system';
}
