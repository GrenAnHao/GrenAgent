import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoWikiService } from './repoWikiService';
import { WorkspaceService } from './workspaceService';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('RepoWiki lazy host boundary', () => {
  it('binds the renderer context without reading roots, resolving a model, or starting a child', async () => {
    const commands = new Map<string, (event: any, input: any) => Promise<any>>();
    const roots = vi.fn(async () => { throw new Error('activation read host roots'); });
    const resolveModel = vi.fn(async () => { throw new Error('activation resolved a model'); });
    const event = { sender: { id: 41, send() {}, isDestroyed: () => false } };
    const service = new RepoWikiService({
      entry: 'unused-child.cjs', dataDir: 'unused-data', configurationPollMs: 0,
      registerCommand: (name, handler) => { commands.set(name, handler); return () => commands.delete(name); },
      isTrustedSender: () => true, allowedWorkspaces: roots, resolveModel,
    });
    cleanups.push(() => service.stop());
    const activation = await commands.get('repoWiki_activate')!(event, { workspace: 'D:\\host\\current' });
    expect(activation.workspace).toBe('D:\\host\\current');
    expect(activation.project_id).toBeNull();
    expect(activation.context_id).toBeTypeOf('string');
    expect(service.pid).toBeUndefined();
    expect(roots).not.toHaveBeenCalled();
    expect(resolveModel).not.toHaveBeenCalled();
    expect(commands.has('repoWiki_hydrate')).toBe(true);
  });

  it('rotates A-B-A tokens while the child has never been requested', async () => {
    const commands = new Map<string, (event: any, input: any) => Promise<any>>();
    const event = { sender: { id: 42, send() {}, isDestroyed: () => false } };
    const service = new RepoWikiService({
      entry: 'unused-child.cjs', dataDir: 'unused-data', configurationPollMs: 0,
      registerCommand: (name, handler) => { commands.set(name, handler); return () => commands.delete(name); },
      isTrustedSender: () => true,
      allowedWorkspaces: async () => { throw new Error('activation read host roots'); },
      resolveModel: async () => { throw new Error('activation resolved a model'); },
    });
    cleanups.push(() => service.stop());
    const activate = (workspace: string) => commands.get('repoWiki_activate')!(event, { workspace });
    const a = await activate('D:\\host\\a'), b = await activate('D:\\host\\b'), again = await activate('D:\\host\\a');
    expect(new Set([a.context_id, b.context_id, again.context_id]).size).toBe(3);
    expect(service.pid).toBeUndefined();
    await expect(commands.get('repoWiki_health')!(event, { __repoWikiContext: a.context_id })).rejects.toMatchObject({ status: 409 });
  });

  it('reads authoritative project records without stat or realpath of their targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repowiki-host-snapshot-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(root, { recursive: true });
    const absent = join(root, 'not-mounted-project');
    await writeFile(join(root, 'opened-projects.json'), JSON.stringify({ projects: [absent] }));
    const workspace = new WorkspaceService(root);
    expect(typeof (workspace as any).getProjectSnapshot).toBe('function');
    expect(typeof (workspace as any).readProjectSnapshot).toBe('function');
    expect((workspace as any).getProjectSnapshot()).toBeUndefined();
    expect(await (workspace as any).readProjectSnapshot()).toEqual([absent]);
    expect((workspace as any).getProjectSnapshot()).toEqual([absent]);
  });

  it('revokes its fast snapshot when authoritative registry metadata becomes unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repowiki-host-corrupt-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const file = join(root, 'opened-projects.json');
    await writeFile(file, JSON.stringify({ projects: [join(root, 'project')] }));
    const workspace = new WorkspaceService(root);
    await workspace.readProjectSnapshot();
    await writeFile(file, '{broken-json');
    await expect(workspace.readProjectSnapshot()).rejects.toThrow();
    expect(workspace.getProjectSnapshot()).toEqual([]);
  });
});
