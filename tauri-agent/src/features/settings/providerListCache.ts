// 进程级缓存：供应商列表（id+name）。设置页在分类间切换时，CapabilityModelField 会反复
// 挂载/卸载；若每次都拉 getProviderConfig 会先空后填、造成闪动。这里缓存一次，挂载时
// 同步读缓存，仅在供应商配置真正变更（ProvidersSettings 保存）时定向失效刷新。

import { useEffect, useState } from 'react';
import { pi } from '../../lib/pi';
import { loadState } from './providerConfigAdapter';
import { PROVIDER_PRESETS } from './providerPresets';

export interface ProviderListItem {
  id: string;
  name: string;
}

let cache: ProviderListItem[] | null = null;
let inflight: Promise<ProviderListItem[]> | null = null;

export function getCachedProviderList(): ProviderListItem[] | null {
  return cache;
}

export async function loadProviderList(force = false): Promise<ProviderListItem[]> {
  if (cache && !force) return cache;
  if (inflight && !force) return inflight;
  inflight = pi
    .getProviderConfig()
    .then((cfg) => {
      cache = loadState(cfg.modelsJson, cfg.authJson, PROVIDER_PRESETS).map((p) => ({ id: p.id, name: p.name }));
      inflight = null;
      return cache;
    })
    .catch((e) => {
      inflight = null;
      throw e;
    });
  return inflight;
}

/** 供应商配置变更后调用，使下次读取重新拉取（定向更新）。 */
export function invalidateProviderList(): void {
  cache = null;
  inflight = null;
}

/** 读供应商列表：初始同步返回缓存（无闪动），后台校验刷新。 */
export function useProviderList(): ProviderListItem[] {
  const [list, setList] = useState<ProviderListItem[]>(() => getCachedProviderList() ?? []);
  useEffect(() => {
    const cached = getCachedProviderList();
    if (cached) setList(cached);
    let alive = true;
    void loadProviderList()
      .then((l) => {
        if (alive) setList(l);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return list;
}
