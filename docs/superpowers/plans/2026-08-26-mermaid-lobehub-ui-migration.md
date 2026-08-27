# Mermaid LobeHub UI 迁移实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将聊天 Mermaid 适配层迁移到 `@lobehub/ui` 的 Mermaid 渲染与预览机制，同时保留项目已有的修复、复制和错误处理能力，并升级兼容的直接 UI 依赖。

**架构：** `LazyMarkdown` 和代码分段协议保持不变；`Mermaid.tsx` 作为项目适配器，负责 sanitize、修复缓存、错误卡片和自定义导出动作，正常图表交给 LobeHub `Mermaid`。LobeHub 内部使用 `beautiful-mermaid` 生成 SVG，并通过 Ant Design Image 的显式 preview source 提供放大查看。

**技术栈：** React 19、`@lobehub/ui` Mermaid、Ant Design 6、antd-style、Vitest、Bun。

---

### 任务 1：锁定依赖版本并建立升级基线

**文件：**
- 修改：`tauri-agent/package.json`
- 修改：`tauri-agent/bun.lock`

- [ ] **步骤 1：记录当前依赖解析结果**

运行：

```powershell
cd tauri-agent
bun pm ls @lobehub/ui @lobehub/editor @lobehub/charts antd antd-style mermaid lucide-react motion zustand
```

预期：输出当前锁定版本，供升级后比较。

- [ ] **步骤 2：升级兼容直接依赖**

运行：

```powershell
bun add @lobehub/ui@latest @lobehub/editor@latest antd@latest mermaid@latest lucide-react@latest zustand@latest
```

保持 `react`、`react-dom` 和 `overrides` 不变；暂不升级 `motion`，因为它存在 12→13 主版本变化。

- [ ] **步骤 3：验证锁文件无重复 React**

运行：

```powershell
rg -n 'react@|react-dom@' tauri-agent/bun.lock
```

预期：根依赖与 peer 解析均归一到 `19.2.8`，没有由升级引入的第二份 React 实例。

- [ ] **步骤 4：提交依赖升级**

```powershell
git add tauri-agent/package.json tauri-agent/bun.lock
git commit -m "chore: update UI dependencies for Mermaid"
```

### 任务 2：建立 Mermaid 适配器测试边界

**文件：**
- 创建：`tauri-agent/src/features/chat/Mermaid.test.tsx`
- 修改：`tauri-agent/src/features/chat/Mermaid.tsx`

- [ ] **步骤 1：编写失败测试**

测试至少覆盖：

```tsx
it('passes sanitized code to the LobeHub Mermaid component', () => {
  render(<Mermaid code={'flowchart TD\n A -->|x{1}| B'} />);
  expect(screen.getByTestId('lobehub-mermaid')).toHaveTextContent('flowchart TD');
  expect(screen.getByTestId('lobehub-mermaid')).toHaveTextContent('"x{1}"');
});

it('renders the project error card when the renderer reports an error', () => {
  render(<Mermaid code={'invalid diagram'} />);
  expect(screen.getByText('Mermaid 图表渲染失败')).toBeInTheDocument();
});
```

Mock `@lobehub/ui` Mermaid only at the adapter boundary; do not mock sanitize, fix store, or the AI request path.

- [ ] **步骤 2：运行测试确认失败**

```powershell
cd tauri-agent
bunx vitest run src/features/chat/Mermaid.test.tsx
```

预期：因适配器尚未输出 `@lobehub/ui` Mermaid 而失败。

### 任务 3：迁移正常渲染和官方放大预览

**文件：**
- 修改：`tauri-agent/src/features/chat/Mermaid.tsx`
- 修改：`tauri-agent/src/features/chat/LazyMarkdown.tsx`（仅在接口需要时）

- [ ] **步骤 1：保留现有入口和数据流**

保持导出接口：

```tsx
export const Mermaid = memo(({ code, streaming }: { code: string; streaming?: boolean }) => ...);
```

继续按 `mermaidFixStore` 读取修复代码，并在交给组件前执行 `sanitizeMermaidCode`。

- [ ] **步骤 2：接入 LobeHub Mermaid**

正常分支使用：

```tsx
<MermaidUI
  fullFeatured
  copyable={false}
  defaultExpand
  actionsRender={renderActions}
  theme={theme.isDarkMode ? 'zinc-dark' : 'zinc-light'}
>
  {sanitizedSource}
</MermaidUI>
```

