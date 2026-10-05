import { open } from 'node:fs/promises';

const HEAD_CHUNK = 16 * 1024;
const HEAD_LIMIT = 1024 * 1024;

/**
 * 只读会话文件的第一行。会话 JSONL 动辄几十 MB，而身份、cwd 都在头一行，
 * 每条命令都整份读进来再取第一行会平白占住主进程。头一行超过 1MB 时返回已读到的部分。
 */
export async function readFirstLine(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < HEAD_LIMIT) {
      const buffer = Buffer.alloc(HEAD_CHUNK);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_CHUNK, total);
      if (bytesRead === 0) break;
      const slice = buffer.subarray(0, bytesRead);
      const newline = slice.indexOf(10);
      if (newline >= 0) {
        chunks.push(slice.subarray(0, newline));
        break;
      }
      chunks.push(slice);
      total += bytesRead;
    }
    return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
  } finally {
    await handle.close();
  }
}

export interface SessionIdentity {
  sessionId: string;
  sessionPath: string;
  workspace: string;
}

/** Read the stable session id and workspace from a Pi JSONL session file. */
export async function readSessionIdentity(sessionPath: string, expectedWorkspace?: string): Promise<SessionIdentity> {
  if (!sessionPath || !sessionPath.endsWith('.jsonl')) throw new Error('INVALID_SESSION_PATH');
  let header: Record<string, unknown> | undefined;
  try {
    const first = await readFirstLine(sessionPath);
    const parsed = JSON.parse(first) as Record<string, unknown>;
    if (parsed?.type === 'session') header = parsed;
  } catch {
    // Headerless/partially-written sessions use path metadata below.
  }

  const sessionId = typeof header?.id === 'string' && header.id.trim() ? header.id.trim() : inferId(sessionPath);
  const headerCwd = typeof header?.cwd === 'string' && header.cwd.trim() ? header.cwd : '';
  const workspace = headerCwd || inferWorkspace(sessionPath);
  if (!sessionId) throw new Error('INVALID_SESSION_IDENTITY');
  if (expectedWorkspace !== undefined) {
    if (!workspaceBelongsTo(sessionPath, expectedWorkspace, headerCwd)) throw new Error('SESSION_WORKSPACE_MISMATCH');
    return { sessionId, sessionPath, workspace: headerCwd || expectedWorkspace };
  }
  if (!workspace) throw new Error('INVALID_SESSION_IDENTITY');
  return { sessionId, sessionPath, workspace };
}

export function isSessionWorkspaceMismatch(error: unknown): boolean {
  return String(error).includes('SESSION_WORKSPACE_MISMATCH');
}

function inferId(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const match = name.match(/^\d{4}-\d{2}-\d{2}T[^_]+_(.+)\.jsonl$/);
  return match?.[1] ?? '';
}

function inferWorkspace(path: string): string {
  const parent = encodedFolderName(path);
  if (!parent.startsWith('--') || !parent.endsWith('--')) return '';
  const inner = parent.slice(2, -2);
  if (!inner) return '';
  if (/^[A-Za-z]-/.test(inner)) return `${inner[0]}:/${inner.slice(2).replace(/-/g, '/')}`;
  if (inner.startsWith('-')) return `/${inner.slice(1).replace(/-/g, '/')}`;
  return `/${inner.replace(/-/g, '/')}`;
}

/** Header cwd wins. Headerless files compare the encoded folder so UUID hyphens stay literal. */
function workspaceBelongsTo(sessionPath: string, expectedWorkspace: string, headerCwd: string): boolean {
  if (headerCwd) return normalize(headerCwd) === normalize(expectedWorkspace);
  const folder = encodedFolderName(sessionPath);
  if (folder.startsWith('--') && folder.endsWith('--') && normalize(folder) === normalize(encodeWorkspaceFolder(expectedWorkspace))) {
    return true;
  }
  const inferred = inferWorkspace(sessionPath);
  return Boolean(inferred) && normalize(inferred) === normalize(expectedWorkspace);
}

function encodeWorkspaceFolder(workspace: string): string {
  const normalized = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
  return `--${normalized.replace(/:/g, '-').replace(/\//g, '-')}--`;
}

function encodedFolderName(sessionPath: string): string {
  return sessionPath.replace(/\\/g, '/').split('/').slice(-2, -1)[0] ?? '';
}

function normalize(value: string): string { return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
