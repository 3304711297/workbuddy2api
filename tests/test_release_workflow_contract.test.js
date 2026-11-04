// 安装包发版工作流契约（2026-11-04 新增）
//
// 边界（改动前必读）：
//   GitHub Release 只作为「安装包分发渠道」，供没有 Rust/Node 工具链的用户直接安装；
//   应用内自动更新**不读** Release，仍走 commit SHA 比对 + 就地重建
//   （见 test_app_update_contract.test.js 第一条：update.rs 不得请求 releases API）。
//
// 本测试锁三件事，每一条都对应一个真实会静默出错的改法：
//   ① 有人把构建「优化」成 `--no-bundle`：Release 照常发布，只是里面没有安装包，
//      直到用户下载时才发现（无报错、无失败）。
//   ② 有人把 tauri build 挪回 ci.yml：每次 push 都多烧 5~15 分钟 windows runner，
//      而 CI 的职责只是检查。
//   ③ 版本校验被删掉：tag v0.3.0 配 tauri.conf.json 0.2.1 会发出版本号说谎的安装包。
//
// 断言前先剥离 YAML 注释 —— 注释里解释了「为什么不能用 --no-bundle」，
// 不剥离会让负向断言（不得出现 --no-bundle）永远失败，也会掩盖真正的代码位置。

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

test('release.yml 只在 v* tag 与手动触发时运行（不得挂 main push）', () => {
  assert.match(releaseCode, /workflow_dispatch:/, '缺少 workflow_dispatch：手动补发安装包将无从触发');
  assert.match(releaseCode, /tags:\s*\n\s*-\s*['"]?v\*['"]?/, "缺少 tags: ['v*'] 触发条件");
  const onBlock = releaseCode.split(/\r?\n(?!\s)/).find((b) => /^on:/.test(b)) ?? '';
  assert.ok(
    !/branches:/.test(onBlock),
    'release.yml 的 on: 段出现 branches:：会把完整打包挂到每次 push 上（CI 已负责检查，不应重复烧 runner）'
  );
});

test('release.yml 必须真打安装包，禁止 --no-bundle', () => {
  assert.match(releaseCode, /npm run tauri build/, '缺少 npm run tauri build：安装包根本没被构建');
  assert.ok(
    !/--no-bundle/.test(releaseCode),
    'release.yml 出现 --no-bundle：Release 会变成一个没有安装包的 Release，且流水线照样绿'
  );
  assert.ok(
    !/cargo\s+build\s+--release/.test(releaseCode),
    '禁止裸 cargo build --release：custom-protocol 只有 tauri CLI 会带，产物是无前端的空壳'
  );
});

test('Release 资产必须包含 NSIS 安装包与 SHA256 校验和', () => {
  assert.match(
    releaseCode,
    /bundle\/nsis\/\*\.exe/,
    '未上传 bundle/nsis/*.exe：Release 里不会有安装包'
  );
  assert.match(releaseCode, /SHA256SUMS\.txt/, '未生成/上传 SHA256SUMS.txt');
  assert.match(releaseCode, /contents:\s*write/, '缺少 permissions: contents: write，无法创建 Release');
});

test('tag 必须与 tauri.conf.json 版本严格一致才允许发版', () => {
  assert.match(releaseCode, /tauri\.conf\.json/, '版本校验未读 tauri.conf.json');
  assert.match(
    releaseCode,
    /TAG="\$REF_NAME"/,
    'tag 名未经 env 中转：直接把 ${{ github.ref_name }} 插进 run: 属命令注入面'
  );
  // 断言范围必须绑在「直接插值」这个违规形态上，而不是全文 grep：
  // env: 段里的 REF_NAME: ${{ github.ref_name }} 正是允许的中转用法。
  const refNameLines = releaseCode
    .split(/\r?\n/)
    .filter((line) => line.includes('${{ github.ref_name }}'));
  assert.strictEqual(
    refNameLines.length,
    1,
    `\${{ github.ref_name }} 应只在 env 中转处出现一次，实际出现 ${refNameLines.length} 次：` +
      refNameLines.join(' | ')
  );
  assert.match(
    refNameLines[0],
    /^\s*REF_NAME:\s*\$\{\{\s*github\.ref_name\s*\}\}\s*$/,
    '${{ github.ref_name }} 必须且只能出现在 env: 的 REF_NAME 赋值行'
  );
  assert.match(
    releaseCode,
    /"\$TAG"\s*!=\s*"v\$CONF_VER"/,
    '缺少 tag == v<tauri.conf version> 的 fail-closed 校验'
  );
});

test('产物尺寸判据必须是安装包量级，不得套用主 exe 的 10MB', () => {
  assert.match(
    releaseCode,
    /"\$size"\s+-lt\s+1048576/,
    '缺少 1MB 松散下限（应为 "$size" -lt 1048576）'
  );
  assert.ok(
    !/10485760/.test(releaseCode),
    '仍在使用 10MB 下限：那是主二进制的判据，NSIS 是 LZMA 压缩体（13.6MB exe 压到约 3.5MB），' +
      '实测会把正常安装包误判成残损并中止发版'
  );
});

test('产物文件名必须与版本号绑定，防止传错包', () => {
  assert.match(
    releaseCode,
    /workbuddy2api_\$\{VER\}_x64-setup\.exe/,
    '未断言 workbuddy2api_${VER}_x64-setup.exe：版本号与安装包不匹配时不会失败'
  );
});

test('SHA256SUMS 只写文件名，用户下到同目录即可校验', () => {
  assert.match(
    releaseCode,
    /\(cd "\$\(dirname "\$expected"\)" && sha256sum "\$\(basename "\$expected"\)"\) > SHA256SUMS\.txt/,
    'SHA256SUMS 必须 cd 到产物目录、只写 basename：带 src-tauri/... 前缀的路径会让用户下载后 ' +
      '`sha256sum -c` 必然找不到文件（2026-11-04 实测踩到）'
  );
});

test('ci.yml 保持「只检查、不打包」', () => {
  assert.ok(
    !/tauri\s+build/.test(ciCode),
    'ci.yml 出现了 tauri build：日常 CI 不再轻量，每次 push 都要付完整打包成本'
  );
  assert.ok(!/bundle\/nsis/.test(ciCode), 'ci.yml 不应涉及 NSIS 产物路径');
  assert.ok(!/--no-bundle/.test(ciCode), 'ci.yml 不应出现打包相关参数');
});
