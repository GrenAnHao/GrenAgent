import { createAgentSessionRuntime, getAgentDir, SessionManager, type ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { makeGrenRuntimeFactory } from '../../../cli/src/gren-runtime.js';
import { runInWorkspace } from '../../../extensions/_shared/workspace-context.js';
import { WorkspaceHandle, type WorkspaceHandleOptions } from './workspaceHandle.js';

export interface CreateGoalHandleInput {
  workspace: string;
  cwd: string;
  sessionId: string;
  sessionPath: string;
  modelRuntime: ModelRuntime;
  allowedExtensionsJson: string;
  resolveConfig: WorkspaceHandleOptions['resolveConfig'];
  onEvent: WorkspaceHandleOptions['onEvent'];
  onFatal: WorkspaceHandleOptions['onFatal'];
  onDispose?: WorkspaceHandleOptions['onDispose'];
}

/** 为非可见 jsonl 打开独立 Goal handle；构造期 ALS origin 为 goal。 */
export async function createGoalHandle(input: CreateGoalHandleInput): Promise<WorkspaceHandle> {
  const config = await input.resolveConfig('goal');
  const runtime = await runInWorkspace(
    { origin: 'goal', workspace: input.workspace, cwd: input.cwd, config },
    () => createAgentSessionRuntime(
      makeGrenRuntimeFactory({ modelRuntime: input.modelRuntime, allowedExtensionsJson: input.allowedExtensionsJson }),
      { cwd: input.cwd, agentDir: getAgentDir(), sessionManager: SessionManager.open(input.sessionPath) },
    ),
  );
  const handle = new WorkspaceHandle({
    workspace: input.workspace,
    cwd: input.cwd,
    runtime,
    resolveConfig: input.resolveConfig,
    emitUiRequest: () => { /* Goal UI 不广播；adapter 在 isGoalTurn 时已立即默认值 */ },
    onEvent: input.onEvent,
    onFatal: input.onFatal,
    onDispose: input.onDispose,
  });
  try {
    await handle.start();
    if (handle.session.sessionId && handle.session.sessionId !== input.sessionId) {
      throw new Error('GOAL_WORKER_SESSION_MISMATCH');
    }
    return handle;
  } catch (error) {
    await handle.dispose();
    throw error;
  }
}
