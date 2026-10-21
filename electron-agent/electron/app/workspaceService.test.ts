import { appendFile, mkdir, writeFile, rm, readFile, realpath, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetActivationsForTest, getActivation, installActivation } from '../../../extensions/multi-agent/activation.js';
import { getRegistry, releaseSubagentControlPlane, __resetSubagentControlPlaneForTest } from '../../../extensions/multi-agent/controlPlane.js';
import { __resetParentHostsForTest, registerParentSessionHost } from '../../../extensions/multi-agent/parent-host.js';
import { WorkspaceService } from './workspaceService';

const directories: string[] = [];

afterEach(async () => {
  __resetSubagentControlPlaneForTest();
  __resetActivationsForTest();
  __resetParentHostsForTest();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createService(): Promise<{ service: WorkspaceService; agentDir: string }> {
  const agentDir = await mkdtemp(join(tmpdir(), 'electron-agent-workspaces-'));
  directories.push(agentDir);
  return { service: new WorkspaceService(agentDir), agentDir };
}

function childLines(id: string, cwd: string, parentSession: string | null): string {
  return [
    JSON.stringify({ type: 'session', id, cwd, ...(parentSession ? { parentSession } : {}) }),
    JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: id, parentSession, mode: 'continuable' } }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: `task for ${id}` } }),
  ].join('\n') + '\n';
}

