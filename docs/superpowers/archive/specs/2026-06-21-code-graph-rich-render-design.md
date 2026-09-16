# 代码图谱丰富渲染设计

**日期:** 2026-06-21
**状态:** 待实现
**范围:** `tauri-agent/src/` — CodeGraphPanel 及相关模块

---

## 问题

对话界面中的代码图谱关系图渲染不够丰富：节点只显示文件名，边类型单一（仅 import），缺少搜索、深度控制、路径高亮、目录折叠等交互，且数据层与渲染层耦合在单文件内难以扩展。

---

## 设计决策

| 维度 | 决策 |
|------|------|
| 节点粒度 | 文件级（不下沉到符号级） |
| 架构模式 | 数据层 / 渲染层分离 |
| 渲染库 | 保留 ReactFlow + d3-force |
| 节点信息密度 | Rich（类型图标 + 行数 + 依赖计数 + 复杂度条 + 大小随 inDegree 缩放） |
| 边类型 | 6 种（见下） |
| 交互功能 | 搜索定位 · N 跳深度 · 路径高亮 · 目录折叠 |

---

## 架构

```
数据层
  codeGraphTypes.ts   — 共享类型（GraphNode / GraphEdge / EdgeKind / RichGraph）
  codeGraphIo.ts      — 扩展：新增 getRichGraph()，保留 FileGraph（@deprecated）

计算层
  codeGraphLayout.ts  — 小改：接受 GraphNode[] 类型
  codeGraphPath.ts    — 新建：BFS 路径查找 + 循环依赖检测

状态层
  useGraphState.ts    — 新建：所有交互状态集中管理

渲染层（纯 props 驱动）
  GraphCanvas.tsx     — ReactFlow 画布
  GraphToolbar.tsx    — 搜索框 · 深度滑块 · 边类型切换
  GraphSidebar.tsx    — 选中文件详情 · 路径列表（从 CodeGraphPanel 拆出）
  CodeGraphPanel.tsx  — 薄编排层（保持现有 Modal + 入口不变）
```

---

## 数据模型

```typescript
// codeGraphTypes.ts

type EdgeKind =
  | 'import-value'  // 普通 import
  | 'import-type'   // import type
  | 'reexport'      // export * from
  | 'dynamic'       // import()
  | 'call'          // 跨文件函数调用（文件级聚合）
  | 'circular'      // 循环依赖（派生：不存储在 RichGraph.edges 中；
                    //   渲染层由 circularPaths 展开为临时 GraphEdge[] 传给 ReactFlow）

interface GraphNode {
  path:        string   // 相对 workspace 根
  lines:       number
  exportCount: number
  complexity:  number   // 0–1，由 CodeGraph 计算
  inDegree:    number   // 被依赖次数，决定节点大小
}

interface GraphEdge {
  source: string
  target: string
  kind:   EdgeKind
  weight: number        // import 次数 / call 次数
}

interface RichGraph {
  nodes:         GraphNode[]
  edges:         GraphEdge[]
  circularPaths: string[][]   // 由 codeGraphPath.detectCycles() 派生
}
```

---

## 节点视觉规范

### 卡片结构

```
┌──── 目录色左边框（3px）────────────────────┐
│  [类型图标]  文件名.tsx                      │
│  312 行   ↑8（依赖数）  ↓5（被依赖数）      │
│  [█████████░░]  复杂度条                    │
└────────────────────────────────────────────┘
```

- **节点高度** = `clamp(12 + node.inDegree * 1.4, 12, 48)` px（相对基准）
- **复杂度条** 颜色：`hsl(dir-hue, 62%, 58%)` → `hsl(dir-hue+40, 62%, 70%)`

### 状态

| 状态 | 样式 |
|------|------|
| 默认 | `border: 1px solid dirColor`，`border-left: 3px solid dirColor` |
| 选中 | `border: 2px solid colorPrimary`，`box-shadow: 0 0 0 3px primary/30` |
| 淡出 | `opacity: 0.12`（不在当前高亮集合内） |

### 文件类型图标（纯文字符号，无 emoji）

| 扩展名 | 图标字符 |
|--------|---------|
| `.tsx` | `[tsx]` |
| `.ts`  | `[ts]`  |
| `.rs`  | `[rs]`  |
| `.css` / `.scss` | `[css]` |
| `index.*` | `[idx]` |
| 其他 | `[...]` |

---

## 边类型视觉规范

| EdgeKind | 线型 | 颜色 | 宽度 |
|----------|------|------|------|
| `import-value` | 实线 | `#6b7280` | `log(weight)` |
| `import-type`  | 虚线（4,3） | `#818cf8` | 1 |
| `reexport`     | 实线粗 | `#34d399` | 3 |
| `dynamic`      | 点划线（8,3,1,3） | `#f59e0b` | 1.5 |
| `call`         | 实线 | `#38bdf8` | `log(weight)` |
| `circular`     | 虚线流动 + 脉冲发光 | `#ef4444` | 2.5 |

