# 证据：子代理重新设计 · 第 1 阶段（管理器 + 两个后端，行为不变）

笔记：[2026-10-11-subagent-redesign.md](../../notes/proposed/architecture/2026-10-11-subagent-redesign.md)。日期 2026-10-11，Windows 11，pi 1.1.0。

| 文件 | 内容 | 结果 |
|---|---|---|
| `vitest-multi-agent.txt` | `cd extensions && npx vitest run multi-agent` | 通过：31 个文件通过 / 1 个跳过，424 个用例通过 / 2 个跳过。改动前基线是 30 / 414，多出来的是新增的 `manager.test.ts`（10 个用例）；现有测试一行没改 |
| `vitest-extensions-full.txt` | `cd extensions && npx vitest run`（全量） | 1811 个通过，1 个失败：`_shared/sandbox/windows/deleteSemantics.test.ts`。和本次改动无关，见下一行 |
| `vitest-extensions-full-HEAD.txt` | 同一条命令在 HEAD 上跑（暂存了本次改动） | HEAD 上同一个用例也失败（1801 个通过 / 1 个失败）。单独跑这个文件，在 HEAD 和本次改动上都通过（本次改动上连跑 3 次都通过），只有全量并行跑时才失败 |
| `tsc-compare.txt` | `npx tsc -p electron-agent/tsconfig.node.json --noEmit`（覆盖 `../extensions`） | HEAD 和本次改动都是 155 条，逐条比对没有差异；新文件 0 条 |
| `agent-host-smoke.txt` | `node electron-agent/scripts/agent-host-smoke.mjs --entry out/subagent-p1/main/agent-host.js`。构建产物里有新管理器的代码（`extensions-*.js` 里能搜到「后端不支持可续聊子代理」） | 通过：15 项检查全部通过 |
| `real-subagent-run.mjs` / `real-subagent-run.txt` | 真实 agent-host 加真实模型 `custom-muqywnc8/claude-haiku-5-5`（`models.json` 里标价最低的模型）。父会话按提示词各派一次子代理，让它回复 OK | 通过：18 项检查全部通过 |

## 实跑覆盖了什么

`real-subagent-run.mjs` 起的是构建产物里的 `agent-host.js`（不经 Electron 主进程）：
- HOME 用临时目录，只拷入 `models.json` 和 `auth.json`，结束时整个临时目录删掉（日志最后一行写「临时目录已删除：true」）；日志里的密钥值会被替换成 `<redacted>`。
- `PI_WORKER_ENTRY` 指向同一次构建的 `pi-worker.js`。
- 主进程那一侧的工具授权（AgentData 通道的 `permission.tool.evaluate`）用桩，一律放行。第一次实跑没接这个桩，`spawn_agent` 被 safety 判成「已被授权规则拒绝」，子代理根本没起来；这是脚本的问题，和本次改动无关。

| 用例 | 走的后端 / 路径 | 父会话拿到的结果 |
|---|---|---|
| `action:"run"`，default 档案 | in-process：`runSubagent` → `inProcessBackend.run` → `runEmbeddedSubagent` | 工具结果正文 `OK`；details 带子会话 `sessionPath`（文件存在）、`isolated:false`、`stopReason:"completed"`；父会话最后一条回复是 `OK` |
| `action:"spawn"`，default 档案 | in-process：`startContinuableSubagent` → `startContinuableEmbedded` | 工具结果 `mode:"continuable"`。子代理结束后，父会话收到 `subagent-settled` 通知（childId 对得上，`stopReason:"completed"`，正文里有 `OK`），并据此开了一轮新回复 |
| `action:"run"`，executor 档案（worktree） | worker：`runSubagent` → `workerBackend.run` → `spawnPiAgent` 起 `pi-worker.js` 进程 | 工具结果正文 `OK` 加 worktree diff 段（`(no file changes)`）；details 是 `isolated:true`、没有 `sessionPath`、`stopReason:"completed"`；父会话最后一条回复是 `OK` |

复跑：

    cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-p1
    cd .. && node .agents/evidence/2026-10-11-subagent-redesign/real-subagent-run.mjs

会调用 `models.json` 里配置的真实供应商；默认模型可用 `--model provider/id` 改。

---

# 证据：第 2 阶段（统一后台交付 + wait_agent，删掉子代理的 jobs 路径）

日期 2026-10-12。上面第 1 阶段的文件保持原样，下面这些文件都以 `stage2-` 开头，另加 `real-run-stage2.*`。

