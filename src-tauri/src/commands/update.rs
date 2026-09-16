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
/// 检测结果缓存 TTL：成功 24h、失败 1h（失败重试更勤，但不会每次轮询都打 API）
const CHECK_TTL_MS: i64 = 24 * 60 * 60 * 1000;
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

/// 读取本地 HEAD 的完整 commit SHA。支持普通检出、detached HEAD 与 packed-refs。
///
/// 之所以不 shell 出 `git rev-parse`：用户机器未必装 git，而读 `.git/HEAD` 是纯文件操作，
/// 成功率更高，也让判定逻辑可在单测里直接构造目录验证。
fn read_git_head(root: &Path) -> Option<String> {
    let git_dir = resolve_git_dir(root)?;
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim().to_string();

    // 普通检出：HEAD 内容是 "ref: refs/heads/main"
    let Some(reference) = head.strip_prefix("ref:") else {
        // detached HEAD：HEAD 直接就是 40 位 SHA
        return is_sha(&head).then_some(head);
    };
    let reference = reference.trim();

    // 松散引用优先
    if let Ok(raw) = std::fs::read_to_string(git_dir.join(reference)) {
        let sha = raw.trim().to_string();
        if is_sha(&sha) {
            return Some(sha);
        }
    }

    // 已被 pack 的引用：`.git/packed-refs` 里形如 "<sha> <refname>"
    let packed = std::fs::read_to_string(git_dir.join("packed-refs")).ok()?;
    for line in packed.lines() {
        let line = line.trim();
        // '#' 是文件头注释，'^' 是 annotated tag 指向的 commit，均跳过
        if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let (Some(sha), Some(name)) = (parts.next(), parts.next()) else {
            continue;
        };
        if name == reference && is_sha(sha) {
            return Some(sha.to_string());
        }
    }
    None
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
/// 一旦应用了更新或切了分支，HEAD 变化即刻失效，24h TTL 不会残留假的「有更新」。
fn cache_is_fresh(cached: &AppUpdateInfo, current_sha: &str, branch: &str, now: i64) -> bool {
    if cached.current_sha != current_sha || cached.branch != branch {
        return false;
    }
    let ttl = if cached.error.is_some() {
        CHECK_FAILURE_TTL_MS
    } else {
        CHECK_TTL_MS
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
    let current_sha = read_git_head(&root).unwrap_or_default();
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

/// 工作区是否有未提交改动的近似判定。
///
/// 精确比对需要完整 git 实现（index vs HEAD tree）；这里用两个高置信信号：
/// ① 存在 `MERGE_HEAD` / `rebase-merge` / `rebase-apply` 等中间态（必然「不干净」）；
/// ② `.git/index` 的 mtime 晚于 `HEAD` 引用文件 —— 提交或暂存都会先更新 HEAD/index。
/// 宁可漏报（脚本仍会 stash）也不误报，因为误报会让用户在干净树上看到「有改动」的恐吓文案。
fn working_tree_dirty(root: &Path) -> bool {
    let Some(git_dir) = resolve_git_dir(root) else {
        return false;
    };
    if git_dir.join("MERGE_HEAD").exists()
        || git_dir.join("rebase-merge").exists()
        || git_dir.join("rebase-apply").exists()
    {
        return true;
    }
    let (Ok(idx), Ok(head)) = (
        git_dir.join("index").metadata(),
        git_dir.join("HEAD").metadata(),
    ) else {
        return false;
    };
    matches!((idx.modified(), head.modified()), (Ok(a), Ok(b)) if a > b)
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
    let log_dir = local_app_dir().join("update");
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log_path = log_dir.join("app-update.log");

    // 分离启动：DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP，使父进程退出后脚本继续运行。
    // 必须 -NoProfile 且用 pwsh 优先（Store 别名版本无关）；脚本自身负责等 GUI 退出。
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

        let shell = resolve_powershell();
        let mut cmd = std::process::Command::new(shell);
        cmd.arg("-NoProfile")
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
            .current_dir(&root)
            .stdin(std::process::Stdio::null())
            // stdout/stderr 交由脚本自己写日志文件，避免句柄继承导致父进程退出被拖住
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        cmd.spawn().map_err(|e| format!("无法启动更新程序：{e}"))?;

        // 让前端有时间把界面切到「更新中」再退出：脚本正等待本 PID 消失才动工作树，
        // 因此这里必须真正退出进程，否则更新永远不会开始。
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            handle.exit(0);
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

/// 优先 pwsh（PowerShell 7+，版本无关且不受 Store 别名影响），回退 Windows PowerShell 5.1。
#[cfg(target_os = "windows")]
fn resolve_powershell() -> String {
    if let Some(p) = env_compat("POWERSHELL").filter(|p| Path::new(p).exists()) {
        return p;
    }
    "pwsh".to_string()
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

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn read_git_head_supports_loose_ref() {
        let root = tmp_dir("loose");
        let git = root.join(".git");
        std::fs::create_dir_all(git.join("refs/heads")).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(git.join("refs/heads/main"), format!("{SHA_A}\n")).unwrap();
        assert_eq!(read_git_head(&root).as_deref(), Some(SHA_A));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_git_head_supports_detached_head() {
        let root = tmp_dir("detached");
        let git = root.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), format!("{SHA_B}\n")).unwrap();
        assert_eq!(read_git_head(&root).as_deref(), Some(SHA_B));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_git_head_falls_back_to_packed_refs() {
        let root = tmp_dir("packed");
        let git = root.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(
            git.join("packed-refs"),
            format!("# pack-refs with: peeled\n{SHA_A} refs/heads/main\n{SHA_B} refs/heads/dev\n"),
        )
        .unwrap();
        assert_eq!(read_git_head(&root).as_deref(), Some(SHA_A));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_git_head_returns_none_without_git() {
        let root = tmp_dir("nogit");
        assert_eq!(read_git_head(&root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_git_head_resolves_worktree_gitdir_file() {
        // worktree 场景：.git 是文件，内容为 "gitdir: <绝对路径>"
        let real = tmp_dir("wt_real");
        std::fs::create_dir_all(real.join("refs/heads")).unwrap();
        std::fs::write(real.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(real.join("refs/heads/main"), format!("{SHA_B}\n")).unwrap();
        let wt = tmp_dir("wt_root");
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", real.to_string_lossy())).unwrap();
        assert_eq!(read_git_head(&wt).as_deref(), Some(SHA_B));
        let _ = std::fs::remove_dir_all(&real);
        let _ = std::fs::remove_dir_all(&wt);
    }

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
        let base = AppUpdateInfo {
            supported: true,
            branch: "main".into(),
            current_sha: SHA_A.into(),
            fetched_at: 1_000_000,
            ..Default::default()
        };
        let now = 1_000_000 + CHECK_TTL_MS - 1;
        assert!(cache_is_fresh(&base, SHA_A, "main", now));

        // HEAD 变化（刚应用完更新）→ 立即失效，不残留「有更新」
        assert!(!cache_is_fresh(&base, SHA_B, "main", now));
        // 分支变化 → 失效
        assert!(!cache_is_fresh(&base, SHA_A, "dev", now));
        // 过期 → 失效
        assert!(!cache_is_fresh(&base, SHA_A, "main", 1_000_000 + CHECK_TTL_MS));
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
        // 失败缓存 1h 后即失效，好让用户重试；成功缓存同样时刻仍有效
        assert!(!cache_is_fresh(&failed, SHA_A, "main", CHECK_FAILURE_TTL_MS));
        let good = AppUpdateInfo {
            error: None,
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
}
