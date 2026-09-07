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

fn find_item_extent(lines: &[String], start: usize, header_indent: usize, limit_end: usize) -> usize {
    let mut last_content = start;
    for j in (start + 1)..limit_end {
        let line = &lines[j];
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent <= header_indent {
            break;
        }
        last_content = j;
    }
    last_content + 1
}

fn extract_yaml_value(line: &str) -> String {
    let (_, val_part) = match line.split_once(':') {
        Some(pair) => pair,
        None => return String::new(),
    };
    let val_trimmed = val_part.trim();
    if val_trimmed.starts_with('"') {
        if let Some(end_q) = val_trimmed[1..].find('"') {
            return val_trimmed[1..=end_q].to_string();
        }
    } else if val_trimmed.starts_with('\'') {
        if let Some(end_q) = val_trimmed[1..].find('\'') {
            return val_trimmed[1..=end_q].to_string();
        }
    }
    let clean = val_trimmed.split('#').next().unwrap_or("").trim();
    clean.to_string()
}

fn update_yaml_line_value(line: &str, new_val: &str) -> String {
    let (key_part, val_part) = match line.split_once(':') {
        Some(pair) => pair,
        None => return line.to_string(),
    };
    let hash_pos = val_part.find('#');
    let inline_comment = if let Some(pos) = hash_pos {
        let before_hash = &val_part[..pos];
        let dquotes = before_hash.matches('"').count();
        let squotes = before_hash.matches('\'').count();
        if dquotes % 2 == 0 && squotes % 2 == 0 {
            Some(&val_part[pos..])
        } else {
            None
        }
    } else {
        None
    };

    match inline_comment {
        Some(comment) => format!("{key_part}: \"{new_val}\" {comment}"),
        None => format!("{key_part}: \"{new_val}\""),
    }
}

