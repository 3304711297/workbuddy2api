/**
 * i18n 一致性契约：zh-CN / en 双词典必须键集合一致、插值变量一致，
 * 且源码中所有静态 t('...') 调用都有对应词条；zh-TW 经 toTraditional() 转换，
 * MUST_CONVERT 集锁定核心词组的繁体映射。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// Node 24 可直接类型剥离导入 .ts（Windows 路径必须转为 file:// URL 协议）
const toUrl = (sub) => pathToFileURL(path.join(REPO_ROOT, sub)).href;
const { zhCN } = await import(toUrl('src/i18n/zh-CN.ts'));
const { en } = await import(toUrl('src/i18n/en.ts'));
const { toTraditional } = await import(toUrl('src/i18n/traditional.ts'));

const zhKeys = new Set(Object.keys(zhCN));
const enKeys = new Set(Object.keys(en));

test('zh-CN 与 en 键集合完全一致', () => {
  const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
  const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
  assert.deepEqual(onlyZh, [], `zh-CN 独有键: ${onlyZh.join(', ')}`);
  assert.deepEqual(onlyEn, [], `en 独有键: ${onlyEn.join(', ')}`);
});

test('插值变量名在双语间一致', () => {
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const bad = [];
  for (const k of zhKeys) {
    const zv = vars(zhCN[k]);
    const ev = vars(en[k]);
    if (zv !== ev) bad.push(`${k}: zh={${zv}} en={${ev}}`);
  }
  assert.deepEqual(bad, [], `插值变量不一致:\n${bad.join('\n')}`);
});

test('源码中所有静态 t(key) 都有词条', () => {
  const used = new Set();
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(f)) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-z][a-zA-Z.]+)'/g)) used.add(m[1]);
    }
  };
  walk(path.join(REPO_ROOT, 'src', 'pages'));
  walk(path.join(REPO_ROOT, 'src', 'components'));
  walk(path.join(REPO_ROOT, 'src', 'state'));
  const missing = [...used].filter((k) => !zhKeys.has(k));
  assert.deepEqual(missing, [], `缺失词条: ${missing.join(', ')}`);
});

test('词条值非空', () => {
  const bad = [];
  for (const k of zhKeys) {
    if (!zhCN[k]) bad.push(`zh:${k}`);
    if (!en[k]) bad.push(`en:${k}`);
  }
  assert.deepEqual(bad, [], `空值: ${bad.join(', ')}`);
});

// 简→繁核心词组：必须正确转换（锁定 traditional.ts 的 curated 表）
const MUST_CONVERT = [
  ['软件', '軟體'],
  ['服务器', '伺服器'],
  ['默认', '預設'],
  ['账号', '帳號'],
  ['设置', '設定'],
  ['复制', '複製'],
  ['日志', '日誌'],
  ['重启', '重啟'],
  ['启动', '啟動'],
  ['网络', '網路'],
  ['窗口', '視窗'],
  ['确认', '確認'],
  ['显示', '顯示'],
  ['语言', '語言'],
];

test('toTraditional 核心词组转换正确', () => {
  for (const [simp, trad] of MUST_CONVERT) {
    assert.equal(toTraditional(simp), trad, `「${simp}」应转为「${trad}」`);
  }
});

test('toTraditional 未覆盖字诚实保留（不编造）', () => {
  // 纯 ASCII 与数字不应被改动
  assert.equal(toTraditional('v0.2.1 d1cb787'), 'v0.2.1 d1cb787');
  assert.equal(toTraditional('HTTP 200'), 'HTTP 200');
});

test('toTraditional 词组优先于单字（语境正确）', () => {
  // 「软件」整体转「軟體」，而非逐字「軟件」
  assert.ok(!toTraditional('软件').includes('軟件'), '词组「软件」不应被逐字转为「軟件」');
});
