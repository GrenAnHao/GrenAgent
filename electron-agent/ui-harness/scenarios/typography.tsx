import { useState } from 'react';
import { Titlebar } from '../../src/components/Titlebar';
import { CodeProjectHome } from '../../src/features/agentData/CodeProjectHome';
import { LazyMarkdown } from '../../src/features/chat/LazyMarkdown';
import { TerminalBlock } from '../../src/features/chat/conv/TerminalBlock';
import { ExtensionPageHeader } from '../../src/features/extensions/ExtensionPageHeader';
import { McpServerCard } from '../../src/features/extensions/McpServerCard';
import { pathKey } from '../../src/lib/pathUtils';

const noop = () => {};
const cwd = 'D:/项目/GrenAgent';
const name = 'antd_list';
const fullName = 'mcp__antd__' + name;
const status = { workspace: cwd, connected: true, indexed: true, files: 111, nodes: 888, edges: 321 };

export default function TypographyScenario() {
  const [enabled, setEnabled] = useState(true);
  return <main style={{ height: '100vh', overflow: 'auto', background: 'var(--gren-content-bg)' }}>
    <Titlebar />
    <section style={{ maxWidth: 960, margin: 'auto', padding: '20px 32px' }}>
      <ExtensionPageHeader title="MCP" count={8} id="mcp" description="管理工具服务与权限"
        onRefresh={async () => {}} onDirectory={async () => {}} />
      <McpServerCard name="antd" config={{ command: 'node' }} detail enabled={enabled} scope="global"
        onToggle={setEnabled} onEdit={noop} onDelete={noop} runtimeStatus="connected" runtimeToolNames={[fullName]}
        catalog={[{ name, fullName, description: 'List components, usage examples, and supported properties.' }]}
        connectionPanel={<>
          <TerminalBlock command="node tools/list.mjs --count=12" cwd={cwd} output="antd_list => 12" />
          <LazyMarkdown>{'行内 `antd_list`\n\n```sh\nnode tools/list.mjs\n```\n\n$E=mc^2$'}</LazyMarkdown>
        </>} />
      <CodeProjectHome options={[{ name: 'GrenAgent', cwd }]} entries={{ [pathKey(cwd)]: { status } }}
        staleCount={0} onAdd={noop} onSyncAll={noop} onOpen={noop} onSelect={noop} onSync={noop} onRemove={noop} />
    </section>
  </main>;
}
