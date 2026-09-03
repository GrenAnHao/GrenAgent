# Electron Mermaid 字体缩放修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 阻止 LobeHub 全局 `font-size-adjust` 改变 Electron Mermaid SVG 的文字尺寸，使文字和节点随 `viewBox` 同比例缩放。

**架构：** Electron 的 `Mermaid` 适配器继续使用 LobeHub Mermaid 和 `beautiful-mermaid`。图表框局部覆盖 `font-size-adjust: none`，SVG `<text>` 通过继承获得该值；全局主题和 Tauri 代码保持不变。

**技术栈：** React 19、TypeScript、antd-style、@lobehub/ui Mermaid、Vitest、Testing Library、Electron 38

---

## 文件结构

- 修改：`electron-agent/src/features/chat/Mermaid.test.tsx`，锁定图表框的局部字体调整行为。
- 修改：`electron-agent/src/features/chat/Mermaid.tsx`，在现有 `diagramFrame` 静态样式中关闭 `font-size-adjust`。

### 任务 1：局部字体调整回归测试和最小修复

**文件：**
- 修改：`electron-agent/src/features/chat/Mermaid.test.tsx:62`
- 修改：`electron-agent/src/features/chat/Mermaid.tsx:31`

- [ ] **步骤 1：编写失败的测试**

在 `keeps the full-featured LobeHub body...` 测试后添加：

```tsx
it('isolates SVG text from the global font-size adjustment', async () => {
  wrap(<Mermaid code={'flowchart TD\n  A[Long label]'} />);

  const component = await screen.findByTestId('lobehub-mermaid');
  const diagramFrame = component.parentElement?.parentElement;
  expect(diagramFrame).toBeTruthy();
  expect(window.getComputedStyle(diagramFrame!).fontSizeAdjust).toBe('none');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"
npm test -- src/features/chat/Mermaid.test.tsx
```

预期：新增测试失败；`fontSizeAdjust` 不是 `none`。其他 Mermaid 适配测试通过。

- [ ] **步骤 3：编写最少实现代码**

在 `Mermaid.tsx` 的 `diagramFrame` 样式中加入一条继承属性：

```tsx
diagramFrame: css`
  width: 100%;
  overflow: hidden;
  border: 1px solid ${cssVar.colorBorderSecondary};
  border-radius: 8px;
  background: ${cssVar.colorBgContainer};
  font-size-adjust: none;
  box-shadow:
    0 1px 0 -1px ${cssVar.colorBorder},
    0 1px 2px -0.5px ${cssVar.colorBorder},
    0 2px 2px -1px ${cssVar.colorBorderSecondary},
    0 3px 6px -4px ${cssVar.colorBorderSecondary};
`,
```

- [ ] **步骤 4：运行测试验证通过**

运行：

```powershell
npm test -- src/features/chat/Mermaid.test.tsx
```

预期：测试文件全部通过，输出中没有失败用例。

- [ ] **步骤 5：检查精确改动**

运行：

```powershell
git diff --check -- electron-agent/src/features/chat/Mermaid.tsx electron-agent/src/features/chat/Mermaid.test.tsx
git diff -- electron-agent/src/features/chat/Mermaid.tsx electron-agent/src/features/chat/Mermaid.test.tsx
```

预期：生产代码只新增 `font-size-adjust: none`；测试只新增一个回归用例，不覆盖用户已有的测试修改。

### 任务 2：构建和真实宽图验证

**文件：**
- 验证：`electron-agent/src/features/chat/Mermaid.tsx`
- 复现输入：`electron-agent/.mermaid-repro/diagram-0.mmd`

- [ ] **步骤 1：运行 Electron 构建**

运行：

```powershell
cd "D:\OneDrive\Project Files\Pi\electron-agent"
npm run build
```

预期：TypeScript 和 electron-vite 构建退出码为 `0`。

- [ ] **步骤 2：启动可检查的 Electron 开发实例**

运行：

```powershell
npx electron-vite --remoteDebuggingPort 9223 --clearScreen false
```

预期：终端输出 `DevTools listening`，并显示 renderer URL。若 `5173` 已占用，使用 electron-vite 自动选择的新端口。

- [ ] **步骤 3：通过 CDP 渲染宽图并测量**

连接 `http://127.0.0.1:9223`，在 renderer 页面动态导入 React、`react-dom/client` 和 `/src/features/chat/Mermaid.tsx`，使用 `electron-agent/.mermaid-repro/diagram-0.mmd` 的内容挂载 `Mermaid`。等待 SVG 出现后读取：

```js
const svg = document.querySelector('.ant-mermaid-mermaid svg');
const node = [...svg.querySelectorAll('g.node')]
  .find((group) => group.getAttribute('data-id') === 'A');
const rect = node.querySelector('rect').getBoundingClientRect();
const text = node.querySelector('text').getBoundingClientRect();
({
  fontSizeAdjust: getComputedStyle(node.querySelector('text')).fontSizeAdjust,
  nodeWidth: rect.width,
  textWidth: text.width,
});
```

预期：`fontSizeAdjust` 为 `none`，`textWidth <= nodeWidth`。修复前记录为节点约 `120.9px`、文字约 `305.5px`；修复后文字应约为 `113.3px`。

- [ ] **步骤 4：截取宽图并检查视觉结果**

通过 CDP 截取 Mermaid 图表区域。确认节点标签没有越过边框，标签之间没有重叠，图表框、工具栏和后续正文位置不变。

- [ ] **步骤 5：停止诊断实例并提交实现**

停止步骤 2 启动的 Electron 进程，然后运行：

```powershell
git add -- electron-agent/src/features/chat/Mermaid.tsx electron-agent/src/features/chat/Mermaid.test.tsx
git commit -m "fix: 修复 Electron Mermaid 文字缩放"
```

预期：提交仅包含 Electron Mermaid 实现和测试。