| 文件 | 内容 | 结果 |
|---|---|---|
| `stage2-vitest-multi-agent-jobs.txt` | `cd extensions && npx vitest run multi-agent jobs prompt-metadata fable-behavior` | 通过：43 个文件，525 个用例通过 / 2 个跳过 |
| `stage2-vitest-extensions-full.txt` | `cd extensions && npx vitest run`（全量） | 1829 个通过，1 个失败：仍是 `_shared/sandbox/windows/deleteSemantics.test.ts`，和第 1 阶段记录的一样，与本次改动无关 |
| `stage2-electron-main-compare.txt` | `cd electron-agent && npx vitest run electron` | 16 个失败，分布在 agentData / tencentdb / subagentService / taskViewService / gitService。把 extensions 改动暂存后，在 HEAD 上跑同样这 7 个文件，失败了 15 个。唯一的差别是 `gitService.test.ts` 的临时目录 EBUSY，单独复跑 2/2 通过。`subagentService.test.ts` 失败是因为期望值里少了 `thinkingLevel` 列，在 HEAD 上也一样失败 |
| `stage2-tsc-compare.txt` | `npx tsc -p electron-agent/tsconfig.node.json --noEmit` | 和第 1 阶段一样都是 155 条，逐条比对没有差异 |
| `stage2-agent-host-smoke.txt` | `agent-host-smoke.mjs --entry out/subagent-p2/main/agent-host.js` | 通过：15 项全部通过 |
| `real-run-stage2.mjs` / `real-run-stage2.txt` | 真实 agent-host 加 `custom-muqywnc8/claude-haiku-5-5` | 通过：25 项全部通过 |

## 实跑覆盖了什么

脚本的做法和第 1 阶段相同（临时 HOME、AgentData 授权桩、结束后删除临时目录、日志里的密钥值替换成 `<redacted>`）。用例：

1. **回归**：进程内一次性 `action:"run"`，前台交付不变，结果正文是 `OK`。
2. **第 2 阶段**：父会话在同一轮里调两次 `spawn_agent({action:"spawn"})`，再调一次 `wait_agent()`。
   - 两份回执都没有 `jobId`，文字里提示 `wait_agent`，不再提 `job_output` / `action:"wait"`。
   - `wait_agent` 返回 `outcome: "settled"`，报告的 childId 都是这次派出的，只有摘要，没有 closing message。
   - 两个子代理各发来一条 `subagent-settled`（completed，正文 `OK`）。`wait_agent` 报告的那个子代理，它的通知排在 `wait_agent` 结果之后，说明父会话忙时这条通知是按 steer 投递的。
   - 全程没有 `job-done`。
3. **回归**：worker（executor 档案，worktree）`action:"run"`，结果正文 `OK` 加 diff 段。

第一次实跑有 1 项失败：「wait_agent 只给摘要」这条检查用 `\bOK\b` 判断有没有带正文，但标签取的是任务首行（"Reply with exactly the two letters OK…"），本来就含 OK。这是检查写错了，代码的行为是对的（日志里 `wait_agent` 的结果只有摘要）。把检查改成看有没有 closing message 后重跑，25 项全部通过，现在的日志就是重跑的那一次。

worker 后台运行（`startBackgroundRun`）这次没有实跑（用户选了只做单元测试）：在 Electron 里只有 worktree 档案会走 worker，而后台 worktree spawn 本来就被拒绝，只有 CLI 或 worker 进程里的父会话才会走到这条路径。覆盖它的是 `manager.test.ts` 的 `startBackgroundRun`，以及 `index.test.ts` 的「background delivery」两组单测：有父会话宿主、没有宿主时退回 `pi.sendMessage`、失败时带 diagnostic、静默、`wait_agent` 等到结算。

复跑：

    cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-p2
    cd .. && node .agents/evidence/2026-10-11-subagent-redesign/real-run-stage2.mjs

---

# 证据：第 2.5 阶段（worktree 改为显式工具，每会话工作目录）

日期 2026-10-12。文件以 `stage25-` 开头，另有 `real-run-stage25.*`。

| 文件 | 内容 | 结果 |
|---|---|---|
| `stage25-vitest-targeted.txt` | `cd extensions && npx vitest run working-directory _shared/session-cwd multi-agent safety memory jobs prompt-metadata` | 通过：662 个用例通过 / 2 个跳过 |
| `stage25-vitest-extensions-full.txt` | `cd extensions && npx vitest run`（全量） | 通过：1860 个用例通过 / 4 个跳过，没有失败。连跑两次都全绿，`deleteSemantics` 这次也通过了 |
| `stage25-cli-tests.txt` | `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts` | 通过：12/12 |
| `stage25-electron-main.txt` | `cd electron-agent && npx vitest run electron` | 15 个失败，和 HEAD 的失败集合（`stage2-electron-main-compare.txt`）完全一样，没有新增 |
| `stage25-tsc-compare.txt` | `npx tsc -p electron-agent/tsconfig.node.json --noEmit` | 和第 2 阶段一样都是 155 条，逐条比对没有差异 |
| `stage25-agent-host-smoke.txt` | agent-host 冒烟（入口用 `out/subagent-p25`） | 通过：15 项全部通过 |
| `real-run-stage25.mjs` / `real-run-stage25.txt` | 真实 agent-host 加 `custom-muqywnc8/claude-haiku-5-5`，临时 git 工作区 | 通过：18 项全部通过（另有 1 项跳过，见下） |

