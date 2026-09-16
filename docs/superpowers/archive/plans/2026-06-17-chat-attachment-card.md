# 聊天附件卡片 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把用户消息里粘贴的长文本块 / 拖入的文件块，在发送后的对话气泡里渲染成可折叠的「附件卡片」（默认折叠单行、点击展开、限高滚动），取代当前整段铺开的纯文本。

**架构：** 采用「文本边界标记 + 渲染解析」（设计方案 A）。发送时 `composeMessage` 用 `wrapAttachment` 把每个附件块包成 `<pi:attachment>` XML 标记拼进文本；渲染时 `UserMessage` 用 `parseAttachments` 把消息 text 切成正文段与附件段，正文段走现有 `@路径` 渲染、附件段渲染成 `AttachmentCard`。包裹与解析是同一契约，集中在 `features/chat/attachment.ts`，实时发送与历史恢复因此自动一致。

**技术栈：** React 19 + TypeScript、`@lobehub/ui`（`Icon`）+ `lucide-react`、antd-style（`createStaticStyles` + `cssVar`）、Vitest + `@testing-library/react`（jsdom 已配置）。

**规格：** `docs/superpowers/specs/2026-06-17-chat-attachment-card-design.md`

**运行目录：** 所有命令在 `tauri-agent/` 下执行。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `tauri-agent/src/features/chat/attachment.ts` | 新增。标记契约单一来源：`AttachmentBlock` 类型、`wrapAttachment`（包裹 + 转义）、`parseAttachments`（解析 + 容错）。 |
| `tauri-agent/src/features/chat/attachment.test.ts` | 新增。契约单测：包裹格式、解析各组合、往返还原、转义、未闭合回退、向后兼容。 |
| `tauri-agent/src/features/chat/AttachmentCard.tsx` | 新增。折叠卡片展示组件（折叠单行 / 点击展开 / 限高滚动）。 |
| `tauri-agent/src/features/chat/AttachmentCard.test.tsx` | 新增。组件测试：折叠态文案、展开切换。 |
| `tauri-agent/src/features/chat/input/editor/composeMessage.ts` | 修改。附件块改用 `wrapAttachment`，替换现有「纯文本直接追加 / 文件块动态围栏」。 |
| `tauri-agent/src/features/chat/input/editor/composeMessage.test.ts` | 修改。更新断言为带 `<pi:attachment>` 标记的输出。 |
| `tauri-agent/src/features/chat/UserMessage.tsx` | 修改。用 `parseAttachments` 切段：正文进气泡、附件段在气泡外渲染 `AttachmentCard`。 |
| `tauri-agent/src/features/chat/UserMessage.test.tsx` | 新增。验证带标记的 text 渲染出气泡正文 + 附件卡片。 |

依赖顺序：任务 1（契约）→ 任务 2（composeMessage 接入）/ 任务 3（卡片组件）可并行 → 任务 4（UserMessage 接入，依赖 1 与 3）。

---

## 任务 1：标记契约 `attachment.ts`

**文件：**
- 创建：`tauri-agent/src/features/chat/attachment.ts`
- 测试：`tauri-agent/src/features/chat/attachment.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `tauri-agent/src/features/chat/attachment.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { wrapAttachment, parseAttachments, type AttachmentBlock } from './attachment';

describe('wrapAttachment', () => {
  it('text 块输出 type/lines/chars 属性', () => {
    expect(
      wrapAttachment({ attType: 'text', lines: 2, chars: 11, content: 'line1\nline2' }),
    ).toBe('<pi:attachment type="text" lines="2" chars="11">\nline1\nline2\n</pi:attachment>');
  });

  it('file 块输出 type/path/lines（不含 chars）', () => {
    expect(
      wrapAttachment({ attType: 'file', path: 'src/a.ts', lines: 1, chars: 11, content: 'const x = 1' }),
    ).toBe('<pi:attachment type="file" path="src/a.ts" lines="1">\nconst x = 1\n</pi:attachment>');
  });
});

