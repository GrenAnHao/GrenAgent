use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use uuid::Uuid;

use crate::state::AppStateStore;

type ConfigMap = BTreeMap<String, Value>;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpDocument {
    #[serde(default)]
    mcp_servers: ConfigMap,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    disabled_mcp_servers: ConfigMap,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigEntry {
    name: String,
    config: Value,
    enabled: bool,
    scope: String,
}

fn config_paths(workspace: &Path, home: &Path) -> (PathBuf, PathBuf) {
    (
        home.join(".pi").join("agent").join("mcp.json"),
        workspace.join(".pi").join("mcp.json"),
    )
}

fn parse_collection(raw: Option<&String>) -> ConfigMap {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return ConfigMap::new();
    };
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(raw) else {
        return ConfigMap::new();
    };
    let source = root
        .get("mcpServers")
        .and_then(Value::as_object)
        .unwrap_or(&root);
    source
        .iter()
        .filter(|(_, config)| config.is_object())
        .map(|(name, config)| (name.clone(), config.clone()))
        .collect()
}

fn serialize_collection(configs: &ConfigMap) -> Result<String, String> {
    if configs.is_empty() {
        return Ok(String::new());
    }
    serde_json::to_string_pretty(&serde_json::json!({ "mcpServers": configs }))
        .map_err(|error| error.to_string())
}

fn read_document(path: &Path) -> Result<McpDocument, String> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("MCP 配置 JSON 损坏 ({}): {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(McpDocument::default()),
        Err(error) => Err(format!("读取 MCP 配置失败 ({}): {error}", path.display())),
    }
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(target_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| error.to_string())
}

fn write_document(path: &Path, document: &McpDocument) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("MCP 配置路径无效: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!("mcp.{}.tmp", Uuid::new_v4()));
    let json = serde_json::to_string_pretty(document).map_err(|error| error.to_string())?;
    fs::write(&temporary, json).map_err(|error| error.to_string())?;
    if let Err(error) = replace_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("写入 MCP 配置失败 ({}): {error}", path.display()));
    }
    Ok(())
}

fn merge_layer(
    result: &mut BTreeMap<String, McpConfigEntry>,
    scope: &str,
    enabled: ConfigMap,
    disabled: ConfigMap,
) {
    for (name, config) in enabled {
        result.insert(
            name.clone(),
            McpConfigEntry {
                name,
                config,
                enabled: true,
                scope: scope.to_string(),
            },
        );
    }
    for (name, config) in disabled {
        result.insert(
            name.clone(),
            McpConfigEntry {
                name,
                config,
                enabled: false,
                scope: scope.to_string(),
            },
        );
    }
}

fn list_at(
    workspace: &Path,
    home: &Path,
    settings: &HashMap<String, String>,
) -> Result<Vec<McpConfigEntry>, String> {
    let mut result = BTreeMap::new();
    merge_layer(
        &mut result,
        "settings",
        parse_collection(settings.get("MCP_SERVERS")),
        parse_collection(settings.get("MCP_SERVERS_DISABLED")),
    );

    let (global_path, project_path) = config_paths(workspace, home);
    for (scope, path) in [("global", global_path), ("project", project_path)] {
        let document = read_document(&path)?;
        merge_layer(
            &mut result,
            scope,
            document.mcp_servers,
            document.disabled_mcp_servers,
        );
    }
    Ok(result.into_values().collect())
}

fn validate_scope(scope: &str) -> Result<(), String> {
    match scope {
        "settings" | "global" | "project" => Ok(()),
        _ => Err(format!("未知 MCP 作用域: {scope}")),
    }
}

fn validate_config(config: &Value) -> Result<(), String> {
    let object = config
        .as_object()
        .ok_or_else(|| "MCP 配置必须是对象".to_string())?;
    let has_command = object.get("command").and_then(Value::as_str).is_some();
    let has_url = object.get("url").and_then(Value::as_str).is_some();
    if has_command || has_url {
        Ok(())
    } else {
        Err("MCP 配置必须包含 command 或 url".to_string())
    }
}

fn mutate_document(document: &mut McpDocument, name: &str, config: Option<Value>, enabled: bool) {
    document.mcp_servers.remove(name);
    document.disabled_mcp_servers.remove(name);
    if let Some(config) = config {
        if enabled {
            document.mcp_servers.insert(name.to_string(), config);
        } else {
            document
                .disabled_mcp_servers
                .insert(name.to_string(), config);
        }
    }
}

