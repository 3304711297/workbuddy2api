//! Agent 一键检测与配置写入 (Hermes & ZCode)

use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

use super::shared::{atomic_write_file, env_nonempty, local_appdata, user_home};

/// 对 127.0.0.1:<port> 做带超时的 TCP 连通性探测（800ms 上限，避免 UI 卡顿）
fn loopback_port_open(port: u16) -> bool {
    let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentStatus {
    pub hermes_installed: bool,
    pub hermes_configured: bool,
    pub hermes_config_path: String,
    pub zcode_installed: bool,
    /// provider.workbuddy 仍写在 ZCode 的 JSON 配置里（ZCode Desktop 不读取，仅作残留提示）
    pub zcode_provider_registered: bool,
    /// 对 c2o 服务端口的真实可达性探测（这才是 ZCode 里能不能拉到模型的决定条件）
    pub zcode_service_online: bool,
    pub zcode_cli_path: String,
    pub zcode_v2_path: String,
}

/// Hermes 配置文件候选列表：
/// 1. `HERMES_HOME` 环境变量（hermes 本身使用的约定）
/// 2. %LOCALAPPDATA%\hermes\config.yaml（原默认）
/// 3. %USERPROFILE%\.hermes\config.yaml（原备选）
fn hermes_config_candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(home) = env_nonempty("HERMES_HOME") {
        list.push(PathBuf::from(home).join("config.yaml"));
    }
    list.push(local_appdata().join("hermes\\config.yaml"));
    list.push(user_home().join(".hermes\\config.yaml"));
    list
}

/// 解析当前实际生效的 Hermes 配置文件路径
fn resolve_hermes_config() -> PathBuf {
    let candidates = hermes_config_candidates();
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        // 全部不存在时保持原行为：回退到 %LOCALAPPDATA% 默认路径
        .unwrap_or_else(|| local_appdata().join("hermes\\config.yaml"))
}

fn zcode_cli_path() -> PathBuf {
    user_home().join(".zcode\\cli\\config.json")
}

fn zcode_v2_path() -> PathBuf {
    user_home().join(".zcode\\v2\\config.json")
}