describe('parseAttachments', () => {
  it('无标记返回单个 text 段（向后兼容）', () => {
    expect(parseAttachments('plain text')).toEqual([{ type: 'text', text: 'plain text' }]);
  });

  it('切出正文段与附件段', () => {
    const text =
      '看这个\n\n<pi:attachment type="file" path="src/a.ts" lines="1">\nconst x = 1\n</pi:attachment>';
    expect(parseAttachments(text)).toEqual([
      { type: 'text', text: '看这个\n\n' },
      {
        type: 'attachment',
        block: { attType: 'file', path: 'src/a.ts', lines: 1, chars: undefined, content: 'const x = 1' },
      },
    ]);
  });

  it('解析多个附件段', () => {
    const text =
      '<pi:attachment type="text" lines="1" chars="1">\na\n</pi:attachment>\n\n' +
      '<pi:attachment type="text" lines="1" chars="1">\nb\n</pi:attachment>';
    const parts = parseAttachments(text);
    const blocks = parts.filter((p) => p.type === 'attachment');
    expect(blocks).toHaveLength(2);
  });

  it('未闭合标签整体回退为 text', () => {
    const text = '看 <pi:attachment type="text" lines="1">\nno close';
    expect(parseAttachments(text)).toEqual([{ type: 'text', text }]);
  });

  it('内容含字面 </pi:attachment> 经转义后能正确还原', () => {
    const block: AttachmentBlock = {
      attType: 'text',
      lines: 1,
      chars: 20,
      content: 'a </pi:attachment> b',
    };
    const parts = parseAttachments(wrapAttachment(block));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: 'attachment', block: { ...block, path: undefined } });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/features/chat/attachment.test.ts`
预期：FAIL，报错 `Failed to resolve import './attachment'` 或 `wrapAttachment is not a function`。

- [ ] **步骤 3：编写实现**

创建 `tauri-agent/src/features/chat/attachment.ts`：

```ts
/** 用户消息里附件块的结构化表示（粘贴文本 / 拖入文件）。 */
export interface AttachmentBlock {
  attType: 'file' | 'text';
  /** 文件块的相对路径 / 文件名；文本块为 undefined。 */
  path?: string;
  lines: number;
  /** 文本块的字符数；文件块省略。 */
  chars?: number;
  content: string;
}

/** 渲染用：消息切成的有序段。 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'attachment'; block: AttachmentBlock };

// 转义：避免内容里字面 </pi:attachment> 提前闭合标签（插入零宽字符，解析时还原）。
const LITERAL_CLOSE = '</pi:attachment>';
const ESCAPED_CLOSE = '</pi:attachment\u200b>';

function escapeContent(s: string): string {
  return s.split(LITERAL_CLOSE).join(ESCAPED_CLOSE);
}
function unescapeContent(s: string): string {
  return s.split(ESCAPED_CLOSE).join(LITERAL_CLOSE);
}

// 属性值转义（path 可能含特殊字符）。
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** 把附件块包成 <pi:attachment> 文本。供 composeMessage 用。 */
export function wrapAttachment(block: AttachmentBlock): string {
  const attrs: string[] = [`type="${block.attType}"`];
  if (block.attType === 'file' && block.path) attrs.push(`path="${escapeAttr(block.path)}"`);
  attrs.push(`lines="${block.lines}"`);
  if (block.attType === 'text' && block.chars != null) attrs.push(`chars="${block.chars}"`);
  return `<pi:attachment ${attrs.join(' ')}>\n${escapeContent(block.content)}\n</pi:attachment>`;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out[m[1]] = unescapeAttr(m[2]);
  return out;
}

/** 把消息 text 切成正文段与附件段。解析失败的片段回退为 text，绝不抛错。供 UserMessage 用。 */
export function parseAttachments(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const re = /<pi:attachment\s+([^>]*)>\n?([\s\S]*?)\n?<\/pi:attachment>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) });
    const attrs = parseAttrs(m[1]);
    parts.push({
      type: 'attachment',
      block: {
        attType: attrs.type === 'file' ? 'file' : 'text',
        path: attrs.path,
        lines: Number(attrs.lines) || 0,
        chars: attrs.chars != null ? Number(attrs.chars) : undefined,
        content: unescapeContent(m[2]),
      },
    });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  if (parts.length === 0) parts.push({ type: 'text', text });
  return parts;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/features/chat/attachment.test.ts`
预期：PASS（全部用例通过）。

- [ ] **步骤 5：Commit**

```bash
git add src/features/chat/attachment.ts src/features/chat/attachment.test.ts
git commit -m "feat(attachment): pi:attachment wrap/parse contract"
```

---

## 任务 2：`composeMessage` 接入 `wrapAttachment`

**文件：**
- 修改：`tauri-agent/src/features/chat/input/editor/composeMessage.ts`
- 测试：`tauri-agent/src/features/chat/input/editor/composeMessage.test.ts`

- [ ] **步骤 1：更新测试为带标记的输出（先失败）**

把 `composeMessage.test.ts` 中两个涉及块格式的用例替换为如下断言（其余用例不变）：

```ts
  it('粘贴块用 pi:attachment text 标记包裹', () => {
    expect(composeMessage('看这段', [pasted('line1\nline2')])).toBe(
      '看这段\n\n<pi:attachment type="text" lines="2" chars="11">\nline1\nline2\n</pi:attachment>',
    );
  });

  it('正文为空时只发送被标记的粘贴块', () => {
    expect(composeMessage('', [pasted('only pasted')])).toBe(
      '<pi:attachment type="text" lines="1" chars="11">\nonly pasted\n</pi:attachment>',
    );
  });

  it('多个粘贴块按顺序各自包裹', () => {
    expect(composeMessage('x', [pasted('a'), pasted('b')])).toBe(
      'x\n\n<pi:attachment type="text" lines="1" chars="1">\na\n</pi:attachment>' +
        '\n\n<pi:attachment type="text" lines="1" chars="1">\nb\n</pi:attachment>',
    );
  });

  it('拖入文件块用 pi:attachment file 标记标注相对路径', () => {
    const fileBlock: PastedText = { id: 'f', text: 'const x = 1', lines: 1, chars: 11, source: 'src/a.ts' };
    expect(composeMessage('看这个', [fileBlock])).toBe(
      '看这个\n\n<pi:attachment type="file" path="src/a.ts" lines="1">\nconst x = 1\n</pi:attachment>',
    );
  });
