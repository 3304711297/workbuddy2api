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
const THEME_STORAGE_KEY = 'workbuddy2api.theme';
const LEGACY_THEME_STORAGE_KEY = 'codebuddy2openai.theme';

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
  try { saved = localStorage.getItem(THEME_STORAGE_KEY) || localStorage.getItem(LEGACY_THEME_STORAGE_KEY); } catch (e) { /* 忽略 */ }
  const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)')?.matches;
  const initial = (saved === 'light' || saved === 'dark') ? saved : (prefersLight ? 'light' : 'dark');
  applyTheme(initial, false); // 初始不写入 localStorage，保留“跟随系统”语义

  document.getElementById('btn-theme-light')?.addEventListener('click', () => applyTheme('light', true));
  document.getElementById('btn-theme-dark')?.addEventListener('click', () => applyTheme('dark', true));
}

// ---------------------------------------------------------------------------
// 设置页面逻辑
// ---------------------------------------------------------------------------
// 模型清单模式的「客户端侧」说明：本开关只影响内核向客户端暴露的清单，
// 管不到客户端自己写死的模型表 —— 这是真实踩到过的困惑点（已选「仅展示可用」
// 但 Hermes 里仍有需授权模型）。提示随当前选择变化，避免用户在错误的开关上找原因。
const MODEL_LIST_MODE_NOTES = {
  available: '注意：此开关只改变内核对外提供的清单。Hermes 等客户端若在其端点配置里关闭了「Discover models」（即 discover_models: false），会改用其配置文件里写死的模型列表，此时本开关不生效 —— 需在客户端打开「Discover models」让它实时读取本清单（改后需重启客户端）。',
  all: '提示：选「全部展示」时需授权模型会带 🔒 标记一并下发，供客户端自行选择是否隐藏。',
};

function renderModelListModeNote(mode) {
  const el = document.getElementById('model-list-mode-client-note');
  if (!el) return; // DOM 缺失不得硬崩（与本文件其它处同约定）
  el.textContent = MODEL_LIST_MODE_NOTES[mode] || MODEL_LIST_MODE_NOTES.all;
}

