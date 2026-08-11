import { useEffect } from 'react';
import { useSubAgentLiveStore, selectSubAgentById } from '../stores/subagentLiveStore';

export interface SubAgentLive {
  model: string | null;
  step: number | null;
  action: string | null;
}

/**
 * 实时读取运行中子代理的模型与状态。
 *
 * 原先每个实例各自启动一个 2.5s 轮询并拉取全量 transcript（所有代理）。
 * 现在改为：订阅单例 subagentLiveStore（多个 hook 共享一次轮询），
 * transcript 不再随列表返回（已从 Rust 侧去除），不再做 JSONL 全量重解析。
 *
 * step/action 的精确值依赖 transcript，不在轮询路径中计算；
 * 打开详情面板时由 SubAgentConversation 通过 subagentGetTranscript 按需拉取。
 */
export function useSubAgentLive(
  workspace: string,
  agentId: string | null,
  running: boolean,
): SubAgentLive {
  const startPolling = useSubAgentLiveStore((s) => s.startPolling);

  useEffect(() => {
    if (!workspace || !running) return;
    return startPolling(workspace);
  }, [workspace, running, startPolling]);

  const item = useSubAgentLiveStore(selectSubAgentById(workspace, agentId));

  return {
    model: item?.model ?? null,
    step: null,
    action: running && item ? '运行中…' : null,
  };
}
