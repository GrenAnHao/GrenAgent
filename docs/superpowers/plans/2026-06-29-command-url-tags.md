# 命令 / URL 标签与执行性命令去幽灵 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 让粘贴的 URL 在输入框与对话气泡里都渲染成与命令/文件一致的链接 chip；并让执行性命令（如 `/dream`）发送时不再留下切换会话即消失的幽灵气泡，改为瞬态「已执行」提示。

**架构：** Part A 复用现有 `ChatTag` chip 体系，新增 `link` 类目 + 粘贴识别 + 气泡 URL 段渲染。Part B 用一份保守白名单把「整条消息==单个执行性命令」判出，在 `handleSend` 短路掉乐观气泡。判定逻辑全部抽成纯函数以便单测。

**技术栈：** React 19 + TypeScript + `@lobehub/editor`(Lexical) + antd v6 + antd-style(`cssVar`) + lucide-react 1.x + Vitest。

**通用命令（在 `tauri-agent/` 下执行）：**
- 单测：`bunx vitest run <文件路径>`
- 类型检查：`bunx tsc --noEmit`

---

### 任务 1：ChatTag 新增 `link` 类目与序列化

**文件：**
- 修改：`tauri-agent/src/features/chat/input/editor/ChatTag/types.ts:4`
- 修改：`tauri-agent/src/features/chat/input/editor/ChatTag/tagText.ts`
- 测试：`tauri-agent/src/features/chat/input/editor/ChatTag/tagText.test.ts`

- [ ] **步骤 1：扩展测试（先失败）**

在 `tagText.test.ts` 的 `describe('tagToText', ...)` 内追加：

```ts
  it('链接写成原始 URL（无前缀）', () => {
    expect(tagToText('link', 'https://vercel.com/docs')).toBe('https://vercel.com/docs');
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bunx vitest run src/features/chat/input/editor/ChatTag/tagText.test.ts`
预期：FAIL（`link` 当前落入 `@` 分支，得到 `@https://...`）。

- [ ] **步骤 3：加 `link` 到类目枚举**

`types.ts` 第 4 行改为：

```ts
export type ChatTagCategory = 'file' | 'directory' | 'command' | 'link';
```

- [ ] **步骤 4：`tagText.ts` 处理 link**

整体替换为：

```ts
import type { ChatTagCategory } from './types';

/** 标签序列化成消息文本：文件/目录写 `@路径`，命令写 `/名称`，链接写原始 URL。 */
export function tagToText(category: ChatTagCategory, value: string): string {
  if (category === 'command') return `/${value}`;
  if (category === 'link') return value;
  return `@${value}`;
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`bunx vitest run src/features/chat/input/editor/ChatTag/tagText.test.ts`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/chat/input/editor/ChatTag/types.ts tauri-agent/src/features/chat/input/editor/ChatTag/tagText.ts tauri-agent/src/features/chat/input/editor/ChatTag/tagText.test.ts
git commit -m "feat(chat): add link category to chat tag serialization"
```

---

### 任务 2：URL 粘贴纯函数（识别 + 精简 label + 解析标签）

**文件：**
- 创建：`tauri-agent/src/features/chat/input/editor/urlPaste.ts`
- 测试：`tauri-agent/src/features/chat/input/editor/urlPaste.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `urlPaste.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { formatUrlLabel, isSingleUrl, resolveUrlTag } from './urlPaste';

describe('isSingleUrl', () => {
  it('接受单条 http(s) URL（含首尾空白）', () => {
    expect(isSingleUrl('https://github.com/lobehub/lobe-chat')).toBe(true);
    expect(isSingleUrl('  http://example.com  ')).toBe(true);
  });
  it('拒绝含空白 / 非 URL / 路径', () => {
    expect(isSingleUrl('看 https://a.com')).toBe(false);
    expect(isSingleUrl('https://a.com https://b.com')).toBe(false);
    expect(isSingleUrl('/usr/local/bin')).toBe(false);
    expect(isSingleUrl('hello')).toBe(false);
  });
});

describe('formatUrlLabel', () => {
  it('根路径只显示 host（去 www）', () => {
    expect(formatUrlLabel('https://vercel.com')).toBe('vercel.com');
    expect(formatUrlLabel('https://www.vercel.com/')).toBe('vercel.com');
  });
  it('单段路径显示 host/段', () => {
    expect(formatUrlLabel('https://vercel.com/docs')).toBe('vercel.com/docs');
  });
  it('深路径折叠为 host/.../末段', () => {
    expect(formatUrlLabel('https://github.com/lobehub/lobe-chat/pull/123')).toBe('github.com/.../123');
  });
  it('非法 URL 原样返回', () => {
    expect(formatUrlLabel('not a url')).toBe('not a url');
  });
});

