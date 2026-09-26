/**
 * 模型标签与动态计费契约（2026-09-26 迁移至 src/services/modelBilling.ts）
 *
 * 迁移说明：
 *  - 旧 models.js 的 isNightWindowNow / getMultiplierNum / formatMultiplier /
 *    getModelMultiplierInfo / getNextWindowBoundaryDelayMs / renderBadgeHtml →
 *    modelBilling.ts 的同名（或改名）纯函数：formatMultiplier 的渲染职责拆为
 *    getMultiplierRender，renderBadgeHtml 拆为 getBadgeRender（React 组件据此渲染）；
 *  - 以下全部 import 真实模块做行为断言（旧文件曾有本地拷贝式模拟，现已消除）；
 *  - 标签口径（按批次要求锁定）：来源端标签只保留 CodeBuddy / WorkBuddy / 双端，
 *    「需授权」是虚拟标签——它不存于 m.tags，由 availability === 'unavailable'
 *    在 buildTagCounts / applyModelFilterSort 中派生；
 *  - billing.rs 的 ModelBadge 结构体契约未动（后端），仍由其 Rust 单测锁定；
 *    本文件第 7 条锁定前端消费侧（getBadgeRender 优先消费其 text/color/kind）；
 *  - 旧 accounts.js 的夜间徽章「防全场免费误导」文案契约，新家是
 *    src/pages/AccountsPage.tsx + i18n accounts.rateLimitNightOn/Off（第 8 条）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const BILLING_TS = fs.readFileSync(
  path.join(REPO_ROOT, 'src', 'services', 'modelBilling.ts'),
  'utf-8'
);
const ACCOUNTS_PAGE = fs.readFileSync(
  path.join(REPO_ROOT, 'src', 'pages', 'AccountsPage.tsx'),
  'utf-8'
);
const ZH_CN = fs.readFileSync(path.join(REPO_ROOT, 'src', 'i18n', 'zh-CN.ts'), 'utf-8');

const {
  applyModelFilterSort,
  buildTagCounts,
  cleanModelTags,
  getBadgeRender,
  getModelMultiplierInfo,
  getMultiplierNum,
  getMultiplierRender,
  getNextWindowBoundaryDelayMs,
  isNightWindowNow,
} = await import('../src/services/modelBilling.ts');

test('modelBilling 不把 tags 硬编码限制在 3 来源端内（放行动态业务徽章），仍过滤 craft', () => {
  // 旧 models.js 曾有 ['CodeBuddy', 'WorkBuddy', '双端'].includes(t) 限制并被移除；
  // 新实现延续该契约：动态徽章（夜间免费/限时免费等）必须放行
  assert.equal(
    BILLING_TS.includes("['CodeBuddy', 'WorkBuddy', '双端'].includes(t)"),
    false,
    'modelBilling.ts 不得将 tags 硬编码限制在 3 个来源端标签内，必须放行动态业务徽章'
  );
  assert.deepEqual(
    cleanModelTags(['双端', '夜间免费', '限时免费', 'craft', ' Craft ']),
    ['双端', '夜间免费', '限时免费'],
    '只过滤 craft（含 trim 保护），来源端与动态徽章都保留'
  );
});

test('isNightWindowNow 正确判定 Asia/Shanghai 23:00-08:00（真实函数，注入日期）', () => {
  // UTC 15:00 = CST 23:00 (Night window start)
  assert.equal(isNightWindowNow(new Date('2026-09-22T15:00:00Z')), true, '23:00 CST 必须是夜间窗口');
  // UTC 18:30 = CST 02:30 (Mid-night)
  assert.equal(isNightWindowNow(new Date('2026-09-22T18:30:00Z')), true, '02:30 CST 必须是夜间窗口');
  // UTC 23:59 = CST 07:59 (Just before 08:00)
  assert.equal(isNightWindowNow(new Date('2026-09-22T23:59:00Z')), true, '07:59 CST 必须是夜间窗口');
  // UTC 00:00 = CST 08:00 (Day window start)
  assert.equal(isNightWindowNow(new Date('2026-09-22T00:00:00Z')), false, '08:00 CST 必须是白天窗口');
  // UTC 06:00 = CST 14:00 (Afternoon)
  assert.equal(isNightWindowNow(new Date('2026-09-22T06:00:00Z')), false, '14:00 CST 必须是白天窗口');
});

test('getMultiplierNum / getMultiplierRender 处理动态夜间计费（真实函数）', () => {
  const dNight = new Date('2026-09-22T16:00:00Z'); // 24:00 CST (Night)
  const dDay = new Date('2026-09-22T04:00:00Z'); // 12:00 CST (Day)

  const hy4 = { id: 'hy4-preview', credits: 'x0.29', tags: ['双端', '夜间免费'] };
  const glm52 = { id: 'glm-5.2', credits: 'x0.79 credits', tags: ['双端', '夜间折扣'] };
  const hy3 = { id: 'hy3', credits: 'x0.00 credits', tags: ['双端', '限时免费'] };

  // 夜间：hy4 实际生效 0.00x
  assert.equal(getMultiplierNum(hy4, dNight), 0.0);
  const rHy4Night = getMultiplierRender(hy4, dNight);
  assert.equal(rHy4Night.kind, 'night_free');
  assert.equal(rHy4Night.text, '免费 (0.00x)');
  assert.match(rHy4Night.note, /限免中/);

  // 白天：hy4 标称 0.29x
  assert.equal(getMultiplierNum(hy4, dDay), 0.29);
  const rHy4Day = getMultiplierRender(hy4, dDay);
  assert.equal(rHy4Day.kind, 'night_free_idle');
  assert.equal(rHy4Day.text, '0.29x');
  assert.match(rHy4Day.note, /夜间 0\.00x/);

  // 夜间：glm-5.2 显示折扣生效中（排序沿用 base）
  assert.equal(getMultiplierNum(glm52, dNight), 0.79);
  const rGlmNight = getMultiplierRender(glm52, dNight);
  assert.equal(rGlmNight.kind, 'night_discount');
  assert.match(rGlmNight.note, /折扣生效中/);

  // 白天：glm-5.2 显示夜间享折扣
  assert.equal(getMultiplierNum(glm52, dDay), 0.79);
  const rGlmDay = getMultiplierRender(glm52, dDay);
  assert.equal(rGlmDay.kind, 'night_discount_idle');
  assert.match(rGlmDay.note, /夜间享折扣/);

  // hy3 全天免费
  assert.equal(getMultiplierNum(hy3, dNight), 0.0);
  assert.equal(getMultiplierNum(hy3, dDay), 0.0);
  assert.equal(getMultiplierRender(hy3, dNight).kind, 'free');
  assert.equal(getMultiplierRender(hy3, dDay).text, '免费 (0.00x)');
});

test('「需授权」是虚拟标签：由 availability 派生，不存于 tags，参与筛选与计数', () => {
  const list = [
    { id: 'gpt-x', credits: 'x2.0', tags: ['WorkBuddy'], availability: 'unavailable' },
    { id: 'glm-5.3', credits: 'x0.51 credits', tags: ['双端'], availability: 'available' },
  ];
  // 未在 tags 里写「需授权」，仍被虚拟标签筛出
  assert.deepEqual(
    applyModelFilterSort(list, '需授权', null, null).map((m) => m.id),
    ['gpt-x'],
    '虚拟标签「需授权」应按 availability === unavailable 筛选'
  );
  // 计数注入且排第一（TAG_ORDER 优先级）
  const counts = buildTagCounts(list);
  assert.ok(counts.length > 0 && counts[0].tag === '需授权', 'buildTagCounts 必须把虚拟标签「需授权」排在首位');
  assert.equal(counts[0].count, 1);
  // 来源端标签只保留 CodeBuddy / WorkBuddy / 双端（动态徽章另行放行，见第 1 条）
  const tags = counts.map((c) => c.tag);
  assert.ok(tags.includes('WorkBuddy') && tags.includes('双端'), '来源端标签应出现在计数中');
});

test('getModelMultiplierInfo 区分 base 与 effective（真实函数）', () => {
  const dNight = new Date('2026-09-22T16:00:00Z'); // 24:00 CST
  const dDay = new Date('2026-09-22T04:00:00Z'); // 12:00 CST

  const glm = { id: 'glm-5.2', credits: 'x0.79 credits', tags: ['双端', '夜间折扣'] };
  const infoNight = getModelMultiplierInfo(glm, dNight);
  assert.equal(infoNight.base, 0.79);
  assert.equal(infoNight.effective, 0.79);
  assert.equal(infoNight.effectiveRateStatus, 'night_discount');

  const hy4 = { id: 'hy4-preview', credits: 'x0.29', tags: ['双端', '夜间免费'] };
  const infoHy4Night = getModelMultiplierInfo(hy4, dNight);
  assert.equal(infoHy4Night.base, 0.29);
  assert.equal(infoHy4Night.effective, 0.0);
  assert.equal(infoHy4Night.effectiveRateStatus, 'night_free');

  // 白天无夜间标签影响 → normal
  const infoDay = getModelMultiplierInfo(glm, dDay);
  assert.equal(infoDay.effectiveRateStatus, 'normal');
});

test('getNextWindowBoundaryDelayMs 计算到下一个 23:00 / 08:00 的延迟（真实函数）', () => {
  // CST 22:59:00 -> 距 23:00 约 60s（含 1s 缓冲）
  const d2259 = new Date('2026-09-22T14:59:00Z');
  const delay = getNextWindowBoundaryDelayMs(d2259);
  assert.ok(delay >= 60000 && delay <= 62000, `delay 应该约为 60s，实得 ${delay}`);
});

test('getBadgeRender 优先消费 ModelBadge 结构化颜色（真实函数）', () => {
  const m = {
    id: 'test-m',
    tags: ['双端', '专属活动'],
    badges: [{ text: '专属活动', color: '#10B981', kind: 'promo' }],
  };
  const r = getBadgeRender('专属活动', m, false);
  assert.match(r.style, /#10B981/);
  assert.match(r.text, /专属活动/);
});

test('getBadgeRender 对已知 kind（night_free / limited_free）优先用上游合法色', () => {
  const mNight = {
    id: 'test-night',
    tags: ['双端', '夜间免费'],
    badges: [{ text: '夜间免费', color: '#1E90FF', kind: 'night_free' }],
  };
  const rNight = getBadgeRender('夜间免费', mNight, true);
  assert.match(rNight.style, /#1E90FF/, 'night_free 必须优先消费 ModelBadge 下发的自定义合法颜色');
  assert.equal(rNight.text, '🌙 夜间免费中');

  const mLimited = {
    id: 'test-ltd',
    tags: ['双端', '限时免费'],
    badges: [{ text: '限时免费', color: '#8B5CF6', kind: 'limited_free' }],
  };
  const rLtd = getBadgeRender('限时免费', mLimited, false);
  assert.match(rLtd.style, /#8B5CF6/, 'limited_free 必须优先消费 ModelBadge 下发的自定义合法颜色');
  assert.equal(rLtd.text, '🔥 限时免费');
});

test('账号页夜间徽章文案明确「指定模型」，防「全场免费」误导（旧 accounts.js 契约的新家）', () => {
  assert.ok(
    ACCOUNTS_PAGE.includes("t('accounts.rateLimitNightOn')"),
    'AccountsPage 未渲染夜间徽章文案（accounts.rateLimitNightOn）'
  );
  assert.ok(
    /'accounts\.rateLimitNightOn': '🌙 指定模型/.test(ZH_CN) ||
      /'accounts\.rateLimitNightOff': '🌙 指定模型/.test(ZH_CN),
    '夜间徽章文案必须包含「指定模型」，防用户误解为全场免费'
  );
});
