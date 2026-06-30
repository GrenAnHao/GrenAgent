// Code Intelligence management UI + canvas data, backed by the codebase-memory-mcp
// CLI (`<bin> cli <tool> <json-args>`). codebase-memory ships as a SINGLE static
// binary placed under src-tauri/binaries/codebase-memory/ by build-codebasememory.mjs
// and shipped via tauri.conf.json `bundle.resources`.
//
// Two consumer groups, both via the CLI (one-shot tool calls):
//   - management UI: status / init / sync / reindex / is_initialized
//   - canvas: file_graph / rich_graph, built from `query_graph` Cypher results
//
// Project location: codebase-memory is multi-project and stores indexes under
// CBM_CACHE_DIR (we point it at <app_data_dir>/codebase-memory, shared with the
// agent path so both read the same DBs). Query tools REQUIRE an explicit
// `project` slug — we derive it from the workspace path (see `project_slug`,
// reproducing cbm_project_name_from_path).
//
// Output convention: the CLI prints log lines to stderr and the JSON result to
// stdout, so we parse stdout only. Cypher returns numeric columns as STRINGS
// (e.g. weight "1"), and external/empty endpoints as file_path "{}" or "" — both
// filtered on the consumer side, along with self-loops (a == b).
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tauri::path::BaseDirectory;
use tauri::Manager;

/// Resolve the codebase-memory binary: packaged resource first (prod), then the
/// dev build output (src-tauri/binaries/codebase-memory).
fn cbm_binary(app: &tauri::AppHandle) -> PathBuf {
    let exe = if cfg!(windows) {
        "codebase-memory-mcp.exe"
    } else {
        "codebase-memory-mcp"
    };
    if let Ok(p) = app.path().resolve("binaries/codebase-memory", BaseDirectory::Resource) {
        if p.is_dir() {
            return p.join(exe);
        }
    }
    crate::pi::sidecar::pi_package_dir()
        .join("codebase-memory")
        .join(exe)
}

