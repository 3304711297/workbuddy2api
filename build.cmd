@echo off
cd /d "%~dp0"
powershell.exe -NoExit -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Set-Location -LiteralPath '%~dp0'; Write-Host '===================================================' -ForegroundColor Cyan; Write-Host '  WorkBuddy2API 自动构建 (npm run tauri build)' -ForegroundColor Green; Write-Host '===================================================' -ForegroundColor Cyan; Write-Host ''; npm run tauri build"
