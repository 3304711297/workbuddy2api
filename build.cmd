@echo off
chcp 65001 >nul
title WorkBuddy2API 自动构建

cd /d "%~dp0"

echo =======================================================
echo           WorkBuddy2API 自动化构建流程
echo =======================================================
echo.
echo 工作目录: %CD%
echo 正在执行: npm run tauri build
echo -------------------------------------------------------
echo.

call npm run tauri build
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo =======================================================
    echo [构建失败] 退出码: %ERRORLEVEL%
    echo 请检查上方控制台输出的报错信息。
    echo =======================================================
    echo.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo =======================================================
echo [构建成功] Tauri 桌面端产物已生成！
echo 产物路径: src-tauri\target\release\workbuddy2api.exe
echo =======================================================
echo.
pause
