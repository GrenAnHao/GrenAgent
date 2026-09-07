import { readFile } from 'node:fs/promises';

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
    const first = (await readFile(sessionPath, 'utf8')).split(/\r?\n/, 1)[0];
    const parsed = JSON.parse(first) as Record<string, unknown>;
    if (parsed?.type === 'session') header = parsed;
  } catch {
    // Headerless/partially-written sessions use path metadata below.
  }

  const sessionId = typeof header?.id === 'string' && header.id.trim() ? header.id.trim() : inferId(sessionPath);
  const workspace = typeof header?.cwd === 'string' && header.cwd.trim() ? header.cwd : inferWorkspace(sessionPath);
  if (!sessionId || !workspace) throw new Error('INVALID_SESSION_IDENTITY');
  if (expectedWorkspace !== undefined && normalize(workspace) !== normalize(expectedWorkspace)) throw new Error('SESSION_WORKSPACE_MISMATCH');
  return { sessionId, sessionPath, workspace };
}

function inferId(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const match = name.match(/^\d{4}-\d{2}-\d{2}T[^_]+_(.+)\.jsonl$/);
  return match?.[1] ?? '';
}

function inferWorkspace(path: string): string {
  const parent = path.replace(/\\/g, '/').split('/').slice(-2, -1)[0] ?? '';
  if (!parent.startsWith('--') || !parent.endsWith('--')) return '';
  const inner = parent.slice(2, -2);
  if (!inner) return '';
  if (/^[A-Za-z]-/.test(inner)) return `${inner[0]}:/${inner.slice(2).replace(/-/g, '/')}`;
  if (inner.startsWith('-')) return `/${inner.slice(1).replace(/-/g, '/')}`;
  return `/${inner.replace(/-/g, '/')}`;
}

function normalize(value: string): string { return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
