import { createAgentSessionRuntime, getAgentDir, SessionManager, type ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { makeGrenRuntimeFactory } from '../../../cli/src/gren-runtime.js';
import { runInWorkspace } from '../../../extensions/_shared/workspace-context.js';
import { WorkspaceHandle, type WorkspaceHandleOptions } from './workspaceHandle.js';

export interface CreateWorkspaceHandleInput {
  workspace: string;
  cwd: string;
  modelRuntime: ModelRuntime;
  allowedExtensionsJson: string;
  resolveConfig: WorkspaceHandleOptions['resolveConfig'];
  emitUiRequest: WorkspaceHandleOptions['emitUiRequest'];
  onEvent: WorkspaceHandleOptions['onEvent'];
  onFatal: WorkspaceHandleOptions['onFatal'];
}

/** 在 main store 内构造 runtime（构造期扩展工厂读 ALS config），返回已 start 的 handle。 */
export async function createWorkspaceHandle(input: CreateWorkspaceHandleInput): Promise<WorkspaceHandle> {
  const config = await input.resolveConfig('main');
  const runtime = await runInWorkspace(
    { origin: 'main', workspace: input.workspace, cwd: input.cwd, config },
    () => createAgentSessionRuntime(
      makeGrenRuntimeFactory({ modelRuntime: input.modelRuntime, allowedExtensionsJson: input.allowedExtensionsJson }),
      { cwd: input.cwd, agentDir: getAgentDir(), sessionManager: SessionManager.create(input.cwd) },
    ),
  );
  const handle = new WorkspaceHandle({
    workspace: input.workspace,
    cwd: input.cwd,
    runtime,
    resolveConfig: input.resolveConfig,
    emitUiRequest: input.emitUiRequest,
    onEvent: input.onEvent,
    onFatal: input.onFatal,
  });
  try {
    await handle.start();
    return handle;
  } catch (error) {
    await handle.dispose();
    throw error;
  }
}