async fn mutate_settings(
    store: &AppStateStore,
    name: &str,
    config: Option<Value>,
    enabled: bool,
) -> Result<(), String> {
    let mut settings = store.settings_all().await;
    let mut enabled_configs = parse_collection(settings.get("MCP_SERVERS"));
    let mut disabled_configs = parse_collection(settings.get("MCP_SERVERS_DISABLED"));
    enabled_configs.remove(name);
    disabled_configs.remove(name);
    if let Some(config) = config {
        if enabled {
            enabled_configs.insert(name.to_string(), config);
        } else {
            disabled_configs.insert(name.to_string(), config);
        }
    }
    settings.insert(
        "MCP_SERVERS".to_string(),
        serialize_collection(&enabled_configs)?,
    );
    settings.insert(
        "MCP_SERVERS_DISABLED".to_string(),
        serialize_collection(&disabled_configs)?,
    );
    store.replace_settings(settings).await;
    store.write_runtime_config().await;
    Ok(())
}

fn mutate_file(
    workspace: &Path,
    home: &Path,
    scope: &str,
    name: &str,
    config: Option<Value>,
    enabled: bool,
) -> Result<(), String> {
    let (global_path, project_path) = config_paths(workspace, home);
    let path = if scope == "global" {
        global_path
    } else {
        project_path
    };
    let mut document = read_document(&path)?;
    mutate_document(&mut document, name, config, enabled);
    write_document(&path, &document)
}

#[tauri::command]
pub async fn list_mcp_configs(
    workspace: String,
    store: State<'_, AppStateStore>,
) -> Result<Vec<McpConfigEntry>, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法解析用户主目录".to_string())?;
    list_at(Path::new(&workspace), &home, &store.settings_all().await)
}

#[tauri::command]
pub async fn upsert_mcp_config(
    workspace: String,
    scope: String,
    name: String,
    config: Value,
    enabled: bool,
    store: State<'_, AppStateStore>,
) -> Result<(), String> {
    validate_scope(&scope)?;
    validate_config(&config)?;
    if scope == "settings" {
        return mutate_settings(&store, &name, Some(config), enabled).await;
    }
    let home = dirs::home_dir().ok_or_else(|| "无法解析用户主目录".to_string())?;
    mutate_file(
        Path::new(&workspace),
        &home,
        &scope,
        &name,
        Some(config),
        enabled,
    )
}

#[tauri::command]
pub async fn remove_mcp_config(
    workspace: String,
    scope: String,
    name: String,
    store: State<'_, AppStateStore>,
) -> Result<(), String> {
    validate_scope(&scope)?;
    if scope == "settings" {
        return mutate_settings(&store, &name, None, true).await;
    }
    let home = dirs::home_dir().ok_or_else(|| "无法解析用户主目录".to_string())?;
    mutate_file(Path::new(&workspace), &home, &scope, &name, None, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("pi-mcp-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn lists_all_layers_with_project_precedence_and_scope() {
        let home = temp_dir("home");
        let workspace = temp_dir("workspace");
        let (global_path, project_path) = config_paths(&workspace, &home);
        write_document(
            &global_path,
            &McpDocument {
                mcp_servers: BTreeMap::from([
                    (
                        "global-only".into(),
                        serde_json::json!({ "command": "global" }),
                    ),
                    ("same".into(), serde_json::json!({ "command": "global" })),
                ]),
                ..McpDocument::default()
            },
        )
        .unwrap();
        write_document(
            &project_path,
            &McpDocument {
                mcp_servers: BTreeMap::from([(
                    "same".into(),
                    serde_json::json!({ "command": "project" }),
                )]),
                ..McpDocument::default()
            },
        )
        .unwrap();
        let settings = HashMap::from([(
            "MCP_SERVERS".into(),
            r#"{"mcpServers":{"settings-only":{"command":"settings"},"same":{"command":"settings"}}}"#.into(),
        )]);

        let entries = list_at(&workspace, &home, &settings).unwrap();

        assert_eq!(entries.len(), 3);
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.name == "same")
                .unwrap()
                .scope,
            "project"
        );
        assert_eq!(
            entries
                .iter()
                .find(|entry| entry.name == "global-only")
                .unwrap()
                .scope,
            "global"
        );
        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn toggles_file_entry_without_moving_it_to_another_scope() {
        let mut document = McpDocument {
            mcp_servers: BTreeMap::from([(
                "demo".into(),
                serde_json::json!({ "command": "node" }),
            )]),
            ..McpDocument::default()
        };
        let config = document.mcp_servers.get("demo").unwrap().clone();

        mutate_document(&mut document, "demo", Some(config), false);

        assert!(!document.mcp_servers.contains_key("demo"));
        assert!(document.disabled_mcp_servers.contains_key("demo"));
    }
}
