# Agent Note: 输入框草稿整份保留：编辑器状态存 JSON，图片和粘贴块进 IndexedDB

Status: implemented

## Problem

底部输入框的「记忆」只记纯文本。`ChatInput` 每 300ms 把 `readComposerText` 的结果写进 `chatDraftStore`（localStorage `pi-chat-drafts`），切会话和重启时用 `writeComposerText` 写回。文本之外的东西都会丢：

- 命令胶囊：读出来是 `/名 "参数"` 的调用文本，写回去就是这串文字，胶囊没了。发送仍然有效（扩展只认 `/名` 开头），但界面上退化成普通文字，参数也不能再逐格填。
- `@文件` 标签、`/命令` 标签：同样退化成 `@路径` 文字。
- 图片、粘贴块、文件引用 chip：只放在 `composerFiles` 内存 store 里（当时的理由是 base64 写 localStorage 会撑爆配额）。切会话能带回来，重启就没了。

另外输入框上方的图片缩略图是裸 `<img>`，点不开，没法像气泡里的图那样放大看。

## Decision

### 草稿存 Lexical JSON，文本只做回退

`electron-agent/src/features/chat/input/editor/composerDraft.ts`：

- `readComposerDraft(editor)` 返回 `{ text, json? }`。`text` 仍是 `readComposerText` 的输出（发送、空态判断、消息编辑都还用它）；`json` 是 lobehub `getDocument('json')` 给的 `{ root }`，节点由各自的 `exportJSON` 写出（`CommandPillNode` 带 name / params / values，`ChatTagNode` 带 category / label / value）。文本为空时不带 json。
- `writeComposerDraft(editor, draft)`：有 json 就 `setDocument('json', json)`；解析抛错（节点类型没注册、格式变了）或没有 json 时退回 `writeComposerText(text)`。也接受纯字符串，老调用方和单测桩不用改。

`chatDraftStore` 的值是 `string | { text, json }`，`getDraft` 统一返回 `{ text, json? }`，老的字符串草稿读成 `{ text }`。`setDraft` 比较 text 和 json 序列化结果，没变不写。

`ChatInput` 存草稿（debounce、切会话、卸载）读 `readComposerDraft`，恢复走 `writeComposerDraft`。发送失败回填仍走文本：那条路径的快照本来就只有文本，失败时胶囊已经被 `cleanDocument` 清掉，按文本回填和原来一致。

不变量：恢复 JSON 要求编辑器已经注册了 `command-pill` / `chat-tag` 节点（`ReactCommandPillPlugin` / `ReactChatTagPlugin` 在 layout effect 里注册，`ChatInput` 的恢复 effect 在它们之后跑）。以后给输入框加新的行内节点，必须有 `importJSON` / `exportJSON`，否则那种节点的草稿会退回文本。

### 图片和粘贴块进 IndexedDB

`composerFiles` store 挂 zustand `persist`，storage 是 `electron-agent/src/lib/idbStorage.ts`（一个库一个 kv 对象仓，`getItem / setItem / removeItem` 都返回 Promise；`indexedDB` 不存在时退化成空操作，jsdom 单测下 store 行为和以前一样）。库名和 key 都是 `pi-composer-files`。

- `partialize` 只留 `byKey`，图片去掉 `url`（它是整份 data URL，和 `data` 重复一倍；blob URL 重启后也失效）。
- `merge` 时 `reviveComposerFiles` 按 `data:${mimeType};base64,${data}` 重建 `url`、丢掉形状不对的条目，再 `mergeComposerFiles` 把存档和内存合并、内存优先：hydration 是异步的，启动瞬间用户已经贴进去的东西不能被存档覆盖。
- 发送 / 移除到空时 `withBucket` 删桶，persist 跟着把这个 key 从存档里拿掉。

### 图片可放大

`InputChips` 里的 `<img>` 换成 `@lobehub/ui` 的 `Image`（48×48、`objectFit: cover`）并包 `Image.PreviewGroup`，和 `UserMessage` 一致：点开放大、多图左右切换（键盘 ←/→ 或两侧箭头）、Esc 关闭。移除按钮不动。缩略图容器带 `data-testid="composer-image"`。

## Alternatives considered