/// Shared cache dir for cbm indexes = <app_data_dir>/codebase-memory. Set as
/// CBM_CACHE_DIR for every CLI call here AND when spawning the agent (see
/// pi/sidecar.rs), so the canvas and the agent's MCP server read the same DBs.
pub(crate) fn cbm_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("codebase-memory"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Reproduce cbm_project_name_from_path (fqn.c): map every char outside
/// [A-Za-z0-9._-] to '-', collapse consecutive '-' and '.', trim leading '-'/'.'
/// and trailing '-'. Deterministic — matches the indexed project name exactly.
fn project_slug(path: &str) -> String {
    let mapped: String = path
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let mut collapsed = String::with_capacity(mapped.len());
    let mut prev = '\0';
    for c in mapped.chars() {
        if (c == '-' && prev == '-') || (c == '.' && prev == '.') {
            continue;
        }
        collapsed.push(c);
        prev = c;
    }
    let trimmed = collapsed.trim_start_matches(['-', '.']).trim_end_matches('-');
    if trimmed.is_empty() {
        "root".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Normalize path separators for tolerant root_path comparison.
fn norm_path(p: &str) -> String {
    p.replace('\\', "/")
}

/// Run a one-shot CLI tool call. Returns trimmed stdout (the JSON result; logs
/// go to stderr). `args` is e.g. ["cli", "list_projects", "{}"].
async fn run_cbm(app: &tauri::AppHandle, args: &[&str]) -> Result<String, String> {
    let program = cbm_binary(app);
    let cache = cbm_cache_dir(app);
    std::fs::create_dir_all(&cache).ok();
    let output = tokio::process::Command::new(&program)
        .args(args)
        .env("CBM_CACHE_DIR", &cache)
        .output()
        .await
        .map_err(|e| format!("codebase-memory spawn failed ({}): {e}", program.display()))?;
    if !output.status.success() {
        return Err(format!(
            "codebase-memory {:?} exited ({:?}): {}",
            args,
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Index status + statistics for the current workspace, as a normalized JSON
/// string for the panel: {indexed, project, nodes, edges, sizeBytes, rootPath}.
#[tauri::command]
pub async fn code_intel_status(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    let slug = project_slug(&workspace);
    let raw = run_cbm(&app, &["cli", "list_projects", "{}"]).await?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    let empty = vec![];
    let projects = parsed
        .get("projects")
        .and_then(|p| p.as_array())
        .unwrap_or(&empty);
    let ws_norm = norm_path(&workspace);
    let found = projects.iter().find(|p| {
        p.get("name").and_then(|n| n.as_str()) == Some(slug.as_str())
            || p.get("root_path")
                .and_then(|r| r.as_str())
                .map(norm_path)
                .as_deref()
                == Some(ws_norm.as_str())
    });
    let status = match found {
        Some(p) => {
            let nodes = p.get("nodes").and_then(|n| n.as_i64()).unwrap_or(0);
            serde_json::json!({
                "indexed": nodes > 0,
                "project": slug,
                "nodes": nodes,
                "edges": p.get("edges").and_then(|n| n.as_i64()).unwrap_or(0),
                "sizeBytes": p.get("size_bytes").and_then(|n| n.as_i64()),
                "rootPath": p.get("root_path").and_then(|n| n.as_str()),
            })
        }
        None => serde_json::json!({ "indexed": false, "project": slug }),
    };
    Ok(status.to_string())
}

/// Initialize / build the index for the workspace (`cli index_repository`).
/// Incremental on subsequent runs (cbm hashes files), so safe to re-run.
#[tauri::command]
pub async fn code_intel_init(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    let arg = serde_json::json!({ "repo_path": workspace }).to_string();
    run_cbm(&app, &["cli", "index_repository", arg.as_str()]).await
}

/// Incremental sync since last index — cbm auto-detects changes, so this is the
/// same `index_repository` call as init.
#[tauri::command]
pub async fn code_intel_sync(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    let arg = serde_json::json!({ "repo_path": workspace }).to_string();
    run_cbm(&app, &["cli", "index_repository", arg.as_str()]).await
}

/// Rebuild — cbm's index_repository refreshes in place (no separate force flag in
/// the CLI surface); re-running picks up all changes.
#[tauri::command]
pub async fn code_intel_reindex(
    app: tauri::AppHandle,
    workspace: String,
) -> Result<String, String> {
    let arg = serde_json::json!({ "repo_path": workspace }).to_string();
    run_cbm(&app, &["cli", "index_repository", arg.as_str()]).await
}

/// Whether the workspace already has an index: cbm stores it at
/// <cache>/<slug>.db, so stat that file (cheap — no process spawn).
#[tauri::command]
pub async fn code_intel_is_initialized(
    app: tauri::AppHandle,
    workspace: String,
) -> Result<bool, String> {
    let db = cbm_cache_dir(&app).join(format!("{}.db", project_slug(&workspace)));
    Ok(db.is_file())
}

// ── 文件依赖图（代码图谱可视化） ─────────────────────────────────────────────
// 经 `query_graph` 取 cbm 的图谱数据，把符号级 import / call 边按文件归并成
// 「文件 → 文件」依赖图，供前端 reactflow 渲染。FileGraph/RichGraph 结构体与旧版
// 完全一致 → 前端画布零改动。

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGraphNode {
    pub path: String,
    pub language: String,
    pub node_count: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGraphEdge {
    pub source: String,
    pub target: String,
    pub weight: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGraph {
    pub nodes: Vec<FileGraphNode>,
    pub edges: Vec<FileGraphEdge>,
}

/// Cypher returns numeric columns as JSON strings (e.g. "546"); be tolerant.
fn cell_str(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
fn cell_i64(v: &serde_json::Value) -> i64 {
    match v {
        serde_json::Value::String(s) => s.trim().parse().unwrap_or(0),
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
        _ => 0,
    }
}

/// Run a `query_graph` Cypher query for the given project slug, returning rows
/// (each a Vec of cells). Surfaces a query-level `{"error":...}` as Err.
async fn query_rows(
    app: &tauri::AppHandle,
    slug: &str,
    cypher: &str,
) -> Result<Vec<Vec<serde_json::Value>>, String> {
    let arg = serde_json::json!({ "project": slug, "query": cypher }).to_string();
    let out = run_cbm(app, &["cli", "query_graph", arg.as_str()]).await?;
    let v: serde_json::Value = serde_json::from_str(&out)
        .map_err(|e| format!("query_graph JSON parse failed: {e}"))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(format!("query_graph: {err}"));
    }
    let rows = v
        .get("rows")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(rows
        .into_iter()
        .map(|r| r.as_array().cloned().unwrap_or_default())
        .collect())
}

/// Map a file extension (cbm File.extension) to a coarse language label for the
/// canvas. Falls back to the bare extension when unknown.
fn lang_from_ext(ext: &str, path: &str) -> String {
    let e = ext.trim_start_matches('.').to_ascii_lowercase();
    let e = if e.is_empty() {
        path.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
    } else {
        e
    };
    match e.as_str() {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescript",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascript",
        "py" => "python",
        "rs" => "rust",
        "go" => "go",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "md" | "mdx" => "markdown",
        "json" => "json",
        "" => "",
        other => return other.to_string(),
    }
    .to_string()
}

/// 文件依赖图：节点=文件，边=文件间 import（按符号级 import 归并、按 weight 取前 N）。
/// 只返回参与 import 边的文件（连通子图），避免孤立文件刷屏。
#[tauri::command]
pub async fn code_intel_file_graph(
    app: tauri::AppHandle,
    workspace: String,
    limit: Option<u32>,
) -> Result<FileGraph, String> {
    let slug = project_slug(&workspace);
    let max_edges = limit.unwrap_or(1500).clamp(1, 20000) as usize;

    // import 边（外部包目标 file_path 为 "{}"，过滤；自环与空串在消费侧再滤）。
    let rows = query_rows(
        &app,
        &slug,
        "MATCH (a)-[:IMPORTS]->(b) WHERE b.file_path <> '{}' \
         RETURN a.file_path AS source, b.file_path AS target, count(*) AS weight",
    )
    .await?;
    let mut edges: Vec<FileGraphEdge> = rows
        .iter()
        .filter_map(|r| {
            if r.len() < 3 {
                return None;
            }
            let source = cell_str(&r[0]);
            let target = cell_str(&r[1]);
            if source.is_empty() || target.is_empty() || source == target {
                return None;
            }
            Some(FileGraphEdge {
                source,
                target,
                weight: cell_i64(&r[2]),
            })
        })
        .collect();
    edges.sort_by(|a, b| b.weight.cmp(&a.weight));
    edges.truncate(max_edges);

    // 每文件节点数（结果含空串 file_path 行，过滤）。
    let nc_rows = query_rows(
        &app,
        &slug,
        "MATCH (n) WHERE n.file_path <> '{}' RETURN n.file_path AS path, count(*) AS nodeCount",
    )
    .await?;
    let mut node_count: HashMap<String, i64> = HashMap::new();
    for r in &nc_rows {
        if r.len() >= 2 {
            let p = cell_str(&r[0]);
            if !p.is_empty() {
                node_count.insert(p, cell_i64(&r[1]));
            }
        }
    }

    // File 元信息（extension → language）。
    let meta_rows = query_rows(
        &app,
        &slug,
        "MATCH (f:File) RETURN f.file_path AS path, f.extension AS ext",
    )
    .await?;
    let mut ext_by_path: HashMap<String, String> = HashMap::new();
    for r in &meta_rows {
        if r.len() >= 2 {
            let p = cell_str(&r[0]);
            if !p.is_empty() {
                ext_by_path.insert(p, cell_str(&r[1]));
            }
        }
    }

    // 连通文件集合。
    let mut paths: HashSet<String> = HashSet::new();
    for e in &edges {
        paths.insert(e.source.clone());
        paths.insert(e.target.clone());
    }

    let mut nodes: Vec<FileGraphNode> = paths
        .into_iter()
        .map(|p| {
            let language = lang_from_ext(ext_by_path.get(&p).map(|s| s.as_str()).unwrap_or(""), &p);
            let nc = node_count.get(&p).copied().unwrap_or(0);
            FileGraphNode {
                path: p,
                language,
                node_count: nc,
            }
        })
        .collect();
    nodes.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(FileGraph { nodes, edges })
}

// ── RichGraph（文件级归并，import + call 两类边） ───────────────────────────

/// 顶层目录作为聚类键；根文件（无目录分隔符）归到 '·'。
fn top_level_dir(path: &str) -> String {
    let segs: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    if segs.len() > 1 {
        segs[0].to_string()
    } else {
        "\u{00B7}".to_string()
    }
}

/// 力导布局：同目录节点锚定同一圆上的扇区，Euler 积分 420 步收敛。
/// 返回与 `paths` 同序的 (x, y) 坐标列表。
fn compute_layout(paths: &[String], edge_pairs: &[(usize, usize)]) -> Vec<(f32, f32)> {
    let n = paths.len();
    if n == 0 {
        return vec![];
    }

    let spacing = 190.0_f32;
    let size = 1000.0_f32.max((n as f32).sqrt() * spacing);
    let (cx, cy) = (size / 2.0, size / 2.0);
    let radius = size * 0.42;

    // 按插入顺序收集唯一顶层目录
    let mut dir_list: Vec<String> = Vec::new();
    {
        let mut seen = std::collections::HashSet::<String>::new();
        for p in paths {
            let d = top_level_dir(p);
            if seen.insert(d.clone()) {
                dir_list.push(d);
            }
        }
    }
    let nd = dir_list.len();

    // 各目录锚点（多目录均匀分布在大圆上，单目录锚在中心）
    let anchors: Vec<(f32, f32)> = dir_list
        .iter()
        .enumerate()
        .map(|(i, _)| {
            if nd <= 1 {
                (cx, cy)
            } else {
                let a = (i as f32 / nd as f32) * std::f32::consts::TAU;
                (cx + a.cos() * radius, cy + a.sin() * radius)
            }
        })
        .collect();

    // 每个节点对应的锚点索引
    let node_anchor: Vec<usize> = paths
        .iter()
        .map(|p| {
            let d = top_level_dir(p);
            dir_list.iter().position(|x| x == &d).unwrap_or(0)
        })
        .collect();

    // 初始位置：锚点 + 确定性抖动（与 TS 端 ((i*53)%100−50 相同）
    let mut px: Vec<f32> = (0..n)
        .map(|i| anchors[node_anchor[i]].0 + ((i * 53) % 100) as f32 - 50.0)
        .collect();
    let mut py: Vec<f32> = (0..n)
        .map(|i| anchors[node_anchor[i]].1 + ((i * 97) % 100) as f32 - 50.0)
        .collect();
    let mut vx = vec![0.0_f32; n];
    let mut vy = vec![0.0_f32; n];

    let mut alpha = 1.0_f32;
    let alpha_decay = 1.0 - 0.001_f32.powf(1.0 / 300.0); // ≈ 0.02279

    for _ in 0..420 {
        alpha *= 1.0 - alpha_decay;

        // 斥力（O(n²)，服务端单次计算，n≤2000 可接受）
        for i in 0..n {
            for j in (i + 1)..n {
                let dx = px[j] - px[i];
                let dy = py[j] - py[i];
                let d2 = (dx * dx + dy * dy).max(1.0);
                let f = -450.0 * alpha / d2; // 负 = 斥力
                vx[i] += dx * f;
                vy[i] += dy * f;
                vx[j] -= dx * f;
                vy[j] -= dy * f;
            }
        }

        // 弹簧力
        for &(si, ti) in edge_pairs {
            let dx = px[ti] + vx[ti] - px[si] - vx[si];
            let dy = py[ti] + vy[ti] - py[si] - vy[si];
            let l = (dx * dx + dy * dy).sqrt().max(1e-6);
            let s = (l - 120.0) / l * alpha * 0.08;
            vx[ti] -= dx * s * 0.5;
            vy[ti] -= dy * s * 0.5;
            vx[si] += dx * s * 0.5;
            vy[si] += dy * s * 0.5;
        }

        // 锚力 + 中心引力
        for i in 0..n {
            let (ax, ay) = anchors[node_anchor[i]];
            vx[i] += (ax - px[i]) * 0.13 * alpha;
            vy[i] += (ay - py[i]) * 0.13 * alpha;
            vx[i] += (cx - px[i]) * 0.02 * alpha;
            vy[i] += (cy - py[i]) * 0.02 * alpha;
        }

        // 速度衰减 + 积分
        for i in 0..n {
            vx[i] *= 0.6;
            vy[i] *= 0.6; // velocity_decay=0.4 → keep 0.6
            px[i] += vx[i];
            py[i] += vy[i];
        }

        // 防重叠（2 遍位置修正，radius=70）
        for _ in 0..2 {
            for i in 0..n {
                for j in (i + 1)..n {
                    let dx = px[j] - px[i];
                    let dy = py[j] - py[i];
                    let d2 = dx * dx + dy * dy;
                    if d2 < 140.0 * 140.0 && d2 > 0.0 {
                        let push = (140.0 / d2.sqrt() - 1.0) * 0.5;
                        px[i] -= dx * push;
                        py[i] -= dy * push;
                        px[j] += dx * push;
                        py[j] += dy * push;
                    }
                }
            }
        }
    }

    px.into_iter()
        .zip(py)
        .map(|(x, y)| (x.round(), y.round()))
        .collect()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RichGraphNode {
    pub path: String,
    pub lines: i64,
    pub export_count: i64,
    pub complexity: f64,
    pub in_degree: i64,
    pub x: f32,
    pub y: f32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RichGraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub weight: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RichGraph {
    pub nodes: Vec<RichGraphNode>,
    pub edges: Vec<RichGraphEdge>,
    pub circular_paths: Vec<Vec<String>>,
}

fn db_kind_to_edge_kind(k: &str) -> &'static str {
    match k {
        "imports" | "import" => "import-value",
        "type_imports" | "import_type" | "type-import" => "import-type",
        "reexports" | "reexport" | "re_export" => "reexport",
        "dynamic_imports" | "dynamic_import" | "dynamic" => "dynamic",
        "calls" | "call" | "invokes" => "call",
        _ => "import-value",
    }
}

#[tauri::command]
pub async fn code_intel_rich_graph(
    app: tauri::AppHandle,
    workspace: String,
    limit: Option<u32>,
) -> Result<RichGraph, String> {
    let slug = project_slug(&workspace);
    // Default capped low: the canvas renders edges on-demand (focused view), so we
    // only need the strongest edges for the skeleton + neighborhood expansion.
    let max_edges = limit.unwrap_or(800).clamp(1, 20000) as usize;

    // cbm 只有单一 IMPORTS（不分 type/reexport/dynamic）+ CALLS；`type(r)` 不支持，
    // 故按 [:TYPE] 分别查再合并。端点为 Function/Method，按 file_path 归并。
    let mut raw_edges: Vec<(String, String, String, i64)> = Vec::new();
    for (cypher, kind) in [
        (
            "MATCH (a)-[:IMPORTS]->(b) WHERE a.file_path <> '{}' AND b.file_path <> '{}' \
             RETURN a.file_path AS source, b.file_path AS target, count(*) AS weight",
            "imports",
        ),
        (
            "MATCH (a)-[:CALLS]->(b) WHERE a.file_path <> '{}' AND b.file_path <> '{}' \
             RETURN a.file_path AS source, b.file_path AS target, count(*) AS weight",
            "calls",
        ),
    ] {
        let rows = query_rows(&app, &slug, cypher).await?;
        for r in &rows {
            if r.len() < 3 {
                continue;
            }
            let source = cell_str(&r[0]);
            let target = cell_str(&r[1]);
            if source.is_empty() || target.is_empty() || source == target {
                continue;
            }
            raw_edges.push((source, target, kind.to_string(), cell_i64(&r[2])));
        }
    }
    raw_edges.sort_by(|a, b| b.3.cmp(&a.3));
    raw_edges.truncate(max_edges);

    let mut in_degree: HashMap<String, i64> = HashMap::new();
    for (_, tgt, _, _) in &raw_edges {
        *in_degree.entry(tgt.clone()).or_insert(0) += 1;
    }

    let mut path_set: HashSet<String> = HashSet::new();
    for (src, tgt, _, _) in &raw_edges {
        path_set.insert(src.clone());
        path_set.insert(tgt.clone());
    }

    // 每文件节点数（画布节点大小 / complexity 归一化）。
    let nc_rows = query_rows(
        &app,
        &slug,
        "MATCH (n) WHERE n.file_path <> '{}' RETURN n.file_path AS path, count(*) AS nodeCount",
    )
    .await?;
    let mut meta: HashMap<String, i64> = HashMap::new();
    for r in &nc_rows {
        if r.len() >= 2 {
            let p = cell_str(&r[0]);
            if !p.is_empty() {
                meta.insert(p, cell_i64(&r[1]));
            }
        }
    }

    let max_nc = meta.values().copied().max().unwrap_or(1).max(1);
    let mut nodes: Vec<RichGraphNode> = {
        let mut v: Vec<RichGraphNode> = path_set
            .iter()
            .map(|p| {
                let nc = meta.get(p).copied().unwrap_or(0);
                RichGraphNode {
                    path: p.clone(),
                    lines: nc,
                    export_count: nc,
                    complexity: (nc as f64 / max_nc as f64).min(1.0),
                    in_degree: in_degree.get(p).copied().unwrap_or(0),
                    x: 0.0,
                    y: 0.0,
                }
            })
            .collect();
        v.sort_by(|a, b| a.path.cmp(&b.path));
        v
    };

    // 力导布局（Rust 侧，420 步 Euler 积分）
    let paths: Vec<String> = nodes.iter().map(|n| n.path.clone()).collect();
    let path_idx: HashMap<&str, usize> =
        paths.iter().enumerate().map(|(i, p)| (p.as_str(), i)).collect();
    let edge_idx: Vec<(usize, usize)> = raw_edges
        .iter()
        .filter_map(|(src, tgt, _, _)| Some((*path_idx.get(src.as_str())?, *path_idx.get(tgt.as_str())?)))
        .collect();
    for (node, (x, y)) in nodes.iter_mut().zip(compute_layout(&paths, &edge_idx)) {
        node.x = x;
        node.y = y;
    }

    let edges: Vec<RichGraphEdge> = raw_edges
        .into_iter()
        .map(|(src, tgt, kind, weight)| RichGraphEdge {
            source: src,
            target: tgt,
            kind: db_kind_to_edge_kind(&kind).to_string(),
            weight,
        })
        .collect();

    Ok(RichGraph {
        nodes,
        edges,
        circular_paths: vec![],
    })
}
