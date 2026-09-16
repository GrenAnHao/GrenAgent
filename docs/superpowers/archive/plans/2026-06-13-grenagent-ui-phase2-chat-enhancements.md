# GrenAgent UI 第 2 期：对话增强（工具卡片 + 自动注入提示条 + 输入区快捷）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在现有「对话」模块里，为 8 个 extension 的工具调用提供专用结果卡片（kb_search/kb_add/memory_save/memory_recall/generate_image/spawn_agent/fetch_url/speak），把 knowledge-rag / long-term-memory 的自动注入消息渲染为轻量提示条，并在输入区加「加入知识库 / 生图 / 朗读」快捷按钮。

**架构：**
- 工具卡片：沿用现有 `ToolExecution`（`Collapse` 折叠 + `ToolInspector` 头部 + `ToolDetail` 详情）机制。新增「**注册表分派**」`features/tools/extensionCards.tsx`（`toolName → 卡片组件` 的 `Record` map + `renderExtensionCard()`，借鉴 lobehub `getBuiltinRender` 但极简），在 `ToolDetail` 顶部命中即用 `ErrorBoundary` 包裹返回，否则回退现有逻辑。卡片只读取已确认的 `result.details` 字段 + `extractText(result)`，**不新增任何 RPC/协议**。
- 自动注入提示条：注入消息是 pi 的 `CustomMessage`（`role:'custom'`、`customType:'knowledge-rag'|'long-term-memory'`、`content:string`、`display:true`）。在 `agentReducer` 新增 `notice` 消息类型并在 `message_start`/`message_end`/`messagesFromAgent` 三处识别（按 `content` 去重），`MessageList` 用新 `NoticePill`（lucide `Sparkles` + 标题 + 可折叠 markdown）渲染。
- 输入区快捷：沿用 `actionMap` 注册表 + `useChatInput().setValue` 预填指令文本（用户可编辑后发送），不直接调工具。

**技术栈：** React 19、zustand、`@lobehub/ui`（`Flexbox`/`Icon`/`Collapse`/`ActionIcon`）、antd-style、lucide-react、`@tauri-apps/plugin-opener`（`openPath`，已在 `Sidebar.tsx` 使用）、vitest + @testing-library/react（**未开 `globals`、无自动 cleanup**，测试需显式从 `vitest` import 并手动 `afterEach(cleanup)`）。

---

## 范围

仅第 2 期（对话增强）。完成后：8 类工具调用在对话流里有专用卡片；知识/记忆自动注入显示为提示条；输入区多三个快捷按钮。**不含**知识库/记忆/审查/创作/连接/设置等管理面板（后续期）。可独立运行与测试。

**前置事实（已核实）**
- 工具 `result` 统一形如 `{ content:[{type:'text',text}], details:{...} }`。各 `details` 字段：
  - `kb_search`：`{ mode:'semantic'|'keyword', hits:[{source,score}] }`（命中全文在 `content` text）
  - `kb_add`：`{ source, chunks, embedded }`
  - `memory_save`：`{ id, scope:'project'|'global', category, embedded }`
  - `memory_recall`：`{ hits:[{id,scope,score}] }`（召回全文在 `content` text）
  - `generate_image`：`{ path, bytes, model, size }`
  - `spawn_agent`：`{ exitCode }`（单任务）或 `{ count, failed }`（多任务）；输出在 `content` text
  - `fetch_url`：`{ url, status, contentType, chars, truncated }`（正文在 `content` text）
  - `speak`：`{ path, bytes, voice, model, format }`
- 注入消息（`CustomMessage`）当前被 reducer 三处 `role!=='assistant'` 丢弃。
- 现有可复用：`features/tools/toolUtils.ts`（`extractText`/`getArgString`/`toolMeta`/`stringifyJson`）、`features/chat/LazyMarkdown.tsx`、`features/tools/StatusIndicator.tsx`、`features/chat/input/ChatInputContext.tsx`（`useChatInput().setValue`）。

## 文件结构

- 修改 `tauri-agent/src/features/tools/toolUtils.ts` — `toolMeta` 增 7 个工具图标；新增 `getDetails()`
- 修改 `tauri-agent/src/features/tools/toolUtils.test.ts` — 追加用例
- 创建 `tauri-agent/src/components/ErrorBoundary.tsx` — 轻量错误边界
- 创建 `tauri-agent/src/components/ErrorBoundary.test.tsx`
- 创建 `tauri-agent/src/features/tools/extensionCards.tsx` — 8 工具卡片 + 注册表分派
- 创建 `tauri-agent/src/features/tools/extensionCards.test.tsx`
- 修改 `tauri-agent/src/features/tools/ToolExecution.tsx` — `ToolDetail` 顶部接入 `renderExtensionCard`
- 修改 `tauri-agent/src/stores/agentReducer.ts` — 新增 `notice` 类型 + 识别 `CustomMessage`
- 修改 `tauri-agent/src/stores/agentReducer.test.ts` — 追加用例
- 创建 `tauri-agent/src/features/chat/NoticePill.tsx` — 注入提示条
- 创建 `tauri-agent/src/features/chat/NoticePill.test.tsx`
- 修改 `tauri-agent/src/features/chat/MessageList.tsx` — `notice` 分支
- 创建 `tauri-agent/src/features/chat/input/actions/KbAddAction.tsx`
- 创建 `tauri-agent/src/features/chat/input/actions/GenerateImageAction.tsx`
- 创建 `tauri-agent/src/features/chat/input/actions/SpeakAction.tsx`
- 创建 `tauri-agent/src/features/chat/input/actions/extensionActions.test.tsx`
- 修改 `tauri-agent/src/features/chat/input/config.tsx` — 注册三个 action

