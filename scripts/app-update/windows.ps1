<#
.SYNOPSIS
    WorkBuddy2API 应用内自动更新编排脚本（交接式 + 启动确认）。

.DESCRIPTION
    由 GUI 的「立即更新」按钮以分离进程方式拉起，或由用户手动执行以排障。
    检测机制对齐 Hermes Desktop，交接与启动确认参考 EasyCLIProxyAPI。

    完整流程：
      1.  等待发起更新的 GUI 进程退出（它必须先死，才能动工作树与重建 exe）；
      2.  git stash 保存未提交改动（有的话）；
      3.  git fetch + git merge --ff-only 快进（本地领先/分叉则中止，绝不覆盖用户提交）；
      4.  package-lock.json 变化时才 npm ci，然后 npm run build 重建前端；
      5.  cargo tauri build --no-bundle 重建 exe —— ⚠️ 必须走 tauri CLI，
          裸 cargo build --release 会因缺少 custom-protocol feature 静默产出无前端的空壳；
      6.  校验产物（尺寸显著大于空壳基准 + 前端资源名已内嵌）；
      7.  拉起新 exe 并**等待启动确认**（进程存活 + 反代端口探活）；
          确认失败 → 回滚到更新前 commit → 重新构建并拉起旧版，避免把用户留在崩溃版本上。
      8.  恢复 stash。

    全程把阶段与进度写入 $StatePath（JSON），GUI 侧轮询显示，用户不会看到黑屏。

    ⚠️ 关于反代：converter.py 是 GUI 的子进程，GUI 退出时它随之结束。
    这是本机 Hermes 会话链路所依赖的服务，因此更新必然中断当前会话——
    更新完成后脚本会拉起新 GUI，服务随 GUI 启动恢复。

.PARAMETER InstallRoot
    源码检出根目录（含 .git 与其下的 src-tauri/package.json）。

.PARAMETER Branch
    要更新到的远端分支，默认 main。

.PARAMETER GuiPid
    发起本次更新的 GUI 进程 PID；脚本会等它退出。手动排障时可传 0 跳过等待。

.PARAMETER LogPath
    日志文件路径。

.PARAMETER StatePath
    阶段/进度状态文件（JSON）。GUI 轮询它显示实时进度。

.PARAMETER CurrentBuildSha
    发起更新的 GUI **自身**的构建提交短 sha。

    ⚠️ 判定「是否需要重建」必须用它，而不是工作树 HEAD：本项目源码留在检出目录，
    工作树会被 pull 推进到最新，而跑着的 exe 仍是旧提交产物。只看工作树会得出
    「已是最新，无需重建」→ 用户点了更新却什么都没发生（真实踩到过）。

.PARAMETER Port
    反代实际监听端口，用于启动确认（探活）。

    ⚠️ 必须由 GUI 传入其配置真源（`load_app_config().port`）。**不得**在本脚本里
    写死 8787：端口可配置，用户配成 9000 时新版会正常监听 9000，而写死 8787 的
    探活必然失败 → 90 秒后误判 startup-unhealthy → 把**正常的新版**回滚掉。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [string]$Branch = 'main',
    [Parameter(Mandatory = $true)][int]$GuiPid,
    [string]$LogPath,
    [string]$StatePath,
    [string]$CurrentBuildSha = '',
    [Parameter(Mandatory = $true)][int]$Port
)

$ErrorActionPreference = 'Stop'

$updateDir = Join-Path $env:LOCALAPPDATA 'workbuddy2api\update'
if ([string]::IsNullOrWhiteSpace($LogPath)) { $LogPath = Join-Path $updateDir 'app-update.log' }
if ([string]::IsNullOrWhiteSpace($StatePath)) { $StatePath = Join-Path $updateDir 'app-update-state.json' }

$logDir = Split-Path -Parent $LogPath
if ($logDir -and -not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    try {
        # 同样避开 `Add-Content -Encoding UTF8`：5.1 下新建文件会写入 BOM，
        # 让日志首行多出不可见字符（用记事本打开才看得出来）。
        $line = "[$stamp] [$Level] $Message`r`n"
        [System.IO.File]::AppendAllText($LogPath, $line, (New-Object System.Text.UTF8Encoding $false))
    } catch { }
}

