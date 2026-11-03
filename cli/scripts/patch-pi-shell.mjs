/** Supplement Pi's Windows shell discovery; preserve the upstream shell checks. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Each package's postinstall passes its own root. The original CLI invocation
// without an argument remains supported, independently of the caller's cwd.
const projectRoot = process.argv[2]
  ? resolve(process.argv[2])
  : join(dirname(fileURLToPath(import.meta.url)), '..');
const shellPath = join(projectRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js');

if (!existsSync(shellPath)) {
  console.warn('patch-pi-shell: shell.js not found, skip');
  process.exit(0);
}

const source = readFileSync(shellPath, 'utf8');
const patchMarker = '// GrenAgent Windows shell discovery v2';
const whereCall = 'const result = spawnWhere([executable]);';
const gitFallback = `const gitBashFromCmd = findGitBashFromGitCmd();
        if (gitBashFromCmd) {
            return getBashShellConfig(gitBashFromCmd);
        }
        `;

function unexpectedShape() {
  console.error('patch-pi-shell: unexpected shell.js shape; reinstall the supported Pi SDK before patching');
  process.exit(1);
}

if (source.includes(patchMarker)) {
  if (!source.includes(whereCall) || !source.includes(gitFallback) ||
      !source.includes('if (shellPathExists(bashPath))') || source.includes('spawnSync("where",')) {
    unexpectedShape();
  }
  console.log('patch-pi-shell: already patched', shellPath);
  process.exit(0);
}

const helperAnchor = 'function isLegacyWslBashPath(path) {';
const fallbackAnchor = '// 3. Fallback: search bash.exe on PATH (Cygwin, MSYS2, WSL, etc.)';
const upstreamWhere = /const result = spawnSync\("where", \[executable\], \{[\s\S]*?\}\);/g;
if (source.includes('function getWindowsSearchPath()') ||
    source.split(helperAnchor).length !== 2 || source.split(fallbackAnchor).length !== 2 ||
    !source.includes('function shellPathExists(path) {') ||
    !source.includes('import { delimiter, join, win32 } from "node:path";') ||
    [...source.matchAll(upstreamWhere)].length !== 1) {
  unexpectedShape();
}

const helpers = String.raw`${patchMarker}
function winWhereExe() {
    return win32.join(process.env.SystemRoot || process.env.WINDIR || "C:/Windows", "System32", "where.exe");
}
function getWindowsSearchPath() {
    const seen = new Set();
    const parts = [];
    const add = (value) => {
        for (const chunk of value.split(";")) {
            if (chunk && !seen.has(chunk.toLowerCase())) {
                seen.add(chunk.toLowerCase());
                parts.push(chunk);
            }
        }
    };
    add(process.env.PATH ?? "");
    try {
        const ps = win32.join(process.env.SystemRoot || process.env.WINDIR || "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const result = spawnSync(ps, ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"], {
            encoding: "utf-8",
            timeout: 5000,
            windowsHide: true,
        });
        if (result.status === 0 && result.stdout) add(result.stdout.trim());
    }
    catch {
        // Registry PATH is an optional supplement to the process PATH.
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
            const gitExe = result.stdout.trim().split(/\r?\n/)[0];
            if (gitExe) {
                const gitRoot = gitExe.replace(/\\cmd\\git\.exe$/i, "").replace(/\\git\.exe$/i, "");
                const bashPath = win32.join(gitRoot, "bin", "bash.exe");
                if (shellPathExists(bashPath)) {
                    return bashPath;
                }
            }
        }
    }
    catch {
        // Continue with Pi's normal bash-on-PATH fallback.
    }
    return null;
}
`;

const patched = source
  .replace(helperAnchor, helpers + helperAnchor)
  .replace(upstreamWhere, whereCall)
  .replace(fallbackAnchor, gitFallback + fallbackAnchor);
writeFileSync(shellPath, patched);
console.log('patch-pi-shell: patched', shellPath);