测试命令：`cd tauri-agent && npx vitest run <file>`；类型检查：`cd tauri-agent && npx tsc --noEmit`。

---

## 任务 1：扩展 toolMeta 图标 + getDetails 辅助

**文件：**
- 修改：`tauri-agent/src/features/tools/toolUtils.ts`
- 测试：`tauri-agent/src/features/tools/toolUtils.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `tauri-agent/src/features/tools/toolUtils.test.ts` 末尾追加（顶部已有的 `import { describe, expect, it } from 'vitest';` 与 `toolMeta` 等 import 复用；若未导入 `getDetails`/`toolMeta`，把它们加入现有的 `from './toolUtils'` import）：

```ts
describe('toolMeta extension icons', () => {
  it('returns distinct icons for extension tools', () => {
    for (const name of ['kb_search', 'kb_add', 'memory_save', 'memory_recall', 'generate_image', 'spawn_agent', 'fetch_url', 'speak']) {
      expect(toolMeta(name).icon).toBeTruthy();
    }
  });
});

describe('getDetails', () => {
  it('returns the details object when present', () => {
    expect(getDetails({ content: [], details: { path: '/a.png' } })).toEqual({ path: '/a.png' });
  });
  it('returns undefined when missing or invalid', () => {
    expect(getDetails(null)).toBeUndefined();
    expect(getDetails('x')).toBeUndefined();
    expect(getDetails({ content: [] })).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/tools/toolUtils.test.ts`
预期：FAIL，`getDetails is not a function`（或 toolMeta 对扩展工具返回默认 `Wrench`，断言仍通过——核心失败来自 `getDetails` 未定义）。

- [ ] **步骤 3：编写最少实现代码**

在 `tauri-agent/src/features/tools/toolUtils.ts` 顶部的 lucide import 中补充新图标：

```ts
import type { LucideIcon } from 'lucide-react';
import {
  BookPlus,
  Brain,
  FilePen,
  FilePlus,
  FileText,
  Folder,
  Globe,
  Image,
  Network,
  Search,
  Terminal,
  Volume2,
  Wrench,
} from 'lucide-react';
```

把 `toolMeta` 的 fallback 之前追加扩展工具分支：

```ts
export function toolMeta(toolName: string): { icon: LucideIcon } {
  const name = toolName.toLowerCase();
  if (name === 'bash' || name === 'shell' || name === 'run_terminal_cmd') {
    return { icon: Terminal };
  }
  if (name === 'read' || name === 'read_file') return { icon: FileText };
  if (name === 'write' || name === 'write_file') return { icon: FilePlus };
  if (name === 'edit' || name === 'search_replace' || name === 'str_replace') {
    return { icon: FilePen };
  }
  if (name === 'glob' || name === 'grep' || name === 'ripgrep') return { icon: Search };
  if (name === 'ls' || name === 'list_dir') return { icon: Folder };
  // —— extension tools ——
  if (name === 'kb_search') return { icon: Search };
  if (name === 'kb_add') return { icon: BookPlus };
  if (name === 'memory_save' || name === 'memory_recall') return { icon: Brain };
  if (name === 'generate_image') return { icon: Image };
  if (name === 'spawn_agent') return { icon: Network };
  if (name === 'fetch_url') return { icon: Globe };
  if (name === 'speak') return { icon: Volume2 };
  return { icon: Wrench };
}
```

在文件末尾追加 `getDetails`：

```ts
export function getDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== 'object') return undefined;
  return details as Record<string, unknown>;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/tools/toolUtils.test.ts`
预期：PASS（全部通过）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/tools/toolUtils.ts tauri-agent/src/features/tools/toolUtils.test.ts
git commit -m "feat(grenagent): add extension tool icons + getDetails helper"
```

---

## 任务 2：ErrorBoundary 组件

**文件：**
- 创建：`tauri-agent/src/components/ErrorBoundary.tsx`
- 测试：`tauri-agent/src/components/ErrorBoundary.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/components/ErrorBoundary.test.tsx`：

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

afterEach(() => {
  cleanup();
});

function Boom(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <div>OK_CONTENT</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('OK_CONTENT')).toBeTruthy();
  });

  it('renders fallback when a child throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={<div>FALLBACK</div>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('FALLBACK')).toBeTruthy();
    spy.mockRestore();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/components/ErrorBoundary.test.tsx`
预期：FAIL，"Cannot find module './ErrorBoundary'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/components/ErrorBoundary.tsx`：

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // 卡片渲染错误不应冒泡打断整条消息列表；静默降级到 fallback。
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div
            data-testid="error-boundary-fallback"
            style={{ fontSize: 12, color: 'var(--gren-fg-muted, #9aa1ac)' }}
          >
            渲染出错
          </div>
        )
      );
    }
    return this.props.children;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/components/ErrorBoundary.test.tsx`
预期：PASS（2 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/components/ErrorBoundary.tsx tauri-agent/src/components/ErrorBoundary.test.tsx
git commit -m "feat(grenagent): add lightweight ErrorBoundary component"
```

