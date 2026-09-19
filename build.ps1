# WorkBuddy2API 自动化构建脚本 (UTF-8 with BOM)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "WorkBuddy2API 自动构建"

Set-Location -LiteralPath $PSScriptRoot

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  WorkBuddy2API 自动化构建流程 (Tauri Build)" -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "工作目录: $PSScriptRoot" -ForegroundColor Gray
Write-Host "正在执行: npm run tauri build" -ForegroundColor Gray
Write-Host "---------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""

# 通过 cmd.exe 调用 npm，避免 PS 5.1 将 stderr 转化为 NativeCommandError 伪报错，
# 同时也避免 npm.ps1 内部的 exit $LASTEXITCODE 导致 PowerShell 进程直接闪退
cmd.exe /c "npm run tauri build"
$code = $LASTEXITCODE

Write-Host ""
if ($code -eq 0) {
    Write-Host "===================================================" -ForegroundColor Green
    Write-Host " [构建成功] Tauri 生产产物已生成完毕！" -ForegroundColor Green
    Write-Host " 产物路径: src-tauri\target\release\workbuddy2api.exe" -ForegroundColor White
    Write-Host " 安装程序: src-tauri\target\release\bundle\nsis\*.exe" -ForegroundColor White
    Write-Host "===================================================" -ForegroundColor Green
} else {
    Write-Host "===================================================" -ForegroundColor Red
    Write-Host " [构建失败] 退出代码: $code" -ForegroundColor Red
    Write-Host " 请查看上方控制台的详细报错与诊断信息。" -ForegroundColor Red
    Write-Host "===================================================" -ForegroundColor Red
}

Write-Host ""
Read-Host "构建完成，请查阅上方日志。按 Enter 键退出窗口..."
