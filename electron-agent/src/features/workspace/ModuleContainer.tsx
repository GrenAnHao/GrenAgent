import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useModuleStore, type ModuleId } from '../../stores/moduleStore';
import { useSessionStore } from '../../store';
import { IS_DEV } from '../../lib/devMode';

// 除对话外的模块都按需加载：启动只显示对话，这些面板连同图表库、日期选择器等不该进首包。
const SettingsPanel = lazy(() => import('../settings/SettingsPanel').then((m) => ({ default: m.SettingsPanel })));
const ConnectionsPanel = lazy(() => import('../connections/ConnectionsPanel').then((m) => ({ default: m.ConnectionsPanel })));
const ExtensionsPanel = lazy(() => import('../extensions/ExtensionsPanel').then((m) => ({ default: m.ExtensionsPanel })));
const UsagePanel = lazy(() => import('../usage/UsagePanel').then((m) => ({ default: m.UsagePanel })));
const AgentDataCenter = lazy(() => import('../agentData/AgentDataCenter').then((m) => ({ default: m.AgentDataCenter })));
const DevWorkbench = lazy(() => import('../devtools/DevWorkbench').then((m) => ({ default: m.DevWorkbench })));

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
        <Suspense fallback={null}>
          <AgentDataCenter userId="local" initialProject={agentData.initialProject} visible={isAgentData} onOpenSession={onOpenSession} />
        </Suspense>
      </div> : null}
      {isChat || isAgentData ? null : (
        <Suspense fallback={null}>
          <ActivePanel module={activeModule} />
        </Suspense>
      )}
    </>
  );
}
