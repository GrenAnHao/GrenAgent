# hashline 锚点过期自动恢复（3-way merge）设计

- 日期：2026-06-17
- 状态：设计已批准（brainstorming 产出），待实现
- 主题：给 `hashline` 扩展加「锚点过期自动恢复」——文件在 `hl_read` 后被改动导致 #TAG 过期时，不再直接拒绝，而是用 `hl_read` 快照做 3-way merge 把补丁安全落到当前内容。对标 omp `@oh-my-pi/hashline` 的 `recovery.ts`。
- 上游对标：`oh-my-pi/packages/hashline/src/recovery.ts`、`mismatch.ts`
- 路线图归属：`2026-06-17-oh-my-pi-parity-roadmap-design.md` 已有扩展对标改进（hashline 行）
- 约束：纯扩展 / 零核心改动 / 零 fork；**不改 fast path**（tag 匹配时行为不变）。

## 1. 背景与目标

### 现状
`hl_edit` 比对当前内容 tag 与补丁头 tag，不一致即拒绝（`index.ts` 的 `curTag !== section.tag → rejected`），模型必须重新 `hl_read`。文件被无关改动（如别处插了一行）也会让所有锚点失效，体验差。

### omp 的做法
`recovery.ts`：把补丁应用到缓存的**快照**（pre-edit `previousText`）得 `applied`，用 `Diff.structuredPatch(previousText, applied)` 生成补丁，再 `Diff.applyPatch(currentText, patch, {fuzzFactor: 0})` 3-way merge 到当前内容。`fuzzFactor: 0` 严格对齐（绝不把 hunk 滑到 100 行外的重复处）；并 `verifyAnchorContent` 防止覆盖 in-session 新内容。失败抛 `MismatchError`。

### 成功标准
1. 文件在 `hl_read` 后被**无关改动**、补丁目标区未被触碰时，`hl_edit` 即使 tag 过期也能自动恢复并写回，附"已自动恢复"提示。
2. 补丁目标区在快照后被改动（冲突）时，恢复失败 → 维持现有拒绝 + 重读提示。
3. 无快照或快照 tag 也不匹配时，维持现有拒绝。
4. tag 匹配的 fast path 行为完全不变。

### 非目标
- 不做 omp 的 session-chain 链式 replay。
- 不改 `applyOps`/`parser`/fast-path。
- 快照仅内存（进程级），不持久化。

## 2. 组件

- 复用：`apply.ts`（`applyOps`）、`parser.ts`（`Op`/`FileSection`）、`snapshots.ts`（`computeTag`）。
- 新增 `recovery.ts`：`recover(prev, cur, ops)` 纯逻辑（用 `diff` 库），返回 `{content}` 或 `{error}`。
- 改 `index.ts`：
  - 模块内 `snapshots = new Map<string, { content: string; tag: string }>()`。
  - `hl_read`：渲染后 `snapshots.set(abs, { content, tag })`。
  - `hl_edit`：tag 过期分支接入 `recover`。
- 新依赖：`diff`（`structuredPatch` / `applyPatch`）。

## 3. recover 算法（recovery.ts，纯逻辑）

```
recover(prev, cur, ops):
  applied = applyOps(prev, ops)              // 补丁应用到快照
  if applied.error or applied.content===prev: return { error }
  patch = structuredPatch("f","f", prev, applied.content, "", "", { context: 3 })
  merged = applyPatch(cur, patch, { fuzzFactor: 0 })
  if typeof merged !== "string": return { error: "无法合并（锚点漂移），请重新 hl_read" }
  return { content: merged }
```

## 4. hl_edit 流程（改后）

```
curTag = computeTag(abs, 当前内容)
if curTag === section.tag:
  applyOps(当前内容, ops) → 写回          // fast path 不变
else:
  snap = snapshots.get(abs)
  if snap && snap.tag === section.tag:
    r = recover(snap.content, 当前内容, ops)
    if r.content: 写回 r.content；applied 标注「#TAG 过期，已基于 hl_read 快照自动恢复（文件已变，请核对）」
    else: rejected（r.error）
  else:
    rejected「#TAG 已过期且无可用快照，请重新 hl_read」
```

## 5. 安全
- `fuzzFactor: 0`：严格对齐，对不上即失败，绝不误落。
- 恢复成功也在结果里**明确提示**文件已变、请核对（非静默改写）。
- 恢复失败完全回退到现有"拒绝 + 重读"。
- 快照按 `hl_read` 写入；写回成功后用新内容刷新快照。

## 6. 测试
- `recovery.ts`：
  - 快照后在**无关行**插入内容、补丁改另一处 → `recover` 成功，merged 含两处变更。
  - 补丁目标行在快照后被改 → `applyPatch` 对不上 → 返回 error。
  - 补丁对快照无改动 → error。
- `index.ts` 集成（tmp 文件）：
  - `hl_read` → 改无关行 → `hl_edit`(旧 tag) → 自动恢复写回，结果含"自动恢复"。
  - `hl_read` → 改目标行 → `hl_edit`(旧 tag) → 拒绝。
  - 无 `hl_read`（无快照）→ `hl_edit`(错 tag) → 拒绝。