describe('WorkspaceService', () => {
  it('remembers a project directory that has no session file across restart', async () => {
    const { service, agentDir } = await createService();
    const project = await mkdtemp(join(tmpdir(), 'electron-agent-project-'));
    directories.push(project);

    const resolved = await service.ensureWorkspace(project);
    const restarted = new WorkspaceService(agentDir);

    await expect(restarted.listProjects()).resolves.toEqual([resolved]);
    await expect(restarted.listAllSessions()).resolves.toEqual([]);

    await restarted.ensureWorkspace(project);
    await expect(restarted.listProjects()).resolves.toEqual([resolved]);

    await restarted.removeProject(resolved);
    await expect(restarted.listProjects()).resolves.toEqual([]);
  });

  it('does not remember scratch conversation directories as projects', async () => {
    const { service } = await createService();
    const conversation = await service.createConversation();

    await service.ensureWorkspace(conversation.cwd);

    await expect(service.listProjects()).resolves.toEqual([]);
  });

  it('creates conversation directories below the canonical works directory', async () => {
    const { service } = await createService();
    const worksDir = await service.getWorksDir();
    const conversation = await service.createConversation();

    expect(conversation.cwd.startsWith(worksDir)).toBe(true);
    await expect(service.getWorksDir()).resolves.toBe(worksDir);
  });

  it('hides memory_extract system-worker sessions from the sidebar', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    const prompt = [
      'Extract durable memory as strict JSON. Return JSON only.',
      'Task kind: memory_extract',
      'Input: {"delta":"user: 你是什么模型?"}',
    ].join('\n');
    await writeFile(
      join(sessionsDir, 'extract.jsonl'),
      [
        JSON.stringify({ type: 'session', id: 'extract', cwd: 'C:/work', timestamp: '2026-09-08T00:00:00Z' }),
        JSON.stringify({
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        }),
      ].join('\n'),
    );
    await writeFile(
      join(sessionsDir, 'kept.jsonl'),
      '{"type":"session","id":"one","cwd":"C:/work","timestamp":"2026-08-30T00:00:00Z"}\n',
    );

    await expect(service.listAllSessions()).resolves.toEqual([
      { id: 'one', path: join(sessionsDir, 'kept.jsonl'), cwd: 'C:/work', timestamp: '2026-08-30T00:00:00Z', name: null },
    ]);
  });

  it('lists only session JSONL files with a workspace cwd', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'kept.jsonl'), '{"type":"session","id":"one","cwd":"C:/work","timestamp":"2026-08-30T00:00:00Z"}\n');
    await writeFile(join(sessionsDir, 'ignored.jsonl'), '{"type":"session","id":"two"}\n');

    await expect(service.listAllSessions()).resolves.toEqual([
      { id: 'one', path: join(sessionsDir, 'kept.jsonl'), cwd: 'C:/work', timestamp: '2026-08-30T00:00:00Z', name: null },
    ]);
  });

  it('reads generated titles from session_info entries after the session header', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    const path = join(sessionsDir, 'named.jsonl');
    await writeFile(path, [
      JSON.stringify({ type: 'session', id: 'named', cwd: 'C:/work', timestamp: '2026-09-05T00:00:00Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '排查标题问题' } }),
      JSON.stringify({ type: 'session_info', name: '修复对话标题' }),
    ].join('\n'));

    await expect(service.listAllSessions()).resolves.toEqual([
      { id: 'named', path, cwd: 'C:/work', timestamp: '2026-09-05T00:00:00Z', name: '修复对话标题' },
    ]);
  });

  it('untitled sessions use the first user message as the sidebar title', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    const path = join(sessionsDir, 'plain.jsonl');
    await writeFile(path, [
      JSON.stringify({ type: 'session', id: 'plain', cwd: 'C:/work', timestamp: '2026-09-17T00:00:00Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '帮我修一下登录页\n第二行' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: '好的' } }),
    ].join('\n'));

    await expect(service.listAllSessions()).resolves.toMatchObject([{ path, name: '帮我修一下登录页 第二行' }]);
  });

  it('untitled sessions unwrap pasted blocks, skills and image hints for the sidebar title', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    const write = (name: string, content: unknown) => writeFile(join(sessionsDir, `${name}.jsonl`), [
      JSON.stringify({ type: 'session', id: name, cwd: 'C:/work', timestamp: `2026-10-19T00:00:0${name.length % 10}Z` }),
      JSON.stringify({ type: 'message', message: { role: 'user', content } }),
    ].join('\n'));
    await write('pasted', '<pi:attachment type="text" lines="45" chars="4194">\n我们要为客服模块规划服务端设计。\n## 背景\n</pi:attachment>');
    await write('skill', '<skill name="brainstorming" location="C:\\s\\SKILL.md">\nReferences are relative to C:\\s.\n\n# 头脑风暴\n</skill>\n\n规划套餐订购页');
    await write('image', [
      { type: 'text', text: '调整订单查询栏\n\n[Image: original 2559x1527, displayed at 2000x1193. Multiply coordinates by 1.28 to map to original image.]' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
    ]);

    const names = Object.fromEntries((await service.listAllSessions()).map((s) => [s.id, s.name]));
    expect(names).toEqual({ pasted: '我们要为客服模块规划服务端设计。', skill: '规划套餐订购页', image: '调整订单查询栏' });
  });

  it('untitled sessions truncate a long first user message for the sidebar title', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    const long = '请'.repeat(120);
    await writeFile(join(sessionsDir, 'long.jsonl'), [
      JSON.stringify({ type: 'session', id: 'long', cwd: 'C:/work', timestamp: '2026-09-17T00:00:00Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: long }] } }),
    ].join('\n'));

    await expect(service.listAllSessions()).resolves.toMatchObject([{ name: '请'.repeat(80) }]);
  });

  it('reuses the parsed record while size and mtime are unchanged, and rereads once either changes', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    const path = join(sessionsDir, 'cached.jsonl');
    const header = JSON.stringify({ type: 'session', id: 'cached', cwd: 'C:/work', timestamp: '2026-10-04T00:00:00Z' });
    // 整秒的修改时间，重写后能原样设回去。
    const pinned = new Date('2026-10-04T00:00:00Z');
    await writeFile(path, `${header}\n${JSON.stringify({ type: 'session_info', name: '标题甲' })}\n`);
    await utimes(path, pinned, pinned);
    await expect(service.listAllSessions()).resolves.toMatchObject([{ name: '标题甲' }]);

    // 同样长度、同一个修改时间：视为同一份文件，不重读。
    await writeFile(path, `${header}\n${JSON.stringify({ type: 'session_info', name: '标题乙' })}\n`);
    await utimes(path, pinned, pinned);
    expect((await stat(path)).mtimeMs).toBe(pinned.getTime());
    await expect(service.listAllSessions()).resolves.toMatchObject([{ name: '标题甲' }]);

    const later = new Date(pinned.getTime() + 5000);
    await utimes(path, later, later);
    await expect(service.listAllSessions()).resolves.toMatchObject([{ name: '标题乙' }]);
  });

  it('does not mistake escaped markers inside tool output for session entries', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    const path = join(sessionsDir, 'tooling.jsonl');
    // 工具输出里引用了子代理标记、短调用提示和标题行，转义后不是真正的条目。
    const quoted = [
      JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { agentId: 'x' } }),
      JSON.stringify({ type: 'session_info', name: '工具里的标题' }),
      'role user\nTask kind: memory_extract\nInput: {}',
    ].join('\n');
    await writeFile(path, [
      JSON.stringify({ type: 'session', id: 'tooling', cwd: 'C:/work', timestamp: '2026-10-04T00:00:00Z' }),
      // 这两行都带未转义的 "user"，但都不是用户消息。
      JSON.stringify({ type: 'custom', customType: 'note', data: { role: 'user' } }),
      JSON.stringify({ type: 'message', message: { role: 'toolResult', details: { actor: 'user' }, content: [{ type: 'text', text: quoted }] } }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '真正的第一条' } }),
    ].join('\n'));

    await expect(service.listAllSessions()).resolves.toMatchObject([{ path, name: '真正的第一条' }]);
  });

  it('hides a system-worker session whose task prompt is not the first user message', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'late.jsonl'), [
      JSON.stringify({ type: 'session', id: 'late', cwd: 'C:/work', timestamp: '2026-10-04T00:00:00Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '先问一句' } }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Do it.\nTask kind: memory_extract\nInput: {}' } }),
    ].join('\n'));

    await expect(service.listAllSessions()).resolves.toEqual([]);
  });

  it('returns the latest renamed title on subsequent workspace listings', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    const path = join(sessionsDir, 'renamed.jsonl');
    await writeFile(path, '{"type":"session","id":"renamed","cwd":"C:/work"}\n');
    await expect(service.listSessions('C:/work')).resolves.toMatchObject([{ name: null }]);

    await appendFile(path, '{"type":"session_info","name":"自动标题"}\n');
    await expect(service.listSessions('C:/work')).resolves.toMatchObject([{ name: '自动标题' }]);

    await appendFile(path, '{"type":"session_info","name":"手动标题"}\n');
    await expect(service.listSessions('C:/work')).resolves.toMatchObject([{ name: '手动标题' }]);
  });

  it('renames a session file in place without opening its workspace', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    const path = join(sessionsDir, 'sidebar.jsonl');
    await writeFile(path, [
      JSON.stringify({ type: 'session', id: 'sidebar', cwd: 'C:/work', timestamp: '2026-09-11T00:00:00Z' }),
      JSON.stringify({ type: 'session_info', name: '连续 Bash 执行测试审批工具' }),
    ].join('\n') + '\n');

    await service.setSessionDisplayName(path, '123');

    await expect(service.listSessions('C:/work')).resolves.toMatchObject([{ path, name: '123' }]);
  });

  it('preserves the latest non-empty title when other entries are invalid or incomplete', async () => {
    const { service, agentDir } = await createService();
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'partial.jsonl'), [
      '{"type":"session","cwd":"C:/work"}',
      '{"type":"session_info","name":"旧标题"}',
      'not JSON',
      'null',
      '{"type":"session_info","name":"  最新标题  "}',
      '{"type":"session_info","name":"   "}',
      '{"type":"session_info","name":123}',
      '{"type":"message","name":"不是会话标题"}',
      '{"type":"session_info","name":"未写完',
    ].join('\r\n'));

    await expect(service.listAllSessions()).resolves.toMatchObject([{ name: '最新标题' }]);
  });

  it('reads titles for headerless sessions while inferring metadata from the path', async () => {
    const { service, agentDir } = await createService();
    const { cwd } = await service.createConversation();
    const sessionsDir = join(agentDir, 'sessions', `--${cwd.replace(/[\\/:]/g, '-')}--`);
    await mkdir(sessionsDir, { recursive: true });
    const path = join(sessionsDir, '2026-09-05T00-00-00-000Z_headerless.jsonl');
    await writeFile(path, [
      '{"type":"message","message":{"role":"user","content":"你好"}}',
      '{"type":"session_info","name":"无头部会话标题"}',
    ].join('\n'));

    await expect(service.listSessions(cwd)).resolves.toEqual([
      { id: 'headerless', path, cwd, timestamp: '2026-09-05T00:00:00.000Z', name: '无头部会话标题' },
    ]);
  });

  it('prunes an unused conversation while retaining a session-backed directory and explicit keep item', async () => {
    const { service, agentDir } = await createService();
    const worksDir = await service.getWorksDir();
    const used = join(worksDir, 'used');
    const kept = join(worksDir, 'kept');
    const orphan = join(worksDir, 'orphan');
    await Promise.all([mkdir(used), mkdir(kept), mkdir(orphan)]);
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'used.jsonl'), `{\"type\":\"session\",\"id\":\"one\",\"cwd\":${JSON.stringify(used)}}\n`);

    await expect(service.pruneOrphanConversations([kept])).resolves.toBe(1);
    await expect(service.getWorksDir()).resolves.toBe(worksDir);
    await expect(service.pruneOrphanConversations([used, kept])).resolves.toBe(0);
  });

  it('prunes a conversation that only has hidden child sessions left and removes their files', async () => {
    const { service, agentDir } = await createService();
    const worksDir = await service.getWorksDir();
    const orphan = join(worksDir, 'orphan');
    await mkdir(orphan);
    const sessionsDir = join(agentDir, 'sessions', 'hash');
    await mkdir(sessionsDir, { recursive: true });
    const child = join(sessionsDir, 'child.jsonl');
    await writeFile(child, [
      JSON.stringify({ type: 'session', id: 'sa-1', cwd: orphan }),
      JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: 'sa-1' } }),
    ].join('\n') + '\n');

    await expect(service.pruneOrphanConversations([])).resolves.toBe(1);
    await expect(realpath(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(child, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not prune a draft conversation created in the current application run', async () => {
    const { service } = await createService();
    const conversation = await service.createConversation();

    await expect(service.pruneOrphanConversations([])).resolves.toBe(0);
    await expect(service.listSessions(conversation.cwd)).resolves.toEqual([]);
  });

  it('recreates a missing conversation directory below works', async () => {
    const { service } = await createService();
    const workspace = join(await service.getWorksDir(), 'recreated');

    await expect(service.ensureWorkspace(workspace)).resolves.toBe(workspace);
  });

  it('deletes a conversation directory and only sessions belonging to that conversation', async () => {
    const { service, agentDir } = await createService();
    const conversation = await service.createConversation();
    const sessions = join(agentDir, 'sessions', 'hash');
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, 'conversation.jsonl'), `{"type":"session","cwd":${JSON.stringify(conversation.cwd)}}\n`);
    await writeFile(join(sessions, 'project.jsonl'), '{"type":"session","cwd":"C:/project"}\n');

    await service.deleteConversation(conversation.cwd);
    await expect(service.ensureWorkspace(conversation.cwd)).resolves.toBe(conversation.cwd);
    await expect(readFile(join(sessions, 'project.jsonl'), 'utf8')).resolves.toContain('project');
    await expect(readFile(join(sessions, 'conversation.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('hides embedded subagent child sessions so the newest listed session stays the parent', async () => {
    const { service, agentDir } = await createService();
    const { cwd } = await service.createConversation();
    const sessionsDir = join(agentDir, 'sessions', `--${cwd.replace(/[\\/:]/g, '-')}--`);
    await mkdir(sessionsDir, { recursive: true });
    const parent = join(sessionsDir, '2026-09-14T14-56-00-000Z_parent.jsonl');
    const child = join(sessionsDir, '2026-09-14T14-57-30-000Z_sa-1.jsonl');
    await writeFile(parent, [
      JSON.stringify({ type: 'session', id: 'parent', cwd, timestamp: '2026-09-14T14:56:00.000Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: '帮我探测一下工作区' } }),
      JSON.stringify({ type: 'session_info', name: '探测工作区' }),
    ].join('\n') + '\n');
    await writeFile(child, [
      JSON.stringify({ type: 'session', id: 'sa-1', cwd, timestamp: '2026-09-14T14:57:30.000Z', parentSession: parent }),
      JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: 'sa-1', parentSession: parent, mode: 'one-shot' } }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'You are a connectivity probe / scout.' } }),
    ].join('\n') + '\n');

    await expect(service.listSessions(cwd)).resolves.toEqual([
      { id: 'parent', path: parent, cwd, timestamp: '2026-09-14T14:56:00.000Z', name: '探测工作区' },
    ]);
    await expect(service.listAllSessions()).resolves.toMatchObject([{ path: parent }]);
  });

  it('deletes hidden child and system-worker sessions together with their conversation', async () => {
    const { service, agentDir } = await createService();
    const conversation = await service.createConversation();
    const sessions = join(agentDir, 'sessions', 'hash');
    await mkdir(sessions, { recursive: true });
    const parent = join(sessions, 'parent.jsonl');
    const child = join(sessions, 'child.jsonl');
    const worker = join(sessions, 'worker.jsonl');
    const foreignChild = join(sessions, 'foreign-child.jsonl');
    await writeFile(parent, `{"type":"session","id":"parent","cwd":${JSON.stringify(conversation.cwd)}}\n`);
    await writeFile(child, [
      JSON.stringify({ type: 'session', id: 'sa-1', cwd: conversation.cwd }),
      JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: 'sa-1' } }),
    ].join('\n') + '\n');
    await writeFile(worker, [
      JSON.stringify({ type: 'session', id: 'worker', cwd: conversation.cwd }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Extract memory.\nTask kind: memory_extract\nInput: {}' } }),
    ].join('\n') + '\n');
    await writeFile(foreignChild, [
      JSON.stringify({ type: 'session', id: 'sa-2', cwd: 'C:/project' }),
      JSON.stringify({ type: 'custom', customType: 'subagent_meta', data: { origin: 'subagent', agentId: 'sa-2' } }),
    ].join('\n') + '\n');

    await service.deleteConversation(conversation.cwd);

    await expect(readFile(parent, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(child, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(worker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(foreignChild, 'utf8')).resolves.toContain('sa-2');
  });

  it('closes an in-process subagent registry before deleting the conversation directory', async () => {
    const { service } = await createService();
    const conversation = await service.createConversation();
    getRegistry(conversation.cwd);

    await service.deleteConversation(conversation.cwd);
    await expect(realpath(conversation.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('closes an active workspace before deleting its directory', async () => {
    const { service } = await createService();
    const conversation = await service.createConversation();
    const close = vi.fn(async () => {});
    service.setWorkspaceCloser(close);

    await service.deleteConversation(conversation.cwd);

    expect(close).toHaveBeenCalledWith(conversation.cwd);
  });

  it('tears down live children while the registry is still open, before the workspace closer releases it', async () => {
    const { service, agentDir } = await createService();
    const { cwd } = await service.createConversation();
    const sessionsDir = join(agentDir, 'sessions', `--${cwd.replace(/[\\/:]/g, '-')}--`);
    await mkdir(sessionsDir, { recursive: true });
    const parent = join(sessionsDir, '2026-09-14T14-56-00-000Z_parent.jsonl');
    const child = join(sessionsDir, '2026-09-14T14-57-30-000Z_sa-live.jsonl');
    await writeFile(parent, `{"type":"session","id":"parent","cwd":${JSON.stringify(cwd)}}\n`);
    await writeFile(child, childLines('sa-live', cwd, parent));
    const session = {
      isStreaming: true,
      pendingMessageCount: 0,
      messages: [],
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      waitForIdle: () => new Promise<void>(() => {}),
    };
    installActivation({
      childId: 'sa-live', sessionPath: child, parentSessionId: 'parent', parentSessionPath: parent,
      workspace: cwd, session, announced: true,
    });
    const registry = getRegistry(cwd);
    registry.create({ id: 'sa-live', task: 't', sessionPath: child });
    let statusAtClose: string | undefined;
    // 与真实 onDispose 一致：closer 释放 registry；此时子级必须已收口、其 cancelled 已写进仍开着的 registry。
    service.setWorkspaceCloser(async (workspace) => {
      expect(session.dispose).toHaveBeenCalled();
      statusAtClose = registry.get('sa-live')?.status;
      releaseSubagentControlPlane(workspace);
    });

    await service.deleteConversation(cwd);

    expect(statusAtClose).toBe('cancelled');
    expect(getActivation('sa-live')).toBeUndefined();
    await expect(realpath(cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(child, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(parent, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes project sessions without deleting the project directory', async () => {
    const { service, agentDir } = await createService();
    const project = join(agentDir, 'project'); await mkdir(project);
    const sessions = join(agentDir, 'sessions', 'hash'); await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, 'project.jsonl'), `{"type":"session","cwd":${JSON.stringify(project)}}\n`);

    await service.removeProject(project);
    await expect(readFile(join(sessions, 'project.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(realpath(project)).resolves.toBe(project);
  });

  it('deletes only a session that belongs to the requested workspace', async () => {
    const { service, agentDir } = await createService();
    const workspace = join(agentDir, 'project'); await mkdir(workspace);
    const sessions = join(agentDir, 'sessions', 'hash'); await mkdir(sessions, { recursive: true });
    const owned = join(sessions, 'owned.jsonl');
    const foreign = join(sessions, 'foreign.jsonl');
    await writeFile(owned, `{"type":"session","cwd":${JSON.stringify(workspace)}}\n`);
    await writeFile(foreign, '{"type":"session","cwd":"C:/other"}\n');

    await service.deleteSession(workspace, owned);
    await expect(readFile(owned, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(service.deleteSession(workspace, foreign)).rejects.toThrow('session does not belong to workspace');
  });

  it('takes a session off the runtime before removing its file', async () => {
    const { service, agentDir } = await createService();
    const workspace = join(agentDir, 'project'); await mkdir(workspace);
    const sessions = join(agentDir, 'sessions', 'hash'); await mkdir(sessions, { recursive: true });
    const owned = join(sessions, 'owned.jsonl');
    await writeFile(owned, `{"type":"session","cwd":${JSON.stringify(workspace)}}\n`);
    const seen: Array<{ paths: string[]; existed: boolean }> = [];
    // 还在跑的会话会把后续条目 append 回同一路径：必须先停下、再删文件。
    service.setSessionReleaser(async (paths) => {
      seen.push({ paths, existed: await readFile(owned, 'utf8').then(() => true, () => false) });
    });

    await service.deleteSession(workspace, owned);

    expect(seen).toEqual([{ paths: expect.arrayContaining([owned]), existed: true }]);
    await expect(readFile(owned, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the file when the runtime cannot let go of the session', async () => {
    const { service, agentDir } = await createService();
    const workspace = join(agentDir, 'project'); await mkdir(workspace);
    const sessions = join(agentDir, 'sessions', 'hash'); await mkdir(sessions, { recursive: true });
    const owned = join(sessions, 'owned.jsonl');
    await writeFile(owned, `{"type":"session","cwd":${JSON.stringify(workspace)}}\n`);
    service.setSessionReleaser(async () => { throw new Error('SESSION_RELEASE_CANCELLED'); });

    await expect(service.deleteSession(workspace, owned)).rejects.toThrow('SESSION_RELEASE_CANCELLED');
    await expect(readFile(owned, 'utf8')).resolves.toContain('"session"');
  });

  it('takes every session of a removed project off the runtime before deleting files', async () => {
    const { service, agentDir } = await createService();
    const project = join(agentDir, 'project'); await mkdir(project);
    const sessions = join(agentDir, 'sessions', 'hash'); await mkdir(sessions, { recursive: true });
    const first = join(sessions, 'first.jsonl');
    const second = join(sessions, 'second.jsonl');
    await writeFile(first, `{"type":"session","cwd":${JSON.stringify(project)}}\n`);
    await writeFile(second, `{"type":"session","cwd":${JSON.stringify(project)}}\n`);
    const released: string[] = [];
    service.setSessionReleaser(async (paths) => {
      for (const path of paths) {
        if (await readFile(path, 'utf8').then(() => true, () => false)) released.push(path);
      }
    });

    await service.removeProject(project);

    expect(released.sort()).toEqual([first, second].sort());
    await expect(readFile(first, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(second, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cascades a session delete to its subagent children and grandchildren only', async () => {
    const { service, agentDir } = await createService();
    const workspace = join(agentDir, 'project'); await mkdir(workspace);
    const sessions = join(agentDir, 'sessions', 'hash'); await mkdir(sessions, { recursive: true });
    const parent = join(sessions, 'parent.jsonl');
    const sibling = join(sessions, 'sibling.jsonl');
    const child = join(sessions, 'child.jsonl');
    const grandchild = join(sessions, 'grandchild.jsonl');
    const siblingChild = join(sessions, 'sibling-child.jsonl');
    const unlinked = join(sessions, 'unlinked-child.jsonl');
    await writeFile(parent, `{"type":"session","id":"parent","cwd":${JSON.stringify(workspace)}}\n`);
    await writeFile(sibling, `{"type":"session","id":"sibling","cwd":${JSON.stringify(workspace)}}\n`);
    // 子会话 parentSession 按 SDK 落盘写法（分隔符 / 大小写可与调用方传入的路径不同）
    await writeFile(child, childLines('sa-child', workspace, parent.replace(/\\/g, '/').toUpperCase()));
    await writeFile(grandchild, childLines('sa-grandchild', workspace, child));
    await writeFile(siblingChild, childLines('sa-sibling-child', workspace, sibling));
    await writeFile(unlinked, childLines('sa-unlinked', workspace, null));

    await service.deleteSession(workspace, parent);

    await expect(readFile(parent, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(child, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(grandchild, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(sibling, 'utf8')).resolves.toContain('sibling');
    await expect(readFile(siblingChild, 'utf8')).resolves.toContain('sa-sibling-child');
    await expect(readFile(unlinked, 'utf8')).resolves.toContain('sa-unlinked');
  });

  it('tears down a resident child before removing its file and does not settle into the deleted parent', async () => {
    const { service, agentDir } = await createService();
    const workspace = join(agentDir, 'project'); await mkdir(workspace);
    const sessions = join(agentDir, 'sessions', 'hash'); await mkdir(sessions, { recursive: true });
    const parent = join(sessions, 'parent.jsonl');
    const child = join(sessions, 'child.jsonl');
    await writeFile(parent, `{"type":"session","id":"parent","cwd":${JSON.stringify(workspace)}}\n`);
    await writeFile(child, childLines('sa-live', workspace, parent));
    const sendMessage = vi.fn();
    registerParentSessionHost({
      sessionId: 'parent', sessionPath: parent, workspace,
      isBusy: () => false, isDraining: () => false, sendMessage, prompt: vi.fn(),
    });
    // 子级正在流式输出：不这样设置的话空闲子级会自然结算并给父会话发回执，测不到删除路径本身。
    const session = {
      isStreaming: true,
      pendingMessageCount: 0,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'partial' }] }],
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
      waitForIdle: () => new Promise<void>(() => {}),
    };
    installActivation({
      childId: 'sa-live', sessionPath: child, parentSessionId: 'parent', parentSessionPath: parent,
      workspace, session, announced: true,
    });
    getRegistry(workspace).create({ id: 'sa-live', task: 't', sessionPath: child });

    await service.deleteSession(workspace, parent);

    expect(session.dispose).toHaveBeenCalled();
    expect(getActivation('sa-live')).toBeUndefined();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getRegistry(workspace).get('sa-live')?.status).toBe('cancelled');
    await expect(readFile(child, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(parent, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('WorkspaceService session archive', () => {
  async function withSessions(): Promise<{ service: WorkspaceService; agentDir: string; workspace: string; a: string; b: string }> {
    const { service, agentDir } = await createService();
    const workspace = join(agentDir, 'project'); await mkdir(workspace);
    const sessions = join(agentDir, 'sessions', 'hash'); await mkdir(sessions, { recursive: true });
    const a = join(sessions, 'a.jsonl');
    const b = join(sessions, 'b.jsonl');
    await writeFile(a, `${JSON.stringify({ type: 'session', id: 'a', cwd: workspace, timestamp: '2026-10-01T00:00:00Z' })}\n`);
    await writeFile(b, `${JSON.stringify({ type: 'session', id: 'b', cwd: workspace, timestamp: '2026-10-02T00:00:00Z' })}\n`);
    return { service, agentDir, workspace, a, b };
  }

  const registry = async (agentDir: string) =>
    JSON.parse(await readFile(join(agentDir, 'archived-sessions.json'), 'utf8')) as { sessions: string[] };

  it('marks archived sessions in both listings and survives a restart', async () => {
    const { service, agentDir, workspace, a, b } = await withSessions();

    await service.setSessionsArchived([a], true);

    const all = await service.listAllSessions();
    expect(all.find((s) => s.path === a)?.archived).toBe(true);
    expect(all.find((s) => s.path === b)).not.toHaveProperty('archived');
    const restarted = new WorkspaceService(agentDir);
    expect((await restarted.listSessions(workspace)).find((s) => s.path === a)?.archived).toBe(true);
    expect(await registry(agentDir)).toEqual({ sessions: [a] });
  });

  it('unarchives by path regardless of separator or case spelling', async () => {
    const { service, agentDir, a } = await withSessions();
    await service.setSessionsArchived([a], true);

    await service.setSessionsArchived([a.replace(/\\/g, '/').toUpperCase()], false);

    expect(await registry(agentDir)).toEqual({ sessions: [] });
    expect((await service.listAllSessions()).some((s) => s.archived)).toBe(false);
  });

  it('does not record the same session twice', async () => {
    const { service, agentDir, a } = await withSessions();
    await service.setSessionsArchived([a, a], true);
    await service.setSessionsArchived([a], true);
    expect(await registry(agentDir)).toEqual({ sessions: [a] });
  });

  it('serializes concurrent archive writes', async () => {
    const { service, agentDir, a, b } = await withSessions();
    await Promise.all([service.setSessionsArchived([a], true), service.setSessionsArchived([b], true)]);
    expect((await registry(agentDir)).sessions.sort()).toEqual([a, b].sort());
  });

  it('refuses to archive files outside the sessions directory or hidden sessions', async () => {
    const { service, agentDir, workspace } = await withSessions();
    const outside = join(agentDir, 'outside.jsonl');
    await writeFile(outside, `${JSON.stringify({ type: 'session', cwd: workspace })}\n`);
    const child = join(agentDir, 'sessions', 'hash', 'child.jsonl');
    await writeFile(child, childLines('sa-1', workspace, null));

    await expect(service.setSessionsArchived([outside], true)).rejects.toThrow('session file not in sessions directory');
    await expect(service.setSessionsArchived([child], true)).rejects.toThrow('SESSION_NOT_FOUND');
    await expect(service.setSessionsArchived([join(agentDir, 'sessions', 'missing.jsonl')], true)).rejects.toThrow('session file not found');
  });

  it('forgets an archived session when it is deleted', async () => {
    const { service, agentDir, workspace, a, b } = await withSessions();
    await service.setSessionsArchived([a, b], true);

    await service.deleteSession(workspace, a);

    expect(await registry(agentDir)).toEqual({ sessions: [b] });
  });

  it('drops entries whose files are gone on a full scan', async () => {
    const { service, agentDir, a, b } = await withSessions();
    await service.setSessionsArchived([a, b], true);
    await rm(a);

    const all = await service.listAllSessions();

    expect(all.map((s) => [s.path, s.archived])).toEqual([[b, true]]);
    expect(await registry(agentDir)).toEqual({ sessions: [b] });
  });

  it('keeps archived conversation directories when pruning orphans', async () => {
    const { service, agentDir } = await createService();
    const { cwd } = await service.createConversation();
    const sessions = join(agentDir, 'sessions', 'conv'); await mkdir(sessions, { recursive: true });
    const path = join(sessions, 'c.jsonl');
    await writeFile(path, `${JSON.stringify({ type: 'session', id: 'c', cwd, timestamp: '2026-10-01T00:00:00Z' })}\n`);
    await service.setSessionsArchived([path], true);

    // 重启后没有草稿记忆，只靠「目录里有会话」保住它。
    const restarted = new WorkspaceService(agentDir);
    await expect(restarted.pruneOrphanConversations([])).resolves.toBe(0);
    await expect(realpath(cwd)).resolves.toBeTruthy();
  });

  it('treats a corrupt registry as empty', async () => {
    const { service, agentDir, a } = await withSessions();
    await writeFile(join(agentDir, 'archived-sessions.json'), '{not json');

    expect((await service.listAllSessions()).some((s) => s.archived)).toBe(false);
    await service.setSessionsArchived([a], true);
    expect(await registry(agentDir)).toEqual({ sessions: [a] });
  });
});