## 实跑覆盖了什么

1. **建 worktree**：父会话调 `create_worktree({name:"p25-feature"})`，然后用 `write` 写相对路径 `note.txt`。
   - checkout 建在 `<工作区>/.agents/worktrees/p25-feature`，分支是 `p25-feature`，worktrees 目录下的 `.gitignore` 内容是 `*`。
   - `note.txt` 只出现在 worktree 里，原工作区没有。
   - 父会话 JSONL 里有 `working_directory` 记录，会话头的 cwd 仍是原工作区。
2. **子代理继承目录**：父会话在 worktree 里派一个进程内子代理，让它写 `child.txt`。
   - 文件落在 worktree 里，原工作区没有。
   - 子会话头的 cwd 是原工作区，子会话文件和父会话在同一个会话目录。
3. **新建 / 切回会话**：
   - `agent_new_session` 新建了一个会话。
   - `agent_switch_session` 切回原会话后，让父会话调 `working_directory()`，返回的是 worktree：目录按会话里的记录恢复了。
   - 跳过的那一项：新会话的头要等第一条消息才落盘，这次没法读，所以「新会话头是原工作区」没有检查。代码上，`makeGrenRuntimeFactory` 始终按原始目录建服务（`runtime.cwd` 不变），切回原会话靠的是 `attachSessionCwd` 原地切换。
4. **离开 worktree**：`working_directory({cd: 原工作区})` 返回 `changed: true`，checkout 和分支都还在。

第 1、2 阶段的实跑脚本（`real-subagent-run.mjs`、`real-run-stage2.mjs`）里的 worker 用例用的是 `profile: "executor"`。第 2.5 阶段删掉了这个档案（会回退到 default，走进程内），所以在当前代码上重跑，这两个脚本的 worker 检查会按设计失败；它们记录的是那两个阶段当时的代码。

复跑：

    cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-p25
    cd .. && node .agents/evidence/2026-10-11-subagent-redesign/real-run-stage25.mjs

---

# 证据：第 3 阶段（worker 改为常驻 RPC 进程）

日期 2026-10-12。文件以 `stage3-` 开头，另有 `real-run-stage3.*`。

| 文件 | 内容 | 结果 |
|---|---|---|
| `stage3-vitest-targeted.txt` | `cd extensions && npx vitest run multi-agent im-platforms working-directory _shared/session-cwd jobs prompt-metadata` | 通过：556 个用例通过 / 2 个跳过 |
| `stage3-vitest-extensions-full.txt` | `cd extensions && npx vitest run`（全量） | 1857 个通过，1 个失败：仍是已知的 `deleteSemantics.test.ts`。另一次全量里 `resource-manager/mcp-store.test.ts` 的文件监听时序失败过一次，单独连跑 3 次都通过 |
| `stage3-cli-tests.txt` | `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts` | 通过：16/16 |
| `stage3-electron-main.txt` | `cd electron-agent && npx vitest run electron` | 17 个失败。HEAD 的 15 个照旧；多出的两个文件是负载下超时（`tencentdbRemoval` 扫全源码树超过 5 秒、`gitService` 临时目录 EBUSY），单独复跑都通过 |
| `stage3-tsc-compare.txt` | `npx tsc -p electron-agent/tsconfig.node.json --noEmit` | 和第 2.5 阶段一样都是 155 条，逐条比对没有差异 |
| `stage3-agent-host-smoke.txt` | agent-host 冒烟（入口用 `out/subagent-p3`，最终构建） | 通过：15 项全部通过 |
| `real-run-stage3.mjs` / `real-run-stage3.txt` | 真实 agent-host 加 haiku，运行时设置 `SUBAGENT_BACKEND=worker` | 通过：14 项全部通过 |

## 实跑覆盖了什么

脚本每 1.5 秒按命令行查一次 `pi-worker.js --mode subagent` 进程，把 PowerShell 自己排除在外。

1. **worker 一次性 run**：
   - 子代理回复 `OK`，带子会话 `sessionPath`（worker 里也是真会话，有 JSONL）。
   - 子会话的 `subagent_meta.backend` 是 `worker`。
   - 观察到了 worker 进程。
2. **worker 后台 spawn**：
   - 走可续聊：Activation 在宿主里，会话在 worker 里。第一条 `subagent-settled` 是 completed，正文 `OK`。
   - 然后父会话 `send_message` 让它回复 `AGAIN`。这时子代理已经结算、worker 已经退出，于是按 JSONL 冷恢复到一个新的 worker 进程（观察到新的 pid），第二条结算通知带回了 `AGAIN`。
