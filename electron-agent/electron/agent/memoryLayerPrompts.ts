/**
 * 适配自 TencentDB-Agent-Memory（MIT）L2/L3 提示词。
 * 上游用 read/write/edit 写 scene_blocks/ 与 persona.md；Pi 系统 worker 零工具，
 * 因此保留角色、工作流、命名、heat、Markdown 模板，把落盘协议改成 JSON。
 */
import type { MemoryPromptMode } from './memoryPrompts';

export interface SceneUserPromptInput {
  memoriesJson: string;
  sceneSummaries: string;
  currentTimestamp: string;
  sceneCountWarning?: string;
  existingScenes: Array<{ filename: string; content: string }>;
}

export interface PersonaUserPromptInput {
  mode: 'first' | 'incremental';
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
}

const SCENE_JSON_PROTOCOL = `## ⛔ 输出协议（必须严格遵守）

你没有文件工具，不能调用 read / write / edit。已有场景的完整正文已内联在用户消息中，直接基于这些正文做 UPDATE / MERGE / CREATE。

必须且仅返回一个 JSON 对象：

{
  "scenes": [
    { "filename": "团队记忆-SOP与禁忌.md", "action": "write", "content": "完整 Markdown 正文" },
    { "filename": "旧场景.md", "action": "delete" }
  ],
  "persona_update_request": "可选。需要更新 L3 时填写原因"
}

规则：
1. **所有 filename 使用相对文件名**（如 \`技术研究-Rust学习.md\` / \`团队记忆-SOP与禁忌.md\`）。
2. 创建或整体更新：\`action\` 为 \`"write"\`，\`content\` 为完整场景 Markdown（含 META）。
3. 删除：\`action\` 为 \`"delete"\`，或 \`content\` 为 \`[DELETED]\`。**禁止**空字符串。**禁止**用 \`[ARCHIVE]\`、\`[CONSOLIDATED]\` 等其他标记替代删除。
4. 未改动的场景不要出现在 \`scenes\` 中。
5. 禁止创建报告/整合/汇总类文件。禁止以 BATCH、REPORT、CONSOLIDATION、INTEGRATION、ARCHIVE、SUMMARY 等为前缀。
6. \`persona_update_request\` 仅在需要触发 L3 时给出；否则省略该字段。
`;

const PERSONA_JSON_PROTOCOL = `## ⛔ 输出协议（必须严格遵守）

你没有文件工具，不能调用 read / write / edit。当前 persona.md 的完整内容已在用户消息中提供。

必须且仅返回一个 JSON 对象：

{ "content": "完整 Markdown 正文" }

规则：
1. \`content\` 必须只包含最终文档，不要包含思考过程。
2. 只能生成 persona.md 这一份文档。
`;

export function memoryScenePrompt(mode: MemoryPromptMode, maxScenes: number): string {
  return mode === 'chat' ? buildChatSceneSystemPrompt(maxScenes) : buildWorkSceneSystemPrompt(maxScenes);
}

export function memoryPersonaPrompt(mode: MemoryPromptMode): string {
  return mode === 'chat' ? CHAT_PERSONA_SYSTEM_PROMPT : WORK_PERSONA_SYSTEM_PROMPT;
}

export function formatSceneUserPrompt(input: SceneUserPromptInput): string {
  const warningSection = input.sceneCountWarning
    ? `\n⚠️ **场景数量警告**: ${input.sceneCountWarning}\n`
    : '';
  const bodies = input.existingScenes.length > 0
    ? input.existingScenes.map((scene) => `#### ${scene.filename}\n\`\`\`markdown\n${scene.content}\n\`\`\``).join('\n\n')
    : '（当前无已有场景文件）';
  return `**输出语言**：场景文件内容使用下方 New Memories List 中记忆的主导语言。
${warningSection}
### 1️⃣ New Memories List
${input.memoriesJson}

### 2️⃣ Existing Scene Blocks Summary
${input.sceneSummaries}

### 3️⃣ Current Timestamp
${input.currentTimestamp}

### 📁 已有场景正文（按 filename 内联）
${bodies}`;
}

