// turing_helper.cjs 生产链路测试（findSdkDir 的「两轮优先级选择」）
//
// 与 tests/test_turing_security.test.js 的分工：
//   - test_turing_security.test.js  -> looksLikeSdk(dir, strict) 的**判定规则**（单目录特征）
//   - 本文件                        -> findSdkDir() 的**选择链路**（真实生产路径：
//                                      哪些候选参与、以什么次序、严格/宽松如何分工）
//
// 为什么必须单独测这一层：判定函数全绿 ≠ 生产安全。即使 looksLikeSdk 完全正确，
// 只要 findSdkDir 的「两轮」次序或优先级被改坏，就会让严格校验在实际运行中被绕过：
//   · 若第一轮不跳过显式路径，用户显式目录会被当普通候选扫，宽松入口失去意义；
//   · 若第二轮（宽松）跑在严格轮之前，一个恰好存在的宽松目录会劫持选择；
//   · 若盘根扫描默认开启，盘根伪造目录会被 require 执行（本地供应链风险）。
// 因此本文件对这三条不变量逐一锁定，并做变异验证（见文件末尾说明）。

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

// 被测模块通过 require.main 区分「直接运行」与「被引用」，被引用时导出三个函数。
// 注意：模块读取 process.env 是在函数调用时（而非 require 时），故可在调用前设 env。
const { looksLikeSdk, collectCandidateDirs, findSdkDir } = require(path.join(rootDir, 'turing_helper.cjs'));

// ---------- 环境变量隔离：这些用例会改 process.env，必须逐一还原 ----------
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// 所有涉及「常见安装基目录」探测的用例都把六个基目录变量指向空目录，
// 避免测试机真实存在的 WorkBuddy 安装干扰断言（让用例在任何机器上都确定）。
const BASE_ENVS = ['LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'USERPROFILE', 'HOME'];

function makeDir(base, name) {
  const d = path.join(base, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeStrictSdk(dir, pkgName = 'workbuddy-turing-sdk') {
  fs.writeFileSync(path.join(dir, 'index.cjs'), '// ok');
  fs.writeFileSync(path.join(dir, 'turing_sdk.node'), 'binary');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName }));
  return dir;
}

function writeLooseOnly(dir) {
  // 仅 index.cjs：严格模式拒绝、宽松模式（用户显式信任）接受
  fs.writeFileSync(path.join(dir, 'index.cjs'), '// custom wrapper');
  return dir;
}

function redirectBases(sandbox) {
  const envs = {};
  for (const k of BASE_ENVS) envs[k] = makeDir(sandbox, 'empty-base-' + k);
  return envs;
}

