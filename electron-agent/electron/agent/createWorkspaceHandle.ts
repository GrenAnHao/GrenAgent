import { createAgentSessionRuntime, getAgentDir, SessionManager, type ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { makeGrenRuntimeFactory } from '../../../cli/src/gren-runtime.js';
import { releaseImBinding } from '../../../extensions/_shared/im-binding.js';
import { runInWorkspace } from '../../../extensions/_shared/workspace-context.js';
import { disposeMcpManager } from '../../../extensions/mcp/manager.js';
import { releaseSubagentControlPlane } from '../../../extensions/multi-agent/controlPlane.js';
import { WorkspaceHandle, type WorkspaceHandleOptions } from './workspaceHandle.js';
import { releaseWorkspaceLease, retainWorkspaceLease } from './workspaceLease.js';

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
  retainWorkspaceLease(input.workspace);
  let handedToHandle = false;
  try {
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
      onDispose: async (workspace, cwd) => {
        await releaseWorkspaceLease(workspace, async () => {
          // 先同步摘下 MCP 管理器、IM 绑定和子代理控制面，再等 MCP 连接关完（最多几秒）。
          // 反过来的话，等待期间同一工作区新开的 handle 会先声明 IM、打开 registry，随后被这里释放掉。
          const closingMcp = disposeMcpManager(workspace);
          // IM 在 session_start 用 ctx.cwd 声明；workspace ≠ resolved 时两键都释放。
          releaseImBinding(workspace);
          if (cwd !== workspace) releaseImBinding(cwd);
          releaseSubagentControlPlane(cwd);
          if (cwd !== workspace) releaseSubagentControlPlane(workspace);
          await closingMcp;
        });
      },
    });
    handedToHandle = true;
    try {
      await handle.start();
      return handle;
    } catch (error) {
      await handle.dispose();
      throw error;
    }
  } catch (error) {
    if (!handedToHandle) await releaseWorkspaceLease(input.workspace, async () => {});
    throw error;
  }
}
