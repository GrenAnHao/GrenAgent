import type {
  SessionInfo,
  SessionProjectTransferBusyReason,
  SessionProjectTransferStaleReason,
} from '../../lib/pi';
import type { SessionProjectTransferFamilySummary } from '../../lib/pi';
import { isUnder, pathsEquivalent } from '../../lib/pathUtils';
import { agentStoreRegistry } from '../../stores/agentStoreRegistry';
import { invalidateCachedSession } from '../../lib/sessionMessageCache';

/**
 * 跨项目迁移的渲染侧收尾：目标候选、列表投影、workspace store 失效和「这一次切换是迁移打开」的标记。
 *
 * 这里只做纯投影和极窄的缓存操作，契约、journal、运行时都由主进程 owner 负责。
 * 见 openspec/changes/move-sessions-between-projects/design.md 第 7 节。
 */

export interface TransferTargetOption {
  cwd: string;
  name: string;
  sessionCount: number;
}

const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/**
 * 「已有项目」候选：有会话的项目组 + 已登记的空项目，排除来源、排除 works 下的临时对话目录。
 * 会话 cwd 可能与来源只差分隔符/大小写，用 pathsEquivalent 判等。
 */
export function collectTransferTargets(input: {
  allSessions: SessionInfo[];
  registeredProjects: string[];
  worksDir: string;
  aliases: Record<string, string>;
  sourceWorkspace: string;
}): TransferTargetOption[] {
  const { allSessions, registeredProjects, worksDir, aliases, sourceWorkspace } = input;
  const counts = new Map<string, { cwd: string; count: number }>();
  for (const session of allSessions) {
    const cwd = session.cwd;
    if (!cwd || session.archived) continue;
    if (worksDir && isUnder(cwd, worksDir)) continue;
    if (pathsEquivalent(cwd, sourceWorkspace)) continue;
    const hit = [...counts.values()].find((entry) => pathsEquivalent(entry.cwd, cwd));
    if (hit) hit.count += 1;
    else counts.set(cwd, { cwd, count: 1 });
  }
  for (const cwd of registeredProjects) {
    if (!cwd || pathsEquivalent(cwd, sourceWorkspace)) continue;
    if (worksDir && isUnder(cwd, worksDir)) continue;
    if ([...counts.values()].some((entry) => pathsEquivalent(entry.cwd, cwd))) continue;
    counts.set(cwd, { cwd, count: 0 });
  }
  return [...counts.values()]
    .map(({ cwd, count }) => ({ cwd, name: aliases[cwd] || basename(cwd), sessionCount: count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 把某份会话的 cwd 投影到目标项目；同路径的迟到目标列表行合并成一条，不出现两份。
 * 保留 id / path / timestamp / name / archived，只改归属。
 */
export function relocateSession(sessions: SessionInfo[], sessionPath: string, targetWorkspace: string): SessionInfo[] {
  let seen = false;
  const out: SessionInfo[] = [];
  for (const session of sessions) {
    if (!pathsEquivalent(session.path, sessionPath)) {
      out.push(session);
      continue;
    }
    if (seen) continue;
    seen = true;
    out.push({ ...session, cwd: targetWorkspace });
  }
  return out;
}

/** 提交前失败的列表回滚：把 cwd 改回来源（只动这一条）。 */
export function restoreSessionLocation(sessions: SessionInfo[], sessionPath: string, sourceWorkspace: string): SessionInfo[] {
  return relocateSession(sessions, sessionPath, sourceWorkspace);
}

/** 清掉来源工作区对这份会话的「上次打开」绑定；目标由打开流程重新写。 */
export function clearWorkspaceSessionBinding(bindings: Record<string, string>, sourceWorkspace: string, sessionPath: string): Record<string, string> {
  const hit = Object.entries(bindings).find(([cwd, path]) => pathsEquivalent(cwd, sourceWorkspace) && pathsEquivalent(path, sessionPath));
  if (!hit) return bindings;
  const next = { ...bindings };
  next[hit[0]] = '';
  return next;
}

export interface TransferOpenHandoff {
  sessionPath: string;
  sourceWorkspace: string;
  targetWorkspace: string;
}

let pendingOpen: TransferOpenHandoff | null = null;

/**
 * 迁移成功后立刻要切到目标项目。App 的切 workspace effect 平时会 resetWorkspaceTabs（会杀掉旧终端、
 * 换掉终端实例）；迁移这一跳要保留旧文件标签和脏编辑，只让新入口使用目标根。
 */
export function markTransferOpen(handoff: TransferOpenHandoff): void {
  pendingOpen = handoff;
}

/** 这次 workspace 变化是不是迁移打开；消费一次，之后恢复正常切换行为。 */
export function consumeTransferOpen(workspace: string): boolean {
  if (!pendingOpen || !pathsEquivalent(pendingOpen.targetWorkspace, workspace)) return false;
  pendingOpen = null;
  return true;
}

/** 只给测试和诊断用：不消费。 */
export function peekTransferOpen(): TransferOpenHandoff | null {
  return pendingOpen;
}

export function resetTransferOpen(): void {
  pendingOpen = null;
}

/**
 * 旧 workspace 的 agent store 不能再把这份会话当成自己的：
 * 只在该 store 内存里正好加载着这份会话、且没有实时活动时清空画面。
 * 源项目其它会话的 store（加载着别的路径）保持不动。
 */
export function detachTransferredSession(sourceWorkspace: string, sessionPath: string): void {
  invalidateCachedSession(sessionPath);
  const store = agentStoreRegistry.get(sourceWorkspace);
  if (!store) return;
  const loaded = store.getLoadedSessionPath();
  if (!loaded || !pathsEquivalent(loaded, sessionPath)) return;
  if (store.hasLiveActivity()) return;
  store.reset();
}

const BUSY_TEXT: Record<SessionProjectTransferBusyReason, string> = {
  'turn-active': '此会话正在执行回合，请等它结束',
  'turn-queued': '此会话还有排队中的消息，请等处理完',
  'background-jobs': '此会话仍有后台任务运行，请等待任务结束',
  'subagent-unsettled': '关联的子代理还没有结算，请等待完成',
  'pending-ui': '此会话正在等待批准或选择，请先完成交互',
  'goal-running': '会话目标仍在续跑，请先暂停目标',
  'structure-recovery': '会话正在修改或等待恢复，请稍后重试',
  unknown: '无法确认会话活动状态，请稍后重试',
};

export function transferBusyText(reason: SessionProjectTransferBusyReason, detail?: string): string {
  return detail?.trim() ? detail : BUSY_TEXT[reason] ?? BUSY_TEXT.unknown;
}

const STALE_TEXT: Record<SessionProjectTransferStaleReason, string> = {
  'ticket-expired': '预览已过期，请重新预览',
  'ticket-unknown': '这次预览已失效，请重新预览',
  'session-changed': '会话内容已变化，请重新预览',
  'family-changed': '关联的子代理集合已变化，请重新预览',
  'registry-changed': '子代理登记已变化，请重新预览',
  'target-changed': '目标项目已变化，请重新预览',
  'source-changed': '来源会话已变化，请重新预览',
};

export function transferStaleText(reason: SessionProjectTransferStaleReason): string {
  return STALE_TEXT[reason] ?? '会话或目标已变化，请重新预览';
}

/** 确认摘要里的一行族统计；不暴露子级路径或正文。 */
export function transferFamilyText(family: SessionProjectTransferFamilySummary): string {
  const parts = [`主会话 1 份`];
  if (family.childSessionCount > 0) parts.push(`子会话 ${family.childSessionCount} 份`);
  if (family.subagentCount > 0) parts.push(`子代理 ${family.subagentCount} 个`);
  if (family.registryRecordCount > 0) parts.push(`登记 ${family.registryRecordCount} 条`);
  return parts.join(' · ');
}
