// One-shot CodeGraph CLI invocations backing the Code Intelligence management UI
// (status / init / sync / reindex) plus an init-state probe.
//
// CodeGraph ships as a directory bundle (a vendored Node runtime + lib/dist + a
// bin launcher), NOT a single-file binary, so it cannot be a tauri externalBin
// sidecar. build-codegraph.mjs places it under src-tauri/binaries/codegraph and
// tauri.conf.json ships it via `bundle.resources`. We resolve the bundle dir
// (packaged resource first, dev binaries/ fallback) and run the platform
// launcher directly:
//   unix : <dir>/bin/codegraph <args>
//   win32: <dir>/node.exe --liftoff-only <dir>/lib/dist/bin/codegraph.js <args>
// (Windows cannot spawn the bundle's .cmd directly — CVE-2024-27980 hardening —
//  so we invoke the bundled node.exe against the app entry; --liftoff-only also
//  keeps tree-sitter's WASM grammars off V8's turboshaft tier to avoid an OOM.)
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Resolve the CodeGraph bundle directory: packaged resource first (prod),
/// then the dev build output (src-tauri/binaries/codegraph).
fn codegraph_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = app
        .path()
        .resolve("binaries/codegraph", tauri::path::BaseDirectory::Resource)
    {
        if p.is_dir() {
            return p;
        }
    }
    crate::pi::sidecar::pi_package_dir().join("codegraph")
}

/// (program, leading-args) for the bundled launcher on this platform.
fn launcher(dir: &Path) -> (PathBuf, Vec<String>) {
    if cfg!(windows) {
        (
            dir.join("node.exe"),
            vec![
                "--liftoff-only".to_string(),
                // 相对入口（解析自 cwd = bundle dir，见 run_codegraph）。绝对入口若含空格
                // （如 "D:\\OneDrive\\Project Files\\..."），codegraph 在非 TTY / piped 下用
                // child_process 拉起索引 worker 时会在空格处截断入口，报
                // "Cannot find module 'D:\\OneDrive\\Project'" / lstat 'D:'。相对入口规避。
                "lib/dist/bin/codegraph.js".to_string(),
            ],
        )
    } else {
        (dir.join("bin").join("codegraph"), Vec::new())
    }
}

