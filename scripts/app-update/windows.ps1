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

# ---------------------------------------------------------------------------
# 进度微型 Web 视窗（Hermes 同款体验：基于 ui.html + Edge/Chrome --app，无边框暗黑科技风）
# ---------------------------------------------------------------------------
$script:UiStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:UiState = [hashtable]::Synchronized(@{
    status               = 'running'
    message              = '正在准备更新…'
    detail               = ''
    clock                = $script:UiStopwatch
    receipt              = $null
    acknowledged_receipt = $null
})
$script:UiServer = $null
$script:ProgressText = '正在准备更新…'

function Get-UiHtmlPath {
    $p = Join-Path $PSScriptRoot 'ui.html'
    if (Test-Path -LiteralPath $p) { return $p }
    return $null
}

function Get-DefaultBrowserExe {
    $progId = $null
    foreach ($proto in @('https', 'http')) {
        try {
            $progId = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\$proto\UserChoice" -Name ProgId -ErrorAction Stop).ProgId
        } catch { continue }
        if ($progId) { break }
    }
    if ($progId) {
        try {
            $cmd = (Get-ItemProperty -Path "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction Stop).'(default)'
            if ($cmd -and $cmd -match '"([^"]+\.exe)"') {
                $exe = $Matches[1]
                if (Test-Path -LiteralPath $exe) { return $exe }
            }
        } catch { }
    }
    $candidates = @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge Dev\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge Dev\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

function Start-UiServer([string]$HtmlPath) {
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $serverPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port

        $rs = [runspacefactory]::CreateRunspace()
        $rs.Open()
        $rs.SessionStateProxy.SetVariable('Listener', $listener)
        $rs.SessionStateProxy.SetVariable('State', $script:UiState)
        $rs.SessionStateProxy.SetVariable('HtmlBytes', [System.IO.File]::ReadAllBytes($HtmlPath))

        $ps = [powershell]::Create()
        $ps.Runspace = $rs
        [void]$ps.AddScript({
            function Send-Response($Stream, [string]$Status, [string]$ContentType, [byte[]]$Body) {
                $head = "HTTP/1.1 $Status`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
                $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
                $Stream.Write($headBytes, 0, $headBytes.Length)
                $Stream.Write($Body, 0, $Body.Length)
                $Stream.Flush()
            }
            while ($true) {
                try { $client = $Listener.AcceptTcpClient() } catch { break }
                try {
                    $client.ReceiveTimeout = 2000
                    $stream = $client.GetStream()
                    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
                    $request = $reader.ReadLine()
                    while ($true) { $h = $reader.ReadLine(); if ($null -eq $h -or $h -eq '') { break } }
                    if ($request -match '^GET /progress HTTP/1\.[01]$') {
                        $elapsed = [Math]::Floor($State.clock.Elapsed.TotalSeconds)
                        $snapshot = @{
                            status          = $State.status
                            message         = $State.message
                            detail          = $State.detail
                            elapsed_seconds = $elapsed
                            receipt         = $State.receipt
                        } | ConvertTo-Json -Compress
                        Send-Response $stream '200 OK' 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($snapshot))
                    } elseif ($request -match '^POST /ack/([^ /?]+) HTTP/1\.[01]$') {
                        $receipt = $Matches[1]
                        if ($State.status -in @('done', 'rolled-back', 'failed') -and $State.receipt -and $receipt -ceq $State.receipt) {
                            Send-Response $stream '204 No Content' 'text/plain' ([byte[]]@())
                            $State.acknowledged_receipt = $receipt
                        } else {
                            Send-Response $stream '409 Conflict' 'text/plain' ([System.Text.Encoding]::ASCII.GetBytes('unknown receipt'))
                        }
                    } elseif ($request -match '^GET / HTTP/1\.[01]$') {
                        Send-Response $stream '200 OK' 'text/html; charset=utf-8' $HtmlBytes
                    } else {
                        Send-Response $stream '404 Not Found' 'text/plain' ([System.Text.Encoding]::ASCII.GetBytes('not found'))
                    }
                } catch {
                } finally {
                    try { $client.Close() } catch { }
                }
            }
        })
        [void]$ps.BeginInvoke()

        $ready = $false
        $readyDeadline = [DateTime]::UtcNow.AddSeconds(10)
        while (-not $ready -and [DateTime]::UtcNow -lt $readyDeadline) {
            try {
                $probe = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$serverPort/progress")
                $probe.Timeout = 1000
                $probe.ReadWriteTimeout = 1000
                $probe.KeepAlive = $false
                $resp = $probe.GetResponse()
                try { $ready = ([int]$resp.StatusCode -eq 200) } finally { $resp.Close() }
            } catch {
                Start-Sleep -Milliseconds 100
            }
        }
        if (-not $ready) {
            Write-Log 'progress server did not answer /progress within 10s; continuing without UI' 'WARN'
            try { $listener.Stop() } catch { }
            try { $ps.Stop() } catch { }
            try { $rs.Close() } catch { }
            return $null
        }

        return @{ Listener = $listener; Runspace = $rs; PowerShell = $ps; Port = $serverPort; BrowserProc = $null; Profile = $null }
    } catch {
        Write-Log "Start-UiServer 异常：$_" 'WARN'
        try { if ($listener) { $listener.Stop() } } catch { }
        return $null
    }
}