// ---------------------------------------------------------------------------
// Agent 一键集成与配置 (Hermes & ZCode)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agent_detect(port: Option<u16>) -> Result<AgentStatus, String> {
    // Hermes 真实配置文件：HERMES_HOME 环境变量优先 → %LOCALAPPDATA%\hermes → %USERPROFILE%\.hermes
    let hermes_p = resolve_hermes_config();
    let hermes_installed = hermes_p.exists();
    let mut hermes_configured = false;
    if hermes_installed {
        if let Ok(raw) = std::fs::read_to_string(&hermes_p) {
            hermes_configured = raw.contains("WorkBuddy (127.0.0.1:");
        }
    }

    let zcode_c = zcode_cli_path();
    let zcode_v = zcode_v2_path();
    let zcode_installed = zcode_c.exists() || zcode_v.exists();
    // provider.workbuddy 是否仍写在 JSON 配置里（ZCode Desktop 不读这份文件，仅作残留提示）
    let mut zcode_provider_registered = false;
    if zcode_c.exists() {
        if let Ok(raw) = std::fs::read_to_string(&zcode_c) {
            zcode_provider_registered = raw.contains("workbuddy") && raw.contains("8787");
        }
    }
    // 关键状态：c2o 服务端口真实可达性（决定 ZCode 里能否拉到模型）
    let zcode_service_online = loopback_port_open(port.unwrap_or(8787));

    Ok(AgentStatus {
        hermes_installed,
        hermes_configured,
        hermes_config_path: hermes_p.to_string_lossy().to_string(),
        zcode_installed,
        zcode_provider_registered,
        zcode_service_online,
        zcode_cli_path: zcode_c.to_string_lossy().to_string(),
        zcode_v2_path: zcode_v.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn agent_configure(agent_type: String, port: u16) -> Result<String, String> {
    match agent_type.as_str() {
        "hermes" => configure_hermes(port),
        "zcode" => configure_zcode(port),
        _ => Err(format!("不支持的 agent 类型: {agent_type}")),
    }
}

#[tauri::command(rename_all = "snake_case")]
pub fn agent_remove(agent_type: String) -> Result<String, String> {
    match agent_type.as_str() {
        "hermes" => remove_hermes(),
        "zcode" => remove_zcode(),
        _ => Err(format!("不支持的 agent 类型: {agent_type}")),
    }
}

fn is_top_level_directive(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t.starts_with('#') {
        return false;
    }
    if line.starts_with(' ') || line.starts_with('\t') || line.starts_with('-') {
        return false;
    }
    t.contains(':')
}

fn find_top_level_section(lines: &[String], key: &str) -> Option<(usize, usize, usize)> {
    let mut header_idx = None;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        if !line.starts_with(' ') && !line.starts_with('\t') && !line.starts_with('-') {
            if t == format!("{key}:") || t.starts_with(&format!("{key}:")) {
                header_idx = Some(i);
                break;
            }
        }
    }
    let h_idx = header_idx?;
    let start = h_idx + 1;
    let mut end = lines.len();
    for i in start..lines.len() {
        if is_top_level_directive(&lines[i]) {
            end = i;
            break;
        }
    }
    Some((h_idx, start, end))
}

fn generate_workbuddy_provider_lines(port: u16, indent: &str) -> Vec<String> {
    vec![
        format!("{indent}- name: WorkBuddy (127.0.0.1:{port})"),
        format!("{indent}  base_url: http://127.0.0.1:{port}/v1"),
        format!("{indent}  api_key: local"),
        format!("{indent}  model: auto"),
        format!("{indent}  models:"),
        format!("{indent}    auto: {{}}"),
        format!("{indent}    hy4-preview: {{}}"),
        format!("{indent}    hy3: {{}}"),
        format!("{indent}    glm-5.3: {{}}"),
        format!("{indent}    glm-5.3-flash: {{}}"),
        format!("{indent}    glm-5.2: {{}}"),
        format!("{indent}    glm-5.1: {{}}"),
        format!("{indent}    glm-5v-turbo: {{}}"),
        format!("{indent}    kimi-k3: {{}}"),
        format!("{indent}    kimi-k2.7: {{}}"),
        format!("{indent}    kimi-k2.6: {{}}"),
        format!("{indent}    kimi-k2.5: {{}}"),
        format!("{indent}    deepseek-v4-pro: {{}}"),
        format!("{indent}    deepseek-v4-flash: {{}}"),
        format!("{indent}    minimax-m3: {{}}"),
        format!("{indent}  models_discovered: true"),
    ]
}

const WORKBUDDY_ALIASES_SPECS: &[(&str, &str)] = &[
    ("workbuddy", "auto"),
    ("workbuddy-glm", "glm-5.2"),
    ("workbuddy-glm53", "glm-5.3-flash"),
    ("workbuddy-kimi", "kimi-k2.7"),
    ("workbuddy-kimi3", "kimi-k3"),
    ("workbuddy-deepseek", "deepseek-v4-pro"),
    ("workbuddy-hy4", "hy4-preview"),
];

fn generate_alias_entry_lines(name: &str, model: &str, port: u16, indent: &str) -> Vec<String> {
    vec![
        format!("{indent}{name}:"),
        format!("{indent}  model: \"{model}\""),
        format!("{indent}  provider: \"custom\""),
        format!("{indent}  base_url: \"http://127.0.0.1:{port}/v1\""),
    ]
}

fn find_block_extent(lines: &[String], start: usize, header_indent: usize, limit_end: usize) -> usize {
    let mut end = start + 1;
    while end < limit_end {
        let line = &lines[end];
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        let indent = line.len() - line.trim_start().len();
        if indent <= header_indent {
            break;
        }
        end += 1;
    }
    end
}

/// 精准文本 Patch：仅修改/注入 Hermes 所需配置，100% 保持用户注释、空行、原有键顺序与缩进。
pub(crate) fn patch_hermes_config_content(raw: &str, port: u16) -> Result<String, String> {
    let line_ending = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = raw.lines().map(|s| s.to_string()).collect();

    // 1. 处理 custom_providers
    if let Some((h_idx, start, end)) = find_top_level_section(&lines, "custom_providers") {
        if lines[h_idx].contains("[]") {
            lines[h_idx] = "custom_providers:".into();
            let new_item = generate_workbuddy_provider_lines(port, "");
            for (offset, line) in new_item.into_iter().enumerate() {
                lines.insert(h_idx + 1 + offset, line);
            }
        } else {
            // 扫描 start..end 内的所有列表项
            let mut items: Vec<(usize, usize, String)> = Vec::new();
            let mut i = start;
            while i < end {
                let line = &lines[i];
                let trimmed = line.trim_start();
                if trimmed.starts_with("- ") || trimmed == "-" {
                    let leading_spaces = line.len() - trimmed.len();
                    let cur_indent = line[..leading_spaces].to_string();
                    let item_end = find_block_extent(&lines, i, leading_spaces, end);
                    items.push((i, item_end, cur_indent));
                    i = item_end;
                } else {
                    i += 1;
                }
            }

            // 查找是否已有 WorkBuddy item
            let mut existing_idx = None;
            for (idx, (s, e, _)) in items.iter().enumerate() {
                let content = lines[*s..*e].join("\n");
                if content.contains("WorkBuddy") || content.contains("codebuddy2openai") {
                    existing_idx = Some(idx);
                    break;
                }
            }

            if let Some(idx) = existing_idx {
                let (s, e, indent) = &items[idx];
                let content = lines[*s..*e].join("\n");
                let expected_name = format!("127.0.0.1:{port}");
                let expected_url = format!("127.0.0.1:{port}/v1");
                if !content.contains(&expected_name) || !content.contains(&expected_url) {
                    let replacement = generate_workbuddy_provider_lines(port, indent);
                    lines.splice(*s..*e, replacement);
                }
            } else {
                let indent = items.first().map(|(_, _, ind)| ind.as_str()).unwrap_or("");
                let new_item = generate_workbuddy_provider_lines(port, indent);
                let insert_pos = end;
                for (offset, line) in new_item.into_iter().enumerate() {
                    lines.insert(insert_pos + offset, line);
                }
            }
        }
    } else {
        if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(false) {
            lines.push(String::new());
        }
        lines.push("custom_providers:".into());
        let new_item = generate_workbuddy_provider_lines(port, "");
        lines.extend(new_item);
    }

    // 2. 处理 model_aliases
    if let Some((h_idx, start, mut end)) = find_top_level_section(&lines, "model_aliases") {
        if lines[h_idx].contains("{}") {
            lines[h_idx] = "model_aliases:".into();
        }
        for (name, model) in WORKBUDDY_ALIASES_SPECS {
            let mut alias_found = false;
            for i in start..end {
                let line = &lines[i];
                let trimmed = line.trim();
                if trimmed == format!("{name}:") || trimmed.starts_with(&format!("{name}:")) {
                    alias_found = true;
                    // 检查此 alias 块内部的 base_url
                    let expected_url = format!("http://127.0.0.1:{port}/v1");
                    let header_indent = line.len() - line.trim_start().len();
                    let alias_end = find_block_extent(&lines, i, header_indent, end);
                    for j in (i + 1)..alias_end {
                        let sub_trimmed = lines[j].trim();
                        if sub_trimmed.starts_with("base_url:") {
                            if !sub_trimmed.contains(&expected_url) {
                                let leading = &lines[j][..lines[j].len() - sub_trimmed.len()];
                                lines[j] = format!("{leading}base_url: \"{expected_url}\"");
                            }
                            break;
                        }
                    }
                    break;
                }
            }
            if !alias_found {
                let new_alias = generate_alias_entry_lines(name, model, port, "  ");
                for (offset, line) in new_alias.into_iter().enumerate() {
                    lines.insert(end + offset, line);
                }
                end += 4;
            }
        }
    } else {
        if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(false) {
            lines.push(String::new());
        }
        lines.push("model_aliases:".into());
        for (name, model) in WORKBUDDY_ALIASES_SPECS {
            let new_alias = generate_alias_entry_lines(name, model, port, "  ");
            lines.extend(new_alias);
        }
    }

    let trailing_newline = raw.ends_with('\n') || raw.is_empty();
    let mut result = lines.join(line_ending);
    if trailing_newline && !result.ends_with('\n') {
        result.push_str(line_ending);
    }
    if result == raw {
        return Ok(raw.to_string());
    }
    Ok(result)
}

/// 精准文本移除：仅移除 WorkBuddy 相关的 provider 与 alias，保留原文件所有其他内容、注释与排版。
pub(crate) fn remove_hermes_config_content(raw: &str) -> Result<String, String> {
    let line_ending = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = raw.lines().map(|s| s.to_string()).collect();

    // 1. 从 custom_providers 中精准剔除 WorkBuddy
    if let Some((_, start, end)) = find_top_level_section(&lines, "custom_providers") {
        let mut items: Vec<(usize, usize)> = Vec::new();
        let mut i = start;
        while i < end {
            let line = &lines[i];
            let trimmed = line.trim_start();
            if trimmed.starts_with("- ") || trimmed == "-" {
                let header_indent = line.len() - trimmed.len();
                let item_end = find_block_extent(&lines, i, header_indent, end);
                items.push((i, item_end));
                i = item_end;
            } else {
                i += 1;
            }
        }

        for (s, e) in items.into_iter().rev() {
            let content = lines[s..e].join("\n");
            if content.contains("WorkBuddy") || content.contains("codebuddy2openai") {
                lines.drain(s..e);
            }
        }
    }

    // 2. 从 model_aliases 中精准剔除 workbuddy*
    if let Some((_, start, end)) = find_top_level_section(&lines, "model_aliases") {
        let mut alias_ranges: Vec<(usize, usize)> = Vec::new();
        let mut i = start;
        while i < end {
            let line = &lines[i];
            let trimmed = line.trim_start();
            let is_alias_header = (line.starts_with("  ") || line.starts_with("    "))
                && !line.starts_with("      ")
                && trimmed.contains(':')
                && !trimmed.starts_with("model:")
                && !trimmed.starts_with("provider:")
                && !trimmed.starts_with("base_url:")
                && !trimmed.starts_with('#');

            if is_alias_header {
                let header_indent = line.len() - trimmed.len();
                let alias_end = find_block_extent(&lines, i, header_indent, end);
                alias_ranges.push((i, alias_end));
                i = alias_end;
            } else {
                i += 1;
            }
        }

        for (s, e) in alias_ranges.into_iter().rev() {
            let header = lines[s].trim();
            if header.starts_with("workbuddy") {
                lines.drain(s..e);
            }
        }
    }

    let trailing_newline = raw.ends_with('\n') || raw.is_empty();
    let mut result = lines.join(line_ending);
    if trailing_newline && !result.ends_with('\n') {
        result.push_str(line_ending);
    }
    Ok(result)
}

fn configure_hermes(port: u16) -> Result<String, String> {
    let p = resolve_hermes_config();
    if !p.exists() {
        return Err(format!("Hermes 配置文件未找到: {}", p.display()));
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;

    // 备份原文件
    let bak = p.with_extension("yaml.bak-codebuddy-gui");
    let _ = std::fs::copy(&p, bak);

    // 纯文本精准 Patch，杜绝破坏用户注释、空行与排版
    let patched = patch_hermes_config_content(&raw, port)?;
    if patched != raw {
        atomic_write_file(&p, &patched).map_err(|e| e.to_string())?;
    }
    Ok("Hermes Agent 配置一键写入成功！".into())
}

fn remove_hermes() -> Result<String, String> {
    let p = resolve_hermes_config();
    if !p.exists() {
        return Ok("文件不存在".into());
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;

    // 纯文本精准移除
    let cleaned = remove_hermes_config_content(&raw)?;
    if cleaned != raw {
        atomic_write_file(&p, &cleaned).map_err(|e| e.to_string())?;
    }
    Ok("已从 Hermes 移除 WorkBuddy 配置".into())
}

fn configure_zcode(port: u16) -> Result<String, String> {
    // ZCode Desktop 的自定义供应商列表存放在其内部压缩数据库里，只认界面内添加，
    // 直接写 JSON 配置文件不会被读取（实测确认）。因此这里不再写文件，
    // 而是返回引导信息由前端复制到剪贴板，引导用户在 Desktop 界面内添加。
    let models_list = [
        "auto", "hy4-preview", "hy3", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1",
        "glm-5v-turbo", "kimi-k3", "kimi-k2.7", "kimi-k2.6", "kimi-k2.5",
        "deepseek-v4-pro", "deepseek-v4-flash", "minimax-m3",
    ];
    let payload = serde_json::json!({
        "mode": "manual-guide",
        "base_url": format!("http://127.0.0.1:{port}/v1"),
        "api_format": "Chat Completions (/chat/completions)",
        "api_key": "local",
        "models": models_list,
        "steps": [
            "1. 打开 ZCode Desktop → 模型设置 → 添加供应商",
            "2. Base URL / API Key 粘贴下方对应值，API 格式选 Chat Completions",
            "3. 在模型列表里逐个添加上方模型名（至少加一个，推荐 glm-5.3-flash）",
            "4. 保存后确认本控制台服务已启动（端口在线），即可在聊天中选择 WorkBuddy 模型"
        ],
        "note": "ZCode Desktop 只认界面内添加的供应商；此前写入配置文件的 workbuddy 残留可用『清理文件残留』按钮移除"
    });
    Ok(serde_json::to_string(&payload).map_err(|e| e.to_string())?)
}

fn remove_zcode() -> Result<String, String> {
    for path in [zcode_cli_path(), zcode_v2_path()] {
        if path.exists() {
            let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            if let Ok(mut cfg) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(obj) = cfg.as_object_mut() {
                    if let Some(provs) = obj.get_mut("provider").and_then(|v| v.as_object_mut()) {
                        provs.remove("workbuddy");
                    }
                }
                let out = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
                let _ = std::fs::write(&path, out);
            }
        }
    }
    Ok("已清理配置文件中的 workbuddy 残留。注意：ZCode Desktop 模型设置里手动添加的 WorkBuddy 条目存储在其内部数据库，需在界面中手动删除".into())
}

#[cfg(test)]
mod hermes_patch_tests {
    use super::*;

    // Case A: 普通已有配置
    #[test]
    fn test_case_a_normal_existing_config() {
        let input = r#"model:
  default: gemini-3.8-flash

custom_providers:
- name: cpa-gui
  base_url: http://127.0.0.1:18080/v1

platforms:
  webhook: true
"#;
        let patched = patch_hermes_config_content(input, 8787).unwrap();
        assert!(patched.contains("WorkBuddy (127.0.0.1:8787)"));
        assert!(patched.contains("name: cpa-gui"));
        assert!(patched.contains("platforms:\n  webhook: true"));
        assert!(patched.contains("workbuddy-glm:"));
    }

    // Case B: 包含大量注释
    #[test]
    fn test_case_b_comments_preserved() {
        let input = r#"# 顶部重要注释 - 系统基线
# 第二行说明
model:
  default: gemini-3.8-flash # 行内注释

# custom_providers 专有注释说明
custom_providers:
# 现有服务 cpa
- name: cpa-gui
  base_url: http://127.0.0.1:18080/v1 # 端口说明

# 底部全局注释
platforms:
  webhook: true # 结束
"#;
        let patched = patch_hermes_config_content(input, 8787).unwrap();
        assert!(patched.contains("# 顶部重要注释 - 系统基线"));
        assert!(patched.contains("# 第二行说明"));
        assert!(patched.contains("# 行内注释"));
        assert!(patched.contains("# custom_providers 专有注释说明"));
        assert!(patched.contains("# 现有服务 cpa"));
        assert!(patched.contains("# 端口说明"));
        assert!(patched.contains("# 底部全局注释"));
        assert!(patched.contains("# 结束"));
    }

    // Case C: 大量空行与特殊排版
    #[test]
    fn test_case_c_empty_lines_and_formatting() {
        let input = r#"model:
  default: gemini-3.8-flash



custom_providers:

  - name: cpa-gui
    base_url: http://127.0.0.1:18080/v1


platforms:
  webhook: true
"#;
        let patched = patch_hermes_config_content(input, 8787).unwrap();
        assert!(patched.contains("gemini-3.8-flash\n\n\n\ncustom_providers:"));
        assert!(patched.contains("platforms:\n  webhook: true"));
    }

    // Case D: 重复执行必须幂等
    #[test]
    fn test_case_d_repeated_execution_idempotent() {
        let input = r#"model:
  default: gemini-3.8-flash

custom_providers:
- name: cpa-gui
"#;
        let patched1 = patch_hermes_config_content(input, 8787).unwrap();
        let patched2 = patch_hermes_config_content(&patched1, 8787).unwrap();
        let patched3 = patch_hermes_config_content(&patched2, 8787).unwrap();

        assert_eq!(patched1, patched2, "第二次执行不得造成任何内容变更");
        assert_eq!(patched2, patched3, "第三次执行不得造成任何内容变更");

        // 确保没有产生重复的 custom_providers 或重复的 WorkBuddy
        let count_wb = patched3.matches("WorkBuddy (127.0.0.1:8787)").count();
        assert_eq!(count_wb, 1, "WorkBuddy provider 必须仅有一份");
        let count_cp = patched3.matches("custom_providers:").count();
        assert_eq!(count_cp, 1, "custom_providers 键必须仅有一份");
    }

    // Case E: 目标已经正确（零修改）
    #[test]
    fn test_case_e_target_already_correct_zero_change() {
        let input = r#"model:
  default: gemini-3.8-flash

custom_providers:
- name: WorkBuddy (127.0.0.1:8787)
  base_url: http://127.0.0.1:8787/v1
  api_key: local
  model: auto
  models:
    auto: {}
  models_discovered: true

model_aliases:
  workbuddy:
    model: "auto"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-glm:
    model: "glm-5.2"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-glm53:
    model: "glm-5.3-flash"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-kimi:
    model: "kimi-k2.7"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-kimi3:
    model: "kimi-k3"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-deepseek:
    model: "deepseek-v4-pro"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-hy4:
    model: "hy4-preview"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
"#;
        let patched = patch_hermes_config_content(input, 8787).unwrap();
        assert_eq!(patched, input, "目标已正确时必须保持完全一致，零字节变更");
    }

    // Case F: 目标需要修改（端口变更仅更新对应值）
    #[test]
    fn test_case_f_target_needs_update_updates_in_place() {
        let input = r#"# 顶层注释
model:
  default: gemini-3.8-flash

custom_providers:
- name: WorkBuddy (127.0.0.1:8787)
  base_url: http://127.0.0.1:8787/v1
  api_key: local
  model: auto
  models:
    auto: {}
  models_discovered: true

model_aliases:
  workbuddy:
    model: "auto"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-glm:
    model: "glm-5.2"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-glm53:
    model: "glm-5.3-flash"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-kimi:
    model: "kimi-k2.7"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-kimi3:
    model: "kimi-k3"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-deepseek:
    model: "deepseek-v4-pro"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
  workbuddy-hy4:
    model: "hy4-preview"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
# 尾部注释
"#;
        let patched = patch_hermes_config_content(input, 9999).unwrap();
        assert!(patched.contains("# 顶层注释"));
        assert!(patched.contains("# 尾部注释"));
        assert!(patched.contains("WorkBuddy (127.0.0.1:9999)"));
        assert!(patched.contains("http://127.0.0.1:9999/v1"));
        assert!(!patched.contains("8787"), "旧端口应已被替换");
    }

    #[test]
    fn test_remove_hermes_config_fidelity() {
        let input = r#"# 顶层注释
model:
  default: gemini-3.8-flash

custom_providers:
- name: cpa-gui
- name: WorkBuddy (127.0.0.1:8787)
  base_url: http://127.0.0.1:8787/v1

model_aliases:
  other-alias:
    model: "test"
  workbuddy:
    model: "auto"
# 尾部注释
"#;
        let cleaned = remove_hermes_config_content(input).unwrap();
        assert!(cleaned.contains("# 顶层注释"));
        assert!(cleaned.contains("# 尾部注释"));
        assert!(cleaned.contains("name: cpa-gui"));
        assert!(cleaned.contains("other-alias:"));
        assert!(!cleaned.contains("WorkBuddy"));
        assert!(!cleaned.contains("workbuddy:"));
    }
}
