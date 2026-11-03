import { resolve } from 'node:path';
import { build, type BuildOptions } from 'esbuild';

export const REPO_WIKI_HOST_ENTRY = 'repo-wiki-host.cjs';

export function repoWikiHostBuildOptions(appDir: string, mainOutDir: string): BuildOptions {
  return {
    absWorkingDir: appDir,
    entryPoints: [resolve(appDir, 'electron/knowledgeProcess/hostEntry.ts')],
    outfile: resolve(mainOutDir, REPO_WIKI_HOST_ENTRY),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    legalComments: 'inline',
    metafile: true,
    logLevel: 'warning',
    plugins: [{
      name: 'knowledge-sdk-tool-schemas',
      setup(plugin) {
        plugin.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, args => args.importer.endsWith('readTools.ts') ? { path: 'tool-schemas', namespace: 'knowledge-schema' } : undefined);
        plugin.onLoad({ filter: /.*/, namespace: 'knowledge-schema' }, async () => {
          const sdk = await import('@earendil-works/pi-coding-agent');
          const clone = (value: any): any => Array.isArray(value) ? value.map(clone) : value && typeof value === 'object' ? Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, clone(value[key])])) : value;
          const definitions = [['createReadTool', sdk.createReadTool], ['createFindTool', sdk.createFindTool], ['createGrepTool', sdk.createGrepTool], ['createLsTool', sdk.createLsTool]] as const;
          return { loader: 'js', contents: definitions.map(([name, create]) => { const tool = create(appDir); return `export const ${name} = () => (${JSON.stringify({ name: tool.name, label: tool.label, description: tool.description, parameters: clone(tool.parameters) })});`; }).join('\n') };
        });
      },
    }],
  };
}

// A separate build keeps SQLite and the engine out of the main graph and the
// bytecode transform. The unpacked child must not resolve packages from asar.
export async function buildRepoWikiHost(appDir: string, mainOutDir: string) {
  return build(repoWikiHostBuildOptions(appDir, mainOutDir));
}
