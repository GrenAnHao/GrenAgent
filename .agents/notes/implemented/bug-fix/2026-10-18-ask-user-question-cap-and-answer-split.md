# Agent Note: 提问卡超过 8 题被静默截断、答案在题目冒号处切错

Status: implemented

## Problem

用户实测一次 11 题的 `ask_user`：卡片翻到第 8 题就出现「提交」，第 9–11 题从没出现过；提交后「已回答」卡列出 11 道题目，后 3 道没有答案。同一张卡上已答的题，答案前面还粘着半截题目，例如「每条回复一条扣点流水）：每条回复一条（推荐）」。

两个独立的原因：

1. `extensions/agent-mode/questions.ts` 的 `normalizeQuestions` 把题目截到 `MAX_QUESTIONS = 8`，只在扩展 stderr 打一行日志。前端分页卡只拿到 8 题，第 8 题就是最后一页；模型拿到的 `[我的选择]` 也只有 8 行，它不知道另外 3 题没问出去。「已回答」卡的题目取自工具调用参数（11 题），答案取自结果（8 条），所以对不齐。
2. 回传文本格式是 `N. 题目：选项`，`parseAnswerBlock` 取每行**第一个**全角冒号。模型被要求在题目里写推荐（`…（推荐：…）`），题目自带冒号，切点落在题目中间。

## Decision

- `MAX_QUESTIONS` 改为 20。卡片按题分页，一屏一题，题多不会撑高卡片；8 这个上限当初按「整张卡的体量」定，分页后已经不成立。
- 上限写进工具 schema：`questions` 的 `maxItems: MAX_QUESTIONS`，描述写明「最多 20 题」。pi-ai 的 `validateToolArguments` 用 TypeBox 编译校验，超过时模型直接拿到校验错误、自己拆成两次，**never** 再静默截断。
- `normalizeQuestions` 仍然截断（防绕过校验的调用），截断时 `truncationNotice` 把「第 21–N 题没有展示、没有答案，需要再问一次」追加进工具结果，阻塞和非阻塞两条返回路径都带。
- `parseAnswerBlock(text, titles?)`：传了题目全文就按 `题目：` 前缀切；没传或对不上时取**括号外**的第一个全角冒号（括号含（）()【】[]「」『』《》）。`AnsweredQuestionsCard` 把调用参数里每题 trim 后的全文传进去，与扩展写进卡片、`formatAnswers` 回传时用的是同一份题目。

## Alternatives considered

- **只放宽上限，不加 schema 约束。** 改动最小，眼下的 11 题就能过。但上限仍然只存在于扩展内部，模型看不到，下次超了还是静默截断，问题只是往后推。
- **去掉上限。** 分页后题数对界面没有压力，理由最直接。但一次调用塞几十道题本身就是模型用法出了问题，载荷也会跟着涨；给一个模型看得见的上限，超了让它拆，比无限制更可控。
- **回传格式改成结构化（JSON 或带分隔符），彻底不靠冒号。** 最稳。但 `[我的选择]` 文本是模型读的工具结果，也是历史会话里已经落盘的格式；改格式要兼容所有旧会话，还会让模型读到更机械的文本。按已知题目切 + 括号外冒号回退，已经覆盖新旧两种数据。

## Consequences

- **收益**：20 题以内全部能答；超过时模型和用户都知道哪些题没问。「已回答」卡的答案不再粘半截题目，旧会话重新打开同样按新规则解析。
- **代价**：题目里如果有括号外的裸全角冒号，又没有调用参数可对照（`ToolExecution` 只用 `parseAnswers` 数个数），回退规则仍会切错；只影响显示，不影响模型拿到的原文。
- **重访信号**：又见到「提交按钮提前出现」或「已回答卡后几题空白」，先查 `MAX_QUESTIONS` 与 schema 的 `maxItems` 是否还一致。

## Verification

- `cd extensions && npx vitest run agent-mode/questions.test.ts prompt-metadata.test.ts` → 2 文件 / 16 用例通过（新增：11 题全部保留；超过上限截断并给出「第 21–23 题」说明；空白题不计数）。
- `cd electron-agent && npx vitest run src/components/QuestionSelector src/features/tools/AnsweredQuestionsCard.test.tsx src/features/tools/ToolExecution.test.tsx` → 4 文件 / 72 用例通过（新增：题目含「（推荐：…）」时答案不粘题目；传入题目全文时题目里的裸冒号也切对）。
- 临时用例（跑完已删）：取 `agent-mode` 注册出的真实 `ask_user` 定义，过 pi-ai `validateToolArguments`，11 题通过、21 题抛出 `questions` 校验错误。
- 没有在真实界面里再发一次 11 题的提问：`verify: n/a` 需要真实模型发起调用；分页卡本身没改，只是拿到的题数变了，由上面的单测和 schema 校验覆盖。