`circular` 边使用 ReactFlow 自定义 `EdgeComponent`，在 SVG `<path>` 上叠加：
- `stroke-dasharray: 6,4` + CSS `animation: march`（`stroke-dashoffset` 流动）
- CSS `animation: glow-pulse`（`drop-shadow` 0→7px 脉冲）
- 线 + 箭头同步动画

边宽通用公式：`Math.min(1 + Math.log2(weight + 1) * 0.5, 4)`

---

## 交互规范

### GraphToolbar 布局（左 → 右）

```
[搜索文件名…]  深度 [━●━━] 2  |  [import] [type] [re-exp] [lazy] [call] [循环]
```

- 边类型开关：激活态有对应颜色高亮边框，默认全开
- 深度滑块：仅在 `selected !== null` 且非路径模式时可用

### 搜索定位

1. 输入时实时过滤，命中节点加 ring 描边高亮
2. 单结果：`fitView` 居中，`padding: 0.6`
3. 多结果：命中节点高亮，其余淡出；点击某节点进入邻域模式
4. 清空：恢复全图

### N 跳邻域

- 选中节点后，深度滑块控制展开 1–4 跳（默认 1）
- `highlightSet` 由 BFS 从 `selected` 出发展开 `depth` 跳的节点集合

### 路径高亮（Path Mode）

```
Shift + 点节点 A  →  pathSource = A（工具栏显示"选择终点…"提示）
Shift + 点节点 B  →  pathTarget = B  →  BFS 查找所有简单路径（深度上限 10）
点空白 / Esc       →  退出路径模式
```

- 路径上的节点/边高亮，其余 `opacity: 0.08`
- 侧边栏显示路径条数 + 每条路径的文件序列（可点击跳转）
- 路径模式激活时，搜索框和深度滑块置灰

### 目录折叠（Cluster Mode）

- 工具栏「折叠分组」开关切换
- 折叠：每个顶层目录聚合为气泡节点（圆角矩形 + 虚线边框 + 文件数量），边权重为目录内汇总
- 双击气泡：展开该目录的文件级子图，其余目录保持折叠（`expandedDirs` 集合管理）
- 气泡节点使用 ReactFlow 自定义 `NodeType: 'cluster'`

### 模式优先级

```
路径模式 > 搜索高亮 > 邻域+深度 > 折叠视图
```

---

## useGraphState

```typescript
interface GraphState {
  searchQuery:  string
  selected:     string | null
  depth:        1 | 2 | 3 | 4
  pathSource:   string | null
  pathTarget:   string | null
  collapsed:    boolean
  expandedDirs: Set<string>
  visibleKinds: Set<EdgeKind>
}
```

### 节点点击转移

```
onNodeClick(id, shiftKey):
  if !shiftKey && pathSource == null  →  selected = id（邻域模式）
  if !shiftKey && id == selected       →  selected = null
  if shiftKey  && pathSource == null   →  pathSource = id
  if shiftKey  && pathSource != null   →  pathTarget = id（触发 BFS）

onPaneClick():
  selected = pathSource = pathTarget = null
```

### 派生计算（useMemo）

- `visibleNodes` — 由 searchQuery / depth / path / collapsed 派生
- `highlightSet` — 当前高亮节点 id 集合
- `pathEdges`    — BFS 结果中的边 id 集合

---

## 文件变更清单

| 文件（相对 `tauri-agent/src/`） | 操作 | 职责 |
|--------------------------------|------|------|
| `lib/codeGraphTypes.ts` | 新建 | GraphNode · GraphEdge · EdgeKind · RichGraph |
| `lib/codeGraphIo.ts` | 扩展 | 新增 `getRichGraph()`，FileGraph 标记 `@deprecated` |
| `lib/codeGraphLayout.ts` | 小改 | 接受 `GraphNode[]` |
| `lib/codeGraphPath.ts` | 新建 | `findPaths(graph, src, dst)` · `detectCycles(graph)` |
| `features/chat/input/workspace/useGraphState.ts` | 新建 | 所有交互状态 |
| `features/chat/input/workspace/GraphCanvas.tsx` | 新建 | ReactFlow 画布 + CircularEdge 自定义组件 |
| `features/chat/input/workspace/GraphToolbar.tsx` | 新建 | 搜索 · 深度 · 边类型开关 |
| `features/chat/input/workspace/GraphSidebar.tsx` | 新建 | 文件详情 · 路径列表（从 CodeGraphPanel 拆出） |
| `features/chat/input/workspace/CodeGraphPanel.tsx` | 重构 | 薄编排层，Modal 入口不变 |

---

## 范围外

- 符号级节点（函数/类）
- 替换 ReactFlow 为其他渲染库
- 5000+ 文件规模的性能优化
- 与 LSP 的类型引用集成
