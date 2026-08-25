use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 全局技能目录（与 pi 的全局 skill 发现一致）：`~/.agents/skills` 与 `~/.pi/agent/skills`。
/// 列表会扫描两者；新增技能写到首选目录 `~/.agents/skills`（见 add_target_dir）。
fn global_skill_dirs() -> Vec<PathBuf> {
    match dirs::home_dir() {
        Some(home) => vec![
            home.join(".agents").join("skills"),
            home.join(".pi").join("agent").join("skills"),
        ],
        None => Vec::new(),
    }
}
/// 新增技能的目标目录：用户全局 `~/.agents/skills`（与现有技能同处）。
fn add_target_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法解析用户主目录".to_string())?;
    Ok(home.join(".agents").join("skills"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// 技能名（frontmatter 的 name，缺省回退到目录名）——不含 `skill:` 前缀。
    pub name: String,
    pub description: String,
    /// 技能目录的绝对路径（删除时回传校验用）。
    pub path: String,
    pub scope: String,
}

/// 从 SKILL.md 抽取 frontmatter 的 name / description。
/// 仅做展示用的最简解析：支持 description 为单行，或 YAML 折叠/字面块（`>` `|` 后跟缩进多行）。
fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let trimmed = text.trim_start_matches('\u{feff}');
    if !trimmed.starts_with("---") {
        return (None, None);
    }

    let mut lines = trimmed.lines();
    lines.next(); // 跳过起始的 ---
    let mut fm: Vec<&str> = Vec::new();
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        fm.push(line);
    }

    let unquote = |s: &str| s.trim().trim_matches('"').trim_matches('\'').to_string();
    let mut name = None;
    let mut description = None;
    let mut i = 0;
    while i < fm.len() {
        let line = fm[i];
        if let Some(rest) = line.strip_prefix("name:") {
            name = Some(unquote(rest));
            i += 1;
        } else if let Some(rest) = line.strip_prefix("description:") {
            let head = rest.trim();
            let is_block = head.is_empty()
                || head == ">"
                || head == "|"
                || head.starts_with(">-")
                || head.starts_with("|-")
                || head.starts_with(">+")
                || head.starts_with("|+");
            if is_block {
                let mut collected: Vec<String> = Vec::new();
                i += 1;
                while i < fm.len() {
                    let l = fm[i];
                    if l.trim().is_empty() {
                        collected.push(String::new());
                        i += 1;
                    } else if l.starts_with(' ') || l.starts_with('\t') {
                        collected.push(l.trim().to_string());
                        i += 1;
                    } else {
                        break;
                    }
                }
                description = Some(
                    collected
                        .join(" ")
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            } else {
                description = Some(unquote(head));
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    (name, description)
}

/// 列出全局技能（按名排序，同名只保留先发现的，`~/.agents/skills` 优先）。
#[tauri::command]
pub async fn list_skills() -> Result<Vec<SkillInfo>, String> {
    let mut out: Vec<SkillInfo> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for dir in global_skill_dirs() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // 目录不存在 → 跳过
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let dir_name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let (fm_name, fm_desc) =
                parse_frontmatter(&fs::read_to_string(&skill_md).unwrap_or_default());
            let name = fm_name
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| dir_name.clone());
            if !seen.insert(name.clone()) {
                continue;
            }
            out.push(SkillInfo {
                name,
                description: fm_desc.unwrap_or_default(),
                path: path.to_string_lossy().to_string(),
                scope: "global".to_string(),
            });
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("技能名称不能为空".into());
    }
    if name.len() > 64 {
        return Err("技能名称过长（最多 64 字符）".into());
    }
    if name.starts_with('.') {
        return Err("技能名称不能以点开头".into());
    }
    let ok = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if !ok {
        return Err("技能名称只能包含字母、数字、连字符、下划线和点".into());
    }
    Ok(())
}

/// 把描述压成单行并以 YAML 双引号标量输出，避免冒号等字符破坏 frontmatter。
fn yaml_quote(s: &str) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    format!(
        "\"{}\"",
        one_line.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

fn build_skill_md(name: &str, description: &str, body: &str) -> String {
    let desc = description.trim();
    let body = body.trim();
    let mut s = String::from("---\n");
    s.push_str(&format!("name: {name}\n"));
    if !desc.is_empty() {
        s.push_str(&format!("description: {}\n", yaml_quote(desc)));
    }
    s.push_str("---\n\n");
    if body.is_empty() {
        s.push_str(&format!("# {name}\n"));
    } else {
        s.push_str(body);
        s.push('\n');
    }
    s
}

/// 在 `~/.agents/skills/<name>/SKILL.md` 创建一个新技能。已存在则报错。
#[tauri::command]
pub async fn create_skill(
    name: String,
    description: String,
    body: String,
) -> Result<SkillInfo, String> {
    let name = name.trim().to_string();
    validate_skill_name(&name)?;

    let skill_dir = add_target_dir()?.join(&name);
    if skill_dir.exists() {
        return Err(format!("技能 \"{name}\" 已存在"));
    }
    fs::create_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    fs::write(
        skill_dir.join("SKILL.md"),
        build_skill_md(&name, &description, &body),
    )
    .map_err(|e| e.to_string())?;

    Ok(SkillInfo {
        name,
        description: description.split_whitespace().collect::<Vec<_>>().join(" "),
        path: skill_dir.to_string_lossy().to_string(),
        scope: "global".to_string(),
    })
}

/// 永久删除一个技能目录。仅允许删除「全局技能目录内、且含 SKILL.md」的目录（防误删）。
#[tauri::command]
pub async fn delete_skill(path: String) -> Result<(), String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("路径无效: {e}"))?;

    let within_global = global_skill_dirs().into_iter().any(|dir| {
        dir.canonicalize()
            .map(|base| canonical != base && canonical.starts_with(&base))
            .unwrap_or(false)
    });
    if !within_global {
        return Err("拒绝删除：路径不在全局技能目录内".into());
    }
    if !canonical.join("SKILL.md").is_file() {
        return Err("拒绝删除：目标不是技能目录（缺少 SKILL.md）".into());
    }

    fs::remove_dir_all(&canonical).map_err(|e| e.to_string())
}

