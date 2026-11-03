import { describe, expect, it, vi } from 'vitest';
import { pi } from './pi';
import * as runtime from '../platform/runtime';

const prefs = {
  model: { provider: 'anthropic', id: 'opus' },
  thinkingLevel: 'high',
  mode: 'agent' as const,
  approval: 'auto' as const,
  revision: 0,
};

describe('pi session preference bridge', () => {
  it('routes model and thinking setters to the original session path', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({});
    try {
      await pi.setModel('/ws', 'anthropic', 'opus', '/ws/.pi/sessions/a.jsonl');
      await pi.setThinkingLevel('/ws', 'high', '/ws/.pi/sessions/a.jsonl');
      expect(spy.mock.calls).toEqual([
        ['agent_set_model', { workspace: '/ws', provider: 'anthropic', modelId: 'opus', targetSessionPath: '/ws/.pi/sessions/a.jsonl' }],
        ['agent_set_thinking_level', { workspace: '/ws', level: 'high', targetSessionPath: '/ws/.pi/sessions/a.jsonl' }],
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('omits targetSessionPath when no session identity is given (legacy callers)', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({});
    try {
      await pi.setModel('/ws', 'anthropic', 'opus');
      await pi.setThinkingLevel('/ws', 'off');
      expect(spy.mock.calls).toEqual([
        ['agent_set_model', { workspace: '/ws', provider: 'anthropic', modelId: 'opus' }],
        ['agent_set_thinking_level', { workspace: '/ws', level: 'off' }],
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('routes the session Fast toggle to the original session path, keeping false', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({});
    try {
      await pi.setFastMode('/ws', true, '/ws/.pi/sessions/a.jsonl');
      await pi.setFastMode('/ws', false, '/ws/.pi/sessions/b.jsonl');
      expect(spy.mock.calls).toEqual([
        ['agent_set_fast_mode', { workspace: '/ws', enabled: true, targetSessionPath: '/ws/.pi/sessions/a.jsonl' }],
        ['agent_set_fast_mode', { workspace: '/ws', enabled: false, targetSessionPath: '/ws/.pi/sessions/b.jsonl' }],
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('omits targetSessionPath for a Fast toggle without a session identity', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({});
    try {
      await pi.setFastMode('/ws', true);
      expect(spy.mock.calls).toEqual([
        ['agent_set_fast_mode', { workspace: '/ws', enabled: true }],
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('reads and writes explicit project defaults through their own commands', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue(prefs);
    try {
      await pi.getSessionDefaults('/ws');
      await pi.setSessionDefaults('/ws', prefs);
      expect(spy.mock.calls).toEqual([
        ['agent_get_session_defaults', { workspace: '/ws' }],
        ['agent_set_session_defaults', { workspace: '/ws', preferences: prefs }],
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('passes draft initial preferences when creating the session', async () => {
    const spy = vi.spyOn(runtime, 'invoke').mockResolvedValue({});
    try {
      await pi.newSession('/ws', prefs);
      await pi.newSession('/ws');
      expect(spy.mock.calls).toEqual([
        ['agent_new_session', { workspace: '/ws', initialPreferences: prefs }],
        ['agent_new_session', { workspace: '/ws', initialPreferences: undefined }],
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});
