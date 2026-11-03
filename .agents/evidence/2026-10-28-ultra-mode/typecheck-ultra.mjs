import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const app = join(repo, 'electron-agent');
const targets = [
  'extensions/_shared/ultra-context.ts',
  'extensions/agent-mode/modes.ts', 'extensions/agent-mode/planState.ts', 'extensions/agent-mode/index.ts', 'extensions/agent-mode/ultra-rules.ts',
  'extensions/context-rules/index.ts', 'extensions/context-rules/rules.ts', 'extensions/fable-behavior/loader.ts',
  'extensions/multi-agent/index.ts', 'extensions/multi-agent/routing.ts', 'extensions/multi-agent/model-selection.ts', 'extensions/multi-agent/list-models-tool.ts',
  'extensions/multi-agent/tasks.ts', 'extensions/multi-agent/agents.ts', 'extensions/multi-agent/embedded-runner.ts', 'extensions/multi-agent/activation.ts',
  'extensions/multi-agent/worker-host.ts', 'extensions/multi-agent/worker-session.ts', 'extensions/multi-agent/worker-protocol.ts',
  'electron-agent/src/stores/modeStore.ts', 'electron-agent/src/features/chat/input/actions/ModeAction.tsx',
  'electron-agent/src/features/settings/settingsSchema.ts', 'electron-agent/src/features/extensions/RulesPanel.tsx',
  'electron-agent/src/features/extensions/libraryStyles.ts', 'electron-agent/src/lib/promptLibraryIo.ts',
  'electron-agent/electron/app/promptLibraryService.ts', 'electron-agent/electron/ipc/register.ts', 'electron-agent/electron/agent/copyPiAdjacentAssets.ts',
  'electron-agent/ui-harness/scenarios/ultra-mode.tsx', 'electron-agent/ui-harness/scenarios/prompt-library-panel.tsx',
];
const files = targets.map((p) => join(repo, p));
for (const file of files) if (!existsSync(file)) throw new Error(`Missing target ${file}`);
const config = {
  extends: join(app, 'tsconfig.json'),
  compilerOptions: { composite: false, incremental: false, noEmit: true, types: ['node', 'vite/client'] },
  files,
  references: [],
};
const evidence = dirname(fileURLToPath(import.meta.url));
const configPath = join(app, `.ultra-typecheck-${process.pid}.json`);
writeFileSync(configPath, JSON.stringify(config, null, 2));
writeFileSync(join(evidence, 'tsconfig.ultra.json'), JSON.stringify(config, null, 2));
let result;
try {
  // TypeScript 7 ships a native CLI rather than the TypeScript 5 compiler API.
  result = spawnSync(process.execPath, [join(app, 'node_modules/typescript/bin/tsc'), '-p', configPath, '--noEmit', '--pretty', 'false'], {
    cwd: app, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
  });
} finally { rmSync(configPath, { force: true }); }
if (result.error) throw result.error;
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
writeFileSync(join(evidence, 'typecheck-scoped-all.log'), output);
const normalize = (p) => resolve(p).replaceAll('\\', '/').toLowerCase();
const owned = new Set(files.map(normalize));
const diagnostics = output.split(/\r?\n/).filter((line) => /\berror TS[0-9]+:/.test(line));
const relevant = diagnostics.filter((line) => {
  const match = /^(.*)\([0-9]+,[0-9]+\):/.exec(line);
  return !match || owned.has(normalize(resolve(app, match[1])));
});
console.log(`Checked ${targets.length} Ultra production/scenario files; ${relevant.length} target diagnostics; ${diagnostics.length - relevant.length} diagnostics in imported files outside this change.`);
if (relevant.length) console.log(relevant.join('\n'));
if (result.status && !diagnostics.length) console.log(output);
process.exitCode = relevant.length || (result.status && !diagnostics.length) ? 1 : 0;
