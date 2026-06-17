// 进程级缓存：每个 workspace 的可用对话模型列表（getAvailableModels）。ModelSelectField
// 在设置分类切换时反复挂载；若每次都拉取会先回退 Input 再变 Select、造成闪动。缓存后
// 挂载即同步读缓存，仅在供应商配置变更时定向失效。

import { useEffect, useState } from 'react';
import { pi } from '../../lib/pi';
import { parseModels, type ModelInfo } from '../chat/input/modelUtils';

const cache = new Map<string, ModelInfo[]>();
const inflight = new Map<string, Promise<ModelInfo[]>>();

export function getCachedAvailableModels(workspace: string): ModelInfo[] | undefined {
  return cache.get(workspace);
}

export async function loadAvailableModels(workspace: string, force = false): Promise<ModelInfo[]> {
  if (!force) {
    const cached = cache.get(workspace);
    if (cached) return cached;
    const pending = inflight.get(workspace);
    if (pending) return pending;
  }
  const p = pi
    .getAvailableModels(workspace)
    .then((raw) => {
      const models = parseModels(raw);
      // 仅缓存非空结果：Pi 冷启动/未就绪时可能返回空，缓存空会命中缓存导致此后永不刷新。
      if (models.length > 0) cache.set(workspace, models);
      inflight.delete(workspace);
      return models;
    })
    .catch((e) => {
      inflight.delete(workspace);
      throw e;
    });
  inflight.set(workspace, p);
  return p;
}

/** 供应商配置变更后调用，使模型列表重新拉取（定向更新）。 */
export function invalidateAvailableModels(): void {
  cache.clear();
  inflight.clear();
}

/** 读可用模型：初始同步返回缓存（无闪动），后台校验刷新；无 workspace 返回 null。 */
export function useAvailableModels(workspace: string | undefined): ModelInfo[] | null {
  const [models, setModels] = useState<ModelInfo[] | null>(() =>
    workspace ? (getCachedAvailableModels(workspace) ?? null) : null,
  );
  useEffect(() => {
    if (!workspace) {
      setModels(null);
      return;
    }
    const cached = getCachedAvailableModels(workspace);
    if (cached) setModels(cached);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Pi 冷启动时 getAvailableModels 可能短暂失败（workspace 尚未 open）或返回空（registry 未就绪）。
    // 轮询重试直到拿到非空模型，避免首屏停在手填 Input、要手动切页面才恢复。
    const attempt = (left: number) => {
      void loadAvailableModels(workspace)
        .then((m) => {
          if (cancelled) return;
          if (m.length > 0 || left <= 0) {
            setModels(m);
            return;
          }
          timer = setTimeout(() => attempt(left - 1), 1000);
        })
        .catch(() => {
          if (cancelled) return;
          if (left <= 0) {
            if (!cached) setModels(null);
            return;
          }
          timer = setTimeout(() => attempt(left - 1), 1000);
        });
    };
    attempt(12); // 最多约 12s，覆盖 Pi 冷启动 + 扩展加载
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspace]);
  return models;
}
