import type { ReactNode } from 'react';
import { useModuleStore, type ModuleId } from '../../stores/moduleStore';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ConnectionsPanel } from '../connections/ConnectionsPanel';
import { ExtensionsPanel } from '../extensions/ExtensionsPanel';
import { UsagePanel } from '../usage/UsagePanel';
import { AgentDataCenter } from '../agentData/AgentDataCenter';
import { useSessionStore } from '../../store';

/** 全局模块面板（应用级，或以全局数据为主）：相对较轻，按需挂载/卸载即可。 */
function ActivePanel({ module }: { module: ModuleId }) {
  const workspace = useSessionStore((state) => state.activeWorkspace);
  switch (module) {
    case 'settings':
      return <SettingsPanel />;
    case 'connections':
      return <ConnectionsPanel />;
    case 'extensions':
      return <ExtensionsPanel />;
    case 'usage':
      return <UsagePanel />;
    case 'agentData':
      return <AgentDataCenter userId="local" workspace={workspace || undefined} />;
    default:
      return null;
  }
}

/**
 * chat 模块常驻保活：切到其它模块时仅用 display:none 隐藏，而不是卸载。
 * 避免切回「对话」时重挂整棵对话树（Sidebar + ChatView 全量消息 + Markdown + Dock + 终端），
 * 这是「切设置/其它面板再切回对话会卡一下」的根因。其它面板较轻，按需挂载/卸载。
 */
export function ModuleContainer({ chat }: { chat: ReactNode }) {
  const activeModule = useModuleStore((s) => s.activeModule);
  const isChat = activeModule === 'chat';
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
      {isChat ? null : <ActivePanel module={activeModule} />}
    </>
  );
}
