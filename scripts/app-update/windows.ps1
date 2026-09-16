<#
.SYNOPSIS
    WorkBuddy2API 应用内自动更新编排脚本（交接式）。

.DESCRIPTION
    由 GUI 内的「立即更新」按钮以分离进程方式拉起。职责与 Hermes Desktop 的
    scripts/desktop-update/windows.ps1 同构：

      1. 等待发起更新的 GUI 进程退出（它必须先死，才能动工作树与重建 exe）；
      2. git fetch + 以 --ff-only 快进到远端分支（本地领先/分叉则中止，绝不覆盖用户提交）；
      3. 工作树有未提交改动时先 git stash 保存，重建成功后再尝试恢复；
      4. npm ci（依赖锁变化时）+ npm run build 重建前端；
      5. cargo tauri build --no-bundle 重建 exe —— ⚠️ 必须走 tauri CLI，
         裸 cargo build --release 会因缺少 custom-protocol feature 静默产出无前端的空壳；
      6. 校验产物（尺寸显著大于空壳基准 + 前端资源名已内嵌）；
      7. 拉起新 exe；失败则回滚到更新前 commit 并重新拉起旧版。

    ⚠️ 关于 8787 反代：converter.py 是 GUI 的子进程，GUI 退出时它随之结束。
    这是本机 Hermes 会话链路所依赖的服务，因此更新必然中断当前会话——
    更新完成后脚本会拉起新 GUI，服务随 GUI 启动恢复。

.PARAMETER InstallRoot
    源码检出根目录（含 .git 与其下的 src-tauri/package.json）。

.PARAMETER Branch
    要更新到的远端分支，默认 main。

.PARAMETER GuiPid
    发起本次更新的 GUI 进程 PID；脚本会等它退出。

.PARAMETER LogPath
    日志文件路径。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [string]$Branch = 'main',
    [Parameter(Mandatory = $true)][int]$GuiPid,
    [string]$LogPath
)

$ErrorActionPreference = 'Stop'

# 无日志路径时落到 %LOCALAPPDATA%\workbuddy2api\update\app-update.log
if ([string]::IsNullOrWhiteSpace($LogPath)) {
    $LogPath = Join-Path $env:LOCALAPPDATA 'workbuddy2api\update\app-update.log'
}

$logDir = Split-Path -Parent $LogPath
if ($logDir -and -not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message, [string]$Level = 'INFO')
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "[$stamp] [$Level] $Message"
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
}

# 所有原生命令的输出都并入日志（成功也记），便于事后定位
function Invoke-Logged {
    param([string]$FilePath, [string[]]$Arguments, [string]$What)
    Write-Log "执行：$FilePath $($Arguments -join ' ')"
    $out = & $FilePath @Arguments 2>&1
    $code = $LASTEXITCODE
    foreach ($line in $out) { Write-Log "  $line" }
    if ($code -ne 0) {
        Write-Log "$What 失败（退出码 $code）" 'ERROR'
    }
    return $code
}

$exePath = Join-Path $InstallRoot 'src-tauri\target\release\workbuddy2api.exe'
# 裸 cargo build --release 的空壳基准尺寸：产物明显小于它即说明前端没进包
$SHELL_BASELINE_BYTES = 15572992

