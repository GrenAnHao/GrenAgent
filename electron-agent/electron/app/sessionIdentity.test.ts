import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readSessionIdentity } from './sessionIdentity';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('readSessionIdentity', () => {
  it('reads identity from a session header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-identity-')); roots.push(root);
    const file = join(root, 'session.jsonl');
    await writeFile(file, JSON.stringify({ type: 'session', id: 'session-a', cwd: 'C:/repo' }) + '\n');
    await expect(readSessionIdentity(file)).resolves.toEqual({ sessionId: 'session-a', sessionPath: file, workspace: 'C:/repo' });
  });

  it('falls back to encoded workspace path and filename id without a header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-identity-')); roots.push(root);
    const file = join(root, '--tmp-repo--', '2026-09-05T00-00-00-000Z_fallback-id.jsonl');
    await expect(readSessionIdentity(file)).resolves.toMatchObject({ sessionId: 'fallback-id', sessionPath: file, workspace: '/tmp/repo' });
  });

  it('rejects a workspace mismatch instead of trusting the caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-identity-')); roots.push(root);
    const file = join(root, 'session.jsonl');
    await writeFile(file, JSON.stringify({ type: 'session', id: 'session-a', cwd: 'C:/repo' }) + '\n');
    await expect(readSessionIdentity(file, 'C:/other')).rejects.toThrow('SESSION_WORKSPACE_MISMATCH');
  });

  it('checks the caller workspace against headerless metadata too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-identity-')); roots.push(root);
    const directory = join(root, '--C--repo--');
    const file = join(directory, '2026-09-05T00-00-00-000Z_123e4567-e89b-12d3-a456-426614174000.jsonl');
    await mkdir(directory, { recursive: true });
    await expect(readSessionIdentity(file, 'C:/other')).rejects.toThrow('SESSION_WORKSPACE_MISMATCH');
  });

  it('does not treat UUID hyphens in a conversation cwd as path separators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-identity-')); roots.push(root);
    const workspace = 'C:/Users/me/.pi/agent/works/3778c198-1830-4aa9-a0eb-78549e8c4456';
    const directory = join(root, '--C--Users-me-.pi-agent-works-3778c198-1830-4aa9-a0eb-78549e8c4456--');
    const file = join(directory, '2026-09-05T00-00-00-000Z_draft-session.jsonl');
    await mkdir(directory, { recursive: true });
    await writeFile(file, '{}\n');
    await expect(readSessionIdentity(file, workspace)).resolves.toMatchObject({
      sessionId: 'draft-session',
      sessionPath: file,
      workspace,
    });
  });

  it('rejects paths that do not contain the timestamp and id filename shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-identity-')); roots.push(root);
    await expect(readSessionIdentity(join(root, '--tmp-repo--', 'session.jsonl'))).rejects.toThrow('INVALID_SESSION_IDENTITY');
  });
});
