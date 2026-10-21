# Agent Note: 输入框正文原样发出，不再经过 remark 转义

Status: implemented

## Problem

底部输入框和消息编辑框发出去的文字和用户打的不一样。打 `a * b [x] foo_bar ~t~`，发出去是 `a \* b \[x] foo\_bar \~t\~`。另外几种改写更隐蔽：

- `* one` / `+ two` 开头的行被改成 `- one`，前后还多出空行。
- 续行的缩进被吃掉，`    return 1` 变成 `return 1`。短代码直接打进输入框时，缩进全丢。
- `&amp;` 被解码成 `&`，`x<y` 变成 `x\<y`，邮箱被包成 `<user@gmail.com>`。

原因在 `readComposerText`。它读的是 `editor.getDocument('markdown')`，而 @lobehub/editor 4.27 的 `MarkdownDataSource.write` 拼好 markdown 后，还会用 remark + remark-gfm 再 parse 一遍、stringify 一遍（`formatMarkdown`）。用户打的是纯文本，被当成 markdown 重新排了版。之前的 `unescapeComposerMarkdown` 只还原了 `\_`、`\@` 和邮箱尖括号，别的转义照样发出去。这种黑名单补不完，而且用户故意打的 `\_` 也会被它吃掉反斜杠。

回填方向也有同样的问题：草稿恢复、发送失败回填、编辑消息、撤回引导都走 `setDocument('markdown', text)`，纯文本被当成 markdown 解析后再放进输入框。

## Decision

输入框的读写都按纯文本处理，不经过 markdown：

- `readComposerText` 直接遍历 Lexical 树（`$readComposerPlainText`）。文本节点原样输出。块与块之间写一个 `\n`：这个编辑器里 Shift+Enter 插的是新段落（lobehub 的 `INSERT_LINE_BREAK_COMMAND` 改派成 `INSERT_PARAGRAPH_COMMAND`），段落就是用户看到的行。命令胶囊写 `PILL_MARKER`，之后照旧由 `substitutePillMarker` 换成调用文本并挪到最前。其余节点用自己的 `getTextContent`：文件标签是 `@路径`，命令标签是 `/名称`，链接是 URL。光标占位符 `\uFEFF` 去掉。
- 回填统一走 `writeComposerText`，内部是 `setDocument('text', text)`（lobehub 的 `TextDataSource`，每行一个段落）。CRLF 先统一成 LF。空文本照旧走 `cleanDocument`。读和写互逆：写进去再读出来，文本一个字都不变。
- 删掉 `unescapeComposerMarkdown`。
- 拿不到 Lexical 实例时（只在单测桩里出现）退回 `getDocument('text')`。

改动在 `electron-agent/src/features/chat/input/editor/CommandPill/composerText.ts`。调用方是 `ChatInput.tsx`（发送、草稿、`setValue`、发送失败回填）和 `MessageEditBox.tsx`（初值、`setValue`）。

### 不变量

- 输入框开着 `markdownOption: false`，里面没有富文本格式。以后要是给输入框打开 markdown 格式或列表插件，这里得重新决定加粗、列表怎么写成文本。
- 新加的行内节点要有正确的 `getTextContent`，那就是它发出去的文本。像胶囊这样需要特殊处理的，在 `$plainText` 里单独判断。
- 胶囊和标签的 markdown writer 还在，lobehub 自己复制选区时会用到。发送路径不再用它们。

## Alternatives considered

- **继续扩充去转义的黑名单**（再还原 `\*`、`\[`、`\~`……）：改动最小，只碰一个函数，这是它最强的理由。不用它，是因为 remark 不只加反斜杠：列表符改写、缩进丢失、`&amp;` 解码、插入空行都是结构性的改写，反向还原不回来。用户故意打的 `\*` 也会和 remark 加的分不开。
- **改用 lobehub 自带的 `getDocument('text')`**：现成的 API，不用自己遍历树。但它底下是 Lexical 的 `$getRoot().getTextContent()`，块之间写两个换行。用户 Shift+Enter 换一行，发出去变成空一行，写回再读出来行数还会翻倍。胶囊在里面直接是调用文本，没有标记，`substitutePillMarker` 就没法把它挪到最前面。
- **让 lobehub 跳过 `formatMarkdown`**：库没有这个选项，只能 patch 依赖。patch 掉以后 writer 拼出的仍然是 markdown 语义（段落、标签走各自的 writer），而输入框本来就没有 markdown，用不着这一层。

