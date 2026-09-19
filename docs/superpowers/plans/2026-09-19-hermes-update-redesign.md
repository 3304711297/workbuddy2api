# Hermes-Aligned Update UX & Handoff Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-architect the application update workflow to 1:1 align with Hermes Desktop's clean 4-view modal UX, eliminate WinForms & MessageBox popups in favor of an Edge-powered chromeless Web transition window (`ui.html`), and introduce a fail-closed `handoff-ready` handshake protocol with single-source-of-truth state.

**Architecture:** 
- Frontend adopts Hermes 4-view model: `checking` (pulse) -> `latest` (all set) -> `available` (grouped conventional changelog) -> `applying` (handoff transition).
- Handoff handshake: `apply_app_update` waits for `handoff-ready` status from the background orchestrator before GUI exits; fails closed after 8s timeout to prevent sudden disappearing windows.
- Transition window: PowerShell spawns an ephemeral loopback listener serving `scripts/app-update/ui.html` via `msedge --app=http://127.0.0.1:<port> --user-data-dir=...`, displaying smooth dark-mode loader, elapsed time, and status lines. Failure transitions to a clean card with a dismiss button rather than native OS MessageBox.
- Rollback & safety engine: existing hardened git `--ff-only`, reset, npm/cargo rebuild, and health probe invariants remain strictly preserved.

**Tech Stack:** Vanilla JS (ES Modules), HTML5/CSS3 (dark geek theme), PowerShell 5.1/7, Rust (Tauri v2), Edge/Chromium `--app` mode.

## Global Constraints
- `windows.ps1` must always start with UTF-8 BOM (`\xef\xbb\xbf`) for PS 5.1 compatibility.
- Never pipe native command output directly to `Select-Object -First 1` before checking `$LASTEXITCODE`.
- No `MessageBox::Show` or WinForms UI in `windows.ps1`.
- All automated contract tests in `tests/test_app_update_contract.test.js` must pass.
- All Python pytest, isolated pytest, and cargo tests must remain 100% green.

## Review Focus
1. Handoff handshake timeout: if Edge fails to launch or script fails before `handoff-ready`, GUI must not exit.
2. Edge profile isolation: `--user-data-dir` must use an isolated temp path to never corrupt or lock user profile.
3. Rollback UX: safe rollback must display "更新未完成（已恢复旧版）" rather than an alarming catastrophic error.
4. Single source of truth: `app-update-state.json` holds `run_id`, `updater_pid`, and `phase`.
5. Frontend DOM cleanup: remove `<ol class="update-steps">` without breaking any remaining valid tests.

---

### Task 1: Create `scripts/app-update/ui.html`
- Create `scripts/app-update/ui.html` with clean responsive layout, dark/light theme matching OS, Fourier-flow/bloom SVG loader, title, and status line.
- Support `/progress` polling and terminal outcome rendering (`done`, `rolled-back`, `failed`).

### Task 2: Refactor `scripts/app-update/windows.ps1`
- Remove `Start-ProgressWindow`, `Update-ProgressWindow`, `Stop-ProgressWindow` (WinForms).
- Remove `Show-FailureMessage` (`[System.Windows.MessageBox]::Show`).
- Implement loopback TcpListener server and launch Edge `--app=http://127.0.0.1:$port --user-data-dir=$tempProfile`.
- Implement `handoff-ready` state before proceeding with GUI wait and git operations.
- On error/rollback, report proper terminal state to `ui.html` before exiting or restarting.

### Task 3: Refactor Frontend Modal (`index.html` + `src/update-check.js` + `src/style.css`)
- Remove `#update-steps` 8-step list.
- Implement Hermes 4-view model in `src/update-check.js`.
- In `applyUpdate()`, await `handoff-ready` before permitting or expecting GUI exit; fallback to error toast on timeout.

### Task 4: Update Contract Tests (`tests/test_app_update_contract.test.js`)
- Replace old `update-steps` assertions with the 4-view modal assertions.
- Assert prohibition of `MessageBox` and requirement of `ui.html` / `handoff-ready`.

### Task 5: Full Verification & Quality Gate
- Run `npm test`, `pytest`, isolated tests, and `cargo test`.