/// 递归复制目录（std 无内置 copy_dir，手写）。目标目录会被创建。
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 读取已落盘技能目录的 SKILL.md，组装 SkillInfo（name 取 frontmatter，缺省回退目录名）。
fn read_skill_info(dir: &Path, fallback_name: &str) -> SkillInfo {
    let (fm_name, fm_desc) =
        parse_frontmatter(&fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default());
    let name = fm_name
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback_name.to_string());
    SkillInfo {
        name,
        description: fm_desc.unwrap_or_default(),
        path: dir.to_string_lossy().to_string(),
        scope: "global".to_string(),
    }
}

/// 把一个技能目录（含 SKILL.md）整体导入到 `~/.agents/skills/<目录名>`。
#[tauri::command]
pub async fn import_skill_from_dir(src: String) -> Result<SkillInfo, String> {
    let src = PathBuf::from(&src)
        .canonicalize()
        .map_err(|e| format!("路径无效: {e}"))?;
    if !src.is_dir() {
        return Err("请选择一个技能目录".into());
    }
    if !src.join("SKILL.md").is_file() {
        return Err("该目录缺少 SKILL.md，不是有效技能目录".into());
    }
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无法解析目录名".to_string())?
        .to_string();
    validate_skill_name(&name)?;
    let dst = add_target_dir()?.join(&name);
    if dst.exists() {
        return Err(format!("技能 \"{name}\" 已存在"));
    }
    copy_dir_recursive(&src, &dst)?;
    Ok(read_skill_info(&dst, &name))
}

/// 把单个 Markdown 文件作为 SKILL.md 导入：新建 `~/.agents/skills/<推导名>/SKILL.md`。
/// 推导名：文件名为 SKILL.md 时取父目录名，否则取文件名（去扩展名）。
#[tauri::command]
pub async fn import_skill_from_file(src: String) -> Result<SkillInfo, String> {
    let src = PathBuf::from(&src)
        .canonicalize()
        .map_err(|e| format!("路径无效: {e}"))?;
    if !src.is_file() {
        return Err("请选择一个文件".into());
    }
    let content = fs::read_to_string(&src).map_err(|e| format!("读取失败: {e}"))?;
    let file_name = src.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let name = if file_name.eq_ignore_ascii_case("SKILL.md") {
        src.parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("skill")
            .to_string()
    } else {
        src.file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("skill")
            .to_string()
    };
    validate_skill_name(&name)?;
    let dst = add_target_dir()?.join(&name);
    if dst.exists() {
        return Err(format!("技能 \"{name}\" 已存在"));
    }
    fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
    fs::write(dst.join("SKILL.md"), content).map_err(|e| e.to_string())?;
    Ok(read_skill_info(&dst, &name))
}

/// 在解压后的临时目录里定位技能根：根直接含 SKILL.md（名取 zip 文件名），
/// 或唯一一个含 SKILL.md 的直接子目录（名取子目录名）。
fn locate_skill_root(tmp: &Path, zip_path: &Path) -> Result<(PathBuf, String), String> {
    if tmp.join("SKILL.md").is_file() {
        let name = zip_path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("skill")
            .to_string();
        return Ok((tmp.to_path_buf(), name));
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(tmp).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.is_dir() && p.join("SKILL.md").is_file() {
            candidates.push(p);
        }
    }
    match candidates.len() {
        0 => Err("zip 内未找到 SKILL.md".into()),
        1 => {
            let p = candidates.pop().unwrap();
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("skill")
                .to_string();
            Ok((p, name))
        }
        _ => Err("zip 内包含多个技能，请逐个打包安装".into()),
    }
}