## Consequences

用户打什么就发什么，存草稿也存原文，`*`、`_`、`[`、`~`、`\`、缩进、列表符、HTML 实体都保持原样。

模型现在会原样收到 `**粗体**`、`# 标题` 这类 markdown，以前也是这样（remark 会保留它们），所以没有新变化。以前加的反斜杠会让模型多看到一层转义，这一层现在没有了。

旧草稿是去转义之后的文本，按纯文本读回，没有迁移问题。旧草稿里如果还留着 remark 加的 `\*`，会原样显示出来，用户删掉就行。

编辑历史消息时，原文按纯文本放进编辑框。以前 `1. a` 这类行会先被当成 markdown 解析，现在就是原文。

## Verification

结果：通过（真实剪贴板粘贴那一步因为环境原因没跑成，见最后一条）。

- `cd electron-agent && npx vitest run src/features/chat/input/editor/CommandPill/composerText.test.ts src/features/chat/ChatInput.test.tsx src/features/chat/messageEditFlow.test.tsx src/features/chat/MessageEditBox.test.tsx src/features/chat/input/editor/CommandPill`：8 个文件、58 条用例通过。`composerText.test.ts` 用真实 Lexical 编辑器验证：特殊字符、缩进、列表符、Windows 路径原样读出，没有调用 `getDocument`；标签写成 `@路径`；胶囊调用文本放在最前；写回再读出文本不变。日志在 `.agents/evidence/2026-10-19-composer-plain-text/vitest.log`。
- `cd electron-agent && node ui-harness/check.mjs composer-text`：新场景，10 条全部 PASS。场景用真实的 lobehub Editor，参数照 `MessageEditor` 配。用真实按键打 `a * b [x] arr[0] ~t~ foo_bar 2*3=6 &amp; x<y`，再用 Shift+Enter 打出缩进行、`* one`、`+ two`、`# not heading`，回车发出的文本和键入的完全一样。同一份内容在旧路径 `getDocument('markdown')` 下的输出也记进了日志：`a \* b \[x] arr\[0] \~t\~ foo\_bar 2\*3=6 & x\<y\ndef f():\nreturn 1\n\n- one\n\n* two…`。其余几条：带缩进和制表符的多行代码原样发出；文件标签加文本发出 `@src/a_b.ts look *args`；回填后没有列表节点、每行一个段落、读出和写进去相同，接着打字再发也不变；CRLF 统一成 LF。日志和截图在 `.agents/evidence/2026-10-19-composer-plain-text/`。
- `cd electron-agent && node ui-harness/check.mjs command-pill`：它也用 `readComposerText`，41 条通过，2 条失败。失败的两条都是「真实粘贴进参数」。这台机器的系统剪贴板写不进去：PowerShell `Set-Clipboard` 报「所请求的剪贴板操作失败」，Electron `clipboard.writeText` 之后读回来是空串，放开沙箱权限也一样。跟本次改动没有关系，胶囊发送、拦截、Tab 轮转相关的断言都通过了。`composer-text` 的粘贴步骤在剪贴板不可用时会写 INFO，然后改走 lobehub `handlePlainTextPaste` 拿到文本之后派发的那条 `CONTROLLED_TEXT_INSERTION_COMMAND`。所以这次验证到的是粘贴的后半段，`webContents.paste()` 这一段没有跑到。
- 只跑了 `composer-text` 和 `command-pill`，只有这两个场景引用了 `composerText.ts`。工作区里别的未提交改动很多，所以没有用 `--changed`。
