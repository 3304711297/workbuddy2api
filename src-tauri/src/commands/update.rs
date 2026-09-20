//! 应用更新：被动检测（GitHub API 比对分支 commit）+ 交接式自动更新。
//!
//! 检测口径对齐 Hermes Desktop（见其 `update-api-check.ts` / `main.ts:checkUpdates`）：
//! 不做 `git fetch` 轮询（多客户端会拖垮仓库并触发 GitHub 429），而是
//!   ① `GET /repos/{slug}/commits/{branch}` 带 `Accept: application/vnd.github.sha`
//!      取回 40 字节远端 tip SHA，与本机 HEAD 比对；
//!   ② 仅当两者不同，才 `GET /compare/{head}...{tip}` 取 `ahead_by` 与 commit 列表。
//!
//! ⚠️ **`ahead_by == 0` 但 tip 不同 ⇒ 本地领先，不是落后**，必须判定为「无更新」——
//! 否则会诱导用户用远端覆盖掉自己的提交。
//!
//! 应用更新为交接式：写编排脚本 → 分离进程启动 → 退出 GUI →
//! 脚本待 GUI 退出后 `git merge --ff-only` + 重建前端与 Rust → 拉起新 exe。
//! 本模块只做「检测」与「发起交接」，实际更新动作在 `scripts/app-update/windows.ps1`。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::shared::{atomic_write_file, env_compat, local_app_dir};

const DEFAULT_BRANCH: &str = "main";
const SLUG: &str = "3304711297/workbuddy2api";
/// 检测结果缓存 TTL：有更新 24h、无更新 10min、失败 1h。
/// 失败重试更勤；「无更新」必须短（见 cache_is_fresh 的文档——键里没有远端 tip，
/// 长缓存会把远端新提交挡在门外，让「检查更新」变成复读旧答案）。
const CHECK_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const CHECK_CLEAN_TTL_MS: i64 = 10 * 60 * 1000;
const CHECK_FAILURE_TTL_MS: i64 = 60 * 60 * 1000;

/// 一条待展示的 commit（弹窗变更列表的一行）
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UpdateCommit {
    pub sha: String,
    pub summary: String,
    pub author: String,
    pub at: i64,
}

/// 更新检测结果（前端契约：检测失败不打断流程，返回 update_available=false + error 描述）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppUpdateInfo {
    /// 是否可自更新（工作区是带 .git 的源码检出且编排脚本存在）
    pub supported: bool,
    /// 不可自更新的原因：not-a-git-checkout / no-handoff-script
    pub reason: Option<String>,
    pub branch: String,
    pub current_sha: String,
    pub target_sha: Option<String>,
    /// 落后多少个 commit；None = 有更新但数量未知（绝不编造数字）
    pub behind: Option<u32>,
    pub update_available: bool,
    /// 工作区可能有未提交改动（更新脚本会先 stash）
    pub dirty: bool,
    pub commits: Vec<UpdateCommit>,
    pub update_root: String,
    pub fetched_at: i64,
    pub error: Option<String>,
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// 本地 git 元数据读取（纯文件操作，不依赖 PATH 上有 git 可执行文件）
// ---------------------------------------------------------------------------

/// 构建时烘焙进的短 sha（由 `build.rs` 注入 `WORKBUDDY2API_BUILD_SHA`）。
///
/// ⚠️ 这是「本 exe 是哪个提交构建的」的唯一真源，**不能**改用工作树 `.git/HEAD`：
/// 本项目源码留在检出目录且更新靠就地重建，工作树 HEAD 会被 pull 推进到最新，
/// 而运行中的 exe 仍是旧提交的产物 —— 读工作树会把「运行的是旧版本」谎报成
/// 「已是最新」（真实踩到：exe 构建于 88b0f7e、工作树已到 d1cb787）。
pub fn build_sha() -> &'static str {
    env!("WORKBUDDY2API_BUILD_SHA")
}

/// 解析 `.git`：普通检出的 `.git` 是目录；worktree 下是内容为 `gitdir: <path>` 的文件。
fn resolve_git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let raw = std::fs::read_to_string(&dot_git).ok()?;
    let target = raw.trim().strip_prefix("gitdir:")?.trim().to_string();
    let path = PathBuf::from(&target);
    let path = if path.is_absolute() { path } else { root.join(path) };
    path.is_dir().then_some(path)
}

