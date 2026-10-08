import { listPromptCommands, type PromptCommandInfo } from '../../../../lib/promptLibraryIo';

/**
 * 命令模板列表（全局，和工作区无关）。斜杠菜单、粘贴识别、气泡还原共用；
 * 气泡渲染是同步的，所以另给一个只读缓存的 getCachedPromptCommands。
 */
const TTL_MS = 10_000;

let cache: { data: PromptCommandInfo[]; expiresAt: number } | null = null;
let inflight: Promise<PromptCommandInfo[]> | null = null;

export function getCachedPromptCommands(): PromptCommandInfo[] {
  return cache?.data ?? [];
}

/** 带 {参数} 的模板；没有参数的模板仍走 ChatTag。 */
export function findParamTemplate(name: string): PromptCommandInfo | undefined {
  return getCachedPromptCommands().find((command) => command.name === name && command.params.length > 0);
}

export function loadPromptCommands(): Promise<PromptCommandInfo[]> {
  if (cache && cache.expiresAt > Date.now()) return Promise.resolve(cache.data);
  if (inflight) return inflight;
  inflight = listPromptCommands()
    .then((data) => {
      cache = { data, expiresAt: Date.now() + TTL_MS };
      return data;
    })
    .catch(() => [] as PromptCommandInfo[])
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 只让缓存过期：旧数据继续供同步读取（气泡还原），下一次 load 才重新请求。 */
export function invalidatePromptCommands(): void {
  if (cache) cache = { data: cache.data, expiresAt: 0 };
}
