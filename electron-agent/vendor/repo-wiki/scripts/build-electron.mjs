// One standalone CJS child entry for GrenAgent's Electron/CJS build and asarUnpack.
import {build} from 'esbuild';
await build({entryPoints:['packages/process/src/child.ts'],bundle:true,platform:'node',format:'cjs',target:'node22',outfile:'dist/electron/repo-wiki-host.cjs',sourcemap:true,legalComments:'eof',external:['node:*']});
console.log('Built dist/electron/repo-wiki-host.cjs — separate process entry, no Python runtime');
