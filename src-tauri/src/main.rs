// Tauri v2 入口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    workbuddy2api::run_app();
}