```

注意：`pasted('only pasted')` 的 `chars` 为字符串长度（`'only pasted'`.length === 11）。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/features/chat/input/editor/composeMessage.test.ts`
预期：FAIL（现有实现输出旧的围栏 / 直接追加格式）。

- [ ] **步骤 3：改写 `composeMessage.ts`**

把 `composeMessage.ts` 整体替换为：

```ts
import { wrapAttachment } from '../../attachment';
import type { PastedText } from './types';

/**
 * 把编辑器序列化出的 markdown 与暂存的「粘贴文本 / 文件块」拼成最终发送文本。
 * 每个块用 <pi:attachment> 标记包裹（见 features/chat/attachment.ts），
 * 渲染侧据此切出附件卡片；块按插入顺序附在正文之后，块间空行分隔。
 */
export function composeMessage(markdown: string, pastedTexts: PastedText[]): string {
  const base = markdown.trim();
  const blocks = pastedTexts
    .map((p) => {
      const content = p.text.replace(/\s+$/, '');
      if (!content) return '';
      return wrapAttachment({
        attType: p.source ? 'file' : 'text',
        path: p.source,
        lines: p.lines,
        chars: p.chars,
        content,
      });
    })
    .filter(Boolean);
  return [base, ...blocks].filter(Boolean).join('\n\n');
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/features/chat/input/editor/composeMessage.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/features/chat/input/editor/composeMessage.ts src/features/chat/input/editor/composeMessage.test.ts
git commit -m "feat(attachment): emit pi:attachment markers in composeMessage"
```

---

## 任务 3：`AttachmentCard.tsx` 折叠卡片

**文件：**
- 创建：`tauri-agent/src/features/chat/AttachmentCard.tsx`
- 测试：`tauri-agent/src/features/chat/AttachmentCard.test.tsx`

- [ ] **步骤 1：编写失败的测试**

创建 `tauri-agent/src/features/chat/AttachmentCard.test.tsx`：

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AttachmentCard } from './AttachmentCard';

describe('AttachmentCard', () => {
  it('file 卡显示文件名与行数, 折叠态不显示内容', () => {
    render(<AttachmentCard block={{ attType: 'file', path: 'src/config.ts', lines: 42, content: 'secret' }} />);
    expect(screen.getByText('config.ts')).toBeTruthy();
    expect(screen.getByText('42 行')).toBeTruthy();
    expect(screen.queryByText('secret')).toBeNull();
  });

  it('text 卡显示粘贴文本与行数字数', () => {
    render(<AttachmentCard block={{ attType: 'text', lines: 120, chars: 3210, content: 'log' }} />);
    expect(screen.getByText('粘贴文本')).toBeTruthy();
    expect(screen.getByText('120 行 · 3.2k 字')).toBeTruthy();
  });

  it('点击头部展开后显示内容', () => {
    render(<AttachmentCard block={{ attType: 'file', path: 'a.ts', lines: 1, content: 'const x = 1' }} />);
    fireEvent.click(screen.getByText('a.ts'));
    expect(screen.getByText('const x = 1')).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/features/chat/AttachmentCard.test.tsx`
预期：FAIL，报错无法解析 `./AttachmentCard`。

- [ ] **步骤 3：编写实现**

创建 `tauri-agent/src/features/chat/AttachmentCard.tsx`：

```tsx
import { memo, useState } from 'react';
import { Icon } from '@lobehub/ui';
import { ChevronRight, ClipboardList, FileText } from 'lucide-react';
import { createStaticStyles, cssVar, cx } from 'antd-style';
import type { AttachmentBlock } from './attachment';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    width: 100%;
    min-width: 260px;
    max-width: 480px;
    overflow: hidden;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorFillTertiary};
  `,
  head: css`
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    cursor: pointer;
    user-select: none;

    &:hover {
      background: ${cssVar.colorFillSecondary};
    }
  `,
  ico: css`
    display: flex;
    flex-shrink: 0;
    color: ${cssVar.colorTextSecondary};
  `,
  title: css`
    overflow: hidden;

    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  meta: css`
    flex-shrink: 0;
    margin-left: auto;
    padding-left: 8px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    white-space: nowrap;
  `,
  chev: css`
    display: flex;
    flex-shrink: 0;
    color: ${cssVar.colorTextTertiary};
    transition: transform 0.15s ease;
  `,
  chevOpen: css`
    transform: rotate(90deg);
  `,
  body: css`
    overflow: auto;

    max-height: 240px;
    margin: 0;
    padding: 8px 10px;
    border-top: 1px solid ${cssVar.colorBorderSecondary};

    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.55;
    color: ${cssVar.colorText};
    white-space: pre;

    background: ${cssVar.colorBgContainer};
  `,
}));

