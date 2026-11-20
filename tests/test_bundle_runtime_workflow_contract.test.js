// 发版工作流必须先把内置 Python 运行时落盘再打包（issue #47）
//
// 背景（已复现）：v0.3.0 的 NSIS 安装包解包后只有 workbuddy2api.exe + uninstall.exe，
// 既没有 converter.py 也没有 Python 运行时 —— 干净机器装完点「启动服务」必然失败。
// 修法是随包内置 runtime/（约 40MB，用户已拍板），由 scripts/prepare_bundle_runtime.py
// 在构建前下载钉版资产并安装依赖。
//
// 本文件锁三件事：
//   ① release.yml 必须先准备运行时、再 `npm run tauri build`，且准备步骤失败即中止
//      （continue-on-error 会让发版悄悄退回「安装包缺内核」的旧状态）；
//   ② 该步骤仅限 Windows：钉住的资产是 x86_64-pc-windows-msvc，在别的 runner 上跑只是浪费。
//   ③ ci.yml 保持轻量：日常 CI 不下载 22MB 运行时、不装 pip 依赖，也不因此变红。

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseYml = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const ciYml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

const stripYamlComments = (src) =>
  src
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

const releaseCode = stripYamlComments(releaseYml);
const ciCode = stripYamlComments(ciYml);

/** 按 `      - ` 切出 release.yml 的 step 块，便于断言「某个 step 自己」的属性。 */
const releaseSteps = releaseCode
  .split(/\r?\n(?=\s{6}-\s)/)
  .filter((block) => /^\s{6}-\s/.test(block));

const stepContaining = (needle) => {
  const step = releaseSteps.find((block) => block.includes(needle));
  assert.ok(step, `release.yml 缺少包含 ${needle} 的步骤`);
  return step;
};

test('release.yml 在打包前准备内置 Python 运行时', () => {
  const prepareAt = releaseCode.indexOf('scripts/prepare_bundle_runtime.py');
  const buildAt = releaseCode.indexOf('npm run tauri build');
  assert.ok(prepareAt !== -1, 'release.yml 未调用 scripts/prepare_bundle_runtime.py：安装包会缺内核与运行时');
  assert.ok(buildAt !== -1, 'release.yml 缺少 npm run tauri build');
  assert.ok(
    prepareAt < buildAt,
    '准备运行时必须在 npm run tauri build 之前：tauri 只在打包那一刻取 bundle.resources，晚一步等于没准备'
  );
});

test('准备运行时的步骤仅限 Windows runner', () => {
  const step = stepContaining('scripts/prepare_bundle_runtime.py');
  assert.match(
    step,
    /if:\s*runner\.os\s*==\s*'Windows'/,
    "准备步骤必须带 if: runner.os == 'Windows'：钉住的是 x86_64-pc-windows-msvc 资产，别的平台跑只是白下载"
  );
});

test('准备运行时失败必须中止发版（禁止 continue-on-error）', () => {
  const step = stepContaining('scripts/prepare_bundle_runtime.py');
  assert.ok(
    !/continue-on-error:\s*true/.test(step),
    '准备步骤不得 continue-on-error：下载/校验/装依赖失败时发版会悄悄产出「缺内核」的安装包'
  );
});

test('ci.yml 不跑运行时准备脚本（日常 CI 保持轻量）', () => {
  assert.ok(
    !/prepare_bundle_runtime/.test(ciCode),
    'ci.yml 不应调用准备脚本：每次 push 下载 22MB + pip 装依赖会把轻量检查变重'
  );
  assert.ok(
    !/tauri\s+build/.test(ciCode),
    'ci.yml 仍不得出现 tauri build（既有反向断言：日常 CI 只检查、不打包）'
  );
});

test('准备脚本的产物目录被 .gitignore 排除（40MB 运行时绝不入库）', () => {
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(
    gitignore,
    /^src-tauri\/runtime\//m,
    '缺少 src-tauri/runtime/ 的忽略规则：一次 `git add -A` 就会把 40MB 运行时提交进去'
  );
});