function Start-ProgressWindow {
    try {
        $htmlPath = Get-UiHtmlPath
        $browser = Get-DefaultBrowserExe
        if ($htmlPath -and $browser) {
            $server = Start-UiServer $htmlPath
            if ($server) {
                $browserProfile = Join-Path $env:TEMP ("workbuddy2api-update-ui-{0}" -f $PID)
                $browserArgs = @(
                    "--app=http://127.0.0.1:$($server.Port)/",
                    "--user-data-dir=$browserProfile",
                    "--no-first-run", "--no-default-browser-check",
                    "--window-size=380,320"
                )
                $bProc = Start-Process -FilePath $browser -ArgumentList $browserArgs -PassThru
                $server.BrowserProc = $bProc
                $server.Profile = $browserProfile
                $script:UiServer = $server
                Write-Log "微型 Web 过渡视窗已在 127.0.0.1:$($server.Port) 启动（PID $($bProc.Id)）"
            }
        }
    } catch {
        Write-Log "启动微型 Web 过渡视窗失败（不阻断更新）：$_" 'WARN'
    }

    # 写入 handoff-ready：向主 GUI 宣告外部更新环境已就绪（主窗口可安全退出）
    Write-State -Phase 'handoff-ready' -Message '更新环境已就绪'
}

function Update-ProgressWindow {
    param([Parameter(Mandatory = $true)][string]$Message, [string]$Detail = '')
    $script:ProgressText = $Message
    $script:UiState.message = $Message
    if ($Detail) { $script:UiState.detail = $Detail }
}

function Stop-ProgressWindow {
    param([switch]$LeaveWindow, [string]$FinalMessage = '')
    if (-not $script:UiServer) { return }
    if ($FinalMessage) { $script:UiState.message = $FinalMessage }
    try { $script:UiServer.Listener.Stop() } catch { }
    try { $script:UiServer.PowerShell.Stop() } catch { }
    try { $script:UiServer.Runspace.Close() } catch { }
    if (-not $LeaveWindow) {
        try {
            if ($script:UiServer.BrowserProc -and -not $script:UiServer.BrowserProc.HasExited) {
                $script:UiServer.BrowserProc.CloseMainWindow() | Out-Null
            }
        } catch { }
    }
    try {
        if ($script:UiServer.Profile -and (Test-Path -LiteralPath $script:UiServer.Profile)) {
            Remove-Item -LiteralPath $script:UiServer.Profile -Recurse -Force -ErrorAction SilentlyContinue
        }
    } catch { }
    $script:UiServer = $null
}