test('turing_helper 生产链路（findSdkDir 选择与优先级）', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'turing-findsdk-'));
  t.after(() => {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  });

  await t.test('A. 严格特征目录被选中（常规安装位，无显式 env）', () => {
    const fakeLocal = makeDir(sandbox, 'base-a');
    const sdk = path.join(fakeLocal, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'native', 'turing-sdk');
    fs.mkdirSync(sdk, { recursive: true });
    writeStrictSdk(sdk);

    withEnv({ ...redirectBases(sandbox), LOCALAPPDATA: fakeLocal, WORKBUDDY_TURING_SDK_DIR: undefined }, () => {
      assert.strictEqual(findSdkDir(), sdk, '应选中带强特征的 SDK 目录');
    });
  });

  await t.test('B. 严格轮优先于宽松轮：显式目录只有 index.cjs、常规位有强特征目录时，必须先选强特征目录', () => {
    // 这条锁定「第二轮（显式信任，宽松）不得插到严格轮之前」。
    const fakeLocal = makeDir(sandbox, 'base-b');
    const strictSdk = path.join(fakeLocal, 'WorkBuddy', 'resources', 'app.asar.unpacked', 'native', 'turing-sdk');
    fs.mkdirSync(strictSdk, { recursive: true });
    writeStrictSdk(strictSdk);

    const looseOnly = writeLooseOnly(makeDir(sandbox, 'loose-b'));

    withEnv({ ...redirectBases(sandbox), LOCALAPPDATA: fakeLocal, WORKBUDDY_TURING_SDK_DIR: looseOnly }, () => {
      // 严格轮必须赢：即便显式目录存在，也只能被第二轮（宽松）选中
      assert.strictEqual(findSdkDir(), strictSdk,
        '严格特征目录必须优先于显式宽松目录（否则宽松入口会劫持选择，严格校验形同虚设）');
    });
  });

  await t.test('B2. 显式目录本身也是强特征时，仍由「常规安装位」的强特征目录胜出（严格轮的语义）', () => {
    // 这条锁定 findSdkDir 第一轮里那句 `continue` 的真实语义：
    // 「严格轮专扫常规安装位，显式 env 路径留到第二轮」。
    // 若删掉那句 continue，显式目录会参与严格轮并因排在候选列表更前而胜出
    // —— 实测基线返回 regularSdk / 变异后返回 explicitDir，是**可观测的行为差异**。
    const fakeB2 = makeDir(sandbox, 'base-b2');
    const regularSdk = path.join(fakeB2, 'WorkBuddy', 'resources', 'native', 'turing-sdk');
    fs.mkdirSync(regularSdk, { recursive: true });
    writeStrictSdk(regularSdk);

    const explicitStrong = makeDir(sandbox, 'explicit-strong-b2');
    writeStrictSdk(explicitStrong);

    withEnv({ ...redirectBases(sandbox), LOCALAPPDATA: fakeB2, WORKBUDDY_TURING_SDK_DIR: explicitStrong }, () => {
      assert.strictEqual(findSdkDir(), regularSdk,
        '两个强特征目录并存时，应由常规安装位胜出（显式 env 属于第二轮兜底，不参与第一轮严格扫描）');
    });
  });

  await t.test('C. 仅显式路径可用时回退到宽松接受（两轮的兜底作用）', () => {
    const looseOnly = writeLooseOnly(makeDir(sandbox, 'loose-c'));
    withEnv({ ...redirectBases(sandbox), WORKBUDDY_TURING_SDK_DIR: looseOnly }, () => {
      assert.strictEqual(findSdkDir(), looseOnly,
        '无强特征候选时应回退到用户显式信任目录（否则显式配置功能失效）');
    });
  });

  await t.test('D. 显式目录若连 index.cjs 都没有，绝不接受（宽松 ≠ 无门槛）', () => {
    const empty = makeDir(sandbox, 'empty-d'); // 空目录：无 index.cjs
    withEnv({ ...redirectBases(sandbox), WORKBUDDY_TURING_SDK_DIR: empty }, () => {
      assert.strictEqual(findSdkDir(), null,
        '宽松模式仍需 index.cjs 入口；否则 require 一个空目录会抛错或落进意外行为');
    });
  });

  await t.test('E. 完全无候选时返回 null（不是抛错、不是随便给一个路径）', () => {
    withEnv({ ...redirectBases(sandbox), WORKBUDDY_TURING_SDK_DIR: undefined, WORKBUDDY_TURING_DRIVES: undefined }, () => {
      assert.strictEqual(findSdkDir(), null, '无候选必须显式返回 null，由调用方决定报错');
    });
  });

  await t.test('F. 盘根扫描默认关闭：未设 WORKBUDDY_TURING_DRIVES 时，盘根伪造目录不参与候选', () => {
    // 供应链加固的关键不变量：伪造的 <盘根>/workbuddy/... 目录不得进入候选，
    // 因为盘根不是官方安装位置，扫描会放大本地执行风险。
    withEnv({ ...redirectBases(sandbox), WORKBUDDY_TURING_SDK_DIR: undefined, WORKBUDDY_TURING_DRIVES: undefined }, () => {
      const dirs = collectCandidateDirs().map((d) => d.replace(/\\/g, '/').toLowerCase());
      // 盘根候选的形态是「单字母盘符 + 冒号 + 斜杠 + workbuddy」，与
      // %LOCALAPPDATA%/ProgramFiles 等推导出的绝对路径（多级目录）形态不同。
      const driveRootCandidates = dirs.filter((d) => /^[a-z]:\/(workbuddy)\//.test(d));
      assert.strictEqual(driveRootCandidates.length, 0,
        '默认不得产生盘根 workbuddy 候选；实际：' + JSON.stringify(driveRootCandidates));
    });
  });

  await t.test('G. 显式开启盘根扫描后，盘根候选才出现（纯盘符与带冒号两种写法都生效）', () => {
    withEnv({ ...redirectBases(sandbox), WORKBUDDY_TURING_SDK_DIR: undefined, WORKBUDDY_TURING_DRIVES: 'Z,Z:' }, () => {
      const norm = (d) => d.replace(/\\/g, '/').toLowerCase();
      const dirs = collectCandidateDirs().map(norm);
      // 期望值必须用与实现相同的 path.join 推导，不能写死 `z:/workbuddy/` 正则：
      // path.join 是平台相关的——Windows 下 path.join('Z:\\','workbuddy') === 'Z:\\workbuddy'，
      // 而 POSIX 下会得到 'Z:\\/workbuddy'（反斜杠被当普通字符，再补一个分隔符），
      // 写死正则会让本用例在 Linux/macOS 检出上恒失败（CI 只跑 Windows，故此前未暴露）。
      // 两种写法（'Z' 与 'Z:'）归一后是同一组路径，add() 去重后应恰好 4 条。
      const expected = [];
      const relPaths = [
        'resources/app.asar.unpacked/native/turing-sdk',
        'resources/native/turing-sdk',
      ];
      for (const base of [path.join('Z:\\', 'workbuddy'), path.join('Z:\\', 'WorkBuddy')]) {
        for (const rel of relPaths) expected.push(norm(path.join(base, rel)));
      }
      const zHits = expected.filter((e) => dirs.includes(e));
      assert.strictEqual(zHits.length, 4,
        '设了 WORKBUDDY_TURING_DRIVES 后应产生 4 条盘根候选（两种写法去重后）；实际：' + JSON.stringify(zHits));
      // 反向确认：候选确实来自「显式开启」这一条件，而不是无条件存在
      const allDriveHits = dirs.filter((d) => /(^|\/)workbuddy\//.test(d) && /^z:/.test(d));
      assert.ok(allDriveHits.length <= 8, '不应重复铺开（add 去重应生效）；实际：' + JSON.stringify(allDriveHits));
    });
  });

  await t.test('H. 强特征与宽松的边界：严格拒绝但宽松接受（构造性反例，锁定 strict 开关真实生效）', () => {
    const looseOnly = writeLooseOnly(makeDir(sandbox, 'loose-h'));
    assert.strictEqual(looksLikeSdk(looseOnly, true), false, '仅 index.cjs 在严格模式下必须拒绝');
    assert.strictEqual(looksLikeSdk(looseOnly, false), true, '仅 index.cjs 在宽松模式下接受（用户显式信任）');
    assert.notStrictEqual(looksLikeSdk(looseOnly, true), looksLikeSdk(looseOnly, false),
      'strict 开关必须真实改变判定结果，否则「显式信任」与「自动发现」就没有区别了');
  });

  await t.test('I. 目录不存在 / 无权限读取时安全降级为 false（不得抛错）', () => {
    const missing = path.join(sandbox, 'does-not-exist-at-all');
    assert.strictEqual(looksLikeSdk(missing, true), false, '不存在的目录必须返回 false 而非抛错');
    assert.strictEqual(looksLikeSdk(missing, false), false, '同一路径宽松模式也不得抛错');
  });
});

