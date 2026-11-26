import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelRuntime, SessionManager, SettingsManager } from '../../../cli/src/pi-sdk.js';
import { createAgentSessionServices, createAgentSessionFromServices } from '../../../cli/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import contextRules from '../../../extensions/context-rules/index.js';
import { RULE_INJECTION_ENTRY } from '../../../extensions/context-rules/injectionNotice.js';
import { workflowHistoryMessages } from './sessionWorkflowData.js';
import { toRendererEvent } from '../agent/streamingEvent.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('records only effective rules once per run, outside the provider payload and with current-branch replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gren-rule-injection-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const projectRules = join(cwd, '.pi', 'rules');
  const modelsPath = join(root, 'models.json');
  vi.stubEnv('PI_CODING_AGENT_DIR', root);
  await mkdir(join(root, 'rules'));
  await mkdir(projectRules, { recursive: true });
  await writeFile(join(root, 'rules', 'language.md'), '---\ntitle: 全局语言\n---\nfixture-global-body');
  await writeFile(join(projectRules, 'format.md'), '---\ntitle: 项目格式\n---\nfixture-project-body');
  await writeFile(join(projectRules, 'typed.md'), '---\ntitle: TS 范围\nglobs: ["src/**/*.ts"]\n---\nfixture-glob-body');
  await writeFile(join(projectRules, 'disabled.md'), '---\nenabled: false\n---\nfixture-disabled-body');
  await writeFile(join(projectRules, 'ultra.md'), '---\nmodes: [ultra]\n---\nfixture-ultra-body');
  await writeFile(modelsPath, JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', baseUrl: 'https://never-called.invalid/v1', apiKey: 'fixture-only',
    models: [{ id: 'local', contextWindow: 32000, maxTokens: 1024 }],
  } } }));
  const modelRuntime = await ModelRuntime.create({ modelsPath, authPath: join(root, 'auth.json'), allowModelNetwork: false });
  let changePrompt = false;
  const services = await createAgentSessionServices({
    cwd, agentDir: root, modelRuntime,
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false } }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [contextRules, (pi) => {
        pi.on('before_agent_start', (event) => {
          if (changePrompt) event.systemPromptOptions.contextFiles = [];
        });
      }],
    },
  });
  const manager = SessionManager.create(cwd, join(root, 'sessions'));
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager,
    model: modelRuntime.getModel('fixture', 'local')!, noTools: 'all' });
  const payloads: string[] = [];
  const wire: Array<Record<string, unknown>> = [];
  session.subscribe((event) => wire.push(toRendererEvent(event)));
  const originalStream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => originalStream(model, context, {
    ...options, fetch: async (_url, init) => {
      payloads.push(String(init?.body));
      const chunk = { id: 'fixture', model: 'local', created: 1, object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'fixture reply' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  try {
    await session.bindExtensions({ mode: 'rpc' });
    await session.prompt('first');
    await session.prompt('second @src/lib.ts');
    changePrompt = true;
    await session.prompt('third');
    expect(payloads).toHaveLength(3);
    for (const payload of payloads.slice(0, 2)) {
      expect(payload).toContain('fixture-global-body');
      expect(payload).toContain('fixture-project-body');
      expect(payload).not.toMatch(/fixture-(disabled|ultra)-body|已注入规则|context-rule-injection|全局语言/);
    }
    expect(payloads[0]).not.toContain('fixture-glob-body');
    expect(payloads[1]).toContain('fixture-glob-body');
    expect(payloads[2]).not.toContain('fixture-glob-body');
    expect(payloads[2]).not.toMatch(/fixture-(global|project)-body|已注入规则/);
    const notices = wire.filter((event) => event.type === 'entry_appended' &&
      (event.entry as { customType?: string })?.customType === RULE_INJECTION_ENTRY);
    expect(notices).toHaveLength(2);
    const reopened = SessionManager.open(manager.getSessionFile()!);
    const history = workflowHistoryMessages(reopened);
    const receipts = history.filter((message) => message.customType === RULE_INJECTION_ENTRY);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({
      entryId: (notices[0].entry as { id: string }).id,
      inContext: false,
      details: { rules: [
        { id: 'language', title: '全局语言', scope: 'global' },
        { id: 'format', title: '项目格式', scope: 'project' },
      ] },
    });
    expect(receipts[1].entryId).not.toBe(receipts[0].entryId);
    expect(history.filter(message => message.role !== 'system').map((message) => message.role))
      .toEqual(['user', 'custom', 'assistant', 'user', 'custom', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(receipts)).not.toMatch(/fixture-(global|project)-body/);
    expect(reopened.buildSessionProjection().messages.some(message => message.role === 'custom')).toBe(false);
    const firstUser = history.find((message) => message.role === 'user')!;
    reopened.branch(firstUser.entryId);
    expect(workflowHistoryMessages(reopened).some(message => message.customType === RULE_INJECTION_ENTRY)).toBe(false);
  } finally { session.dispose(); }
}, 15_000);