# 阶段名与前端 i18n 一一对应；detail 是给人看的一句话
function Write-State {
    param(
        [Parameter(Mandatory = $true)][string]$Phase,
        [string]$Message = '',
        [string]$FailureKind = '',
        [string]$Detail = ''
    )
    $payload = [ordered]@{
        phase       = $Phase
        message     = $Message
        failureKind = $FailureKind
        detail      = $Detail
        updatedAt   = [int64]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds
        pid         = $PID
    }
    try {
        # 原子替换：GUI 可能正在读，不能让它读到半截 JSON
        $tmp = "$StatePath.tmp"
        # ⚠️ 必须用 .NET 的无 BOM UTF-8 编码：Windows PowerShell 5.1 的
        # `Set-Content -Encoding UTF8` 会写入 BOM（EF BB BF），而 Rust 侧
        # serde_json 解析带 BOM 的 JSON 会失败 → 进度显示整体静默失效。
        $json = $payload | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding $false))
        Move-Item -LiteralPath $tmp -Destination $StatePath -Force
    } catch {
        Write-Log "写入状态文件失败：$_" 'WARN'
    }
    Write-Log "[$Phase] $Message"
}

# 失败分类：让用户看到「哪一步、为什么」，而不是笼统的「更新失败」
$script:FailureKind = 'unknown'
function Throw-Failure {
    param([string]$Kind, [string]$Message)
    $script:FailureKind = $Kind
    throw $Message
}

function Invoke-Logged {
    param([string]$FilePath, [string[]]$Arguments, [string]$What)
    Write-Log "执行：$FilePath $($Arguments -join ' ')"
    $out = & $FilePath @Arguments 2>&1
    $code = $LASTEXITCODE
    foreach ($line in $out) { Write-Log "  $line" }
    if ($code -ne 0) { Write-Log "$What 失败（退出码 $code）" 'ERROR' }
    return $code
}

$exePath = Join-Path $InstallRoot 'src-tauri\target\release\workbuddy2api.exe'
# 裸 cargo build --release 的空壳基准尺寸：产物明显小于它即说明前端没进包
$SHELL_BASELINE_BYTES = 15572992
# 反代探活地址：端口由 GUI 传入（配置真源 load_app_config().port），**不写死**。
# GUI 起来后会拉起 converter.py，该端口通即证明整条链路活着。
#
# ⚠️ 必须探 **/health**（免鉴权），不能探 /v1/models：
# /v1/models 走 converter.py 的 `_check_auth`，配了密钥后无认证请求一律 401。
# 实测（模拟「密钥已配」的内核）：探 /v1/models 时 Wait-PortReleased 在 0.1s 内
# 就因 401 误判「端口已释放」（内核其实还活着），且 90s 健康检查必然全 401 →
# 误判 startup-unhealthy → **把正常的新版回滚掉**。与端口写死是同一类错误。
# /health 在内核里明确设计为免鉴权（只返回 status/authenticated 两个布尔），
# 且不依赖凭据可用性 —— 作为「进程活着且 HTTP 在服务」的判据最合适。
$PROXY_HEALTH_URL = "http://127.0.0.1:$Port/health"

function Start-WorkBuddy {
    param([string]$Reason)
    if (-not (Test-Path $exePath)) {
        Write-Log "产物不存在，无法拉起：$exePath" 'ERROR'
        return $null
    }
    Write-Log "拉起应用（$Reason）：$exePath"
    try {
        return Start-Process -FilePath $exePath -WorkingDirectory $InstallRoot -PassThru
    } catch {
        Write-Log "拉起应用失败：$_" 'ERROR'
        return $null
    }
}

<#
    启动确认（借鉴 EasyCLIProxyAPI 的 ack 等待 + 时序判据）：
    拉起后必须确认「进程活着」且「反代端口可用」。仅确认进程存在是不够的——
    本项目 GUI 启动后要拉起 Python 内核，内核起不来时 GUI 进程仍在但不提供服务，
    用户看到的仍是坏掉的应用。

    ⚠️ 为什么必须要求「端口先消失再出现」而不是只看「最终可用」：
    converter.py 没有父进程退出检测（实测：GUI 退出后它变孤儿继续存活），
    因此旧内核可能一直占着该端口。若只判「最终可用」，就会出现
    「新版 GUI 启动即崩 → 旧内核仍在响应 → 健康检查拿到 2xx → 误判成功」，
    把崩溃版本当成更新成功留在盘上。先等端口消失，可证明旧内核确实退了，
    此后端口上的 2xx 必然来自新启动的进程。

    宽容期设计：给旧进程一段退出时间（默认 30s）。若超时仍未释放，
    再宽限一轮「最终可用」判定（有上限），避免把「旧内核残留」误判成
    「新版失败」而触发不必要的回滚——两种情况都不可取，但后者代价更大。