function baseName(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function titleOf(block: AttachmentBlock): string {
  return block.attType === 'file' && block.path ? baseName(block.path) : '粘贴文本';
}

function metaOf(block: AttachmentBlock): string {
  if (block.attType === 'text' && block.chars != null) {
    return `${block.lines} 行 · ${formatChars(block.chars)} 字`;
  }
  return `${block.lines} 行`;
}

function AttachmentCardInner({ block }: { block: AttachmentBlock }) {
  const [open, setOpen] = useState(false);
  const icon = block.attType === 'file' ? FileText : ClipboardList;
  return (
    <div className={styles.card}>
      <div className={styles.head} onClick={() => setOpen((v) => !v)} title={block.path}>
        <span className={styles.ico}>
          <Icon icon={icon} size={15} />
        </span>
        <span className={styles.title}>{titleOf(block)}</span>
        <span className={styles.meta}>{metaOf(block)}</span>
        <span className={cx(styles.chev, open && styles.chevOpen)}>
          <Icon icon={ChevronRight} size={14} />
        </span>
      </div>
      {open ? <pre className={styles.body}>{block.content}</pre> : null}
    </div>
  );
}

export const AttachmentCard = memo(AttachmentCardInner);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/features/chat/AttachmentCard.test.tsx`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/features/chat/AttachmentCard.tsx src/features/chat/AttachmentCard.test.tsx
git commit -m "feat(attachment): collapsible AttachmentCard component"
```

---

## 任务 4：`UserMessage` 接入解析与卡片

**文件：**
- 修改：`tauri-agent/src/features/chat/UserMessage.tsx`
- 测试：`tauri-agent/src/features/chat/UserMessage.test.tsx`

- [ ] **步骤 1：编写失败的测试**

创建 `tauri-agent/src/features/chat/UserMessage.test.tsx`：

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserMessage } from './UserMessage';