function Start-WorkBuddy {
    param([string]$Reason)
    if (Test-Path $exePath) {
        Write-Log "拉起应用（$Reason）：$exePath"
        Start-Process -FilePath $exePath -WorkingDirectory $InstallRoot | Out-Null
    } else {
        Write-Log "产物不存在，无法拉起：$exePath" 'ERROR'
    }
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

Write-Log '============================================================'
Write-Log "更新开始：branch=$Branch root=$InstallRoot guiPid=$GuiPid"

# ── 1. 等 GUI 退出 ──────────────────────────────────────────────────────────
# 必须先等它消失：GUI 是 converter.py 的父进程且持有 exe 文件锁，
# 未退出就重建会因文件占用失败，且工作树仍在被读取。
$deadline = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $deadline) {
    $proc = Get-Process -Id $GuiPid -ErrorAction SilentlyContinue
    if (-not $proc) { break }
    Start-Sleep -Milliseconds 500
}
if (Get-Process -Id $GuiPid -ErrorAction SilentlyContinue) {
    Write-Log "等待 GUI（PID $GuiPid）退出超时，中止更新" 'ERROR'
    Show-FailureMessage "等待应用退出超时（PID $GuiPid 仍在运行），更新已中止。请手动退出应用后重试。"
    exit 1
}
Write-Log 'GUI 已退出，开始更新工作树'

# GUI 退出后 converter.py 可能仍在收尾，给它一点时间释放 8787 与文件句柄
Start-Sleep -Seconds 2

$previousSha = $null
$stashed = $false

