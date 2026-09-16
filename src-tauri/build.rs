//! 构建脚本：把「构建时的 git 提交」烘焙进二进制。
//!
//! 为什么必须烘焙而不是运行时读 `.git/HEAD`：
//! 本项目是「源码检出 + 就地重建」的更新模式，用户的工作树 HEAD 会被 `git pull`
//! 推进到最新，但**正在运行的 exe 仍是旧提交构建的**。若检测更新时去读工作树，
//! 就会拿新提交与远端比对 → 谎报「已是最新」，而实际运行的产物落后若干提交
//! （真实踩到：exe 构建于 88b0f7e，工作树已到 d1cb787，界面显示「已是最新」）。
//!
//! 因此运行中的版本只能由 exe 自己携带。`env!("WORKBUDDY2API_BUILD_SHA")`
//! 读取到的即为构建那一刻的 HEAD。
//!
//! 重编时机：注入的 `cargo:rerun-if-changed` 指向 `.git/HEAD` 与当前分支引用文件，
//! 二者变化（切分支 / 新提交）都会触发重编，保证 sha 不会陈旧。

use std::path::Path;
use std::process::Command;

/// 取短 sha；取不到（无 git、非检出）时回退 "unknown"。
///
/// 不 fail 构建：源码包（无 .git）也必须能编译，此时版本判定退化为「未知」，
/// 由上层决定如何提示，而不是让整个构建崩掉。
fn git_short_sha() -> String {
    let out = Command::new("git").args(["rev-parse", "--short", "HEAD"]).output();
    match out {
        Ok(o) if o.status.success() => {
            let sha = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if sha.is_empty() {
                "unknown".into()
            } else {
                sha
            }
        }
        _ => "unknown".into(),
    }
}

fn main() {
    let sha = git_short_sha();
    println!("cargo:rustc-env=WORKBUDDY2API_BUILD_SHA={sha}");

    // HEAD 变化（切分支）与分支引用变化（新提交）时都要重编，避免 sha 陈旧：
    // 提交时 HEAD 内容不变而分支引用文件变，切分支时 HEAD 本身变，故两条都发。
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Ok(head) = std::fs::read_to_string(Path::new("../.git/HEAD")) {
        if let Some(reference) = head.trim().strip_prefix("ref:") {
            let reference = reference.trim();
            // packed-refs 场景下松散引用文件可能不存在，发了也只是不触发（无害）
            println!("cargo:rerun-if-changed=../.git/{reference}");
        }
    }

    tauri_build::build()
}