3. **worker fork**：
   - `fork: true` 继承了父会话 15 条已完成事件，子会话 meta 是 `backend: worker`。
   - 子代理的任务前面有继承说明（照 Codex 的 MultiAgentUsageHint，本阶段补上的）。

关于 fork 的说明：继承的上下文里包含父会话「调用 spawn_agent …」那条用户消息（DSH 的快照切到最后一个 `turn/end`，Codex 的 fork 也带着它）。即使有继承说明，haiku 有时仍会照做，再派一个子代理（这次就是：孙代理在深度上限处 `spawn_agent` 被正确拒绝，报 "Tool spawn_agent not found"）。所以第 3 项只检查机制（继承事件数、后端、继承说明在不在），子代理的回复只记录、不判定。前几次实跑里有一次 haiku 照说明直接回复了 `FORKED`。

调试中还发现：这台机器配置的供应商会给工具改名（例如 `spawn_agent` 在模型那边叫 `review_spa34`）。第 1 阶段实跑里 haiku 说「工具叫 sync_spa15」也是这个原因。进程内和 worker 子代理拿到的工具列表一致（`spawn_agent` / `wait_agent` / `working_directory` / `create_worktree` 都在）。

复跑：

    cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-p3
    cd .. && node .agents/evidence/2026-10-11-subagent-redesign/real-run-stage3.mjs

# 证据：第 4 阶段（子代理目录、活跃上限、驻留、诊断采样）

日期 2026-10-12。文件以 `stage4-` 开头，另有 `real-run-stage4.*`。

| 文件 | 内容 | 结果 |
|---|---|---|
| `stage4-vitest-targeted.txt` | `cd extensions && npx vitest run multi-agent working-directory _shared/session-cwd jobs im-platforms prompt-metadata` | 通过：571 个用例通过 / 2 个跳过 |
| `stage4-vitest-extensions-full.txt` | `cd extensions && npx vitest run`（全量） | 1872 个通过，1 个失败：仍是已知的 `deleteSemantics.test.ts` |
| `stage4-cli-tests.txt` | `cd cli && node --import tsx --test src/gren-runtime.test.ts src/extension-profile.test.ts src/pi-worker.test.ts` | 通过：16/16 |
| `stage4-electron-main.txt` | `cd electron-agent && npx vitest run electron` | 15 个失败，6 个文件，和 HEAD 的失败集合一致，没有新增 |
| `stage4-tsc-compare.txt` | `npx tsc -p electron-agent/tsconfig.node.json --noEmit` | 154 条，比第 3 阶段少 1 条（`activation.ts` 冷恢复里 `poke` 的参数类型，本阶段改成按 id 取记录后消失），新增 0 条 |
| `stage4-agent-host-smoke.txt` | agent-host 冒烟（入口用 `out/subagent-p4`） | 通过：15 项全部通过 |
| `real-run-stage4.mjs` / `real-run-stage4.txt` | 真实 agent-host 加 haiku（进程内后端） | 通过：14 项全部通过 |

## 实跑覆盖了什么

脚本扮演主进程，收 agent-host 每 10 秒发来的 `host.diag` 采样，读其中的 `lag` 和新增的 `subagents`。主进程把同一份数据作为 `agent-host-sample` 写进 `runtime-diag.jsonl`。

1. **8 个进程内子代理并发**：
   - 父会话调一次 `spawn_agent`，`tasks` 给 8 个任务。每个任务都要求逐行写出 1 到 400 的英文，让 8 个子代理在同一时段持续推流。
   - 8 个结果都回来了。
   - 有一个采样窗口里 `active: 8, inProcess: 8`，8 个 id 都记下了。这个窗口事件循环 p99 148 ms、max 281 ms；其余窗口 p99 34～35 ms。验收线是 p99 ≤ 200 ms。
2. **驻留**：
   - 后台 spawn 一个可续聊子代理，结算后下一次采样 `resident: 1`。
   - 然后 `send_message` 让它回复 `AGAIN`。它从驻留池里取出，不用冷恢复，第二条结算通知带回 `AGAIN`。
3. **重启后**：重启 agent-host，用同一个临时 HOME，切回原父会话。
   - `list_agents` 从父会话 JSONL 的子代理目录列出 9 个子代理：8 个一次性（标明不能收消息），1 个可续聊，状态都是 `inactive`。
   - `send_message` 给那个可续聊子代理时按 JSONL 冷恢复，结算通知带回 `RESUMED`。

复跑：

    cd electron-agent && npx electron-vite build --mode localrun --outDir out/subagent-p4
    cd .. && node .agents/evidence/2026-10-11-subagent-redesign/real-run-stage4.mjs