function Publish-UiTerminal {
    param([string]$Status, [string]$Message, [string]$Detail = '')
    $receipt = [Guid]::NewGuid().ToString('N')
    $script:UiState.receipt = $receipt
    $script:UiState.acknowledged_receipt = $null
    $script:UiState.message = $Message
    $script:UiState.detail = $Detail
    $script:UiState.status = $Status
    if ($script:UiServer) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        while ($script:UiState.acknowledged_receipt -cne $receipt -and $sw.Elapsed.TotalSeconds -lt 4) {
            Start-Sleep -Milliseconds 50
        }
    }
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
    # 进度窗同步刷新：状态文件的每个阶段都实时可见（Hermes 同款体验）
    if ($Message) { Update-ProgressWindow -Message $Message -Detail $Detail }
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

    ⚠️ 旧内核超时未释放时的处理（外部评审定级 P1，采纳）：等不到端口释放就**不允许
    进入健康确认**。uvicorn 对端口被占的行为是实测确认的：`loop.create_server` 抛
    `OSError`（WinError 10048）→ uvicorn 记日志后 `sys.exit(STARTUP_FAILURE=3)`
    —— 即新版内核**必然起不来**，此后端口上的任何 2xx 都来自残留旧内核，
    健康检查只会产生「假成功」。所以超时 = 直接 Throw-Failure 'port-not-released'，
    进入回滚（回滚前会先终止本次拉起的新版 GUI，见 catch 分支），绝不接受
    来源可疑的 2xx。原则：**「把坏版本宣布成功」比「更新失败并回滚」危险得多**。
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
    # ⚠️ 拉起失败（$null）时绝不继续探活：端口上的 2xx 只可能来自残留旧内核，
    # 继续探只会把「没启动」误判成「启动成功」（外部评审定级 P1）。
    if (-not $Process) {
        return @{ ok = $false; reason = '新版应用未能启动（Start-WorkBuddy 返回空）' }
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) {
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
    param([string]$Message, [string]$Detail = '')
    # 彻底废除 MessageBox.Show：改为通过 ui.html 现代 Web 视窗就地展示
    Publish-UiTerminal -Status 'failed' -Message $Message -Detail $Detail
}

Start-ProgressWindow   # Hermes 同款：微型 Web 视窗置顶显示，更新不再是后台黑箱
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
        Publish-UiTerminal -Status 'failed' -Message '等待应用退出超时' -Detail "PID $GuiPid 仍在运行。请手动退出应用后重试。"
        Stop-ProgressWindow -LeaveWindow
        exit 1
    }
    Write-Log 'GUI 已退出'
    # 给 converter.py 收尾时间：释放监听端口与文件句柄，否则重建会撞占用
    Start-Sleep -Seconds 2
}

$previousSha = $null
$stashed = $false
$proc = $null   # 本次拉起的新版 GUI 进程；catch 分支按此 PID 精确终止

