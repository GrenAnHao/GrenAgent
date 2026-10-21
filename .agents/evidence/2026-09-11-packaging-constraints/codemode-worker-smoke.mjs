// 在 Electron 的 node（ELECTRON_RUN_AS_NODE，和 agent-host 同一个 V8）里起 pi-codemode 的真实 host，
// worker 指向生产构建产出的 out/main/chunks/worker.js（字节码桩 → bytecode-loader → worker.jsc）。
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const app = process.argv[2];
const pkg = resolve(app, 'node_modules/.pnpm/@earendil-works+pi-codemode@1.3.0/node_modules/@earendil-works/pi-codemode/dist/index.js');
const { CodemodeSandbox } = await import(pathToFileURL(pkg).href);
const workerUrl = pathToFileURL(resolve(app, 'out/main/chunks/worker.js'));
const sandbox = new CodemodeSandbox({ workerUrl, timeoutMs: 20000 });
sandbox.registerTool({ name: 'search', execute: async (args) => `hit for ${args.pattern}` });
const result = await sandbox.execute('const r = await tools.search({ pattern: "CodeRetrievalPanel" }); text(r); return 42;');
console.log(JSON.stringify(result).slice(0, 600));
await sandbox.close();
process.exit(result.ok ? 0 : 1);