---

## 任务 3：扩展工具卡片 extensionCards（8 卡片 + 注册表分派）

**文件：**
- 创建：`tauri-agent/src/features/tools/extensionCards.tsx`
- 测试：`tauri-agent/src/features/tools/extensionCards.test.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/tools/extensionCards.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderExtensionCard } from './extensionCards';

const openPath = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({ openPath: (p: string) => openPath(p) }));

afterEach(() => {
  cleanup();
  openPath.mockReset();
});

function renderCard(toolName: string, result: unknown, args: unknown = {}) {
  const node = renderExtensionCard({ toolName, args, result, status: 'done' });
  return render(<>{node}</>);
}

describe('renderExtensionCard', () => {
  it('returns null for unknown tools', () => {
    expect(renderExtensionCard({ toolName: 'bash', args: {}, result: {}, status: 'done' })).toBeNull();
  });

  it('kb_search shows hit sources and scores', () => {
    renderCard('kb_search', { content: [{ type: 'text', text: 'body' }], details: { mode: 'semantic', hits: [{ source: 'spec.md', score: 0.91 }] } });
    expect(screen.getByTestId('card-kb_search')).toBeTruthy();
    expect(screen.getByText(/spec\.md/)).toBeTruthy();
  });

  it('kb_add shows indexed source and chunk count', () => {
    renderCard('kb_add', { content: [], details: { source: 'notes.md', chunks: 7, embedded: true } });
    const card = screen.getByTestId('card-kb_add');
    expect(card.textContent).toContain('notes.md');
    expect(card.textContent).toContain('7');
  });

  it('memory_save shows scope', () => {
    renderCard('memory_save', { content: [], details: { id: 'm1', scope: 'global', category: 'preference' } });
    expect(screen.getByTestId('card-memory_save').textContent).toContain('全局');
  });

  it('memory_recall renders recall card', () => {
    renderCard('memory_recall', { content: [{ type: 'text', text: 'mem body' }], details: { hits: [{ id: 'm1', scope: 'project', score: 0.8 }] } });
    expect(screen.getByTestId('card-memory_recall')).toBeTruthy();
  });

  it('generate_image shows filename and opens file on click', () => {
    renderCard('generate_image', { content: [], details: { path: '/proj/.pi/images/img_42.png', model: 'gpt-image-1', size: '1024x1024' } });
    expect(screen.getByText(/img_42\.png/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('open-file-generate_image'));
    expect(openPath).toHaveBeenCalledWith('/proj/.pi/images/img_42.png');
  });

  it('spawn_agent shows sub-agent count', () => {
    renderCard('spawn_agent', { content: [{ type: 'text', text: 'out' }], details: { count: 3, failed: 1 } });
    expect(screen.getByTestId('card-spawn_agent').textContent).toContain('3');
  });

  it('fetch_url shows the url', () => {
    renderCard('fetch_url', { content: [{ type: 'text', text: '# Title' }], details: { url: 'https://x.dev', status: 200 } });
    expect(screen.getByText('https://x.dev')).toBeTruthy();
  });

  it('speak opens the audio file on click', () => {
    renderCard('speak', { content: [], details: { path: '/proj/.pi/audio/speech_1.mp3', voice: 'alloy', format: 'mp3' } });
    fireEvent.click(screen.getByTestId('open-file-speak'));
    expect(openPath).toHaveBeenCalledWith('/proj/.pi/audio/speech_1.mp3');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/tools/extensionCards.test.tsx`
预期：FAIL，"Cannot find module './extensionCards'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/features/tools/extensionCards.tsx`：