describe('UserMessage', () => {
  it('把 pi:attachment 标记渲染成附件卡片, 正文进气泡', () => {
    const text =
      '看这个\n\n<pi:attachment type="file" path="src/config.ts" lines="42">\nconst x = 1\n</pi:attachment>';
    render(<UserMessage text={text} />);
    expect(screen.getByText('看这个')).toBeTruthy();
    expect(screen.getByText('config.ts')).toBeTruthy();
    expect(screen.getByText('42 行')).toBeTruthy();
    // 折叠态不直接显示文件内容
    expect(screen.queryByText('const x = 1')).toBeNull();
  });

  it('无标记的纯文本按原样渲染', () => {
    render(<UserMessage text={'hello world'} />);
    expect(screen.getByText('hello world')).toBeTruthy();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm exec vitest run src/features/chat/UserMessage.test.tsx`
预期：FAIL（当前 `UserMessage` 把标记当普通文本，找不到 `config.ts` 卡片标题）。

- [ ] **步骤 3：改写 `UserMessage.tsx`**

把 `UserMessage.tsx` 整体替换为：

```tsx
import { memo, type CSSProperties } from 'react';
import { Image } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { ChatItemShell } from './ChatItemShell';
import { chatStyles } from './chatStyles';
import { renderMessageTags } from './messageTags';
import { parseAttachments } from './attachment';
import { AttachmentCard } from './AttachmentCard';
import type { UserImage } from '../../stores/agentReducer';

interface UserMessageProps {
  text: string;
  images?: UserImage[];
}

const styles = createStaticStyles(({ css }) => ({
  col: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
    max-width: 100%;
  `,
}));

const gridStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

function UserMessageInner({ text, images }: UserMessageProps) {
  const parts = parseAttachments(text);
  const bodyText = parts
    .filter((p) => p.type === 'text')
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();
  const attachments = parts.flatMap((p) => (p.type === 'attachment' ? [p.block] : []));
  const hasImages = Boolean(images?.length);
  const hasBubble = hasImages || bodyText.length > 0;

  return (
    <ChatItemShell placement="right" bubble={false}>
      <div className={styles.col}>
        {hasBubble ? (
          <div className={chatStyles.bubble}>
            {hasImages ? (
              <Image.PreviewGroup>
                <div style={{ ...gridStyle, marginBottom: bodyText ? 8 : 0 }}>
                  {images!.map((img, i) => (
                    <Image
                      key={i}
                      alt=""
                      src={`data:${img.mimeType};base64,${img.data}`}
                      maxWidth={220}
                      maxHeight={220}
                      styles={{ image: { borderRadius: 8 } }}
                    />
                  ))}
                </div>
              </Image.PreviewGroup>
            ) : null}
            {bodyText ? (
              <span style={{ whiteSpace: 'pre-wrap' }}>{renderMessageTags(bodyText)}</span>
            ) : null}
          </div>
        ) : null}
        {attachments.map((block, i) => (
          <AttachmentCard key={i} block={block} />
        ))}
      </div>
    </ChatItemShell>
  );
}

export const UserMessage = memo(UserMessageInner);
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm exec vitest run src/features/chat/UserMessage.test.tsx`
预期：PASS。

- [ ] **步骤 5：全量回归 + 类型检查**

运行：`pnpm exec vitest run src/features/chat/`
预期：本目录测试全 PASS（含未改动的现有用例）。

运行：`pnpm exec tsc --noEmit`
预期：无类型错误。

- [ ] **步骤 6：Commit**

```bash
git add src/features/chat/UserMessage.tsx src/features/chat/UserMessage.test.tsx
git commit -m "feat(attachment): render attachment cards in user message bubble"
```

- [ ] **步骤 7：手动验证（构建后）**

启动应用，发送一段超过 12 行 / 1500 字符的粘贴文本，再拖入一个文本文件发送。预期：
- 用户气泡下方出现折叠的附件卡片（单行：图标 + 标题 + 行数）。
- 点击卡片头部展开，内容区限高滚动；再点收起。
- 切换到别的会话再切回，历史消息里的附件仍折叠成卡片（验证历史一致）。

---

## 自检

**1. 规格覆盖度（对照设计 §3–§9）**
- 方案 A（文本标记 + 解析）→ 任务 1（契约）+ 任务 2（发送）+ 任务 4（渲染）。
- XML 标记格式 `<pi:attachment>` + 转义 → 任务 1 `wrapAttachment` / `escapeContent`。
- 默认折叠单行 / 展开限高 240px 滚动 → 任务 3 `AttachmentCard`。
- 卡片在气泡外右对齐 → 任务 4 `styles.col` + `bubble={false}`。
- 错误回退 / 向后兼容 → 任务 1 `parseAttachments`（未闭合回退、无标记单段）+ 任务 4「无标记纯文本」用例。
- 覆盖范围（文本块 + 文件块；图片 / @引用不变）→ 任务 2 区分 `source`、任务 4 保留 `images` 与 `renderMessageTags`。
- 测试清单 → 任务 1/2/3/4 各步骤测试。

**2. 占位符扫描：** 无「待定 / TODO」；所有步骤含可运行的实际代码与命令。

**3. 类型一致性：** `AttachmentBlock` / `MessagePart` 在任务 1 定义，任务 2（`wrapAttachment`）、任务 3（`AttachmentCard` props）、任务 4（`parseAttachments` 返回）一致引用；方法名 `wrapAttachment` / `parseAttachments` 全程一致；`AttachmentCard` props 为 `{ block: AttachmentBlock }`，任务 4 按此传入。

---

## 风险与回退

- `cssVar.colorBgContainer` / `colorFillSecondary` / `colorTextTertiary` 若在当前主题不可用，回退用 `colorBgElevated` / `colorFillTertiary` / `colorTextSecondary`（`InputChips` 已验证后三者可用）。
- 解析所有异常路径回退为纯文本段，最坏情况等价现有「整段铺开」，不会崩溃或丢内容。
- 旧历史里 ```` ```path ```` 文件块不再识别为卡片（按 markdown 代码块显示），属预期的向后兼容行为。
