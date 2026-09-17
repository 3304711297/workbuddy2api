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

test('脚本必须内置可见进度窗（Hermes 同款体验，不得是后台黑箱）', () => {
  // 用户明确要求与 Hermes 更新逻辑一致：更新全程要有可见进度。
  // GUI 必须退出（Windows 锁 exe），进度窗由脚本用 WinForms runspace 自绘。
  for (const fn of ['Start-ProgressWindow', 'Update-ProgressWindow', 'Stop-ProgressWindow']) {
    assert.ok(new RegExp(`function ${fn}`).test(handoff), `缺少进度窗函数 ${fn}`);
  }
  // Write-State 必须联动刷新进度窗（否则窗体文字停在初始值）
  const wsIdx = handoff.indexOf('function Write-State');
  const wsBody = handoff.slice(wsIdx, handoff.indexOf('function Throw-Failure'));
  assert.ok(
    /Update-ProgressWindow/.test(wsBody),
    'Write-State 未联动进度窗：每个阶段都必须实时可见'
  );
  // 四个出口（成功/无更新/失败/GUI 超时）都必须关窗
  const stops = [...handoff.matchAll(/Stop-ProgressWindow/g)].length;
  assert.ok(stops >= 4, `Stop-ProgressWindow 出口覆盖不足（${stops} 处，需 ≥4）`);
  // 窗体必须置顶（GUI 已退出，窗口是唯一可见面）
  assert.ok(/TopMost\s*=\s*\$true/.test(handoff), '进度窗未置顶');
});
