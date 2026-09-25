/**
 * 主题控制器（无框架依赖，与 EasyCLIProxyAPI 的 themeController.ts 对齐）。
 *
 * 职责：
 *  - 从 localStorage（兼容旧键）读取用户偏好，默认深色（与旧版一致）；
 *  - 解析为 light/dark 后写到 document.documentElement.dataset.theme；
 *  - 同步 Tauri 原生窗口底色，避免窗口边框与内容区色差；
 *  - 监听 system 变化与跨实例存储变化。
 */

import {
  THEME_LEGACY_STORAGE_KEY,
  THEME_STORAGE_KEY,
  isTheme,
  type Theme,
} from './theme';

const DEFAULT_THEME: Theme = 'dark';

type Listener = (theme: Theme, resolved: 'light' | 'dark') => void;

const listeners = new Set<Listener>();
let mediaQuery: MediaQueryList | null = null;

/** 读取存储的主题偏好（无效值 → 默认深色）。 */
export function getStoredTheme(): Theme {
  try {
    const raw =
      window.localStorage.getItem(THEME_STORAGE_KEY) ??
      window.localStorage.getItem(THEME_LEGACY_STORAGE_KEY);
    if (isTheme(raw)) return raw;
  } catch {
    /* 存储不可用时走默认 */
  }
  return DEFAULT_THEME;
}

/** 把偏好解析为实际生效的 light/dark。 */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  try {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** 同步 Tauri 原生窗口底色（与 CSS --bg-app 对齐），失败静默。 */
async function syncNativeWindowBackground(resolved: 'light' | 'dark'): Promise<void> {
  try {
    if (!('__TAURI__' in window)) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setBackgroundColor(resolved === 'light' ? '#f4f6f8' : '#0b0d11');
  } catch {
    /* 非 Tauri 或 API 不可用时忽略 */
  }
}

/** 应用主题：写 data-theme、存偏好、同步原生窗口、通知订阅者。 */
export function applyTheme(theme: Theme): 'light' | 'dark' {
  const resolved = resolveTheme(theme);
  try {
    document.documentElement.dataset.theme = resolved;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* 存储不可用时保持内存态 */
  }
  void syncNativeWindowBackground(resolved);
  for (const fn of listeners) {
    try {
      fn(theme, resolved);
    } catch {
      /* 订阅者异常不影响主题应用 */
    }
  }
  return resolved;
}

/** 订阅主题变化，返回取消订阅函数。 */
export function onThemeChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 初始化主题（应用启动时调用一次）：
 *  - 绑定 system 媒体查询（偏好为 system 时跟随变化）；
 *  - 绑定跨标签页存储同步；
 *  - 首屏 data-theme 已由 public/theme-preset.js 预置，此处只补齐原生窗口底色与订阅。
 */
export function initializeTheme(): { theme: Theme; resolved: 'light' | 'dark' } {
  try {
    mediaQuery = window.matchMedia?.('(prefers-color-scheme: light)') ?? null;
    mediaQuery?.addEventListener?.('change', () => {
      const current = getStoredTheme();
      if (current === 'system') applyTheme('system');
    });
    window.addEventListener('storage', (event) => {
      if (event.key === THEME_STORAGE_KEY || event.key === THEME_LEGACY_STORAGE_KEY) {
        applyTheme(getStoredTheme());
      }
    });
  } catch {
    /* 监听注册失败不影响初始应用 */
  }
  const theme = getStoredTheme();
  const resolved = resolveTheme(theme);
  void syncNativeWindowBackground(resolved);
  return { theme, resolved };
}

/** 循环切换主题（light → dark → system → light），供设置页快捷按钮使用。 */
export function cycleTheme(current: Theme): Theme {
  if (current === 'light') return 'dark';
  if (current === 'dark') return 'system';
  return 'light';
}
