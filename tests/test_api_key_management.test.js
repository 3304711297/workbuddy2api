/**
 * 客户端 API Key 管理契约测试（React+TS 迁移版；第四轮：对标 EasyCLIProxyAPI 的 ApiAccessPage）
 *
 * 背景：内核早已支持 `--api-key`（非回环监听时强制要求携带），
 * 但 GUI 完全没有入口——用户无法在界面启用/查看/轮换鉴权密钥。
 * 本测试锁定：
 *   A. 内核能力前置事实（--api-key / --unsafe-expose 参数存在）
 *   B. Rust 侧 AppConfig 承载 api_key + 启动时透传（含空值不下发）
 *   C. 启动参数装配：非空才追加 --api-key，避免空串反而开启校验
 *   D. 前端设置页提供密钥管理 UI（生成/复制/清空）
 *
 * 契约变更说明（中文）：
 *   旧前端断言目标是 index.html 的 input-api-key / btn-gen-api-key /
 *   btn-clear-api-key id 与 src/settings.js。React 迁移后无元素 id 绑定：
 *   SettingsPage.tsx 用 id="settings-input-api-key" 输入框 +
 *   t('settings.apiKeyGen')（生成）/ t('settings.apiKeyCopy')（复制）/
 *   t('settings.apiKeyClear')（清空）按钮；密钥生成走
 *   settingsService.generateApiKey（crypto.getRandomValues）。
 *   安全硬约束保持：API Key 只在内存（本页表单 state + 全局 useApp），
 *   绝不进 localStorage、绝不出现在日志/toast 文案中；生成必须用 CSPRNG。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS = (p) => readFileSync(join(ROOT, p), 'utf8');

const CONVERTER = JS('converter.py');
const PROXY_RS = JS('src-tauri/src/commands/proxy.rs');
const LIB_RS = JS('src-tauri/src/lib.rs');
const SETTINGS_TSX = JS('src/pages/SettingsPage.tsx');
const SETTINGS_SERVICE = JS('src/services/settingsService.ts');
const SERVICE_PROVIDER = JS('src/state/ServiceProvider.tsx');
const I18N = JS('src/i18n/zh-CN.ts');

/**
 * 剥离注释（字符串感知：跳过 '...' / "..." / `...` 字面量，避免
 * 把字符串里的 // 当成注释起点而误判；见仓库 AGENTS.md 第 2 节）。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // 字符串 / 模板字面量：原样保留
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        const d = src[i];
        out += d;
        i++;
        if (d === '\\') { out += src[i] ?? ''; i++; }
        else if (d === q) break;
      }
      continue;
    }
    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // 行注释
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

test('A 前置事实：内核支持 --api-key 与 --unsafe-expose（非回环强制鉴权）', () => {
  assert.ok(
    CONVERTER.includes('"--api-key"'),
    'converter.py 未定义 --api-key 参数'
  );
  assert.ok(
    CONVERTER.includes('"--unsafe-expose"'),
    'converter.py 未定义 --unsafe-expose 参数（非回环无鉴权需显式确认）'
  );
  // 内核确实会校验（_check_auth）
  assert.ok(
    CONVERTER.includes('def _check_auth('),
    'converter.py 缺少 _check_auth 校验函数'
  );
});

test('B Rust AppConfig 承载 api_key 字段（serde default 兼容旧配置）', () => {
  assert.ok(
    /pub api_key: String/.test(LIB_RS),
    'AppConfig 缺少 api_key 字段'
  );
  // serde 属性位于字段声明**之前**（Rust 语法）——须向前取窗口查找
  const idx = LIB_RS.indexOf('pub api_key: String');
  const before = LIB_RS.slice(Math.max(0, idx - 120), idx);
  assert.ok(
    before.includes('#[serde(default'),
    'api_key 需带 serde(default) 保证旧配置兼容（属性在声明之前）'
  );
});

test('C 启动参数装配：api_key 非空才追加 --api-key（空串不下发）', () => {
  assert.ok(
    PROXY_RS.includes('"--api-key"'),
    'proxy.rs 未透传 --api-key 给内核'
  );
  // 必须是条件追加，而非无条件 arg
  const block = PROXY_RS.match(/[\s\S]{0,400}"--api-key"[\s\S]{0,120}/)?.[0] || '';
  assert.ok(
    /if\s*!?\s*api_key\.is_empty\(\)|api_key\s*\.\s*is_empty\(\)\s*\{/.test(block) ||
      /if\s+!api_key\.is_empty\(\)/.test(PROXY_RS),
    '--api-key 必须仅在非空时追加：传空串会让内核开启校验却无有效密钥'
  );
});

test('D 前端设置页提供客户端鉴权密钥管理 UI（生成/复制/清空）', () => {
  // 输入框（React 版 id）
  assert.ok(
    SETTINGS_TSX.includes('id="settings-input-api-key"'),
    'SettingsPage.tsx 缺少 API Key 输入框（id="settings-input-api-key"）'
  );
  // 生成 / 复制 / 清空按钮（走 i18n 文案）
  for (const key of ['settings.apiKeyGen', 'settings.apiKeyCopy', 'settings.apiKeyClear']) {
    assert.ok(
      SETTINGS_TSX.includes(`t('${key}')`),
      `SettingsPage.tsx 缺少按钮 t('${key}')`
    );
  }
  assert.ok(
    /'settings\.apiKeyGen': '生成'/.test(I18N) && /'settings\.apiKeyClear': '清空'/.test(I18N),
    'i18n 缺少 生成/清空 按钮文案'
  );
  // 生成按钮接 generateApiKey，清空走二次确认
  assert.ok(SETTINGS_TSX.includes('onGenApiKey'), '缺少 onGenApiKey（生成）');
  assert.ok(SETTINGS_TSX.includes('onClearApiKey'), '缺少 onClearApiKey（清空）');
  assert.ok(SETTINGS_TSX.includes('generateApiKey()'), 'onGenApiKey 未调用 settingsService.generateApiKey');
});

test('D 前端逻辑：密钥读写接入 AppConfig 且提示需重启内核', () => {
  // 密钥变更走 patch { api_key } 落盘（dirty merge 语义，清空时显式声明空值防回灌）
  assert.ok(SETTINGS_TSX.includes('{ api_key: key }'), '生成密钥未声明 api_key patch');
  assert.ok(SETTINGS_TSX.includes("{ api_key: '' }"), '清空密钥未显式声明空值 patch（会被磁盘回灌覆盖）');
  // 生成密钥必须用 CSPRNG（crypto.getRandomValues），不得用 Math.random()（可预测）
  assert.ok(
    SETTINGS_SERVICE.includes('crypto.getRandomValues'),
    'settingsService.generateApiKey 必须用 crypto.getRandomValues（CSPRNG）'
  );
  for (const [name, content] of [['SettingsPage.tsx', SETTINGS_TSX], ['settingsService.ts', SETTINGS_SERVICE]]) {
    assert.ok(
      !/Math\.random\s*\(/.test(stripComments(content)),
      `${name} 不得用 Math.random() 生成鉴权密钥（可预测）`
    );
  }
  // API Key 区域需提示重启内核后生效（与其它 AppConfig 项一致）
  assert.ok(
    /'settings\.apiKeyHintC': '[^']*重启内核生效[^']*'/.test(I18N),
    'API Key 区域需提示「重启内核生效」（settings.apiKeyHintC）'
  );
  assert.ok(
    /'settings\.suffixRestartKernel': '[^']*重启内核后生效[^']*'/.test(I18N),
    '生成/保存后的 toast 后缀需提示重启内核后生效'
  );
});

test('D 安全硬约束：API Key 只在内存，禁入 localStorage / 日志 / toast', () => {
  // 源码注释即契约声明
  assert.ok(
    SETTINGS_TSX.includes('绝不进 localStorage'),
    'SettingsPage.tsx 必须声明密钥不进 localStorage'
  );
  assert.ok(
    SERVICE_PROVIDER.includes('仅内存，不进 localStorage'),
    'ServiceProvider 必须声明客户端密钥仅内存'
  );
  // 真实代码中不得有 localStorage 写入（注释剥离后）
  for (const [name, content] of [['SettingsPage.tsx', SETTINGS_TSX], ['settingsService.ts', SETTINGS_SERVICE], ['ServiceProvider.tsx', SERVICE_PROVIDER]]) {
    assert.ok(
      !/localStorage\.setItem/.test(stripComments(content)),
      `${name} 不得向 localStorage 写入（含密钥）`
    );
  }
  // toast / saveField 文案不得插值密钥明文：密钥相关 t('settings.apiKey…') 的
  // 插值参数只允许 suffix（重启提示），不允许出现密钥值变量
  const codeOnly = stripComments(SETTINGS_TSX);
  const tCalls = [...codeOnly.matchAll(/t\('settings\.apiKey[^']*'((?:,\s*\{[^}]*\})?)\)/g)];
  assert.ok(tCalls.length >= 5, '未找到足够的 API Key 相关文案调用（断言锚点失效）');
  for (const m of tCalls) {
    const args = m[1] || '';
    assert.ok(
      !/form\.apiKey/.test(args) && !/\bkey\b/.test(args.replace(/apiKey/g, '')),
      `文案插值不得携带密钥明文：t('settings.apiKey…', ${args || '无参数'})`
    );
  }
});