try {
    Push-Location $InstallRoot

    # ── 2. 记录更新前状态（回滚用） ─────────────────────────────────────────
    Write-State -Phase 'preparing' -Message '正在检查工作区'
    # ⚠️ 外部原生命令输出绝不能直接管道流向 Select-Object -First 1：
    # PowerShell 7 (pwsh) 的管道提前终止机制会在下游拿到首行后立即关闭输入流，
    # 导致原生命令非正常终止或 $LASTEXITCODE 被清空为 $null。
    # 而 PowerShell 中 `$null -ne 0` 为 True，会把成功的 git rev-parse 误判为失败。
    # 必须先由变量完整接收输出，保留真实的 $LASTEXITCODE。
    $headOutput = (& git rev-parse HEAD 2>&1)
    if ($LASTEXITCODE -ne 0 -or -not $headOutput) {
        Throw-Failure 'not-a-git-checkout' "无法读取当前提交（$InstallRoot 不是有效的 git 检出）"
    }
    $previousSha = ($headOutput | Select-Object -First 1).ToString().Trim()
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

    $targetOutput = (& git rev-parse "origin/$Branch" 2>&1)
    if ($LASTEXITCODE -ne 0 -or -not $targetOutput) {
        Throw-Failure 'fetch-failed' "无法读取 origin/$Branch 的最新提交"
    }
    $targetSha = ($targetOutput | Select-Object -First 1).ToString().Trim()

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
        $currentOutput = (& git rev-parse HEAD 2>&1)
        $currentSha = ($currentOutput | Select-Object -First 1).ToString().Trim()
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
        Stop-ProgressWindow -FinalMessage '已是最新版本，无需更新。正在拉起应用…'
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
        # ⚠️ 旧内核没退干净 → 新版内核**必然**起不来（uvicorn 端口被占时实测行为：
        # create_server 抛 OSError → sys.exit(STARTUP_FAILURE=3)），此后端口上的
        # 任何 2xx 都来自残留旧内核，健康确认只会产生假成功 → 直接失败回滚，
        # 绝不「放宽判定」继续（外部评审定级 P1：把坏版本宣布成功比回滚更危险）。
        Write-Log "端口在 30 秒内未释放（$PROXY_HEALTH_URL），旧内核疑似残留，中止启动确认" 'ERROR'
        Throw-Failure 'port-not-released' "旧服务未在 30 秒内释放端口（$PROXY_HEALTH_URL）。为避免把残留旧进程的响应误判为新版本健康，已中止更新。"
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
        Stop-ProgressWindow -FinalMessage '更新完成！新版本已启动，本窗口即将关闭。'
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

    # ⚠️ 回滚前必须先终止本次拉起的新版 GUI（外部评审定级 P1）：
    # 健康确认失败时新版 GUI 可能仍活着并持有 exe 文件锁 —— 不先终止，
    # 后面的 `cargo tauri build` 会因文件占用失败，回滚链路断裂。
    # 只按**本次 Start-WorkBuddy 返回的 PID** 精确终止，绝不按 exe 名称全杀
    # （避免误杀用户手动另开的实例）。
    if ($proc -and -not $proc.HasExited) {
        Write-Log "终止本次拉起的新版 GUI（PID $($proc.Id)）"
        try {
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            # 等它真正退出（含内核子进程释放端口），否则回滚重建仍可能撞文件占用
            $deadDeadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $deadDeadline) {
                if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) { break }
                Start-Sleep -Milliseconds 400
            }
            Write-Log '新版 GUI 已终止'
        } catch {
            Write-Log "终止新版 GUI 失败（继续回滚，重建可能因文件占用失败）：$_" 'WARN'
        }
    }

    $rollbackSourceRestored = $false
    $rollbackStashRestored = $true
    $rollbackRebuildOk = $false

    if ($previousSha) {
        Write-State -Phase 'rolling-back' -Message '更新失败，正在回滚到更新前的版本'
        try {
            Push-Location $InstallRoot
            Write-Log "回滚到 $previousSha"
            $resetCode = Invoke-Logged -FilePath 'git' -Arguments @('reset', '--hard', $previousSha) -What '回滚'
            if ($resetCode -eq 0) {
                $rollbackSourceRestored = $true
            } else {
                Write-Log "git reset --hard 回滚失败（退出码 $resetCode），放弃回滚并保留 stash" 'ERROR'
            }
        } catch {
            Write-Log "回滚过程出错：$_" 'ERROR'
        } finally {
            Pop-Location -ErrorAction SilentlyContinue
        }
    }

    if ($rollbackSourceRestored) {
        # 源码已回旧版，必须在纯净 previousSha 下重新构建旧版产物，
        # 严禁在构建前 pop stash（防止未完成代码破坏构建或污染版本指纹）
        try {
            Write-State -Phase 'rolling-back' -Message '正在重新构建回滚后的版本'
            Push-Location $InstallRoot
            $npmCode = Invoke-Logged -FilePath 'npm' -Arguments @('run', 'build') -What '回滚后前端构建'
            if ($npmCode -eq 0) {
                Push-Location (Join-Path $InstallRoot 'src-tauri')
                try {
                    $cargoCode = Invoke-Logged -FilePath 'cargo' -Arguments @('tauri', 'build', '--no-bundle') -What '回滚后 Rust 重建'
                    if ($cargoCode -eq 0) {
                        $rollbackRebuildOk = $true
                    } else {
                        Write-Log "回滚后 Rust 重建失败（退出码 $cargoCode）" 'ERROR'
                    }
                } finally {
                    Pop-Location
                }
            } else {
                Write-Log "回滚后前端构建失败（退出码 $npmCode）" 'ERROR'
            }
        } catch {
            Write-Log "回滚后重建失败：$_" 'ERROR'
        } finally {
            Pop-Location -ErrorAction SilentlyContinue
        }

        # 仅当旧版产物成功重新构建后，才恢复用户改动；
        # 确保旧版 EXE 是纯 previousSha，且 stash pop 即使冲突也不会破坏已构建的产物。
        if ($rollbackRebuildOk -and $stashed) {
            try {
                Push-Location $InstallRoot
                $stashCode = Invoke-Logged -FilePath 'git' -Arguments @('stash', 'pop') -What 'git stash pop'
                if ($stashCode -ne 0) {
                    $rollbackStashRestored = $false
                    Write-Log "git stash pop 恢复失败（退出码 $stashCode），改动仍保留在 stash 中" 'WARN'
                }
            } catch {
                $rollbackStashRestored = $false
                Write-Log "git stash pop 过程出错：$_" 'WARN'
            } finally {
                Pop-Location -ErrorAction SilentlyContinue
            }
        }
    }

    $rolledBack = ($rollbackSourceRestored -and $rollbackRebuildOk)
    $rollbackSummary = if ($rolledBack) {
        if (-not $rollbackStashRestored) {
            '已回滚到更新前的版本并重新构建（但工作区改动 stash pop 恢复失败，仍保存在 stash 中）。'
        } else {
            '已回滚到更新前的版本。'
        }
    } elseif ($rollbackSourceRestored) {
        '源码已回滚，但旧版产物重新构建失败，请手动编译或检查工作区。'
    } else {
        if ($stashed) {
            '未能回滚源码，已放弃恢复 stash 以免污染现场。未提交改动仍安全保存在 git stash 中，请手动检查工作区。'
        } else {
            '未能回滚，请手动检查工作区。'
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
        'port-not-released' { '旧服务未释放端口（残留进程占用），已中止更新以避免误判。请重启电脑后重试。' }
        default { '请查看日志了解详情。' }
    }

    $failureTitle = if ($rolledBack) { '更新未完成' } else { '更新失败' }
    $failureStatus = if ($rolledBack) { 'rolled-back' } else { 'failed' }
    $failureDetail = [string]::Join("`n", @($message, $hint, $rollbackSummary, "详细日志：$LogPath") | Where-Object { $_ })

    Write-State -Phase 'failed' -Message $failureTitle -FailureKind $kind `
        -Detail $failureDetail

    # 外部 ui.html 呈现终端状态并等待用户操作，绝不弹 MessageBox
    Publish-UiTerminal -Status $failureStatus -Message $failureTitle -Detail $failureDetail
    Stop-ProgressWindow -LeaveWindow -FinalMessage $failureTitle

    if ($rolledBack) {
        Start-WorkBuddy -Reason '更新失败回滚后' | Out-Null
    } else {
        Write-Log '回滚未完全成功（源码或重建失败），跳过拉起应用以避免重复启动损坏版本' 'WARN'
    }
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
