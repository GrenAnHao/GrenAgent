import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { truncateSessionLines } from './truncateSession';
import { syncSessionFromDisk } from './syncSessionFromDisk';

const user = (text: string, timestamp: number) => ({ role: 'user', content: text, timestamp }) as never;
const assistant = (text: string, timestamp: number) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'test',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp,
  }) as never;

/** 用真实的 SessionManager、真实 Agent 和 AgentSession 原型上的 _refreshFinalizedContext 拼一个会话。 */
async function liveSession() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-sync-disk-'));
  const manager = SessionManager.create('C:/work', dir);
  const ids = {
    u1: manager.appendMessage(user('第一问', 1)),
    a1: manager.appendMessage(assistant('第一答', 2)),
    u2: manager.appendMessage(user('第二问', 3)),
    a2: manager.appendMessage(assistant('被回退掉的回复', 4)),
  };
  const session = Object.create(AgentSession.prototype) as Record<string, unknown>;
  session.sessionManager = manager;
  session.agent = new Agent({} as never);
  session._entryIdsByMessage = new WeakMap();
  (session._refreshFinalizedContext as () => void).call(session);
  const sessionFile = manager.getSessionFile()!;
  return { dir, manager, session, ids, sessionFile };
}

async function truncateOnDisk(sessionFile: string, entryId: string, mode: 'drop-target' | 'keep-target') {
  const lines = (await readFile(sessionFile, 'utf8')).split(/\r?\n/).filter((line) => line.trim());
  const result = truncateSessionLines(lines, entryId, mode);
  if (!result.ok) throw new Error(result.reason);
  await writeFile(sessionFile, `${result.lines.join('\n')}\n`, 'utf8');
}

const texts = (session: Record<string, unknown>) =>
  ((session.agent as Agent).state.messages as Array<{ content: unknown }>).map((m) =>
    typeof m.content === 'string' ? m.content : (m.content as Array<{ text?: string }>)[0]?.text,
  );

describe('syncSessionFromDisk', () => {
  it('回退到此（drop-target）后，模型下一轮不再读到被删掉的问答', async () => {
    const { dir, manager, session, ids, sessionFile } = await liveSession();
    try {
      expect(texts(session)).toEqual(['第一问', '第一答', '第二问', '被回退掉的回复']);
      await truncateOnDisk(sessionFile, ids.u2, 'drop-target');

      syncSessionFromDisk(session as never, sessionFile);

      expect(texts(session)).toEqual(['第一问', '第一答']);
      expect(manager.getLeafId()).toBe(ids.a1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('同步后新消息接在截断点后面，不再挂到已删掉的旧 leaf 上', async () => {
    const { dir, manager, session, ids, sessionFile } = await liveSession();
    try {
      await truncateOnDisk(sessionFile, ids.u2, 'drop-target');
      syncSessionFromDisk(session as never, sessionFile);
      const next = manager.appendMessage(user('换个问法', 5));

      const entries = (await readFile(sessionFile, 'utf8'))
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { id?: string; parentId?: string | null });
      expect(entries.map((entry) => entry.id).filter(Boolean)).not.toContain(ids.a2);
      expect(entries.find((entry) => entry.id === next)?.parentId).toBe(ids.a1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('重新生成（keep-target）后，上下文停在那条用户消息', async () => {
    const { dir, session, ids, sessionFile } = await liveSession();
    try {
      await truncateOnDisk(sessionFile, ids.u2, 'keep-target');
      syncSessionFromDisk(session as never, sessionFile);
      expect(texts(session)).toEqual(['第一问', '第一答', '第二问']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('没有私有刷新方法时按投影直接写 agent 的 messages', async () => {
    const { dir, manager, ids, sessionFile } = await liveSession();
    try {
      await truncateOnDisk(sessionFile, ids.u2, 'drop-target');
      const plain = { sessionManager: manager, agent: { state: { messages: [{ stale: true }] as unknown[] } } };
      syncSessionFromDisk(plain, sessionFile);
      expect(plain.agent.state.messages).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('会话管理器不能重读文件时报错，交给调用方重试', () => {
    expect(() => syncSessionFromDisk({ sessionManager: {} }, 'x.jsonl')).toThrow('cannot reload');
  });
});
