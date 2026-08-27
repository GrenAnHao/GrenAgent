# Agent MCP 与 Skill 添加工具设计

## 背景

GrenAgent 已具备 MCP 连接管理、MCP 权限控制、全局 Skill 创建与导入，以及运行时资源热重载能力，但这些入口目前主要服务于桌面界面。Agent 没有结构化、可确认、可回滚的资源添加工具，只能依赖通用文件或命令工具间接修改配置。

本次为 Pi Sidecar 增加两个内置 Agent 工具：`add_mcp_server` 与 `add_skill`。它们复用现有 MCP Manager 和 Pi Skill 发现机制，使 Agent 能直接完成资源添加，同时保留明确的用户确认、安全校验与失败回滚。

## 目标

1. Agent 能通过结构化工具添加 MCP server 和本地 Skill。
2. MCP 支持全局和当前项目两种作用域。
3. Skill 支持内容创建、本地 Markdown 文件导入和本地目录导入。
4. 所有写入都必须经过独立的用户确认，自动批准模式不得绕过。
5. 同名资源默认拒绝；仅在显式传入 `replace: true` 并再次确认后覆盖。
6. MCP 探测失败不落盘；Skill 覆盖失败恢复旧版本。
7. 添加成功后尽量在当前会话热加载，不要求重启应用。
8. 现有桌面 MCP 设置、MCP 权限和 Skill 管理能力保持兼容。

## 非目标

- 不新增斜杠命令或新的聊天输入交互。
- 不支持从 URL、GitHub 或其他网络来源下载 Skill。
- 不实现 MCP 或 Skill 的自动更新。
- 不自动合并同名 Skill 内容。
- Skill 本期只安装到全局目录，不增加项目级 Skill 安装参数。
- 不改变 MCP 工具权限策略；新连接发现的工具继续由现有 `mcp-policy` 管理。

## 方案选择

### 采用：独立资源文件与 Sidecar 扩展

新增内置 `resource-manager` 扩展，由 Sidecar 直接管理 Pi 标准资源文件：

- 全局 MCP：`~/.pi/agent/mcp.json`
- 项目 MCP：`<workspace>/.pi/mcp.json`
- 全局 Skill：`~/.agents/skills/<name>/`

MCP Manager 将独立文件与现有桌面设置 `MCP_SERVERS` 合并。该方案同时适用于桌面 RPC 模式和 CLI 模式，不要求 Sidecar 直接修改 Tauri 私有状态。

### 未采用：Sidecar 到 Tauri 写入桥

该方案可直接修改现有桌面设置，但需要新增双向控制协议，且 CLI 模式不可用。对于两个资源添加工具，其复杂度和耦合度过高。

### 未采用：系统提示驱动通用文件工具

让 Agent 自行使用文件或命令工具写配置，无法稳定提供参数校验、冲突检测、强制确认和事务回滚，不构成可靠的系统能力。

## MCP 配置模型

