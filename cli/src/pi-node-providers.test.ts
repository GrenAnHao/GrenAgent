import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("SDK entry keeps OAuth and Bedrock implementations loadable in a standalone split bundle", async () => {
  const out = mkdtempSync(join(tmpdir(), "pi-node-providers-"));
  try {
    writeFileSync(join(out, "package.json"), '{"type":"module"}');
    await build({
      stdin: {
        contents: `
          import './pi-sdk.js';
          export { metaProvider } from '@earendil-works/pi-ai/providers/meta';
          export { bedrockConverseStreamApi } from '@earendil-works/pi-ai/compat';
        `,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      },
      bundle: true,
      splitting: true,
      platform: "node",
      format: "esm",
      outdir: out,
      outExtension: { ".js": ".mjs" },
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      plugins: [{
        name: "external-sdk-surface",
        setup(builder) {
          // This test consumes the entry's provider registration, not coding-agent's unrelated exports.
          builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
            path: import.meta.resolve("@earendil-works/pi-coding-agent"), external: true,
          }));
        },
      }],
    });
    const probe = `
      import assert from 'node:assert/strict';
      globalThis.fetch = () => { throw new Error('unexpected network'); };
      const { metaProvider, bedrockConverseStreamApi } = await import('./stdin.mjs');
      assert.deepEqual(await metaProvider().auth.oauth.toAuth({ type: 'oauth', access: 'fixture', refresh: '', expires: Number.MAX_SAFE_INTEGER }), { apiKey: 'fixture' });
      const context = { get messages() { throw new Error('bedrock implementation reached'); } };
      const result = await bedrockConverseStreamApi().stream({ id: 'fixture', api: 'bedrock-converse-stream', provider: 'amazon-bedrock' }, context).result();
      assert.equal(result.errorMessage, 'bedrock implementation reached');
      console.log('OAuth and Bedrock lazy chunks loaded without network');
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
      cwd: out, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.match(result.stdout, /lazy chunks loaded without network/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
