// 进程级缓存：每个 workspace 的可用对话模型列表（getAvailableModels）。ModelSelectField
// 在设置分类切换时反复挂载；若每次都拉取会先回退 Input 再变 Select、造成闪动。缓存后
// 挂载即同步读缓存，仅在供应商配置变更时定向失效。

import { useEffect, useState } from 'react';
import { pi } from '../../lib/pi';
import { parseModels, type ModelInfo } from '../chat/input/modelUtils';

const cache = new Map<string, ModelInfo[]>();
const inflight = new Map<string, Promise<ModelInfo[]>>();

// 项目无关的全局模型枚举（SP-1 probe-models）用的缓存键：与任何真实 workspace 路径不冲突。
export const GLOBAL_MODELS_KEY = '__global__';

export function getCachedAvailableModels(workspace: string): ModelInfo[] | undefined {
  return cache.get(workspace);
}

/**
 * 加载项目无关的全局模型列表（不需要打开项目）：走 list_models_global → probe-models 子命令。
 * 供冷启动 / 全局设置 / 真对话模式（SP-3）在没有 workspace 时枚举模型。复用同一缓存（GLOBAL_MODELS_KEY）。
 */
export async function loadGlobalModels(force = false): Promise<ModelInfo[]> {
  if (!force) {
    const cached = cache.get(GLOBAL_MODELS_KEY);
    if (cached) return cached;
    const pending = inflight.get(GLOBAL_MODELS_KEY);
    if (pending) return pending;
  }
  const p = pi
    .listModelsGlobal()
    .then((raw) => {
      const models = parseModels(raw);
      if (models.length > 0) cache.set(GLOBAL_MODELS_KEY, models);
      inflight.delete(GLOBAL_MODELS_KEY);
      return models;
    })
    .catch((e) => {
      inflight.delete(GLOBAL_MODELS_KEY);
      throw e;
    });
  inflight.set(GLOBAL_MODELS_KEY, p);
  return p;
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

export interface AvailableModelsState {
  models: ModelInfo[] | null;
  /** 冷启动轮询中、尚未拿到首个结果：用于下拉显示 loading 态。缓存命中或轮询结束后为 false。 */
  loading: boolean;
}

/**
 * 读可用模型 + loading 态：初始同步返回缓存（无闪动 / 无 loading）；缓存未命中时轮询期间 loading=true，
 * 拿到结果或轮询耗尽后转 false。切换 workspace 会把 models 重置为新 workspace 的缓存（或 null），不串台。
 */
export function useAvailableModelsState(workspace: string | undefined): AvailableModelsState {
  const [models, setModels] = useState<ModelInfo[] | null>(
    () => getCachedAvailableModels(workspace ?? GLOBAL_MODELS_KEY) ?? null,
  );
  const [loading, setLoading] = useState<boolean>(
    () => getCachedAvailableModels(workspace ?? GLOBAL_MODELS_KEY) === undefined,
  );
  useEffect(() => {
    if (!workspace) {
      // 无项目：走项目无关的全局枚举（SP-1），让选择器冷启动 / 真对话模式下也有模型。
      const cached = getCachedAvailableModels(GLOBAL_MODELS_KEY);
      setModels(cached ?? null);
      setLoading(cached === undefined);
      if (cached) return;
      let cancelledGlobal = false;
      void loadGlobalModels()
        .then((m) => {
          if (!cancelledGlobal) {
            setModels(m);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelledGlobal) {
            setModels(null);
            setLoading(false);
          }
        });
      return () => {
        cancelledGlobal = true;
      };
    }
    const cached = getCachedAvailableModels(workspace);
    // 切到新 workspace 先对齐到它自己的缓存（命中秒显、未命中清空），避免沿用上一个 workspace 的列表。
    setModels(cached ?? null);
    setLoading(cached === undefined);
    if (cached) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (m: ModelInfo[] | null) => {
      if (cancelled) return;
      setModels(m);
      setLoading(false);
    };
    // Pi 冷启动时 getAvailableModels 可能短暂失败（workspace 尚未 open）或返回空（registry 未就绪）。
    // 轮询重试直到拿到非空模型，避免首屏停在手填 Input、要手动切页面才恢复。
    const attempt = (left: number) => {
      void loadAvailableModels(workspace)
        .then((m) => {
          if (cancelled) return;
          if (m.length > 0 || left <= 0) {
            settle(m);
            return;
          }
          timer = setTimeout(() => attempt(left - 1), 1000);
        })
        .catch(() => {
          if (cancelled) return;
          if (left <= 0) {
            settle(null);
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
  return { models, loading };
}

/** 读可用模型：初始同步返回缓存（无闪动），后台校验刷新；无 workspace 返回 null。 */
export function useAvailableModels(workspace: string | undefined): ModelInfo[] | null {
  return useAvailableModelsState(workspace).models;
}