不要再手动维护隐藏 `Image` preview；LobeHub 组件内部负责 SVG Blob、preview source 和 URL 释放。

- [ ] **步骤 3：保留流式体验**

流式期间只在完整 fenced block 交给 Mermaid，继续由 `splitMermaid` 处理未闭合代码块；`streaming` 只用于降低昂贵的导出动作，不改变 Mermaid 源码。

- [ ] **步骤 4：运行适配器测试**

```powershell
bunx vitest run src/features/chat/Mermaid.test.tsx src/features/chat/splitMermaid.test.ts
```

预期：正常渲染、清洗和官方预览相关测试通过。

### 任务 4：接回项目导出、修复和错误卡片

**文件：**
- 修改：`tauri-agent/src/features/chat/Mermaid.tsx`
- 修改：`tauri-agent/src/stores/mermaidFixStore.ts`（仅在类型适配需要时）
- 修改：`tauri-agent/src/lib/pi.ts`（不改变命令签名）

- [ ] **步骤 1：通过 `actionsRender` 保留复制菜单**

动作菜单继续提供复制 PNG、复制 SVG、复制 Mermaid 源码。PNG/SVG 导出使用当前 `svgToPngBlob`、`svgWithPixelSize` 逻辑；复制按钮由 LobeHub 提供源码复制能力时关闭重复按钮。

- [ ] **步骤 2：保留自动修复和 AI 修复**

`autoFixMermaid` 和 `pi.fixMermaid` 仍由适配器调用；成功修复后写入 `useMermaidFixStore.getState().setFix(code, fixed, ai)`，通过 source 变化触发 LobeHub 重新渲染。

- [ ] **步骤 3：保留错误卡片**

适配器捕获 LobeHub 渲染错误，显示现有错误标题、源码、复制代码和 AI 修复按钮；错误不得冒泡到消息列表边界。

- [ ] **步骤 4：补齐错误和导出测试**

```tsx
it('keeps AI fix action available when a workspace is present', ...);
it('renders copy actions without mounting a second preview image', ...);
```

### 任务 5：覆盖图表类型和依赖升级回归

**文件：**
- 修改：`tauri-agent/src/features/chat/Mermaid.test.tsx`
- 修改：`tauri-agent/src/features/chat/mermaidAutofix.test.ts`
- 修改：`tauri-agent/src/features/chat/sanitizeMermaid.test.ts`

- [ ] **步骤 1：加入图表类型样本**

为 flowchart、sequenceDiagram、stateDiagram-v2、classDiagram、erDiagram、xychart-beta、gantt、pie、mindmap、timeline 分别加入渲染样本；不支持的类型断言错误卡片而非整条消息崩溃。

- [ ] **步骤 2：运行 Mermaid 相关完整测试**

```powershell
cd tauri-agent
bunx vitest run src/features/chat/Mermaid.test.tsx src/features/chat/mermaidAutofix.test.ts src/features/chat/sanitizeMermaid.test.ts src/features/chat/splitMermaid.test.ts
```

- [ ] **步骤 3：验证类型和构建**

```powershell
bunx tsc --noEmit
bun run build
```

预期：类型检查和 Vite 构建通过。

- [ ] **步骤 4：单独验证 motion 主版本**

在独立工作树执行 `bun add motion@latest`，运行同一组类型检查、Mermaid 测试和构建；若失败，恢复 `motion@^12.43.0`，不要把主版本升级混入 Mermaid 迁移提交。

- [ ] **步骤 5：运行完整测试并记录已知环境失败**

```powershell
bun run test
```

确认 Mermaid 相关测试通过；若已有 TencentDB 测试仍因环境超时失败，记录具体失败用例和原因，不将其误判为 Mermaid 回归。

### 任务 6：最终提交与工作区核对

**文件：**
- 修改：本计划涉及的全部文件

- [ ] **步骤 1：检查冲突标记和空白错误**

```powershell
git diff --check
rg -n '<<<<<<<|=======|>>>>>>>' tauri-agent/src/features/chat tauri-agent/package.json
```

- [ ] **步骤 2：确认用户未提交修改仍未被纳入**

```powershell
git status --short
git diff --name-only
```

预期：仅本次 Mermaid/依赖文件已提交，用户原有修改仍以工作区改动存在。

- [ ] **步骤 3：提交实现**

```powershell
git add tauri-agent docs/superpowers/plans/2026-08-26-mermaid-lobehub-ui-migration.md
git commit -m "feat: use LobeHub Mermaid preview"
```

