import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { spawn, type IPty } from '@homebridge/node-pty-prebuilt-multiarch';
import { SandboxManager } from './sandbox/sandboxManager';

export interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
}

type SpawnPty = (file: string, args: string[], options: { cwd: string; rows: number; cols: number; name: string; env: NodeJS.ProcessEnv }) => Pty;
type ShellEvent = { type: 'output'; data: string; session_id: string } | { type: 'exit'; exit_code: number; session_id: string };

export class ShellService {
  private readonly sessions = new Map<string, Pty>();

  constructor(
    private readonly emit: (event: 'shell-output', payload: ShellEvent) => void,
    private readonly spawnPty: SpawnPty = spawn as unknown as SpawnPty,
    private readonly resolveWorkspace: (workspace: string) => Promise<string> = realpath,
    private readonly sandbox?: SandboxManager,
  ) {}

  async start(workspace?: string): Promise<{ session_id: string }> {
    const cwd = workspace?.trim() ? await this.resolveWorkspace(workspace) : process.cwd();
    const file = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const args = process.platform === 'win32' ? ['-NoLogo'] : ['-l'];
    const launch = this.sandbox?.prepare({ profile: 'workspace', workspaceRoot: cwd, cwd }) ?? { profile: 'workspace' as const, cwd, env: process.env, network: 'none' as const, degraded: false };
    const terminal = this.spawnPty(file, args, { cwd: launch.cwd ?? cwd, rows: 24, cols: 100, name: 'xterm-color', env: launch.env });
    const sessionId = randomUUID();
    terminal.onData((data) => this.emit('shell-output', { type: 'output', data, session_id: sessionId }));
    terminal.onExit(({ exitCode }) => this.emit('shell-output', { type: 'exit', exit_code: exitCode, session_id: sessionId }));
    this.sessions.set(sessionId, terminal);
    return { session_id: sessionId };
  }

  async write(sessionId: string, data: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('shell session not found');
    session.write(data);
  }

  async resize(sessionId: string, rows: number, cols: number): Promise<void> {
    if (!rows || !cols) return;
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('shell session not found');
    session.resize(cols, rows);
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    session?.kill();
  }

  async stopAll(): Promise<void> {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
  }
}