fn reconcile_alias_block(
    lines: &mut Vec<String>,
    alias_start: usize,
    alias_end: usize,
    expected_model: &str,
    expected_url: &str,
) -> usize {
    let header_line = &lines[alias_start];
    let header_indent = header_line.len() - header_line.trim_start().len();

    // 探测属性行缩进
    let mut prop_indent = format!("{}  ", &header_line[..header_indent]);
    for j in (alias_start + 1)..alias_end {
        let l = &lines[j];
        let t = l.trim();
        if !t.is_empty() && !t.starts_with('#') {
            let ind = l.len() - l.trim_start().len();
            if ind > header_indent {
                prop_indent = l[..ind].to_string();
                break;
            }
        }
    }

    let mut found_model = None;
    let mut found_provider = None;
    let mut found_base_url = None;
    let mut last_prop_idx = alias_start;

    for j in (alias_start + 1)..alias_end {
        let t = lines[j].trim();
        if t.starts_with("model:") || t.starts_with("model ") {
            found_model = Some(j);
            last_prop_idx = j;
        } else if t.starts_with("provider:") || t.starts_with("provider ") {
            found_provider = Some(j);
            last_prop_idx = j;
        } else if t.starts_with("base_url:") || t.starts_with("base_url ") {
            found_base_url = Some(j);
            last_prop_idx = j;
        } else if !t.is_empty() && !t.starts_with('#') {
            last_prop_idx = j;
        }
    }

    let mut current_end = alias_end;

    // 1. 校正 model
    match found_model {
        Some(idx) => {
            let val = extract_yaml_value(&lines[idx]);
            if val != expected_model {
                lines[idx] = update_yaml_line_value(&lines[idx], expected_model);
            }
        }
        None => {
            lines.insert(
                last_prop_idx + 1,
                format!("{prop_indent}model: \"{expected_model}\""),
            );
            last_prop_idx += 1;
            current_end += 1;
            if let Some(ref mut p) = found_provider {
                if *p >= last_prop_idx {
                    *p += 1;
                }
            }
            if let Some(ref mut b) = found_base_url {
                if *b >= last_prop_idx {
                    *b += 1;
                }
            }
        }
    }

    // 2. 校正 provider
    match found_provider {
        Some(idx) => {
            let val = extract_yaml_value(&lines[idx]);
            if val != "custom" {
                lines[idx] = update_yaml_line_value(&lines[idx], "custom");
            }
        }
        None => {
            lines.insert(
                last_prop_idx + 1,
                format!("{prop_indent}provider: \"custom\""),
            );
            last_prop_idx += 1;
            current_end += 1;
            if let Some(ref mut b) = found_base_url {
                if *b >= last_prop_idx {
                    *b += 1;
                }
            }
        }
    }

    // 3. 校正 base_url
    match found_base_url {
        Some(idx) => {
            let val = extract_yaml_value(&lines[idx]);
            if val != expected_url {
                lines[idx] = update_yaml_line_value(&lines[idx], expected_url);
            }
        }
        None => {
            lines.insert(
                last_prop_idx + 1,
                format!("{prop_indent}base_url: \"{expected_url}\""),
            );
            current_end += 1;
        }
    }

    current_end
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
            // 扫描 start..end 内的所有列表项（允许 block 内部存在空行和注释）
            let mut items: Vec<(usize, usize, String)> = Vec::new();
            let mut i = start;
            while i < end {
                let line = &lines[i];
                let trimmed = line.trim_start();
                if trimmed.starts_with("- ") || trimmed == "-" {
                    let leading_spaces = line.len() - trimmed.len();
                    let cur_indent = line[..leading_spaces].to_string();
                    let item_end = find_item_extent(&lines, i, leading_spaces, end);
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

    // 2. 处理 model_aliases（完整三字段校验与按需补齐）
    if let Some((h_idx, start, mut end)) = find_top_level_section(&lines, "model_aliases") {
        if lines[h_idx].contains("{}") {
            lines[h_idx] = "model_aliases:".into();
        }
        for (name, model) in WORKBUDDY_ALIASES_SPECS {
            let mut alias_found = false;
            let mut i = start;
            while i < end {
                let line = &lines[i];
                let trimmed = line.trim();
                let is_this_alias = (line.starts_with("  ") || line.starts_with("    "))
                    && !line.starts_with("      ")
                    && (trimmed == format!("{name}:") || trimmed.starts_with(&format!("{name}:")));

                if is_this_alias {
                    alias_found = true;
                    let header_indent = line.len() - line.trim_start().len();
                    let alias_end = find_item_extent(&lines, i, header_indent, end);
                    let expected_url = format!("http://127.0.0.1:{port}/v1");
                    let new_end = reconcile_alias_block(&mut lines, i, alias_end, model, &expected_url);
                    let diff = new_end - alias_end;
                    end += diff;
                    break;
                } else {
                    i += 1;
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
                let item_end = find_item_extent(&lines, i, header_indent, end);
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
                let alias_end = find_item_extent(&lines, i, header_indent, end);
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

    // 边界测试 1: 已有 alias 三个字段全部正确 → 零修改
    #[test]
    fn test_alias_all_three_fields_correct_zero_change() {
        let input = r#"model_aliases:
  workbuddy-glm:
    model: "glm-5.2"
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
"#;
        let patched = patch_hermes_config_content(input, 8787).unwrap();
        // 包含其他未出现的 alias，但对已有且正确的 workbuddy-glm 必须零修改
        assert!(patched.contains("  workbuddy-glm:\n    model: \"glm-5.2\"\n    provider: \"custom\"\n    base_url: \"http://127.0.0.1:8787/v1\""));
    }

    // 边界测试 2: model 错误 → 只修 model
    #[test]
    fn test_alias_model_wrong_only_fixes_model() {
        let input = r#"model_aliases:
  workbuddy-glm:
    model: "wrong-model" # 保留注释
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
"#;
        let patched = patch_hermes_config_content(input, 8787).unwrap();
        assert!(patched.contains("model: \"glm-5.2\" # 保留注释"));
        assert!(!patched.contains("wrong-model"));
        assert!(patched.contains("provider: \"custom\""));
        assert!(patched.contains("base_url: \"http://127.0.0.1:8787/v1\""));
    }

    // 边界测试 3: provider 错误 → 只修 provider
    #[test]
    fn test_alias_provider_wrong_only_fixes_provider() {
        let input = r#"model_aliases:
  workbuddy-glm:
    model: "glm-5.2"
    provider: "openai" # 旧 provider
    base_url: "http://127.0.0.1:8787/v1"
"#;
        let patched = patch_hermes_config_content(input, 8787).unwrap();
        assert!(patched.contains("provider: \"custom\" # 旧 provider"));
        assert!(!patched.contains("\"openai\""));
        assert!(patched.contains("model: \"glm-5.2\""));
        assert!(patched.contains("base_url: \"http://127.0.0.1:8787/v1\""));
    }

    // 边界测试 4: base_url 错误 → 只修 base_url
    #[test]
    fn test_alias_base_url_wrong_only_fixes_base_url() {
        let input = r#"model_aliases:
  workbuddy-glm:
    model: "glm-5.2"
    provider: "custom"
    base_url: "http://127.0.0.1:9999/v1" # 旧端口
"#;
        let patched = patch_hermes_config_content(input, 8787).unwrap();
        assert!(patched.contains("base_url: \"http://127.0.0.1:8787/v1\" # 旧端口"));
        assert!(!patched.contains("9999"));
        assert!(patched.contains("model: \"glm-5.2\""));
        assert!(patched.contains("provider: \"custom\""));
    }

    // 边界测试 5: 缺少其中一个字段 → 精准补齐
    #[test]
    fn test_alias_missing_field_precise_completion() {
        let input = r#"model_aliases:
  workbuddy-glm:
    model: "glm-5.2"
    base_url: "http://127.0.0.1:8787/v1"
"#;
        let patched = patch_hermes_config_content(input, 8787).unwrap();
        assert!(patched.contains("provider: \"custom\""));
        assert!(patched.contains("model: \"glm-5.2\""));
        assert!(patched.contains("base_url: \"http://127.0.0.1:8787/v1\""));

        // 再测试缺少 model
        let input2 = r#"model_aliases:
  workbuddy-glm:
    provider: "custom"
    base_url: "http://127.0.0.1:8787/v1"
"#;
        let patched2 = patch_hermes_config_content(input2, 8787).unwrap();
        assert!(patched2.contains("model: \"glm-5.2\""));
        assert!(patched2.contains("provider: \"custom\""));
        assert!(patched2.contains("base_url: \"http://127.0.0.1:8787/v1\""));
    }

    // 边界测试 6: alias block 内存在空行/注释 → 不破坏 block
    #[test]
    fn test_alias_block_with_blank_lines_and_comments() {
        let input = r#"model_aliases:
  workbuddy-glm:
    # 顶部说明

    model: "wrong-model"

    # 中间说明
    provider: "custom"

    base_url: "http://127.0.0.1:8787/v1"
    # 底部说明
  other-alias:
    model: "foo"
"#;
        let patched = patch_hermes_config_content(input, 8787).unwrap();
        assert!(patched.contains("# 顶部说明"));
        assert!(patched.contains("# 中间说明"));
        assert!(patched.contains("# 底部说明"));
        assert!(patched.contains("model: \"glm-5.2\""));
        assert!(patched.contains("other-alias:\n    model: \"foo\""));
    }

    // 边界测试 7: configure → remove → configure 后结构仍正常
    #[test]
    fn test_configure_remove_configure_cycle() {
        let initial = r#"# 系统基线配置
model:
  default: gemini-3.8-flash

custom_providers:
- name: cpa-gui
  base_url: http://127.0.0.1:18080/v1

model_aliases:
  custom-agent:
    model: "custom-v1"
"#;
        let c1 = patch_hermes_config_content(initial, 8787).unwrap();
        assert!(c1.contains("WorkBuddy (127.0.0.1:8787)"));
        assert!(c1.contains("workbuddy:"));
        assert!(c1.contains("cpa-gui"));
        assert!(c1.contains("custom-agent:"));

        let r1 = remove_hermes_config_content(&c1).unwrap();
        assert!(!r1.contains("WorkBuddy"));
        assert!(!r1.contains("workbuddy"));
        assert!(r1.contains("cpa-gui"));
        assert!(r1.contains("custom-agent:"));
        assert!(r1.contains("# 系统基线配置"));

        let c2 = patch_hermes_config_content(&r1, 8787).unwrap();
        assert!(c2.contains("WorkBuddy (127.0.0.1:8787)"));
        assert!(c2.contains("workbuddy:"));
        assert!(c2.contains("cpa-gui"));
        assert!(c2.contains("custom-agent:"));
        assert!(c2.contains("# 系统基线配置"));
    }

    // 边界测试 8: 连续执行 configure 三次仍然幂等
    #[test]
    fn test_repeated_configure_thrice_idempotent() {
        let initial = r#"# 复杂环境基线
model:
  default: gemini-3.8-flash

custom_providers:
- name: cpa-gui
  base_url: http://127.0.0.1:18080/v1

model_aliases:
  gemini:
    model: "gemini-3.8-flash"
"#;
        let c1 = patch_hermes_config_content(initial, 8787).unwrap();
        let c2 = patch_hermes_config_content(&c1, 8787).unwrap();
        let c3 = patch_hermes_config_content(&c2, 8787).unwrap();

        assert_eq!(c1, c2, "第一次与第二次必须完全一致");
        assert_eq!(c2, c3, "第二次与第三次必须完全一致");
    }

    // 边界测试 9: WorkBuddy block 内含空行 + 注释（替换与移除均无残余）
    #[test]
    fn test_workbuddy_provider_block_with_blank_lines_and_comments() {
        let input = r#"# 顶层配置
custom_providers:
- name: WorkBuddy (127.0.0.1:8787)
  # 内部注释 1

  base_url: http://127.0.0.1:8787/v1
  api_key: local

  # 内部注释 2
  model: auto
  models:
    auto: {}
  models_discovered: true

- name: other-provider
  base_url: http://127.0.0.1:9000/v1
"#;
        // 1. 端口变更替换：不留旧 block 残留
        let patched = patch_hermes_config_content(input, 9999).unwrap();
        assert!(patched.contains("WorkBuddy (127.0.0.1:9999)"));
        assert!(patched.contains("127.0.0.1:9999/v1"));
        assert!(!patched.contains("8787"), "旧端口与旧字段不得残留");
        assert!(patched.contains("other-provider"));

        // 2. 移除测试：全 block 连同内部空行与注释彻底清除，无残余
        let removed = remove_hermes_config_content(input).unwrap();
        assert!(!removed.contains("WorkBuddy"));
        assert!(!removed.contains("8787"));
        assert!(!removed.contains("内部注释 1"));
        assert!(!removed.contains("内部注释 2"));
        assert!(removed.contains("other-provider"));
    }
}
