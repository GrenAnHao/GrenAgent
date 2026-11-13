import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentDataService } from '../app/agentDataService';
import { AgentDataRuntime } from './runtime';

describe('thread RPC parameter contract', () => {
  let dir: string;
  let service: AgentDataService;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'thread-rpc-'));
    service = new AgentDataService({ runtime: new AgentDataRuntime({ dataPath: join(dir, 'data.db') }) });
    await service.start();
    await service.createThread({ id: 'thread', projectId: 'project', workspace: dir });
  });
  afterEach(async () => {
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['普通文字消息', '', ' \n\t', '  原样保留\n正文  '])('round-trips text input %j without treating it as an identifier', async (input) => {
    await expect(service.createTurn({ id: 'turn', threadId: 'thread', input, permissionProfile: 'workspace' }))
      .resolves.toMatchObject({ input, status: 'queued' });
    expect((await service.readThread('thread'))?.turns[0].input).toBe(input);
  });

  it.each([undefined, null, 42])('rejects non-string input %j with its RPC field name', async (input) => {
    await expect(service.request('turn.create', { id: 'turn', threadId: 'thread', input, permissionProfile: 'workspace' }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'turn.create.input must be a string' });
  });

  it.each(['id', 'threadId', 'permissionProfile'])('still rejects blank %s with its RPC field name', async (field) => {
    await expect(service.request('turn.create', { id: 'turn', threadId: 'thread', input: 'private message', permissionProfile: 'workspace', [field]: ' ' }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS', message: `turn.create.${field} must be a non-empty string` });
  });
});