async fn run_codegraph(app: &tauri::AppHandle, args: &[&str]) -> Result<String, String> {
    let dir = codegraph_dir(app);
    let (program, mut full_args) = launcher(&dir);
    full_args.extend(args.iter().map(|s| s.to_string()));
    // cwd = bundle dir（不是 workspace）：win32 相对入口据此解析，且让 codegraph 的索引
    // worker 子进程以无空格的相对入口启动。workspace 始终经命令行参数显式传入
    // （init/status/sync/index <workspace>），不依赖 cwd。
    let output = tokio::process::Command::new(&program)
        .args(&full_args)
        .current_dir(&dir)
        .output()
        .await
        .map_err(|e| format!("codegraph spawn failed ({}): {e}", program.display()))?;
    if !output.status.success() {
        return Err(format!(
            "codegraph {:?} exited ({:?}): {}",
            args,
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Index status + statistics (`codegraph status <ws>`), human-readable text.
#[tauri::command]
pub async fn code_intel_status(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    run_codegraph(&app, &["status", workspace.as_str()]).await
}

/// Initialize CodeGraph and build the initial index (`codegraph init <ws>`).
/// Idempotent: re-running on an initialized project is a no-op/refresh upstream.
#[tauri::command]
pub async fn code_intel_init(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    run_codegraph(&app, &["init", workspace.as_str()]).await
}

/// Incremental sync since last index (`codegraph sync <ws>`).
#[tauri::command]
pub async fn code_intel_sync(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    run_codegraph(&app, &["sync", workspace.as_str()]).await
}

/// Full rebuild (`codegraph index -f <ws>`).
#[tauri::command]
pub async fn code_intel_reindex(
    app: tauri::AppHandle,
    workspace: String,
) -> Result<String, String> {
    run_codegraph(&app, &["index", "-f", workspace.as_str()]).await
}

/// Whether the workspace already has an index (presence of `.codegraph/`).
#[tauri::command]
pub async fn code_intel_is_initialized(workspace: String) -> Result<bool, String> {
    Ok(Path::new(&workspace).join(".codegraph").is_dir())
}

// ── 文件依赖图（代码图谱可视化） ─────────────────────────────────────────────
// 直接只读 CodeGraph 的 SQLite 索引（.codegraph/codegraph.db），把符号级/文件级的
// `imports` 边按文件归并成「文件 → 文件」依赖图，供前端 reactflow 渲染。
// schema 取自 CodeGraph 源码：nodes(id,kind,name,file_path,...) / edges(source,target,kind,...)
// / files(path,language,node_count,...)；edges.source/target 为 nodes.id。

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

/// 只读打开 codegraph.db。路径含空格/反斜杠时直接传 Path（非 URI）最稳。
fn open_codegraph_db(workspace: &str) -> Result<rusqlite::Connection, String> {
    let db = Path::new(workspace)
        .join(".codegraph")
        .join("codegraph.db");
    if !db.is_file() {
        return Err("当前 workspace 尚未建立 CodeGraph 索引（请先在「索引」里初始化）".to_string());
    }
    rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开 codegraph.db 失败: {e}"))
}

/// 文件依赖图：节点=文件，边=文件间 import（按符号级 import 归并、按 weight 取前 N）。
/// 只返回参与 import 边的文件（连通子图），避免孤立文件刷屏。
#[tauri::command]
pub async fn code_intel_file_graph(
    workspace: String,
    limit: Option<u32>,
) -> Result<FileGraph, String> {
    let conn = open_codegraph_db(&workspace)?;
    let max_edges = limit.unwrap_or(1500).clamp(1, 20000);

    // import 边按文件归并（对符号级与文件级 import 都鲁棒）；按 weight 取前 N。
    let mut stmt = conn
        .prepare(
            "SELECT src.file_path AS source, tgt.file_path AS target, COUNT(*) AS weight \
             FROM edges e \
             JOIN nodes src ON e.source = src.id \
             JOIN nodes tgt ON e.target = tgt.id \
             WHERE e.kind = 'imports' AND src.file_path <> tgt.file_path \
             GROUP BY src.file_path, tgt.file_path \
             ORDER BY weight DESC \
             LIMIT ?1",
        )
        .map_err(|e| format!("查询依赖边失败: {e}"))?;
    let edges: Vec<FileGraphEdge> = stmt
        .query_map([max_edges], |row| {
            Ok(FileGraphEdge {
                source: row.get(0)?,
                target: row.get(1)?,
                weight: row.get(2)?,
            })
        })
        .map_err(|e| format!("查询依赖边失败: {e}"))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("读取依赖边失败: {e}"))?;

    // 连通文件集合。
    let mut paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    for e in &edges {
        paths.insert(e.source.clone());
        paths.insert(e.target.clone());
    }

    // 文件元信息（language / node_count），仅对连通集合产出节点。
    let mut meta = conn
        .prepare("SELECT path, language, node_count FROM files")
        .map_err(|e| format!("查询文件失败: {e}"))?;
    let mut by_path: std::collections::HashMap<String, (String, i64)> =
        std::collections::HashMap::new();
    let rows = meta
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("查询文件失败: {e}"))?;
    for r in rows {
        let (path, language, node_count) = r.map_err(|e| format!("读取文件失败: {e}"))?;
        by_path.insert(path, (language, node_count));
    }

    let mut nodes: Vec<FileGraphNode> = paths
        .into_iter()
        .map(|p| {
            let (language, node_count) = by_path.get(&p).cloned().unwrap_or_default();
            FileGraphNode {
                path: p,
                language,
                node_count,
            }
        })
        .collect();
    nodes.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(FileGraph { nodes, edges })
}

// ── RichGraph（全边类型，文件级归并） ─────────────────────────────────────────

/// 顶层目录作为聚类键；根文件（无目录分隔符）归到 '·'。
fn top_level_dir(path: &str) -> String {
    let segs: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    if segs.len() > 1 { segs[0].to_string() } else { "\u{00B7}".to_string() }
}

/// 力导布局：同目录节点锚定同一圆上的扇区，Euler 积分 420 步收敛。
/// 返回与 `paths` 同序的 (x, y) 坐标列表。
fn compute_layout(paths: &[String], edge_pairs: &[(usize, usize)]) -> Vec<(f32, f32)> {
    let n = paths.len();
    if n == 0 { return vec![]; }

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
            if seen.insert(d.clone()) { dir_list.push(d); }
        }
    }
    let nd = dir_list.len();

    // 各目录锚点（多目录均匀分布在大圆上，单目录锚在中心）
    let anchors: Vec<(f32, f32)> = dir_list.iter().enumerate().map(|(i, _)| {
        if nd <= 1 { (cx, cy) } else {
            let a = (i as f32 / nd as f32) * std::f32::consts::TAU;
            (cx + a.cos() * radius, cy + a.sin() * radius)
        }
    }).collect();

    // 每个节点对应的锚点索引
    let node_anchor: Vec<usize> = paths.iter().map(|p| {
        let d = top_level_dir(p);
        dir_list.iter().position(|x| x == &d).unwrap_or(0)
    }).collect();

    // 初始位置：锚点 + 确定性抖动（与 TS 端 ((i*53)%100−50 相同）
    let mut px: Vec<f32> = (0..n).map(|i| anchors[node_anchor[i]].0 + ((i * 53) % 100) as f32 - 50.0).collect();
    let mut py: Vec<f32> = (0..n).map(|i| anchors[node_anchor[i]].1 + ((i * 97) % 100) as f32 - 50.0).collect();
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
                vx[i] += dx * f;  vy[i] += dy * f;
                vx[j] -= dx * f;  vy[j] -= dy * f;
            }
        }

        // 弹簧力
        for &(si, ti) in edge_pairs {
            let dx = px[ti] + vx[ti] - px[si] - vx[si];
            let dy = py[ti] + vy[ti] - py[si] - vy[si];
            let l = (dx * dx + dy * dy).sqrt().max(1e-6);
            let s = (l - 120.0) / l * alpha * 0.08;
            vx[ti] -= dx * s * 0.5;  vy[ti] -= dy * s * 0.5;
            vx[si] += dx * s * 0.5;  vy[si] += dy * s * 0.5;
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
            vx[i] *= 0.6;  vy[i] *= 0.6; // velocity_decay=0.4 → keep 0.6
            px[i] += vx[i];  py[i] += vy[i];
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
                        px[i] -= dx * push;  py[i] -= dy * push;
                        px[j] += dx * push;  py[j] += dy * push;
                    }
                }
            }
        }
    }

    px.into_iter().zip(py).map(|(x, y)| (x.round(), y.round())).collect()
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
    workspace: String,
    limit: Option<u32>,
) -> Result<RichGraph, String> {
    let conn = open_codegraph_db(&workspace)?;
    // Default capped low: the canvas renders edges on-demand (focused view), so we
    // only need the strongest edges for the skeleton + neighborhood expansion.
    // Callers can still request more via `limit`.
    let max_edges = limit.unwrap_or(800).clamp(1, 20000);

    let mut stmt = conn
        .prepare(
            "SELECT src.file_path, tgt.file_path, e.kind, COUNT(*) \
             FROM edges e \
             JOIN nodes src ON e.source = src.id \
             JOIN nodes tgt ON e.target = tgt.id \
             WHERE src.file_path <> tgt.file_path \
             GROUP BY src.file_path, tgt.file_path, e.kind \
             ORDER BY COUNT(*) DESC \
             LIMIT ?1",
        )
        .map_err(|e| format!("query edges failed: {e}"))?;

    let raw_edges: Vec<(String, String, String, i64)> = stmt
        .query_map([max_edges], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|e| format!("query edges failed: {e}"))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("read edges failed: {e}"))?;

    let mut in_degree: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for (_, tgt, _, _) in &raw_edges {
        *in_degree.entry(tgt.clone()).or_insert(0) += 1;
    }

    let mut path_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (src, tgt, _, _) in &raw_edges {
        path_set.insert(src.clone());
        path_set.insert(tgt.clone());
    }

    let mut meta_stmt = conn
        .prepare("SELECT path, node_count FROM files")
        .map_err(|e| format!("query files failed: {e}"))?;
    let meta: std::collections::HashMap<String, i64> = meta_stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| format!("query files failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read files failed: {e}"))?
        .into_iter()
        .collect();

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

    // 计算力导布局（Rust 侧，420 步 Euler 积分）
    let paths: Vec<String> = nodes.iter().map(|n| n.path.clone()).collect();
    let path_idx: std::collections::HashMap<&str, usize> =
        paths.iter().enumerate().map(|(i, p)| (p.as_str(), i)).collect();
    let edge_idx: Vec<(usize, usize)> = raw_edges
        .iter()
        .filter_map(|(src, tgt, _, _)| {
            Some((*path_idx.get(src.as_str())?, *path_idx.get(tgt.as_str())?))
        })
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

    Ok(RichGraph { nodes, edges, circular_paths: vec![] })
}