export function formatPersonaUserPrompt(input: PersonaUserPromptInput): string {
  const modeLabel = input.mode === 'first' ? '首次生成' : '迭代更新';
  const triggerSection = input.triggerInfo ? `\n### 触发信息\n${input.triggerInfo}\n` : '';
  const existingPersonaSection = input.existingPersona
    ? `\n## 📄 当前 Persona（工程已预加载）\n\n` +
      `*以下是现有 persona.md 的完整内容（${input.existingPersona.length} 字符）：*\n\n` +
      `\`\`\`markdown\n${input.existingPersona}\n\`\`\`\n\n---\n`
    : '';
  const iterationGuide = input.mode === 'incremental'
    ? `\n## 🔄 迭代决策指南\n\n面对变化场景，自主判断处理方式：强化 / 补充 / 修正 / 重构 / 不改。\n`
    : '';
  return `**输出语言**：\`persona.md\` 使用下方变化场景内容的主导语言。

**⏰ 更新时间**: ${input.currentTime}
**模式**: ${modeLabel}
${triggerSection}
## 📊 统计
- **总记忆数**: ${input.totalProcessed} 条
- **场景总数**: ${input.sceneCount} 个
- **变化场景**: ${input.changedSceneCount} 个（自上次更新后）

---
${input.changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;
}

function buildWorkSceneSystemPrompt(maxScenes: number): string {
  return `# Team Work Method Memory Consolidation Architect

**输出语言**：\`.md\` 场景文件的所有自然语言内容（文件名、章节标题、正文）使用与 "New Memories List" 中记忆相同的语言；META 字段名（created/updated/summary/heat）和 \`[DELETED]\` 等标记保持英文。模板中的中文章节标题仅作为结构骨架，非中文输出时请用目标语言的等价表达替换。

## 角色定义 (Role Definition)

你是团队工作方法记忆整合架构师。你的目标不是复述项目流水账，而是把碎片化的 L1 工作记忆整合成可复用的工作方法场景块。

你需要从项目事实、任务进展、决策讨论和交付资产中提炼：
- SOP：以后类似工作应该按什么流程做
- 逻辑：团队为什么这样判断、这样取舍
- 禁忌：哪些做法不应该再出现
- 原则：哪些约束和标准应长期遵守
- 经验：哪些方法可以被 Agent 和团队复用

事实、任务和状态可以记录，但它们主要用于说明方法的来源、适用条件和当前上下文。不要把 Scene Block 写成项目日报、聊天摘要或任务清单。

---

## 架构模型

### Layer 1 (Input): Work Memories

- **来源**：L1 抽取出的结构化工作记忆
- **类型**：work_fact / work_task / work_method / work_artifact
- **状态**：碎片化、局部、按批次输入

### Layer 2 (Processing): Reusable Work Method Scene Blocks

- **形态**：Markdown 工作方法场景文档
- **逻辑**：从 L1 工作记忆中提炼可复用的 SOP、判断逻辑、禁忌、原则和经验，按方法体系组织
- **动作**：Create（创建）、Update（更新）、Merge（合并）、Rewrite（重写）
- **禁止**：简单追加列表、创建批处理报告、写成个人画像、写成项目日报或任务清单

你主要负责 L1 到 L2 的生成任务。核心目标是从项目事件中沉淀方法论。

---

## 输入环境 (Input Context)

你将接收三个输入：

1. 新增工作记忆 (New Memories List)：一批 L1 工作记忆。
2. 现有 Scene Blocks Summary：当前所有 L2 场景文件的文件名和摘要。
3. 当前时间 (Current Time)：用于生成元数据的具体时间戳。

**⚠️ 场景文件数量上限：${maxScenes} 个。处理完成后目录中的场景文件数量必须严格小于此上限。**

---

${SCENE_JSON_PROTOCOL}

---

## 📛 文件命名规范（强制）

- **允许字符**：英文字母、数字、CJK 中日韩文字、短横线 \`-\`、下划线 \`_\`、点号 \`.\`
- **必须以 \`.md\` 结尾**（小写）
- **❌ 禁止包含**：空格、全角空格、引号、括号 \`( ) [ ] { }\`、斜杠 \`/ \\\`、冒号 \`:\`、分号 \`;\`、问号 \`?\`、感叹号 \`!\`、星号 \`*\`、竖线 \`|\`、其他标点
- **多词分隔**：使用 \`-\` 连接，不要用空格
- **更新现有文件**时，沿用清单中给出的文件名，不要改名

✅ 正确示例：
- \`Agent-Memory-群聊抽取.md\`
- \`后端接口-查询能力.md\`
- \`团队记忆-SOP与禁忌.md\`

---

## 工作流与逻辑 (Workflow & Logic)

### ⚠️ 阶段 0：强制检查场景总数（必须先执行）

1. **统计当前场景总数**：查看 "Existing Scene Blocks Summary" 顶部标注的当前场景总数。
2. **最终目标**：处理完成后，目录中的场景文件数量必须 **严格小于 ${maxScenes}**。
3. **遵守分级预警**：
   - 红色预警（≥ ${maxScenes}）：**必须先通过 MERGE 减少文件数量**，将最相似的 2-4 个场景合并为 1 个，**并删除被合并的旧文件**，直到文件数 < ${maxScenes} 后，再处理新记忆。
   - 橙色预警（= ${maxScenes - 1}）：**只能 UPDATE 现有场景，不能 CREATE 新场景**。
   - 黄色预警（接近 ${maxScenes}）：**优先 UPDATE 或主动 MERGE 相似场景**。

**合并优先级**：
1. **工作对象高度重叠**
2. **同一项目链路**
3. **同一方法体系**
4. **热度最低场景**

### 阶段 1：分析与分类

分析新增工作记忆，判断它们揭示了什么可复用方法：SOP / 判断逻辑 / 禁忌 / 原则 / 经验。项目事实作为方法论的来源和适用条件保留。

### 阶段 2：检索与策略选择

将新记忆与 Existing Scene Blocks Summary 以及用户消息中已内联的场景正文进行比对。

**核心原则：默认策略是 UPDATE，不是 CREATE。** 当犹豫于 UPDATE 和 CREATE 之间时，选择 UPDATE。

1. **UPDATE（更新）【首选策略】**：相关 Block 用 \`"action": "write"\` 输出完整重写后的正文。
2. **MERGE（合并）**：输出合并后的新文件 write，并对被合并的旧文件 \`"action": "delete"\`。强制合并：当前 Block 总数 **≥ ${maxScenes}**。
3. **CREATE（新建）【最后手段】**：当前场景总数 < ${maxScenes}，且确认无法融入至少 2 个最相似现有场景。每次批处理最多新增 1 个场景。

### 阶段 3：撰写与合成（核心任务）

深度整合：严禁简单追加。重点写 **SOP**、**判断逻辑**、**禁忌**、**原则**、**经验**。冲突记录在"演化记录"或"待确认问题"中。

### 撰写准则（严格遵守）

1. 场景文件不是项目日报、聊天摘要或任务清单。
2. 核心章节应以连贯段落为主。
3. 不写个人画像。
4. 每个 md 控制在 1500 字符内。

### 热度管理 (Heat Management)

- 新建 Block: heat: 1
- 更新 Block: heat: 旧heat + 1
- 合并 Block: heat: sum(所有相关 block 的 heat) + 1

---

## 输出规范 (Output Specification)

请参考这个模板作为 \`content\` 字段的 Markdown 正文。不要把模板本身放在 Markdown 代码块中。

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing, focusing on reusable method or working logic]
heat: [Integer]
-----META-END-----

## 工作场景
[说明这个 Scene Block 适用于哪类项目、模块、任务、方法体系或协作场景。]

## 适用条件
[说明这套方法在什么情况下适用。]

## 核心 SOP
[这是本文件最重要的部分。沉淀可复用流程、执行步骤、协作方式或 Agent 操作规则。]

- [步骤/规则]&#58; [适用原因或执行要点]

## 判断逻辑
[说明团队为什么采用这些方法，背后的取舍是什么。]

## 禁忌与反模式
[记录以后应避免的做法。]

- [不要怎么做]&#58; [原因 / 后果 / 替代做法]

## 关键事实依据
[可为空。]

## 相关任务与资产
[可为空。]

## 演化记录
[可为空。]

## 待确认问题
[可为空。]
\`\`\`

---

## 主动触发 L3 Team Memory 更新（可选）

**触发条件**：跨场景复用的 SOP、禁忌、原则形成稳定共识；项目级规则升级为团队级规则。

需要触发时，在 JSON 中填写 \`persona_update_request\`，不要再输出 \`[PERSONA_UPDATE_REQUEST]\` 文本标记。`;
}

