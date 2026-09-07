import { useEffect, useState, type ReactNode } from 'react';
import { useModuleStore, type ModuleId } from '../../stores/moduleStore';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ConnectionsPanel } from '../connections/ConnectionsPanel';
import { ExtensionsPanel } from '../extensions/ExtensionsPanel';
import { UsagePanel } from '../usage/UsagePanel';
import { AgentDataCenter } from '../agentData/AgentDataCenter';
import { DevWorkbench } from '../devtools/DevWorkbench';
import { useSessionStore } from '../../store';
import { IS_DEV } from '../../lib/devMode';

/** 全局模块面板（应用级，或以全局数据为主）：相对较轻，按需挂载/卸载即可。 */
function ActivePanel({ module }: { module: ModuleId }) {
  switch (module) {
    case 'settings':
      return <SettingsPanel />;
    case 'connections':
      return <ConnectionsPanel />;
    case 'extensions':
      return <ExtensionsPanel />;
    case 'usage':
      return <UsagePanel />;
    // 生产构建里入口不可达，但 store 仍可能被（比如被测试）手动置成该值，这里兜一层不渲染。
    case 'devWorkbench':
      return IS_DEV ? <DevWorkbench /> : null;
    default:
      return null;
  }
}

/**
 * chat 模块常驻保活：切到其它模块时仅用 display:none 隐藏，而不是卸载。
 * 避免切回「对话」时重挂整棵对话树（Sidebar + ChatView 全量消息 + Markdown + Dock + 终端），
 * Agent 数据首次访问后同样保活，保留筛选与滚动位置；其它面板按需挂载/卸载。
 */
export function ModuleContainer({ chat, onOpenSession }: { chat: ReactNode; onOpenSession?: (cwd: string, path: string) => void | Promise<void> }) {
  const activeModule = useModuleStore((s) => s.activeModule);
  const workspace = useSessionStore((state) => state.activeWorkspace);
  const [agentData, setAgentData] = useState<{ initialProject?: string }>();
  const isChat = activeModule === 'chat';
  const isAgentData = activeModule === 'agentData';

  useEffect(() => {
    if (isAgentData) setAgentData((current) => current ?? { initialProject: workspace || undefined });
  }, [isAgentData, workspace]);

  return (
    <>
      <div
        style={{
          display: isChat ? 'flex' : 'none',
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          height: '100%',
        }}
      >
        {chat}
      </div>
      {agentData ? <div
        hidden={!isAgentData}
        style={{ display: isAgentData ? 'flex' : 'none', flex: 1, minWidth: 0, minHeight: 0, height: '100%' }}
      >
        <AgentDataCenter userId="local" initialProject={agentData.initialProject} visible={isAgentData} onOpenSession={onOpenSession} />
      </div> : null}
      {isChat || isAgentData ? null : <ActivePanel module={activeModule} />}
    </>
  );
}