两个独立文件均沿用通用的 `mcpServers` JSON 格式：

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "remote-service": {
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

为支持桌面面板启停独立文件中的 server，GrenAgent 允许同一文件带一个可选的
`disabledMcpServers` 顶层集合。启停操作只在 `mcpServers` 与
`disabledMcpServers` 之间移动条目；MCP Manager 仅连接 `mcpServers`。该扩展不改变
标准 `mcpServers` 的内容，其他客户端读取此文件时会自然忽略未知的顶层字段。

有效配置按以下优先级合并，后者覆盖前者：

1. 内置 MCP server。
2. 桌面设置注入的 `MCP_SERVERS`。
3. `~/.pi/agent/mcp.json`。
4. 当前工作区 `.pi/mcp.json`。

项目配置覆盖同名全局配置时，只形成作用域遮蔽，不修改或删除全局条目。确认界面和工具结果必须明确指出该行为。

若任一独立配置文件存在但 JSON 损坏，添加工具拒绝写入并返回具体文件路径；不得用新配置覆盖损坏文件。

## Agent 工具接口

### `add_mcp_server`

参数：

```ts
interface AddMcpServerInput {
  name: string;
  scope: "global" | "project";
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  replace?: boolean;
}
```

规则：

- `stdio` 必须提供非空 `command`，允许提供 `args`、`env` 和 `cwd`。
- `sse` 必须提供合法的 `http` 或 `https` URL，不接受 stdio 专属字段。
- `project` 必须能解析当前工作区；目标固定为该工作区的 `.pi/mcp.json`。
- 名称只能包含 ASCII 字母、数字、连字符、下划线和点，长度不超过 64。
- 同名资源存在时，`replace` 非 `true` 则拒绝。
- 在较高优先级作用域新增同名资源属于覆盖，也必须提供 `replace: true`。

成功结果包含 server 名称、作用域、配置路径、连接状态和探测得到的 MCP 工具全名。失败结果不得包含 `env` 的值。

### `add_skill`

参数：

```ts
interface AddSkillInput {
  name: string;
  source:
    | { type: "content"; content: string }
    | { type: "file"; path: string }
    | { type: "directory"; path: string };
  description?: string;
  replace?: boolean;
}
```

规则：

- `content` 已包含合法 frontmatter 时保留原文，否则根据 `name` 和 `description` 生成 frontmatter。
- `file` 必须是可读的本地 Markdown 文件，导入后命名为 `SKILL.md`；缺少 frontmatter 时按同样规则补齐。
- `directory` 的根目录必须包含 `SKILL.md`，整个目录连同资源文件一起复制；缺少 frontmatter 时按同样规则补齐。
- 已有 frontmatter 的 `name` 必须与工具参数 `name` 一致，否则拒绝导入；`description` 只用于补齐缺失的 frontmatter。
- 目标固定为 `~/.agents/skills/<name>`。
- 名称规则与现有 `create_skill` 保持一致。
- 拒绝路径穿越、递归导入目标自身、目标目录之外的覆盖和不受支持的文件类型。
- 同名目标存在时，`replace` 非 `true` 则拒绝。

成功结果包含 Skill 名称、安装路径和当前会话加载状态。

## 用户确认

两个工具在产生任何持久化写入前都必须调用交互确认。该确认是工具自身的强制关卡，不受全局自动审批或 Agent 模式设置影响。

MCP 确认信息包含：

- server 名称和作用域。
- 目标配置文件。
- 新增、覆盖或遮蔽状态。
- 完整启动命令和参数，或远程 URL。
- `env` 的键名，但不显示值。
- 项目配置含 `env` 时，提示该文件可能被版本控制收录。

Skill 确认信息包含：

- Skill 名称和目标目录。
- 来源类型和本地来源路径；内容创建不回显完整正文。
- 新增或覆盖状态。
- 目录导入时的文件数量。

用户取消时返回明确的取消结果，不探测 MCP、不切换 Skill 目录、不写入配置。

## 组件设计

新增 `extensions/resource-manager/`：

- `index.ts`：注册工具，组织参数校验、确认、执行和结果格式化。
- `mcp-store.ts`：读取配置层、检测冲突、调用 MCP 探测、更新目标 JSON。
- `skill-store.ts`：解析来源、建立暂存目录、校验和切换 Skill。
- `validation.ts`：资源名称、URL、路径和 frontmatter 的纯校验函数。

扩展加入 `extensions/index.ts` 的导出、`allExtensions` 和 `namedExtensions`。它属于基础资源能力，不应被普通 project profile 裁剪；受限的 conversation profile 不加载该扩展，避免无项目会话安装外部能力。

MCP Manager 扩展配置读取和监听逻辑：

- 继续监听 `PI_RUNTIME_CONFIG` 中的桌面设置。
- 新增全局与当前项目 `mcp.json` 的读取。
- 监听文件及其父目录，以处理首次创建、原子替换和删除。
- 配置差异继续交给现有 `diffServers` 完成连接、重连和关闭。
- 文件监听异常隔离，不影响现有 `MCP_SERVERS` 连接。

桌面 MCP 面板合并显示三个用户配置来源：桌面设置、全局文件和项目文件。每个条目标注来源；编辑和删除只修改对应来源，启停独立文件条目时只在该文件的 `mcpServers` 与 `disabledMcpServers` 间移动，不把独立文件条目写回 `MCP_SERVERS`。

## 数据流与事务

### MCP

1. 校验工具参数。
2. 读取并解析所有配置层。
3. 判断新增、同层覆盖或跨层遮蔽。
4. 请求用户确认。
5. 使用现有 MCP probe 能力临时连接并列出工具。
6. 探测成功后，在目标文件旁写入临时 JSON。
7. 保留其他 server 条目，原子替换目标文件。
8. MCP Manager 的文件监听触发差异更新。
9. 等待目标 server 进入 `connected` 或超时，返回最终状态和工具列表。

探测失败不写入。探测成功但运行时重连失败时，配置仍已持久化，结果明确标记为“已保存、当前连接失败”，不得虚报为已连接。

### Skill

1. 校验名称与来源。
2. 在全局 Skill 根目录下创建同文件系统的临时目录。
3. 写入内容或复制本地来源。
4. 校验暂存目录的 `SKILL.md`、frontmatter 和资源边界。
5. 请求用户确认。
6. 新增时将暂存目录改名为目标目录。
7. 覆盖时先将旧目录改名为备份，再把暂存目录切换为目标；失败则恢复备份。
8. 触发等效于 `PI_RELOAD_REV` 的当前会话资源重载。
9. 验证 Skill 已被 Pi 发现；成功后删除备份。

如果热重载失败，安装内容保留并返回“已安装、当前会话尚未加载”。文件切换失败则恢复旧目录并清理暂存内容。

## 安全边界

- 工具自身始终执行二次确认。
- MCP 环境变量值不得进入确认文案、工具结果或日志。
- MCP JSON 使用受限文件权限创建；支持的平台上全局文件权限设为仅当前用户可读写。
- 项目 MCP 文件可能进入版本控制；存在 `env` 时必须在确认中警告。
- Skill 来源仅限本地文件系统，本期不执行下载。
- 目录导入不跟随逃逸来源根目录的符号链接；遇到此类链接直接拒绝。
- 所有目标路径都从固定根目录与已校验名称构造，不接受调用方提供目标路径。
- 工具不改变 MCP 权限策略，新工具仍经过 `mcp-policy`。

## 错误处理

- 参数或安全校验失败：确认前返回字段级错误。
- 用户取消：返回取消状态，零持久化副作用。
- MCP 探测失败：返回截断后的连接错误或 stderr 摘要，不落盘。
- JSON 损坏：拒绝写入并返回文件路径。
- 原子写入失败：保留原配置文件。
- Skill 校验失败：清理暂存目录，保留原 Skill。
- Skill 覆盖切换失败：恢复备份；若恢复也失败，返回备份与目标的明确路径供人工处理。
- 热重载失败：区分“持久化成功”和“当前会话加载失败”。

## 测试

### 纯逻辑与存储测试

`validation.test.ts` 覆盖：

- MCP 名称、stdio/SSE 必填字段与 URL 协议。
- Skill 名称、路径穿越、递归导入和非法来源。

`mcp-store.test.ts` 覆盖：

- 配置层合并及优先级。
- 新增、显式覆盖和项目遮蔽全局。
- 损坏 JSON 拒绝写入。
- 探测失败零落盘。
- 原子更新保留其他 server。
- 环境变量值不出现在确认文案、结果和错误日志中。

`skill-store.test.ts` 覆盖：

- content 自动补 frontmatter。
- Markdown 文件和完整目录导入。
- 缺少 `SKILL.md`、逃逸符号链接和递归导入时拒绝。
- `replace: false` 拒绝同名。
- 覆盖成功、切换失败回滚及资源完整复制。

### 扩展与运行时测试

`index.test.ts` 覆盖：

- 两个工具正确注册。
- 未确认时零副作用。
- 自动批准模式不能绕过确认。
- 成功、取消和失败结果结构稳定。

MCP Manager 测试覆盖：

- 全局和项目文件首次创建、修改、原子替换及删除。
- 配置变化时正确连接、重连和关闭客户端。
- 文件监听失败不影响桌面设置来源。

桌面端测试覆盖：

- MCP 面板正确显示桌面、全局和项目三个来源。
- 修改、启停或删除只影响条目所属来源。

## 验收标准

1. Agent 能直接调用 `add_mcp_server` 和 `add_skill` 完成添加。
2. 所有操作在写入前强制确认。
3. MCP 支持全局与项目作用域，并在成功后向当前会话提供工具。
4. Skill 支持内容、文件和目录来源，并在当前会话热加载。
5. 只有 `replace: true` 才允许覆盖；失败时旧配置或旧 Skill 保持可用。
6. MCP 环境变量值不出现在确认、结果或日志中。
7. 现有 `MCP_SERVERS`、MCP 权限和 Skill 管理能力保持兼容。
8. 相关 TypeScript、Rust 和前端测试全部通过。
