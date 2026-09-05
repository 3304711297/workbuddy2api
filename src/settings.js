/**
 * 设置页面逻辑 + 明暗双主题模块
 */

import { state } from './state.js';
import { showToast, invokeTauri } from './utils.js';
import { checkHealth } from './service.js';

// ---------------------------------------------------------------------------
// 明暗双主题（对标上游 theme.ts 模式）
// 初始化顺序：localStorage 持久化值 → 否则系统 prefers-color-scheme（默认深色）
// index.html <head> 内联脚本已在 DOM 渲染前设置 dataset.theme 防闪烁，
// 此处负责读取当前值、同步按钮选中态，并把原生窗口底色与主题对齐。
// ---------------------------------------------------------------------------
const THEME_STORAGE_KEY = 'codebuddy2openai.theme';

// 各主题对应的原生窗口底色（与 CSS --bg-app 保持一致，防原生窗口闪白/闪黑）
const THEME_NATIVE_BG = {
  dark: { red: 13, green: 15, blue: 18, alpha: 255 },     // #0d0f12
  light: { red: 246, green: 247, blue: 245, alpha: 255 }  // #f6f7f5
};

// 同步原生窗口底色；非 Tauri 环境或 API 缺失时静默失败，绝不影响页面
function syncNativeWindowBackground(theme) {
  try {
    const color = THEME_NATIVE_BG[theme] || THEME_NATIVE_BG.dark;
    const current = window.__TAURI__?.window?.getCurrent?.();
    const result = current?.setBackgroundColor?.(color);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch (e) {
    // 静默失败：主题切换不依赖原生窗口底色同步
  }
}

// 应用主题：设置 html[data-theme]、同步切换按钮选中态，persist 为 true 时持久化
function applyTheme(theme, persist = false) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  document.getElementById('btn-theme-light')?.classList.toggle('active', t === 'light');
  document.getElementById('btn-theme-dark')?.classList.toggle('active', t === 'dark');
  syncNativeWindowBackground(t);
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, t); } catch (e) { /* 存储不可用时忽略 */ }
  }
}

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_STORAGE_KEY); } catch (e) { /* 忽略 */ }
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)')?.matches;
  const initial = (saved === 'light' || saved === 'dark') ? saved : (prefersLight ? 'light' : 'dark');
  applyTheme(initial, false); // 初始不写入 localStorage，保留“跟随系统”语义

  document.getElementById('btn-theme-light')?.addEventListener('click', () => applyTheme('light', true));
  document.getElementById('btn-theme-dark')?.addEventListener('click', () => applyTheme('dark', true));
}

