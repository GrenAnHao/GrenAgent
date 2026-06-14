# Hermes UI 迁移到 Tauri-Agent 计划

## 目标

将新实现的 Hermes UI 架构迁移到现有的 `tauri-agent` 项目，替换旧的 UI 实现。

---

## 当前状态

### 已完成（hermes/ 目录）
- ✅ lib/types.ts - 类型定义
- ✅ lib/pi-rpc.ts - RPC 客户端
- ✅ store/messages.ts, session.ts, ui.ts - Zustand stores
- ✅ hooks/useRpcClient.ts - RPC 钩子
- ✅ features/chat/* - 聊天组件
- ✅ features/sessions/* - 会话组件
- ✅ features/tools/* - 工具组件
- ✅ App.tsx, main.tsx - 应用入口

### 现有（tauri-agent/src/ 目录）
- 旧的组件结构（components/）
- 旧的 lib/pi.ts（需要替换为 pi-rpc.ts）
- 旧的 stores/（需要替换为新的 store/）
- Tauri 后端（src-tauri/）- 保持不变

---

## 迁移步骤

### 阶段 1：备份和准备

1. **备份旧代码**
   ```bash
   cd tauri-agent
   git checkout -b backup-old-ui
   git add .
   git commit -m "backup: preserve old UI before Hermes migration"
   git checkout master
   git checkout -b feature/hermes-migration
   ```

2. **清理旧文件**（移动到备份目录，不删除）
   ```bash
   mkdir -p .backup/old-src
   cp -r src/* .backup/old-src/
   ```

### 阶段 2：迁移核心层

3. **迁移类型定义**
   ```bash
   cp ../hermes/src/lib/types.ts tauri-agent/src/lib/
   ```

4. **迁移 RPC 客户端**
   ```bash
   cp ../hermes/src/lib/pi-rpc.ts tauri-agent/src/lib/
   # 移除旧的 src/lib/pi.ts
   ```

5. **迁移 Store**
   ```bash
   rm -rf tauri-agent/src/stores
   mkdir -p tauri-agent/src/store
   cp ../hermes/src/store/* tauri-agent/src/store/
   ```

6. **迁移 Hooks**
   ```bash
   mkdir -p tauri-agent/src/hooks
   cp ../hermes/src/hooks/useRpcClient.ts tauri-agent/src/hooks/
   ```

### 阶段 3：迁移功能层

7. **迁移 Chat 组件**
   ```bash
   rm -rf tauri-agent/src/components/chat
   mkdir -p tauri-agent/src/features/chat
   cp ../hermes/src/features/chat/* tauri-agent/src/features/chat/
   ```

8. **迁移 Sessions 组件**
   ```bash
   rm -rf tauri-agent/src/components/sessions
   mkdir -p tauri-agent/src/features/sessions
   cp ../hermes/src/features/sessions/* tauri-agent/src/features/sessions/
   ```

9. **迁移 Tools 组件**
   ```bash
   mkdir -p tauri-agent/src/features/tools
   cp ../hermes/src/features/tools/* tauri-agent/src/features/tools/
   ```

### 阶段 4：迁移入口文件

10. **更新 App.tsx**
    ```bash
    cp ../hermes/src/App.tsx tauri-agent/src/
    ```

11. **更新 main.tsx**
    ```bash
    cp ../hermes/src/main.tsx tauri-agent/src/
    ```

12. **更新样式**
    ```bash
    cp ../hermes/src/index.css tauri-agent/src/
    ```

### 阶段 5：更新依赖

13. **更新 package.json**
    ```bash
    # 合并 hermes/package.json 的依赖到 tauri-agent/package.json
    ```

    需要添加的依赖：
    ```json
    {
      "dependencies": {
        "@lobehub/ui": "^5.15.13",
        "zustand": "^5.0.14",
        "lucide-react": "^1.17.0"
      }
    }
    ```

14. **安装依赖**
    ```bash
    cd tauri-agent
    pnpm install
    ```

### 阶段 6：Tauri 集成

15. **更新 Tauri 配置**（如果需要）
    - 检查 `src-tauri/tauri.conf.json`
    - 确保 `distDir` 和 `devPath` 正确

16. **测试 Tauri 构建**
    ```bash
    pnpm tauri dev
    ```

### 阶段 7：清理和验证

17. **移除旧组件目录**
    ```bash
    rm -rf tauri-agent/src/components
    rm -rf tauri-agent/src/providers
    rm -rf tauri-agent/src/utils（如果不需要）
    ```

18. **验证编译**
    ```bash
    pnpm run build
    pnpm tauri build
    ```

---

## 迁移检查清单

### 核心功能验证
- [ ] 应用启动无错误
- [ ] Tauri 窗口正常显示
- [ ] 聊天输入框可用
- [ ] 消息列表渲染正常
- [ ] 会话列表显示
- [ ] 会话创建/切换/删除功能
- [ ] 工具执行可视化

### Tauri 特定功能
- [ ] 窗口控制（最小化、最大化、关闭）
- [ ] 原生菜单
- [ ] 系统托盘（如果有）
- [ ] 快捷键（如果有）

### 保留功能（从旧 UI）
- [ ] 上下文面板（ContextPanel）- 需要重新集成
- [ ] 终端面板（TerminalPanel）- 需要重新集成
- [ ] 文件编辑器（FileEditor）- 需要重新集成
- [ ] 扩展 UI 对话框（ExtensionUiDialog）- 需要重新集成

---

## 需要保留的旧代码

以下组件需要从旧代码中保留并重新集成到 Hermes 架构：

1. **ContextPanel** - 上下文管理面板
2. **TerminalPanel** - 终端集成
3. **FileEditor** - 文件编辑
4. **ExtensionUiDialog** - 扩展 UI 对话框
5. **Tauri 特定代码** - 窗口控制、原生功能

---

## 快速迁移脚本

```bash
#!/bin/bash
# migrate-hermes.sh

set -e

echo "开始迁移 Hermes UI 到 tauri-agent..."

# 1. 备份
cd tauri-agent
git checkout -b backup-old-ui
git add .
git commit -m "backup: preserve old UI"
git checkout -b feature/hermes-migration

# 2. 清理并迁移
mkdir -p .backup/old-src
cp -r src/* .backup/old-src/

# 3. 迁移文件
cp -r ../hermes/src/lib tauri-agent/src/
cp -r ../hermes/src/store tauri-agent/src/
cp -r ../hermes/src/hooks tauri-agent/src/
cp -r ../hermes/src/features tauri-agent/src/
cp ../hermes/src/App.tsx tauri-agent/src/
cp ../hermes/src/main.tsx tauri-agent/src/
cp ../hermes/src/index.css tauri-agent/src/

# 4. 清理旧文件
rm -rf tauri-agent/src/components
rm -rf tauri-agent/src/stores
rm -rf tauri-agent/src/providers

# 5. 安装依赖
pnpm install

echo "迁移完成！请运行 'pnpm tauri dev' 测试。"
```

---

## 注意事项

1. **保留 Tauri 后端**：`src-tauri/` 目录完全不动
2. **保留有用的旧代码**：将 ContextPanel、TerminalPanel 等组件移到 `features/` 下
3. **合并依赖**：合并 package.json，不要覆盖 Tauri 相关依赖
4. **测试 Tauri 功能**：确保原生窗口、菜单等功能正常

---

## 下一步

迁移完成后，需要将旧 UI 中有价值的功能重新集成：

1. 上下文面板集成
2. 终端面板集成
3. 文件编辑器集成
4. 扩展 UI 完善

**要开始迁移吗？**
