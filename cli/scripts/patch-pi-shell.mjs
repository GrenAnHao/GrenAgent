/**
 * Patch @earendil-works/pi-coding-agent shell resolution on Windows:
 * - use SystemRoot\System32\where.exe (process PATH may omit System32)
 * - search registry Machine+User PATH when locating git/bash
 * - derive Git Bash from `where git.exe` for non-default install paths
 *
 * Run after npm install.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const shellPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'utils',
  'shell.js',
);

if (!existsSync(shellPath)) {
  console.warn('patch-pi-shell: shell.js not found, skip');
  process.exit(0);
}

let src = readFileSync(shellPath, 'utf8');
if (src.includes('function getWindowsSearchPath()')) {
  console.log('patch-pi-shell: already patched');
  process.exit(0);
}

const marker = 'function isLegacyWslBashPath(path) {';
const helpers = `function winWhereExe() {
    const root = process.env.SystemRoot || process.env.WINDIR || "C:\\\\Windows";
    return \`\${root}\\\\System32\\\\where.exe\`;
}
function getWindowsSearchPath() {
    const seen = new Set();
    const parts = [];
    for (const chunk of (process.env.PATH ?? "").split(";")) {
        if (chunk && !seen.has(chunk.toLowerCase())) {
            seen.add(chunk.toLowerCase());
            parts.push(chunk);
        }
    }
    try {
        const ps = \`\${process.env.SystemRoot || process.env.WINDIR || "C:\\\\Windows"}\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\`;
        const result = spawnSync(ps, ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], {
            encoding: "utf-8",
            timeout: 5000,
            windowsHide: true,
        });
        if (result.status === 0 && result.stdout) {
            for (const chunk of result.stdout.trim().split(";")) {
                if (chunk && !seen.has(chunk.toLowerCase())) {
                    seen.add(chunk.toLowerCase());
                    parts.push(chunk);
                }
            }
        }
    }
    catch {
        // Ignore errors
    }
    return parts.join(";");
}
function spawnWhere(args) {
    return spawnSync(winWhereExe(), args, {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
        env: { ...process.env, PATH: getWindowsSearchPath() },
    });
}
function findGitBashFromGitCmd() {
    try {
        const result = spawnWhere(["git.exe"]);
        if (result.status === 0 && result.stdout) {
            const gitExe = result.stdout.trim().split(/\\r?\\n/)[0];
            if (gitExe) {
                const gitRoot = gitExe.replace(/\\\\cmd\\\\git\\.exe$/i, "").replace(/\\\\git\\.exe$/i, "");
                const bashPath = \`\${gitRoot}\\\\bin\\\\bash.exe\`;
                if (existsSync(bashPath)) {
                    return bashPath;
                }
            }
        }
    }
    catch {
        // Ignore errors
    }
    return null;
}
${marker}`;

if (!src.includes(marker)) {
  console.error('patch-pi-shell: unexpected shell.js shape');
  process.exit(1);
}

src = src.replace(marker, helpers);

src = src.replace(
  /const result = spawnSync\("where", \["bash\.exe"\], \{[\s\S]*?\}\);/,
  'const result = spawnWhere(["bash.exe"]);',
);

src = src.replace(
  /(\s+)for \(const path of paths\) \{\s+if \(existsSync\(path\)\) \{\s+return getBashShellConfig\(path\);\s+\}\s+\}/,
  `$1for (const path of paths) {
$1    if (existsSync(path)) {
$1        return getBashShellConfig(path);
$1    }
$1}
$1const gitBashFromCmd = findGitBashFromGitCmd();
$1if (gitBashFromCmd) {
$1    return getBashShellConfig(gitBashFromCmd);
$1}`,
);

writeFileSync(shellPath, src);
console.log('patch-pi-shell: patched', shellPath);