```tsx
import { Flexbox, Icon } from '@lobehub/ui';
import { ActionIcon } from '@lobehub/ui';
import { openPath } from '@tauri-apps/plugin-opener';
import { BookPlus, Brain, ExternalLink, Globe, Image as ImageIcon, Network, Search, Volume2 } from 'lucide-react';
import type { FC, ReactNode } from 'react';
import { LazyMarkdown } from '../chat/LazyMarkdown';
import { extractText, getDetails } from './toolUtils';

export interface ExtensionCardProps {
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'running' | 'done' | 'error';
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

const labelStyle = { fontSize: 12, color: 'var(--gren-fg-muted, #9aa1ac)' } as const;

function OpenFileButton({ path, toolName, title }: { path: string; toolName: string; title: string }) {
  if (!path) return null;
  return (
    <ActionIcon
      data-testid={`open-file-${toolName}`}
      icon={ExternalLink}
      size="small"
      title={title}
      onClick={() => void openPath(path)}
    />
  );
}

const KbSearchCard: FC<ExtensionCardProps> = ({ result }) => {
  const details = getDetails(result);
  const hits = Array.isArray(details?.hits) ? (details!.hits as Array<{ source?: unknown; score?: unknown }>) : [];
  const text = extractText(result);
  return (
    <Flexbox gap={6} data-testid="card-kb_search">
      {hits.length > 0 && (
        <Flexbox gap={2}>
          {hits.map((h, i) => (
            <Flexbox horizontal align="center" gap={6} key={i}>
              <Icon icon={Search} size={13} />
              <span style={{ fontSize: 12 }}>{asString(h.source)}</span>
              {h.score != null && <span style={labelStyle}>score {asString(h.score)}</span>}
            </Flexbox>
          ))}
        </Flexbox>
      )}
      {text && <LazyMarkdown>{text}</LazyMarkdown>}
    </Flexbox>
  );
};

const KbAddCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  return (
    <Flexbox horizontal align="center" gap={6} data-testid="card-kb_add">
      <Icon icon={BookPlus} size={14} />
      <span style={{ fontSize: 12 }}>
        已索引 {asString(d?.source)} 为 {asString(d?.chunks ?? 0)} 块（{d?.embedded ? 'embedded' : 'keyword'}）
      </span>
    </Flexbox>
  );
};

const MemoryCard: FC<ExtensionCardProps> = ({ toolName, result }) => {
  const d = getDetails(result);
  const text = extractText(result);
  if (toolName === 'memory_save') {
    return (
      <Flexbox horizontal align="center" gap={6} data-testid="card-memory_save">
        <Icon icon={Brain} size={14} />
        <span style={{ fontSize: 12 }}>
          已保存到{d?.scope === 'global' ? '全局' : '项目'}记忆{d?.category ? `（${asString(d.category)}）` : ''}
        </span>
      </Flexbox>
    );
  }
  return (
    <Flexbox gap={6} data-testid="card-memory_recall">
      <Flexbox horizontal align="center" gap={6}>
        <Icon icon={Brain} size={14} />
        <span style={{ fontSize: 12 }}>召回记忆</span>
      </Flexbox>
      {text && <LazyMarkdown>{text}</LazyMarkdown>}
    </Flexbox>
  );
};

const GenerateImageCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const path = asString(d?.path);
  return (
    <Flexbox horizontal align="center" gap={8} data-testid="card-generate_image">
      <Icon icon={ImageIcon} size={14} />
      <span style={{ fontSize: 12 }}>{basename(path)}</span>
      {(d?.model || d?.size) && (
        <span style={labelStyle}>
          {asString(d?.model)} {asString(d?.size)}
        </span>
      )}
      <OpenFileButton path={path} toolName="generate_image" title="打开图片" />
    </Flexbox>
  );
};

const SpawnAgentCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const text = extractText(result);
  const count = typeof d?.count === 'number' ? d.count : undefined;
  const failed = typeof d?.failed === 'number' ? d.failed : undefined;
  return (
    <Flexbox gap={6} data-testid="card-spawn_agent">
      {count != null && (
        <Flexbox horizontal align="center" gap={6}>
          <Icon icon={Network} size={14} />
          <span style={{ fontSize: 12 }}>
            {count} 个子 agent{failed ? `，${failed} 个失败` : ''}
          </span>
        </Flexbox>
      )}
      {text && <LazyMarkdown>{text}</LazyMarkdown>}
    </Flexbox>
  );
};

const FetchUrlCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const url = asString(d?.url);
  const text = extractText(result);
  return (
    <Flexbox gap={6} data-testid="card-fetch_url">
      {url && (
        <Flexbox horizontal align="center" gap={6}>
          <Icon icon={Globe} size={14} />
          <span style={{ fontSize: 12 }}>{url}</span>
          {d?.status != null && <span style={labelStyle}>{asString(d.status)}</span>}
        </Flexbox>
      )}
      {text && <LazyMarkdown>{text}</LazyMarkdown>}
    </Flexbox>
  );
};

const SpeakCard: FC<ExtensionCardProps> = ({ result }) => {
  const d = getDetails(result);
  const path = asString(d?.path);
  return (
    <Flexbox horizontal align="center" gap={8} data-testid="card-speak">
      <Icon icon={Volume2} size={14} />
      <span style={{ fontSize: 12 }}>{basename(path)}</span>
      {d?.voice && <span style={labelStyle}>{asString(d.voice)}</span>}
      <OpenFileButton path={path} toolName="speak" title="打开音频" />
    </Flexbox>
  );
};

const EXTENSION_CARD_RENDERERS: Record<string, FC<ExtensionCardProps>> = {
  kb_search: KbSearchCard,
  kb_add: KbAddCard,
  memory_save: MemoryCard,
  memory_recall: MemoryCard,
  generate_image: GenerateImageCard,
  spawn_agent: SpawnAgentCard,
  fetch_url: FetchUrlCard,
  speak: SpeakCard,
};

export function renderExtensionCard(props: ExtensionCardProps): ReactNode | null {
  const Renderer = EXTENSION_CARD_RENDERERS[props.toolName.toLowerCase()];
  if (!Renderer) return null;
  return <Renderer {...props} />;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/tools/extensionCards.test.tsx`