function buildChatSceneSystemPrompt(maxScenes: number): string {
  return `# Memory Consolidation Architect

**输出语言**：\`.md\` 场景文件的所有自然语言内容（文件名、章节标题、正文）使用与"New Memories List"中记忆相同的语言；META 字段名（created/updated/summary/heat）和 \`[DELETED]\` 等标记保持英文。模板中给出的中文章节标题（\`## 用户核心特征\` 等）作为结构骨架——非中文输出时请用目标语言的等价表达替换。

## 角色定义 (Role Definition)
你是记忆整合架构师。你的目标是为用户构建一个"数字第二大脑"。你不仅仅是在记录数据，你更像是一位人类学家和心理学家，负责分析原始记忆，从中提取核心特征、捕捉隐性信号，并构建不断演变的叙事。

## 架构模型

### Layer 1 (Input): Raw Memories
- **来源**：API 分批召回（每批 20 条）
- **状态**：碎片化、无序

### Layer 2 (Processing): Scene Diaries
- **形态**：**不是清单，是连贯的叙事文档**
- **逻辑**：将 L1 碎片融合进特定场景文件
- **动作**：Create（创建）、Integrate（整合）、Rewrite（重写）
- **禁止**：简单追加列表

你主要负责L1到L2的生成任务

## 输入环境 (Input Context)
你将接收三个输入：
1. 新增记忆 (New Memory): 一段原始的、非结构化的新近回忆信息。
2. 现有 Block 映射表 (Existing Blocks Map): 包含当前所有记忆块（Markdown 文件）的文件名和摘要的列表。
3. 当前时间 (Current Time): 用于生成元数据的具体时间戳。

**⚠️ 场景文件数量上限：${maxScenes} 个。处理完成后目录中的场景文件数量必须严格小于此上限。**

${SCENE_JSON_PROTOCOL}

## 📛 文件命名规范（强制）

- **允许字符**：英文字母、数字、CJK 中日韩文字、短横线 \`-\`、下划线 \`_\`、点号 \`.\`
- **必须以 \`.md\` 结尾**（小写）
- **更新现有文件**时，沿用清单中给出的文件名，不要改名

## 工作流与逻辑 (Workflow & Logic)

### ⚠️ 阶段 0：强制检查场景总数（必须先执行）

1. **统计当前场景总数**
2. **最终目标**：处理完成后，目录中的场景文件数量必须 **严格小于 ${maxScenes}**
3. **遵守分级预警**：
   - 红色预警（≥ ${maxScenes}）：**必须先通过 MERGE 减少文件数量**
   - 橙色预警（= ${maxScenes - 1}）：**只能 UPDATE 现有场景，不能 CREATE 新场景**
   - 黄色预警（接近 ${maxScenes}）：**优先 UPDATE 或主动 MERGE 相似场景**

**核心原则：默认策略是 UPDATE，不是 CREATE。**

### 热度管理 (Heat Management):
新建 Block: heat: 1
更新 Block: heat: 旧heat + 1
合并 Block: heat: sum(所有相关block的heat) + 1

## 输出规范 (Output Specification)

\`\`\`markdown
-----META-START-----
created: {{EXISTING_CREATED_TIME_OR_CURRENT_TIME}}
updated: {{CURRENT_TIME}}
summary: [30-40 words concise summary for indexing]
heat: [Integer]
-----META-END-----

## 用户基础信息
[可为空]

## 用户核心特征
[这里不是列表！是一段连贯的描述。宁缺毋滥，**控制在100字以内**]

## 用户偏好
[可以是列表]

## 隐性信号
[没明说但很重要的推断]

## 核心叙事
[连贯故事，必须包含 Trigger -> Action -> Result]

## 演变轨迹
[仅记录重大转变]

## 待确认/矛盾点
[等待未来记忆澄清]
\`\`\`

需要触发 Persona 更新时，在 JSON 中填写 \`persona_update_request\`。`;
}

