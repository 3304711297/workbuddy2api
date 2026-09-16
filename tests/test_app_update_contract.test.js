// 应用更新契约测试（2026-09-16）
//
// 背景：本项目**不使用 GitHub Release 发版**。更新检测与 Hermes Desktop 对齐：
//   ① 被动查询 GitHub API 取远端 main 的 tip SHA，与本机 HEAD 比对；
//   ② 仅当 tip 不同才走 compare 端点取 ahead_by（= 落后数）与 commit 列表；
//   ③ 应用更新是「退出 GUI → 独立脚本 git 快进 + 重建 → 自动拉起」。
//
// 本测试锁定四件事：
//   1. Rust 侧不再引用 Release API（防止有人「顺手改回去」）；
//   2. 检测判据必须是 commit sha 比对，且 ahead_by==0 判为「无更新」（本地领先防误报）；
//   3. 更新走交接式脚本，脚本必须包含 --ff-only、tauri build 与产物校验；
//   4. 前端弹窗结构与 Rust 序列化字段名一致（snake_case），且 JSON 走 textContent。

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const updateRs = readFileSync(join(root, 'src-tauri', 'src', 'commands', 'update.rs'), 'utf8');
const libRs = readFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const updateJs = readFileSync(join(root, 'src', 'update-check.js'), 'utf8');
const changelogJs = readFileSync(join(root, 'src', 'commit-changelog.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const handoff = readFileSync(join(root, 'scripts', 'app-update', 'windows.ps1'), 'utf8');

// Rust 注释里提到 Release 是在解释「为何不用它」，断言需剥离注释后再看代码。
function stripRustComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const updateRsCode = stripRustComments(updateRs);

test('Rust 侧不得再使用 GitHub Release API 作为更新来源', () => {
  assert.ok(
    !/releases\/latest/.test(updateRsCode),
    'update.rs 仍在请求 releases/latest：Release 路径已废弃（改用 commit 比对）'
  );
  assert.ok(
    !/release_url/.test(updateRsCode),
    'update.rs 仍产出 release_url 字段：前端已不再消费它'
  );
  assert.ok(
    !/tag_name/.test(updateRsCode),
    'update.rs 仍在解析 tag_name：语义已改为 commit sha 比对'
  );
});

test('检测走 GitHub API：tip SHA + compare，且不做 git fetch 轮询', () => {
  assert.ok(
    /repos\/\{slug\}\/commits\/\{branch\}/.test(updateRsCode),
    '缺少 tip SHA 查询端点（被动检测的基础）'
  );
  assert.ok(
    /application\/vnd\.github\.sha/.test(updateRsCode),
    '缺少 application/vnd.github.sha 媒体类型：会退回完整 commit JSON，浪费带宽'
  );
  assert.ok(
    /compare\/\{base\}\.\.\.\{head\}/.test(updateRsCode),
    '缺少 compare 端点：拿不到 behind 数与 commit 列表'
  );
  assert.ok(
    !/'fetch'/.test(updateRsCode) && !/"fetch"/.test(updateRsCode),
    'update.rs 出现 git fetch：被动检测不应拉 pack（多客户端会触发 GitHub 429）'
  );
});

test('ahead_by==0 但 tip 不同必须判为「无更新」（本地领先防误报）', () => {
  // 这是最危险的误报：把「本地领先」说成「有更新」会诱导用户用远端覆盖自己的提交。
  const decideIdx = updateRsCode.indexOf('fn decide(');
  assert.ok(decideIdx > -1, '未找到 decide 函数');
  const body = updateRsCode.slice(decideIdx, decideIdx + 700);
  assert.ok(
    /Some\(\(0,\s*_\)\)\s*=>\s*\(Some\(0\),\s*false/.test(body),
    'decide 未把 ahead_by==0 判为无更新 —— 本地领先会被误报成可更新'
  );
});

test('compare 失败时保持「有更新、数量未知」，绝不编造数字', () => {
  const decideIdx = updateRsCode.indexOf('fn decide(');
  const body = updateRsCode.slice(decideIdx, decideIdx + 700);
  assert.ok(
    /None\s*=>\s*\(None,\s*true/.test(body),
    'compare 失败时 behind 应为 None（未知）且仍判定有更新，不得伪造计数'
  );
});

test('检测结果缓存以 HEAD + 分支为键（更新后立即可失效）', () => {
  const idx = updateRsCode.indexOf('fn cache_is_fresh');
  assert.ok(idx > -1, '未找到 cache_is_fresh');
  const body = updateRsCode.slice(idx, idx + 500);
  assert.ok(
    /cached\.current_sha\s*!=\s*current_sha/.test(body) && /cached\.branch\s*!=\s*branch/.test(body),
    '缓存未以 HEAD+分支为键：刚更新完仍会显示「有更新」'
  );
});

test('apply_app_update 已注册到 Tauri 命令表', () => {
  assert.ok(
    /commands::apply_app_update/.test(libRs),
    'lib.rs 未注册 apply_app_update：前端调用会报 command not found'
  );
});

test('交接脚本必须用 --ff-only 快进（绝不覆盖用户提交）', () => {
  assert.ok(/merge',\s*'--ff-only'/.test(handoff), '脚本未用 --ff-only：本地领先/分叉时会产生合并提交或覆盖用户提交');
  assert.ok(!/reset',\s*'--hard',\s*'origin/.test(handoff), '脚本用 reset --hard 覆盖工作树：会丢用户提交');
  assert.ok(/stash/.test(handoff), '脚本未处理未提交改动（更新会因冲突失败或丢失改动）');
});

test('交接脚本必须走 tauri CLI 重建，并校验产物真伪', () => {
  // 裸 cargo build --release 会静默产出无前端的空壳 exe，是本仓库已知坑。
  // 注意：脚本注释里刻意写了这句警示语，断言前必须剥离注释，否则会误伤自己。
  const code = handoff
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');

  assert.ok(
    /@\(\s*'tauri'\s*,\s*'build'\s*,\s*'--no-bundle'\s*\)/.test(code),
    '脚本未使用 cargo tauri build --no-bundle（裸 cargo build 会产出空壳 exe）'
  );
  assert.ok(
    !/'build'\s*,\s*'--release'\s*,\s*'--no-bundle'/.test(code),
    '脚本出现裸 cargo build --release：会静默产出无前端的空壳'
  );
  assert.ok(/SHELL_BASELINE_BYTES/.test(code), '脚本缺少空壳基准尺寸校验');
  assert.ok(/index-\*\.js/.test(code), '脚本未校验前端资源是否内嵌进 exe');
});

test('交接脚本必须等 GUI 退出并能在失败后回滚', () => {
  assert.ok(/Get-Process -Id \$GuiPid/.test(handoff), '脚本未等待发起更新的 GUI 退出');
  assert.ok(/回滚/.test(handoff), '脚本缺少失败回滚（构建失败会把用户留在半更新状态）');
  assert.ok(/Start-WorkBuddy/.test(handoff), '脚本未在完成后拉起应用');
});

// ---------------------------------------------------------------------------
// 启动确认 + 阶段进度 + 失败分级（借鉴 EasyCLIProxyAPI）
// ---------------------------------------------------------------------------

test('脚本必须做启动确认，失败则回滚（防止把用户留在崩溃版本上）', () => {
  // 参照 EasyCLIProxyAPI 的 ack 等待：拉起新版后必须验证它真的可用，
  // 否则新版启动即崩时用户会被反复拉回同一个坏版本。
  assert.ok(/function Wait-WorkBuddyHealthy/.test(handoff), '缺少启动确认函数');
  assert.ok(
    /Wait-WorkBuddyHealthy\s+-Process/.test(handoff),
    '拉起新版后未调用启动确认'
  );
  // 确认必须同时覆盖「进程存活」与「服务可用」两个层面
  assert.ok(/HasExited/.test(handoff), '启动确认未检查进程是否立即退出');
  assert.ok(
    /PROXY_HEALTH_URL|v1\/models/.test(handoff),
    '启动确认未做 8787 反代探活（GUI 活着但内核没起来不算成功）'
  );
  // 确认失败必须走回滚，而不是照常 exit 0
  assert.ok(
    /startup-unhealthy/.test(handoff),
    '启动确认失败未归类为 startup-unhealthy（会被当成功处理）'
  );
  assert.ok(
    /回滚后.*重建|重新构建回滚后的版本/.test(handoff),
    '回滚后未重建：源码回旧版但 exe 仍是坏的新版'
  );
});

test('脚本必须写阶段状态文件供 GUI 轮询（不留黑屏）', () => {
  assert.ok(/function Write-State/.test(handoff), '缺少阶段状态写入函数');
  assert.ok(/StatePath/.test(handoff), '脚本未接收状态文件路径参数');
  // 状态文件必须原子替换，否则 GUI 会读到半截 JSON
  assert.ok(/Move-Item/.test(handoff), '状态文件未做原子替换（GUI 可能读到半截 JSON）');

  // 阶段名必须与前端 UPDATE_PHASES 及 index.html 步骤条三处完全一致
  const phases = [
    'preparing', 'fetching', 'merging', 'deps',
    'frontend', 'building', 'verifying', 'restarting',
  ];
  for (const p of phases) {
    assert.ok(new RegExp(`-Phase '${p}'`).test(handoff), `脚本未上报 ${p} 阶段`);
    assert.ok(
      new RegExp(`'${p}'`).test(updateJs),
      `前端 UPDATE_PHASES 缺少 ${p}（步骤条会错位）`
    );
    assert.ok(
      html.includes(`data-step="${p}"`),
      `index.html 步骤条缺少 ${p}`
    );
  }
});

test('失败分类必须在脚本、Rust 契约与前端提示三处对齐', () => {
  // 脚本抛出的 kind
  const kinds = [
    'fetch-failed', 'diverged', 'stash-failed', 'deps-failed',
    'frontend-build-failed', 'rust-build-failed', 'artifact-suspicious',
    'startup-unhealthy', 'gui-exit-timeout',
  ];
  for (const k of kinds) {
    assert.ok(
      new RegExp(`'${k}'`).test(handoff),
      `脚本未产出失败分类 ${k}`
    );
    assert.ok(
      new RegExp(`['"]?${k}['"]?\\s*:`).test(updateJs),
      `前端 FAILURE_HINTS 缺少 ${k}（用户只能看到笼统的「更新失败」）`
    );
  }
  // 分级必须落到状态文件字段上
  assert.ok(/failureKind/.test(handoff), '脚本未把失败分类写进状态文件');
  assert.ok(/failure_kind/.test(updateRs), 'Rust 未解析 failureKind → failure_kind');
  assert.ok(/state\.failure_kind/.test(updateJs), '前端未消费 failure_kind 字段');
});

test('app_update_state 命令已注册且容忍文件缺失/半截 JSON', () => {
  assert.ok(
    /commands::app_update_state/.test(libRs),
    'lib.rs 未注册 app_update_state：进度轮询会报 command not found'
  );
  // 三条容错路径都必须返回 None 而不是 Err：
  //   ① 文件缺失（从未更新过）② JSON 半截（脚本正在写）③ BOM 前缀（PS 5.1 写入）
  const idx = updateRs.indexOf('pub fn app_update_state');
  assert.ok(idx > -1, '未找到 app_update_state');
  // 取足够长的窗口覆盖到解析分支（含 BOM 剥离与注释）
  const body = updateRs.slice(idx, idx + 1600);

  assert.ok(
    /fs::read_to_string\(&path\)\s*else\s*\{[\s\S]{0,120}?return Ok\(None\)/.test(body),
    '文件缺失时未返回 Ok(None)（会让前端弹错误）'
  );
  assert.ok(
    /serde_json::from_str[\s\S]{0,200}?else\s*\{[\s\S]{0,200}?return Ok\(None\)/.test(body),
    'JSON 解析失败（脚本正在写入 / BOM 前缀）未降级为 None'
  );
  // BOM 必须被剥离：否则 serde_json 直接失败，整条进度显示静默失效
  assert.ok(
    /trim_start_matches\('\\u\{feff\}'\)/.test(body),
    '未剥离 UTF-8 BOM：PS 5.1 写入的状态文件会让进度显示整体失效'
  );
});

test('apply_app_update 发起前必须清理上一次的状态残留', () => {
  // 否则前端可能把上次的 done/failed 当成本次进度，误判更新已完成
  const idx = updateRs.indexOf('pub fn apply_app_update');
  const body = updateRs.slice(idx, idx + 1200);
  assert.ok(
    /remove_file\(&state_path\)/.test(body),
    '未清理旧状态文件：上一次的 done/failed 会被当成本次进度'
  );
});

test('前端必须支持接续进行中的更新（重开应用后继续显示进度）', () => {
  assert.ok(/resumeInFlightUpdate/.test(updateJs), '缺少接续逻辑：重开应用后进度丢失，用户会重复点击');
  assert.ok(/rolling-back/.test(updateJs), '进行中阶段白名单缺少 rolling-back');
  // 轮询必须能停止，否则离开视图后仍在后台打 IPC
  assert.ok(/function stopUpdatePolling/.test(updateJs), '缺少停止轮询的函数');
  assert.ok(/clearInterval/.test(updateJs), '未真正清除定时器');
});


test('弹窗包含 Hermes 同款结构：变更列表 + 立即更新 + 稍后再说', () => {
  for (const id of [
    'update-overlay',
    'update-status-view',
    'update-available-view',
    'update-applying-view',
    'update-changelog',
    'update-now',
    'update-later',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}（弹窗结构不完整）`);
  }
  assert.ok(html.includes('立即更新'), 'index.html 缺少「立即更新」按钮文案');
  assert.ok(html.includes('稍后再说'), 'index.html 缺少「稍后再说」按钮文案');
  assert.ok(html.includes('有可用更新'), 'index.html 缺少「有可用更新」标题');
});

test('更新字段走 snake_case，与 Rust 序列化结果一致', () => {
  // Rust 结构体无 rename_all 时按字段名原样序列化（snake_case）；
  // 写成驼峰会静默取到 undefined（本仓库踩过同类坑）。
  assert.ok(/pub update_available: bool/.test(updateRs), 'Rust 侧应有 update_available 字段');
  assert.ok(/pub current_sha: String/.test(updateRs), 'Rust 侧应有 current_sha 字段');
  assert.ok(/pub target_sha: Option<String>/.test(updateRs), 'Rust 侧应有 target_sha 字段');
  assert.ok(/info\.update_available/.test(updateJs), '前端必须读 snake_case 的 update_available');
  assert.ok(!/info\.updateAvailable/.test(updateJs), '前端不得读 camelCase（会静默 undefined）');
  assert.ok(/info\.current_sha/.test(updateJs), '前端必须读 snake_case 的 current_sha');
});

test('远端 commit 标题必须以 textContent 渲染（不得当 HTML 注入）', () => {
  // commit summary 来自远端仓库，对本应用是不可信输入
  const idx = updateJs.indexOf('update-group-list');
  assert.ok(idx > -1, 'update-check.js 未渲染变更列表');
  const body = updateJs.slice(idx, idx + 500);
  assert.ok(
    /\.textContent\s*=\s*item/.test(body),
    '变更条目未用 textContent 填充：远端 commit 标题可注入 HTML'
  );
  assert.ok(!/innerHTML/.test(updateJs), 'update-check.js 使用了 innerHTML');
});

test('changelog 分组过滤内部噪音类型且永不返回空列表', () => {
  // 工程内部事务（chore/ci/docs/test…）对用户无意义；全被过滤时要退化为占位而不是空弹窗
  assert.ok(/HIDDEN_TYPES/.test(changelogJs), '缺少 HIDDEN_TYPES 过滤集');
  for (const t of ['chore', 'ci', 'docs', 'test']) {
    assert.ok(new RegExp(`'${t}'`).test(changelogJs), `HIDDEN_TYPES 未包含 ${t}`);
  }
  assert.ok(/FALLBACK_GROUP/.test(changelogJs), '缺少兜底分组（全部被过滤会渲染空弹窗）');
  assert.ok(/result\.length === 0/.test(changelogJs), '未对空结果做兜底判断');
});