// ---------------------------------------------------------------------------
// 设置页面逻辑
// ---------------------------------------------------------------------------
export function initSettings() {
  const inputPort = document.getElementById('input-port');
  const btnSave = document.getElementById('btn-save-port');
  const chkDesensitize = document.getElementById('chk-desensitize');
  const chkDebugConsole = document.getElementById('chk-debug-console');
  const chkAutoStart = document.getElementById('chk-auto-start');
  const btnOpenLiveConsole = document.getElementById('btn-open-live-console');
  const radioCloseActions = document.querySelectorAll('input[name="close-action"]');

  // 用户是否已手动改动（防止异步加载的持久化配置覆盖用户正在编辑的值）
  let portTouched = false;
  let desensitizeTouched = false;
  // 最近一次持久化到后端的端口值（用于保存时判断端口是否变化）
  let savedPort = state.port;

  // 端口 → 内存 state 与看板/侧边栏/端点联动展示
  const applyPortToUi = (val) => {
    state.port = val;
    const dashPort = document.getElementById('dash-port');
    if (dashPort) dashPort.textContent = String(val);
    const sideBadge = document.getElementById('side-port-badge');
    if (sideBadge) sideBadge.textContent = `:${val}`;
    const endpoint = document.getElementById('endpoint-url');
    if (endpoint) endpoint.value = `http://127.0.0.1:${val}/v1`;
  };

  // 脱敏开关 → 内存 state 与看板联动展示
  const applyDesensitizeToUi = (val) => {
    state.desensitize = val;
    const txt = document.getElementById('dash-desensitize');
    if (txt) {
      txt.textContent = val ? '已启用' : '已禁用';
      txt.className = val ? 'metric-value text-success' : 'metric-value muted';
    }
  };

  // 统一构造完整设置对象（契约：save_app_settings 接收含 port/desensitize 的完整对象）
  const buildSettingsPayload = () => {
    const currentClose = Array.from(radioCloseActions).find(r => r.checked)?.value || 'hide_to_tray';
    return {
      close_action: currentClose,
      auto_start_proxy: chkAutoStart ? chkAutoStart.checked : false,
      show_debug_console: chkDebugConsole ? chkDebugConsole.checked : false,
      port: state.port,
      desensitize: state.desensitize
    };
  };

  const persistSettings = async () => {
    try {
      await invokeTauri('save_app_settings', { settings: buildSettingsPayload() });
      return true;
    } catch (err) {
      showToast(`保存设置失败: ${err.message || err}`, 'error');
      return false;
    }
  };

  // 用户手动改动追踪（先于异步配置加载绑定）
  inputPort?.addEventListener('input', () => { portTouched = true; });
  chkDesensitize?.addEventListener('change', () => { desensitizeTouched = true; });

  chkDebugConsole?.addEventListener('change', async (e) => {
    if (await persistSettings()) {
      showToast(e.target.checked ? '已启用：启动服务时显示外部 CMD 调试窗口' : '已恢复默认：静默后台启动（无黑框）', 'success');
    }
  });

  chkAutoStart?.addEventListener('change', async (e) => {
    if (await persistSettings()) {
      showToast(e.target.checked ? '已启用：下次打开应用自动拉起反代服务' : '已关闭：反代服务需手动启动', 'success');
    }
  });

  radioCloseActions.forEach(r => {
    r.addEventListener('change', async () => {
      if (r.checked) {
        if (await persistSettings()) {
          showToast(r.value === 'hide_to_tray' ? '已设置为：关闭窗口时最小化到系统托盘' : '已设置为：关闭窗口时停止服务并退出', 'success');
        }
      }
    });
  });

  btnSave?.addEventListener('click', async () => {
    const val = parseInt(inputPort.value, 10);
    if (val >= 1024 && val <= 65535) {
      const portChanged = val !== savedPort;
      applyPortToUi(val);
      if (await persistSettings()) {
        savedPort = val;
        // 服务运行中且端口有变化时不自动重启，仅提示用户手动重启生效
        if (state.running && portChanged) {
          showToast('端口已保存，重启服务后生效', 'info');
        } else {
          showToast(`端口已保存为 ${val}，请重启服务生效`, 'info');
        }
      }
    } else {
      showToast('端口范围必须在 1024-65535 之间', 'error');
    }
  });

  chkDesensitize?.addEventListener('change', async (e) => {
    applyDesensitizeToUi(e.target.checked);
    if (await persistSettings()) {
      showToast('脱敏设置已保存', 'success');
    }
  });

  // 读取后端配置（放最后：先绑定监听，异步返回后不覆盖用户已手动改动的值）
  (async () => {
    try {
      const cfg = await invokeTauri('get_app_settings');
      if (cfg) {
        if (cfg.close_action) {
          radioCloseActions.forEach(r => {
            r.checked = (r.value === cfg.close_action);
          });
        }
        if (chkDebugConsole) {
          chkDebugConsole.checked = Boolean(cfg.show_debug_console);
        }
        // 契约新增字段：port / desensitize（缺失或非法时保持前端默认值）
        const cfgPort = Number(cfg.port);
        if (Number.isFinite(cfgPort) && cfgPort >= 1024 && cfgPort <= 65535) {
          savedPort = cfgPort;
          if (!portTouched) {
            if (inputPort) inputPort.value = String(cfgPort);
            applyPortToUi(cfgPort);
          }
        }
        if (typeof cfg.desensitize === 'boolean' && !desensitizeTouched) {
          if (chkDesensitize) chkDesensitize.checked = cfg.desensitize;
          applyDesensitizeToUi(cfg.desensitize);
        }
        if (chkAutoStart) {
          chkAutoStart.checked = Boolean(cfg.auto_start_proxy);
        }
        // 自动拉起：应用启动时按持久化设置执行一次（托盘隐藏重开不触发——前端只加载一次；
        // proxy_start 本身幂等，与首次 checkHealth 的竞态由 800ms 延迟 + state.running 守卫兜底）
        if (cfg.auto_start_proxy && window.__TAURI__) {
          setTimeout(async () => {
            if (state.running) return;
            try {
              await invokeTauri('proxy_start', { port: state.port, desensitize: state.desensitize });
              showToast(`已按设置自动拉起反代服务（:${state.port}）`, 'success');
              setTimeout(checkHealth, 600);
            } catch (e) {
              console.warn('自动拉起反代失败:', e);
            }
          }, 800);
        }
      }
    } catch (e) {
      console.warn('获取设置失败:', e);
    }
  })();
}