export function initSettings() {
  const inputPort = document.getElementById('input-port');
  const btnSave = document.getElementById('btn-save-port');
  const chkDesensitize = document.getElementById('chk-desensitize');
  const chkDebugConsole = document.getElementById('chk-debug-console');
  const chkAutoStart = document.getElementById('chk-auto-start');
  // 注：#btn-open-live-console（原「一键跳转实时日志」按钮）已从 index.html 移除，
  // 此处原先的 getElementById 死引用一并删除；若日后补回该按钮，再在此绑定 addEventListener
  const radioCloseActions = document.querySelectorAll('input[name="close-action"]');
  const selectModelListMode = document.getElementById('select-model-list-mode');

  // 用户是否已手动改动（防止异步加载的持久化配置覆盖用户正在编辑的值）
  let portTouched = false;
  let desensitizeTouched = false;
  // 最近一次持久化到后端的端口值（用于保存时判断端口是否变化）
  let savedPort = state.port;

  // 硬编码示例联动：index.html 把 127.0.0.1:8787 写死在模板文本里——接入示例代码块
  // （#code-claude / #code-python，也是「复制」按钮的复制源）与 Agent 卡片里的
  // 「兼容端点」文案。改端口后用户复制到的命令仍连旧端口，连不上。
  // 采用「host:port 整体替换」而非「写死 8787 → 新端口」：幂等（重复调用结果一致）、
  // 不依赖调用顺序（首屏回读配置时同样走 applyPortToUi），且旧值不是 8787 时也能纠正。
  // 元素缺失（index.html 结构变动）时直接跳过，绝不因可选元素抛错。
  const PORT_TEXT_RE = /127\.0\.0\.1:\d{2,5}/g;
  const applyPortToStaticExamples = (val) => {
    const targets = [
      document.getElementById('code-claude'),
      document.getElementById('code-python'),
      ...document.querySelectorAll('.agent-path-text .mono'),
    ];
    for (const el of targets) {
      // 只改含「127.0.0.1:端口」字样的元素（如「路径: —」等其它 .mono 保持原样）
      if (!el || !String(el.textContent || '').includes('127.0.0.1:')) continue;
      el.textContent = String(el.textContent).replace(PORT_TEXT_RE, `127.0.0.1:${val}`);
    }
  };

  // 端口 → 内存 state 与看板/侧边栏/端点联动展示
  const applyPortToUi = (val) => {
    state.port = val;
    const dashPort = document.getElementById('dash-port');
    if (dashPort) dashPort.textContent = String(val);
    const sideBadge = document.getElementById('side-port-badge');
    if (sideBadge) sideBadge.textContent = `:${val}`;
    const endpoint = document.getElementById('endpoint-url');
    if (endpoint) endpoint.value = `http://127.0.0.1:${val}/v1`;
    // 硬编码示例（接入代码块 / 兼容端点文案）同步改写，避免复制到旧端口
    applyPortToStaticExamples(val);
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
  // ⚠️ 后端 save_app_settings 是「整对象覆盖写盘」，payload 缺字段会被 serde default 抹回默认值。
  // 因此任何新增的 AppConfig 字段都必须在此显式带上，否则用户改动会被静默回滚。
  // rotate_mode / rotate_count 由「账号与资产」页的调度策略卡负责写入，这里只做透传保留。
  //
  // dirty merge 模型（2026-09-12 评审修复）：persistSettings(patch) 的 patch 声明「本次
  // 明确修改的字段」，在最终 payload 中最后展开（优先级最高）；磁盘真源只用于回填
  // 「本次未修改」的字段。修复前 persistSettings 会把磁盘旧值无条件回灌 cache，
  // 导致 LAN 开关 / log_level / log_payloads / model_list_mode 首次修改保存不生效、
  // 「清空密钥」永远清不掉（空输入恰好满足回灌条件把旧 key 读回来）。
  let rotateModeCache = 'off';
  let rotateCountCache = 1;
  let modelListModeCache = 'all';
  let apiKeyCache = '';
  let logLevelCache = 'info';
  let logPayloadsCache = false;
  let listenHostCache = '127.0.0.1';
  let snapshotsCache = true;
  let snapshotsKeepCache = 200;
  const buildSettingsPayload = (patch = {}) => {
    const currentClose = Array.from(radioCloseActions).find(r => r.checked)?.value || 'hide_to_tray';
    return {
      close_action: currentClose,
      auto_start_proxy: chkAutoStart ? chkAutoStart.checked : false,
      show_debug_console: chkDebugConsole ? chkDebugConsole.checked : false,
      port: state.port,
      desensitize: state.desensitize,
      rotate_mode: rotateModeCache,
      rotate_count: rotateCountCache,
      model_list_mode: modelListModeCache,
      // 客户端鉴权密钥：留空即不鉴权；每次保存都带上，避免被整对象覆盖写盘抹除
      api_key: apiKeyCache,
      log_level: logLevelCache,
      log_payloads: logPayloadsCache,
      listen_host: listenHostCache,
      snapshots: snapshotsCache,
      snapshots_keep: snapshotsKeepCache,
      // dirty 字段最后展开：显式声明的「本次修改」优先于磁盘回填与 cache
      ...patch
    };
  };

  const persistSettings = async (patch = {}) => {
    try {
      // 写盘前先读一次磁盘真源：只回填「本次未修改」的字段（dirty 字段绝不回灌，
      // 否则用户刚改的值会被磁盘旧值覆盖——清空密钥 / LAN 开关曾因此失效）
      try {
        const latest = await invokeTauri('get_app_settings');
        if (latest) {
          if (!('rotate_mode' in patch) && latest.rotate_mode) rotateModeCache = latest.rotate_mode;
          if (!('rotate_count' in patch) && latest.rotate_count) rotateCountCache = latest.rotate_count;
          if (!('model_list_mode' in patch) && latest.model_list_mode) modelListModeCache = latest.model_list_mode;
          if (!('log_level' in patch) && latest.log_level) logLevelCache = latest.log_level;
          if (!('log_payloads' in patch) && typeof latest.log_payloads === 'boolean') logPayloadsCache = latest.log_payloads;
          if (!('listen_host' in patch) && latest.listen_host) listenHostCache = latest.listen_host;
          if (!('snapshots' in patch) && typeof latest.snapshots === 'boolean') snapshotsCache = latest.snapshots;
          if (!('snapshots_keep' in patch) && Number.isInteger(latest.snapshots_keep) && latest.snapshots_keep > 0) {
            snapshotsKeepCache = latest.snapshots_keep;
          }
          // 密钥：本次未修改且输入框为空时才回退磁盘值（用户可能刚改完就点保存）
          const apiKeyEl = document.getElementById('input-api-key');
          if (!('api_key' in patch) && apiKeyEl && !apiKeyEl.value.trim() && typeof latest.api_key === 'string') {
            apiKeyCache = latest.api_key;
          }
        }
      } catch (readErr) {
        // 读盘失败必须中止本次保存：dirty-merge 依赖磁盘真源回填「本次未修改」的字段，
        // 读不到就只剩内存 cache —— 其中 api_key 等字段可能是陈旧值，带着它写盘等于把
        // 旧密钥落回磁盘（用户以为改了，实际没改）。宁可让用户重试，也不静默写旧数据。
        console.warn('读取磁盘设置失败，已中止本次保存:', readErr);
        showToast('读取磁盘设置失败，本次保存已中止（未写入任何改动），请稍后重试', 'error');
        return false;
      }
      await invokeTauri('save_app_settings', { settings: buildSettingsPayload(patch) });
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

  // 模型清单模式：热读生效（内核每请求读 settings.json），保存后无需重启
  selectModelListMode?.addEventListener('change', async (e) => {
    const v = e.target.value === 'available' ? 'available' : 'all';
    modelListModeCache = v;
    renderModelListModeNote(v);
    if (await persistSettings({ model_list_mode: v })) {
      showToast(v === 'available' ? '已切换为仅展示可用模型（Hermes 等客户端刷新模型列表后生效）' : '已切换为全量展示（含需授权模型标记）', 'success');
    }
  });

  // —— 客户端鉴权密钥（对标 EasyCLIProxyAPI ApiAccessPage） ——
  const inputApiKey = document.getElementById('input-api-key');

  // 生成 32 位十六进制随机密钥：必须用 CSPRNG（crypto.getRandomValues），
  // Math.random() 可预测，绝不能用于凭据生成。
  const genApiKey = () => {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  document.getElementById('btn-gen-api-key')?.addEventListener('click', async () => {
    const key = genApiKey();
    if (inputApiKey) inputApiKey.value = key;
    apiKeyCache = key;
    if (await persistSettings({ api_key: key })) {
      showToast(state.running ? '已生成并保存新密钥，重启内核后生效' : '已生成并保存新密钥', 'success');
    }
  });

  document.getElementById('btn-copy-api-key')?.addEventListener('click', async () => {
    const val = (inputApiKey?.value || '').trim();
    if (!val) {
      showToast('当前未设置密钥，无需复制', 'info');
      return;
    }
    try {
      await navigator.clipboard.writeText(val);
      showToast('密钥已复制到剪贴板', 'success');
    } catch (e) {
      showToast('复制失败，请手动选择文本复制', 'error');
    }
  });

  document.getElementById('btn-clear-api-key')?.addEventListener('click', async () => {
    if (inputApiKey) inputApiKey.value = '';
    apiKeyCache = '';
    // 显式声明空值：此前空输入会满足磁盘回灌条件把旧 key 读回来，清空永远不生效
    if (await persistSettings({ api_key: '' })) {
      showToast(
        state.running
          ? '已清空密钥并保存，重启内核后恢复为不鉴权（仅建议回环监听时使用）'
          : '已清空密钥（不鉴权，仅建议回环监听时使用）',
        'info'
      );
    }
  });

  // 手动编辑：只更新缓存，由用户点击「保存设置」链路之外的交互触发（失焦/回车即保存）
  inputApiKey?.addEventListener('change', async () => {
    apiKeyCache = (inputApiKey.value || '').trim();
    if (await persistSettings({ api_key: (inputApiKey.value || '').trim() })) {
      showToast(state.running ? '密钥已保存，重启内核后生效' : '密钥已保存', 'success');
    }
  });

  // —— 结构化日志级别（对标 EasyCLIProxyAPI 日志管理） ——
  const selectLogLevel = document.getElementById('select-log-level');
  const chkLogPayloads = document.getElementById('chk-log-payloads');

  selectLogLevel?.addEventListener('change', async (e) => {
    const v = ['info', 'debug', 'trace'].includes(e.target.value) ? e.target.value : 'info';
    logLevelCache = v;
    if (await persistSettings({ log_level: v })) {
      showToast(`日志级别已设为 ${v}${state.running ? '，重启内核后生效' : ''}`, 'success');
    }
  });

  chkLogPayloads?.addEventListener('change', async (e) => {
    logPayloadsCache = !!e.target.checked;
    if (await persistSettings({ log_payloads: logPayloadsCache })) {
      if (logPayloadsCache) {
        // 明确警示：正文将以明文落盘
        showToast(
          `已开启正文落盘${state.running ? '（重启内核后生效）' : ''}：Prompt 与响应将以明文写入日志，排查完请及时关闭`,
          'info'
        );
      } else {
        showToast('已关闭正文落盘', 'success');
      }
    }
  });

  // —— 请求快照（调试 Tab 数据源） ——
  const chkSnapshots = document.getElementById('chk-snapshots');
  const inputSnapshotsKeep = document.getElementById('input-snapshots-keep');

  chkSnapshots?.addEventListener('change', async (e) => {
    snapshotsCache = !!e.target.checked;
    if (await persistSettings({ snapshots: snapshotsCache })) {
      showToast(
        snapshotsCache
          ? `已开启请求快照${state.running ? '（重启内核后生效）' : ''}：请求体将明文落盘，供调试 Tab 回放排查`
          : '已关闭请求快照（调试 Tab 将无新数据）',
        snapshotsCache ? 'info' : 'success'
      );
    }
  });

  inputSnapshotsKeep?.addEventListener('change', async (e) => {
    const v = Math.max(10, Math.min(2000, parseInt(e.target.value, 10) || 200));
    e.target.value = String(v);
    snapshotsKeepCache = v;
    if (await persistSettings({ snapshots_keep: snapshotsKeepCache })) {
      showToast(`快照保留条数已设为 ${v}${state.running ? '（重启内核后生效）' : ''}`, 'success');
    }
  });

  // —— 局域网访问（对标 EasyCLIProxyAPI 的 get_lan_ipv4） ——
  const chkLanAccess = document.getElementById('chk-lan-access');
  const lanAddressRow = document.getElementById('lan-address');
  const lanAddressValue = document.getElementById('lan-address-value');

  // 展示/隐藏局域网地址行，并填入探测到的 IPv4
  const syncLanAddressRow = async (enabled) => {
    if (!lanAddressRow) return;
    lanAddressRow.style.display = enabled ? '' : 'none';
    if (!enabled || !lanAddressValue) return;
    try {
      const ip = await invokeTauri('lan_ipv4');
      lanAddressValue.textContent = ip ? `http://${ip}:${state.port}/v1` : '未能探测到局域网地址（请检查网络连接）';
    } catch (e) {
      lanAddressValue.textContent = '探测失败';
    }
  };

  chkLanAccess?.addEventListener('change', async (e) => {
    const wantEnable = !!e.target.checked;
    if (wantEnable && !apiKeyCache.trim()) {
      // 无密钥则内核会拒绝启动——提前拦截并引导，而不是让用户看到「内核启动后立刻退出」
      e.target.checked = false;
      listenHostCache = '127.0.0.1';
      showToast('请先在上方「客户端鉴权密钥」处生成并保存密钥，再开启局域网访问（无密钥暴露风险过高）', 'error');
      await syncLanAddressRow(false);
      return;
    }
    listenHostCache = wantEnable ? '0.0.0.0' : '127.0.0.1';
    await syncLanAddressRow(wantEnable);
    if (await persistSettings({ listen_host: listenHostCache })) {
      showToast(
        wantEnable
          ? `已允许局域网访问${state.running ? '，重启内核后生效' : ''}：请确保密钥已同步到各客户端`
          : '已恢复仅本机访问（127.0.0.1）',
        wantEnable ? 'info' : 'success'
      );
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
        // 模型清单模式回读：normalize 非法值
        if (selectModelListMode) {
          selectModelListMode.value = cfg.model_list_mode === 'available' ? 'available' : 'all';
          modelListModeCache = selectModelListMode.value;
          renderModelListModeNote(modelListModeCache);
        }
        // 客户端鉴权密钥回读：null/undefined 都归一到空串
        if (inputApiKey) {
          apiKeyCache = typeof cfg.api_key === 'string' ? cfg.api_key : '';
          inputApiKey.value = apiKeyCache;
        }
        // 日志级别 / 正文落盘回读：非法值归一到默认
        if (selectLogLevel) {
          const lv = ['info', 'debug', 'trace'].includes(cfg.log_level) ? cfg.log_level : 'info';
          selectLogLevel.value = lv;
          logLevelCache = lv;
        }
        if (chkLogPayloads) {
          logPayloadsCache = !!cfg.log_payloads;
          chkLogPayloads.checked = logPayloadsCache;
        }
        if (chkSnapshots) {
          snapshotsCache = typeof cfg.snapshots === 'boolean' ? cfg.snapshots : true;
          chkSnapshots.checked = snapshotsCache;
        }
        if (inputSnapshotsKeep) {
          const keep = Number.isInteger(cfg.snapshots_keep) && cfg.snapshots_keep > 0 ? cfg.snapshots_keep : 200;
          snapshotsKeepCache = keep;
          inputSnapshotsKeep.value = String(keep);
        }
        // 监听地址回读：仅 0.0.0.0 视为开启局域网，其余归一回环
        const lanEnabled = cfg.listen_host === '0.0.0.0';
        listenHostCache = lanEnabled ? '0.0.0.0' : '127.0.0.1';
        if (chkLanAccess) chkLanAccess.checked = lanEnabled;
        syncLanAddressRow(lanEnabled);
        // 自动拉起：应用启动时按持久化设置执行一次（托盘隐藏重开不触发——前端只加载一次；
        // proxy_start 本身幂等，与首次 checkHealth 的竞态由 800ms 延迟 + state.running 守卫兜底）
        if (cfg.auto_start_proxy && window.__TAURI__) {
          setTimeout(async () => {
            if (state.running) return;
            try {
              const res = await invokeTauri('proxy_start', { port: state.port, desensitize: state.desensitize });
              // 竞态：首跳 checkHealth 可能晚于本 800ms 窗口，state.running 尚未回填时后端
              // 走幂等分支返回 already-running(port N)（proxy.rs）。此时本次调用实际没做任何
              // 事，必须换文案，不能谎报「已自动拉起」。
              if (String(res ?? '').includes('already-running')) {
                showToast(`反代服务已在运行（:${state.port}），未重复拉起`, 'info');
              } else {
                showToast(`已按设置自动拉起反代服务（:${state.port}）`, 'success');
              }
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
