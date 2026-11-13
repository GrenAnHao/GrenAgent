import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { isValidNpmName, isValidSemver } from './piPackageModel';

export type PackageMetadataRunner = (command: string, args: string[], cwd: string) => Promise<string>;
/** Native npm reads its normal registry/auth configuration; no credential values are requested. */
export const runPackageMetadata: PackageMetadataRunner = (command, args, cwd) => new Promise((done, fail) => {
  const windows = process.platform === 'win32';
  // A constant PowerShell program invokes a structured argument array; none of the request is evaluated as script.
  const program = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; try { $r=ConvertFrom-Json([Console]::In.ReadToEnd()); $a=@($r.args | ForEach-Object { $_.Replace('\"','\\\"') }); & $r.command @a; if($null -eq $LASTEXITCODE){exit 0}else{exit $LASTEXITCODE} } catch { [Console]::Error.WriteLine('Package metadata command failed'); exit 1 }";
  const executable = windows ? join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : command;
  const child = execFile(executable, windows ? ['-NoProfile', '-NonInteractive', '-Command', program] : args, {
    cwd, windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false', GIT_TERMINAL_PROMPT: '0' },
  }, (error, stdout) => error ? fail(new Error('无法读取 npm 版本元数据')) : done(stdout));
  if (windows) child.stdin?.end(JSON.stringify({ command, args }));
});

export async function readNpmVersions(input: {
  cwd: string; name: string; npmCommand?: string[]; run?: PackageMetadataRunner;
}): Promise<string[]> {
  if (!isValidNpmName(input.name)) throw new Error('INVALID_PACKAGE');
  const [command = 'npm', ...prefix] = input.npmCommand ?? [];
  if (!command || ![command, ...prefix].every((part) => typeof part === 'string' && !part.includes('\0'))) throw new Error('INVALID_NPM_COMMAND');
  try {
    const text = await (input.run ?? runPackageMetadata)(command, [...prefix, 'view', input.name, 'versions', '--json'], input.cwd);
    const values: unknown = JSON.parse(text);
    const versions = Array.isArray(values) ? values : [values];
    if (!versions.every((version) => typeof version === 'string' && isValidSemver(version))) throw new Error('invalid metadata');
    return versions as string[];
  } catch { throw new Error('无法读取 npm 版本元数据'); }
}