- **恢复时把 `/名 "参数"` 文本重新识别成胶囊、`@路径` 识别成标签**（复用 `resolvePromptPill`）：不改存储格式，只补恢复路径，[命令与规则](../architecture/2026-10-02-commands-rules-and-tool-surface.md) 的 Consequences 里就是这么预留的。没选它，因为要先拉命令列表才能认出胶囊，恢复变成异步；`@路径` 文字和用户真打的 `@` 分不开，标签的 isDirectory 也丢了；以后每加一种行内节点都要再写一套识别。JSON 是 Lexical 自己的序列化，节点自带 import / export，一次解决。
- **只存 JSON，不存文本**：少一份冗余。但 `getDraft` 的调用方和两份单测桩都按字符串用，老草稿也是字符串；JSON 解析失败时没有东西可退回。文本留着当回退和兼容层，代价是草稿体积多一份纯文本。
- **图片走主进程写到 userData 目录**：和会话、附件一样落在磁盘上，能用资源管理器看到。但要加 IPC、preload 字段和主进程服务，渲染层还要管文件名和清理；IndexedDB 在渲染层就能做，配额按磁盘比例算、够放几十 MB 图片，zustand `persist` 直接接上。
- **图片继续只放内存，只做 JSON 草稿**：改动最小。用户明确要重启也保留，不选。
- **继续用 localStorage 存图片，超大的跳过**：同步、简单。但一张截图 base64 就能到 1~2MB，localStorage 总共 5~10MB，几张就满，而且写满时 zustand persist 静默失败、连文本草稿都会丢。

## Consequences

- 切会话、重启后，胶囊（含填了一半的参数）、`@文件` 标签、图片、粘贴块都原样回来。旧的字符串草稿照常恢复成文本。
- 草稿体积：localStorage 里每份草稿多一份 Lexical JSON；图片在 IndexedDB，不占 localStorage。
- JSON 里带的是 Lexical 节点类型名和版本。lobehub / lexical 升级改了序列化格式，旧草稿会解析失败，退回文本，用户看到的是 `/名 "参数"` 文字，和以前一样。
- 草稿 key 还是按会话路径，会话删了 key 不会跟着删（文本草稿一直如此）。图片进 IndexedDB 后残留的体积更大。本次不处理，留给会话删除流程。
- `MessageEditBox`（编辑历史消息）仍按文本初始化，不走 JSON：它的初值来自已发出的消息文本，本来就没有胶囊节点。
- 取代了 [命令与规则](../architecture/2026-10-02-commands-rules-and-tool-surface.md) Consequences 里「草稿恢复胶囊会变回调用文本」那条；那条改为只描述发送失败回填。

## 验证

结果：通过。证据在 `.agents/evidence/2026-10-19-composer-draft-full-restore/`。

- `cd electron-agent && npx vitest run src/lib src/stores src/features/chat/input src/features/chat/ChatInput.test.tsx src/features/chat/messageEditFlow.test.tsx src/features/chat/MessageEditBox.test.tsx`：117 个文件、1006 条用例通过（`vitest.log`）。新增 `composerDraft.test.ts`（真实 Lexical 编辑器：读出的 JSON 带胶囊和标签、写回后胶囊参数 / 标签 / 文本原样、节点没注册时退回文本、字符串草稿和坏 json 走文本）、`chatDraftStore.test.ts`（字符串草稿读成 `{ text }`、内容没变不换引用、空草稿删 key）、`composerFiles.test.ts` 加了落盘去 url / 读回重建 url / 坏条目丢掉 / 合并内存优先。
- `cd electron-agent && node ui-harness/check.mjs composer-text`：25 条通过。新加的一步：真实 lobehub Editor 里插胶囊、填 `src/a.ts`、Tab 跳出、打字、插文件标签、再打字；`saveDraft` 存下带 JSON 的草稿、`clear` 清空、`restoreDraft` 写回，胶囊和标签都是装饰器节点、file 参数值不变、style 仍空、读出文本相同，接着打字发出的文本带调用文本和标签；只有文本的旧草稿恢复成纯文字没有胶囊。截图 `composer-text-draft-before.png` / `composer-text-draft-restored.png`。
- `cd electron-agent && node ui-harness/check.mjs composer-chips`：新场景，30 条通过。真实 InputChips + 真实 composerFiles store（挂着 IndexedDB persist）：两张 canvas 画的图加一个粘贴块，缩略图 48px；点第一张弹出放大预览（`[role="dialog"] img` 比缩略图大、src 是第一张）、计数「1 / 2」、点右侧箭头切到第二张、Esc 关掉；IndexedDB 里的存档有这个 key、图片条目没有 url、有 data；模拟重启（内存清空、存档不动）后 `rehydrate` 两张图和粘贴块都回来、url 由 data 重建；内存里已有的桶在 rehydrate 时优先；X 移除到空后存档里没有这个 key。截图 `composer-chips-chips.png` / `composer-chips-preview.png` / `composer-chips-rehydrated.png`。
- 只跑了这两个场景：`composer-text` 引用 `composerDraft.ts`，`composer-chips` 是新场景。工作区里别的未提交改动很多，没有用 `--changed`。
- 真实 app 里关掉再开的那一步没有由我跑：`electron-vite build` 的主进程阶段被正在运行的 app 占着的 `pi-job-guard.exe` 挡住（EBUSY），渲染层 3611 个模块转换通过，`App.tsx` 和改动文件的 `tsc` 单独检查无报错。
