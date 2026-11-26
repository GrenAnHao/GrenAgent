import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTransferJournalBlocks, type TransferJournalBlock } from './sessionProjectTransferJournal.js';
import {
  normalizeSessionOperationPath,
  sessionOperationLeases,
  type SessionOperationLeaseBlocker,
  type SessionOperationLeaseQuery,
} from './sessionOperationLease.js';

/**
 * 把迁移 journal 接到会话操作 lease 的恢复闸门上。
 *
 * main（WorkspaceService）与 agent-host（PiRuntimeService / 迁移 owner）各自调用一次；
 * 两边都只读 `session-transfers/<operationId>/manifest.json`，不认识也不改写 journal 内容。
 * `PiRuntimeService` 不要再自己 `setBlockerProbe`，否则会盖掉这里的探针。
 *
 * 匹配口径：
 * - paths：调用方要读 / 写的会话路径，与 journal 的 sessionPath、family 成员（sessionPaths）按规范路径比较。
 * - workspaces：项目 / scratch 根，与 journal 的 sourceWorkspace、targetWorkspace 比较。applying 阶段父 header
 *   已经是目标、按源项目扫不出来，只靠 paths 会漏掉，所以项目级清理必须带上 workspaces。
 *
 * fail-closed：journal 读不懂（未知版本、manifest 损坏、快照缺失）时仍然阻塞，但只阻塞能对上这个事务的族：
 * 能用原始 manifest 读出来的 sessionPath / family / 源目标项目就精确匹配；连族都定位不出来时才当全局阻塞，
 * 因为无法证明它与其他会话无关。其他项目的会话与删除照常进行。
 */
export function configureTransferJournalBlocker(
  agentDir: string,
  options: { coordinator?: ReturnType<typeof sessionOperationLeases> } = {},
): void {
  const coordinator = options.coordinator ?? sessionOperationLeases(agentDir);
  coordinator.setBlockerProbe({
    blocked: async (query) => {
      // 每次探针重读 journal 目录：迁移提交 / 打开后必须立刻放行，不能缓存过期事实。
      const blocks = await readTransferJournalBlocks(agentDir).catch(() => undefined);
      if (blocks === undefined) {
        // 连 journal 目录都读不了：无法排除任何族，按全局阻塞处理。
        return [{ reason: '无法读取迁移 journal，暂不开放会话写入' }];
      }
      const blockers: SessionOperationLeaseBlocker[] = [];
      for (const block of blocks) {
        const scope = await readJournalScope(agentDir, block);
        // 只阻塞能对上这个事务族的请求；无关项目 / 其他会话照常。
        // scope 全空表示连族都定位不出来：无法证明它与其他会话无关，按全局阻塞。
        if (matches(scope, query)) blockers.push(toBlocker(block, scope));
      }
      return blockers;
    },
  });
}

interface JournalScope {
  paths: string[];
  workspaces: string[];
}

/**
 * journal projection 已经给出 sessionPaths（before / after image 里有）。源 / 目标项目与 family
 * 在 manifest 里；未知版本时 projection 不带它们，这里直接读原始 manifest 的稳定字段做范围匹配，
 * 只用于「这条事务影响谁」，不信任其中的状态结论。
 */
async function readJournalScope(agentDir: string, block: TransferJournalBlock): Promise<JournalScope> {
  const paths = new Set<string>();
  const workspaces = new Set<string>();
  for (const path of block.sessionPaths) paths.add(await safeNormalize(path));
  for (const workspace of [block.sourceWorkspace, block.targetWorkspace]) {
    if (workspace) workspaces.add(await safeNormalize(workspace));
  }
  try {
    const raw = JSON.parse(await readFile(join(agentDir, 'session-transfers', block.operationId, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    for (const field of ['sessionPath', 'sourceWorkspace', 'targetWorkspace']) {
      const value = raw?.[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      const normalized = await safeNormalize(value);
      if (field === 'sessionPath') paths.add(normalized);
      else workspaces.add(normalized);
    }
    if (Array.isArray(raw?.family)) {
      for (const member of raw.family) {
        const value = (member as { sessionPath?: unknown } | null)?.sessionPath;
        if (typeof value === 'string' && value.trim()) paths.add(await safeNormalize(value));
      }
    }
  } catch {
    // 原始 manifest 也读不懂：只靠 projection 给出的路径 / 项目范围。
  }
  return { paths: [...paths], workspaces: [...workspaces] };
}

function matches(scope: JournalScope, query: SessionOperationLeaseQuery): boolean {
  // 定位不出族的事务（损坏 manifest + 缺快照）：无法排除任何会话，必须全局阻塞。
  if (scope.paths.length === 0 && scope.workspaces.length === 0) return true;
  const paths = query.paths ?? [];
  if (paths.some((path) => scope.paths.includes(path))) return true;
  for (const workspace of query.workspaces ?? []) {
    const normalized = normalizeSync(workspace);
    if (scope.workspaces.includes(normalized)) return true;
  }
  return false;
}

function toBlocker(block: TransferJournalBlock, scope: JournalScope): SessionOperationLeaseBlocker {
  return {
    reason: `${block.reason}（迁移 ${block.operationId}）`,
    operationId: block.operationId,
    ...(scope.paths.length > 0 ? { path: scope.paths[0], familyPaths: scope.paths } : {}),
  };
}

async function safeNormalize(path: string): Promise<string> {
  return normalizeSessionOperationPath(path).catch(() => normalizeSync(path));
}

function normalizeSync(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