#>
# 等到探活不再返回 2xx（旧内核确实退出）或超时
function Test-ProxyEndpoint {
    param([Parameter(Mandatory = $true)][string]$Url)
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
            return @{ ok = $true; reason = "HTTP $($resp.StatusCode)" }
        }
        return @{ ok = $false; reason = "HTTP $($resp.StatusCode)" }
    } catch {
        return @{ ok = $false; reason = $_.Exception.Message }
    }
}

# 等到探活不再返回 2xx（旧内核确实退出）或超时
# 等到探活不再返回 2xx（旧内核确实退出）或超时。
# ⚠️ 依赖 $PROXY_HEALTH_URL 指向**免鉴权**端点，否则会因 401 立刻误判「已释放」。
function Wait-PortReleased {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [int]$TimeoutSeconds = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $probe = Test-ProxyEndpoint -Url $Url
        if (-not $probe.ok) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

function Wait-WorkBuddyHealthy {
    param(
        [Parameter(Mandatory = $true)]$Process,
        [int]$TimeoutSeconds = 90
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($Process -and $Process.HasExited) {
            return @{ ok = $false; reason = "新版应用启动后立即退出（退出码 $($Process.ExitCode)）" }
        }
        $probe = Test-ProxyEndpoint -Url $PROXY_HEALTH_URL
        if ($probe.ok) {
            return @{ ok = $true; reason = "反代已在 $PROXY_HEALTH_URL 响应（$($probe.reason)）" }
        }
        Start-Sleep -Milliseconds 1000
    }
    return @{ ok = $false; reason = "$TimeoutSeconds 秒内未能确认服务可用（$PROXY_HEALTH_URL 无响应）" }
}

function Show-FailureMessage {
    param([string]$Message)
    try {
        Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
        [System.Windows.MessageBox]::Show($Message, 'WorkBuddy2API 更新失败', 'OK', 'Error') | Out-Null
    } catch {
        Write-Log "无法弹出失败对话框：$_" 'ERROR'
    }
}

Write-State -Phase 'preparing' -Message '正在准备更新'
Write-Log '============================================================'
Write-Log "更新开始：branch=$Branch root=$InstallRoot guiPid=$GuiPid"

# ── 1. 等 GUI 退出 ──────────────────────────────────────────────────────────
# 必须先等它消失：GUI 是 converter.py 的父进程且持有 exe 文件锁，
# 未退出就重建会因文件占用失败，且工作树仍在被读取。
if ($GuiPid -gt 0) {
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Process -Id $GuiPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Get-Process -Id $GuiPid -ErrorAction SilentlyContinue) {
        Write-State -Phase 'failed' -Message '等待应用退出超时' -FailureKind 'gui-exit-timeout' `
            -Detail "PID $GuiPid 仍在运行。请手动退出应用后重试。"
        Show-FailureMessage "等待应用退出超时（PID $GuiPid 仍在运行），更新已中止。请手动退出应用后重试。"
        exit 1
    }
    Write-Log 'GUI 已退出'
    # 给 converter.py 收尾时间：释放监听端口与文件句柄，否则重建会撞占用
    Start-Sleep -Seconds 2
}

$previousSha = $null
$stashed = $false

try {
    Push-Location $InstallRoot

    # ── 2. 记录更新前状态（回滚用） ─────────────────────────────────────────
    Write-State -Phase 'preparing' -Message '正在检查工作区'
    $previousSha = (& git rev-parse HEAD 2>&1 | Select-Object -First 1).ToString().Trim()
    if ($LASTEXITCODE -ne 0 -or -not $previousSha) {
        Throw-Failure 'not-a-git-checkout' "无法读取当前提交（$InstallRoot 不是有效的 git 检出）"
    }
    Write-Log "更新前 HEAD：$previousSha"

    $dirty = (& git status --porcelain 2>&1) -join "`n"
    if (-not [string]::IsNullOrWhiteSpace($dirty)) {
        Write-Log "工作树有未提交改动，先 stash 保存：`n$dirty"
        $stashCode = Invoke-Logged -FilePath 'git' -Arguments @('stash', 'push', '-u', '-m', "workbuddy2api auto-update $(Get-Date -Format 'yyyyMMdd-HHmmss')") -What 'git stash'
        if ($stashCode -eq 0) { $stashed = $true }
        else { Throw-Failure 'stash-failed' '工作树有未提交改动且 stash 失败，为避免丢失改动已中止更新' }
    }

    # ── 3. 快进到远端分支 ───────────────────────────────────────────────────
    # --ff-only：本地领先或已分叉时直接失败，绝不产生合并提交或覆盖用户提交
    Write-State -Phase 'fetching' -Message "正在获取 origin/$Branch"
    if ((Invoke-Logged -FilePath 'git' -Arguments @('fetch', 'origin', $Branch) -What 'git fetch') -ne 0) {
        Throw-Failure 'fetch-failed' "git fetch origin $Branch 失败（网络或代理问题）"
    }

    $targetSha = (& git rev-parse "origin/$Branch" 2>&1 | Select-Object -First 1).ToString().Trim()

    # ⚠️ 是否需要重建，取决于「工作树 vs **运行中的产物**」，而不是「工作树 vs 远端」。
    # 本项目源码留在检出目录：用户可能已手动 pull 过，或上一次更新中途失败，
    # 此时工作树已比跑着的 exe 新，远端却没有新提交。只看远端会得出
    # 「无需重建」→ 用户点了更新却什么都没发生（真实踩到过）。
    $needsRebuild = $false
    if (-not $CurrentBuildSha -or $CurrentBuildSha -eq 'unknown') {
        # 拿不到构建版本（无 git 构建 / 未知）→ 保守重建，慢但正确
        Write-Log '未获得运行版本的构建提交，保守起见执行重建'
        $needsRebuild = $true
    } elseif ($CurrentBuildSha -ne $previousSha) {
        Write-Log "工作树（$previousSha）已比运行中的产物（$CurrentBuildSha）新，需要重建"
        $needsRebuild = $true
    }

    if ($targetSha -ne $previousSha) {
        Write-State -Phase 'merging' -Message '正在快进到最新提交'
        if ((Invoke-Logged -FilePath 'git' -Arguments @('merge', '--ff-only', "origin/$Branch") -What 'git merge --ff-only') -ne 0) {
            Throw-Failure 'diverged' "无法快进到 origin/$Branch：本地存在未推送的提交。请手动处理分叉后重试。"
        }
        $currentSha = (& git rev-parse HEAD 2>&1 | Select-Object -First 1).ToString().Trim()
        Write-Log "已快进：$previousSha -> $currentSha"
        $needsRebuild = $true
    } else {
        Write-Log "远端 $Branch 无新提交（工作树已是 $previousSha）"
    }

    if (-not $needsRebuild) {
        Write-Log '工作树与运行中的产物一致，无需重建'
        # 此路径不重建、不回滚，恢复改动是安全的（与成功路径同理，只是更早返回）。
        if ($stashed) {
            if ((Invoke-Logged -FilePath 'git' -Arguments @('stash', 'pop') -What 'git stash pop') -ne 0) {
                Write-Log 'stash 恢复冲突，改动仍保存在 git stash 中，请手动 git stash pop' 'WARN'
            }
        }
        Write-State -Phase 'done' -Message '已是最新版本，无需更新'
        Start-WorkBuddy -Reason '无更新' | Out-Null
        exit 0
    }

    # ── 4. 依赖与前端重建 ───────────────────────────────────────────────────
    # 依赖是否变化的比对基准取「运行中的产物」，才能覆盖「工作树早已领先」的情形。
    # 短 sha 用 rev-parse 解析为完整 sha（也可能因不在此仓库而失败 → 回退）。
    $diffBase = $previousSha
    if ($CurrentBuildSha -and $CurrentBuildSha -ne 'unknown') {
        $resolved = (& git rev-parse --verify --quiet "$CurrentBuildSha^{commit}" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $resolved) { $diffBase = $resolved.ToString().Trim() }
    }
    $changedFiles = @(& git diff --name-only $diffBase HEAD 2>&1)
    $lockChanged = $changedFiles -contains 'package-lock.json'

    if ($lockChanged) {
        Write-State -Phase 'deps' -Message '依赖有变化，正在安装依赖'
        if ((Invoke-Logged -FilePath 'npm' -Arguments @('ci') -What 'npm ci') -ne 0) {
            Throw-Failure 'deps-failed' 'npm ci 失败（依赖安装未完成）'
        }
    } else {
        Write-Log 'package-lock.json 未变化，跳过 npm ci'
    }

    Write-State -Phase 'frontend' -Message '正在构建前端'
    if ((Invoke-Logged -FilePath 'npm' -Arguments @('run', 'build') -What '前端构建') -ne 0) {
        Throw-Failure 'frontend-build-failed' 'npm run build 失败（前端构建未通过）'
    }

    # ── 5. Rust 重建（必须走 tauri CLI） ────────────────────────────────────
    Write-State -Phase 'building' -Message '正在编译应用（此步耗时较长）'
    Push-Location (Join-Path $InstallRoot 'src-tauri')
    try {
        # ⚠️ 绝不改成 cargo build --release：custom-protocol feature 只有 tauri CLI 会带上，
        # plain cargo 会静默产出无前端的空壳 exe 且照常打印成功。
        if ((Invoke-Logged -FilePath 'cargo' -Arguments @('tauri', 'build', '--no-bundle') -What 'Rust 重建') -ne 0) {
            Throw-Failure 'rust-build-failed' 'cargo tauri build 失败（Rust 编译未通过）'
        }
    } finally {
        Pop-Location
    }

    # ── 6. 产物校验 ─────────────────────────────────────────────────────────
    Write-State -Phase 'verifying' -Message '正在校验构建产物'
    if (-not (Test-Path $exePath)) {
        Throw-Failure 'artifact-missing' "重建后未找到产物：$exePath"
    }

    $size = (Get-Item -LiteralPath $exePath).Length
    Write-Log "产物尺寸：$size 字节（空壳基准 $SHELL_BASELINE_BYTES）"
    if ($size -le $SHELL_BASELINE_BYTES) {
        Throw-Failure 'artifact-suspicious' "产物尺寸 $size 不大于空壳基准 $SHELL_BASELINE_BYTES，疑似未内嵌前端（构建日志说成功不作数）"
    }

    # 前端资源名必须能在 exe 中命中（dist/assets/index-<hash>.js）
    $assetsDir = Join-Path $InstallRoot 'dist\assets'
    $entryName = $null
    if (Test-Path $assetsDir) {
        $entry = Get-ChildItem -Path $assetsDir -Filter 'index-*.js' -File | Select-Object -First 1
        if ($entry) { $entryName = $entry.Name }
    }
    if ($entryName) {
        $bytes = [System.IO.File]::ReadAllBytes($exePath)
        $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
        if ($ascii.Contains($entryName)) {
            Write-Log "产物已内嵌前端资源：$entryName"
        } else {
            Throw-Failure 'artifact-suspicious' "产物中未找到前端资源名 $entryName，前端未进包"
        }
    } else {
        Write-Log 'dist/assets 下未找到 index-*.js，跳过资源内嵌校验' 'WARN'
    }

    # ⚠️ 此处**刻意不**恢复 stash：见下方第 7 步的说明与 catch 分支的时序。
    # 曾经的写法在这里提前 `stash pop`，一旦后续启动确认失败触发回滚，
    # `git reset --hard $previousSha` 会把刚弹回的改动一并抹掉，而 catch 里的
    # 第二次 pop 只会得到「No stash entries found」——用户未提交的工作**静默丢失**。
    # 提前 pop 对构建和启动毫无影响（exe 早已编译完成），却换来一条数据丢失路径。

    # ── 7. 拉起并等待启动确认（借鉴 EasyCLIProxyAPI 的 ack 等待 + 时序判据） ──
    # 先等旧内核把端口交出来，这样后面探到的 2xx 必然来自新进程，而不是残留的旧内核。
    Write-State -Phase 'restarting' -Message '正在等待旧服务释放端口'
    if (Wait-PortReleased -Url $PROXY_HEALTH_URL -TimeoutSeconds 30) {
        Write-Log "端口已释放（$PROXY_HEALTH_URL）"
    } else {
        # 旧内核没退干净：继续等下去只会白耗；标记为「可能残留」但仍带时序判据继续验活。
        # 这里刻意不判失败——把「旧进程残留」误判成「新版失败」会错误回滚，代价更大。
        Write-Log "端口在 30 秒内未释放（$PROXY_HEALTH_URL），继续启动并放宽判定" 'WARN'
    }

    Write-State -Phase 'restarting' -Message '正在启动新版本'
    $proc = Start-WorkBuddy -Reason '更新完成'

    $health = Wait-WorkBuddyHealthy -Process $proc -TimeoutSeconds 90
    if ($health.ok) {
        Write-Log "启动确认通过：$($health.reason)"
        # ✅ 唯一的 stash 恢复点（成功路径）：此刻已完成全部 git 操作且不会再回滚，
        # 恢复用户改动是安全的。放在更早的位置会让回滚的 reset --hard 抹掉它们；
        # 放在更晚（本就无更晚）则用户改动会被长期留在 stash 里而不自知。
        if ($stashed) {
            if ((Invoke-Logged -FilePath 'git' -Arguments @('stash', 'pop') -What 'git stash pop') -ne 0) {
                Write-Log 'stash 恢复冲突（新版本可能改动了同一文件），改动仍保存在 git stash 中，请手动 git stash pop' 'WARN'
            } else {
                Write-Log '已恢复更新前的未提交改动（git stash pop）'
            }
        }
        Write-State -Phase 'done' -Message '更新完成，新版本已启动'
        exit 0
    }

    # 启动确认失败：新版可能是坏的。回滚 + 重建 + 拉起旧版，绝不能把用户留在崩溃版本上。
    Write-Log "启动确认失败：$($health.reason)" 'ERROR'
    Throw-Failure 'startup-unhealthy' $health.reason
}
catch {
    $message = $_.Exception.Message
    $kind = $script:FailureKind
    Write-Log "更新失败（$kind）：$message" 'ERROR'

    $rolledBack = $false
    if ($previousSha) {
        Write-State -Phase 'rolling-back' -Message '更新失败，正在回滚到更新前的版本'
        try {
            Push-Location $InstallRoot
            Write-Log "回滚到 $previousSha"
            Invoke-Logged -FilePath 'git' -Arguments @('reset', '--hard', $previousSha) -What '回滚' | Out-Null
            if ($stashed) { Invoke-Logged -FilePath 'git' -Arguments @('stash', 'pop') -What 'git stash pop' | Out-Null }
            $rolledBack = $true
        } catch {
            Write-Log "回滚过程出错：$_" 'ERROR'
        } finally {
            Pop-Location -ErrorAction SilentlyContinue
        }
    }

    if ($rolledBack) {
        # 源码已回旧版，但 exe 可能已被新版覆盖 → 必须重建，否则拉起的是坏 exe
        try {
            Write-State -Phase 'rolling-back' -Message '正在重新构建回滚后的版本'
            Push-Location $InstallRoot
            Invoke-Logged -FilePath 'npm' -Arguments @('run', 'build') -What '回滚后前端构建' | Out-Null
            Push-Location (Join-Path $InstallRoot 'src-tauri')
            try {
                Invoke-Logged -FilePath 'cargo' -Arguments @('tauri', 'build', '--no-bundle') -What '回滚后 Rust 重建' | Out-Null
            } finally {
                Pop-Location
            }
        } catch {
            Write-Log "回滚后重建失败：$_" 'ERROR'
        } finally {
            Pop-Location -ErrorAction SilentlyContinue
        }
    }

    $hint = switch ($kind) {
        'fetch-failed' { '网络或代理不可用，无法获取远端提交。' }
        'diverged' { '本地有未推送的提交，与远端分叉。请手动处理后再更新。' }
        'stash-failed' { '工作区改动未能安全保存，已中止以免丢失。' }
        'deps-failed' { '依赖安装失败，通常是网络问题。' }
        'frontend-build-failed' { '前端构建失败，代码可能有问题。' }
        'rust-build-failed' { 'Rust 编译失败，代码可能有问题。' }
        'artifact-suspicious' { '构建产物异常（疑似未内嵌前端），已拒绝使用。' }
        'startup-unhealthy' { '新版本启动后服务不可用，已回滚到更新前的版本。' }
        default { '请查看日志了解详情。' }
    }

    Write-State -Phase 'failed' -Message '更新失败' -FailureKind $kind `
        -Detail "$message`n$hint"

    Show-FailureMessage "自动更新失败：$message`n`n$hint`n`n详细日志：$LogPath`n`n$(if ($rolledBack) { '已回滚到更新前的版本。' } else { '未能回滚，请手动检查工作区。' })"

    Start-WorkBuddy -Reason '更新失败回滚后' | Out-Null
    exit 1
}
finally {
    # 确保无论成功失败都回到原始工作目录。
    # ⚠️ 不能用 `(Get-Location -Stack).Path` 之类写法：栈为空时它会抛错，
    # 在 finally 里抛错会顶替掉 try 中真正的失败原因，让日志丢失关键信息。
    for ($i = 0; $i -lt 8; $i++) {
        try {
            if ((Get-Location -Stack).Count -le 0) { break }
            Pop-Location -ErrorAction Stop
        } catch { break }
    }
    Write-Log '============================================================'
}
