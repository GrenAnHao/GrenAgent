import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createFindTool, createGrepTool, createLsTool, createReadTool } from '@earendil-works/pi-coding-agent';
import type { AgentTool } from '@earendil-works/pi-agent-core';

export interface KnowledgeSourceFile { path: string; hash: string }
/** Collapse sorted line numbers into inclusive [start, end] runs. */
function lineRuns(lines: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && line === last[1] + 1) last[1] = line; else runs.push([line, line]);
  }
  return runs;
}
/** Bytes kept free in a Read result for the continuation note. */
const READ_NOTE_RESERVE = 200;
export interface KnowledgeReadPolicy { root: string; maxFileBytes?: number; maxLines?: number; maxResultBytes?: number; maxMatches?: number; maxEntries?: number }
export interface KnowledgeToolObservation { path: string; hash?: string; kind: 'read' | 'search' | 'directory'; scope?: string; startLine?: number; endLine?: number; truncated?: boolean; readBytes?: number }

function bundledRgPath(): string {
  if (process.env.REPOWIKI_RG_PATH) return process.env.REPOWIKI_RG_PATH;
  const fromApp = createRequire(process.argv[1] || join(process.cwd(), 'package.json'));
  const fromPackage = createRequire(fromApp.resolve('@vscode/ripgrep'));
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const path = fromPackage.resolve(`@vscode/ripgrep-${process.platform}-${process.arch}/bin/${binary}`);
  return path.replace(/([\\/])app\.asar\1/i, '$1app.asar.unpacked$1');
}