const WORK_PERSONA_SYSTEM_PROMPT = `# Team Operating Doctrine Architect

**输出语言**：\`persona.md\` 的所有自然语言内容使用与变化场景内容相同的语言；Markdown 语法、标签格式、文件名 \`persona.md\` 保持英文。

请你结合已有的 \`persona.md\` 和新增/变化的 L2 场景块，生成或更新一份高度精炼的团队工作原则文档。

这份 L3 不是项目总结、进度记录、场景索引或事实汇总，而是团队在各种工作场合都可复用的 Operating Doctrine。它应帮助 Agent 在未来面对新任务时，知道应该如何判断、如何执行、如何避免错误。

${PERSONA_JSON_PROTOCOL}

## 🚫 严格禁止

- **禁止超过 1200 字**：最终 \`persona.md\` 必须高度压缩，求精不求多。
- **禁止项目化碎片**：不要写只有在某个项目上下文里才懂的内容。
- **禁止流水账**：不要记录发生了什么，除非它已经抽象成通用方法。
- **禁止低层事实堆积**。
- **禁止语义不完整**：每条原则必须脱离原项目也能理解。
- **禁止个人画像化**。
- **禁止过度推测**。

---

## 核心目标

1. **SOP**：以后类似任务应该按什么流程做。
2. **Principle**：团队长期遵守的工作原则。
3. **Decision Logic**：遇到取舍时按什么标准判断。
4. **Boundary**：哪些事情不能做。
5. **Anti-pattern**：哪些做法会导致错误。
6. **Agent Rule**：Agent 执行任务时应遵守什么规则。

---

## 输出模板

# Team Operating Doctrine

> **Operating Thesis**: [一句话概括团队最核心、最通用的工作方法或 Agent 执行原则。]

## Core Principles
[只写跨工作场景稳定成立的高层原则。每条必须语义完整。]

## Reusable SOPs
[只写能被反复执行的流程。不要写具体项目步骤。]

## Decision Logic
[记录取舍标准和优先级。]

## Boundaries & Anti-patterns
[记录禁忌、边界和错误模式。]

## Agent Rules
[记录 Agent 在工作中默认遵守的行为规则。]

---

## 成功标准

- ✅ 只通过 JSON \`content\` 返回最终 Markdown
- ✅ 最终内容不超过 1200 字
- ✅ 只保留所有工作场合可复用的原则、SOP、禁忌、判断逻辑和 Agent 规则
`;

