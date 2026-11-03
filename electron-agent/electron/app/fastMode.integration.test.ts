import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRuntime, SessionManager } from '../../../cli/src/pi-sdk.js';
import { ProviderService } from './providerService.js';
import { snapshotSessionModel } from '../agent/workspaceHandle.js';
import { fastPreferenceKey, supportsFastMode, type FastModel } from '../../../extensions/_shared/fast-mode.js';
import fastMode from '../../../extensions/fast-mode/index.js';

const state = vi.hoisted(() => ({ dir: '' }));
afterEach(async () => { vi.unstubAllEnvs(); if (state.dir) await rm(state.dir, { recursive: true, force: true }); });

// Real disk, Pi model schema/resolution, extension handler and provider HTTP serializer.
describe('Fast integration', () => {
  it('merges concurrent per-model writes and survives service recreation', async () => {
    state.dir = await mkdtemp(join(tmpdir(), 'gren-fast-'));
    const service = new ProviderService({ agentDir: state.dir });
    await Promise.all([service.setFastPreference('claude', 'same/id', true), service.setFastPreference('openai', 'same/id', false)]);
    const reopened = new ProviderService({ agentDir: state.dir });
    expect(await reopened.getFastPreferences()).toEqual({ 'claude\0same/id': true, 'openai\0same/id': false });
    await reopened.setFastPreference('claude', 'same/id', false);
    expect(JSON.parse(await readFile(join(state.dir, 'fast-mode.json'), 'utf8'))).toEqual({ 'claude\0same/id': false, 'openai\0same/id': false });
  });

  for (const api of ['anthropic-messages', 'openai-responses', 'openai-completions', 'openai-codex-responses'] as const) {
    it(`${api}: Fast reaches wire only with capability AND preference, thinking unchanged`, async () => {
      state.dir = await mkdtemp(join(tmpdir(), 'gren-fast-'));
      vi.stubEnv('PI_CODING_AGENT_DIR', state.dir);
      const provider = 'relay';
      await writeFile(join(state.dir, 'models.json'), JSON.stringify({ providers: { relay: {
        api, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fake', models: [{
          id: 'fixture-model', reasoning: true, input: ['text', 'image'],
          thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
          compat: { supportsFastMode: true, ...(api === 'anthropic-messages' ? { forceAdaptiveThinking: true } : {}) },
        }],
      } } }));
      const runtime = await ModelRuntime.create({ modelsPath: join(state.dir, 'models.json'), authPath: join(state.dir, 'auth.json'), allowModelNetwork: false });
      const model = runtime.getModel(provider, 'fixture-model')!;
      expect(runtime.getError()).toBeUndefined();
      expect(supportsFastMode(model)).toBe(true);
      expect(snapshotSessionModel(model)).toMatchObject({ fast: true, reasoning: true, input: ['text', 'image'] });
      let handler: (event: { payload: unknown }, ctx: unknown) => Promise<unknown>;
      fastMode({ on: (_name: string, fn: typeof handler) => { handler = fn; } } as never);
      const service = new ProviderService({ agentDir: state.dir });
      const sent: Array<{ body: Record<string, any>; headers: Headers }> = [];
      let live: FastModel = model;
      const a = SessionManager.create(state.dir, join(state.dir, 'sessions'));
      const b = SessionManager.create(state.dir, join(state.dir, 'sessions'));
      const saveFast = (manager: SessionManager, fastMode: boolean, revision: number) =>
        manager.appendCustomEntry('session-preferences', { fastMode, revision });
      saveFast(a, false, 1);
      b.appendCustomEntry('session-preferences', { mode: 'agent', revision: 1 });
      const context = { model, modelRegistry: { find: () => live }, sessionManager: a };
      // The legacy shared preference must not enable either session.
      await service.setFastPreference(provider, model.id, true);
      const send = async () => {
        const response = await runtime.streamSimple(model, { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }, {
          apiKey: api === 'openai-codex-responses'
            ? `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.signature`
            : 'fake',
          transport: 'sse', reasoning: 'high', maxRetries: 0,
          onPayload: (body) => handler({ payload: body }, context),
          fetch: (async (_url, init) => {
            const headers = new Headers(init?.headers);
            const bytes = await new Response(init?.body).arrayBuffer();
            const json = headers.get('content-encoding') === 'zstd'
              ? zstdDecompressSync(Buffer.from(bytes)).toString('utf8')
              : Buffer.from(bytes).toString('utf8');
            sent.push({ body: JSON.parse(json), headers });
            // Deliberately stop at the transport boundary; never call an external paid service.
            return new Response(JSON.stringify({ error: { message: 'fixture-stop', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
          }) as typeof fetch,
        }).result();
        expect(response.stopReason).toBe('error');
        expect(sent.length, response.errorMessage).toBeGreaterThan(0);
        return sent.at(-1)!;
      };
      const initial = await send();
      expect((await service.getFastPreferences())[fastPreferenceKey(provider, model.id)]).toBe(true);
      saveFast(a, true, 2);
      const enabled = await send();
      if (api === 'anthropic-messages') {
        expect(initial.body.speed).toBeUndefined();
        expect(enabled.body.speed).toBe('fast');
        expect(enabled.headers.get('anthropic-beta')).toContain('fast-mode-2026-02-01');
        expect(enabled.body.thinking).toEqual(initial.body.thinking);
        expect(enabled.body.output_config).toEqual(initial.body.output_config);
      } else {
        expect(initial.body.service_tier).toBeUndefined();
        expect(enabled.body.service_tier).toBe('priority');
        expect(enabled.body.reasoning ?? enabled.body.reasoning_effort).toEqual(initial.body.reasoning ?? initial.body.reasoning_effort);
      }
      context.sessionManager = b;
      const legacySession = await send();
      expect(legacySession.body.speed).toBeUndefined();
      expect(legacySession.body.service_tier).toBeUndefined();
      saveFast(b, false, 2);
      const otherSession = await send();
      expect(otherSession.body.speed).toBeUndefined();
      expect(otherSession.body.service_tier).toBeUndefined();
      context.sessionManager = a;
      saveFast(a, false, 3);
      const disabled = await send();
      expect(disabled.body.speed).toBeUndefined();
      expect(disabled.body.service_tier).toBeUndefined();
      expect(api === 'anthropic-messages' ? enabled.body.speed : enabled.body.service_tier)
        .toBe(api === 'anthropic-messages' ? 'fast' : 'priority');
      saveFast(a, true, 4);
      const revokedCompat = { ...model.compat, supportsFastMode: false };
      live = { ...model, compat: revokedCompat };
      const revoked = await send();
      expect(revoked.body.speed).toBeUndefined();
      expect(revoked.body.service_tier).toBeUndefined();
    });
  }
});