fn is_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 定位源码检出根目录：`WORKBUDDY2API_INSTALL_ROOT`（兼容旧名）优先，
/// 否则从可执行文件所在目录逐级向上找第一个含 `.git` 的目录。
///
/// 本机布局：`<root>/src-tauri/target/release/workbuddy2api.exe` → 上溯 3 级即 `<root>`。
fn resolve_install_root() -> Option<PathBuf> {
    if let Some(p) = env_compat("INSTALL_ROOT")
        .map(PathBuf::from)
        .filter(|p| p.join(".git").exists())
    {
        return Some(p);
    }
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    for _ in 0..6 {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// 交接脚本路径（相对安装根）。缺失即视为不可自更新。
fn handoff_script_path(root: &Path) -> PathBuf {
    root.join("scripts").join("app-update").join("windows.ps1")
}

fn update_branch() -> String {
    env_compat("UPDATE_BRANCH")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_BRANCH.to_string())
}

// ---------------------------------------------------------------------------
// GitHub API 载荷解析
// ---------------------------------------------------------------------------

fn branch_tip_api_url(slug: &str, branch: &str) -> String {
    format!("https://api.github.com/repos/{slug}/commits/{branch}")
}

fn compare_api_url(slug: &str, base: &str, head: &str) -> String {
    format!("https://api.github.com/repos/{slug}/compare/{base}...{head}")
}

/// 把 compare 载荷映射成弹窗需要的形状。任何形状异常都返回 None，
/// 让调用方保持诚实的「有更新、数量未知」状态，而不是采信半截答案。
///
/// `ahead_by` = 远端 tip 领先本地 HEAD 的提交数，即 behind；
/// GitHub 按「旧 → 新」返回 commits，这里反转成「新 → 旧」以贴合弹窗展示。
fn parse_compare(payload: &serde_json::Value) -> Option<(u32, Vec<UpdateCommit>)> {
    let ahead = payload.get("ahead_by")?.as_u64()?;
    let behind = u32::try_from(ahead).ok()?;

    let mut commits: Vec<UpdateCommit> = payload
        .get("commits")
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let sha = entry.get("sha")?.as_str()?.to_string();
                    let body = entry.get("commit")?;
                    let message = body.get("message").and_then(|m| m.as_str()).unwrap_or("");
                    let author = body
                        .get("author")
                        .and_then(|a| a.get("name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("");
                    let at = body
                        .get("committer")
                        .and_then(|c| c.get("date"))
                        .and_then(|d| d.as_str())
                        .and_then(parse_rfc3339_secs)
                        .unwrap_or(0);
                    Some(UpdateCommit {
                        sha,
                        // 只取首行，正文不进展列表
                        summary: message.split('\n').next().unwrap_or("").trim().to_string(),
                        author: author.to_string(),
                        at,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    commits.reverse();

    Some((behind, commits))
}

/// 极简 RFC3339 → Unix 秒。仅需处理 GitHub 固定输出的 `YYYY-MM-DDTHH:MM:SSZ`。
fn parse_rfc3339_secs(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.timestamp())
}

/// 缓存是否仍然有效。缓存以「本地 HEAD + 分支」为键——
/// 一旦应用了更新或切了分支，HEAD 变化即刻失效，TTL 内不会残留假的「有更新」。
///
/// ⚠️ **键里没有远端 tip，这是有意的妥协，但因此 TTL 必须短**：
/// 远端推了新提交而本机 exe 未变时，缓存键照旧命中——「已是最新」的旧结果会被
/// 原样奉还，用户点「检查更新」却根本没发请求（真实踩到：exe=3d094fc、远端已到
/// 514fad9，弹窗仍显示「已是最新」）。因此：
/// - 「有更新」可缓存较久（24h）：用户下一步是点「立即更新」，不会反复实查；
/// - 「无更新」只缓存 10 分钟：它是「不需要动作」的答案，过期代价只是多一次 API；
/// - 失败缓存 1h：失败重试更勤。
/// 前端入口点击另传 `force: true` 实时实查，双保险（见 update-check.js onClick）。
fn cache_is_fresh(cached: &AppUpdateInfo, current_sha: &str, branch: &str, now: i64) -> bool {
    if cached.current_sha != current_sha || cached.branch != branch {
        return false;
    }
    let ttl = if cached.error.is_some() {
        CHECK_FAILURE_TTL_MS
    } else if cached.update_available {
        CHECK_TTL_MS
    } else {
        CHECK_CLEAN_TTL_MS
    };
    now - cached.fetched_at < ttl
}

/// 依据 tip 比对结果产出最终状态（纯逻辑，便于单测穷举四种组合）。
fn decide(
    current_sha: &str,
    target_sha: &str,
    compared: Option<(u32, Vec<UpdateCommit>)>,
) -> (Option<u32>, bool, Vec<UpdateCommit>) {
    if target_sha == current_sha {
        return (Some(0), false, Vec::new());
    }
    // compare 失败（限流 / 本地独有提交导致 404）时保持「有更新、数量未知」
    match compared {
        // tip 不同但本地领先 → 不是落后，不提示更新
        Some((0, _)) => (Some(0), false, Vec::new()),
        Some((behind, commits)) => (Some(behind), true, commits),
        None => (None, true, Vec::new()),
    }
}

// ---------------------------------------------------------------------------
// 网络：GitHub API
// ---------------------------------------------------------------------------

fn client(use_env_proxy: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("workbuddy2api-console")
        .timeout(Duration::from_secs(10));
    if !use_env_proxy {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|e| e.to_string())
}

async fn fetch_github(url: &str, accept: Option<&str>) -> Result<reqwest::Response, String> {
    let mut last_err = String::new();
    // 先走标准环境代理（HTTP_PROXY/HTTPS_PROXY），失败再强制直连：
    // 国内直连 api.github.com 常不稳，而代理未开时直连反而可用，两条都试过才算失败。
    for use_env_proxy in [true, false] {
        let req = client(use_env_proxy)?
            .get(url)
            .header("Accept", accept.unwrap_or("application/vnd.github+json"));
        match req.send().await {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => last_err = format!("HTTP {}", resp.status()),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(last_err)
}

/// 把网络失败翻译成一条用户能据此行动（或贴进 issue）的话，
/// 而不是笼统的「无法连接服务器」——隐藏成因会把 GitHub 故障误读成应用缺陷。
fn describe_failure(err: &str) -> String {
    if err.contains("403") || err.contains("429") {
        return format!("GitHub API 触发限流（{err}），请稍后重试");
    }
    if let Some(code) = err.strip_prefix("HTTP ") {
        if let Ok(n) = code.parse::<u16>() {
            if n >= 500 {
                return format!("GitHub 服务异常（api.github.com 返回 HTTP {n}），请稍后重试");
            }
            return format!("api.github.com 返回 HTTP {n}");
        }
    }
    let lower = err.to_ascii_lowercase();
    if lower.contains("dns") || lower.contains("failed to lookup") {
        return "api.github.com 域名解析失败，请检查网络或代理设置".into();
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return "api.github.com 10 秒内未响应，请检查网络或代理设置".into();
    }
    format!("api.github.com 请求失败：{err}")
}

async fn fetch_target_sha(slug: &str, branch: &str) -> Result<String, String> {
    // application/vnd.github.sha 让响应体只有 40 字节的 SHA，而不是完整 commit JSON
    let resp = fetch_github(
        &branch_tip_api_url(slug, branch),
        Some("application/vnd.github.sha"),
    )
    .await
    .map_err(|e| describe_failure(&e))?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let sha = text.trim().to_string();
    if !is_sha(&sha) {
        return Err("GitHub API 未返回有效的 tip SHA".into());
    }
    Ok(sha)
}

async fn fetch_compare(slug: &str, base: &str, head: &str) -> Option<(u32, Vec<UpdateCommit>)> {
    let resp = fetch_github(&compare_api_url(slug, base, head), None)
        .await
        .ok()?;
    let payload: serde_json::Value = resp.json().await.ok()?;
    parse_compare(&payload)
}

// ---------------------------------------------------------------------------
// 缓存落盘
// ---------------------------------------------------------------------------

fn cache_path() -> PathBuf {
    local_app_dir().join("update-check.json")
}

fn read_cache() -> Option<AppUpdateInfo> {
    let raw = std::fs::read_to_string(cache_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cache(info: &AppUpdateInfo) {
    if let Ok(raw) = serde_json::to_string_pretty(info) {
        let _ = atomic_write_file(&cache_path(), &raw);
    }
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn check_app_update(force: Option<bool>) -> Result<AppUpdateInfo, String> {
    let now = chrono::Utc::now().timestamp_millis();
    let branch = update_branch();

    // 前置：必须是带 .git 的源码检出，且编排脚本齐备，否则明确告知不可自更新
    let Some(root) = resolve_install_root() else {
        return Ok(AppUpdateInfo {
            supported: false,
            reason: Some("not-a-git-checkout".into()),
            branch,
            message: Some("此副本不是源码检出，无法在应用内自更新；请重新 clone 仓库后构建。".into()),
            fetched_at: now,
            ..Default::default()
        });
    };
    let root_str = root.to_string_lossy().to_string();
    // ⚠️ 版本比对必须用「本 exe 构建时的提交」，不能用工作树 HEAD：
    // 源码留在检出目录且更新靠就地重建，工作树会被 pull 推到最新，而运行中的 exe
    // 仍是旧提交的产物 —— 读工作树会把「运行的是旧版本」谎报成「已是最新」。
    let current_sha = build_sha().to_string();
    let dirty = working_tree_dirty(&root);

    if !handoff_script_path(&root).exists() {
        return Ok(AppUpdateInfo {
            supported: false,
            reason: Some("no-handoff-script".into()),
            branch,
            current_sha,
            dirty,
            update_root: root_str,
            message: Some("缺少更新编排脚本 scripts/app-update/windows.ps1，无法在应用内自更新。".into()),
            fetched_at: now,
            ..Default::default()
        });
    }

    // 缓存命中直接返回（force=true 绕过）
    if !force.unwrap_or(false) {
        if let Some(cached) = read_cache() {
            if cached.supported && cache_is_fresh(&cached, &current_sha, &branch, now) {
                // dirty 随时可变，始终以本次实读为准
                return Ok(AppUpdateInfo {
                    dirty,
                    update_root: root_str,
                    ..cached
                });
            }
        }
    }

    let result = match fetch_target_sha(SLUG, &branch).await {
        Ok(target_sha) => {
            let compared = if target_sha == current_sha {
                None
            } else {
                fetch_compare(SLUG, &current_sha, &target_sha).await
            };
            let (behind, update_available, commits) = decide(&current_sha, &target_sha, compared);
            AppUpdateInfo {
                supported: true,
                reason: None,
                branch: branch.clone(),
                current_sha: current_sha.clone(),
                target_sha: Some(target_sha),
                behind,
                update_available,
                dirty,
                commits,
                update_root: root_str.clone(),
                fetched_at: now,
                error: None,
                message: None,
            }
        }
        Err(message) => AppUpdateInfo {
            supported: true,
            reason: None,
            branch: branch.clone(),
            current_sha: current_sha.clone(),
            dirty,
            update_root: root_str.clone(),
            fetched_at: now,
            error: Some(message),
            ..Default::default()
        },
    };

    write_cache(&result);
    Ok(result)
}

/// 工作区是否有未提交改动的判定。
///
/// ⚠️ **必须问真实的 git，不能用 mtime 启发式**（2026-09-20 修正）：
/// 旧实现拿 `.git/index` 的 mtime 与 `.git/HEAD` 比大小，理由是「提交或暂存都会先
/// 更新 HEAD/index」——但这半句是错的：**commit 只写 index，HEAD 文件仅作符号引用
/// （`ref: refs/heads/main`），只在 checkout / 切分支时才重写**。于是每次提交后
/// `index > HEAD` 恒成立，**干净树被永久误报为「有未提交改动」**（用户实测：
/// `update-check.json` 报 `dirty: true`，而 `git status --porcelain` 输出为空）。
/// 这与本函数原本宣称的「宁可漏报也不误报」完全相反。
///
/// 改为直接跑 `git status --porcelain`（实测本机 17ms，够快；失败时报「不脏」保持
/// 漏报优先的取向，与 `MERGE_HEAD` 那条同样宁可漏报也不吓唬用户）：
///   · 有输出（含 `??` 未跟踪文件）= 脏 —— 脚本用 `git stash push -u`，未跟踪文件
///     同样会被保存并可能因 pop 冲突而回不来，所以它也算「不干净」；
///   · 空输出 = 干净。
///
/// `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` 必须剔除：命令行 git 会继承它们，
/// 一旦被设置就会查询别的仓库（甚至会「成功」返回空结果），属于静默错答案。
fn working_tree_dirty(root: &Path) -> bool {
    // 合并/变基中间态：必然「不干净」，且此时 git status 也可能被卡住，先判掉。
    if let Some(git_dir) = resolve_git_dir(root) {
        if git_dir.join("MERGE_HEAD").exists()
            || git_dir.join("rebase-merge").exists()
            || git_dir.join("rebase-apply").exists()
        {
            return true;
        }
    }

    let mut cmd = std::process::Command::new("git");
    cmd.args(["status", "--porcelain"])
        .current_dir(root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    // Windows 下不弹黑框（GUI 进程调用命令行工具时的常规防御）。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.output() {
        Ok(out) if out.status.success() => !String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        // git 不可用 / 非检出 / 执行失败：按「不脏」处理（漏报优先，避免无谓的恐吓文案）。
        _ => false,
    }
}

/// 交接握手判据：状态是否已到达 `handoff-ready` **或任何更晚的阶段**。
///
/// ⚠️ **不可退化为 `phase == "handoff-ready"` 的等值比对**（2026-09-20 修复）：
/// 脚本写完 `handoff-ready` 后立刻写 `preparing`（同一语句块，实测间隔 ~2ms），
/// 而轮询间隔是 150ms —— 等值比对约 98.6% 概率错过那个瞬时值，导致误判握手超时、
/// 拒绝退出，而脚本苦等 180s 后报 `gui-exit-timeout`（用户实测的「更新失败」）。
/// 这些后续阶段只可能在视窗就绪之后出现，判「已到达」与判「等于」语义等价，
/// 但不受轮询间隔与写入速度影响。
fn phase_is_handoff_ready_or_later(phase: &str) -> bool {
    matches!(
        phase,
        "handoff-ready"
            | "preparing"
            | "fetching"
            | "merging"
            | "deps"
            | "frontend"
            | "building"
            | "verifying"
            | "restarting"
            | "done"
            | "rolling-back"
            | "rolled-back"
    )
}

/// 退出前停掉反代内核。
///
/// `converter.py` **没有父进程退出检测**（全仓无 getppid 判据，proxy.rs 的孤儿清理
/// 注释也确认了这点）：GUI 进程消失后它会变孤儿继续监听端口，而更新脚本第 7 步的
/// `Wait-PortReleased` 依赖「端口先消失再出现」来证明新版确实起来了 —— 孤儿占着端口
/// 会让这步 30s 超时并 `Throw-Failure 'port-not-released'` 中止更新。
/// 走托盘「退出」（lib.rs 的 "quit" 分支）时是显式停内核的，更新路径必须同口径。
///
/// 失败不阻断退出：清理是尽力而为，脚本侧另有孤儿清理兜底（proxy.rs::climb_to_orphan_root）。
fn stop_proxy_before_exit(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<crate::ProxyHandle>() {
        if let Err(err) = crate::commands::proxy_stop(state, app.clone()) {
            eprintln!("[update] 退出前停止反代失败（不阻断退出）：{err}");
        }
    }
}

/// 发起自动更新：校验前置条件 → 分离进程拉起编排脚本 → 让 GUI 退出。
///
/// 返回后前端应显示「更新程序中」并停止一切交互；GUI 退出由脚本接管，
/// 脚本会在重建完成后重新拉起新 exe（见 `scripts/app-update/windows.ps1`）。
#[tauri::command]
pub fn apply_app_update(app: tauri::AppHandle) -> Result<String, String> {
    let root = resolve_install_root()
        .ok_or_else(|| "当前副本不是源码检出，无法在应用内自更新".to_string())?;
    let script = handoff_script_path(&root);
    if !script.exists() {
        return Err(format!("缺少更新编排脚本：{}", script.display()));
    }

    let branch = update_branch();
    // ⚠️ 端口必须取自配置真源 `load_app_config().port`，与 Hermes 接入检测同一口径
    // （`is_our_proxy_url` 也是这么取的）。**不得**在更新链路上再引入第二个「默认 8787」：
    // 用户把端口配成 9000 时，新版会正常监听 9000，而写死 8787 的健康检查会
    // 探活失败 → 误判 startup-unhealthy → 把正常的新版回滚掉。
    let port = crate::load_app_config().port;
    let log_dir = local_app_dir().join("update");
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log_path = log_dir.join("app-update.log");
    let state_path = log_dir.join("app-update-state.json");

    // 清掉上一次的状态残留：否则前端可能把上次的 done/failed 当成本次的进度。
    // 脚本随后会立即写入 preparing，此处失败不影响更新流程。
    let _ = std::fs::remove_file(&state_path);

    // 分离启动：经 `cmd start /min` 包装，让脚本拥有一个**可见的最小化控制台**。
    //
    // ⚠️ 为什么不能直接 spawn powershell（2026-09-17 实测踩坑 + 2026-09-20 用户反馈）：
    // ① powershell.exe 是 console-subsystem 程序，`DETACHED_PROCESS` 让它在 console
    //    初始化阶段就死掉，**一行脚本都不执行**（08-09 类故障，Hermes 侧亦有同款记录）。
    // ② 改用 `CREATE_NO_WINDOW` 虽能跑，但**完全隐藏了控制台** —— 用户看不到任何进度，
    //    这也是本次用户反馈「Hermes 能看到进度，你这个看不到」的根因。
    // Hermes 的做法（apps/desktop/electron/updater-process.ts::wrapHandoffForDetachedConsole）：
    //   cmd /d /s /c start "" /min powershell ... -File <script> <args>
    // `start` 给子进程分配自己的（最小化）控制台并彻底脱离 cmd.exe（cmd 立即退出），
    // 既解决 console 初始化问题，又把进度输出呈现给用户。
    // 本机三方式对照实测：cmd start /min → 跑 ✅ 可见窗口 1；CREATE_NEW_CONSOLE → 跑 ✅ 窗口 1；
    //                     CREATE_NO_WINDOW → 跑 ✅ 窗口 0；DETACHED_PROCESS → 不跑 ❌。
    #[cfg(target_os = "windows")]
    {
        let run_id = format!(
            "{:x}-{:x}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );
        let shell = resolve_powershell();

        // 参数顺序必须与脚本 param() 声明无关地保持「-File <script> -Name <value>」配对。
        // start 的首个参数是窗口标题（空串），/min 使其最小化启动。
        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.arg("/d")
            .arg("/s")
            .arg("/c")
            .arg("start")
            .arg("")
            .arg("/min")
            .arg(&shell)
            .arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script)
            .arg("-InstallRoot")
            .arg(&root)
            .arg("-Branch")
            .arg(&branch)
            .arg("-GuiPid")
            .arg(std::process::id().to_string())
            .arg("-LogPath")
            .arg(&log_path)
            .arg("-StatePath")
            .arg(&state_path)
            .arg("-RunId")
            .arg(&run_id)
            // 运行中 exe 的构建提交：脚本据此判断「快进后是否需要重建」。
            // 不能只比工作树 HEAD —— 工作树可能已被 pull 到最新，而跑着的仍是旧产物。
            .arg("-CurrentBuildSha")
            .arg(build_sha())
            // 实际监听端口：健康检查必须探这个端口。写死 8787 会让自定义端口的
            // 用户在新版正常启动时被判 startup-unhealthy 并错误回滚。
            .arg("-Port")
            .arg(port.to_string())
            // 用户是否开着「启动时自动拉起内核」。取配置真源（与前端 settings.js 同一份）。
            // ⚠️ 必须传，不能由脚本猜：关掉自动启动的用户，新 GUI 起来后端口不会监听，
            // 而脚本的启动确认若坚持探活就必然超时 → 把**成功的新版**回滚掉
            // （2026-09-20 用户实测，靠手动从托盘启动内核才躲过）。
            // 传字符串 'true'/'false'：实测 [bool] 参数经 -File 传参在 PowerShell 5.1
            // 与 pwsh 7 上均绑定失败（「无法将 System.String 转换为 System.Boolean」）。
            .arg("-AutoStartProxy")
            .arg(if crate::load_app_config().auto_start_proxy {
                "true"
            } else {
                "false"
            })
            .current_dir(&root)
            .stdin(std::process::Stdio::null())
            // stdout/stderr 交由脚本自己写日志文件，避免句柄继承导致父进程退出被拖住。
            // （脚本的进度输出走 Write-Host → 它自己那个最小化控制台，与这两个管道无关）
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // 刻意**不设置** creation_flags：控制台由 `cmd start` 分配（见上方说明）。
        // 设 CREATE_NO_WINDOW 会把它藏掉，回到「用户看不到进度」的问题。
        cmd.spawn().map_err(|e| format!("无法启动更新程序：{e}"))?;

        // 外部视窗交接握手（Fail-Closed 保护）：严格按本次 run_id 比对，
        // 确认外部微型 Web 视窗已成功启动并就绪（handoff-ready）后，主窗口才退出；
        // 若 8 秒内未收到就绪信号或脚本直接报 failed，则拒绝退出以避免主程序意外消失闪退。
        //
        // ⚠️ **必须用「已进入后续阶段」而非「恰好等于 handoff-ready」做判据**（2026-09-20 修复）：
        // 脚本写完 `handoff-ready` 后会**立刻**写 `preparing`（同一个语句块，实测间隔仅 ~2ms），
        // 而本线程 150ms 才轮询一次 —— 严格等值比对意味着 98.6% 的概率看不见那个瞬时值，
        // 8 秒后误判「握手超时」而拒绝退出，脚本那边则干等 180 秒报 `gui-exit-timeout`。
        // 真实踩到：日志里 handoff-ready 与 preparing 同一秒出现，用户看到「更新失败：等待应用退出超时」。
        // 判据改为「已到达 handoff-ready 或任何更晚的阶段」——那些阶段都只可能在
        // 视窗就绪之后出现，语义等价且不受轮询间隔影响。
        let handle = app.clone();
        let target_run_id = run_id.clone();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
            let mut ready = false;
            while std::time::Instant::now() < deadline {
                if let Ok(Some(state)) = app_update_state() {
                    if state.run_id.as_deref() == Some(&target_run_id) {
                        if phase_is_handoff_ready_or_later(&state.phase) {
                            ready = true;
                            break;
                        } else if state.phase == "failed" {
                            eprintln!("[update] updater 启动即报 failed，中止交接退出");
                            break;
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            if ready {
                // ⚠️ 退出前必须显式停掉反代内核。converter.py 没有父进程退出检测：
                // 只 handle.exit(0) 会让它变孤儿继续占着端口，脚本随后的
                // Wait-PortReleased 会判「端口未释放」并中止更新（30s 后报 port-not-released）。
                // 与托盘「退出」同口径（lib.rs 的 "quit" 分支）。
                stop_proxy_before_exit(&app);
                handle.exit(0);
            } else {
                eprintln!("[update] handoff-ready 握手超时或失败，主窗口保持存活");
            }
        });

        Ok(format!("更新程序已启动，日志：{}", log_path.display()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 非 Windows 平台暂不支持应用内自更新（本项目发布形态为 Windows 桌面端）
        let _ = (app, log_path);
        Err("当前平台暂不支持应用内自更新，请手动执行 git pull 并重新构建".into())
    }
}

/// 解析用于运行更新脚本的 PowerShell 可执行文件。
///
/// 优先级：`WORKBUDDY2API_POWERSHELL` 显式指定 > PATH 上的 pwsh（7+，不受 Store 别名影响）
/// > 系统自带 Windows PowerShell 5.1（`%SystemRoot%\System32\WindowsPowerShell\v1.0\`）。
///
/// ⚠️ 5.1 回退不可省：pwsh 是独立安装项，干净 Windows 上未必存在；
/// 而更新脚本本身已兼容 5.1（无 BOM 写入、避免 5.1 不支持的语法）。
/// 只返回 "pwsh" 会让缺 pwsh 的机器在 `cmd.spawn()` 处以
/// 「无法启动更新程序：系统找不到指定的文件」失败，用户完全无从判断原因。
#[cfg(target_os = "windows")]
fn resolve_powershell() -> String {
    if let Some(p) = env_compat("POWERSHELL").filter(|p| Path::new(p).exists()) {
        return p;
    }
    // PATH 上能找到 pwsh 就用它（版本更新、行为更一致）
    if which("pwsh").is_some() {
        return "pwsh".to_string();
    }
    // 回退系统自带 5.1：路径由 %SystemRoot% 派生，不硬编码盘符
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let ps51 = Path::new(&system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if ps51.exists() {
        return ps51.to_string_lossy().to_string();
    }
    // 都找不到仍返回 "pwsh"，让调用方的 spawn 报错带上原始信息
    "pwsh".to_string()
}

/// 在 PATH 中查找可执行文件（仅 Windows）。
///
/// 之所以不用 `std::process::Command::new("pwsh").arg("--version")` 探测：
/// 那会真的启动一个进程（几十到上百毫秒，且可能被 Store 别名弹窗干扰）。
/// 这里只做「PATH 中是否存在该文件」的纯查询。
#[cfg(target_os = "windows")]
fn which(exe: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<String> = std::env::var("PATHEXT")
        .map(|v| v.split(';').map(|s| s.trim().to_string()).collect())
        .unwrap_or_else(|_| vec![".COM".into(), ".EXE".into(), ".BAT".into(), ".CMD".into()]);

    for dir in std::env::split_paths(&path_var) {
        // 先试原名，再按 PATHEXT 补后缀（pwsh.exe / pwsh.cmd 等）
        let direct = dir.join(exe);
        if path_is_executable(&direct) {
            return Some(direct);
        }
        for ext in &exts {
            let candidate = dir.join(format!("{exe}{ext}"));
            if path_is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// 可执行判定：Windows 上不能只用 `is_file()` —— Store 版 pwsh 的
/// `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe` 是 **AppExecLink 重解析点**，
/// `is_file()` 对它返回 false，导致 which 静默找不到 pwsh → 回退 PS 5.1 →
/// 5.1 按 GBK 读无 BOM UTF-8 脚本 → 解析即死（真实踩到：更新脚本无声闪退、
/// 无日志无状态文件）。判定口径放宽为「metadata 可查询即放行」：
/// 宽松方向的误差只是「选中坏 shell 然后 spawn 失败可见」，
/// 严格方向的误差是「跳过存在的 shell 静默降级」，后者伤害大得多。
#[cfg(target_os = "windows")]
fn path_is_executable(p: &Path) -> bool {
    std::fs::metadata(p).is_ok()
}

#[cfg(not(target_os = "windows"))]
fn path_is_executable(p: &Path) -> bool {
    p.is_file()
}

/// 读取更新编排脚本写入的阶段状态（供前端轮询显示实时进度）。
///
/// 契约：状态文件由 `scripts/app-update/windows.ps1` 原子写入，
/// 字段为 camelCase（PowerShell 侧 `[ordered]@{}` + ConvertTo-Json 输出），
/// 这里按名字逐个取值再转成 snake_case 返回，避免两侧字段名风格打架。
///
/// 失败不报错：文件不存在（从未更新过）或半截 JSON（正在写）都返回 None，
/// 前端据此显示「无进行中的更新」，而不是弹错误。
#[tauri::command]
pub fn app_update_state() -> Result<Option<AppUpdateState>, String> {
    let path = local_app_dir().join("update").join("app-update-state.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    // 容忍 UTF-8 BOM：Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
    // 而 serde_json 遇到 BOM 直接解析失败 —— 那会让整条进度显示静默失效。
    // 脚本侧已改用无 BOM 写入（主防线），这里是防御性兜底。
    let raw = raw.trim_start_matches('\u{feff}');
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        // 正在被脚本写入（读到半截）时按「暂无状态」处理，下次轮询会拿到完整内容
        return Ok(None);
    };

    let text = |key: &str| -> Option<String> {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };

    Ok(Some(AppUpdateState {
        run_id: text("run_id"),
        updater_pid: value.get("updater_pid").and_then(|v| v.as_u64()).or_else(|| value.get("pid").and_then(|v| v.as_u64())),
        phase: text("phase").unwrap_or_default(),
        message: text("message").unwrap_or_default(),
        failure_kind: text("failureKind").unwrap_or_default(),
        detail: text("detail").unwrap_or_default(),
        updated_at: value.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(0),
        pid: value.get("pid").and_then(|v| v.as_u64()).unwrap_or(0),
    }))
}

/// 该状态是否表示「更新仍在推进」（用于决定要不要接续显示进度）。
///
/// ⚠️ **终态（`done` / `failed` / `rolled-back`）绝不能算「推进中」**：它们表示
/// 脚本已经收尾，接续它们只会让用户每次启动都看到一个早已结束的弹窗。
/// 与 `phase_is_handoff_ready_or_later` 是不同的判据 —— 那个问「握手是否已过点」，
/// 这个问「还有没有活干」，别合并。
fn phase_is_in_progress(phase: &str) -> bool {
    matches!(
        phase,
        "handoff-ready"
            | "preparing"
            | "fetching"
            | "merging"
            | "deps"
            | "frontend"
            | "building"
            | "verifying"
            | "restarting"
            | "rolling-back"
    )
}

/// 更新进程（`windows.ps1`）是否仍存活。
///
/// ⚠️ **PID 必须与命令行同时校验**：PID 会被系统复用，只看「PID 存在」会把无关进程
/// 误认成更新进程，于是**永远接续**一个早已死掉的更新（用户关不掉弹窗）。
/// 命令行须含 `windows.ps1` 且属于本项目（`app-update`）。
///
/// 用 tasklist 而非 PowerShell：实测 tasklist 约 20ms、PowerShell 约 100ms，
/// 而这是个会在启动路径上被调用的查询。查不到（无此 PID）即判「不存活」。
#[cfg(target_os = "windows")]
fn updater_process_alive(pid: u64) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let pid = pid as u32;

    // ① 进程是否真存在（tasklist 过滤后无输出 = 不存在；报错则保守判「存活」，
    //    宁可让用户看到一次残留弹窗，也不要在查询失败时谎报「更新已结束」）
    let listed = match std::process::Command::new("tasklist")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return true,
    };
    let text = String::from_utf8_lossy(&listed.stdout);
    // CSV 形态：`"powershell.exe","1234",...`；无匹配时是本地化提示（不含引号字段）
    if !text.trim_start().starts_with('"') {
        return false;
    }

    // ② 命令行必须确实是本项目的更新脚本（防 PID 复用误判）
    let script = format!(
        "(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}' -ErrorAction SilentlyContinue).CommandLine"
    );
    let cmdline = match std::process::Command::new("powershell")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-Command", &script])
        .output()
    {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_lowercase().to_string(),
        // 查询失败：保守判「存活」（见上）
        Err(_) => return true,
    };
    cmdline.contains("windows.ps1") && cmdline.contains("app-update")
}

#[cfg(not(target_os = "windows"))]
fn updater_process_alive(_pid: u64) -> bool {
    false
}

/// 接续判断：本次启动是否应继续显示某个「进行中」的更新。
///
/// 返回 `Some(state)` 表示确实还在推进（照常显示进度视图）；`None` 表示不该接续。
///
/// ⚠️ 这条防线的由来（2026-09-20 用户实测）：更新脚本被用户关窗杀死后，state.json
/// 永久停在 `restarting`（脚本再没机会写终态）。前端原先只查 `phase` 是否属于
/// 「进行中」，于是**每次启动应用都弹出关不掉的「正在更新」弹窗** —— 应用本身可用，
/// 但启动即被劫持，用户连重启软件都摆脱不了。
/// 判据从「phase 看起来在进行中」收紧为「phase 在进行中 **且** 更新进程还活着」。
#[tauri::command]
pub fn app_update_resume() -> Result<Option<AppUpdateState>, String> {
    let Some(state) = app_update_state()? else {
        return Ok(None);
    };
    if !phase_is_in_progress(&state.phase) {
        return Ok(None);
    }
    match state.updater_pid {
        // 进程已死：更新不可能再推进，不接续（并顺手把状态收尾成终态，
        // 避免每次启动都重走一遍这段判断）。
        Some(pid) if !updater_process_alive(pid) => {
            let _ = mark_stale_update_finished(&state);
            Ok(None)
        }
        // 没有 updater_pid 字段（旧版脚本写入的状态）：保守不接续 —— 无从证明它还在跑。
        None => Ok(None),
        Some(_) => Ok(Some(state)),
    }
}

/// 把「脚本已死但状态停在非终态」的残留收尾成 `failed`，让前端不会再接续它。
///
/// 用 `failed` + `updater-gone` 而非 `done`：我们**无法确认**更新是否成功
/// （脚本可能死在构建中途），谎报 `done` 会让用户以为更新已完成而不再检查。
fn mark_stale_update_finished(state: &AppUpdateState) -> std::io::Result<()> {
    let dir = local_app_dir().join("update");
    let path = dir.join("app-update-state.json");
    // 保留原字段形态（camelCase，与脚本一致），只改 phase/message/failureKind
    let payload = serde_json::json!({
        "run_id": state.run_id,
        "updater_pid": state.updater_pid,
        "phase": "failed",
        "message": "上次更新未正常结束（更新进程已退出）",
        "failureKind": "updater-gone",
        "detail": "更新脚本已不在运行，无法继续。请重新点击「检查更新」发起一次完整更新。",
        "updatedAt": chrono::Utc::now().timestamp_millis(),
        "pid": state.pid,
    });
    atomic_write_file(&path, &payload.to_string())
}
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AppUpdateState {
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub updater_pid: Option<u64>,
    pub phase: String,
    pub message: String,
    pub failure_kind: String,
    pub detail: String,
    pub updated_at: i64,
    pub pid: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wba_update_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 在测试目录里跑一条 git 命令。
    ///
    /// 宿主配置必须隔离：`user.name`/`user.email` 用环境变量直接给定（CI 容器里没有
    /// 全局身份，不隔离就 commit 失败），并把 global/system 配置指向空设备（防止
    /// 宿主设了 `hooksPath`/`core.fsmonitor` 之类改变本测试所依赖的行为）。
    fn git_run(root: &Path, args: &[&str]) {
        let null_cfg = if cfg!(windows) { "NUL" } else { "/dev/null" };
        let mut cmd = std::process::Command::new("git");
        cmd.args(args)
            .current_dir(root)
            .env("GIT_CONFIG_GLOBAL", null_cfg)
            .env("GIT_CONFIG_SYSTEM", null_cfg)
            .env("GIT_AUTHOR_NAME", "dirty-test")
            .env("GIT_AUTHOR_EMAIL", "dirty-test@example.com")
            .env("GIT_COMMITTER_NAME", "dirty-test")
            .env("GIT_COMMITTER_EMAIL", "dirty-test@example.com")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE");
        let out = cmd
            .output()
            .expect("git 不可用：dirty 判定测试需要真实 git 可执行文件");
        assert!(
            out.status.success(),
            "git {:?} 失败：{}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 建一个真实 git 仓库并完成一次初始提交（默认分支 main）。
    fn git_init_commit(root: &Path) {
        git_run(root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("file.txt"), "base").unwrap();
        git_run(root, &["add", "-A"]);
        git_run(root, &["commit", "-q", "-m", "base"]);
    }

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn parse_compare_maps_payload_and_reverses_to_newest_first() {
        let payload: serde_json::Value = serde_json::from_str(
            r#"{
              "ahead_by": 2,
              "commits": [
                {"sha": "1111111111111111111111111111111111111111",
                 "commit": {"message": "fix(agents): 旧的一条\n\n正文不该进列表",
                            "author": {"name": "alice"},
                            "committer": {"date": "2026-09-16T10:00:00Z"}}},
                {"sha": "2222222222222222222222222222222222222222",
                 "commit": {"message": "feat(ui): 新的一条",
                            "author": {"name": "bob"},
                            "committer": {"date": "2026-09-16T11:00:00Z"}}}
              ]
            }"#,
        )
        .unwrap();
        let (behind, commits) = parse_compare(&payload).unwrap();
        assert_eq!(behind, 2);
        assert_eq!(commits.len(), 2);
        // 反转后最新在前
        assert_eq!(commits[0].sha, "2222222222222222222222222222222222222222");
        assert_eq!(commits[0].summary, "feat(ui): 新的一条");
        assert_eq!(commits[0].author, "bob");
        assert_eq!(commits[1].summary, "fix(agents): 旧的一条");
        assert_eq!(commits[0].at, 1789556400); // 2026-09-16T11:00:00Z
    }

    #[test]
    fn parse_compare_rejects_malformed_payload() {
        // 形状异常必须返回 None（调用方据此保持「数量未知」），不得编造数字
        for raw in [
            r#"{}"#,
            r#"{"ahead_by": "2"}"#,
            r#"{"ahead_by": -1}"#,
            "[]",
            "null",
        ] {
            let payload: serde_json::Value = serde_json::from_str(raw).unwrap();
            assert!(parse_compare(&payload).is_none(), "载荷 {raw} 应被拒绝");
        }
    }

    #[test]
    fn parse_compare_drops_entries_without_sha() {
        let payload: serde_json::Value = serde_json::from_str(
            r#"{"ahead_by":1,"commits":[{"commit":{"message":"no sha"}},
               {"sha":"3333333333333333333333333333333333333333","commit":{"message":"ok"}}]}"#,
        )
        .unwrap();
        let (_, commits) = parse_compare(&payload).unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].summary, "ok");
    }

    #[test]
    fn decide_reports_no_update_when_tips_match() {
        let (behind, available, commits) = decide(SHA_A, SHA_A, None);
        assert_eq!(behind, Some(0));
        assert!(!available);
        assert!(commits.is_empty());
    }

    #[test]
    fn decide_reports_local_ahead_as_not_behind() {
        // 核心防误报：tip 不同但 ahead_by==0 ⇒ 本地领先，不得提示更新
        let (behind, available, commits) = decide(SHA_A, SHA_B, Some((0, Vec::new())));
        assert_eq!(behind, Some(0));
        assert!(
            !available,
            "本地领先时提示更新会诱导用户覆盖掉自己的提交"
        );
        assert!(commits.is_empty());
    }

    #[test]
    fn decide_reports_behind_with_commit_list() {
        let list = vec![UpdateCommit {
            sha: "c".into(),
            summary: "fix: x".into(),
            author: "a".into(),
            at: 1,
        }];
        let (behind, available, commits) = decide(SHA_A, SHA_B, Some((3, list)));
        assert_eq!(behind, Some(3));
        assert!(available);
        assert_eq!(commits.len(), 1);
    }

    #[test]
    fn decide_keeps_count_unknown_when_compare_fails() {
        // compare 失败（限流 / 本地独有提交 404）：诚实报告「有更新、数量未知」
        let (behind, available, commits) = decide(SHA_A, SHA_B, None);
        assert_eq!(behind, None);
        assert!(available);
        assert!(commits.is_empty());
    }

    #[test]
    fn cache_is_fresh_is_keyed_on_head_and_branch() {
        // 「有更新」结果：TTL 24h
        let available = AppUpdateInfo {
            supported: true,
            branch: "main".into(),
            current_sha: SHA_A.into(),
            update_available: true,
            fetched_at: 1_000_000,
            ..Default::default()
        };
        let now = 1_000_000 + CHECK_TTL_MS - 1;
        assert!(cache_is_fresh(&available, SHA_A, "main", now));

        // HEAD 变化（刚应用完更新）→ 立即失效，不残留「有更新」
        assert!(!cache_is_fresh(&available, SHA_B, "main", now));
        // 分支变化 → 失效
        assert!(!cache_is_fresh(&available, SHA_A, "dev", now));
        // 过期 → 失效
        assert!(!cache_is_fresh(&available, SHA_A, "main", 1_000_000 + CHECK_TTL_MS));
    }

    #[test]
    fn cache_clean_result_expires_sooner_than_available() {
        // ⚠️ 「无更新」必须比「有更新」短得多：缓存键里没有远端 tip，
        // 远端推了新提交而本机 exe 未变时键照旧命中——24h 的「已是最新」
        // 会把远端新提交挡在门外，用户点检查更新等于没查（真实踩到：
        // exe=3d094fc、远端已到 514fad9，弹窗仍显示「已是最新」）。
        let clean = AppUpdateInfo {
            supported: true,
            branch: "main".into(),
            current_sha: SHA_A.into(),
            update_available: false,
            fetched_at: 1_000_000,
            ..Default::default()
        };
        // 10 分钟内有效（省 API），超过即失效（保时效）
        assert!(cache_is_fresh(&clean, SHA_A, "main", 1_000_000 + CHECK_CLEAN_TTL_MS - 1));
        assert!(!cache_is_fresh(
            &clean,
            SHA_A,
            "main",
            1_000_000 + CHECK_CLEAN_TTL_MS
        ));
        // 同一时刻「有更新」仍有效（24h）——它不会骗人：用户下一步就是点更新
        let available = AppUpdateInfo {
            update_available: true,
            ..clean.clone()
        };
        assert!(cache_is_fresh(
            &available,
            SHA_A,
            "main",
            1_000_000 + CHECK_CLEAN_TTL_MS
        ));
    }

    #[test]
    fn cache_failure_entries_expire_sooner() {
        let failed = AppUpdateInfo {
            supported: true,
            branch: "main".into(),
            current_sha: SHA_A.into(),
            fetched_at: 0,
            error: Some("HTTP 429".into()),
            ..Default::default()
        };
        // 失败缓存 1h 后即失效，好让用户重试；「有更新」成功缓存同样时刻仍有效
        assert!(!cache_is_fresh(&failed, SHA_A, "main", CHECK_FAILURE_TTL_MS));
        let good = AppUpdateInfo {
            error: None,
            update_available: true,
            ..failed.clone()
        };
        assert!(cache_is_fresh(&good, SHA_A, "main", CHECK_FAILURE_TTL_MS));
    }

    #[test]
    fn working_tree_dirty_detects_in_progress_merge() {
        let root = tmp_dir("merge");
        let git = root.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        assert!(!working_tree_dirty(&root));
        std::fs::write(git.join("MERGE_HEAD"), SHA_B).unwrap();
        assert!(working_tree_dirty(&root), "合并中间态必须判为不干净");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 干净树（刚提交完）必须判为「不脏」。
    ///
    /// ⚠️ 这条锁定的是一个真实误报（2026-09-20 用户实测）：旧实现拿
    /// `.git/index` 的 mtime 与 `.git/HEAD` 比大小，而 **commit 只更新 index、
    /// 不更新 HEAD 文件**（HEAD 只在 checkout / 分支切换时才重写）——
    /// 于是每次提交之后，`index > HEAD` 恒成立，**干净树被永久误报为「有未提交改动」**，
    /// 用户在有可用更新时会看到「检测到工作区有未提交改动」的恐吓文案。
    /// 这与该函数文档宣称的「宁可漏报也不误报」正好相反。
    #[test]
    fn working_tree_dirty_is_false_after_clean_commit() {
        let root = tmp_dir("clean_commit");
        git_init_commit(&root);

        // 前置：确认这个仓库确实是干净的（否则测试自身前提不成立）
        let out = std::process::Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&root)
            .env("GIT_CONFIG_GLOBAL", if cfg!(windows) { "NUL" } else { "/dev/null" })
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&out.stdout).trim().is_empty(),
            "测试前提不成立：新建仓库在提交后本应是干净的"
        );

        assert!(
            !working_tree_dirty(&root),
            "刚提交完的干净工作树被判为「有未提交改动」——用户在更新弹窗里会看到\
             虚假的恐吓文案（index.mtime 在每次提交后都晚于 HEAD 文件）"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 有未提交改动时必须判为「脏」（反向锁定，防止修复过度而永远说「干净」）。
    #[test]
    fn working_tree_dirty_detects_unstaged_and_staged_changes() {
        let root = tmp_dir("dirty_real");
        git_init_commit(&root);

        // ① 未暂存的改动
        std::fs::write(root.join("file.txt"), "modified").unwrap();
        assert!(working_tree_dirty(&root), "未暂存的改动必须判为不干净");

        // ② 已暂存的改动（模拟 git add 之后）
        git_run(&root, &["add", "-A"]);
        assert!(working_tree_dirty(&root), "已暂存的改动必须判为不干净");

        // ③ 未跟踪文件（更新脚本会用 `git stash -u` 一并保存，故也属「不干净」）
        git_run(&root, &["reset", "-q", "--hard"]);
        std::fs::write(root.join("untracked.txt"), "new").unwrap();
        assert!(working_tree_dirty(&root), "未跟踪文件也会被 stash -u 保存，应判为不干净");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn handoff_script_path_is_relative_to_install_root() {
        let root = PathBuf::from("D:\\repo");
        assert!(handoff_script_path(&root)
            .to_string_lossy()
            .replace('/', "\\")
            .ends_with("scripts\\app-update\\windows.ps1"));
    }

    #[test]
    fn api_urls_match_github_conventions() {
        assert_eq!(
            branch_tip_api_url("o/r", "main"),
            "https://api.github.com/repos/o/r/commits/main"
        );
        assert_eq!(
            compare_api_url("o/r", "aaa", "bbb"),
            "https://api.github.com/repos/o/r/compare/aaa...bbb"
        );
    }

    #[test]
    fn state_parsing_tolerates_utf8_bom() {
        // Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
        // serde_json 遇到 BOM 会直接失败 —— 而 app_update_state 的容错会把
        // 解析失败降级成 None，于是整条进度显示静默失效（用户仍只看到黑屏）。
        // 这里锁定「剥掉 BOM 后必须能解析出各字段」。
        let body = r#"{"phase":"building","message":"正在编译应用","failureKind":"","detail":"","updatedAt":1789573868187,"pid":2976}"#;
        let with_bom = format!("\u{feff}{body}");

        // 不剥 BOM 时确实解析失败（证明这个防御不是多余的）
        assert!(
            serde_json::from_str::<serde_json::Value>(&with_bom).is_err(),
            "serde_json 不再拒绝 BOM？则本防御可移除以简化代码"
        );

        // 剥掉 BOM 后必须成功，且字段取值正确
        let stripped = with_bom.trim_start_matches('\u{feff}');
        let value: serde_json::Value = serde_json::from_str(stripped).unwrap();
        assert_eq!(value.get("phase").unwrap().as_str().unwrap(), "building");
        assert_eq!(
            value.get("message").unwrap().as_str().unwrap(),
            "正在编译应用"
        );
        assert_eq!(value.get("updatedAt").unwrap().as_i64().unwrap(), 1789573868187);
    }

    #[test]
    fn resolve_powershell_falls_back_to_windows_powershell() {
        // 文档承诺「回退 Windows PowerShell 5.1」，实现必须真的做到：
        // pwsh 是独立安装项，干净 Windows 上未必存在；只返回 "pwsh" 会让
        // 那些机器在 spawn 处以「系统找不到指定的文件」失败，用户无从判断原因。
        let resolved = resolve_powershell();
        assert!(!resolved.is_empty(), "解析结果不得为空");

        // 本机（CI 与本机）至少存在系统自带 5.1，因此结果必须指向一个真实文件；
        // 若结果是无路径的 "pwsh"，则必须它在 PATH 上确实存在。
        let path = Path::new(&resolved);
        if path.components().count() > 1 {
            assert!(
                path.is_file(),
                "resolve_powershell 返回了带路径但不存在的文件：{resolved}"
            );
        } else {
            assert!(
                which(&resolved).is_some(),
                "resolve_powershell 返回了裸命令名 {resolved}，但 PATH 上找不到它"
            );
        }
    }

    #[test]
    fn which_finds_existing_and_rejects_missing() {
        // 纯 PATH 查询：找到的必须是真实文件，找不到的必须返回 None
        if let Some(found) = which("pwsh") {
            assert!(found.is_file(), "which 返回了不存在的路径：{}", found.display());
        }
        assert!(
            which("definitely-not-a-real-exe-9f3a2b").is_none(),
            "which 对不存在的程序返回了 Some"
        );
    }

    #[test]
    fn build_sha_is_baked_at_compile_time() {
        // build.rs 必须把构建提交注入二进制：这是「本 exe 是哪个提交构建的」唯一真源。
        // 比较与缓存必须使用完整 40 位 SHA；无 git 构建回退 unknown。
        let sha = build_sha();
        assert!(!sha.is_empty(), "WORKBUDDY2API_BUILD_SHA 未注入（build.rs 失效）");
        let ok = sha == "unknown"
            || (sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(ok, "构建 sha 形状异常：{sha:?}（应为完整 40 位 sha 或 unknown）");
    }

    #[test]
    fn version_comparison_uses_build_sha_not_worktree_head() {
        // 核心回归：本项目源码留在检出目录，工作树 HEAD 会被 pull 推进到最新，
        // 而运行中的 exe 仍是旧提交的产物。若版本比对读工作树，就会把
        // 「运行的是旧版本」谎报成「已是最新」（真实踩到：exe=88b0f7e / 工作树=d1cb787）。
        //
        // 这里用源码形状锁定：check_app_update 里 current_sha 必须来自 build_sha()，
        // 且不得再出现直接读工作树 HEAD 赋给 current_sha 的写法。
        //
        // ⚠️ 只取测试模块之前的生产代码：include_str! 会把测试模块自身也读进来，
        // 断言里的字符串字面量会命中自己（恒真的假绿）。截断到 #[cfg(test)] 之前。
        let src = include_str!("update.rs");
        let production = src.split("#[cfg(test)]").next().unwrap_or(src);
        let code: String = production
            .split('\n')
            .map(|line| line.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            code.contains("let current_sha = build_sha().to_string()"),
            "current_sha 未取自 build_sha()：读工作树会把「运行的是旧版本」谎报成「已是最新」"
        );
        // 拼出禁用串，避免字面量再次出现在源码里造成自指
        let forbidden = ["let current_sha = read_git", "head"].concat();
        assert!(
            !code.contains(&forbidden),
            "current_sha 又改回读工作树 HEAD —— 会再次谎报「已是最新」"
        );
        // 生产代码里不应再有任何「读工作树 HEAD 做版本判定」的入口
        let head_reader = ["read_git", "_head"].concat();
        assert!(
            !code.contains(&head_reader),
            "生产代码仍保留读工作树 HEAD 的函数：它已无合法用途，留着只会被误用为版本比对"
        );
    }

    // ── 交接握手判据（2026-09-20 修复：等值比对导致 98.6% 概率误判超时）──────────

    #[test]
    fn handoff_phase_accepts_ready_and_all_later_stages() {
        // 核心回归：脚本写完 handoff-ready 后立刻写 preparing（实测间隔 ~2ms），
        // 轮询 150ms 一次 —— 等值比对会错过瞬时值。判据必须接受「已到达或更晚」。
        assert!(phase_is_handoff_ready_or_later("handoff-ready"));
        assert!(
            phase_is_handoff_ready_or_later("preparing"),
            "preparing 是 handoff-ready 的紧邻后继，必须判定为已握手（否则误报超时）"
        );
        for later in [
            "fetching",
            "merging",
            "deps",
            "frontend",
            "building",
            "verifying",
            "restarting",
            "done",
            "rolling-back",
            "rolled-back",
        ] {
            assert!(
                phase_is_handoff_ready_or_later(later),
                "{later} 晚于 handoff-ready，视窗必然已就绪，不得判为未握手"
            );
        }
    }

    #[test]
    fn handoff_phase_rejects_pre_handoff_and_failed_states() {
        // failed 有独立分支处理（中止退出而非判定就绪），此处必须为 false，
        // 否则会把「脚本启动即失败」误判成交接成功而照常退出。
        assert!(!phase_is_handoff_ready_or_later("failed"));
        // 握手之前的阶段不应被视为就绪
        assert!(!phase_is_handoff_ready_or_later(""));
        assert!(!phase_is_handoff_ready_or_later("unknown"));
        assert!(!phase_is_handoff_ready_or_later("checking"));
    }

    #[test]
    fn handoff_phase_covers_every_phase_the_script_writes() {
        // 三源一致性：脚本里出现的每个 Write-State -Phase 值，要么在
        // phase_is_handoff_ready_or_later 的白名单内，要么是 failed（独立分支）。
        // 漏一个 → 那个阶段出现时判为「未握手」→ 误报超时（本次 bug 的成因）。
        let script = include_str!("../../../scripts/app-update/windows.ps1");
        let mut seen = std::collections::BTreeSet::new();
        for line in script.lines() {
            if let Some(pos) = line.find("Write-State -Phase '") {
                let rest = &line[pos + "Write-State -Phase '".len()..];
                if let Some(end) = rest.find('\'') {
                    seen.insert(rest[..end].to_string());
                }
            }
        }
        assert!(!seen.is_empty(), "未能从脚本中解析出任何 Phase（提取逻辑或脚本结构变了）");
        for phase in &seen {
            if phase == "failed" {
                continue; // 独立分支：中止退出，不判就绪
            }
            assert!(
                phase_is_handoff_ready_or_later(phase),
                "脚本会写入阶段 `{phase}`，但 phase_is_handoff_ready_or_later 不认识它 → \
                 该阶段出现时会被判为「握手未完成」并误报超时。白名单需同步。"
            );
        }
    }

}