describe('resolveUrlTag', () => {
  it('单条 URL 返回 link 标签', () => {
    expect(resolveUrlTag('https://vercel.com/docs')).toEqual({
      category: 'link',
      label: 'vercel.com/docs',
      value: 'https://vercel.com/docs',
    });
  });
  it('非 URL 返回 null', () => {
    expect(resolveUrlTag('hello world')).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bunx vitest run src/features/chat/input/editor/urlPaste.test.ts`
预期：FAIL（`urlPaste` 模块不存在）。

- [ ] **步骤 3：实现 `urlPaste.ts`**

```ts
import type { ChatTagData } from './ChatTag/types';

const SINGLE_URL = /^https?:\/\/\S+$/;

/** 整条文本是否就是单个 http(s) URL（无内部空白）。 */
export function isSingleUrl(text: string): boolean {
  return SINGLE_URL.test(text.trim());
}

/**
 * chip 上展示的精简 URL：host（去 www）+ 路径。
 * 根路径只显示 host；单段显示 host/段；多段折叠为 host/.../末段。完整 URL 存 value。
 */
export function formatUrlLabel(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url.trim();
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return host;
  if (segs.length === 1) return `${host}/${segs[0]}`;
  return `${host}/.../${segs[segs.length - 1]}`;
}

/** 把粘贴文本解析成链接标签数据；非单条 URL 返回 null（由调用方放行默认粘贴）。 */
export function resolveUrlTag(text: string): ChatTagData | null {
  if (!isSingleUrl(text)) return null;
  const url = text.trim();
  return { category: 'link', label: formatUrlLabel(url), value: url };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bunx vitest run src/features/chat/input/editor/urlPaste.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/input/editor/urlPaste.ts tauri-agent/src/features/chat/input/editor/urlPaste.test.ts
git commit -m "feat(chat): add URL paste detection and label utils"
```

---

### 任务 3：URL 粘贴 hook 接入输入框

**文件：**
- 创建：`tauri-agent/src/features/chat/input/editor/useUrlPaste.ts`
- 修改：`tauri-agent/src/features/chat/input/editor/usePasteCapture.ts`
- 修改：`tauri-agent/src/features/chat/input/editor/MessageEditor.tsx:117-124`

- [ ] **步骤 1：实现 `useUrlPaste.ts`**

```ts
import { useCallback } from 'react';
import type { IEditor } from '@lobehub/editor';
import { resolveUrlTag } from './urlPaste';
import { INSERT_CHAT_TAG_COMMAND } from './ChatTag/command';

/**
 * 让「粘贴一条 URL 进输入框」自动转成链接标签——与 /命令 粘贴同构。
 * 仅当整条粘贴文本就是单个 http(s) URL 时转标签；否则返回 false 放行默认粘贴。
 */
export function useUrlPaste(editor: IEditor) {
  const tryUrlPaste = useCallback(
    (text: string): boolean => {
      const tag = resolveUrlTag(text);
      if (!tag) return false;
      editor.dispatchCommand(INSERT_CHAT_TAG_COMMAND, tag);
      return true;
    },
    [editor],
  );
  return { tryUrlPaste };
}
```

- [ ] **步骤 2：`usePasteCapture.ts` 增加 `onUrlText`**

在 `Options` 接口里、`onCommandText` 之前加：

```ts
  /** 短文本粘贴时尝试转成链接标签；返回 true 表示已处理，应阻止默认粘贴。 */
  onUrlText?: (text: string) => boolean;
```

把函数签名解构与依赖数组加入 `onUrlText`：

```ts
export function usePasteCapture({ targetRef, onImages, onPastedText, onUrlText, onCommandText }: Options) {
```

在 `isLongPaste` 的 `return;` 之后、`onCommandText?.(text)` 之前插入：

```ts
      if (onUrlText?.(text)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

```

并把 `useEffect` 末尾依赖数组改为：

```ts
  }, [targetRef, onImages, onPastedText, onUrlText, onCommandText]);
```

- [ ] **步骤 3：`MessageEditor.tsx` 接线**

在 import 区（`useCommandPaste` 之后）加：

```ts
import { useUrlPaste } from './useUrlPaste';
```

把第 117 行附近改为：

```ts
  const { tryCommandPaste } = useCommandPaste(workspace, editor);
  const { tryUrlPaste } = useUrlPaste(editor);

  usePasteCapture({
    targetRef: zoneRef,
    onImages: addAttachments,
    onPastedText: addPastedText,
    onUrlText: tryUrlPaste,
    onCommandText: tryCommandPaste,
  });
```

- [ ] **步骤 4：类型检查**

运行：`bunx tsc --noEmit`
预期：零新增错误。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/input/editor/useUrlPaste.ts tauri-agent/src/features/chat/input/editor/usePasteCapture.ts tauri-agent/src/features/chat/input/editor/MessageEditor.tsx
git commit -m "feat(chat): convert pasted URL to link chip in input"
```

---

### 任务 4：链接 chip 视觉（青色 + Link2 图标）

**文件：**
- 修改：`tauri-agent/src/features/chat/input/editor/ChatTag/ChatTagView.tsx`

- [ ] **步骤 1：加 `link` 配色 token**

在 `createStaticStyles` 的样式对象里，`toolCommand` 之后加：

```ts
  link: css`
    color: ${cssVar.cyan};
    background: color-mix(in srgb, ${cssVar.cyan} 16%, transparent);
  `,
```

- [ ] **步骤 2：导入 `Link2`**

把第 2 行 `import { ToyBrick } from 'lucide-react';` 改为：

```ts
import { Link2, ToyBrick } from 'lucide-react';
```

- [ ] **步骤 3：渲染 link 图标 + hover 完整 URL**

把组件 `return` 改为（`colorClass` 逻辑保持不变，`styles[category]` 已能取到新增的 `styles.link`）：

```tsx
  const colorClass =
    category === 'command' && commandGroup === 'extension' ? styles.toolCommand : styles[category];
  const fileName = label.split('/').pop() || label;
  const isFileLike = category === 'file' || category === 'directory';
  return (
    <span className={cx(styles.tag, colorClass)} title={category === 'link' ? value : undefined}>
      {isFileLike ? (
        <FileIcon fileName={fileName} isDirectory={category === 'directory'} size={13} variant="raw" />
      ) : (
        <Icon icon={category === 'link' ? Link2 : commandIcon(value)} size={13} />
      )}
      <span>{label}</span>
    </span>
  );
```

- [ ] **步骤 4：类型检查**

运行：`bunx tsc --noEmit`
预期：零新增错误。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/input/editor/ChatTag/ChatTagView.tsx
git commit -m "feat(chat): style link chip with cyan and Link2 icon"
```

---

### 任务 5：对话气泡里把 URL 渲染成链接 chip

**文件：**
- 修改：`tauri-agent/src/features/chat/messageTags.tsx`
- 测试：`tauri-agent/src/features/chat/messageTags.test.ts`

- [ ] **步骤 1：扩展测试（先失败）**

在 `messageTags.test.ts` 的 `describe` 内追加：

```ts
  it('把行内 URL 切成 link 段', () => {
    const segs = parseMessageTags('看 https://vercel.com/docs 这个');
    expect(segs).toEqual([
      { type: 'text', text: '看 ' },
      { type: 'link', url: 'https://vercel.com/docs' },
      { type: 'text', text: ' 这个' },
    ]);
  });

  it('URL 在开头', () => {
    const segs = parseMessageTags('https://a.com is up');
    expect(segs[0]).toEqual({ type: 'link', url: 'https://a.com' });
  });

  it('不误伤 email 与普通路径', () => {
    expect(parseMessageTags('user@host.com').every((s) => s.type === 'text')).toBe(true);
    expect(parseMessageTags('see /src/foo.ts')[0].type).toBe('text');
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bunx vitest run src/features/chat/messageTags.test.ts`
预期：FAIL（URL 当前落为纯文本）。

- [ ] **步骤 3：实现 URL 段解析与渲染**

在 `messageTags.tsx` 顶部 import 加：

```ts
import { formatUrlLabel } from './input/editor/urlPaste';
```

把 `MessageSegment` 类型改为：

```ts
export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'file'; path: string }
  | { type: 'skill'; name: string }
  | { type: 'link'; url: string };
```

把 `INLINE_RE` 改为（新增 URL 备选，置于最前；URL 备选不含捕获子组，故 `m[3]`/`m[4]` 仍分别对应 skill/file）：

```ts
// URL（http/https）/ `/skill:name` / `@path`，均限「行首或空白后」。
const INLINE_RE = /(^|\s)(https?:\/\/\S+|\/skill:(\S+)|@(\S+))/g;
```

把 `parseInline` 的分发块改为：

```ts
    if (m[3] !== undefined) {
      segments.push({ type: 'skill', name: bareSkillName(m[3]) });
    } else if (m[4] !== undefined) {
      segments.push({ type: 'file', path: m[4] });
    } else {
      segments.push({ type: 'link', url: m[2] });
    }
```

在 `renderMessageTags` 的 `map` 里，`skill` 分支之后加：

```tsx
    if (seg.type === 'link') {
      return <ChatTagView key={i} category="link" label={formatUrlLabel(seg.url)} value={seg.url} />;
    }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bunx vitest run src/features/chat/messageTags.test.ts`
预期：PASS（含既有 @file / skill / email 用例不回归）。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/messageTags.tsx tauri-agent/src/features/chat/messageTags.test.ts
git commit -m "feat(chat): render pasted URLs as link chips in bubbles"
```

---

### 任务 6：执行性命令分类（保守白名单，纯函数）

**文件：**
- 创建：`tauri-agent/src/features/chat/input/commandClassification.ts`
- 测试：`tauri-agent/src/features/chat/input/commandClassification.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `commandClassification.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { isExecutiveCommand, isExecutiveCommandMessage } from './commandClassification';

describe('isExecutiveCommand', () => {
  it('命中已知动作命令（忽略大小写 / skill: 前缀）', () => {
    expect(isExecutiveCommand('dream')).toBe(true);
    expect(isExecutiveCommand('newSession')).toBe(true);
    expect(isExecutiveCommand('COMPACT')).toBe(true);
  });
  it('提示词 / 技能 / 不确定命令保留气泡', () => {
    expect(isExecutiveCommand('skill:tdd')).toBe(false);
    expect(isExecutiveCommand('deep-research')).toBe(false);
    expect(isExecutiveCommand('review')).toBe(false);
  });
});

describe('isExecutiveCommandMessage', () => {
  it('仅当整条消息==单个执行性命令时为真', () => {
    expect(isExecutiveCommandMessage('/dream')).toBe(true);
    expect(isExecutiveCommandMessage('/dream foo')).toBe(true);
    expect(isExecutiveCommandMessage('/skill:tdd')).toBe(false);
    expect(isExecutiveCommandMessage('hello /dream')).toBe(false);
    expect(isExecutiveCommandMessage('please run dream')).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`bunx vitest run src/features/chat/input/commandClassification.test.ts`
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现 `commandClassification.ts`**

```ts
import { parseCommandToken } from './editor/commandPaste';

/**
 * 「执行性命令」白名单（保守）：发出后不产生对话轮次的纯动作命令。键统一小写。
 * 仅放确定项；不确定者（init/review/goal/deep-research 等）不放 → 默认保留气泡。
 */
export const EXECUTIVE_COMMANDS = new Set<string>([
  'compact', 'newsession', 'new',
  'dream', 'distill',
  'share', 'unshare', 'export', 'undo', 'redo',
  'model', 'models', 'theme', 'themes',
  'agent', 'agents', 'editor', 'mcp',
  'session', 'sessions', 'help', 'exit', 'quit',
]);

function bareName(name: string): string {
  return (name.startsWith('skill:') ? name.slice(6) : name).toLowerCase();
}

/** 命令名是否属于执行性命令（去 skill: 前缀、小写比较）。 */
export function isExecutiveCommand(name: string): boolean {
  return EXECUTIVE_COMMANDS.has(bareName(name));
}

/** 整条消息是否就是单个执行性命令（可带参数）→ 发送时不留气泡。 */
export function isExecutiveCommandMessage(text: string): boolean {
  const parsed = parseCommandToken(text);
  return parsed ? isExecutiveCommand(parsed.name) : false;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`bunx vitest run src/features/chat/input/commandClassification.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add tauri-agent/src/features/chat/input/commandClassification.ts tauri-agent/src/features/chat/input/commandClassification.test.ts
git commit -m "feat(chat): add executive command classification"
```

---

### 任务 7：`handleSend` 执行性命令短路（去幽灵气泡）

**文件：**
- 修改：`tauri-agent/src/features/chat/ChatView.tsx`（import 区 + 组件顶部 + `handleSend` 开头）

- [ ] **步骤 1：导入 antd App 与分类函数**

在 import 区加：

```ts
import { App } from 'antd';
import { isExecutiveCommandMessage } from './input/commandClassification';
```

- [ ] **步骤 2：取 message 实例（避免与 `handleSend` 的 `message` 形参重名）**

在 `export function ChatView()` 体内、`const { workspace, store, workspaceReady } = useAgentStoreContext();` 之后加：

```ts
  const { message: messageApi } = App.useApp();
```

- [ ] **步骤 3：在 `handleSend` 开头加短路**

在 `const handleSend = async (message, images, behavior) => {` 内，`userAbortedRef.current = false;` 之后、`if (behavior) {` 之前插入：

```ts
    // 执行性命令（/dream 等）：不产生对话轮次。跳过乐观气泡与 awaitingResponse，
    // 改瞬态 toast，仍 pi.prompt 让 Pi 执行——切换/重载后不再有幽灵气泡。
    if (text && isExecutiveCommandMessage(text)) {
      const cmd = text.split(/\s/, 1)[0];
      try {
        await pi.prompt(workspace, text, undefined, images);
        messageApi.info(`已执行 ${cmd}`);
      } catch (e) {
        messageApi.error(`${cmd} 执行失败：${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
```

- [ ] **步骤 4：类型检查**

运行：`bunx tsc --noEmit`
预期：零新增错误。

- [ ] **步骤 5：手动验证（dev）**

运行：`bun run dev`，在某对话发送 `/dream`：
预期：无 `/dream` 用户气泡；出现「已执行 /dream」瞬态提示 + 既有「Dream 已启动」notice；切换会话再回来，对话内容一致（无幽灵）。普通文本与 `/skill:xxx` 仍正常显示气泡。

- [ ] **步骤 6：Commit**

```bash
git add tauri-agent/src/features/chat/ChatView.tsx
git commit -m "feat(chat): suppress optimistic bubble for executive commands"
```

---

### 任务 8：整体校验

- [ ] **步骤 1：类型检查**

运行：`bunx tsc --noEmit`
预期：零错误。

- [ ] **步骤 2：跑相关单测**

运行：
```bash
bunx vitest run src/features/chat/input/editor/ChatTag/tagText.test.ts src/features/chat/input/editor/urlPaste.test.ts src/features/chat/messageTags.test.ts src/features/chat/input/commandClassification.test.ts
```
预期：全 PASS。

- [ ] **步骤 3：（可选）预览页加 link chip**

如需视觉回归，在 `src/preview.tsx` 的 chip 画廊加一枚 `<ChatTagView category="link" label="github.com/.../123" value="https://github.com/lobehub/lobe-chat/pull/123" />`，`bun run dev` 打开 `preview.html` 核对。

---

## 自检

**1. 规格覆盖度：**
- Part A 新增 `link` 类目（任务 1）、粘贴识别（任务 2-3）、chip 视觉（任务 4）、气泡渲染（任务 5）。覆盖。
- Part B 分类白名单 + `isExecutiveCommandMessage`（任务 6）、`handleSend` 短路 + 瞬态 toast（任务 7）。覆盖。
- 测试清单：tagText / urlPaste / messageTags / commandClassification 均有单测（任务 1/2/5/6）；发送分支以纯函数 `isExecutiveCommandMessage` 覆盖（任务 6），组件级行为以 dev 手验（任务 7 步骤 5）。

**2. 占位符扫描：** 无「待定 / TODO」；每个代码步骤含完整代码。

**3. 类型一致性：**
- `ChatTagData.category` 因 `ChatTagCategory` 加 `'link'` 而合法（任务 1 先行）。
- `resolveUrlTag`(任务 2) → `useUrlPaste`(任务 3) → `usePasteCapture.onUrlText`(任务 3) → `MessageEditor`(任务 3) 串联一致。
- `formatUrlLabel` 在任务 2 定义，任务 5 `messageTags` 引用一致。
- `isExecutiveCommandMessage` 任务 6 定义、任务 7 调用一致；`parseCommandToken` 复用既有 `editor/commandPaste.ts` 导出。
- `messageApi` 重命名避开 `handleSend(message)` 形参遮蔽（任务 7 步骤 2/3）。

## 非目标（YAGNI）

- 不让 URL 触发抓取（仅视觉）。
- 不改后端 / Pi 协议；命令 `kind` 仅作未来钩子，本计划不实现。
- 不把所有命令强渲染成气泡 chip。
- 不引入新依赖。
```
