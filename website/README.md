# GrenAgent 官网

独立静态官网，位于 `website/`，不参与 Electron 桌面应用构建。

## 本地预览

在仓库根目录执行：

```bash
cd website
python -m http.server 4173
```

打开 http://localhost:4173。

## 部署

将 `website/` 目录部署到任意静态托管服务即可。无需安装依赖、无需构建。

## 设计与内容约定

- 页面以中文为主，保留 GrenAgent、Electron、Pi SDK、CodeGraph、MCP、Skills、LSP、AST 等专有技术名词。
- 使用低饱和炭黑、暖灰与灰橄榄绿，不使用荧光绿或大面积发光效果。
- 代码关系图和工作区模块均为官网信息图示，不冒充真实桌面应用截图。
- 产品能力以仓库当前 Electron 主线 README 与 docs/architecture.md 为准。
- 本地优先不等于模型推理全部离线；模型调用依赖用户配置的供应商。
- 获取入口指向 GitHub，安装包状态以 Releases 实际发布情况为准。
