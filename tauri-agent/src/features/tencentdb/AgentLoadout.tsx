import { Flexbox, Segmented } from '@lobehub/ui';
import { useState } from 'react';

const AGENTS = [
  ['pi-personal', '个人助手'],
  ['coding', '编码代理'],
  ['research', '研究代理'],
] as const;

export function AgentLoadout() {
  const [agent, setAgent] = useState<(typeof AGENTS)[number][0]>('pi-personal');
  const selected = AGENTS.find(([id]) => id === agent) ?? AGENTS[0];
  return (
    <Flexbox gap={12} data-testid="tencentdb-agent-loadout">
      <Segmented block value={agent} onChange={(value) => setAgent(value as typeof agent)} options={AGENTS.map(([id, label]) => ({ value: id, label }))} />
      <p>{selected[1]}（{selected[0]}）使用独立的 TencentDB agentId；后续同步的 Skill、Wiki 与 CodeGraph 装备不会混入其他 Agent。</p>
    </Flexbox>
  );
}