// ─────────────────────────────────────────────────────────────
// 变异验证记录（写入本文件时逐一实测，供后续维护者复核这些断言是否真的能抓缺陷）
//   M1. findSdkDir 两轮顺序对调（宽松轮提到严格轮之前）
//       -> 用例 B 变红：选中 loose-b 而非 strict-b ✓
//   M2. 删掉「严格轮跳过显式路径」那句 continue
//       -> 用例 B2 变红：显式目录反超常规安装位（基线由常规位胜出）✓
//       注：该 continue 的作用是「把显式 env 路径排除出第一轮严格扫描范围」；
//       仅当显式目录本身也是强特征时才可观测，故专门补了 B2 用例锁定。
//   M3. 让 collectCandidateDirs 默认扫描盘根（默认值 "" -> "Z"）
//       -> 用例 F 变红：默认出现 4 条 Z:\workbuddy 候选 ✓
//   M4. 让 looksLikeSdk 的 strict 分支失效（恒真）
//       -> 用例 H 变红：严格模式与宽松模式判定结果不再有差异 ✓
//
// 首轮编写时 M2/M3 曾漏掉（M2 因 B 用例只断言结果、未覆盖「显式目录也是强特征」
// 这一分支；M3 因 F 用例的 filter 条件写成了恒真式），均已修正断言后复测通过。
// ─────────────────────────────────────────────────────────────