/** Tools can only inspect files in the frozen source manifest. */
export function createKnowledgeReadTools(policy: KnowledgeReadPolicy, manifest: KnowledgeSourceFile[], observe: (value: KnowledgeToolObservation) => void = () => {}): AgentTool<any>[] {
  const root = realpathSync(policy.root);
  const maxFileBytes = policy.maxFileBytes ?? 262144, maxLines = policy.maxLines ?? 400, maxResultBytes = policy.maxResultBytes ?? 32768;
  const maxMatches = policy.maxMatches ?? 100, maxEntries = policy.maxEntries ?? 200;
  const files = new Map<string, KnowledgeSourceFile>();
  const normalize = (input: string) => {
    if (/^(?:\\\\|\/\/)/.test(input) || input.split(/[\\/]+/).includes('..')) throw new Error('FORBIDDEN_PATH');
    const full = isAbsolute(input) ? resolve(input) : resolve(root, input);
    const rel = relative(root, full).replace(/\\/g, '/');
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || /^(?:docs\/repo-wiki|\.git|\.agents)(?:\/|$)/i.test(rel) || /(?:^|\/)(?:\.transactions|\.cache|\.repowiki(?:-[^/]*)?)(?:\/|$)/i.test(rel)) throw new Error('FORBIDDEN_PATH');
    return rel;
  };
  for (const item of manifest) {
    const rel = normalize(item.path);
    if (!rel || files.has(rel.toLowerCase())) throw new Error('INVALID_MANIFEST');
    files.set(rel.toLowerCase(), { ...item, path: rel });
  }
  const checkPath = (rel: string) => {
    let current = root;
    for (const part of rel.split('/').filter(Boolean)) {
      if (!readdirSync(current).includes(part)) throw new Error('FORBIDDEN_PATH');
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error('FORBIDDEN_PATH');
    }
    const actual = realpathSync(current);
    const within = relative(root, actual);
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('FORBIDDEN_PATH');
    return actual;
  };
  const readPinned = (path: string) => {
    const rel = normalize(path), file = files.get(rel.toLowerCase());
    if (!file || file.path !== rel) throw new Error('FORBIDDEN_PATH');
    const fd = openSync(checkPath(rel), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let data: Buffer;
    try { if (!fstatSync(fd).isFile()) throw new Error('FORBIDDEN_PATH'); data = readFileSync(fd); }
    finally { closeSync(fd); }
    if (createHash('sha256').update(data).digest('hex') !== file.hash) throw new Error('SNAPSHOT_CHANGED');
    if (data.includes(0)) throw new Error('BINARY_SOURCE');
    try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Error('BINARY_SOURCE'); }
    return { rel, data, hash: file.hash };
  };
  // A partial result tells the model how to get the rest; citations are still limited to the lines actually read.
  const result = (text: string, truncated = false, note = 'narrow the path, pattern or limit to see the rest') => {
    const bytes = Buffer.from(text);
    const marker = `\n[truncated: ${note}]`;
    const cut = bytes.length + (truncated ? Buffer.byteLength(marker) : 0) > maxResultBytes;
    let prefix = text;
    if (cut) {
      let length = Math.max(0, maxResultBytes - Buffer.byteLength(marker));
      while (length > 0) { try { prefix = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); break; } catch { length--; } }
      if (!length) prefix = '';
    }
    return { content: [{ type: 'text' as const, text: cut ? `${prefix}${marker}` : `${text}${truncated ? marker : ''}` }], details: { truncated: cut || truncated } };
  };
  const candidates = (path = '.') => {
    const scope = normalize(path);
    if (scope) checkPath(scope);
    return [...files.values()].filter(file => !scope || file.path === scope || file.path.startsWith(`${scope}/`));
  };
  const read = createReadTool(root), find = createFindTool(root), grep = createGrepTool(root), ls = createLsTool(root);
  return [
    { ...read, name: 'Read', label: 'Read', execute: async (_id, args: any) => {
      const { rel, data, hash } = readPinned(args.path);
      const lines = data.subarray(0, maxFileBytes).toString('utf8').split(/\r\n|\n|\r/);
      const offset = Math.max(0, Math.floor(args.offset ?? 1) - 1), limit = Math.min(maxLines, Math.max(1, Math.floor(args.limit ?? maxLines)));
      // Keep whole lines within the result budget so the recorded range is exactly what the model saw.
      const selected: string[] = [];
      let size = 0;
      for (const line of lines.slice(offset, offset + limit)) {
        const next = size + Buffer.byteLength(line) + (selected.length ? 1 : 0);
        if (next > maxResultBytes - READ_NOTE_RESERVE && selected.length) break;
        selected.push(line); size = next;
      }
      const text = selected.join('\n');
      const shownEnd = offset + selected.length;
      const truncated = data.length > maxFileBytes || (shownEnd < lines.length && (args.limit === undefined || args.limit > selected.length));
      const note = data.length > maxFileBytes ? `only the first ${maxFileBytes} bytes of this file can be read; showed lines ${offset + 1}-${shownEnd}`
        : `showed lines ${offset + 1}-${shownEnd} of ${lines.length}; call Read with offset=${shownEnd + 1} to continue`;
      const output = result(text, truncated, note);
      observe({ path: rel, hash, kind: 'read', ...(data.length && selected.length ? { startLine: offset + 1, endLine: offset + selected.length } : {}), truncated: output.details.truncated, readBytes: Buffer.byteLength(output.content[0].text) });
      return output;
    } },
    { ...find, name: 'Glob', label: 'Glob', execute: async (_id, args: any) => {
      const scope = normalize(args.path ?? '.');
      const selected = candidates(args.path).filter(file => matchesGlob(scope ? file.path.slice(scope.length).replace(/^\//, '') : file.path, args.pattern));
      const limit = Math.min(maxEntries, Math.max(1, Math.floor(args.limit ?? maxEntries)));
      const truncated = selected.length > limit;
      observe({ path: scope || '.', kind: 'search', scope: scope || '.', truncated });
      return result(selected.slice(0, limit).map(file => file.path).join('\n'), truncated, `showed ${limit} of ${selected.length} files; narrow the path or pattern`);
    } },
    { ...grep, name: 'Grep', label: 'Grep', execute: async (_id, args: any, signal?: AbortSignal) => {
      const scope = normalize(args.path ?? '.');
      const selected = candidates(args.path).filter(file => !args.glob || matchesGlob(file.path, args.glob));
      if (!selected.length) { observe({ path: scope || '.', kind: 'search', scope: scope || '.' }); return result(''); }
      const context = Math.min(maxLines, Math.max(0, Math.floor(args.context ?? 0)));
      const flags = ['--json', '--no-config', '--color', 'never', '-C', String(context), ...(args.ignoreCase ? ['-i'] : []), ...(args.literal ? ['-F'] : []), '-e', args.pattern];
      const hits: string[] = [];
      const limit = Math.min(maxMatches, Math.max(1, Math.floor(args.limit ?? maxMatches)));
      for (const file of selected) {
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        // Feed only the verified bytes to rg. Passing paths lets a concurrent
        // symlink swap redirect rg after authorization and exceeds Windows argv.
        const { rel, data } = readPinned(file.path);
        const stdout = await new Promise<string>((resolveOutput, reject) => {
          const child = spawn(bundledRgPath(), flags, { shell: false, signal });
          const chunks: Buffer[] = [], errors: Buffer[] = []; let size = 0;
          child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1024 * 1024) { child.kill(); reject(new Error('SEARCH_INCOMPLETE')); } else chunks.push(chunk); });
          child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
          child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
          child.on('error', reject);
          child.on('close', code => code === 0 || code === 1 ? resolveOutput(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`SEARCH_FAILED: ${Buffer.concat(errors).toString('utf8')}`)));
          child.stdin.end(data);
        });
        const shown: number[] = [];
        for (const line of stdout.split('\n')) {
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === 'match' || event.type === 'context') {
            if (hits.length < limit) shown.push(event.data.line_number);
            hits.push(`${rel}:${event.data.line_number}:${event.data.lines.text.trimEnd()}`);
          }
        }
        // Lines a Grep returned were seen verbatim, so they are citable evidence like a Read range.
        for (const [start, end] of lineRuns(shown)) observe({ path: rel, hash: file.hash, kind: 'read', startLine: start, endLine: end });
        if (hits.length > limit) break;
      }
      const truncated = hits.length > limit;
      const output = result(hits.slice(0, limit).join('\n'), truncated, `showed the first ${limit} matching lines; narrow the path, glob or pattern`);
      observe({ path: scope || '.', kind: 'search', scope: scope || '.', truncated: output.details.truncated, readBytes: Buffer.byteLength(output.content[0].text) });
      return output;
    } },
    { ...ls, name: 'ListDir', label: 'ListDir', execute: async (_id, args: any) => {
      const scope = normalize(args.path ?? '.');
      const entries = [...new Set(candidates(args.path).map(file => (scope ? file.path.slice(scope.length).replace(/^\//, '') : file.path).split('/')[0]).filter(Boolean))].sort();
      const limit = Math.min(maxEntries, Math.max(1, Math.floor(args.limit ?? maxEntries)));
      const truncated = entries.length > limit;
      observe({ path: scope || '.', kind: 'directory', scope: scope || '.', truncated });
      return result(entries.slice(0, limit).join('\n'), truncated, `showed ${limit} of ${entries.length} entries; list a subdirectory`);
    } },
  ];
}