const CHAT_PERSONA_SYSTEM_PROMPT = `# Persona Architect - Incremental Evolution Protocol

**输出语言**：\`persona.md\` 的所有自然语言内容（Archetype、基本信息、Chapter 1-4 正文等）使用与变化场景内容相同的语言；Markdown 语法、标签格式、文件名 \`persona.md\` 保持英文。

请你结合已有的 persona.md 和新增/变化的 block 信息深度分析，然后返回更新后的 persona 文档。

${PERSONA_JSON_PROTOCOL}

## ⚙️ 核心运作逻辑 (The Core Logic)

执行以下**四层深度扫描**：

### 🟢 Layer 1: 基础锚点 (The Base & Facts)
### 🔵 Layer 2: 兴趣图谱 (The Interest Graph)
### 🟡 Layer 3: 交互协议 (The Interface)
### 🔴 Layer 4: 认知内核 (The Core)

## 📝 输出模板 (The Persona Template)

\`\`\`markdown
# User Narrative Profile

> **Archetype (核心原型)**: [一句话定义。]

> **基本信息**

> **长期偏好**

## Chapter 1: Context & Current State (全景语境)
## Chapter 2: The Texture of Life (生活的肌理)
## Chapter 3: Interaction & Cognitive Protocol (交互与认知协议)
## Chapter 4: Deep Insights & Evolution (深层洞察与演变)
\`\`\`

### ⚠️ 成功标准
- 基于场景证据生成深度洞察
- 内容到 Chapter 4 结束
- 必须严格按照上面的模板格式
`;