/// 从 zip 安装技能：解压到临时目录 → 定位含 SKILL.md 的根 → 复制到 `~/.agents/skills/<name>`。
#[tauri::command]
pub async fn install_skill_from_zip(src: String) -> Result<SkillInfo, String> {
    let zip_path = PathBuf::from(&src);
    let file = fs::File::open(&zip_path).map_err(|e| format!("打开 zip 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 zip 失败: {e}"))?;

    let tmp = std::env::temp_dir().join(format!("pi-skill-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    // 解压上限：防解压炸弹（header 声明大小很小、解压后巨大）。skill 包通常很小，这里给足余量。
    const MAX_ENTRIES: usize = 5000;
    const MAX_TOTAL_UNCOMPRESSED: u64 = 100 * 1024 * 1024; // 100MB

    let mut extract = || -> Result<(PathBuf, String), String> {
        if archive.len() > MAX_ENTRIES {
            return Err(format!(
                "zip 条目过多（{} > {}），疑似异常包，已中止",
                archive.len(),
                MAX_ENTRIES
            ));
        }
        let mut total: u64 = 0;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            // enclosed_name 过滤 `..` / 绝对路径等 zip-slip 逃逸条目。
            let rel = match entry.enclosed_name() {
                Some(p) => p.to_path_buf(),
                None => continue,
            };
            let out = tmp.join(&rel);
            if entry.is_dir() {
                fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = out.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut f = fs::File::create(&out).map_err(|e| e.to_string())?;
                // 用「剩余预算 +1」限制单次读取：实际写入超过预算即判定解压炸弹并中止，
                // 不信任 header 声明的 size（可被伪造）。
                let remaining = MAX_TOTAL_UNCOMPRESSED - total;
                let written = std::io::copy(&mut (&mut entry).take(remaining + 1), &mut f)
                    .map_err(|e| e.to_string())?;
                if written > remaining {
                    return Err(format!(
                        "zip 解压总量超过上限（{} MB），疑似解压炸弹，已中止",
                        MAX_TOTAL_UNCOMPRESSED / 1024 / 1024
                    ));
                }
                total += written;
            }
        }
        let (src_dir, name) = locate_skill_root(&tmp, &zip_path)?;
        validate_skill_name(&name)?;
        let dst = add_target_dir()?.join(&name);
        if dst.exists() {
            return Err(format!("技能 \"{name}\" 已存在"));
        }
        copy_dir_recursive(&src_dir, &dst)?;
        Ok((dst, name))
    };

    let result = extract();
    let _ = fs::remove_dir_all(&tmp); // 清理临时目录（无论成败）
    let (dst, name) = result?;
    Ok(read_skill_info(&dst, &name))
}

/// 在系统文件管理器中打开全局技能目录（不存在则先创建），返回其路径。
#[tauri::command]
pub async fn open_skills_dir() -> Result<String, String> {
    let dir = add_target_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open")
        .arg(&dir)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_inline_description() {
        let (name, desc) =
            parse_frontmatter("---\nname: ctx7\ndescription: Fetch docs for libs.\n---\n\nbody");
        assert_eq!(name.as_deref(), Some("ctx7"));
        assert_eq!(desc.as_deref(), Some("Fetch docs for libs."));
    }

    #[test]
    fn parses_folded_description() {
        let text = "---\nname: caveman\ndescription: >\n  Ultra compressed mode.\n  Cuts tokens.\n---\n\nbody";
        let (name, desc) = parse_frontmatter(text);
        assert_eq!(name.as_deref(), Some("caveman"));
        assert_eq!(desc.as_deref(), Some("Ultra compressed mode. Cuts tokens."));
    }

    #[test]
    fn no_frontmatter_returns_none() {
        let (name, desc) = parse_frontmatter("# Just a heading\n");
        assert!(name.is_none());
        assert!(desc.is_none());
    }

    #[test]
    fn rejects_bad_names() {
        assert!(validate_skill_name("good-name_1.2").is_ok());
        assert!(validate_skill_name("").is_err());
        assert!(validate_skill_name("../escape").is_err());
        assert!(validate_skill_name("has space").is_err());
        assert!(validate_skill_name(".hidden").is_err());
    }

    #[test]
    fn builds_skill_md_with_quoted_description() {
        let md = build_skill_md("demo", "Use when: testing", "Hello body");
        assert!(md.contains("name: demo"));
        assert!(md.contains("description: \"Use when: testing\""));
        assert!(md.trim_end().ends_with("Hello body"));
    }
}
