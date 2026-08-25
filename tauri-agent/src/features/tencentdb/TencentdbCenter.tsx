import { Segmented } from 'antd';
import { Flexbox } from '@lobehub/ui';
import { useState } from 'react';
import { AgentLoadout } from './AgentLoadout';
import { AssetCenter } from './AssetCenter';
import { ConnectionSettings } from './ConnectionSettings';

type View = 'connection' | 'assets' | 'agents';

export function TencentdbCenter() {
  const [view, setView] = useState<View>('connection');
  return (
    <Flexbox gap={18} style={{ padding: '20px 24px', overflow: 'auto', height: '100%' }} data-testid="tencentdb-center">
      <Segmented
        value={view}
        onChange={(value) => setView(value as View)}
        options={[
          { label: '连接设置', value: 'connection' },
          { label: '资产中心', value: 'assets' },
          { label: 'Agent 装备', value: 'agents' },
        ]}
      />
      {view === 'connection' ? <ConnectionSettings /> : view === 'assets' ? <AssetCenter /> : <AgentLoadout />}
    </Flexbox>
  );
}