try {
    Push-Location $InstallRoot

    # ── 2. 记录更新前状态（回滚用） ─────────────────────────────────────────
    $previousSha = (& git rev-parse HEAD 2>&1 | Select-Object -First 1).ToString().Trim()
    Write-Log "更新前 HEAD：$previousSha"

    $dirty = (& git status --porcelain 2>&1) -join "`n"
    if (-not [string]::IsNullOrWhiteSpace($dirty)) {
        Write-Log "工作树有未提交改动，先 stash 保存：`n$dirty"
        $stashCode = Invoke-Logged -FilePath 'git' -Arguments @('stash', 'push', '-u', '-m', "workbuddy2api auto-update $(Get-Date -Format 'yyyyMMdd-HHmmss')") -What 'git stash'
        if ($stashCode -eq 0) { $stashed = $true }
        else { throw '工作树有未提交改动且 stash 失败，为避免丢失改动已中止更新' }
    }

    # ── 3. 快进到远端分支 ───────────────────────────────────────────────────
    # --ff-only：本地领先或已分叉时直接失败，绝不产生合并提交或覆盖用户提交
    if ((Invoke-Logged -FilePath 'git' -Arguments @('fetch', 'origin', $Branch) -What 'git fetch') -ne 0) {
        throw "git fetch origin $Branch 失败（网络或代理问题）"
    }

    $targetSha = (& git rev-parse "origin/$Branch" 2>&1 | Select-Object -First 1).ToString().Trim()
    if ($targetSha -eq $previousSha) {
        Write-Log '远端无新提交，无需重建'
        if ($stashed) { Invoke-Logged -FilePath 'git' -Arguments @('stash', 'pop') -What 'git stash pop' | Out-Null }
        Start-WorkBuddy -Reason '无更新'
        exit 0
    }

    if ((Invoke-Logged -FilePath 'git' -Arguments @('merge', '--ff-only', "origin/$Branch") -What 'git merge --ff-only') -ne 0) {
        throw "无法快进到 origin/$Branch（本地可能有未推送的提交）。请手动处理分叉后重试。"
    }
    $currentSha = (& git rev-parse HEAD 2>&1 | Select-Object -First 1).ToString().Trim()
    Write-Log "已快进：$previousSha -> $currentSha"

    # ── 4. 依赖与前端重建 ───────────────────────────────────────────────────
    # 用 git diff --name-only 判断依赖是否变化：比对 lock 文件内容虽然更精确，
    # 但 package-lock.json 常达数万行，两边全量读入只为判断「有没有变」不划算。
    $changedFiles = @(& git diff --name-only $previousSha HEAD 2>&1)
    $lockChanged = $changedFiles -contains 'package-lock.json'

    if ($lockChanged) {
        Write-Log 'package-lock.json 有变化，执行 npm ci'
        if ((Invoke-Logged -FilePath 'npm' -Arguments @('ci') -What 'npm ci') -ne 0) {
            throw 'npm ci 失败'
        }
    } else {
        Write-Log 'package-lock.json 未变化，跳过 npm ci'
    }

    if ((Invoke-Logged -FilePath 'npm' -Arguments @('run', 'build') -What '前端构建') -ne 0) {
        throw 'npm run build 失败'
    }

    # ── 5. Rust 重建（必须走 tauri CLI） ────────────────────────────────────
    Push-Location (Join-Path $InstallRoot 'src-tauri')
    try {
        # ⚠️ 绝不改成 cargo build --release：custom-protocol feature 只有 tauri CLI 会带上，
        # plain cargo 会静默产出无前端的空壳 exe 且照常打印成功。
        if ((Invoke-Logged -FilePath 'cargo' -Arguments @('tauri', 'build', '--no-bundle') -What 'Rust 重建') -ne 0) {
            throw 'cargo tauri build 失败'
        }
    } finally {
        Pop-Location
    }

    # ── 6. 产物校验 ─────────────────────────────────────────────────────────
    if (-not (Test-Path $exePath)) { throw "重建后未找到产物：$exePath" }

    $size = (Get-Item -LiteralPath $exePath).Length
    Write-Log "产物尺寸：$size 字节（空壳基准 $SHELL_BASELINE_BYTES）"
    if ($size -le $SHELL_BASELINE_BYTES) {
        throw "产物尺寸 $size 不大于空壳基准 $SHELL_BASELINE_BYTES，疑似未内嵌前端（构建日志说成功不作数）"
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
            throw "产物中未找到前端资源名 $entryName，前端未进包"
        }
    } else {
        Write-Log 'dist/assets 下未找到 index-*.js，跳过资源内嵌校验' 'WARN'
    }

    # ── 7. 恢复改动并拉起新版本 ─────────────────────────────────────────────
    if ($stashed) {
        if ((Invoke-Logged -FilePath 'git' -Arguments @('stash', 'pop') -What 'git stash pop') -ne 0) {
            Write-Log "stash 恢复冲突，改动仍保存在 git stash 中，请手动 git stash pop" 'WARN'
        }
    }

    Write-Log '更新完成，拉起新版本'
    Start-WorkBuddy -Reason '更新完成'
    exit 0
}
catch {
    $message = $_.Exception.Message
    Write-Log "更新失败：$message" 'ERROR'

    # 回滚到更新前 commit，尽量让用户回到可用状态
    if ($previousSha) {
        try {
            Push-Location $InstallRoot
            Write-Log "回滚到 $previousSha"
            Invoke-Logged -FilePath 'git' -Arguments @('reset', '--hard', $previousSha) -What '回滚' | Out-Null
            if ($stashed) { Invoke-Logged -FilePath 'git' -Arguments @('stash', 'pop') -What 'git stash pop' | Out-Null }
        } catch {
            Write-Log "回滚过程出错：$_" 'ERROR'
        } finally {
            Pop-Location -ErrorAction SilentlyContinue
        }
    }

    Show-FailureMessage "自动更新失败：$message`n`n详细日志：$LogPath`n`n已回滚到更新前的版本。"
    # 回滚后源码已恢复旧版，但 exe 可能已被覆盖一半 → 尽力拉起当前产物
    Start-WorkBuddy -Reason '更新失败回滚后'
    exit 1
}
finally {
    # 确保无论成功失败都回到原始工作目录。
    # ⚠️ 不能用 `(Get-Location -Stack).Path` 之类写法：栈为空时它会抛错，
    # 在 finally 里抛错会顶替掉 try 中真正的失败原因，让日志丢失关键信息。
    # 逐层 Pop 并计数（最多几次），任何异常都吞掉，finally 只负责收尾。
    for ($i = 0; $i -lt 8; $i++) {
        try {
            if ((Get-Location -Stack).Count -le 0) { break }
            Pop-Location -ErrorAction Stop
        } catch { break }
    }
    Write-Log '============================================================'
}
