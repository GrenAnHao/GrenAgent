import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '../cli/src/pi-sdk.ts';
const dir = await mkdtemp(join(tmpdir(), 'repo-wiki-sdk-header-probe-'));
try {
  const configuration = { providers: { workflow: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'offline-key', headers: {} as Record<string, string>, models: [{ id: 'same-model', reasoning: false, input: ['text'] }] } } };
  const modelsPath = join(dir, 'models.json');
  await writeFile(modelsPath, JSON.stringify(configuration));
  const runtime = await ModelRuntime.create({ modelsPath, authPath: join(dir, 'auth.json'), allowModelNetwork: false });
  const before = runtime.getModel('workflow', 'same-model')!;
  const beforeConfig = runtime.getCompatibilityRequestConfig(before);
  configuration.providers.workflow.headers['x-workflow-version'] = '2';
  await writeFile(modelsPath, JSON.stringify(configuration));
  await runtime.refresh({ allowNetwork: false });
  const after = runtime.getModel('workflow', 'same-model')!;
  console.log(JSON.stringify({ sameBareModel: JSON.stringify(before) === JSON.stringify(after), beforeConfig, afterConfig: runtime.getCompatibilityRequestConfig(after) }));
} finally { await rm(dir, { recursive: true, force: true }); }
