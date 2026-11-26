// 迁移定向：子代理列表 / 历史投影 / 冷恢复闸门在未完成迁移族上的行为。
// 不做真实模型调用，也不启动 worker；只读真实 registry.db 与真实 JSONL 夹具。
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../../../cli/src/pi-sdk.js';
import { buildTransferredSession } from './sessionProjectTransferHistory';
import {
  __resetSessionOperationGuardForTest,
  installSessionOperationBlockedSnapshot,
} from '../../../extensions/multi-agent/session-operation-guard.js';
import { foldCatalog, establishCatalogChild } from '../../../extensions/multi-agent/catalog.js';
import { SubagentService } from './subagentService';

const dirs: string[] = [];
afterEach(async () => {
  __resetSessionOperationGuardForTest();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(prefix = 'sa-transfer-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function registry(workspace: string, rows: Array<{ id: string; task: string; sessionPath: string; parentId?: string | null }>) {
  const folder = join(workspace, '.pi', 'subagents');
  await mkdir(folder, { recursive: true });
  const db = new DatabaseSync(join(folder, 'registry.db'));
  db.exec(`CREATE TABLE subagents (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, profile TEXT, model TEXT, status TEXT NOT NULL,
    output TEXT, error TEXT, exitCode INTEGER, transcript TEXT, sessionPath TEXT,
    parentId TEXT, depth INTEGER NOT NULL DEFAULT 0, jobId TEXT, bashState TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
  const insert = db.prepare(
    'INSERT INTO subagents(id, task, status, output, exitCode, transcript, sessionPath, parentId, createdAt, updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?)',
  );
  rows.forEach((row, index) => insert.run(row.id, row.task, 'done', 'ok', 0, 'live transcript', row.sessionPath, row.parentId ?? null, index + 1, index + 2));
  db.close();
}

async function persist(manager: SessionManager): Promise<string> {
  const path = manager.getSessionFile();
  if (!path) throw new Error('session file was not created');
  const lines = [manager.getHeader(), ...manager.getEntries()].filter(Boolean).map((entry) => JSON.stringify(entry));
  await writeFile(path, `${lines.join('\n')}\n`);
  return path;
}

describe('SubagentService during a session project transfer', () => {
  it('hides only the blocked family rows and keeps the rest of the project visible', async () => {
    const workspace = await temp();
    await registry(workspace, [
      { id: 'sa-moving', task: 'moving', sessionPath: join(workspace, 'moving.jsonl') },
      { id: 'sa-other', task: 'other', sessionPath: join(workspace, 'other.jsonl') },
    ]);
    installSessionOperationBlockedSnapshot(() => [join(workspace, 'moving.jsonl')]);

    const rows = new SubagentService().list(workspace);
    expect(rows.map((row) => row.id)).toEqual(['sa-other']);
    // 同一个项目里其他子代理的 transcript / 历史照常可读。
    const service = new SubagentService();
    expect(service.transcript(workspace, 'sa-other')).toBe('live transcript');
    expect(service.transcript(workspace, 'sa-moving')).toBeNull();
  });

  it('fails closed: a broken blocked snapshot hides the row rather than exposing a half-migrated family', async () => {
    const workspace = await temp();
    await registry(workspace, [{ id: 'sa-1', task: 't', sessionPath: join(workspace, 'one.jsonl') }]);
    installSessionOperationBlockedSnapshot(() => {
      throw new Error('journal unreadable');
    });
    expect(() => new SubagentService().list(workspace)).toThrow();
  });

  it('projects child history with the pre-transfer source cwd for relative links', async () => {
    const source = await temp('sa-transfer-src-');
    const target = await temp('sa-transfer-dst-');
    const child = SessionManager.inMemory(source);
    const assistantMeta = {
      api: 'openai-completions', provider: 'fixture', model: 'model', stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    child.appendMessage({ role: 'user', content: 'look at src/config.ts', timestamp: 1 } as never);
    child.appendMessage({
      ...assistantMeta,
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'src/config.ts' } }],
      timestamp: 2,
    } as never);
    child.appendMessage({
      role: 'toolResult', toolCallId: 'call-1', toolName: 'read',
      content: [{ type: 'text', text: 'content from source' }], isError: false, timestamp: 3,
    } as never);
    const raw = [child.getHeader(), ...child.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    const moved = buildTransferredSession(raw, {
      operationId: 'op-child-1',
      fromWorkspace: source,
      toWorkspace: target,
      leafId: null,
    });
    const path = join(target, 'child.jsonl');
    await writeFile(path, moved.raw);

    const messages = new SubagentService().sessionMessages(path) as Array<Record<string, unknown>>;
    const toolResult = messages.find((message) => message.role === 'toolResult')!;
    expect(toolResult.sourceCwd).toBe(source);
  });

  it('refuses to wake a child whose family is blocked and keeps one-shot children read-only', async () => {
    const workspace = await temp();
    const parent = SessionManager.create(workspace, join(workspace, 'sessions'));
    parent.appendMessage({ role: 'user', content: 'root', timestamp: 1 } as never);
    const parentPath = await persist(parent);
    const childPath = join(workspace, 'child.jsonl');
    await writeFile(childPath, `${JSON.stringify({ type: 'session', version: 3, id: 'child', timestamp: new Date(0).toISOString(), cwd: workspace })}\n`);

    // 直接构造父会话的 catalog（真实 foldCatalog 读取）。
    const sm = SessionManager.open(parentPath);
    establishCatalogChild((type, data) => sm.appendCustomEntry(type, data), {
      childId: 'sa-child', sessionPath: childPath, childCreatedAt: 1, mode: 'continuable', label: 'child',
    });
    await persist(sm);
    expect(foldCatalog(parentPath).entries.map((entry) => entry.id)).toEqual(['sa-child']);

    installSessionOperationBlockedSnapshot(() => [childPath]);
    const service = new SubagentService();
    await expect(service.promptChild(workspace, parentPath, childPath, 'hi', 'followUp'))
      .rejects.toThrow(/unfinished transfer/);
    // 读闸门把这一族从 catalog 里藏起来。
    expect(service.catalog(parentPath).entries).toEqual([]);
    expect(service.sessionMessages(childPath)).toEqual([]);
  });
});
