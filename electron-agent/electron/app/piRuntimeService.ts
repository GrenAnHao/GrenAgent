import type { PiManager, PiProcessCommand } from '../pi/manager';

type PiCommand = keyof typeof commandTypes;

const commandTypes = {
  agent_prompt: 'prompt',
  agent_steer: 'steer',
  agent_follow_up: 'follow_up',
  agent_abort: 'abort',
  agent_set_model: 'set_model',
  agent_cycle_model: 'cycle_model',
  agent_get_available_models: 'get_available_models',
  agent_set_thinking_level: 'set_thinking_level',
  agent_cycle_thinking_level: 'cycle_thinking_level',
  agent_set_mode: 'set_mode',
  agent_set_approval: 'set_approval',
  agent_exclude_entry: 'exclude_entry',
  agent_restore_entry: 'restore_entry',
  agent_rewind_to: 'rewind_to',
  agent_compact: 'compact',
  agent_set_auto_compaction: 'set_auto_compaction',
  agent_abort_retry: 'abort_retry',
  agent_get_session_stats: 'get_session_stats',
  agent_get_state: 'get_state',
  agent_get_messages: 'get_messages',
  agent_get_commands: 'get_commands',
  agent_new_session: 'new_session',
  agent_switch_session: 'switch_session',
  agent_fork: 'fork',
  agent_clone: 'clone',
  agent_get_fork_messages: 'get_fork_messages',
  agent_set_session_name: 'set_session_name',
} as const;

interface PiClientPort {
  send<T>(command: Record<string, unknown>): Promise<T>;
  respondUi(response: Record<string, unknown>): Promise<void>;
}

interface PiManagerPort {
  get(workspace: string): PiClientPort | undefined;
  open(workspace: string, cwd: string, env?: Record<string, string>): PiClientPort;
  close(workspace: string): Promise<void>;
}

export interface PiRuntimeOptions {
  manager: PiManagerPort;
  processCommand: PiProcessCommand;
  agentDir: string;
  runtimeConfigPath?: string;
  resolveWorkspace?: (workspace: string) => Promise<string>;
}

export class PiRuntimeService {
  constructor(private readonly options: PiRuntimeOptions) {}

  async openWorkspace(workspace: string): Promise<{ restoredSession: null; sessionFile: string | null }> {
    const client = await this.openClient(workspace);
    const state = await client.send<Record<string, unknown>>({ type: 'get_state' });
    return {
      restoredSession: null,
      sessionFile: typeof state.sessionFile === 'string' ? state.sessionFile : null,
    };
  }

  async warmWorkspace(workspace: string): Promise<void> {
    const client = await this.openClient(workspace);
    await client.send({ type: 'get_state' });
  }

  closeWorkspace(workspace: string): Promise<void> {
    return this.options.manager.close(workspace);
  }

  async send(workspace: string, command: string, args: Record<string, unknown>): Promise<unknown> {
    const type = commandTypes[command as PiCommand];
    if (!type) throw new Error(`Unsupported Pi command: ${command}`);
    const client = this.options.manager.get(workspace);
    if (!client) throw new Error(`Workspace is not open: ${workspace}`);
    return client.send({ type, ...args });
  }

  async respondUi(workspace: string, response: Record<string, unknown>): Promise<void> {
    const client = this.options.manager.get(workspace);
    if (!client) throw new Error(`Workspace is not open: ${workspace}`);
    await client.respondUi(response);
  }

  private async openClient(workspace: string): Promise<PiClientPort> {
    const existing = this.options.manager.get(workspace);
    if (existing) return existing;
    const cwd = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    const env: Record<string, string> = { PI_PACKAGE_DIR: this.options.agentDir };
    if (this.options.runtimeConfigPath) env.PI_RUNTIME_CONFIG = this.options.runtimeConfigPath;
    return this.options.manager.open(workspace, cwd, env);
  }
}
