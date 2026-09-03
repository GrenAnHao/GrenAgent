import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
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
  agent_set_mode: 'prompt',
  agent_set_approval: 'prompt',
  agent_exclude_entry: 'prompt',
  agent_restore_entry: 'prompt',
  agent_rewind_to: 'fork',
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
  all?: () => Array<[string, PiClientPort]>;
}

export interface PiRuntimeOptions {
  manager: PiManagerPort;
  processCommand: PiProcessCommand;
  agentDir: string;
  runtimeConfigPath?: string;
  agentDataEndpoint?: () => string | undefined;
  resolveWorkspace?: (workspace: string) => Promise<string>;
  resolveEnv?: (workspace: string) => Promise<Record<string, string>>;
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
    const client = await this.openClient(workspace);
    if (command === 'agent_set_mode') {
      return client.send({ type: 'prompt', message: `/mode ${String(args.mode ?? '')}` });
    }
    if (command === 'agent_set_approval') {
      return client.send({ type: 'prompt', message: `/approval ${String(args.level ?? '')}` });
    }
    if (command === 'agent_exclude_entry') {
      return client.send({ type: 'prompt', message: `/ctx-exclude ${String(args.timestamp ?? '')}` });
    }
    if (command === 'agent_restore_entry') {
      return client.send({ type: 'prompt', message: `/ctx-restore ${String(args.timestamp ?? '')}` });
    }
    if (command === 'agent_rewind_to') {
      const state = await client.send<Record<string, unknown>>({ type: 'get_state' });
      const sessionFile = state.sessionFile;
      if (typeof sessionFile !== 'string' || !sessionFile) throw new Error('no active session file');
      const entryId = await findEntryIdByTimestamp(sessionFile, args.timestamp);
      if (!entryId) throw new Error(`no message with timestamp ${String(args.timestamp)} in session`);
      return client.send({ type: 'fork', entryId });
    }
    return client.send({ type, ...args });
  }

  async respondUi(workspace: string, response: Record<string, unknown>): Promise<void> {
    const client = await this.openClient(workspace);
    await client.respondUi(response);
  }

  async refreshModelRegistry(): Promise<{ refreshed: string[]; failed: Array<{ workspace: string; error: string }> }> {
    const result = { refreshed: [] as string[], failed: [] as Array<{ workspace: string; error: string }> };
    for (const [workspace, client] of this.options.manager.all?.() ?? []) {
      try {
        const state = await client.send<Record<string, unknown>>({ type: 'get_state' });
        if (typeof state.sessionFile === 'string') await client.send({ type: 'switch_session', sessionPath: state.sessionFile });
        result.refreshed.push(workspace);
      } catch (error) {
        result.failed.push({ workspace, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  private async openClient(workspace: string): Promise<PiClientPort> {
    const existing = this.options.manager.get(workspace);
    if (existing) return existing;
    const cwd = await (this.options.resolveWorkspace?.(workspace) ?? Promise.resolve(workspace));
    const env: Record<string, string> = {
      ...(await this.options.resolveEnv?.(workspace) ?? {}),
      PI_PACKAGE_DIR: this.options.agentDir,
    };
    if (this.options.runtimeConfigPath) env.PI_RUNTIME_CONFIG = this.options.runtimeConfigPath;
    const endpoint = this.options.agentDataEndpoint?.();
    if (endpoint) env.AGENT_DATA_ENDPOINT = endpoint;
    return this.options.manager.open(workspace, cwd, env);
  }
}

async function findEntryIdByTimestamp(sessionFile: string, timestamp: unknown): Promise<string | undefined> {
  const reader = createInterface({ input: createReadStream(sessionFile), crlfDelay: Infinity });
  let found: string | undefined;
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const value = entry as Record<string, unknown>;
      const message = value.message;
      if (value.type !== 'message' || !message || typeof message !== 'object') continue;
      if ((message as Record<string, unknown>).timestamp !== timestamp) continue;
      if (typeof value.id === 'string') found = value.id;
    }
  } finally {
    reader.close();
  }
  return found;
}