预期：PASS（9 passed）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/tools/extensionCards.tsx tauri-agent/src/features/tools/extensionCards.test.tsx
git commit -m "feat(grenagent): add extension tool result cards with registry dispatch"
```

---

## 任务 4：ToolExecution 接入 extensionCards

**文件：**
- 修改：`tauri-agent/src/features/tools/ToolExecution.tsx`（`ToolDetail` 函数）

- [ ] **步骤 1：加 import**

在 `tauri-agent/src/features/tools/ToolExecution.tsx` 顶部 import 区追加：

```tsx
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { renderExtensionCard } from './extensionCards';
```

- [ ] **步骤 2：在 ToolDetail 顶部分派扩展卡片**

把 `ToolDetail` 函数体开头（`const { styles } = useCardStyles();` 之后、`const name = toolName.toLowerCase();` 之前）插入：

```tsx
  const extensionCard = renderExtensionCard({ toolName, args, result, status });
  if (extensionCard) {
    return <ErrorBoundary>{extensionCard}</ErrorBoundary>;
  }
```

- [ ] **步骤 3：类型检查**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误。

- [ ] **步骤 4：回归测试（确认现有工具卡片未受影响）**

运行：`cd tauri-agent && npx vitest run src/features/tools/`
预期：`toolUtils.test.ts` 与 `extensionCards.test.tsx` 全部 PASS，无回归。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/tools/ToolExecution.tsx
git commit -m "feat(grenagent): dispatch extension cards in ToolExecution detail"
```

---

## 任务 5：自动注入提示条 — reducer 识别 CustomMessage

