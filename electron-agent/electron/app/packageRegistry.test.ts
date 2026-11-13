import { expect, it, vi } from 'vitest';
import { readNpmVersions, runPackageMetadata } from './packageRegistry';
it('uses configured package-manager arguments rather than reading credential files or installing', async () => {
  const run = vi.fn(async (_command: string, _args: string[], _cwd: string) => '["1.0.0","1.1.0"]');
  expect(await readNpmVersions({ cwd: '/fixture', npmCommand: ['fixture-npm', '--registry', 'https://registry.example'], name: '@scope/demo', run })).toEqual(['1.0.0', '1.1.0']);
  expect(run).toHaveBeenCalledWith('fixture-npm', ['--registry', 'https://registry.example', 'view', '@scope/demo', 'versions', '--json'], '/fixture');
});
it('rejects invalid names before starting any command and hides command errors', async () => {
  const run = vi.fn(async () => { throw new Error('https://user:secret@private.invalid'); });
  await expect(readNpmVersions({ cwd: '/fixture', name: 'demo;echo-secret', run })).rejects.toThrow('INVALID_PACKAGE');
  expect(run).not.toHaveBeenCalled();
  await expect(readNpmVersions({ cwd: '/fixture', name: 'demo', run })).rejects.toThrow('无法读取 npm 版本元数据');
});
it('passes unicode and script-like arguments literally through the native runner', async () => {
  const args = ['中文', 'space value', '$(throw "injected")', 'quote"value'];
  const text = await runPackageMetadata(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args], process.cwd());
  expect(JSON.parse(text)).toEqual(args);
});
