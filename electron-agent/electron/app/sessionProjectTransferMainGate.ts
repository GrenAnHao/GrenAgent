import { readTransferJournalBlocks } from './sessionProjectTransferJournal.js';
import { configureTransferJournalBlocker } from './sessionProjectTransferBlocker.js';
import type { WorkspaceService } from './workspaceService.js';

type TransferWorkspace = Pick<WorkspaceService, 'setRecoveryGate' | 'markSessionPathsBlocked' | 'clearSessionPathsBlocked'>;

/** Main owns project listings; the agent host owns recovery. Registration itself must not wait on this gate. */
export function installSessionProjectTransferMainGate(input: {
  agentDir: string;
  workspace: TransferWorkspace;
  recover(): Promise<void>;
}): void {
  configureTransferJournalBlocker(input.agentDir);
  let recovery: Promise<void> | undefined;
  let marked: string[] = [];
  input.workspace.setRecoveryGate(async () => {
    // Do not start an agent host just to list a clean store. An unfinished journal,
    // however, must start recovery even if no runtime was running at application launch.
    const pending = await readTransferJournalBlocks(input.agentDir);
    if (pending.length > 0) {
      recovery ??= input.recover().finally(() => { recovery = undefined; });
      await recovery;
    }
    const remaining = await readTransferJournalBlocks(input.agentDir);
    input.workspace.clearSessionPathsBlocked(marked);
    marked = remaining.flatMap(block => block.sessionPaths);
    input.workspace.markSessionPathsBlocked(remaining.flatMap(block => block.sessionPaths.map(path => ({ path, reason: block.reason }))));
    if (remaining.some(block => block.sessionPaths.length === 0)) {
      throw new Error('SESSION_TRANSFER_BLOCKED: 无法定位未完成迁移的会话族，请先恢复 journal');
    }
  });
}
