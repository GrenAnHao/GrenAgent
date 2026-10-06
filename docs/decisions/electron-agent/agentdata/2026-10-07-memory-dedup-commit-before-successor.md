---
title: 去重期间游标不提交的批次仍算进行中，后继抽取等 completeDedup 提交后再接续；去重 Input 不再重复 matches
status: active
date: 2026-10-07
scope: electron-agent/agentdata
files:
  - electron-agent/electron/app/memoryService.ts
  - electron-agent/electron/pi/systemWorkerManager.ts
supersedes:
superseded_by:
---

## 背景
抽取结果有候选时，completeExtraction 不直接写库，而是入队 memory_deduplicate，游标要等 completeDedup 写完才提交（commitCapture）。旧实现在入队去重之后立刻 finishCapture(extractTaskId)，把这一批从 pending 里移除，并按「有更新的输入就接着抽」去发后继 force 任务。此时游标还停在这一批之前：store.capture 算出的 delta 会连同这一批一起带上，同一批对话被抽第二遍；去重任务又还在排队，两边的写入还会交错。光看 completeExtraction 的代码看不出来，因为 finishCapture 在非去重路径里紧跟在 commitCapture 之后，调用顺序看上去是一样的。

另一处是 memory_deduplicate 的 Input 行。入参里的 matches 已经被 formatBatchConflictPrompt 渲染进正文（新记忆和候选各一遍），Input 行又把整份 matches 序列化一次，候选池大时同一份内容发两遍。

## 决定
去重分支不调 finishCapture，也不从 pending 里删这一批：把 extractTaskId 记进 PendingDedup，并在 pending 里补登记（重启后从队列恢复的抽取任务原本不在 pending 里）。这一批在去重结束前一直算进行中，同来源的新一轮 capture 命中它，返回 queued 并入这一批，不另起抽取。去重结束的三条路径各自收尾：completeDedup 在 commitCapture 之后 finishCapture；memory_deduplicate 失败或取消时（taskSettled），以及去重入队被拒时，删除 pendingDedup 并 finishCapture。收尾后的接续逻辑沿用 finishCapture：只有比这一批更新的输入才发后继任务。提交后接续的 delta 只剩新的一轮；失败后游标没动，接续的 delta 带上整批未提交内容，等于连同新输入重抽，这是失败重试该有的行为。

memory_deduplicate 且 matches 是数组时，Input 行只去掉 matches，mode 等其余字段保留。旧形状（newMemories / candidates）不动。

## 放弃的方案
- 在 completeExtraction 里先 commitCapture 再入队去重：游标提前提交，去重失败时这一批永久丢失，且抽取结果还没落库，是更坏的失败模式。
- 后继任务发出时从 delta 里手工扣掉这一批：要在 MemoryService 里重做 store 的游标算术，commitCapture 已经会按 delta 前缀裁剪 pending，应该让它来裁。
- 去重期间让新一轮另起任务、靠队列顺序保证先后：任务入队时 delta 就已经算好，排在后面也还是带着旧批次；去重失败时顺序保证也不存在。
- Input 行里 matches 整体替换成条数或 record_id 列表：正文已经完整渲染，Input 行再留任何摘要都只是噪音。

## 后果
去重期间（等待模型的几秒到几十秒）同来源的 capture 返回 queued 却不会立刻入队新任务；这批的轮数照常计入节奏计数，去重结束后够阈值就接着抽，不够就等空闲补抽。

去重任务如果一直不结束（队列卡住），这个来源的后续输入会一直并入这一批，直到任务失败或超时；memory_deduplicate 有超时，超时算失败，会走 abandonDedup 释放。

matches 里被 asDedupMatches 丢弃的畸形条目现在也不会出现在 Input 行里。MemoryService 生成的 matches 总是合法形状，所以只有手工构造的任务才会受影响。
