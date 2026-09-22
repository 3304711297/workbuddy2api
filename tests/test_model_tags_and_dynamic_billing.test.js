import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

test('models.js does NOT filter out promo badge tags (preserves 夜间免费, 限时免费, etc.)', () => {
  const modelsJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'models.js'), 'utf-8');
  // 必须不再将 tags 仅限制在 CodeBuddy/WorkBuddy/双端 数组内
  assert.equal(
    modelsJs.includes("['CodeBuddy', 'WorkBuddy', '双端'].includes(t)"),
    false,
    'models.js 不得将 tags 硬编码限制在 3 个来源端标签内，必须放行动态业务徽章'
  );
  // 但仍须过滤 craft
  assert.equal(modelsJs.includes("t.toLowerCase() !== 'craft'"), true, 'models.js 必须过滤 craft 标签');
});

test('models.js contains isNightWindowNow function and supports injected date for testing', () => {
  const modelsJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'models.js'), 'utf-8');
  assert.equal(modelsJs.includes('isNightWindowNow'), true, 'models.js 必须导出或包含 isNightWindowNow 函数');
});

test('models.js formatMultiplier and getMultiplierNum handle dynamic night billing', () => {
  const modelsJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'models.js'), 'utf-8');
  // formatMultiplier 必须处理带有夜间免费/夜间折扣的模型
  assert.equal(modelsJs.includes('夜间免费'), true, 'models.js 必须感知「夜间免费」标签');
  assert.equal(modelsJs.includes('夜间折扣'), true, 'models.js 必须感知「夜间折扣」标签');
});

test('accounts.js clarifies night badge to avoid "all models free" misleading trap', () => {
  const accountsJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'accounts.js'), 'utf-8');
  // 文案必须明确指出是「指定模型」或「部分模型」，不能让用户误以为全场免费
  assert.equal(
    accountsJs.includes('指定模型') || accountsJs.includes('部分模型'),
    true,
    'accounts.js 夜间徽章文案必须包含「指定模型」或「部分模型」，防用户误解为全场免费'
  );
});

test('billing.rs preserves badge tags and populates ModelBadge items', () => {
  const billingRs = fs.readFileSync(path.join(REPO_ROOT, 'src-tauri', 'src', 'commands', 'billing.rs'), 'utf-8');
  assert.equal(
    billingRs.includes('ModelBadge'),
    true,
    'billing.rs 必须定义 ModelBadge 结构体'
  );
  assert.equal(
    billingRs.includes('badges'),
    true,
    'billing.rs ModelMetaItem 必须包含 badges 字段'
  );
});

test('Pure unit test: isNightWindowNow correctly judges Asia/Shanghai 23:00-08:00', async () => {
  const { isNightWindowNow } = await import('../src/models.js');
  // UTC 15:00 = CST 23:00 (Night window start)
  const d23 = new Date('2026-09-22T15:00:00Z');
  assert.equal(isNightWindowNow(d23), true, '23:00 CST 必须是夜间窗口');

  // UTC 18:30 = CST 02:30 (Mid-night)
  const d02 = new Date('2026-09-22T18:30:00Z');
  assert.equal(isNightWindowNow(d02), true, '02:30 CST 必须是夜间窗口');

  // UTC 23:59 = CST 07:59 (Just before 08:00)
  const d0759 = new Date('2026-09-22T23:59:00Z');
  assert.equal(isNightWindowNow(d0759), true, '07:59 CST 必须是夜间窗口');

  // UTC 00:00 = CST 08:00 (Day window start)
  const d08 = new Date('2026-09-22T00:00:00Z');
  assert.equal(isNightWindowNow(d08), false, '08:00 CST 必须是白天窗口');

  // UTC 06:00 = CST 14:00 (Afternoon)
  const d14 = new Date('2026-09-22T06:00:00Z');
  assert.equal(isNightWindowNow(d14), false, '14:00 CST 必须是白天窗口');
});

test('Pure unit test: formatMultiplier and getMultiplierNum dynamic behavior', async () => {
  const { formatMultiplier, getMultiplierNum } = await import('../src/models.js');
  const dNight = new Date('2026-09-22T16:00:00Z'); // 24:00 CST (Night)
  const dDay = new Date('2026-09-22T04:00:00Z');   // 12:00 CST (Day)

  const hy4 = { id: 'hy4-preview', credits: 'x0.29', tags: ['双端', '夜间免费'] };
  const glm52 = { id: 'glm-5.2', credits: 'x0.79 credits', tags: ['双端', '夜间折扣'] };
  const hy3 = { id: 'hy3', credits: 'x0.00 credits', tags: ['双端', '限时免费'] };

  // 夜间：hy4 实际生效 0.00x
  assert.equal(getMultiplierNum(hy4, dNight), 0.0);
  assert.match(formatMultiplier(hy4, dNight), /免费 \(0\.00x\)/);
  assert.match(formatMultiplier(hy4, dNight), /限免中/);

  // 白天：hy4 标称 0.29x
  assert.equal(getMultiplierNum(hy4, dDay), 0.29);
  assert.match(formatMultiplier(hy4, dDay), /0\.29x/);
  assert.match(formatMultiplier(hy4, dDay), /夜间 0\.00x/);

  // 夜间：glm-5.2 显示折扣生效中
  assert.equal(getMultiplierNum(glm52, dNight), 0.79);
  assert.match(formatMultiplier(glm52, dNight), /折扣生效中/);

  // 白天：glm-5.2 显示夜间享折扣
  assert.equal(getMultiplierNum(glm52, dDay), 0.79);
  assert.match(formatMultiplier(glm52, dDay), /夜间享折扣/);

  // hy3 全天免费
  assert.equal(getMultiplierNum(hy3, dNight), 0.0);
  assert.equal(getMultiplierNum(hy3, dDay), 0.0);
  assert.match(formatMultiplier(hy3, dNight), /免费 \(0\.00x\)/);
  assert.match(formatMultiplier(hy3, dDay), /免费 \(0\.00x\)/);
});
