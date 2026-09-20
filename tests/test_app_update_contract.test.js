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
import { spawnSync } from 'node:child_process';
import { stripRustComments } from './helpers/strip-rust-comments.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const updateRs = readFileSync(join(root, 'src-tauri', 'src', 'commands', 'update.rs'), 'utf8');
const libRs = readFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
const updateJs = readFileSync(join(root, 'src', 'update-check.js'), 'utf8');
const changelogJs = readFileSync(join(root, 'src', 'commit-changelog.js'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const handoff = readFileSync(join(root, 'scripts', 'app-update', 'windows.ps1'), 'utf8');

// Rust 注释里提到 Release 是在解释「为何不用它」，断言需剥离注释后再看代码。
// 剥离实现见 helpers/strip-rust-comments.mjs（含「为什么不能用逐行正则」的说明）。
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

test('「无更新」缓存必须短于「有更新」（键里没有远端 tip，长缓存会挡住新提交）', () => {
  // 真实踩到：exe=3d094fc、远端已到 514fad9，24h 的「已是最新」缓存让
  // 「检查更新」根本不发请求，弹窗复读启动时的旧答案。缓存键不含远端 tip
  // 是有意妥协，因此「无更新」TTL 必须短（10min）；「有更新」可 24h——
  // 它不会骗人，用户下一步就是点「立即更新」。
  const idx = updateRsCode.indexOf('const CHECK_CLEAN_TTL_MS');
  assert.ok(idx > -1, '缺少「无更新」专用 TTL 常量 CHECK_CLEAN_TTL_MS');
  const ttlBlock = updateRsCode.slice(
    updateRsCode.indexOf('const CHECK_TTL_MS'),
    updateRsCode.indexOf('const CHECK_FAILURE_TTL_MS')
  );
  const ms = (name) => {
    const m = updateRsCode.match(new RegExp(`const ${name}[^=]*=\\s*([^;]+);`));
    assert.ok(m, `未找到常量 ${name}`);
    // 仅支持本文件现有的「N * 单位」纯数字表达式，出现非常量运算即红
    return m[1];
  };
  const cleanTtl = eval(ms('CHECK_CLEAN_TTL_MS')); // eslint-disable-line no-eval -- 测试文件内受控常量
  const availTtl = eval(ms('CHECK_TTL_MS')); // eslint-disable-line no-eval
  assert.ok(cleanTtl < availTtl, '「无更新」TTL 必须 < 「有更新」TTL');
  assert.ok(cleanTtl <= 30 * 60 * 1000, '「无更新」TTL 超过 30 分钟：远端新提交会被旧缓存挡住');

  // cache_is_fresh 必须按 update_available 分流 TTL
  const fnBody = updateRsCode.slice(updateRsCode.indexOf('fn cache_is_fresh'), updateRsCode.indexOf('fn decide'));
  assert.ok(
    /cached\.update_available/.test(fnBody) && /CHECK_CLEAN_TTL_MS/.test(fnBody),
    'cache_is_fresh 未按「有/无更新」分流 TTL'
  );
});

test('「检查更新」入口点击必须绕过缓存实时实查（force: true）', () => {
  // 入口点击的用户语义是「现在去 GitHub 问一次」。若传 force: false，
  // 会命中 Rust 侧磁盘缓存，远端推新后仍显示「已是最新」且毫无反应（真实踩到）。
  // 锚点用绑定处的独特注释（runCheck 函数体内也出现 el('update-entry')，
  // 不能作锚点）；锁定的是 init 里入口的 onClick。
  const anchor = updateJs.indexOf('入口点击：一律打开弹窗并**强制实时**检查');
  assert.ok(anchor > -1, '未找到入口点击绑定处的注释锚点（init 的 onClick 可能被改动）');
  const section = updateJs.slice(anchor, anchor + 400);
  assert.ok(
    /runCheck\(\{\s*silent:\s*false,\s*force:\s*true\s*\}\)/.test(section),
    '入口点击未传 force: true：会吃到磁盘缓存，远端推新后显示「已是最新」'
  );
  // 兜底：runCheck 定义处默认值必须是 force: false（静默检查不吃 API 额度）
  const defIdx = updateJs.indexOf('async function runCheck(');
  const defSection = updateJs.slice(defIdx, defIdx + 120);
  assert.ok(
    /force\s*=\s*false/.test(defSection),
    'runCheck 默认值不是 force: false：启动静默检查会绕过缓存打 API'
  );
  // 启动静默检查保持走缓存（避免每次启动都打 GitHub API），不在此断言范围内。
});

test('apply_app_update 已注册到 Tauri 命令表', () => {
  assert.ok(
    /commands::apply_app_update/.test(libRs),
    'lib.rs 未注册 apply_app_update：前端调用会报 command not found'
  );
});

test('更新脚本 spawn 既不隐藏控制台也不静默失效（控制台是用户看进度的窗口）', () => {
  // 历史三重教训（逐条实测过，改动前必读）：
  //   ① DETACHED_PROCESS(0x8)：PowerShell/pwsh spawn 成功但**静默不执行任何脚本**
  //      就退出（无 console 可初始化）→「点更新闪退、无日志、无状态文件」。
  //   ② CREATE_NO_WINDOW(0x08000000)：脚本能跑，但**控制台被完全隐藏** ——
  //      用户看不到任何进度（2026-09-20 用户实测反馈：Hermes 有窗口、本工具没有）。
  //   ③ CREATE_NEW_CONSOLE(0x10)：可跑且有窗口，但窗口标题栏是 powershell 的默认外观
  //      且不经 cmd 包装，脱离性不如 `cmd start /min`（Hermes 采用后者）。
  //
  // 当前方案（对齐 Hermes apps/desktop/electron/updater-process.ts）：经
  // `cmd /d /s /c start "" /min powershell ...` 启动 —— cmd 立即退出、脚本获得
  // 自己的最小化控制台，既解决 console 初始化又呈现进度。
  //
  // ⚠️ **断言范围必须限定在 apply_app_update 内**（2026-09-20 收窄）：本文件别处
  // 的 `working_tree_dirty` 会跑 `git status`，那里用 CREATE_NO_WINDOW 抑制黑框闪窗
  // 是**正当**的（GUI 调命令行工具的常规防御，与更新脚本的控制台无关）。扫全文会
  // 把这类合法用法判成回归 —— 约束要绑在被约束的那个 spawn 点，不是整个文件。
  const code = stripRustComments(updateRs);
  const fnStart = code.indexOf('pub fn apply_app_update');
  assert.ok(fnStart > 0, '未找到 apply_app_update 定义');
  // 函数体：从定义起到下一个顶格 '}'（Rust 顶层 fn 的收尾）。
  // ⚠️ stripRustComments 保留 `\r`（它刻意不吞行尾以保证 LF/CRLF 结果一致），
  // 所以必须按 /\r?\n/ 拆行并 trimEnd，否则 `}` 永远匹配不上顶格行。
  const afterStart = code.slice(fnStart);
  const bodyLines = afterStart.split(/\r?\n/).map((l) => l.trimEnd());
  const endIdx = bodyLines.findIndex((line, i) => i > 0 && line === '}');
  assert.ok(endIdx > 0, 'apply_app_update 函数体边界未找到（顶层 } 缺失）');
  const spawnCode = bodyLines.slice(1, endIdx).join('\n');
  // 反向自检：边界必须落在真正的函数收尾上，而不是别处（否则断言范围会失控或为空）。
  assert.ok(
    spawnCode.includes('cmd.exe') && spawnCode.includes('/min'),
    'apply_app_update 函数体切片异常：未包含预期的 cmd start /min 启动代码 —— ' +
      '边界定位不可信，后续断言等于没验证'
  );

  assert.ok(
    !/DETACHED_PROCESS/.test(spawnCode),
    'spawn 使用了 DETACHED_PROCESS：PowerShell 会静默不执行脚本（无声闪退根因）'
  );
  assert.ok(
    !/CREATE_NO_WINDOW/.test(spawnCode),
    'spawn 仍设置 CREATE_NO_WINDOW：控制台被隐藏，用户看不到更新进度。' +
      '应改用 cmd start /min 包装（Hermes 同款）'
  );
  assert.ok(
    !/\.creation_flags\s*\(/.test(spawnCode),
    'spawn 仍显式设置 creation_flags：控制台应由 cmd start 分配，勿再干预'
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
  // 探活必须存在，且 URL 必须精确指向免鉴权的 /health（勿改回 /v1/models：
  // 它走 _check_auth，配密钥用户探活恒 401 → 误判 startup-unhealthy → 错误回滚）。
  // 端点契约的独立对拍在下方「探活端点必须免鉴权」用例；此处锁「变量存在 + 精确拼装」。
  assert.ok(
    /PROXY_HEALTH_URL = "http:\/\/127\.0\.0\.1:\$Port\/health"/.test(handoff),
    '启动确认未做反代探活，或探活 URL 不是由 $Port 拼装的免鉴权 /health（GUI 活着但内核没起来不算成功）'
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

  // 阶段名在脚本上报与前端阶段列表中必须覆盖
  const phases = [
    'preparing', 'fetching', 'merging', 'deps',
    'frontend', 'building', 'verifying', 'restarting',
  ];
  for (const p of phases) {
    assert.ok(new RegExp(`-Phase '${p}'`).test(handoff), `脚本未上报 ${p} 阶段`);
    assert.ok(
      new RegExp(`'${p}'`).test(updateJs),
      `前端 UPDATE_PHASES 缺少 ${p}`
    );
  }

  // 前端弹窗必须包含 Hermes 原生 4-view 结构（检测状态、可用更新、交接中视图）
  assert.ok(html.includes('id="update-status-view"'), 'index.html 缺少 #update-status-view');
  assert.ok(html.includes('id="update-available-view"'), 'index.html 缺少 #update-available-view');
  assert.ok(html.includes('id="update-applying-view"'), 'index.html 缺少 #update-applying-view');
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


test('版本比对必须用烘焙 sha，不得读工作树 HEAD', () => {
  // 真实踩到的谎报：exe 构建自 88b0f7e，工作树已被 pull 到 d1cb787，
  // 检测读工作树 → 与远端一致 → 报「已是最新」，而运行中的产物落后 3 个提交。
  assert.ok(
    /let current_sha = build_sha\(\)\.to_string\(\)/.test(updateRs),
    'current_sha 未取自 build_sha()：读工作树会把「运行的是旧版本」谎报成「已是最新」'
  );
  assert.ok(
    !/let current_sha = read_git_head/.test(updateRs),
    'current_sha 又改回读工作树 HEAD —— 会再次谎报「已是最新」'
  );
  // 生产代码里不应再存在「读工作树 HEAD」的函数：它已无合法用途，留着只会被误用
  const prodOnly = updateRs.split('#[cfg(test)]')[0] || updateRs;
  assert.ok(
    !/fn read_git_head/.test(prodOnly),
    '生产代码仍保留读工作树 HEAD 的函数：版本判定必须用烘焙 sha，工作树 HEAD 会被 pull 推进而谎报「已是最新」'
  );
  // build.rs 必须把构建提交注入二进制，并在 HEAD/分支变化时重编
  const buildRs = readFileSync(join(root, 'src-tauri', 'build.rs'), 'utf8');
  assert.ok(
    /cargo:rustc-env=WORKBUDDY2API_BUILD_SHA=/.test(buildRs),
    'build.rs 未注入构建 sha：运行时无从知道本 exe 是哪个提交构建的'
  );
  assert.ok(
    /rerun-if-changed=\.\.\/\.git\/HEAD/.test(buildRs),
    'build.rs 未在 .git/HEAD 变化时重编：新提交后 sha 会陈旧'
  );
});

test('脚本判定「是否需要重建」必须基于运行版本，而非远端差异', () => {
  // 工作树可能已被用户手动 pull（或上次更新中断），此时远端无新提交但
  // 跑着的 exe 是旧的。只看远端会得出「无需重建」→ 点了更新却什么都没发生。
  assert.ok(
    /\$CurrentBuildSha = ''/.test(handoff),
    '脚本未声明 CurrentBuildSha 参数（无法判断工作树与产物是否一致）'
  );
  assert.ok(
    /-CurrentBuildSha/.test(updateRs),
    'Rust 侧未把运行版本的构建提交传给脚本'
  );
  assert.ok(
    /\$CurrentBuildSha -ne \$previousSha/.test(handoff),
    '未比较「运行版本 vs 工作树」：工作树领先时会误判为无需重建'
  );
  assert.ok(
    /\$needsRebuild/.test(handoff),
    '缺少 needsRebuild 判定（重建条件不只取决于远端是否有新提交）'
  );
  // 拿不到构建 sha 时必须保守重建，而不是跳过
  assert.ok(
    /-not \$CurrentBuildSha -or \$CurrentBuildSha -eq 'unknown'[\s\S]{0,200}?\$needsRebuild = \$true/.test(handoff),
    '构建 sha 未知时未保守重建（无 git 构建的产物会永久无法更新）'
  );
});

test('版本指纹只含版本与提交（与 Hermes 形态一致，不含日期）', () => {
  const vite = readFileSync(join(root, 'vite.config.js'), 'utf8');
  assert.ok(
    /v\$\{pkg\.version\} \$\{gitHash\}/.test(vite),
    '指纹形态应为 `v<版本> <提交>`（与 Hermes 的 v0.21.3 784d5c3 一致）'
  );
  assert.ok(
    !/buildDate|BUILD_DATE/.test(vite),
    '指纹仍含构建日期：日期无可行动信息且随每次构建漂移，会让人误以为内容变了'
  );
  // 界面必须直接显示「版本 + 提交」，而不是只显示版本号
  assert.ok(
    /verEl\.textContent = hash \? `v\$\{ver\} \$\{hash\}`/.test(updateJs),
    '版本标识未显示构建提交：无法一眼判断界面对应的产物是哪个提交'
  );
  assert.ok(
    /__GIT_HASH__/.test(updateJs),
    '前端未读取 __GIT_HASH__'
  );
});

test('健康检查端口必须来自配置，不得在更新链路写死 8787', () => {
  // 真实回归风险：用户把端口配成 9000 时新版会正常监听 9000，而写死 8787 的探活
  // 必然失败 → 90s 后误判 startup-unhealthy → 把**正常的新版**回滚掉。
  // 端口真源与 Hermes 接入检测同一条：load_app_config().port。
  assert.ok(
    /let port = crate::load_app_config\(\)\.port;/.test(updateRs),
    'apply_app_update 未从 load_app_config().port 取端口（会与 Hermes 检测的判据分叉）'
  );
  assert.ok(
    /\.arg\("-Port"\)[\s\S]{0,80}?\.arg\(port\.to_string\(\)\)/.test(updateRs),
    'Rust 侧未把端口传给更新脚本'
  );

  // 脚本侧：参数必须声明且为必填，探活 URL 必须由端口拼装
  assert.ok(
    /\[Parameter\(Mandatory = \$true\)\]\[int\]\$Port/.test(handoff),
    '脚本未把 Port 声明为必填参数：缺失时会静默退回写死端口'
  );
  assert.ok(
    /http:\/\/127\.0\.0\.1:\$Port\/health/.test(handoff),
    '探活 URL 未由 $Port 拼装 / 未指向免鉴权端点'
  );

  // ⚠️ 必须探免鉴权端点：/v1/models 走 _check_auth，配了密钥后无认证请求一律 401。
  // 实测：探 /v1/models 时 Wait-PortReleased 在 0.1s 内因 401 误判「端口已释放」，
  // 且 90s 健康检查全 401 → 误判 startup-unhealthy → 把正常的新版回滚掉。
  assert.ok(
    /\/health/.test(handoff) && !/127\.0\.0\.1:\$Port\/v1\/models/.test(handoff),
    '健康检查探了需要鉴权的 /v1/models：配密钥的用户会被误判为启动失败并回滚'
  );

  // 硬编码防线：除注释外，脚本里不得出现裸的 8787 端口字面量。
  // ⚠️ 必须同时剥离块注释 <# ... #>（文档里刻意写了「不得写死 8787」的警示语，
  // 只排除 # 单行注释会把这句警示自己当成违规而误报）。
  const codeOnly = handoff.replace(/<#[\s\S]*?#>/g, '');
  const hardcoded = codeOnly
    .split('\n')
    .filter(l => !l.trimStart().startsWith('#'))
    .filter(l => /8787/.test(l));
  assert.deepEqual(
    hardcoded,
    [],
    `脚本可执行代码里仍有写死的 8787：\n${hardcoded.join('\n')}`
  );
});

test('启动确认必须要求端口先释放（防旧内核残留造成假阳性）', () => {
  // converter.py 没有父进程退出检测（实测：GUI 退出后它变孤儿继续存活）。
  // 若只判「最终可用」，会出现「新版 GUI 启动即崩 → 旧内核仍响应 2xx → 误判成功」，
  // 把崩溃版本当成更新成功留在盘上。
  assert.ok(
    /function Wait-PortReleased/.test(handoff),
    '缺少 Wait-PortReleased：无法证明旧内核已退出，探到的 2xx 可能来自残留进程'
  );
  assert.ok(
    /Wait-PortReleased -Url \$PROXY_HEALTH_URL/.test(handoff),
    '拉起新版前未等待端口释放（诊断结论会指向错误的进程）'
  );
  // ⚠️ 外部评审定级 P1（采纳，推翻旧的 WARN 宽容策略）：uvicorn 端口被占时
  // 实测行为是 create_server 抛 OSError → sys.exit(STARTUP_FAILURE=3)——
  // 新版内核必然起不来，端口上的任何 2xx 都来自残留旧内核。超时必须中止
  // 启动确认进入回滚，绝不允许「放宽判定」后接受来源可疑的 2xx。
  assert.ok(
    /Throw-Failure 'port-not-released'/.test(handoff),
    '端口未释放时未中止启动确认：会接受残留旧内核的 2xx 造成假成功'
  );
  // 「放宽判定」的禁止只查 else 分支体的**可执行行**——解释「为什么不放宽」的
  // 注释行也含这四个字，直接全文匹配会把注释当违规误报
  const wrIdx = handoff.indexOf('if (Wait-PortReleased');
  const elseBody = handoff.slice(
    wrIdx,
    handoff.indexOf("Write-State -Phase 'restarting' -Message '正在启动新版本'")
  );
  const codeLines = elseBody
    .split('\n')
    .filter(l => !l.trimStart().startsWith('#'));
  assert.ok(
    !codeLines.some(l => /放宽判定/.test(l)),
    '仍存在「放宽判定」路径：旧内核残留时继续健康检查必然假成功'
  );
  // 失败分级三处对拍：脚本 kind 必须进入失败提示表
  assert.ok(
    /'port-not-released'\s*\{/.test(handoff),
    '失败提示表缺少 port-not-released 的 hint'
  );
  assert.ok(
    /function Test-ProxyEndpoint/.test(handoff),
    '缺少共用的单次探活函数'
  );
});

test('拉起失败（null 进程）时健康检查必须立即失败，绝不继续探活', () => {
  // Start-WorkBuddy 返回 null 时，端口上的 2xx 只可能来自残留旧内核；
  // 旧实现 `if ($Process -and ...)` 会跳过进程检查继续探活 → 假成功（评审 P1）。
  const fnIdx = handoff.indexOf('function Wait-WorkBuddyHealthy');
  const fnBody = handoff.slice(fnIdx, handoff.indexOf('function Show-FailureMessage'));
  assert.ok(
    /if \(-not \$Process\)/.test(fnBody),
    'Wait-WorkBuddyHealthy 未对 null 进程做立即失败防御'
  );
  // null 防御必须位于探活调用之前（否则防御形同虚设）
  const nullGuard = fnBody.indexOf('if (-not $Process)');
  const probeLoop = fnBody.indexOf('$probe = Test-ProxyEndpoint');
  assert.ok(nullGuard > -1 && probeLoop > nullGuard, 'null 防御不在探活逻辑之前');
  // 不允许旧的宽容写法「$Process -and $Process.HasExited」（null 时静默跳过进程检查）
  assert.ok(
    !/\$Process -and \$Process\.HasExited/.test(fnBody),
    '仍存在「$Process -and HasExited」宽容写法：null 进程会绕过进程检查继续探活'
  );
});

test('启动确认失败回滚前必须先终止本次拉起的新版 GUI（按 PID 精确）', () => {
  // 新版 GUI 活着时持有 exe 文件锁，不先终止会让回滚的 cargo build 撞占用失败
  // （Windows 下运行中的 EXE 不能被覆盖）。必须按本次 Start-WorkBuddy 返回的
  // PID 精确终止，禁止按 exe 名称全杀（避免误杀用户手动另开的实例）。
  // 锚点取 catch 分支内的注释行（块注释 L282 附近也含相似字样，不能作锚点）
  const killAnchor = handoff.indexOf('# 健康确认失败时新版 GUI 可能仍活着并持有 exe 文件锁');
  assert.ok(killAnchor > -1, 'catch 分支缺少终止新版 GUI 的处理块');
  const stopBlock = handoff.slice(killAnchor, killAnchor + 900);
  assert.ok(/Stop-Process -Id \$proc\.Id/.test(stopBlock), '未按 $proc.Id 精确终止');
  assert.ok(!/Stop-Process[^\n]*-Name/.test(stopBlock), '按进程名终止会误杀用户手动另开的实例');
  // 终止后必须等真正退出再回滚（含内核子进程释放端口与文件句柄）
  assert.ok(/Get-Process -Id \$proc\.Id/.test(stopBlock), '终止后未确认进程退出');
});

test('stash 恢复必须晚于所有回滚点（防用户未提交改动被静默抹掉）', () => {
  // 实测复现的数据丢失路径：旧代码在第 6 步（产物校验后）就 `stash pop`，
  // 一旦启动确认失败触发 `git reset --hard $previousSha`，刚弹回的改动会被一并抹掉，
  // 而 catch 分支的第二次 pop 只得到「No stash entries found」——改动静默丢失。
  const pops = [...handoff.matchAll(/git stash pop/g)].map(m => m.index);
  assert.ok(pops.length >= 2, '预期至少两处 stash 恢复点（成功路径 + 回滚路径）');

  // reset --hard 的位置：所有 pop 都必须晚于它（回滚路径）或位于不回滚的分支（成功路径）
  const resets = [...handoff.matchAll(/Arguments @\('reset', '--hard'/g)].map(m => m.index);
  assert.ok(resets.length >= 1, '未找到回滚点');

  // 关键断言：不得存在「pop 之后还有可能执行 reset --hard」的顺序。
  // 用标记法验证：成功路径的 pop 必须出现在 `Wait-WorkBuddyHealthy` 调用之后。
  const healthIdx = handoff.indexOf('$health = Wait-WorkBuddyHealthy');
  assert.ok(healthIdx > 0, '未找到启动确认调用');
  const okBranchPop = handoff.indexOf('stash', healthIdx);
  assert.ok(
    okBranchPop > healthIdx,
    '成功路径的 stash 恢复未放在启动确认之后：回滚的 reset --hard 会抹掉用户改动'
  );

  // 「无更新」早退路径的 pop 必须在 `needsRebuild` 判定分支内（该路径不回滚）
  const noRebuildIdx = handoff.indexOf('if (-not $needsRebuild)');
  const noRebuildPop = handoff.indexOf('stash', noRebuildIdx);
  const rebuildEnd = handoff.indexOf('# ── 4. 依赖与前端重建', noRebuildIdx);
  assert.ok(
    noRebuildPop > noRebuildIdx && noRebuildPop < rebuildEnd,
    '「无更新」早退路径的 stash 恢复不在该分支内'
  );
});

test('探活端点必须免鉴权（/health 而非 /v1/models）', () => {
  // 同类缺陷的鉴权维度：/v1/models 走 _check_auth，配了密钥后无认证请求一律 401。
  // 实测：探 /v1/models 时 Wait-PortReleased 在 0.1s 内因 401 误判「端口已释放」，
  // 且 90s 健康检查全 401 → 误判 startup-unhealthy → 把正常的新版回滚掉。
  const urlLine = handoff.match(/\$PROXY_HEALTH_URL = "([^"]+)"/);
  assert.ok(urlLine, '未找到探活 URL 定义');
  assert.ok(
    urlLine[1].endsWith('/health'),
    `探活端点必须是免鉴权的 /health，当前是 ${urlLine[1]}`
  );
  assert.ok(
    !/127\.0\.0\.1:\$Port\/v1\//.test(handoff),
    '探活链路里仍有需要鉴权的 /v1/ 端点'
  );
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

test('更新脚本必须带 UTF-8 BOM（PS 5.1 无 BOM 按 GBK 读 → 解析即死）', () => {
  // 真实踩到：无 BOM 的 UTF-8 脚本被 Windows PowerShell 5.1 按 GBK 解码，
  // 中文注释变乱码打散引号配对 → 19 个解析错误 → 脚本在写日志前就死了，
  // 表现为「点更新闪退且无任何日志/状态文件」。5.1 只认 BOM 才按 UTF-8 读。
  // JS 的 readFileSync('utf8') 会自动剥 BOM，后续断言不受影响。
  const buf = readFileSync(join(root, 'scripts', 'app-update', 'windows.ps1'));
  assert.ok(
    buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    '更新脚本缺 UTF-8 BOM：PS 5.1 会按 ANSI/GBK 误读中文注释导致解析失败（无声闪退）'
  );
});

test('脚本必须内置可见进度窗（Hermes 同款体验，基于 ui.html Web 视窗，绝不弹 MessageBox）', () => {
  // 用户明确要求与 Hermes 更新逻辑一致：更新全程要有可见进度。
  // GUI 必须退出（Windows 锁 exe），外部微型 Web 视窗由脚本通过 loopback 提供并由 Chromium --app 展示。
  for (const fn of ['Start-ProgressWindow', 'Update-ProgressWindow', 'Stop-ProgressWindow']) {
    assert.ok(new RegExp(`function ${fn}`).test(handoff), `缺少进度窗函数 ${fn}`);
  }
  assert.ok(/function Start-UiServer/.test(handoff), '缺少 Start-UiServer 函数');
  assert.ok(/function Get-UiHtmlPath/.test(handoff), '缺少 Get-UiHtmlPath 函数');

  // 必须存在对应模板文件
  const uiHtmlPath = join(root, 'scripts', 'app-update', 'ui.html');
  const uiHtml = readFileSync(uiHtmlPath, 'utf8');
  assert.ok(uiHtml.includes('WorkBuddy2API'), 'ui.html 缺少 WorkBuddy2API 标识');

  // Write-State 必须联动刷新进度窗
  const wsIdx = handoff.indexOf('function Write-State');
  const wsBody = handoff.slice(wsIdx, handoff.indexOf('function Throw-Failure'));
  assert.ok(
    /Update-ProgressWindow/.test(wsBody),
    'Write-State 未联动进度窗：每个阶段都必须实时可见'
  );
  // 出口（成功/无更新/失败/GUI 超时）都必须关窗或呈现终态
  const stops = [...handoff.matchAll(/Stop-ProgressWindow/g)].length;
  assert.ok(stops >= 4, `Stop-ProgressWindow 出口覆盖不足（${stops} 处，需 ≥4）`);

  // 严格禁止调用 MessageBox::Show（禁止弹原生 Windows 98 风格红叉弹窗）
  const codeOnly = handoff
    .split('\n')
    .filter(l => !l.trimStart().startsWith('#'))
    .join('\n');
  assert.ok(
    !/MessageBox::Show/.test(codeOnly),
    '脚本可执行代码中调用了 MessageBox::Show：必须使用 ui.html Web 视窗优雅呈现'
  );
});

test('更新流程包含 handoff-ready 握手以保护主程序不闪退（Fail-Closed 校验与 RunId 绑定）', () => {
  // 外部评审 P0 采纳：主窗口不能靠固定 sleep 盲目退出；
  // 必须等待脚本上报 handoff-ready 信号后才 exit，超时则 Fail-Closed 保持主程序存活。
  assert.ok(/handoff-ready/.test(handoff), '更新脚本未产生 handoff-ready 握手信号');
  assert.ok(/handoff-ready/.test(updateRs), 'Rust update.rs 未检查 handoff-ready 信号');
  assert.ok(/handoff-ready/.test(updateJs), '前端 update-check.js 未识别 handoff-ready 阶段');

  // P0 契约更新（2026-09-20）：界面不可用时**回退**而非中止更新。
  // 旧契约要求 Start-ProgressWindow 在缺 ui.html / 缺浏览器时 exit 1（fail-closed）。
  // 但那时脚本无窗口可用；现在脚本经 `cmd start /min` 启动、自身就有一个最小化控制台
  // 可以显示进度，因此「界面不可用 = 功能全废」已不成立 —— 回退到控制台是更好的行为。
  // 仍需保证：① 每种界面失败路径都要写 handoff-ready（否则 Rust 侧永远等不到信号）；
  //           ② 不得再因界面问题 exit 1。
  const spwIdx = handoff.indexOf('function Start-ProgressWindow');
  const spwRaw = handoff.slice(spwIdx, handoff.indexOf('function Update-ProgressWindow'));
  assert.ok(spwRaw.length > 0, '未找到 Start-ProgressWindow 函数体');
  // ⚠️ 必须先剥注释再断言：注释里会提到历史行为（如"旧版无浏览器就 exit 1"），
  // 直接用原文会假阳性（本测试第一版即踩到）。
  // 剥离「整行注释」即可（PowerShell 的 # 在字符串内也会出现，逐字符剥不安全）
  const spwBody = spwRaw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.ok(
    !/exit\s+1/.test(spwBody),
    'Start-ProgressWindow 仍在界面失败时 exit 1：现在有控制台可显示进度，' +
      '界面不可用应回退而非中止整个更新'
  );
  const readyCount = (spwBody.match(/handoff-ready/g) || []).length;
  assert.ok(
    readyCount >= 2,
    `Start-ProgressWindow 的 handoff-ready 写入点不足（找到 ${readyCount} 处）：` +
      '停用路径与每个界面失败回退路径都必须写它，否则 Rust 侧等不到信号会误判超时'
  );
  // 严格过滤非 Chromium 浏览器
  assert.ok(
    /ChromeHTML\|MSEdgeHTM\|EdgeDevHTML/.test(handoff),
    'Get-DefaultBrowserExe 未对 Chromium 家族 ProgId 做严格白名单校验（会误选 Firefox 等不支持 --app 的浏览器）'
  );

  // P1 run_id 与 updater_pid 跨端绑定
  assert.ok(/run_id/.test(handoff), 'windows.ps1 缺少 run_id 字段');
  assert.ok(/updater_pid/.test(handoff), 'windows.ps1 缺少 updater_pid 字段');
  assert.ok(/pub run_id: Option<String>/.test(updateRs), 'Rust AppUpdateState 缺少 run_id 字段');
  assert.ok(/pub updater_pid: Option<u64>/.test(updateRs), 'Rust AppUpdateState 缺少 updater_pid 字段');
  assert.ok(/target_run_id/.test(updateRs), 'Rust update.rs 未对 run_id 进行校验绑定');
});

test('更新脚本包含并发互斥锁防多实例冲突（原子抢锁与陈旧自愈）', () => {
  // P1 锁定：使用 FileMode.CreateNew + FileShare.None 原子抢锁，禁止非原子的 check-then-write
  assert.ok(/lock\.json/.test(handoff), 'windows.ps1 缺少 lock.json 互斥锁');
  assert.ok(/CreateNew/.test(handoff), 'windows.ps1 缺少 FileMode::CreateNew 原子抢锁机制（存在并发竞态）');
  assert.ok(/FileShare::None/.test(handoff), 'windows.ps1 缺少 FileShare::None 独占锁');
  assert.ok(/existingLock\.pid/.test(handoff), 'windows.ps1 缺少已有锁进程探活与陈旧自愈');
  assert.ok(/Remove-Item[^\n]*lockPath/.test(handoff), 'finally 块缺少 lock.json 清理逻辑');
});

test('回滚阶段必须严格检查外部命令退出码并受控拉起（防假回滚与拉起损坏产物）', () => {
  // 外部评审 P1 锁定：Invoke-Logged 内部只 return 退出码，不抛异常。
  // 若使用 | Out-Null 吞掉退出码，外部 try/catch 会失效，导致 reset/build 失败却谎报「已回滚」。
  assert.ok(
    !/Invoke-Logged[^\n]*reset[^\n]*\|\s*Out-Null/.test(handoff),
    'git reset 回滚被 | Out-Null 丢弃退出码：必须检查返回值以确认源码是否恢复'
  );
  assert.ok(
    !/Invoke-Logged[^\n]*cargo[^\n]*\|\s*Out-Null/.test(handoff),
    'cargo build 回滚重建被 | Out-Null 丢弃退出码：必须检查返回值以确认产物是否重新生成'
  );
  assert.ok(
    !/Invoke-Logged[^\n]*npm[^\n]*\|\s*Out-Null/.test(handoff),
    'npm run build 回滚重建被 | Out-Null 丢弃退出码：必须检查返回值'
  );

  // 回滚未完全成功（源码或重建失败）时，严禁无脑拉起损坏的应用 exe
  assert.ok(
    /if\s*\(\$rolledBack\)\s*\{[\s\S]*?Start-WorkBuddy/.test(handoff),
    '回滚拉起必须在 if ($rolledBack) 守卫内：回滚未完全成功时绝不得拉起应用'
  );
});

test('回滚时 stash pop 必须在旧版重建完成之后（防本地未完成改动破坏构建或污染版本指纹）', () => {
  // 必须保证：reset -> npm/cargo build -> stash pop -> Start-WorkBuddy
  // 严禁在 reset 和 回滚后 Rust 重建之间出现 git stash pop
  const rollbackResetIdx = handoff.indexOf("What '回滚'");
  assert.ok(rollbackResetIdx > 0, '未找到回滚 reset 调用');
  const rollbackBuildIdx = handoff.indexOf("What '回滚后 Rust 重建'");
  assert.ok(rollbackBuildIdx > 0, '未找到回滚后 Rust 重建代码');
  assert.ok(rollbackBuildIdx > rollbackResetIdx, '重建必须在 reset 之后');

  const intermediateCode = handoff.slice(rollbackResetIdx, rollbackBuildIdx);
  assert.ok(
    !/git stash pop/.test(intermediateCode),
    '回滚中 git stash pop 出现在重建之前：本地未提交改动会污染旧版构建产物与版本指纹'
  );

  // 回滚中的 stash pop 必须在重建成功之后执行
  const rollbackPopIdx = handoff.indexOf('stash', rollbackBuildIdx);
  assert.ok(rollbackPopIdx > rollbackBuildIdx, '回滚中的 stash pop 必须在 Rust 重建之后');
  assert.ok(
    /if\s*\(\$rollbackRebuildOk\s*-and\s*\$stashed\)[\s\S]*?git stash pop/.test(handoff),
    '回滚中的 stash pop 必须置于重建成功（rollbackRebuildOk）的守卫内：构建失败绝不恢复 stash'
  );
});

test('更新脚本读取当前提交不得在管道中直连 Select-Object（防 pwsh 管道提前终止置空 $LASTEXITCODE）', () => {
  // 真实踩坑：PowerShell 7 (pwsh) 下，原生可执行程序输出若直接管道流向 Select-Object -First 1，
  // 下游提取首行后提前断开管道，导致原生进程被非正常终止，PowerShell 将 $LASTEXITCODE 置空（$null）。
  // 而 PowerShell 中 `$null -ne 0` 为 True，会导致「有效的 git 检出」被误判为 not-a-git-checkout 并报错回滚。
  // 必须先由变量完整接收原生命令输出后再取首行。
  const codeOnly = handoff
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.ok(
    !/& git rev-parse[^\n]*\|\s*Select-Object/.test(codeOnly),
    'git rev-parse 在管道中直连了 Select-Object：pwsh 下会导致 $LASTEXITCODE 置空并误报 not-a-git-checkout'
  );
});

test('更新脚本必须能被两版 PowerShell 无错解析（防「点更新卡住不动」静默死亡）', () => {
  // 真实踩坑（2026-09-20）：windows.ps1 第 895 行 `[string]::Join("`n", @(...) | Where-Object { $_ })`
  // 的第二个实参提前闭合并列（`"详细日志：$LogPath")` 的右括号关掉了 Join( ），
  // 导致 4 个解析错误（L895 缺 ')' / L768 块未闭合 / L910 意外 '}'）。
  //
  // 危险之处：PowerShell 解析失败时**一行都不执行**，于是
  //   ① 无日志（Write-Log 在 L126 定义、从未被调用）
  //   ② 无 app-update-state.json（Write-State 从未被调用）
  //   ③ Rust 侧 8s handoff-ready 握手超时 → 按设计保持 GUI 存活
  //   ⇒ 用户看到的是「一直卡在更新中」，且没有任何错误提示可查。
  //   实测该次点击零破坏（工作树/exe/订阅全完好），但更新静默失效。
  //
  // 本测试用 PowerShell 自身的 Parser 做静态语法分析（不执行脚本，无副作用）。
  // Linux CI 无 PowerShell 可执行文件时跳过——语法问题在 Windows CI 档与本地仍会被拦。
  const scriptPath = join(root, 'scripts', 'app-update', 'windows.ps1');

  // 找出可用的 PowerShell：pwsh (7+) 优先，回退 Windows PowerShell 5.1
  const candidates = process.platform === 'win32'
    ? ['pwsh', 'powershell']
    : ['pwsh'];
  const shells = candidates.filter((exe) => {
    const probe = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    return probe.status === 0;
  });

  if (shells.length === 0) {
    console.log('  (skip) 本机无 PowerShell 可执行文件，跳过语法解析检查');
    return;
  }

  const parseCmd = (file) => [
    '-NoProfile',
    '-Command',
    [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$e = $null',
      `[System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e) | Out-Null`,
      "if ($e -and $e.Count -gt 0) {",
      "  $e | ForEach-Object { Write-Output ('L' + $_.Extent.StartLineNumber + ': ' + $_.Message) }",
      '  exit 1',
      '} else { exit 0 }',
    ].join('; '),
  ];

  for (const shell of shells) {
    const result = spawnSync(shell, parseCmd(scriptPath), { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(
      result.status,
      0,
      `${shell} 解析 windows.ps1 失败（解析错误会让脚本一行都不执行，表现为「点更新一直卡住、无日志无状态」）：\n` +
        `${result.stdout || ''}${result.stderr || ''}`
    );
  }
});

test('脚本内函数必须在任何调用点之前定义（防顶层「未定义就调用」静默死亡）', () => {
  // 真实踩坑（2026-09-20）：互斥锁代码块（L77-124）在冲突分支调用 Write-Log，
  // 而 Write-Log 当时定义在 L126 —— PowerShell 顶层语句自上而下执行，函数在定义前
  // **不可见**，一旦走到那些分支就抛 CommandNotFoundException 直接死掉。
  // 更糟的是「写日志的动作本身依赖这个函数」，连一行日志都留不下（无日志无状态文件），
  // 与语法错误的表现完全一致，极难区分。
  //
  // 本测试扫描所有函数定义与**顶层作用域**的调用点，断言定义行 < 首次调用行。
  // 函数体内的调用不算（它们在运行时才解析，那时定义已存在）。
  const lines = handoff.split('\n');

  // 收集函数定义，并标出每个函数体的行范围
  const funcDefs = new Map();
  const bodySpans = [];
  let inFunc = false;
  let brace = 0;
  let start = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^function\s+([\w-]+)/.exec(line);
    if (m) {
      funcDefs.set(m[1], i + 1);
      inFunc = true;
      brace = 0;
      start = i;
    }
    if (inFunc) {
      brace += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      if (brace <= 0 && i > start) {
        bodySpans.push([start, i]);
        inFunc = false;
      }
    }
  }

  const inBody = (idx) => bodySpans.some(([s, e]) => idx >= s && idx <= e);

  const violations = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (inBody(i)) continue;                          // 函数体内：运行时才解析，跳过
    const raw = lines[i];
    if (raw.trimStart().startsWith('#')) continue;    // 整行注释：跳过（防假阳性）
    const code = raw.replace(/#.*$/, '');             // 行尾注释
    if (!code.trim() || /^\s*function\s/.test(code)) continue;
    for (const [name, defLine] of funcDefs) {
      const callRe = new RegExp(`(?<![-\\w])${name}\\s`);
      if (callRe.test(code) && defLine > i + 1) {
        violations.push(`L${i + 1} 调用 ${name}（定义在 L${defLine}）`);
      }
    }
  }

  assert.deepStrictEqual(
    violations,
    [],
    '顶层作用域存在「未定义就调用」：PowerShell 会在该分支抛 CommandNotFoundException 静默死掉，' +
      `且因日志函数本身可能未定义而无任何日志可查：\n${violations.join('\n')}`
  );
});

test('交接握手判据必须是「已到达或更晚」而非等值比对（防 98.6% 概率误报超时）', () => {
  // 真实踩坑（2026-09-20）：Rust 侧用 `state.phase == "handoff-ready"` 等值比对，
  // 而脚本写完 handoff-ready **立刻**写 preparing（同一语句块，实测间隔 2.1ms），
  // Rust 每 150ms 才轮询一次 ⇒ 约 1.4% 概率命中那个瞬时值，8 秒后误判「握手超时」
  // 而拒绝退出主窗口；脚本那边则苦等 180s 报 gui-exit-timeout。
  // 用户看到的现象：「更新失败：等待应用退出超时」。
  //
  // 本测试锁两件事：
  //   ① 轮询循环不得出现 phase 与 "handoff-ready" 的裸等值比对；
  //   ② 必须经过 phase_is_handoff_ready_or_later 这层判据。
  const code = stripRustComments(updateRs);

  assert.ok(
    !/state\.phase\s*==\s*"handoff-ready"/.test(code),
    '握手轮询里出现了 `state.phase == "handoff-ready"` 等值比对：' +
      'handoff-ready 仅存活 ~2ms 而轮询间隔 150ms，等值比对必然错过 → 误报超时'
  );
  assert.ok(
    /phase_is_handoff_ready_or_later\s*\(/.test(code),
    '缺少 phase_is_handoff_ready_or_later 判据调用：交接握手必须判「已到达或更晚的阶段」'
  );
});

test('判据白名单必须覆盖脚本会写入的每个阶段（缺一个即误报超时）', () => {
  // phase 白名单在 Rust 侧硬编码，而阶段名由脚本写死 —— 两者靠人肉同步。
  // 脚本新增一个阶段而 Rust 侧忘记登记时，那个阶段出现即被判为「未握手」。
  // 本测试做跨源对拍（与 Rust 内 handoff_phase_covers_every_phase_the_script_writes 同口径，
  // 但那条 Rust 测试只守白名单函数，这里额外守住"脚本真的只写这些"）。
  const phaseRe = /Write-State -Phase '([^']+)'/g;
  const scriptPhases = new Set();
  let m;
  while ((m = phaseRe.exec(handoff)) !== null) scriptPhases.add(m[1]);

  assert.ok(scriptPhases.size > 0, '未能从脚本提取到任何 Phase，提取逻辑或脚本结构已变');

  // 从 Rust 侧提取白名单
  const code = stripRustComments(updateRs);
  const fnStart = code.indexOf('fn phase_is_handoff_ready_or_later');
  assert.ok(fnStart > 0, '未找到 phase_is_handoff_ready_or_later 定义');
  const fnBody = code.slice(fnStart, code.indexOf('}', code.indexOf('matches!', fnStart)));
  const rustPhases = new Set([...fnBody.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]));

  const missing = [...scriptPhases].filter((p) => p !== 'failed' && !rustPhases.has(p));
  assert.deepStrictEqual(
    missing,
    [],
    `脚本会写入但 Rust 判据白名单未登记的阶段：${missing.join(', ')}。` +
      '这些阶段出现时会被判为「握手未完成」并误报超时。'
  );
});

test('更新脚本必须以「可见的最小化控制台」启动（用户要能看到进度，对齐 Hermes）', () => {
  // 背景（2026-09-20 用户实测对比）：Hermes 更新时用户能看到一个最小化的
  // PowerShell 控制台窗口（里面有进度输出），而 workbuddy2api 用
  // CREATE_NO_WINDOW 把窗口藏了 —— 于是看不到任何进度。
  //
  // Hermes 的做法（apps/desktop/electron/updater-process.ts::wrapHandoffForDetachedConsole）：
  //   cmd /d /s /c start "" /min powershell ... -File <script> <args>
  // 注释说明必须用 `cmd start` 包装：`start` 给子进程分配自己的
  // **（最小化的）控制台**并彻底脱离 cmd.exe —— 直接 detached+hidden spawn 会让
  // powershell.exe 在 console 初始化阶段就死掉，一行脚本都不执行。
  //
  // 实测（本机三种方式对照）：
  //   cmd start /min          → 脚本执行 ✅  可见窗口 1 个（最小化控制台）
  //   CREATE_NEW_CONSOLE      → 脚本执行 ✅  可见窗口 1 个
  //   CREATE_NO_WINDOW        → 脚本执行 ✅  可见窗口 0 个 ← 用户看不到进度
  //   DETACHED_PROCESS        → 脚本不执行 ❌（历史踩坑）
  //
  // 本测试锁：启动命令必须经 `cmd start /min` 包装，且必须使用
  // CREATE_NO_WINDOW 之外能提供控制台的 flags（不得回退到完全隐藏窗口）。
  const code = stripRustComments(updateRs);

  assert.ok(
    /cmd\.exe/.test(code) && /["']\/d["']/.test(code) && /["']\/s["']/.test(code),
    '启动命令未走 cmd.exe /d /s /c 包装：直接 spawn powershell（尤其 detached+hidden）' +
      '会让它在 console 初始化阶段就退出，一行脚本都不执行'
  );
  assert.ok(
    /["']start["']/.test(code) && /["']\/min["']/.test(code),
    '缺少 `start "" /min` 包装：这是给脚本分配可见（最小化）控制台的唯一手段，' +
      '也是用户能看到进度的来源（对齐 Hermes）'
  );
  assert.ok(
    !/CREATE_NO_WINDOW\s*\|\s*CREATE_NEW_PROCESS_GROUP/.test(code),
    '仍在使用 CREATE_NO_WINDOW 组合：它会完全隐藏控制台窗口，用户看不到更新进度。' +
      '应改用 cmd start /min（Hermes 同款，实测可给出可见的最小化控制台）'
  );
});

test('脚本必须把进度同时回显到控制台（否则用户在窗口里看不到任何东西）', () => {
  // 2026-09-20 修复的第二半：只给窗口不给输出 = 白给一个空白窗口。
  // 脚本经 `cmd start /min` 启动后拥有一个最小化控制台，但实测其 Write-Log
  // **只写文件日志、零 Write-Host 调用** —— 窗口里一片空白，用户依然看不到进度。
  // Hermes 的 Write-HandoffLog 内部同时有 Write-Host $line，这是"能看到进度"的必要条件。
  const logFnStart = handoff.indexOf('function Write-Log');
  assert.ok(logFnStart > 0, '未找到 Write-Log 定义');
  // ⚠️ 本文件是 CRLF：不能用 indexOf('\n}') 找函数结尾（匹配不到会切到文件末尾，
  // 让断言在全库范围内成立 —— 假阴性，测试形同虚设）。改为按行找顶格 '}'。
  const afterStart = handoff.slice(logFnStart);
  const linesOfFn = afterStart.split(/\r?\n/);
  const endIdx = linesOfFn.findIndex((line, i) => i > 0 && line.startsWith('}'));
  const logFnRaw = linesOfFn.slice(0, endIdx === -1 ? linesOfFn.length : endIdx + 1).join('\n');
  // ⚠️ 必须先剥整行注释再断言：函数体里那句「对齐 Hermes 的 Write-HandoffLog，
  // 其内部同样有 Write-Host」会让正则命中注释而漏掉真实回显被删除的情况
  //（本测试第一版即此假阳性，变异验证当场抓到）。
  const logFn = logFnRaw
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  assert.ok(
    /Write-Host/.test(logFn),
    'Write-Log 未回显到控制台（缺 Write-Host）：脚本虽有最小化控制台窗口，' +
      '但里面不会有任何进度输出，用户看到的是一个空白窗口'
  );
  assert.ok(
    /AppendAllText/.test(logFn),
    'Write-Log 未写文件日志：控制台回显不能替代持久日志（更新失败时要靠日志排查）'
  );
});

test('健康确认必须按「用户是否开着自动启动内核」分流（否则误判失败并回滚好版本）', () => {
  // 2026-09-20 用户实测踩到（差点把一次**成功**的更新回滚掉）：
  // 用户的 settings.json 里 auto_start_proxy=false —— 新 GUI 启动后**不会**自动拉起
  // 反代内核，端口 8787 自然不监听。而 Wait-WorkBuddyHealthy 的判据是「进程存活
  // **且**端口能探活」，于是必然 90s 超时 → 判 startup-unhealthy → 把刚构建好的
  // 新版回滚掉。本次是用户手动从托盘启动内核才碰巧躲过。
  //
  // 正解：脚本接收 -AutoStartProxy（字符串 'true'/'false'，由 Rust 从配置真源传），
  // 未开启自动启动时**只验进程存活**，端口探活降级为「能探到更好」的加分项而非硬条件。
  assert.ok(
    /\$AutoStartProxy/.test(handoff),
    '脚本缺少 $AutoStartProxy：无法区分「内核该不该自动起来」，会把不开自动启动的用户的正常更新判失败'
  );
  assert.ok(
    /\[string\]\$AutoStartProxy/.test(handoff),
    '脚本未声明 [string]$AutoStartProxy 参数：Rust 侧传了也不会生效' +
      '（注意必须声明成 [string] —— 实测 [bool] 参数经 -File 传参一律绑定失败）'
  );

  // 健康确认函数体里必须出现该开关的分流
  const fnStart = handoff.indexOf('function Wait-WorkBuddyHealthy');
  assert.ok(fnStart > 0, '未找到 Wait-WorkBuddyHealthy 定义');
  const fnLines = handoff.slice(fnStart).split(/\r?\n/);
  const bodyEnd = fnLines.findIndex((line, i) => i > 0 && line.trimEnd() === '}');
  const fnBody = fnLines.slice(0, bodyEnd === -1 ? fnLines.length : bodyEnd + 1)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.ok(
    /\$autoStartProxyEnabled/.test(fnBody),
    'Wait-WorkBuddyHealthy 未按自动启动开关分流：仍会在用户未开自动启动时探活失败，' +
      '把成功的新版回滚掉'
  );
});

test('Rust 侧必须把「自动启动内核」配置传给更新脚本', () => {
  // 配置真源是 load_app_config().auto_start_proxy（与前端 settings.js 读的同一份）。
  // 不得写死 false/true —— 写死 false 会让开着自动启动的用户白等 90s 探活；
  // 写死 true 则回到本条修复要解决的误判。
  const code = stripRustComments(updateRs);
  assert.ok(
    /auto_start_proxy/.test(code),
    'update.rs 未读取 auto_start_proxy：脚本拿不到「该不该等端口」，健康确认无法正确分流'
  );
  assert.ok(
    /"-AutoStartProxy"/.test(code),
    'update.rs 未把 -AutoStartProxy 传给脚本：脚本只能走默认分支'
  );
  // 传参形态必须是字符串 true/false —— 实测 [bool] 参数经 -File 传参一律转换失败
  // 传参必须是字符串 true/false：两种等价写法（三元 / if-else）都接受。
  // 实测 [bool] 参数经 -File 传参在 PS 5.1 与 pwsh 7 上一律绑定失败并直接退出。
  assert.ok(
    /auto_start_proxy[\s\S]{0,120}"true"[\s\S]{0,40}"false"/.test(code),
    '未把 auto_start_proxy 转成字符串 true/false：实测 [bool] 参数经 -File 传参一律绑定失败' +
      '（「无法将 System.String 转换为 System.Boolean」），脚本会直接退出'
  );
});

test('resume 进行中的更新前必须核实更新进程仍存活（防卡在非终态无限弹窗）', () => {
  // 2026-09-20 用户实测：更新脚本被用户关掉窗口杀死后，state.json 永久停在
  // 'restarting'（脚本没机会写 done）。前端 resumeInFlightUpdate 只看 phase 是否属于
  // 「进行中」，于是**每次启动应用都弹出关不掉的「正在更新」弹窗**，用户连重启软件
  // 都摆脱不了（应用照常可用，但启动即被劫持）。
  //
  // 正解：让 Rust 侧核实 state.updater_pid 指向的进程是否还活着，前端只认它的结论。
  // 进程已死 ⇒ 更新不可能再推进 ⇒ 不接续进度视图。

  // ① 前端必须改走 app_update_resume（而不是自己只看 phase 就 openOverlay）
  const resumeStart = updateJs.indexOf('async function resumeInFlightUpdate');
  assert.ok(resumeStart > 0, '未找到 resumeInFlightUpdate 定义');
  const resumeBody = updateJs.slice(resumeStart, resumeStart + 2200)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  assert.ok(
    /app_update_resume/.test(resumeBody),
    'resumeInFlightUpdate 未调用 app_update_resume：脚本已死时会弹「正在更新」且用户关不掉'
  );
  // 必须「先问再开窗」——先 openOverlay 再问等于没问
  const callIdx = resumeBody.indexOf('app_update_resume');
  const openIdx = resumeBody.indexOf('openOverlay()');
  assert.ok(openIdx > 0, 'resumeInFlightUpdate 未调用 openOverlay（提取逻辑或结构已变）');
  assert.ok(
    callIdx < openIdx,
    'resumeInFlightUpdate 先 openOverlay 再问存活：顺序反了，弹窗已经开了'
  );

  // ② Rust 侧必须真的实现这两个函数
  const code = stripRustComments(updateRs);
  assert.ok(
    /fn app_update_resume\s*\(/.test(code),
    'update.rs 未实现 app_update_resume：前端调它会报 command not found'
  );
  assert.ok(
    /fn updater_process_alive\s*\(/.test(code),
    'update.rs 未实现 updater_process_alive：没有进程存活判据'
  );
  // 必须校验命令行是本项目的更新脚本 —— 否则 PID 被复用时会把别的进程当成更新进程
  const aliveFn = code.slice(code.indexOf('fn updater_process_alive'));
  assert.ok(
    /windows\.ps1/.test(aliveFn.slice(0, 2000)),
    'updater_process_alive 未校验命令行含 windows.ps1：PID 复用会误判「更新仍在进行」'
  );

  // ③ 「进行中」白名单不得包含终态（含终态会让 done/failed 也被接续）
  const inProgIdx = code.indexOf('fn phase_is_in_progress');
  assert.ok(inProgIdx > 0, 'update.rs 未实现 phase_is_in_progress');
  const inProgBody = code.slice(inProgIdx, inProgIdx + 700);
  for (const terminal of ['done', 'failed', 'rolled-back']) {
    assert.ok(
      !new RegExp(`"${terminal}"`).test(inProgBody),
      `phase_is_in_progress 含终态 '${terminal}'：终态不该被当成「仍在推进」而接续弹窗`
    );
  }

  // ④ 命令必须注册
  assert.ok(
    /commands::app_update_resume/.test(libRs),
    'lib.rs 未注册 app_update_resume'
  );
});