**文件：**
- 修改：`tauri-agent/src/stores/agentReducer.ts`
- 测试：`tauri-agent/src/stores/agentReducer.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `tauri-agent/src/stores/agentReducer.test.ts` 追加（复用现有 `import { applyEvent, initialAgentState, messagesFromAgent } from './agentReducer';` 与 `vitest` import；缺则补）：

```ts
describe('custom injection messages -> notice', () => {
  it('applyEvent turns a display custom message into a single notice (deduped)', () => {
    const msg = { role: 'custom', customType: 'knowledge-rag', content: '# KB\n\nsnippet', display: true } as const;
    let state = initialAgentState();
    state = applyEvent(state, { type: 'message_start', message: msg } as never);
    state = applyEvent(state, { type: 'message_end', message: msg } as never);
    const notices = state.messages.filter((m) => m.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'notice', customType: 'knowledge-rag', content: '# KB\n\nsnippet' });
  });

  it('ignores custom messages without display:true', () => {
    const msg = { role: 'custom', customType: 'long-term-memory', content: 'x', display: false } as const;
    const state = applyEvent(initialAgentState(), { type: 'message_start', message: msg } as never);
    expect(state.messages.filter((m) => m.kind === 'notice')).toHaveLength(0);
  });

  it('messagesFromAgent restores notices from history', () => {
    const out = messagesFromAgent([
      { role: 'custom', customType: 'long-term-memory', content: '# Mem', display: true } as never,
      { role: 'user', content: 'hi' } as never,
    ]);
    expect(out[0]).toMatchObject({ kind: 'notice', customType: 'long-term-memory', content: '# Mem' });
    expect(out[1]).toMatchObject({ kind: 'user', text: 'hi' });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/stores/agentReducer.test.ts`
预期：FAIL（custom 消息被忽略，`notices` 长度为 0；历史不产出 notice）。

- [ ] **步骤 3：编写最少实现代码**

在 `tauri-agent/src/stores/agentReducer.ts` 的 `ChatMessage` 联合类型追加 `notice` 分支：

```ts
export type ChatMessage =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      thinking: string;
      streaming: boolean;
      timestamp?: number;
      thinkingStartedAt?: number;
      thinkingDuration?: number;
    }
  | { kind: 'tool'; id: string; toolCallId: string; toolName: string; args: unknown; result: unknown; status: 'running' | 'done' | 'error' }
  | { kind: 'notice'; id: string; customType: string; content: string };
```

在 `applyEvent` 之前新增辅助函数：

```ts
/** 把 pi 的 CustomMessage（role:'custom', display:true）转成一条去重的 notice。 */
function applyCustomMessage(state: AgentState, msg: AgentMessage): AgentState {
  if ((msg as { display?: unknown }).display !== true) return state;
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (!content.trim()) return state;
  if (state.messages.some((m) => m.kind === 'notice' && m.content === content)) return state;
  const customType =
    typeof (msg as { customType?: unknown }).customType === 'string'
      ? (msg as { customType: string }).customType
      : '';
  return {
    ...state,
    messages: [...state.messages, { kind: 'notice', id: nextId(), customType, content }],
  };
}
```

在 `message_start` 的 case 开头（取出 `ev` 之后、`role !== 'assistant'` 判断之前）加 custom 分支：

```ts
    case 'message_start': {
      const ev = event as Extract<AgentEvent, { type: 'message_start' }>;
      if (ev.message.role === 'custom') return applyCustomMessage(state, ev.message);
      if (ev.message.role !== 'assistant') return state;
      // ...原有逻辑不变
```

在 `message_end` 的 case 同样位置加：

```ts
    case 'message_end': {
      const ev = event as Extract<AgentEvent, { type: 'message_end' }>;
      if (ev.message.role === 'custom') return applyCustomMessage(state, ev.message);
      if (ev.message.role !== 'assistant') return state;
      // ...原有逻辑不变
```

在 `messagesFromAgent` 的循环里，`if (msg.role === 'user')` 之前加 custom 分支：

```ts
  for (const msg of msgs) {
    if (msg.role === 'custom') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if ((msg as { display?: unknown }).display === true && content.trim()) {
        const customType =
          typeof (msg as { customType?: unknown }).customType === 'string'
            ? (msg as { customType: string }).customType
            : '';
        out.push({ kind: 'notice', id: nextId(), customType, content });
      }
      continue;
    }
    if (msg.role === 'user') {
      // ...原有逻辑不变
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/stores/agentReducer.test.ts`
预期：PASS（含新增 3 例 + 原有用例）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/stores/agentReducer.ts tauri-agent/src/stores/agentReducer.test.ts
git commit -m "feat(grenagent): map injected custom messages to notice items"
```

---

## 任务 6：NoticePill 组件 + MessageList 接入

**文件：**
- 创建：`tauri-agent/src/features/chat/NoticePill.tsx`
- 测试：`tauri-agent/src/features/chat/NoticePill.test.tsx`
- 修改：`tauri-agent/src/features/chat/MessageList.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/chat/NoticePill.test.tsx`：

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { NoticePill } from './NoticePill';

afterEach(() => {
  cleanup();
});

describe('NoticePill', () => {
  it('shows the knowledge-rag title', () => {
    render(<NoticePill customType="knowledge-rag" content="# KB" />);
    expect(screen.getByTestId('notice-pill').textContent).toContain('已注入知识库上下文');
  });

  it('shows the long-term-memory title', () => {
    render(<NoticePill customType="long-term-memory" content="# Mem" />);
    expect(screen.getByTestId('notice-pill').textContent).toContain('已注入长期记忆');
  });

  it('falls back to a generic title for unknown customType', () => {
    render(<NoticePill customType="other" content="x" />);
    expect(screen.getByTestId('notice-pill').textContent).toContain('已注入上下文');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/chat/NoticePill.test.tsx`
预期：FAIL，"Cannot find module './NoticePill'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/features/chat/NoticePill.tsx`：

```tsx
import { Collapse, Flexbox, Icon } from '@lobehub/ui';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { LazyMarkdown } from './LazyMarkdown';

const TITLES: Record<string, string> = {
  'knowledge-rag': '已注入知识库上下文',
  'long-term-memory': '已注入长期记忆',
};

interface NoticePillProps {
  customType: string;
  content: string;
}

export function NoticePill({ customType, content }: NoticePillProps) {
  const [expanded, setExpanded] = useState(false);
  const title = TITLES[customType] ?? '已注入上下文';

  return (
    <div data-testid="notice-pill" style={{ paddingInlineStart: 4, maxWidth: '100%' }}>
      <Collapse
        variant="borderless"
        gap={4}
        activeKey={expanded ? ['notice'] : []}
        onChange={(keys) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          setExpanded(arr.includes('notice'));
        }}
        items={[
          {
            key: 'notice',
            label: (
              <Flexbox horizontal align="center" gap={6} style={{ fontSize: 12, color: 'var(--gren-fg-muted, #9aa1ac)' }}>
                <Icon icon={Sparkles} size={13} />
                <span>{title}</span>
              </Flexbox>
            ),
            children: expanded ? <LazyMarkdown>{content}</LazyMarkdown> : null,
          },
        ]}
      />
    </div>
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/chat/NoticePill.test.tsx`
预期：PASS（3 passed）。

- [ ] **步骤 5：在 MessageList 渲染 notice**

在 `tauri-agent/src/features/chat/MessageList.tsx` 顶部 import 区追加：

```tsx
import { NoticePill } from './NoticePill';
```

在 `messages.map` 的 `switch (msg.kind)` 中，`case 'tool':` 之后、`default:` 之前插入：

```tsx
              case 'notice':
                return <NoticePill key={msg.id} customType={msg.customType} content={msg.content} />;
```

- [ ] **步骤 6：类型检查 + 回归**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误（`switch` 已覆盖 `notice`，其余有 `default`）。

运行：`cd tauri-agent && npx vitest run src/features/chat/`
预期：全部 PASS。

- [ ] **步骤 7：Commit**

```bash
git add tauri-agent/src/features/chat/NoticePill.tsx tauri-agent/src/features/chat/NoticePill.test.tsx tauri-agent/src/features/chat/MessageList.tsx
git commit -m "feat(grenagent): render injection notices as NoticePill in chat"
```

---

## 任务 7：输入区快捷按钮（加入知识库 / 生图 / 朗读）

**文件：**
- 创建：`tauri-agent/src/features/chat/input/actions/KbAddAction.tsx`
- 创建：`tauri-agent/src/features/chat/input/actions/GenerateImageAction.tsx`
- 创建：`tauri-agent/src/features/chat/input/actions/SpeakAction.tsx`
- 测试：`tauri-agent/src/features/chat/input/actions/extensionActions.test.tsx`
- 修改：`tauri-agent/src/features/chat/input/config.tsx`

- [ ] **步骤 1：编写失败的测试**

`tauri-agent/src/features/chat/input/actions/extensionActions.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { ChatInputProvider, type ChatInputContextValue } from '../ChatInputContext';
import KbAddAction from './KbAddAction';
import GenerateImageAction from './GenerateImageAction';
import SpeakAction from './SpeakAction';

afterEach(() => {
  cleanup();
});

function renderWithCtx(ui: ReactNode) {
  const setValue = vi.fn();
  const ctx: ChatInputContextValue = {
    value: '',
    setValue,
    attachments: [],
    addAttachments: vi.fn(),
    removeAttachment: vi.fn(),
    isStreaming: false,
    send: vi.fn(),
    stop: vi.fn(),
  };
  render(<ChatInputProvider value={ctx}>{ui}</ChatInputProvider>);
  return setValue;
}

describe('input extension actions', () => {
  it('KbAddAction prefills a kb_add instruction', () => {
    const setValue = renderWithCtx(<KbAddAction />);
    fireEvent.click(screen.getByRole('button'));
    expect(setValue).toHaveBeenCalledTimes(1);
    expect(setValue.mock.calls[0][0]).toContain('知识库');
  });

  it('GenerateImageAction prefills an image instruction', () => {
    const setValue = renderWithCtx(<GenerateImageAction />);
    fireEvent.click(screen.getByRole('button'));
    expect(setValue.mock.calls[0][0]).toContain('图片');
  });

  it('SpeakAction prefills a speak instruction', () => {
    const setValue = renderWithCtx(<SpeakAction />);
    fireEvent.click(screen.getByRole('button'));
    expect(setValue.mock.calls[0][0]).toContain('朗读');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd tauri-agent && npx vitest run src/features/chat/input/actions/extensionActions.test.tsx`
预期：FAIL，"Cannot find module './KbAddAction'"。

- [ ] **步骤 3：编写最少实现代码**

`tauri-agent/src/features/chat/input/actions/KbAddAction.tsx`：

```tsx
import { ActionIcon } from '@lobehub/ui';
import { BookPlus } from 'lucide-react';
import { useChatInput } from '../ChatInputContext';

export default function KbAddAction() {
  const { setValue } = useChatInput();
  return (
    <ActionIcon
      icon={BookPlus}
      size="small"
      title="加入知识库"
      onClick={() => setValue('请把以下内容加入知识库（使用 kb_add 工具）：\n')}
    />
  );
}
```

`tauri-agent/src/features/chat/input/actions/GenerateImageAction.tsx`：

```tsx
import { ActionIcon } from '@lobehub/ui';
import { Image } from 'lucide-react';
import { useChatInput } from '../ChatInputContext';

export default function GenerateImageAction() {
  const { setValue } = useChatInput();
  return (
    <ActionIcon
      icon={Image}
      size="small"
      title="生成图片"
      onClick={() => setValue('请生成一张图片：')}
    />
  );
}
```

`tauri-agent/src/features/chat/input/actions/SpeakAction.tsx`：

```tsx
import { ActionIcon } from '@lobehub/ui';
import { Volume2 } from 'lucide-react';
import { useChatInput } from '../ChatInputContext';

export default function SpeakAction() {
  const { setValue } = useChatInput();
  return (
    <ActionIcon
      icon={Volume2}
      size="small"
      title="朗读文本"
      onClick={() => setValue('请朗读以下文本（使用 speak 工具）：\n')}
    />
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd tauri-agent && npx vitest run src/features/chat/input/actions/extensionActions.test.tsx`
预期：PASS（3 passed）。

- [ ] **步骤 5：在 config 注册三个 action**

把 `tauri-agent/src/features/chat/input/config.tsx` 改为：

```tsx
import type { ComponentType } from 'react';
import ModelAction from './actions/ModelAction';
import ThinkingAction from './actions/ThinkingAction';
import CompactAction from './actions/CompactAction';
import NewSessionAction from './actions/NewSessionAction';
import UploadAction from './actions/UploadAction';
import KbAddAction from './actions/KbAddAction';
import GenerateImageAction from './actions/GenerateImageAction';
import SpeakAction from './actions/SpeakAction';

/**
 * 动作注册表：key -> 组件。
 * 新增一个工具按钮 = 在此登记一项 + 在 leftActions/rightActions 数组里加 key。
 */
export const actionMap = {
  model: ModelAction,
  thinking: ThinkingAction,
  compact: CompactAction,
  newSession: NewSessionAction,
  fileUpload: UploadAction,
  kbAdd: KbAddAction,
  generateImage: GenerateImageAction,
  speak: SpeakAction,
} satisfies Record<string, ComponentType>;

export type ActionKey = keyof typeof actionMap;

export const DEFAULT_LEFT_ACTIONS: ActionKey[] = [
  'model',
  'thinking',
  'fileUpload',
  'kbAdd',
  'generateImage',
  'speak',
  'compact',
  'newSession',
];
export const DEFAULT_RIGHT_ACTIONS: ActionKey[] = [];
```

- [ ] **步骤 6：类型检查 + 全量测试**

运行：`cd tauri-agent && npx tsc --noEmit`
预期：无错误。

运行：`cd tauri-agent && npx vitest run`
预期：全部 PASS，无回归。

- [ ] **步骤 7：手动验证（Tauri GUI）**

运行：`cd tauri-agent && npm run tauri dev`，在对话里：
1. 让 agent 触发各扩展工具（如「搜索知识库 X」「生成一张猫的图片」「抓取 https://example.com」），确认对应卡片渲染、图片/音频卡片「打开文件」可用。
2. 启用 KB/记忆自动注入（默认开）发一条 prompt，确认消息流出现 `Sparkles` 提示条、可展开看注入内容。
3. 点输入区「加入知识库 / 生图 / 朗读」按钮，确认输入框被预填指令文本。

- [ ] **步骤 8：Commit**

```bash
git add tauri-agent/src/features/chat/input/actions/KbAddAction.tsx tauri-agent/src/features/chat/input/actions/GenerateImageAction.tsx tauri-agent/src/features/chat/input/actions/SpeakAction.tsx tauri-agent/src/features/chat/input/actions/extensionActions.test.tsx tauri-agent/src/features/chat/input/config.tsx
git commit -m "feat(grenagent): add kb/image/speak quick actions to chat input"
```

---

## 自检

**1. 规格覆盖度（对应设计 §4.1、§5、§6、§9.1 第 2 期「对话增强」）：**
- 工具卡片 kb_search / kb_add / memory_save / memory_recall / generate_image / spawn_agent / fetch_url / speak（§6 表）→ 任务 3 八卡片全覆盖 ✓
- 卡片头部图标用 lucide（§9.1）→ 任务 1 `toolMeta` + 任务 3 卡片内 `Icon` ✓
- 卡片接入现有 `ToolExecution`「按 toolName 分派」机制（§6）→ 任务 4 ✓
- 自动注入提示条（knowledge-rag / long-term-memory，`Sparkles` 图标，§4.1/§6）→ 任务 5（reducer）+ 任务 6（NoticePill + MessageList）✓
- 输入区 `+知识库` / `生图` / `朗读`（§4.1）→ 任务 7 ✓
- 媒体呈现用「打开文件」按钮（与用户确认的范围一致；内联缩略图/播放归后续/创作模块）→ 任务 3 `OpenFileButton` ✓
- 全程 lucide SVG、无 emoji（§9.1）→ 所有任务图标均 lucide ✓
- 不在本期：管理面板、sidecar env 注入、直接调工具的新 RPC → 不在范围，符合 §10/§11 ✓

**2. 占位符扫描：** 无 TODO/待定/「类似任务 N」/未定义引用。所有步骤含完整代码、精确命令与预期输出。

**3. 类型一致性：**
- `ExtensionCardProps`（任务 3 定义：`toolName/args/result/status`）在 `renderExtensionCard` 与任务 4 `ToolExecution` 调用处一致。
- `ChatMessage` 的 `notice` 分支（任务 5 定义：`kind/id/customType/content`）与任务 6 `MessageList` 的 `msg.customType/msg.content`、`NoticePill` props 一致。
- `getDetails`（任务 1）被任务 3 各卡片复用，签名 `(result:unknown)=>Record<string,unknown>|undefined` 一致。
- `ActionKey`（任务 7 `config.tsx`）新增 `kbAdd/generateImage/speak` 与 `actionMap` 键、`DEFAULT_LEFT_ACTIONS` 一致。
- `ChatInputContextValue`（任务 7 测试构造）与 `ChatInputContext.tsx` 现有接口字段完全一致（`value/setValue/attachments/addAttachments/removeAttachment/isStreaming/send/stop`）。

## 备注

- 注入提示条去重按 `content` 字符串比对；reducer 在 `message_start` 与 `message_end` 都处理 `role:'custom'`，无论 pi 实时发哪个/两个事件都只产出一条 notice（任务 7 步骤 7 手动验证兜底实时表现）。
- 卡片只读 `result.details` 已确认字段 + `content` text，不解析脆弱的格式化字符串；命中全文/子 agent 输出/抓取正文统一用 `extractText` + `LazyMarkdown` 渲染。
- 内联图片缩略图 / 音频播放器需 `tauri.conf.json` 配 `assetProtocol`（scope）+ capabilities，本期按已确认范围用 `openPath` 打开，留到「创作」模块或单独增强。
- CSS 变量 `--gren-*` 为占位回退，可后续对接 `themeStore`，不影响功能与测试。
