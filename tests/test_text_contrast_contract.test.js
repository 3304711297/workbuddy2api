// 小字/次要文字对比度契约（WCAG 2.1 AA）
//
// 背景：审计发现 `--text-muted` 在深色主题下 8 个使用点全部不达标（最坏 3.59:1），
// 浅色主题 4 处不达标（最坏 4.19:1）。这不是某一处写错色值，而是**变量本身**的取值问题，
// 所以契约锁定在变量层：两个主题的 --text-muted 都必须在其实际背景上达到 AA（小字 4.5:1）。
//
// 为什么用真实计算而不是断言源码里出现某个色值：色值可以换（换 #77879d 或别的合规色
// 都不该让测试变红），但「对比度达标」这个不变量必须始终成立。并且必须用**最坏背景**
// （深色取卡片 #181c24 而非更深的 app 底 #0d0f12；浅色取侧栏 #eff1ed 而非 #ffffff），
// 否则会在某些区域仍然不达标却测试通过——这正是原缺陷得以存在的原因。
//
// 同时锁定视觉层级：--text-muted 必须比 --text-secondary 更弱（深色更暗/浅色更浅），
// 否则「次要文字」会与「次级文字」同权重，层级被压平（把变量直接提亮到 secondary 是
// 一种能让对比度达标、却破坏设计语义的假修复）。

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(__dirname, '..', 'src', 'style.css'), 'utf8');

const AA_SMALL_TEXT = 4.5;

// ---------- WCAG 相对亮度与对比度 ----------
function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// 从 CSS 里取变量在**指定主题块**中的值。
// 深色主题取 `:root {` 块；浅色主题取 `[data-theme="light"] {` 块。
function themeVar(theme, name) {
  const header = theme === 'light' ? /\[data-theme="light"\]\s*\{/ : /:root\s*\{/;
  const m = header.exec(CSS);
  assert.ok(m, `未找到 ${theme} 主题的变量块`);
  const start = m.index + m[0].length;
  const end = CSS.indexOf('}', start);
  const block = CSS.slice(start, end);
  const vm = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(block);
  assert.ok(vm, `${theme} 主题未定义 ${name}`);
  return vm[1].trim();
}

// ---------- 前提断言：背景真值没变（否则本测试的前提失效，必须一起来改） ----------
test('前提：两个主题的背景色真值与本测试假设一致', () => {
  assert.strictEqual(themeVar('dark', '--bg-card'), '#181c24', '深色卡片底变了，最坏背景需重算');
  assert.strictEqual(themeVar('light', '--bg-sidebar'), '#eff1ed', '浅色侧栏底变了，最坏背景需重算');
});

test('深色主题 --text-muted 在最坏背景（卡片 #181c24）上达到 AA', () => {
  const muted = themeVar('dark', '--text-muted');
  const r = contrast(muted, '#181c24');
  assert.ok(
    r >= AA_SMALL_TEXT,
    `深色 --text-muted ${muted} 对比度仅 ${r.toFixed(2)}:1，小字需 ≥${AA_SMALL_TEXT}:1`
  );
});

test('浅色主题 --text-muted 在最坏背景（侧栏 #eff1ed）上达到 AA', () => {
  const muted = themeVar('light', '--text-muted');
  const r = contrast(muted, '#eff1ed');
  assert.ok(
    r >= AA_SMALL_TEXT,
    `浅色 --text-muted ${muted} 对比度仅 ${r.toFixed(2)}:1，小字需 ≥${AA_SMALL_TEXT}:1`
  );
});

test('层级未被压平：--text-muted 必须弱于 --text-secondary（两主题）', () => {
  for (const theme of ['dark', 'light']) {
    const muted = themeVar(theme, '--text-muted');
    const secondary = themeVar(theme, '--text-secondary');
    const lm = luminance(muted);
    const ls = luminance(secondary);
    if (theme === 'dark') {
      assert.ok(lm < ls, `深色主题 --text-muted(${muted}) 应比 --text-secondary(${secondary}) 更暗`);
    } else {
      assert.ok(lm > ls, `浅色主题 --text-muted(${muted}) 应比 --text-secondary(${secondary}) 更浅`);
    }
  }
});

// ---------- .log-console-hint：固定黑底、不随主题切换，故单独锁定 ----------
test('日志控制台提示文字在其固定黑底上达到 AA（两主题一致）', () => {
  const m = /\.log-console-hint\s*\{([^}]*)\}/.exec(CSS);
  assert.ok(m, '未找到 .log-console-hint 规则');
  const cm = /color:\s*([^;]+);/.exec(m[1]);
  assert.ok(cm, '.log-console-hint 未设置 color');
  const color = cm[1].trim();
  // 该控制台固定为终端风格黑底：header #151821 / 正文 #0b0d11 —— 取更亮者作最坏背景
  const r = Math.min(contrast(color, '#151821'), contrast(color, '#0b0d11'));
  assert.ok(
    r >= AA_SMALL_TEXT,
    `.log-console-hint ${color} 在最坏黑底上仅 ${r.toFixed(2)}:1，11px 小字需 ≥${AA_SMALL_TEXT}:1`
  );
});
