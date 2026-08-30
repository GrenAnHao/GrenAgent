import { pi } from '../../../../lib/pi';
import { getFrontendCommands, mergeCommands, parseCommands } from '../commandUtils';
import type { PiCommand } from '../commandTypes';

/**
 * 工作区命令加载器：带 TTL 缓存与去重的在途请求。
 * slash 菜单（useSlashOptions）与粘贴命令识别（useCommandPaste）共用同一份缓存，
 * 避免重复请求，也保证两边看到一致的命令集合。
 */
const COMMAND_CACHE_TTL_MS = 10_000;
const MAX_ATTEMPTS = 20;
const RETRY_DELAY_MS = 400;

const commandCache = new Map<string, { data: PiCommand[]; expiresAt: number }>();
const commandInflight = new Map<string, Promise<PiCommand[]>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCommands(workspace: string): Promise<PiCommand[]> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const raw = await pi.getCommands(workspace);
      return mergeCommands(parseCommands(raw), getFrontendCommands());
    } catch (error) {
      if (String(error).includes('workspace not open') && attempt < MAX_ATTEMPTS - 1) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
  return getFrontendCommands();
}

export async function loadCommands(workspace: string): Promise<PiCommand[]> {
  const now = Date.now();
  const cached = commandCache.get(workspace);
  if (cached && cached.expiresAt > now) return cached.data;

  const existing = commandInflight.get(workspace);
  if (existing) return existing;

  const req = fetchCommands(workspace)
    .then((data) => {
      commandCache.set(workspace, { data, expiresAt: Date.now() + COMMAND_CACHE_TTL_MS });
      return data;
    })
    .catch(() => getFrontendCommands())
    .finally(() => {
      commandInflight.delete(workspace);
    });

  commandInflight.set(workspace, req);
  return req;
}
