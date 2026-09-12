/**
 * 客户端 API Key 管理契约测试（第四轮：对标 EasyCLIProxyAPI 的 ApiAccessPage）
 *
 * 背景：内核早已支持 `--api-key`（非回环监听时强制要求携带），
 * 但 GUI 完全没有入口——用户无法在界面启用/查看/轮换鉴权密钥。
 * 本测试锁定：
 *   A. 内核能力前置事实（--api-key / --unsafe-expose 参数存在）
 *   B. Rust 侧 AppConfig 承载 api_key + 启动时透传（含空值不下发）
 *   C. 启动参数装配：非空才追加 --api-key，避免空串反而开启校验
 *   D. 前端设置页提供密钥管理 UI（生成/复制/清空）
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
const SETTINGS_JS = JS('src/settings.js');
const INDEX_HTML = JS('index.html');

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

test('D 前端设置页提供客户端鉴权密钥管理 UI', () => {
  assert.ok(
    INDEX_HTML.includes('input-api-key') || INDEX_HTML.includes('api-key-field'),
    'index.html 缺少 API Key 输入框'
  );
  assert.ok(
    INDEX_HTML.includes('btn-gen-api-key') || INDEX_HTML.includes('gen-api-key'),
    'index.html 缺少「生成随机密钥」按钮'
  );
  assert.ok(
    INDEX_HTML.includes('btn-clear-api-key') || INDEX_HTML.includes('clear-api-key'),
    'index.html 缺少「清空密钥」按钮'
  );
});

test('D 前端逻辑：密钥读写接入 AppConfig 且提示需重启内核', () => {
  assert.ok(
    SETTINGS_JS.includes('api_key'),
    'settings.js 未读写 api_key'
  );
  assert.ok(
    /crypto\.randomUUID|getRandomValues|randomBytes/.test(SETTINGS_JS),
    '生成密钥必须用 CSPRNG（crypto.*），不得用 Math.random()（可预测）'
  );
  // 只检测**真实调用**（Math.random() 后跟 ; 或 ) 等语法定界），
  // 排除注释中的说明性提及——注释里写「不要用 Math.random()」不算违规。
  const codeOnly = SETTINGS_JS
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/\/\/[^\n]*/g, '');        // 行注释
  assert.ok(
    !/Math\.random\(\s*\)/.test(codeOnly),
    '不得用 Math.random() 生成鉴权密钥（可预测）'
  );
  // 密钥变更必须走「保存设置」，且 UI 要有重启提示（AppConfig 改动不热加载）
  assert.ok(
    /restart|重启/.test(INDEX_HTML.slice(INDEX_HTML.indexOf('api-key-field') >= 0 ? INDEX_HTML.indexOf('api-key-field') : INDEX_HTML.indexOf('input-api-key'), (INDEX_HTML.indexOf('api-key-field') >= 0 ? INDEX_HTML.indexOf('api-key-field') : INDEX_HTML.indexOf('input-api-key')) + 2500)),
    'API Key 区域需提示重启内核后生效（与其它 AppConfig 项一致）'
  );
});
