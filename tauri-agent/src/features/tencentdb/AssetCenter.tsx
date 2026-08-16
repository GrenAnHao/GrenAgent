import { Flexbox, Segmented } from '@lobehub/ui';
import { useState } from 'react';
import { useTencentdbConnection } from './tencentdbApi';

const ASSETS = [
  ['chat-memory', 'Chat Memory', 'L0 对话、L1 原子记忆、L2 场景与 L3 个人画像'],
  ['skills', 'Skills', '按 Agent 装备的版本化 SKILL.md 与资源'],
  ['wiki', 'Wiki', 'MemoryKnowledge 文档与检索索引'],
  ['codegraph', 'CodeGraph', '仓库符号、调用关系与影响分析'],
] as const;

export function AssetCenter() {
  const { status } = useTencentdbConnection();
  const [asset, setAsset] = useState<(typeof ASSETS)[number][0]>('chat-memory');
  const selected = ASSETS.find(([id]) => id === asset) ?? ASSETS[0];
  return (
    <Flexbox gap={14} data-testid="tencentdb-asset-center">
      <Segmented block value={asset} onChange={(value) => setAsset(value as typeof asset)} options={ASSETS.map(([id, label]) => ({ value: id, label }))} />
      <div>
        <h3>{selected[1]}</h3>
        <p>{selected[2]}</p>
        <p>{status?.state === 'ready' ? 'Gateway 已连接，可由 Pi SDK / MemoryKnowledge MCP 访问。' : 'Gateway 未连接；连接成功后这里显示远程资产状态。'}</p>
        {status?.knowledgeEndpoint ? <p>Knowledge：{status.knowledgeEndpoint}</p> : null}
      </div>
    </Flexbox>
  );
}
